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
| `list_figma_comments` | Lists comment threads, with replies nested under the comment they answer. Resolves each pin to the layer it sits on, so a comment arrives as *"on `01 · Results — default`"* rather than `{node_id: "132:5"}`. Filters resolved threads by default. Optional `since` returns anything with new activity — including old threads that just got a reply. |
| `reply_to_figma_comment` | Posts a reply into a thread. Accepts a thread id or the id of any reply inside it; Figma only accepts replies against the root, so it walks up automatically. |
| `get_figma_comment_image` | Renders whatever a comment is pinned to and returns it as an image. This is the one that matters for comments left on screenshots — see below. |

### Why the image tool exists

Layer names stop helping exactly where you need them most.

A comment pinned to a frame resolves to something useful: `01 · Results — default`. A comment
pinned to a pasted screenshot resolves to `image 21`, type `RECTANGLE`. Technically correct,
completely useless — and *"too much space here"* is unanswerable without seeing it.

So `list_figma_comments` flags those pins with a `render_hint`, and `get_figma_comment_image`
renders the node so the agent can look at it.

Renders are size-budgeted. A full-page frame comes back around 650KB at scale 1, which costs
more context than the answer is worth, so anything over ~400KB is re-rendered at a lower scale
until it fits. When that happens the response says so rather than quietly handing back
something different from what was asked for.

### Point pins vs. region pins

Figma has two kinds of pin and the difference carries meaning. A point pin is a dot. A region
pin is a box someone dragged over an area — the comment is about everything inside it, not the
pixel underneath. On a real design file, roughly half the comments turn out to be regions.

Both come back on `anchor`, with `region` present only for the second kind.

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
