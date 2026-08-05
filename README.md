# figma-comments-mcp

An MCP server that lets Claude read and reply to Figma file comments directly.

## Why I built it

Design feedback lives in Figma. The agent can't see it.

So every review round looked like this: read the comments in Figma, retype them into Claude,
get the change, go back to Figma, reply to each thread by hand. I was the copy-paste layer
between the two tools, and the context lost in that handoff was usually the part that
mattered — which comment was blocking, which was a nit, what the thread had already
resolved.

This closes the loop. Claude reads the thread itself, makes the change, and posts the reply.

## Tools

| Tool | What it does |
|---|---|
| `list_figma_comments` | Lists comments on a file. Filters out resolved threads by default, and takes an optional `since` timestamp so you can ask for just what's new. Returns author, message, timestamp, and whether it's a reply. |
| `reply_to_figma_comment` | Posts a reply into an existing thread. |

## Setup

```bash
npm install
npm run build
```

Then add it to your MCP client config — for Claude Desktop, that's
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "figma-comments": {
      "command": "node",
      "args": ["/absolute/path/to/figma-comments-mcp/dist/index.js"],
      "env": { "FIGMA_TOKEN": "figd_your_token_here" }
    }
  }
}
```

Generate the token at Figma → Settings → Security → Personal access tokens. It needs read
access to files, and write access to comments if you want replies to work.

MCP servers are spawned once at client launch, so restart the app after editing the config.

## Usage

Grab the file key from any Figma URL — `figma.com/file/<file_key>/...` — and ask for what
you want:

> "What are the open comments on file `abc123`?"
>
> "Reply to the one about the empty state and say it's fixed in the latest push."

## Notes

- Built on `@modelcontextprotocol/server` v2, over stdio.
- Hits the Figma REST API directly with `fetch` — no SDK, no extra HTTP client.
- Auth is the `X-Figma-Token` header. `figd_` personal access tokens reject
  `Authorization: Bearer`, which is the first thing to check on a 401 or 403.
- Run `npm run build` after any change to `src/index.ts` — the client runs `dist/`, not `src/`.
