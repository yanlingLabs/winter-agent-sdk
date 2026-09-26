// Phase 6 Lane C: the WARNING MATRIX -- report §8.4/§8.5, as a decision anyone can audit. REWRITTEN for
// WS-23 (reasoning-state, user decision 9): a switch loses ONLY what the target cannot represent.
//
// THE MATRIX WARNS IFF THE TRANSFER IS GENUINELY LOSSY. Both halves of that sentence are load-bearing.
// A warning on every model switch trains a reader to dismiss it, and by the time one means something
// nobody is looking; a MISSING warning on a lossy switch is worse still, because the user believes a
// continuation they are not getting.
//
// WHAT IS NO LONGER A LOSS, and why. A switch replays the ACTUAL conversation to the target -- nothing is
// summarized or forked -- and each model's reasoning state stays in the provider-state sidecar, keyed by
// its own continuation domain: the target gets the readable part as labelled data, and the source gets
// its own state back, natively, on a switch back. So "the reasoning context starts over" (the old
// triggers 1-3, 5 and 6) is not something the user loses by switching, and the prose that implied a
// summary hand-off ("the objective, the decisions already made...") described a mechanism that never
// ran. What IS lost is exactly four things:
//   - images or documents sent to a model that cannot read them (they reach it as a note that one was there);
//   - results of the source vendor's own SERVER tools (web search and the like), which another vendor's
//     model receives as plain text rather than as tool results;
//   - the conversation's older part, when it does not fit the target and the fit check will compact it;
//   - an interrupted turn's unfinished work, when the switch cancels a running turn.
//
// THREE RULES ABOUT THE TEXT ITSELF, from §8.6:
//   - it NEVER claims the visible conversation is lost;
//   - it names EXACTLY what remains portable and exactly what does not;
//   - it NEVER prints an encrypted payload. Structurally, not by discipline: `SwitchFacts` carries
//     booleans and counts and has no field a payload could arrive in, so no warning this module can
//     produce has anything to print.

import { sameDomain, type ContinuityEndpoint } from "./domains.ts";

/**
 * How much of the conversation survives.
 *
 * `lossless-native` -- the target also accepts the source's own continuation state (a certified shared
 * domain, or the same model): nothing is lost and even the reasoning replays.
 * `lossless-portable` -- nothing the target can see is lost; the source's reasoning stays in the sidecar
 * for the source (the ordinary cross-family switch).
 * `warned-lossy` -- one of the four losses above applies.
 */
export type LossClass = "lossless-native" | "lossless-portable" | "warned-lossy";

/**
 * The per-switch observations. BOOLEANS AND COUNTS ONLY -- there is deliberately no field that could
 * carry reasoning text, a payload, or a credential, which is what makes "warnings never print
 * payloads" a property of the type rather than a rule someone has to remember.
 *
 * WS-23: the reasoning-carriage fields (`summaryAvailable`, `exposedComplete`, `truncated`,
 * `policyBlocksForwarding`) are still ACCEPTED -- older callers pass them -- and no longer decide
 * anything: reasoning parked in the sidecar is not lost.
 */
export interface SwitchFacts {
  /** WS-23: image or document blocks in the conversation that the target cannot read. */
  unreadableMedia?: number;
  /** WS-23: the source vendor's own server-tool blocks (calls and their results) that the target receives as plain text. */
  serverToolBlocks?: number;
  /** WS-23: the conversation does not fit the target, so the fit check will compact it before the target's first request. */
  compaction?: { estimatedTokens: number; window: number };
  /** The switch aborts a RUNNING turn before its final state exists (§8.3's immediate switch). */
  midTurnAbort?: boolean;
  /** How many tool calls completed and carry over. Zero is a fact about the turn, not a missing input. */
  completedToolResults?: number;
  /** @deprecated WS-23: reasoning is not lost on a switch; accepted and ignored. */
  summaryAvailable?: boolean;
  /** @deprecated WS-23: accepted and ignored. */
  exposedComplete?: boolean;
  /** @deprecated WS-23: accepted and ignored. */
  truncated?: boolean;
  /** @deprecated WS-23: accepted and ignored. */
  policyBlocksForwarding?: boolean;
}

