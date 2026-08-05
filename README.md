# figma-comments-mcp

An MCP server that lets Claude read Figma design feedback directly — comment threads and
Dev Mode annotations.

## Why I built it

Design feedback lives in Figma. The agent can't see it.

So every review round looked like this: read the comments in Figma, retype them into Claude,
get the change. I was the copy-paste layer between the two tools, and the context lost in
that handoff was usually the part that mattered — which comment was blocking, which was a
nit, which frame it was even about.

This closes that half of the loop. Claude reads the threads itself and makes the change.
Replying stays manual, on purpose: a reply is a statement to collaborators, and it should be
mine.

## Tools

| Tool | What it does |
|---|---|
| `list_figma_comments` | Reads comment threads **and annotations** on a file, **or on one frame within it**. Resolves each pin to the layer it sits on, so a comment arrives as *"on `01 · Results — default`"* rather than `{node_id: "132:5"}`. Filters resolved threads by default. Optional `since` returns anything with new activity — including old threads that just got a reply. |
| `get_figma_comment_image` | Renders whatever a comment is pinned to and returns it as an image. This is the one that matters for comments left on screenshots — see below. |

### Annotations are not comments

Dev Mode annotations look like feedback, read like feedback, and are invisible to
`/v1/files/:key/comments`. They live on the node, in the file document.

This server missed all of them until v2.1.0. On the file it was built for, that was six
annotations — every one of them a real design question — silently absent from every answer
it had ever given. A frame the designer knew held one comment and one annotation came back
as *"1 thread"*, which reads as complete.

So both counts are now on the headline, and annotations render in their own block rather
than being mixed into the threads — they have no author and no timestamp, and reading them
as comments turns a note-to-self into something a collaborator said to you:

```
rNK3UkoeLnbBHHYQiv9MW8 · frame 132:5 "01 · Results — default" · 1 thread · 1 annotation

1873426532 · Eun Ji Jung · 2026-08-05 19:22
  on 132:5 "01 · Results — default" FRAME
  have hover states

annotation on 132:258 "Overview" FRAME
  allow for collapsing panels
```

A scoped call gets them free — the subtree it already fetched to resolve layer names carries
them. A whole-file call pays for a full document fetch (a few MB, about a second), because
annotations sit arbitrarily deep and a depth-limited fetch would miss exactly the ones worth
having. Pass `include_annotations: false` to skip it.

### Scoping: the frame link problem

Every Figma share link copied off a selected frame carries `?node-id=`. The first version of
this server parsed the file key out of that URL and threw the rest away — so linking one
frame and linking the whole file were indistinguishable, and both returned every comment on
the file.

That failure is quiet and expensive. Ask about one frame, get eight threads back with no
indication that seven of them are about something else, and the agent will happily act on
all of them.

So `list_figma_comments` now scopes to the linked frame by default:

```
rNK3UkoeLnbBHHYQiv9MW8 · frame 132:5 "01 · Results — default" · 1 thread
7 more threads elsewhere on this file — re-run with scope:"file" to read them.
```

Three rules make it predictable:

- **Descendants count.** A comment is pinned to whatever layer was under the cursor, so a
  note about a frame is usually anchored to a text run several levels down. Matching the
  frame id alone would return almost nothing.
- **Ancestors don't.** A comment on the section *containing* this frame is about the section.
  Pulling it in would re-create the same over-broad answer in a subtler form.
- **What's excluded is always counted.** Silent filtering is as misleading as silent
  over-fetching. The out-of-scope line is not optional output.

`node_id` overrides the URL; `scope: "file"` overrides both.

### Why the image tool exists

Layer names stop helping exactly where you need them most.

A comment pinned to a frame resolves to something useful: `01 · Results — default`. A comment
pinned to a pasted screenshot resolves to `image 21`, type `RECTANGLE`. Technically correct,
completely useless — and *"too much space here"* is unanswerable without seeing it.

So `list_figma_comments` flags those pins, and `get_figma_comment_image` renders the node so
the agent can look at it.

Renders are size-budgeted. A full-page frame comes back around 650KB at scale 1, which costs
more context than the answer is worth, so anything over ~400KB is re-rendered at a lower scale
until it fits. When that happens the response says so rather than quietly handing back
something different from what was asked for.

Rendering is the expensive call in this server by a wide margin — a full frame runs a couple
of thousand tokens against a listing's few hundred. The tool description says so, so it gets
called when the words genuinely aren't enough rather than by reflex.

### Point pins vs. region pins

Figma has two kinds of pin and the difference carries meaning. A point pin is a dot. A region
pin is a box someone dragged over an area — the comment is about everything inside it, not the
pixel underneath. On a real design file, roughly half the comments turn out to be regions.

Region pins are marked `[area]` in the listing. The pixel dimensions are not reported: which
kind of pin it is changes how the comment reads, the exact numbers never did.

## Output format

The listing is plain text, not JSON. It is read by a language model, and pretty-printed JSON
spent most of its bytes on punctuation, indentation, and keys whose value was `null` on nearly
every thread.

