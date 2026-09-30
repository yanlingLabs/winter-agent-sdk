// Code-mode images: the PER-REQUEST image budget.
//
// Every request resends the whole conversation, images included. Each image is bounded where it is made
// (the Read tool / MCP preparation: at most 1568 px on its long edge and 3.75 MiB), but a long session
// accumulates them, and every provider bounds a REQUEST too -- by bytes and/or by image count. A request
// over that bound is refused, and since the images stay in the history, so is every later request: the
// session is stuck. So before the wire, the OLDEST images beyond the target's budget become a short text
// note, the way `representableFor` (renderer.ts) turns an image into a note for a model that reads none.
//
// THE CACHE TRADE-OFF. Turning an old image into a note changes the prompt at that point, so the cached
// prefix is lost from there on for that request. Dropping exactly "as many as needed" would move that
// point on EVERY turn once a session is over budget (each new image pushes one more old one out). The
// drop count is therefore rounded UP to a whole STEP of images (a quarter of the count budget, 1..4): the
// prefix changes once per step's worth of new images, and the requests in between are byte-stable. It is
// a pure function of the messages and the budget -- no state -- so a resumed session drops exactly what
// the live one did.
import type { ContentBlockLike, ProviderMessageLike } from "../types.ts";

/** A per-request image budget: how many images, and how many bytes of base64 image data, one request may carry. */
export interface ImageBudget {
  maxImages: number;
  maxBytes: number;
}

/** What an image left out for the budget becomes. */
export const IMAGE_BUDGET_NOTE = "[an earlier image was left out here to keep this request within the provider's image limits]";

const MiB = 1024 * 1024;

/**
 * The budget for a request target. Each number is the provider's documented limit, or a margin under it
 * where the documented limit also covers the request's text:
 *
 * - Claude on Anthropic's own API (`anthropic`, `console`): "100 per request on the API, for models with a
 *   200k-token context window", "600 per request on the API, for all other models", and a 32 MB request
 *   limit for standard endpoints (https://platform.claude.com/docs/en/build-with-claude/vision, "Request
 *   limits"). 24 MiB of image data leaves 8 MB for everything else. A row whose context window is not
 *   known gets the safe 100.
 * - Other Anthropic-dialect endpoints (DeepSeek, Kimi, MiniMax, Z.ai and the rest of the
 *   `*-anthropic` providers): they speak the Messages API but publish none of Claude's limits, so the
 *   conservative default below, not Claude's.
 * - `bedrock`: "You can include up to 20 images" per Converse message, each at most 3.75 MB
 *   (https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Message.html), and Claude's
 *   request limit on Bedrock is below the API's 32 MB (same vision page). 20 images and 14 MiB, applied
 *   per request, which also covers a merged user turn.
 * - `google` (Gemini, Vertex): "Inline image data limits your total request size (text prompts, system
 *   instructions, and inline bytes) to 20MB" (https://ai.google.dev/gemini-api/docs/image-understanding).
 *   14 MiB of image data; no count limit of ours (the bytes bind first).
 * - `mistral` and `codestral` (Mistral's API): "The maximum number images per request via API is 8"
 *   (Mistral's vision FAQ, https://docs.mistral.ai/capabilities/vision/). 8 images, and the default 20 MiB.
 * - `openai` (OpenAI's own API): "Up to 512 MB total payload per request", "Up to 1,500 images per
 *   request" (https://developers.openai.com/api/docs/guides/images-vision). 1,500 images and 256 MiB.
 * - `azure-openai`: "Maximum number of images per request" is 50 for the vision models
 *   (https://learn.microsoft.com/en-us/azure/foundry/openai/quotas-limits); no published byte figure, so
 *   the default 20 MiB.
 * - Anything else -- `codex-oauth` (the ChatGPT backend publishes no limits), xAI, the OpenAI-compatible
 *   providers, the local runners: no published limit we rely on, so a conservative 20 images and 20 MiB.
 */
