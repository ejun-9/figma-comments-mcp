const FIGMA_API_BASE = 'https://api.figma.com/v1';

/**
 * Where a comment is pinned.
 *
 * Verified against a real file rather than the docs. Node-anchored pins come in
 * two flavours and the difference matters: a plain pin is a point, but one with
 * region_width/height is a box the author dragged over an area — an annotation
 * covering "this whole row", not "this spot". Roughly half of real comments on a
 * design file turn out to be regions.
 *
 * The bare { x, y } canvas pin is documented but did not appear in testing; it's
 * kept as a fallback.
 */
export type NodePin = {
  node_id: string;
  node_offset: { x: number; y: number };
  stable_path?: string[];
  region_width?: number;
  region_height?: number;
  comment_pin_corner?: string;
};

export type CommentPin = NodePin | { x: number; y: number };

export interface FigmaComment {
  id: string;
  message: string;
  file_key: string;
  parent_id: string;
  user: { handle: string };
  created_at: string;
  resolved_at: string | null;
  client_meta: CommentPin | null;
}

export class FigmaError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(explain(status, body));
    this.name = 'FigmaError';
  }
}

/**
 * Turn a status code into something worth reading at 11pm. The raw Figma body
 * is appended, but the leading sentence should be enough on its own.
 */
function explain(status: number, body: string): string {
  const hint =
    status === 403
      ? 'Figma rejected the token (403). It may have expired, or it may not have access to this file. Note that figd_ tokens must be sent as X-Figma-Token — Authorization: Bearer is rejected.'
      : status === 404
        ? 'File not found (404). Either the file key is wrong, or the token belongs to an account that cannot see this file.'
        : status === 429
          ? 'Rate limited by Figma (429). Wait a moment and retry.'
          : `Figma API error ${status}.`;
  return body ? `${hint}\n\nFigma said: ${body}` : hint;
}

const FIGMA_TOKEN = process.env.FIGMA_TOKEN;

export async function figmaFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${FIGMA_API_BASE}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      'X-Figma-Token': FIGMA_TOKEN as string,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) {
    throw new FigmaError(res.status, await res.text());
  }
  return (await res.json()) as T;
}

/**
 * Accept anything that identifies a file: a bare key, or any of the URL shapes
 * Figma has shipped (/file/, /design/, /proto/, /board/). Pasting the URL is
 * what people actually do.
 */
export function parseFileKey(input: string): string {
  const trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;

  const match = trimmed.match(/\/(?:file|design|proto|board|slides)\/([A-Za-z0-9]+)/);
  if (!match) {
    throw new Error(
      `Could not find a file key in "${input}". Expected a URL like figma.com/design/<key>/... or a bare file key.`
    );
  }
  return match[1];
}

/**
 * Figma writes node ids as "1:23" in the API but "1-23" in URLs. Callers may
 * paste either.
 */
export function normalizeNodeId(id: string): string {
  return id.replace(/-/g, ':');
}

/**
 * Pull the node id out of a Figma URL, if it has one.
 *
 * This is the difference between "here is my file" and "here is this frame".
 * Every share link copied off a selected frame carries `?node-id=`, and
 * dropping it silently — which this server used to do — turns a question about
 * one frame into an answer about the whole file.
 *
 * Returns null for a bare file key or a URL with no node-id.
 */
