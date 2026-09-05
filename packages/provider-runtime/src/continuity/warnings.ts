// Phase 6 Lane C: the WARNING MATRIX -- report §8.4/§8.5, as a decision anyone can audit.
//
// THE MATRIX WARNS IFF THE TRANSFER IS GENUINELY LOSSY. Both halves of that sentence are load-bearing.
// A warning on every model switch trains a reader to dismiss it, and by the time one means something
// nobody is looking; a MISSING warning on a lossy switch is worse still, because the user believes a
// continuation they are not getting. So there are exactly seven reasons to warn (§8.4) and exactly two
// proofs that suppress the hidden-reasoning warning (§8.4's own two conditions), and neither list is
// open to a judgement call at the call site.
//
// THREE RULES ABOUT THE TEXT ITSELF, from §8.6:
//   - it NEVER claims the visible conversation is lost. It is not: every visible message, every
//     completed tool result and every artifact crosses intact. Saying otherwise is both false and the
//     reason users refuse switches they should accept;
//   - it names EXACTLY what remains portable and exactly what does not;
//   - it NEVER prints an encrypted payload. Structurally, not by discipline: `SwitchFacts` carries
//     booleans and counts and has no field a payload could arrive in, so no warning this module can
//     produce has anything to print.

import { sameDomain, type ContinuityEndpoint } from "./domains.ts";

/**
 * How much of the source's continuation survives.
 *
 * `lossless-native` -- the target accepts the source's own native continuation object (§8.4's first
 * suppressing condition: a certified shared domain).
 * `lossless-portable` -- the source's COMPLETE readable reasoning crosses unmodified as text (§8.4's
 * second condition; the DeepSeek→OpenAI class).
 * `warned-lossy` -- everything else. Truncation flips either lossless class into this one.
 */
export type LossClass = "lossless-native" | "lossless-portable" | "warned-lossy";

/**
 * The per-switch observations. BOOLEANS AND COUNTS ONLY -- there is deliberately no field that could
 * carry reasoning text, a payload, or a credential, which is what makes "warnings never print
 * payloads" a property of the type rather than a rule someone has to remember.
 */
