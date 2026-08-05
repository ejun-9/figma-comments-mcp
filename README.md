# figma-comments-mcp

An MCP server that lets Claude read Figma file comments directly.

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
| `list_figma_comments` | Reads comment threads on a file, **or on one frame within it**. Resolves each pin to the layer it sits on, so a comment arrives as *"on `01 · Results — default`"* rather than `{node_id: "132:5"}`. Filters resolved threads by default. Optional `since` returns anything with new activity — including old threads that just got a reply. |
| `get_figma_comment_image` | Renders whatever a comment is pinned to and returns it as an image. This is the one that matters for comments left on screenshots — see below. |

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

Generate the token at Figma → Settings → Security → Personal access tokens. It only needs
read access to files.

MCP servers are spawned once at client launch, so restart the app after editing the config.

## Usage

Paste a Figma URL and ask for what you want. A frame link scopes to that frame:

> "Read the comments on https://figma.com/design/abc123/...?node-id=132-5 and apply them."
>
> "What's still open across the whole file?"

## Trying it without a client

```bash
npm run try -- "https://figma.com/design/<key>/...?node-id=132-5"        # scoped to the frame
npm run try -- "https://figma.com/design/<key>/..." --all                # whole file
npm run try -- "https://figma.com/design/<key>/..." --image 115-67
```

This spawns the server and speaks real JSON-RPC to it, so it exercises the transport rather
than importing the functions directly. It reads `FIGMA_TOKEN` from the environment, falling
back to the Claude Desktop config so there's nothing to set up twice.

## Notes

- Built on `@modelcontextprotocol/server` v2, over stdio.
- Hits the Figma REST API directly with `fetch` — no SDK, no extra HTTP client.
- Auth is the `X-Figma-Token` header. `figd_` personal access tokens reject
  `Authorization: Bearer`, which is the first thing to check on a 401 or 403.
- A scoped call fetches the frame's subtree, which already carries every layer name it needs —
  so it skips the separate name-resolution round trip a whole-file call has to make.
- Run `npm run build` after any change to `src/` — the client runs `dist/`, not `src/`.
