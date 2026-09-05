// Phase 6 Task 6 (Lane B): content-block traversal that does not stop at the top level.
//
// WHY THIS EXISTS. `ContentBlockLike.tool_result.content` is `string | ContentBlockLike[]` (R6-3),
// and P3-M's multimodal `Read` is the shape that fills it: derived-shapes item (f) records the pin's
// own prose that extracted page images are delivered SOLELY as image blocks in the model-facing
// `tool_result` content. So the interesting images in a real history are NESTED, and a capability
// gate written as `message.content.some(b => b.type === "image")` sees none of them — it passes a
// non-vision model a request the endpoint will reject, which is precisely the upstream failure the
// pre-request gate exists to prevent.
//
// Both families' serializers already recurse when they BUILD the wire block; only the gates did not.
// One traversal, used by both, so the two can never disagree about what a message contains.
import type { ContentBlockLike } from "../types.ts";

/**
 * How deep the walk goes.
 *
 * `tool_result.content` can nest a `tool_result` at the type level, and a cyclic or absurdly deep
 * structure would otherwise be a stack overflow reachable from history. Real content is one level
 * deep; the bound is a backstop, not a limit anyone should meet.
 */
const MAX_BLOCK_DEPTH = 8;

function blocksOf(content: string | ContentBlockLike[]): ContentBlockLike[] {
  return typeof content === "string" ? [] : content;
}

/** Every `image` block in `content`, including those nested inside a `tool_result`, in wire order. */
export function collectImages(content: string | ContentBlockLike[], depth = 0): Array<Extract<ContentBlockLike, { type: "image" }>> {
  if (depth >= MAX_BLOCK_DEPTH) return [];
  const out: Array<Extract<ContentBlockLike, { type: "image" }>> = [];
  for (const block of blocksOf(content)) {
    if (block.type === "image") out.push(block);
    else if (block.type === "tool_result") out.push(...collectImages(block.content, depth + 1));
  }
  return out;
}

/** True when `content` carries an image ANYWHERE — the capability gate's real question. */
export function containsImage(content: string | ContentBlockLike[]): boolean {
  return collectImages(content).length > 0;
}

// --- Winter-authored decorations (R6-3 `ProviderMessageLike.decoration`) ---------------------------

/**
 * The tag a decoration rides in.
 *
 * WINTER-AUTHORED, and deliberately not a vendor convention: the phase forbids vendor prompt text
 * anywhere, and this name is Winter's own. The WORDING inside is Lane C's — `decoration.text` — so
 * this layer decides only how the note is delimited, never what it says.
 */
const DECORATION_TAG = "winter-note";

/**
 * A decoration as PLAIN TEXT, for both doors.
 *
 * `door: "thinking-channel"` DEGRADES to the tag door for these two families, and that degradation
 * is the rule rather than a shortcut. Anthropic's thinking channel is signed and Gemini's is a
 * `thought` part the model produced — putting Winter-authored text into either would be exactly the
 * impersonation R6-8 exists to forbid (capture (F): the runtime materialises a signature for a
 * signatureless thinking block, so a foreign note placed there would ride a fabricated one). Carried
 * plainly is what R6-8 prescribes instead, and it is visible to the model either way.
 */
export function renderDecoration(decoration: { text: string; door: "tag" | "thinking-channel" }): string {
  return `<${DECORATION_TAG}>${decoration.text}</${DECORATION_TAG}>`;
}