```
1873426532 · Eun Ji Jung · 2026-08-05 19:22
  on 132:5 "01 · Results — default" FRAME
  have hover states
```

Measured against the same file (8 threads):

| | chars |
|---|---|
| Pretty JSON, whole file | 4,687 |
| Text, whole file | 1,397 |
| Text, scoped to one frame | 273 |

## Setup

Node 20 or newer. Nothing else to install globally.

### 1. Clone and build

```bash
git clone https://github.com/ejun-9/figma-comments-mcp.git
cd figma-comments-mcp
npm install
npm run build
```

The client runs `dist/`, not `src/`, so the build step is not optional.

### 2. Make a Figma token

Figma → your avatar → **Settings** → **Security** → **Personal access tokens** → *Generate
new token*.

Scopes matter here, and the two you need are not both obvious:

| Scope | Set to | Why |
|---|---|---|
| **File content** | Read-only | Layer names, the file document, and image renders |
| **Comments** | Read-only | The comment threads themselves |

File content alone is the easy mistake — the server starts fine, resolves layer names fine,
and then returns a 403 the moment it asks for comments. Read-only is enough for both; this
server never writes.

Copy the token when it's shown. Figma will not show it again.

### 3. Point your client at it

**Claude Code** — one command, run it anywhere:

```bash
claude mcp add figma-comments --env FIGMA_TOKEN=figd_your_token_here -- node /absolute/path/to/figma-comments-mcp/dist/index.js
```

**Claude Desktop** — edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(on Windows, `%APPDATA%\Claude\claude_desktop_config.json`):

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

The path must be absolute — `~` and relative paths will not resolve.

### 4. Restart the client

MCP servers are spawned once when the client launches. Editing the config, or rebuilding
`dist/`, does nothing to a session that is already running. This catches everyone at least
once.

### 5. Check it works

Before involving the client at all:

```bash
FIGMA_TOKEN=figd_your_token_here npm run try -- "https://figma.com/design/<key>/...?node-id=1-2"
```

A working setup prints a headline and any threads:

```
rNK3UkoeLnbBHHYQiv9MW8 · frame 132:5 "01 · Results — default" · 1 thread · 1 annotation

1873426532 · Eun Ji Jung · 2026-08-05 19:22
  on 132:5 "01 · Results — default" FRAME
  have hover states
```

If that works and the client doesn't, the problem is the config or the restart, not the token.

## Usage

Paste a Figma URL and ask for what you want. A link copied off a selected frame scopes to
that frame:

> "Read the comments on https://figma.com/design/abc123/...?node-id=132-5 and apply them."
>
> "What's still open across the whole file?"
>
> "What did I annotate on this frame?"

Copy the link from Figma with the frame selected — that is what puts `node-id` in the URL and
keeps the answer to the frame you mean.

## Trying it without a client

```bash
npm run try -- "https://figma.com/design/<key>/...?node-id=132-5"        # scoped to the frame
npm run try -- "https://figma.com/design/<key>/..." --all                # whole file
npm run try -- "https://figma.com/design/<key>/..." --image 115-67       # render a node to disk
```

This spawns the server and speaks real JSON-RPC to it, so it exercises the transport rather
than importing the functions directly. It reads `FIGMA_TOKEN` from the environment, falling
back to the Claude Desktop config so there's nothing to set up twice.

## Troubleshooting

| What you see | What it is |
|---|---|
| `403` on every call | The token is missing the **Comments** scope, or it has expired. File content alone is not enough. |
| `403` on some calls only | The token works but the account cannot see this particular file. Check you can open it in the browser while signed in as the same user. |
| `404` on a file that exists | Wrong file key, or the file belongs to an org the token's account is not in. |
| `429` | Figma rate limit. Wait and retry. |
| `FIGMA_TOKEN is not set` | The client isn't passing the env var. In Claude Desktop it must be inside the server's `env` block, not your shell. |
| Server not listed in the client | Restart it. See step 4. |
| Changes to `src/` have no effect | `npm run build`, then restart the client. |
| `No node "1:2" in this file` | The `node-id` in the URL isn't in this file — usually a URL from a different file. Pass `scope: "file"` to search everything. |

## Notes

- Built on `@modelcontextprotocol/server` v2, over stdio.
- Hits the Figma REST API directly with `fetch` — no SDK, no extra HTTP client.
- Auth is the `X-Figma-Token` header. `figd_` personal access tokens reject
  `Authorization: Bearer`, which is the first thing to check on a 401 or 403.
- Endpoints used, all read-only: `/v1/files/:key/comments`, `/v1/files/:key/nodes`,
  `/v1/files/:key`, `/v1/images/:key`.
- A scoped call fetches the frame's subtree, which already carries every layer name and
  annotation it needs — so it skips the separate name-resolution round trip a whole-file call
  has to make.
- Run `npm run build` after any change to `src/` — the client runs `dist/`, not `src/`.

## License

ISC.
