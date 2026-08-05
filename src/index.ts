import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import {
  figmaFetch,
  parseFileKey,
  pinNodeId,
  normalizeNodeId,
  renderNode,
  resolveNodeNames,
  type FigmaComment
} from './figma.js';

if (!process.env.FIGMA_TOKEN) {
  console.error('FIGMA_TOKEN is not set. Add it to the env block in claude_desktop_config.json.');
  process.exit(1);
}

const server = new McpServer({ name: 'figma-comments-mcp', version: '1.1.0' });

/** MCP tools should report failure as content, not blow up the transport. */
function toolError(err: unknown) {
  return {
    content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
    isError: true
  };
}

function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

async function fetchComments(fileKey: string): Promise<FigmaComment[]> {
  const data = await figmaFetch<{ comments: FigmaComment[] }>(`/files/${fileKey}/comments`);
  return data.comments ?? [];
}

server.registerTool(
  'list_figma_comments',
  {
    title: 'List Figma comments',
    description:
      'List comment threads on a Figma file. Replies are nested under the comment they answer, and comments pinned to a layer are resolved to that layer name so you can tell what is being talked about.',
    inputSchema: z.object({
      file: z
        .string()
        .describe('A Figma file URL (figma.com/design/<key>/...) or a bare file key. URLs are fine.'),
      since: z
        .string()
        .optional()
        .describe(
          'ISO 8601 timestamp. Returns threads with any activity after this time, including old threads that got a new reply.'
        ),
      include_resolved: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include threads already marked resolved')
    })
  },
  async ({ file, since, include_resolved }) => {
    try {
      const fileKey = parseFileKey(file);
      const comments = await fetchComments(fileKey);

      const roots = comments.filter((c) => !c.parent_id);
      const repliesByParent = new Map<string, FigmaComment[]>();
      for (const c of comments) {
        if (!c.parent_id) continue;
        const list = repliesByParent.get(c.parent_id) ?? [];
        list.push(c);
        repliesByParent.set(c.parent_id, list);
      }

      let threads = roots;
      if (!include_resolved) {
        threads = threads.filter((c) => !c.resolved_at);
      }

      if (since) {
        const cutoff = new Date(since).getTime();
        if (Number.isNaN(cutoff)) {
          throw new Error(`"${since}" is not a valid ISO 8601 timestamp.`);
        }
        // A thread counts as new if the root OR any reply landed after the cutoff.
        // Filtering on the root alone silently drops fresh replies to old threads,
        // which is usually the exact thing you were looking for.
        threads = threads.filter((root) => {
          const times = [root, ...(repliesByParent.get(root.id) ?? [])].map((c) =>
            new Date(c.created_at).getTime()
          );
          return times.some((t) => t > cutoff);
        });
      }

      const nodeIds = threads.map((t) => pinNodeId(t.client_meta)).filter((id): id is string => !!id);
      const nodeNames = await resolveNodeNames(fileKey, nodeIds);

      const payload = threads
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
        .map((root) => {
          const pin = root.client_meta;
          const nodeId = pinNodeId(pin);
          const info = nodeId ? nodeNames.get(nodeId) : undefined;

          return {
            thread_id: root.id,
            author: root.user.handle,
            message: root.message,
            created_at: root.created_at,
            resolved: Boolean(root.resolved_at),
            anchor: nodeId
              ? {
                  node_id: nodeId,
                  node_name: info?.name ?? null,
                  node_type: info?.type ?? null,
                  offset: pin && 'node_offset' in pin ? pin.node_offset : null,
                  // Present means the author dragged a box over an area rather
                  // than dropping a point — the comment is about everything
                  // inside it, not the pixel under the pin.
                  region:
                    pin && 'region_width' in pin && pin.region_width
                      ? {
                          width: pin.region_width,
                          height: pin.region_height ?? null,
                          anchored_from: pin.comment_pin_corner ?? null
                        }
                      : null,
                  // Layer names go generic exactly where they matter most —
                  // a comment on a pasted screenshot resolves to "image 21".
                  render_hint:
                    info && !/^(FRAME|SECTION|COMPONENT|INSTANCE|GROUP)$/.test(info.type)
                      ? 'This is not a frame, so the layer name may not describe it. Call get_figma_comment_image to see it.'
                      : null
                }
              : pin && 'x' in pin
                ? { canvas: { x: pin.x, y: pin.y } }
                : null,
            replies: (repliesByParent.get(root.id) ?? [])
              .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
              .map((r) => ({
                id: r.id,
                author: r.user.handle,
                message: r.message,
                created_at: r.created_at
              }))
          };
        });

      return ok({ file_key: fileKey, thread_count: payload.length, threads: payload });
    } catch (err) {
      return toolError(err);
    }
  }
);

server.registerTool(
  'reply_to_figma_comment',
  {
    title: 'Reply to a Figma comment',
    description:
      'Post a reply into an existing comment thread. Accepts either a thread id or the id of a reply within it — replies are redirected to the root, which is what Figma requires.',
    inputSchema: z.object({
      file: z.string().describe('A Figma file URL or a bare file key'),
      comment_id: z.string().describe('The id of the thread (or any comment in it) to reply to'),
      message: z.string().describe('The reply text')
    })
  },
  async ({ file, comment_id, message }) => {
    try {
      const fileKey = parseFileKey(file);

      // Figma only accepts replies against a root comment. Claude will sometimes
      // hand back the id of a reply it just read, so walk up to the root first.
      const comments = await fetchComments(fileKey);
      const target = comments.find((c) => c.id === comment_id);
      if (!target) {
        throw new Error(
          `No comment with id "${comment_id}" on this file. Run list_figma_comments to get current ids.`
        );
      }
      const rootId = target.parent_id || target.id;

      const created = await figmaFetch<FigmaComment>(`/files/${fileKey}/comments`, {
        method: 'POST',
        body: JSON.stringify({ message, comment_id: rootId })
      });

      return ok({
        posted: true,
        reply_id: created.id,
        replied_to: rootId,
        redirected_to_root: rootId !== comment_id,
        message: created.message
      });
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
      'Render the layer a comment is pinned to and return it as an image. Use this whenever a comment is spatial ("this spacing", "move this left") or is pinned to something that is not a frame — a pasted screenshot resolves to a name like "image 21", which tells you nothing.',
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
      scale: z.number().optional().default(1).describe('Render scale, 1–4. Higher costs more tokens.'),
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