export function parseNodeId(input: string): string | null {
  const trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;

  const match = trimmed.match(/[?&]node[-_]id=([^&#]+)/i);
  if (!match) return null;

  return normalizeNodeId(decodeURIComponent(match[1]));
}

interface NodeDoc {
  id: string;
  name: string;
  type: string;
  annotations?: FigmaAnnotation[];
  children?: NodeDoc[];
}

/**
 * A Dev Mode annotation. Not a comment — a different feature, a different
 * place in the API, and the reason this server used to under-report a frame:
 * annotations live on the node itself, so a file with six of them looks empty
 * to anything that only reads /comments.
 *
 * `label` is the note. `properties` are the layer properties pinned alongside
 * it (width, fill…), and an annotation may carry those with no label at all.
 */
export interface FigmaAnnotation {
  label?: string;
  properties?: { type: string }[];
}

export interface AnnotatedNode {
  nodeId: string;
  name: string;
  type: string;
  annotations: FigmaAnnotation[];
}

/** Every annotated node at or below `root`, in document order. */
function collectAnnotations(root: NodeDoc): AnnotatedNode[] {
  const out: AnnotatedNode[] = [];
  const walk = (node: NodeDoc) => {
    if (node.annotations?.length) {
      out.push({
        nodeId: node.id,
        name: node.name,
        type: node.type,
        annotations: node.annotations
      });
    }
    node.children?.forEach(walk);
  };
  walk(root);
  return out;
}

/**
 * Every node inside `rootId`, including `rootId` itself, mapped to its name
 * and type.
 *
 * Scoping has to include descendants: a comment is pinned to whatever layer sat
 * under the cursor, so a note about a frame is usually anchored to a button or
 * a text run several levels down, not to the frame. Matching the frame id alone
 * would return almost nothing.
 *
 * Ancestors are deliberately excluded. A comment on the section that contains
 * this frame is about the section — pulling it in would re-create the same
 * over-broad answer in a subtler form.
 *
 * Returns names as well as ids so a scoped call can skip resolveNodeNames
 * entirely — the subtree already has every name it needs. Annotations come out
 * of the same payload, so reading them costs nothing extra.
 */
export async function descendantNodes(
  fileKey: string,
  rootId: string
): Promise<{ names: Map<string, NodeInfo>; annotations: AnnotatedNode[] }> {
  const names = new Map<string, NodeInfo>();

  const data = await figmaFetch<{
    nodes: Record<string, { document?: NodeDoc } | null>;
  }>(`/files/${fileKey}/nodes?ids=${encodeURIComponent(rootId)}`);

  const root = data.nodes?.[rootId]?.document;
  if (!root) {
    throw new Error(
      `No node "${rootId}" in this file. Check the node-id in the URL, or pass scope:"file" to search the whole file.`
    );
  }

  const walk = (node: NodeDoc) => {
    names.set(node.id, { name: node.name, type: node.type });
    node.children?.forEach(walk);
  };
  walk(root);

  return { names, annotations: collectAnnotations(root) };
}

/**
 * Every annotation in the file.
 *
 * There is no annotations endpoint, and annotations sit arbitrarily deep, so a
 * depth-limited fetch would miss exactly the ones worth having. That means
 * pulling the whole document — a few MB and about a second on a real design
 * file. Only the whole-file path pays it; a scoped call gets its annotations
 * out of the subtree it already fetched.
 *
 * Never throws: annotations are an enrichment, and losing them should not fail
 * a call that was primarily about comments.
 */
export async function fileAnnotations(fileKey: string): Promise<AnnotatedNode[]> {
  try {
    const data = await figmaFetch<{ document?: NodeDoc }>(`/files/${fileKey}`);
    return data.document ? collectAnnotations(data.document) : [];
  } catch {
    return [];
  }
}

export function pinNodeId(pin: CommentPin | null): string | null {
  if (pin && 'node_id' in pin && pin.node_id) return normalizeNodeId(pin.node_id);
  return null;
}

export interface NodeInfo {
  name: string;
  type: string;
}

/**
 * Resolve node ids to human-readable layer names. This is what makes a pin
 * actionable — "on layer 'CTA button'" instead of "at {x: 40, y: 12}".
 *
 * Deliberately never throws: name resolution is an enrichment, and losing it
 * should degrade the output rather than fail the whole call.
 */
export async function resolveNodeNames(
  fileKey: string,
  nodeIds: string[]
): Promise<Map<string, NodeInfo>> {
  const out = new Map<string, NodeInfo>();
  const unique = [...new Set(nodeIds)].filter(Boolean);
  if (unique.length === 0) return out;

  // Figma caps the ids query; batch conservatively.
  const BATCH = 50;
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    try {
      const data = await figmaFetch<{
        nodes: Record<string, { document?: { id: string; name: string; type: string } } | null>;
      }>(`/files/${fileKey}/nodes?ids=${encodeURIComponent(batch.join(','))}`);

      for (const [id, entry] of Object.entries(data.nodes ?? {})) {
        const doc = entry?.document;
        if (doc) out.set(id, { name: doc.name, type: doc.type });
      }
    } catch {
      // Enrichment only — leave these ids unresolved.
    }
  }
  return out;
}

/**
 * Render a node to an image and return the bytes.
 *
 * This exists because layer names stop helping exactly when you need them most.
 * A comment pinned to a pasted screenshot resolves to something like
 * "image 21" (RECTANGLE) — technically correct, completely useless. The only
 * way to act on "too much space here" is to look at it.
 */
/**
 * Roughly a 1000×1000 screenshot. Above this the base64 payload starts costing
 * more context than the answer is worth — a full-page frame at scale 1 came back
 * at 650KB in testing, which is not a thing you can call twice.
 */
const MAX_IMAGE_BYTES = 400_000;
const MIN_SCALE = 0.15;

async function renderOnce(
  fileKey: string,
  nodeId: string,
  scale: number,
  format: 'png' | 'jpg'
): Promise<Buffer> {
  const res = await figmaFetch<{ err: string | null; images: Record<string, string | null> }>(
    `/images/${fileKey}?ids=${encodeURIComponent(nodeId)}&format=${format}&scale=${scale}`
  );
  if (res.err) throw new Error(`Figma could not render ${nodeId}: ${res.err}`);

  const url = res.images?.[nodeId];
  if (!url) {
    throw new Error(
      `Figma returned no image for ${nodeId}. Nodes that render to nothing (zero-size or fully hidden layers) come back empty.`
    );
  }

  // The render URL is a short-lived signed link, so inline the bytes rather than
  // handing back a URL that will be dead by the time anyone clicks it.
  const img = await fetch(url);
  if (!img.ok) throw new Error(`Failed to download the rendered image (${img.status}).`);
  return Buffer.from(await img.arrayBuffer());
}

export async function renderNode(
  fileKey: string,
  nodeId: string,
  opts: { scale?: number; format?: 'png' | 'jpg' } = {}
): Promise<{ data: string; mimeType: string; bytes: number; scale: number; downscaled: boolean }> {
  const format = opts.format ?? 'png';
  const requested = opts.scale ?? 1;

  let scale = requested;
  let buf = await renderOnce(fileKey, nodeId, scale, format);

  // Big frames and whole sections blow past anything usable at scale 1. Halve
  // until it fits rather than handing back something that cannot be read.
  while (buf.byteLength > MAX_IMAGE_BYTES && scale > MIN_SCALE) {
    scale = Math.max(MIN_SCALE, Number((scale / 2).toFixed(3)));
    buf = await renderOnce(fileKey, nodeId, scale, format);
  }

  return {
    data: buf.toString('base64'),
    mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
    bytes: buf.byteLength,
    scale,
    downscaled: scale !== requested
  };
}