export function imageBudgetFor(target: { family: string; providerId?: string; contextWindow?: number }): ImageBudget {
  const provider = target.providerId ?? "";
  const conservative: ImageBudget = { maxImages: 20, maxBytes: 20 * MiB };
  if (provider === "mistral" || provider === "codestral") return { maxImages: 8, maxBytes: 20 * MiB };
  if (provider === "anthropic" || provider === "console") return { maxImages: target.contextWindow !== undefined && target.contextWindow > 200_000 ? 600 : 100, maxBytes: 24 * MiB };
  if (target.family === "anthropic") return conservative;
  if (target.family === "bedrock") return { maxImages: 20, maxBytes: 14 * MiB };
  if (target.family === "google") return { maxImages: Number.MAX_SAFE_INTEGER, maxBytes: 14 * MiB };
  if (provider === "openai") return { maxImages: 1500, maxBytes: 256 * MiB };
  if (provider === "azure-openai") return { maxImages: 50, maxBytes: 20 * MiB };
  return conservative;
}

/**
 * How many images a drop is rounded up to (see the header's cache trade-off). Derived from the BUDGET
 * only -- never from how many images happen to be present, which made the drop jump and even SHRINK as a
 * history grew (dropped images came back, and the prefix moved every turn). A quarter of the count
 * budget, between 1 and 4: small enough that a byte-limited budget of large images still keeps most of
 * what fits, large enough that the prefix moves once per few new images rather than every turn.
 */
function dropStep(budget: ImageBudget): number {
  return Math.max(1, Math.min(4, Math.floor(budget.maxImages / 4)));
}

/** How deep images are looked for inside nested tool results -- ONE limit for counting and for rewriting. */
const MAX_IMAGE_DEPTH = 8;

function visitImages(content: string | ContentBlockLike[], visit: (image: Extract<ContentBlockLike, { type: "image" }>) => void, depth = 0): void {
  if (typeof content === "string" || depth > MAX_IMAGE_DEPTH) return;
  for (const block of content) {
    if (block.type === "image") visit(block);
    else if (block.type === "tool_result") visitImages(block.content, visit, depth + 1);
  }
}

/**
 * `messages` with the OLDEST images turned into `IMAGE_BUDGET_NOTE` until what is left fits `budget`,
 * the drop rounded up to a whole step. Returned by identity when everything fits.
 *
 * Two guarantees, both pinned by tests over a sweep of history lengths:
 * - MONOTONIC: as a history grows (images appended), the number dropped never decreases -- an image
 *   left out never comes back, so the prefix up to the last drop point is stable.
 * - THE NEWEST STAYS: when the newest image fits the budget on its own, it is never dropped (the image
 *   the model just read is the one it needs).
 */
export function withinImageBudget<M extends ProviderMessageLike>(messages: readonly M[], budget: ImageBudget): M[] {
  const sizes: number[] = [];
  for (const message of messages) visitImages(message.content, (image) => sizes.push(image.source.data.length));
  let total = sizes.reduce((a, b) => a + b, 0);
  if (sizes.length <= budget.maxImages && total <= budget.maxBytes) return messages as M[];

  // The fewest oldest images to leave out so the rest fits, then rounded up to a whole step.
  let drop = 0;
  while (drop < sizes.length && (sizes.length - drop > budget.maxImages || total > budget.maxBytes)) {
    total -= sizes[drop]!;
    drop++;
  }
  drop = Math.ceil(drop / dropStep(budget)) * dropStep(budget);
  const newestFitsAlone = budget.maxImages >= 1 && sizes[sizes.length - 1]! <= budget.maxBytes;
  drop = Math.min(drop, newestFitsAlone ? sizes.length - 1 : sizes.length);

  let seen = 0;
  const mapBlocks = (blocks: ContentBlockLike[], depth: number): ContentBlockLike[] =>
    blocks.map((block): ContentBlockLike => {
      if (block.type === "image") return seen++ < drop ? { type: "text", text: IMAGE_BUDGET_NOTE } : block;
      if (block.type === "tool_result" && Array.isArray(block.content) && depth < MAX_IMAGE_DEPTH) return { ...block, content: mapBlocks(block.content, depth + 1) };
      return block;
    });
  return messages.map((message) => {
    if (seen >= drop || typeof message.content === "string") return message;
    return { ...message, content: mapBlocks(message.content, 0) };
  });
}