export interface SwitchClassification {
  lossClass: LossClass;
  /** User-facing prose. Empty for a lossless transfer -- that is what "warn iff lossy" means. */
  warnings: string[];
  /** What survives the switch, named exactly. Never empty: the visible conversation always crosses. */
  portable: string[];
}

/**
 * Classifies one requested transition.
 *
 * `from`/`to` carry the CAPABILITY facts (the stamped continuation domain decides only whether the
 * reasoning also replays on the target -- `lossless-native` vs `lossless-portable`), and `facts` carries
 * what is true of this particular switch.
 */
export function classifySwitch(from: ContinuityEndpoint, to: ContinuityEndpoint, facts: SwitchFacts = {}): SwitchClassification {
  const warnings: string[] = [];
  // THE SAME EXACT PROFILE IS NEVER A SWITCH (review I1): checked by identity, because a model with no
  // continuation domain has no domain id to compare.
  const sameProfile = from.providerId === to.providerId && from.modelKey === to.modelKey;
  const nativeCarries = sameProfile || sameDomain(from, to);

  const media = facts.unreadableMedia ?? 0;
  if (media > 0) {
    warnings.push(
      `${identify(to)} cannot read images or documents: the ${media} in this conversation will reach it as a note that ${media === 1 ? "one was" : "they were"} there. Everything else carries over as it is.`,
    );
  }
  const server = facts.serverToolBlocks ?? 0;
  if (server > 0) {
    warnings.push(
      `${server} step${server === 1 ? "" : "s"} of ${from.providerId}'s own server-side tools (such as web search) will reach ${identify(to)} as plain text rather than as tool results.`,
    );
  }
  if (facts.compaction !== undefined) {
    warnings.push(
      `This conversation (about ${formatTokens(facts.compaction.estimatedTokens)} tokens) is larger than ${identify(to)} can hold (a ${formatTokens(facts.compaction.window)}-token window), so ${identify(from)} will summarize its older part before the switch. The most recent exchanges carry over as they are.`,
    );
  }
  // Applies EVEN INSIDE a shared domain -- the loss is the unfinished turn, not the transport.
  if (facts.midTurnAbort === true) {
    warnings.push(
      `The current turn is being cancelled before it finished, so its unfinished work is discarded. Tool calls that already completed are kept; nothing that ran is undone.`,
    );
  }

  const portable = portableList(from, to, facts, nativeCarries);
  const lossClass: LossClass = warnings.length > 0 ? "warned-lossy" : nativeCarries ? "lossless-native" : "lossless-portable";
  return { lossClass, warnings, portable };
}

/**
 * What survives, named. THE VISIBLE CONVERSATION IS ALWAYS FIRST and never qualified (§8.6).
 */
function portableList(from: ContinuityEndpoint, to: ContinuityEndpoint, facts: SwitchFacts, nativeCarries: boolean): string[] {
  const portable = [facts.compaction !== undefined ? "the recent conversation as it is, and a summary of the older part" : "the whole visible conversation, as it is"];
  const completed = facts.completedToolResults ?? 0;
  if (completed > 0) portable.push(`${completed} completed tool result${completed === 1 ? "" : "s"}`);
  if (from.continuation === "none") return portable;
  if (nativeCarries) portable.push(`${from.modelKey}'s own reasoning state, replayed exactly`);
  else portable.push(`${from.modelKey}'s reasoning, kept for ${from.modelKey} and replayed if you switch back (${identify(to)} sees what it can read of it)`);
  return portable;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** `provider/model` for prose. Ids only -- the two things a user actually chose between. */
function identify(endpoint: ContinuityEndpoint): string {
  return endpoint.modelKey.startsWith(`${endpoint.providerId}/`) ? endpoint.modelKey : `${endpoint.providerId}/${endpoint.modelKey}`;
}
