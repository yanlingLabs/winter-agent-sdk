// Phase 5 Task 7 (Lane K, R5-4): WHAT SURVIVES A COMPACTION.
//
// This is the whole of the lane's obligation on the retention side, because the ENGINE TAKES
// `retained` LITERALLY (compaction/seam.ts's own note, pinned by the seam contract test): with
// `retained: []` the entire conversation -- including the envelope's own just-pushed user message --
// is replaced by the summary. Nothing downstream re-adds context, so anything this file drops is
// gone from the live history for the rest of the session.
//
// The unit of retention is a TURN, not a message. R5-4 says "the last N user/assistant pairs with
// their tool results intact", and the only way to keep tool results intact is to cut at a boundary
// that never separates an assistant `tool_use` from the `tool_result` answering it: a provider
// handed an orphan tool_result rejects the request outright. Cutting at the START of a user message
// gives that for free -- everything between two user prompts (the assistant's tool rounds and the
// tool-role results answering them) lands on the same side of the cut, whole.
//
// ONE DEGRADATION, deliberately narrow (see selectRetention). A single long agentic turn is exactly
// where a context window actually fills, and it has only ONE turn start -- so a turn-start-only rule
// could never compact the case it exists for. When (and only when) the history holds no more than
// one turn start, the cut degrades to ROUND starts: an assistant message, which is still a boundary
// that keeps every tool round whole.
import type { ContentBlock, ProviderMessage } from "../engine.ts";

/** R5-4's own default: the last four user/assistant pairs. An option on the controller. */
export const DEFAULT_RETAINED_PAIRS = 4;

export interface RetentionPlan {
  /**
   * False when the window covers the whole history -- there is no cut that both keeps the requested
   * pairs and folds anything. `retained` then holds the input unchanged and `summarized` is empty;
   * the CONTROLLER turns this into a thrown error, because a `CompactionResult` whose `retained` is
   * the whole input would make the engine's history LONGER (summary + everything) on every round.
   */
  foldable: boolean;
  /** The messages that survive the boundary, in order. */
  retained: ProviderMessage[];
  /** The messages the summary replaces -- what the summarizer is asked to condense. */
  summarized: ProviderMessage[];
}

function blocksOf(message: ProviderMessage): ContentBlock[] {
  return typeof message.content === "string" ? [] : message.content;
}

/**
 * A conversational turn opens at a user PROMPT. A `user` message whose blocks are all `tool_result`
 * is a tool-result carrier, not a prompt: the engine puts those on `role: "tool"` today, but the
 * WIRE shape does carry them as user messages (WS-03 §8), so a future producer that reused the role
 * here must not make every tool round look like a fresh conversational turn.
 */
function isTurnStart(message: ProviderMessage): boolean {
  if (message.role !== "user") return false;
  const blocks = blocksOf(message);
  if (blocks.length === 0) return true;
  return !blocks.every((b) => b.type === "tool_result");
}

/** A round opens at an assistant message -- the fallback boundary for a single long agentic turn. */
function isRoundStart(message: ProviderMessage): boolean {
  return message.role === "assistant";
}

function indicesWhere(messages: readonly ProviderMessage[], predicate: (m: ProviderMessage) => boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < messages.length; i++) if (predicate(messages[i]!)) out.push(i);
  return out;
}

/** The `n`-th boundary counted from the END of `boundaries`, or undefined when there are fewer than `n`. */
function nthFromEnd(boundaries: readonly number[], n: number): number | undefined {
  return boundaries[boundaries.length - n];
}

export interface RetentionOptions {
  /** How many pairs (turns) to keep. Defaults to DEFAULT_RETAINED_PAIRS. */
  pairs?: number;
}

export function selectRetention(messages: readonly ProviderMessage[], opts: RetentionOptions = {}): RetentionPlan {
  const raw = opts.pairs;
  const pairs = typeof raw === "number" && Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_RETAINED_PAIRS;
  const nothingFolded: RetentionPlan = { foldable: false, retained: [...messages], summarized: [] };
  if (messages.length === 0) return nothingFolded;

  const turnStarts = indicesWhere(messages, isTurnStart);

  // The normal case: cut at the `pairs`-th turn start from the end. A cut of 0 (or no such start)
  // means the requested window already covers everything -- there is nothing older to fold, and
  // shrinking the window silently would retain less than the caller asked for.
  if (turnStarts.length > 1) {
    const cut = nthFromEnd(turnStarts, pairs);
    if (cut === undefined || cut === 0) return nothingFolded;
    return { foldable: true, retained: messages.slice(cut), summarized: messages.slice(0, cut) };
  }

  // The degradation: at most one turn start, so "N pairs" is unsatisfiable by construction and a
  // turn-start cut can only ever be 0. Fall back to round starts INSIDE the turn -- `pairs` now
  // counts tool rounds. Still never a `tool` message: the boundary is the assistant message that
  // opened the round, so its results ride along with it.
  const roundStarts = indicesWhere(messages, isRoundStart).filter((i) => i > 0);
  const cut = nthFromEnd(roundStarts, pairs);
  if (cut === undefined) return nothingFolded;
  return { foldable: true, retained: messages.slice(cut), summarized: messages.slice(0, cut) };
}

/**
 * WS-09 §8.5: the tools the compacted context still carries EVIDENCE of. `registry.onCompaction`
 * resets the session's deferred loaded set to `evidenced ∩ still-registered`, so a tool whose call
 * the summary swallowed goes back to searchable-not-loaded and must be rediscovered.
 *
 * DISCLOSED READING of the brief's "deferred tools referenced in retained messages": this returns
 * EVERY referenced name, not a `descriptor.deferred`-filtered subset. The filtered set would be
 * behaviourally identical at best -- `LoadedToolSet` only ever holds names Tool Search actually
 * loaded, and `onCompaction` intersects rather than unions -- and strictly worse at worst: a
 * descriptor whose `deferred` is a `PermissionMode[]` reads as not-deferred outside those modes, so
 * filtering here would silently unload a tool the model is still visibly using. Over-reporting
 * cannot add anything to the loaded set; under-reporting drops something from it.
 */
export function evidencedToolNames(retained: readonly ProviderMessage[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const message of retained) {
    for (const block of blocksOf(message)) {
      if (block.type !== "tool_use" || seen.has(block.name)) continue;
      seen.add(block.name);
      ordered.push(block.name);
    }
  }
  return ordered;
}
