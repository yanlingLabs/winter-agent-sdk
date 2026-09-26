// WS-23 (reasoning-state): Anthropic-family thinking, carried BESIDE the transcript instead of inside it.
//
// THE TRANSCRIPT IS PROVIDER-NEUTRAL NOW: an assistant entry holds text, tool_use and tool_result, and
// nothing a single vendor minted. The `thinking` / `redacted_thinking` blocks a Claude turn produced --
// with their signatures and opaque `data`, which the API requires back unmodified and in place inside
// an active tool loop -- ride the provider-state sidecar as a `reasoning-blocks` record instead: each
// block VERBATIM plus `at`, its index in the turn's stream-order content. On the way back they are
// folded into the message's `nativeState` as items of the tagged type below, so the continuity
// renderer's one rule covers them with no new branch: same continuation domain (or the same model) ->
// they ride; any other target -> they are dropped with the rest of the native state, and the message's
// readable thinking becomes at most one `<recovered_reasoning>` decoration.
//
// THE ANTHROPIC ADAPTER PUTS THEM BACK (`spliceReasoningBlocks`), and the splice must reproduce the
// pre-move content array byte for byte -- that array is the cached prefix, and on the block-binding
// rows (Opus 5.5 / Fable 5.1) an edited thinking block also invalidates every later one. Inserting the
// blocks in ascending `at` order into the neutral content rebuilds it exactly: after every block whose
// original index is below `k` is back, index `k` is precisely where the next one belongs.
//
// TAGGED, never bare. `nativeState.items` is replayed verbatim by the Responses adapter, so an item a
// foreign adapter could mistake for its own is a latent 400. The `type` tag is what lets the Anthropic
// adapter take exactly these and every other adapter ignore them (the renderer never lets them cross a
// domain boundary anyway).
//
// INLINE WINS. A transcript written before the move carries its thinking in the content. Such a message
// is replayed as it stands and any sidecar blocks for the same anchor are ignored -- never merged,
// because a signed block sent twice is a 400.
import type { ContentBlockLike, ProviderNativeState } from "../types.ts";

/** The `type` tag of one sidecar-carried in-dialect reasoning block inside `nativeState.items`. */
export const REASONING_BLOCK_ITEM_TYPE = "winter.reasoning_block" as const;

/** An Anthropic-family in-dialect reasoning block, verbatim: signature and opaque data intact. */
export type InDialectReasoningBlock = Extract<ContentBlockLike, { type: "thinking" }> | Extract<ContentBlockLike, { type: "redacted_thinking" }>;

/** One block and its index in the turn's stream-order content. */
export interface ReasoningBlockAt {
  at: number;
  block: InDialectReasoningBlock;
}

/** The item a `reasoning-blocks` sidecar record folds into (`nativeState.items`). */
export interface ReasoningBlockItem extends ReasoningBlockAt {
  type: typeof REASONING_BLOCK_ITEM_TYPE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural check of one in-dialect block. Never a cast: these bytes came off disk. */
export function coerceInDialectReasoningBlock(value: unknown): InDialectReasoningBlock | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "thinking" && typeof value.thinking === "string" && typeof value.signature === "string") return { type: "thinking", thinking: value.thinking, signature: value.signature };
  if (value.type === "redacted_thinking" && typeof value.data === "string") return { type: "redacted_thinking", data: value.data };
  return undefined;
}

export function isReasoningBlockItem(item: unknown): item is ReasoningBlockItem {
  return isRecord(item) && item.type === REASONING_BLOCK_ITEM_TYPE && typeof item.at === "number" && Number.isInteger(item.at) && item.at >= 0 && coerceInDialectReasoningBlock(item.block) !== undefined;
}

/** The tagged items for a list of blocks, in `at` order. */
export function reasoningBlockItems(blocks: readonly ReasoningBlockAt[]): ReasoningBlockItem[] {
  return [...blocks].sort((a, b) => a.at - b.at).map(({ at, block }) => ({ type: REASONING_BLOCK_ITEM_TYPE, at, block }));
}

/** A message's sidecar-carried reasoning blocks, in `at` order; empty when it has none. */
export function reasoningBlocksOf(state: ProviderNativeState | undefined): ReasoningBlockItem[] {
  if (state === undefined) return [];
  return state.items.filter(isReasoningBlockItem).sort((a, b) => a.at - b.at);
}

/** Does this content still carry in-dialect reasoning of its own (a transcript written before the move)? */
export function hasInlineReasoning(content: string | readonly ContentBlockLike[]): boolean {
  return typeof content !== "string" && content.some((block) => block.type === "thinking" || block.type === "redacted_thinking");
}

/**
 * Splits a turn's stream-order content into the provider-neutral content the transcript keeps and the
 * in-dialect blocks the sidecar keeps, each with its original index.
 */
export function separateReasoningBlocks<B extends ContentBlockLike>(content: readonly B[]): { neutral: B[]; blocks: ReasoningBlockAt[] } {
  const neutral: B[] = [];
  const blocks: ReasoningBlockAt[] = [];
  content.forEach((block, at) => {
    if (block.type === "thinking" || block.type === "redacted_thinking") blocks.push({ at, block: block as InDialectReasoningBlock });
    else neutral.push(block);
  });
  return { neutral, blocks };
}

/**
 * The content the model produced, rebuilt from the neutral content and the sidecar blocks.
 *
 * A collapsed string (the in-memory and resumed shape of a lone text block) is a one-block array again
 * first -- the pre-move content always held the text as a block beside the thinking. `at` past the end
 * (a corrupt record) appends rather than throws: the bytes are then wrong for the cache, not fatal.
 */
export function spliceReasoningBlocks(content: string | readonly ContentBlockLike[], items: readonly ReasoningBlockAt[]): ContentBlockLike[] {
  const out: ContentBlockLike[] = typeof content === "string" ? [{ type: "text", text: content }] : [...content];
  for (const { at, block } of [...items].sort((a, b) => a.at - b.at)) out.splice(Math.min(at, out.length), 0, { ...block });
  return out;
}

/**
 * The message's content as the model wrote it, when its reasoning rides the sidecar: the splice above,
 * or the content unchanged when there is nothing to put back or the content already carries its own
 * (inline wins, never both).
 */
export function contentWithReasoningBlocks(message: { content: string | ContentBlockLike[]; nativeState?: ProviderNativeState }): string | ContentBlockLike[] {
  const items = reasoningBlocksOf(message.nativeState);
  if (items.length === 0 || hasInlineReasoning(message.content)) return message.content;
  return spliceReasoningBlocks(message.content, items);
}

/**
 * The READABLE half of a message's sidecar-carried thinking -- each `thinking` block's own text, joined
 * in order -- for the cross-family decoration. Never `signature`, never `redacted_thinking.data`.
 */
export function reasoningBlocksVisibleText(state: ProviderNativeState | undefined): string | undefined {
  // The same join the renderer applied to inline blocks before the move (`visibleThinkingText`), empty
  // blocks included, so a cross-family decoration's text is unchanged by where the blocks live.
  const texts = reasoningBlocksOf(state).flatMap(({ block }) => (block.type === "thinking" ? [block.thinking] : []));
  return texts.length > 0 ? texts.join("\n\n") : undefined;
}
