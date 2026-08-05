import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import {
  figmaFetch,
  parseFileKey,
  parseNodeId,
  descendantNodes,
  pinNodeId,
  normalizeNodeId,
  renderNode,
  resolveNodeNames,
  type NodeInfo,
  type FigmaComment
} from './figma.js';

if (!process.env.FIGMA_TOKEN) {
  console.error('FIGMA_TOKEN is not set. Add it to the env block in claude_desktop_config.json.');
  process.exit(1);
}

const server = new McpServer({ name: 'figma-comments-mcp', version: '2.0.0' });

/** MCP tools should report failure as content, not blow up the transport. */
function toolError(err: unknown) {
  return {
    content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
    isError: true
  };
}

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

async function fetchComments(fileKey: string): Promise<FigmaComment[]> {
  const data = await figmaFetch<{ comments: FigmaComment[] }>(`/files/${fileKey}/comments`);
  return data.comments ?? [];
}

/** "2026-08-05T15:36:10.517Z" → "2026-08-05 15:36". Seconds never mattered. */
function shortTime(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16);
}

server.registerTool(
  'list_figma_comments',
  {
    title: 'List Figma comments',
    description:
      'Read comment threads on a Figma file, or on one frame within it. IMPORTANT: a URL copied off a selected frame carries node-id, and this tool scopes to that frame by default — threads elsewhere on the file are counted but not returned. Pass scope:"file" to read everything.',
    inputSchema: z.object({
      file: z
        .string()
        .describe('A Figma file URL (figma.com/design/<key>/...) or a bare file key. URLs are fine.'),
      node_id: z
        .string()
        .optional()
        .describe('Scope to this frame, overriding the URL. Accepts "132:5" or "132-5".'),
      scope: z
        .enum(['auto', 'file'])
        .optional()
        .default('auto')
        .describe(
          '"auto" (default): scope to node_id, else the URL\'s node-id, else the whole file. "file": whole file even when a frame was linked.'
        ),
      since: z
        .string()
        .optional()
        .describe('ISO 8601. Threads with any activity after this, including new replies to old threads.'),
      include_resolved: z.boolean().optional().default(false).describe('Include resolved threads')
    })
  },
  async ({ file, node_id, scope, since, include_resolved }) => {
    try {
      const fileKey = parseFileKey(file);

      // An explicit node_id beats the URL; scope:"file" beats both. Anything
      // else, and a frame link means the frame.
      const scopeId =
        scope === 'file' ? null : node_id ? normalizeNodeId(node_id) : parseNodeId(file);

      const comments = await fetchComments(fileKey);

      const repliesByParent = new Map<string, FigmaComment[]>();
      for (const c of comments) {
        if (!c.parent_id) continue;
        const list = repliesByParent.get(c.parent_id) ?? [];
        list.push(c);
        repliesByParent.set(c.parent_id, list);
      }

      let threads = comments.filter((c) => !c.parent_id);
      if (!include_resolved) threads = threads.filter((c) => !c.resolved_at);

      if (since) {
        const cutoff = new Date(since).getTime();
        if (Number.isNaN(cutoff)) {
          throw new Error(`"${since}" is not a valid ISO 8601 timestamp.`);
        }
        // A thread counts as new if the root OR any reply landed after the cutoff.
        // Filtering on the root alone silently drops fresh replies to old threads,
        // which is usually the exact thing you were looking for.
        threads = threads.filter((root) =>
          [root, ...(repliesByParent.get(root.id) ?? [])].some(
            (c) => new Date(c.created_at).getTime() > cutoff
          )
        );
      }

      const candidates = threads.length;

      // A scoped call already holds the whole subtree, so it has every name it
      // needs; only a whole-file call has to go back for them.
      let names: Map<string, NodeInfo>;
      if (scopeId) {
        names = await descendantNodes(fileKey, scopeId);
        threads = threads.filter((t) => {
          const id = pinNodeId(t.client_meta);
          return id ? names.has(id) : false;
        });
      } else {
        names = await resolveNodeNames(
          fileKey,
          threads.map((t) => pinNodeId(t.client_meta)).filter((id): id is string => !!id)
        );
      }

      threads.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

      const scopeLabel = scopeId
        ? `${names.get(scopeId)?.type.toLowerCase() ?? 'node'} ${scopeId} "${names.get(scopeId)?.name ?? '?'}"`
        : 'whole file';

      const lines: string[] = [
        `${fileKey} · ${scopeLabel} · ${threads.length} thread${threads.length === 1 ? '' : 's'}`
      ];

      // The count that would have prevented reading six comments as one frame's
      // worth. Silent filtering is as misleading as silent over-fetching.
      const excluded = candidates - threads.length;
      if (excluded > 0) {
        lines.push(
          `${excluded} more thread${excluded === 1 ? '' : 's'} elsewhere on this file — re-run with scope:"file" to read them.`
        );
      }

      for (const root of threads) {
        const pin = root.client_meta;
        const nodeId = pinNodeId(pin);
        const info = nodeId ? names.get(nodeId) : undefined;

        lines.push('');
        lines.push(`${root.id} · ${root.user.handle} · ${shortTime(root.created_at)}`);

        if (nodeId) {
          // A dragged region means "everything in this box", not "this spot".
          // Which it is changes the reading; the pixel figures never did.
          const area = pin && 'region_width' in pin && pin.region_width ? ' [area]' : '';
          lines.push(`  on ${nodeId} "${info?.name ?? '?'}" ${info?.type ?? '?'}${area}`);

          // Layer names go generic exactly where they matter most — a comment
          // on a pasted screenshot resolves to "image 21".
          if (info && !/^(FRAME|SECTION|COMPONENT|INSTANCE|GROUP)$/.test(info.type)) {
            lines.push('  (not a frame — call get_figma_comment_image to see it)');
          }
        } else if (pin && 'x' in pin) {
          lines.push('  on canvas (not pinned to a layer)');
        }

        lines.push(`  ${root.message.replace(/\n+/g, ' ')}`);

        for (const r of (repliesByParent.get(root.id) ?? []).sort(
          (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        )) {
          lines.push(`  ↳ ${r.user.handle}: ${r.message.replace(/\n+/g, ' ')}`);
        }
      }

      if (threads.length === 0 && excluded === 0) {
        lines.push('No unresolved comments.');
      }

      return text(lines.join('\n'));
    } catch (err) {
      return toolError(err);
    }
  }
);

server.registerTool(
  'get_figma_comment_image',
  {
    title: 'See what a Figma comment points at',
    description:
      'Render the layer a comment is pinned to. Costs real context — call it only when the words are not enough: a spatial note ("this spacing", "move this left"), or a pin on something that is not a frame. A layer name plus the comment text is usually sufficient. Drop scale below 1 for layout questions.',
    inputSchema: z.object({
      file: z.string().describe('A Figma file URL or a bare file key'),
      comment_id: z
        .string()
        .optional()
        .describe('Render whatever this comment is pinned to. Either this or node_id is required.'),
      node_id: z
        .string()
        .optional()
        .describe('Render this node directly. Accepts "132:5" or the "132-5" form used in URLs.'),
      scale: z.number().optional().default(1).describe('Render scale, 0.25–4. Higher costs more context.'),
      format: z.enum(['png', 'jpg']).optional().default('png').describe('Image format')
    })
  },
  async ({ file, comment_id, node_id, scale, format }) => {
    try {
      const fileKey = parseFileKey(file);

      let targetId: string | null = node_id ? normalizeNodeId(node_id) : null;
      let context: string;

      if (comment_id) {
        const comments = await fetchComments(fileKey);
        const target = comments.find((c) => c.id === comment_id);
        if (!target) {
          throw new Error(
            `No comment with id "${comment_id}" on this file. Run list_figma_comments to get current ids.`
          );
        }
        targetId = pinNodeId(target.client_meta);
        if (!targetId) {
          throw new Error(
            `Comment "${comment_id}" is not pinned to a layer, so there is nothing to render.`
          );
        }
        context = `Comment "${target.message}" is pinned to node ${targetId}.`;
      } else if (targetId) {
        context = `Node ${targetId}.`;
      } else {
        throw new Error('Pass either comment_id or node_id.');
      }

      const render = await renderNode(fileKey, targetId, { scale, format });

      const note = render.downscaled
        ? ` Rendered at scale ${render.scale} instead of ${scale} — at full size it was too large to return.`
        : '';

      return {
        content: [
          { type: 'text' as const, text: `${context}${note}` },
          { type: 'image' as const, data: render.data, mimeType: render.mimeType }
        ]
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
