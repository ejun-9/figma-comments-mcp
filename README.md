# figma-comments-mcp

**An MCP server that lets Claude read your Figma comments and Dev Mode annotations.**
Read-only. Scoped to the frame you link.

Design feedback lives in Figma. The agent can't see it. So every round of changes meant
reading comments in Figma, retyping them into Claude, and pasting the result back — with me
as the copy-paste layer in the middle.

Now: leave the comments where you already leave them, paste the frame link, and ask.

> **"Read the comments on `figma.com/design/abc123/…?node-id=132-5` and apply them."**

I wrote about why I built it here: [figma-comments-mcp: an MCP server so Claude can read
your comments](https://eunji.design/thoughts/figma-comments-mcp).

---

## What Claude sees

A comment arrives resolved to the layer it's pinned to — the layer *name*, not a node id —
so the agent knows what the feedback is about:

```
rNK3UkoeLnbBHHYQiv9MW8 · frame 132:5 "01 · Results — default" · 1 thread · 1 annotation

1873426532 · Eun Ji Jung · 2026-08-05 19:22
  on 132:5 "01 · Results — default" FRAME
  have hover states

annotation on 132:258 "Overview" FRAME
  allow for collapsing panels
```

## The two tools

**`list_figma_comments`** — comment threads and Dev Mode annotations on a file, or on one
frame within it, each resolved to its layer.

**`get_figma_comment_image`** — renders the layer a comment is pinned to. For when the note
is spatial (*"too much space here"*) and the words alone don't carry it, or when it's pinned
to a pasted screenshot whose layer name is something useless like `image 21`.

### It only reads

It never writes to Figma, edits your designs, or posts replies. The token it asks for is
read-only on both scopes, and there is no code path that mutates anything.

### Two behaviours worth knowing

**A frame link reads only that frame.** Any Figma URL copied with a frame selected carries
`?node-id=`, and the tool scopes to it — including everything nested inside, excluding the
section around it. It always reports how many threads it left out. Pass `scope: "file"` for
the whole file.

**Annotations are not comments.** Dev Mode annotations are a separate Figma feature,
invisible to the comments API, and easy to forget you left. Both counts are on the headline
so a frame never looks emptier than it is.

### Why not Figma's own MCP server?

Figma's official MCP server reads designs, variables and Code Connect mappings, but it has no tool for comments. I checked its tool list again in October 2026. Figma's forum has reports of annotations coming back when you ask about one layer at a time, so you still can't get everything pinned to a frame. This server reads every comment and annotation on a frame in one call.

---

## Setup

Node 20 or newer. Five steps, and step 4 is the one everyone misses.

### 1. Clone and build

```bash
git clone https://github.com/ejun-9/figma-comments-mcp.git
cd figma-comments-mcp
npm install
npm run build
```

The client runs `dist/`, not `src/`, so the build isn't optional.

### 2. Make a Figma token

Figma → your avatar → **Settings** → **Security** → **Personal access tokens** → *Generate
new token*.

You need **two** scopes, both read-only:

| Scope | Set to |
|---|---|
| **File content** | Read-only |
| **Comments** | Read-only |

File content alone is the easy mistake — the server starts fine, resolves layer names fine,
then returns a 403 the moment it asks for comments.

Copy the token when it's shown. Figma won't show it again.

### 3. Point your client at it

**Claude Code:**

```bash
claude mcp add figma-comments --env FIGMA_TOKEN=figd_your_token_here -- node /absolute/path/to/figma-comments-mcp/dist/index.js
```

**Claude Desktop** — edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

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

The path must be absolute — `~` won't resolve.

### 4. Restart the client

MCP servers are spawned once at launch. Editing the config or rebuilding `dist/` does nothing
to a session that's already running. This catches everyone at least once.

### 5. Check it works

Before involving the client at all:

```bash
FIGMA_TOKEN=figd_your_token_here npm run try -- "https://figma.com/design/<key>/...?node-id=1-2"
```

If that prints threads and your client shows nothing, the problem is the config or the
restart — not the token.

---

## Using it

Copy a link from Figma with the frame selected, and ask:

> "Read the comments on https://figma.com/design/abc123/...?node-id=132-5 and apply them."
>
> "What's still open across the whole file?"
>
> "What did I annotate on this frame?"

The first is the one that changes your day. The feedback goes straight from where the
reviewer left it into the change, without passing through you.

---

## Troubleshooting

| What you see | What it is |
|---|---|
| `403` on every call | Token is missing the **Comments** scope, or it expired. File content alone isn't enough. |
| `403` on some calls only | Token works, but the account can't see this file. Check you can open it in the browser as the same user. |
| `404` on a file that exists | Wrong file key, or the file belongs to an org the token's account isn't in. |
| `429` | Figma rate limit. Wait and retry. |
| `FIGMA_TOKEN is not set` | The client isn't passing the env var — it goes in the server's `env` block, not your shell. |
| Server not listed in the client | Restart it. See step 4. |
| Changes to `src/` do nothing | `npm run build`, then restart the client. |
| `No node "1:2" in this file` | The `node-id` is from a different file. Pass `scope: "file"` to search everything. |

---

## How it's built

- TypeScript on `@modelcontextprotocol/server` v2, over stdio. Hits the Figma REST API with
  `fetch` — no SDK.
- Auth is the `X-Figma-Token` header. `figd_` tokens reject `Authorization: Bearer`, which is
  the first thing to check on a 401 or 403.
- Read-only endpoints used: `/v1/files/:key/comments`, `/v1/files/:key/nodes`,
  `/v1/files/:key`, `/v1/images/:key`.
- Built with Claude.

## Related

- [ds-specs](https://github.com/ejun-9/ds-specs) — a Claude Skill that builds design systems
  an LLM can follow, with a two-way Figma bridge.
- [More of what I'm figuring out](https://eunji.design/thoughts) about designing with agents.

## License

ISC. See [LICENSE](LICENSE).