export interface SwitchFacts {
  /** A provider-produced summary for the source's work exists (captured into the sidecar). */
  summaryAvailable?: boolean;
  /** For a `full-exposed` source: is the readable reasoning COMPLETE? `false` means some of it is missing (§8.4's third trigger). */
  exposedComplete?: boolean;
  /** Reasoning had to be trimmed to fit the target's context (§9.6). Flips a lossless class to lossy, always. */
  truncated?: boolean;
  /** A provider or user policy forbids forwarding the reasoning text (§8.4's fifth trigger, §12.4's "only when policy permits"). */
  policyBlocksForwarding?: boolean;
  /** The switch aborts a RUNNING turn before its final summary/state exists (§8.3's immediate switch). */
  midTurnAbort?: boolean;
  /** How many tool calls completed and are therefore carried as portable FACTS. Zero is a fact about the turn, not a missing input. */
  completedToolResults?: number;
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
 * `from`/`to` carry the CAPABILITY facts (readable state, stamped continuation domain) and `facts`
 * carries what is true of this particular switch. Nothing here reads a provider id to decide
 * portability -- `sameDomain` is the only continuation test, so "same vendor" never buys a suppressed
 * warning and "different vendor" never forces one.
 */
export function classifySwitch(from: ContinuityEndpoint, to: ContinuityEndpoint, facts: SwitchFacts = {}): SwitchClassification {
  const warnings: string[] = [];
  const domainShared = sameDomain(from, to);
  const sourceHidden = from.readableState !== "full-exposed";
  const exposedComplete = from.readableState === "full-exposed" && facts.exposedComplete !== false;
  const forwardable = !facts.policyBlocksForwarding;
  const truncated = facts.truncated === true;

  // §8.4's two suppressing proofs, evaluated FIRST so the warning list below is only ever built for a
  // transfer that has actually earned one.
  const nativeCarries = domainShared;
  const exposedCarries = exposedComplete && forwardable && !truncated;

  const portable = portableList(from, facts, { nativeCarries, exposedCarries });

  // Triggers 1 and 2 -- hidden reasoning whose opaque state is invalid for the target, and only a
  // summary being available -- are ONE sentence to a reader; splitting them says the same thing twice.
  if (!nativeCarries && sourceHidden) {
    warnings.push(
      `Switching from ${identify(from)} to ${identify(to)} starts a new reasoning context: ${from.providerId}'s reasoning state is bound to ${from.providerId} and cannot be used by ${to.providerId}. ` +
        `Winter carries over ${joinList(portable)}.`,
    );
  }

  // Trigger 5, and INDEPENDENT rather than an alternative to the line above. A hidden-reasoning source
  // whose summary is also policy-blocked loses two different things for two different reasons, and a
  // user who is told only the first will not understand why the summary they can see in the UI did not
  // cross either. The condition is "there was material that would otherwise have crossed" -- warning
  // about a block on nothing would be noise.
  if (facts.policyBlocksForwarding === true && (facts.summaryAvailable === true || from.readableState === "full-exposed")) {
    warnings.push(
      `${identify(from)}'s readable reasoning exists for this turn, but policy forbids forwarding it to ${identify(to)}. Winter carries over ${joinList(portable)}.`,
    );
  }

  // Trigger 3: an exposed-reasoning source whose trace is incomplete. §8.4 is explicit that this warns
  // even though the source's readable state would otherwise suppress the hidden-reasoning warning.
  if (!nativeCarries && from.readableState === "full-exposed" && facts.exposedComplete === false) {
    warnings.push(
      `${identify(from)} exposes readable reasoning, but part of this turn's trace was not captured, so the handoff to ${identify(to)} is incomplete. Winter carries over ${joinList(portable)}.`,
    );
  }

  // Trigger 4. Independent of the branch above: truncation is what flips a would-be-lossless exposed
  // transfer into a lossy one, and §9.6's closing rule is that it is never silent.
  if (truncated) {
    warnings.push(
      `Some of ${identify(from)}'s reasoning had to be trimmed to fit ${identify(to)}'s context. Decisions, evidence and completed tool results are kept; the trimmed reasoning is not.`,
    );
  }

  // Trigger 6, and it is a SEPARATE line rather than a variant of the first because the reader's
  // question is different: they did not change vendors, and the reason this is still lossy is that
  // this pair of models has no tested continuation rule between them.
  if (!domainShared && from.providerId === to.providerId) {
    warnings.push(
      `${from.providerId} has not certified that ${from.modelKey}'s reasoning state is valid for ${to.modelKey}; Winter will not replay it across the two, so this switch is treated as lossy even though the provider is unchanged.`,
    );
  }

  // Trigger 7. Applies EVEN INSIDE a shared domain -- the loss is the unfinished turn, not the
  // transport -- which is why it sits outside the suppressing conditions entirely.
  if (facts.midTurnAbort === true) {
    warnings.push(
      `The current turn is being cancelled before it finished, so its in-flight reasoning and its incomplete tool loop are discarded. Tool calls that already completed are kept as facts; nothing that ran is undone.`,
    );
  }

  const lossClass: LossClass = warnings.length > 0 ? "warned-lossy" : nativeCarries ? "lossless-native" : "lossless-portable";
  return { lossClass, warnings, portable };
}

/**
 * What survives, named.
 *
 * THE VISIBLE CONVERSATION IS ALWAYS FIRST and is never qualified: §8.6's own rule is that the
 * warning must not claim it is lost, and the surest way to obey that is for every warning to state
 * the opposite in its own words.
 */
function portableList(from: ContinuityEndpoint, facts: SwitchFacts, carries: { nativeCarries: boolean; exposedCarries: boolean }): string[] {
  const portable = ["the visible conversation"];
  const completed = facts.completedToolResults ?? 0;
  if (completed > 0) portable.push(`${completed} completed tool result${completed === 1 ? "" : "s"} and their facts`);
  if (carries.nativeCarries) {
    portable.push(`${from.modelKey}'s own reasoning state, replayed exactly`);
  } else if (carries.exposedCarries) {
    portable.push(`${from.modelKey}'s complete readable reasoning, forwarded unmodified`);
  } else if (facts.summaryAvailable === true && facts.policyBlocksForwarding !== true) {
    portable.push(`${from.modelKey}'s reasoning summary`);
  }
  portable.push("the objective, the decisions already made and their visible rationale, and any unresolved questions");
  return portable;
}

/** `provider/model` for prose. Ids only -- the two things a user actually chose between. */
function identify(endpoint: ContinuityEndpoint): string {
  return endpoint.modelKey.startsWith(`${endpoint.providerId}/`) ? endpoint.modelKey : `${endpoint.providerId}/${endpoint.modelKey}`;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]!}`;
}
