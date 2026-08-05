import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const FIGMA_TOKEN = process.env.FIGMA_TOKEN;
if (!FIGMA_TOKEN) {
  console.error('FIGMA_TOKEN is not set. Add it to the env block in claude_desktop_config.json.');
  process.exit(1);
}

const FIGMA_API_BASE = 'https://api.figma.com/v1';

/**
 * Where a comment is pinned. Figma returns one of two shapes: absolute canvas
 * coordinates, or an offset within a specific node. Comments left on top of an
 * image are almost always the latter — and without this, a comment like
 * "too much space here" arrives with no idea what "here" is.
 */
type CommentPin =
  | { x: number; y: number }
  | { node_id: string; node_offset: { x: number; y: number } };

async function figmaFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${FIGMA_API_BASE}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      'X-Figma-Token': FIGMA_TOKEN as string,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Figma API error ${res.status}: ${body}`);
  }
  return res.json();
}

const server = new McpServer({ name: 'figma-comments-mcp', version: '1.0.0' });

server.registerTool(
  'list_figma_comments',
  {
    title: 'List Figma comments',
    description: 'List comments on a Figma file, optionally only those posted after a given ISO 8601 timestamp.',
    inputSchema: z.object({
      file_key: z.string().describe('The Figma file key, e.g. the ID in figma.com/file/<file_key>/...'),
      since: z.string().optional().describe('ISO 8601 timestamp; only return comments created after this time'),
      include_resolved: z.boolean().optional().default(false).describe('Include comments already marked resolved')
    })
  },
  async ({ file_key, since, include_resolved }) => {
    const data = (await figmaFetch(`/files/${file_key}/comments`)) as {
      comments: Array<{
        id: string;
        message: string;
        file_key: string;
        parent_id: string;
        user: { handle: string };
        created_at: string;
        resolved_at: string | null;
        client_meta: CommentPin | null;
      }>;
    };

    let comments = data.comments;
    if (!include_resolved) {
      comments = comments.filter((c) => !c.resolved_at);
    }
    if (since) {
      const sinceTime = new Date(since).getTime();
      comments = comments.filter((c) => new Date(c.created_at).getTime() > sinceTime);
    }

    const summary = comments.map((c) => ({
      id: c.id,
      author: c.user.handle,
      message: c.message,
      created_at: c.created_at,
      resolved: Boolean(c.resolved_at),
      is_reply: Boolean(c.parent_id),
      parent_id: c.parent_id || null,
      pin: c.client_meta ?? null
    }));

    return {
      content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }]
    };
  }
);

server.registerTool(
  'reply_to_figma_comment',
  {
    title: 'Reply to a Figma comment',
    description: 'Post a reply to an existing comment thread on a Figma file.',
    inputSchema: z.object({
      file_key: z.string().describe('The Figma file key'),
      comment_id: z.string().describe('The id of the comment to reply to'),
      message: z.string().describe('The reply text')
    })
  },
  async ({ file_key, comment_id, message }) => {
    const data = await figmaFetch(`/files/${file_key}/comments`, {
      method: 'POST',
      body: JSON.stringify({ message, comment_id })
    });

    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
