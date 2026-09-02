// Task 9 (WS-08 §4, verbatim): the multi-hook reducer — the core deliverable of this task. Pure,
// synchronous, no I/O: `reduceHookOutcomes` takes an ALREADY-ORDERED list of (participant, outcome)
// pairs and folds them into one composite. Ordering (WS-08 §2's merged deterministic order) and
// short-circuiting (deciding which hooks even get invoked vs. marked `skipped`) are runner.ts's job,
// upstream of this function — by the time a list reaches here, a `deny` earlier in the list has
// already caused every later entry to arrive as `{kind:"skipped"}` rather than this function
// re-deriving that itself. This split is deliberate: it is what makes the precedence/composition
// MATH testable with zero async, zero invoker doubles, and zero timers (task brief Step 1).
//
// Normative source: WS-08 §4's five numbered rules, applied literally:
//   1. Merged deterministic order — NOT this file's concern (registry.ts + runner.ts).
//   2. Strictest decision wins: deny > defer > ask > allow > none (RANK below, verbatim). A later,
//      weaker (or EQUAL — see tie-break note) decision never overrides an earlier stronger one.
//   3. Transforms compose in evaluation order; a transform from a hook whose OWN decision was
//      overridden by a stricter one is discarded along with it.
//   4. extraContext accumulates (ordered, attributed) — UNQUALIFIED by rule 2's override logic; rule
//      4's own text carries no "unless overridden" caveat the way rule 3 explicitly does, so an
//      overridden hook's extraContext still accumulates (judgment call, flagged in the task report;
//      pinned by this file's own fixtures).
//   5. The composite enters the permission pipeline with stage-1 semantics — enforced by the
//      hook-stage adapter (hooks/hook-stage.ts), not this function; this file only guarantees the
//      composite's `decision` is drawn from the SAME 4-value vocabulary a single hook could return,
//      never a fifth "stronger than allow" value.
//
// JUDGMENT CALL — tie-break on EQUAL rank, and why transform/output use a DIFFERENT rule than the
// scalar decision/message/interrupt slots: WS-08 §4 rule 2 only states "a later, WEAKER decision
// never overrides an earlier stronger one," leaving two hooks at the identical rank unaddressed, and
// rule 3's discard clause is scoped to a hook "whose decision was overridden BY A STRICTER one" —
// strictly stricter, not merely different. This file resolves the two questions separately:
//   - Scalar slots (decision/message/interrupt): the EARLIEST entry to reach the eventual maximum
//     rank wins (a later, tied entry never overwrites it) — a single, simple, deterministic
//     attribution for fields that can only ever hold one hook's answer.
//   - Transform chain (transformedInput/transformedOutput): an entry contributes to the chain
//     (conditionally overwriting whatever the chain currently holds, exactly like a "none" outcome
//     always does) IF its own decision's rank EQUALS the FINAL winning rank — a "co-winner," never
//     actually beaten by anything stricter — OR if the outcome is "none" (which proposed no decision
//     at all, so nothing of its own can ever be overridden). An entry whose decision's rank is
//     STRICTLY BELOW the final winning rank is excluded from the chain entirely (rule 3's discard).
//     Two same-rank hooks that AGREE (e.g. both "allow") are not in any conflict with each other —
//     discarding the later one's more-refined transform just because it "tied" would throw away real
//     information the rule's "stricter" qualifier never asked for; this is why transform-chaining
//     computing needs the FINAL rank first (a two-pass fold — see the implementation below), while
//     the scalar attribution can be (and is) resolved in the same single forward pass as everything
//     else.
// At most one `deny` can ever reach this function as a real "decision" entry, since a committed deny
// causes the runner to mark every later hook `skipped` before it ever runs (WS-08 §4 rule 2's own
// short-circuit clause) — so the only ranks that can genuinely tie here are ask/allow/defer.
//
// INVOCATION-TIME vs. COMPOSITE split (load-bearing for runner.ts, not this file): rule 3's FIRST
// sentence ("each hook sees the previous hook's transformed value") describes INVOCATION-TIME
// behavior — the runner must feed every well-formed transform forward into the NEXT hook's input
// optimistically, as it happens, because at invocation time the final winning rank is not yet known
// (later hooks haven't run). This function's two-pass discard is necessarily RETROSPECTIVE and
// applies only to the COMPOSITE's own final transformedInput/transformedOutput — meaning the input a
// hook actually SAW during invocation can legitimately differ from what the composite reports at the
// end (e.g., a sanitizing hook's transform is what a LATER, stricter hook actually evaluated against,
// even if that sanitizing hook's own "allow" is later outranked and its transform therefore excluded
// from the final composite). This is an inherent consequence of the spec's own rule, not a bug in
// this file; see the task report's Concerns for the corner case this produces.
//
// JUDGMENT CALL — WS-08 §4's own composite sketch lists only `decision?/transformedInput?/
// transformedOutput?/extraContext?/lifecycleMessages`. This file's HookComposite EXTENDS that
// illustrative sketch with `message?`/`interrupt?` (carried from the WINNING decision — needed by
// the evaluator-adapter seam, evaluator.ts's own HookDecision, which has always had these fields)
// and a SEPARATE `classifierContext?` accumulator (WS-08 §5's PostToolUse-only, T12-consumed field —
// kept distinct from the generic `extraContext` bucket per this phase's own controller note that
// classifierContext is "a typed field, attributed," not a generic-context entry). WS-08 §4's
// composite shape is Winter's OWN normative contract (its own §13 Open Question 1: "the rules above
// are Winter's normative contract"), not a verbatim upstream wire pin — extending it for what real
// integration needs is in scope; the five numbered PRECEDENCE rules above are what must never be
// deviated from.
import type { HookEvent, HookSource, HookPermissionDecision } from "@yanlinglabs/winter-agent-sdk";

// --- The per-hook outcome vocabulary the runner produces (P2-A's audit outcome set, minus the
// audit-only bookkeeping — duration/requestId/etc. live on the audit record, hooks/runner.ts) ---

export interface HookOutcomeFields {
  transformedInput?: Record<string, unknown>;
  transformedOutput?: unknown;
  extraContext?: unknown;
  classifierContext?: string; // WS-08 §5: PostToolUse's own contract-bound field is string-typed.
  message?: string;
  interrupt?: boolean;
}

export type HookOutcome =
  // A well-formed response that DID propose a decision (allow/ask/deny/defer — WS-08 §3's full
  // vocabulary; "defer" is kept as a real, distinct rank here even though the P2 runner resolves a
  // raw PreToolUse `defer` to `ask` before it ever reaches this function — see runner.ts's own
  // header for why that resolution is layered OUTSIDE this spec-faithful reducer).
  | ({ kind: "decision"; decision: HookPermissionDecision } & HookOutcomeFields)
  // A well-formed response with NO opinion on allow/deny/ask, but which may still contribute a
  // transform and/or context (WS-08 §3: "(none) no opinion; evaluation continues" — a no-opinion
  // hook's transform/context contributions are real, independent of the decision question).
  | ({ kind: "none" } & HookOutcomeFields)
  // Gating error/timeout/malformed-output/invalid-defer (WS-08 §8): no contribution of any kind.
  // "error" and "timeout" are DISTINCT kinds (never collapsed) because P2-A's audit vocabulary
  // requires the fine-grained distinction on the lifecycle record even though they reduce
  // IDENTICALLY here (both contribute nothing).
  | { kind: "error"; reason?: string }
  | { kind: "timeout" }
  // Never invoked at all — WS-08 §4 rule 2's short-circuit: a committed `deny` earlier in the
  // merged order means every later hook for this event is skipped, not run.
  | { kind: "skipped" };

// The reducer's minimal view of "who produced this outcome" — hooks/registry.ts's SourcedHookEntry
// extends this (adding registry-only bookkeeping like `timeoutMs`), so a real registry entry is
// always assignable here without either file importing the other's full surface.
export interface HookParticipant {
  id: string;
  name?: string;
  event: HookEvent;
  matcher?: string;
  source: HookSource;
}

export interface AttributedContext {
  hookId: string;
  hookName?: string;
  context: unknown;
}

// WS-08 §9 / P2-A: the coarse outcome vocabulary a lifecycle/audit record carries. "decision" here
// means "this invocation returned a well-formed response with an opinion" — the actual decision
// VALUE is the record's own optional `decision` field, kept separate so a record can say
// `outcome:"none"` (ran, no opinion) distinctly from `outcome:"decision"` (ran, had an opinion).
export type HookInvocationOutcome = "decision" | "none" | "error" | "timeout" | "skipped";

export interface HookLifecycleRecord {
  hookId: string;
  hookName?: string;
  event: HookEvent;
  matchedMatcher?: string;
  source: HookSource;
  outcome: HookInvocationOutcome;
  decision?: HookPermissionDecision;
}

export interface HookComposite {
  decision?: HookPermissionDecision;
  transformedInput?: Record<string, unknown>;
  transformedOutput?: unknown;
  extraContext?: AttributedContext[];
  classifierContext?: AttributedContext[];
  message?: string;
  interrupt?: boolean;
  lifecycleMessages: HookLifecycleRecord[];
}

export interface HookOutcomeEntry {
  participant: HookParticipant;
  outcome: HookOutcome;
}

// WS-08 §4 rule 2, verbatim rank order (highest first): deny > defer > ask > allow > none.
const RANK: Record<HookPermissionDecision, number> = { allow: 0, ask: 1, defer: 2, deny: 3 };

function lifecycleOutcomeOf(outcome: HookOutcome): HookInvocationOutcome {
  return outcome.kind;
}

export function reduceHookOutcomes(results: HookOutcomeEntry[]): HookComposite {
  // --- Pass 1: lifecycle records (every entry, unconditionally), extraContext/classifierContext
  // (rule 4, unconditional — see header), and the scalar decision/message/interrupt attribution
  // (earliest entry to reach the eventual maximum rank; a single forward pass already suffices for
  // this because "is this rank the new maximum SO FAR" only ever needs entries seen up to now). ---
  let decision: HookPermissionDecision | undefined;
  let winnerRank = -1; // below every real rank (allow=0) so the FIRST decision-bearing outcome always wins its own comparison
  let message: string | undefined;
  let interrupt: boolean | undefined;
  const extraContext: AttributedContext[] = [];
  const classifierContext: AttributedContext[] = [];
  const lifecycleMessages: HookLifecycleRecord[] = [];

  for (const { participant, outcome } of results) {
    lifecycleMessages.push({
      hookId: participant.id,
      ...(participant.name !== undefined ? { hookName: participant.name } : {}),
      event: participant.event,
      ...(participant.matcher !== undefined ? { matchedMatcher: participant.matcher } : {}),
      source: participant.source,
      outcome: lifecycleOutcomeOf(outcome),
      ...(outcome.kind === "decision" ? { decision: outcome.decision } : {}),
    });

    // §8 failure matrix: error/timeout/skipped contribute NOTHING beyond their lifecycle record.
    if (outcome.kind === "error" || outcome.kind === "timeout" || outcome.kind === "skipped") continue;

    // Rule 4: extraContext/classifierContext accumulate UNCONDITIONALLY (no override-discard —
    // see this file's own header). Applies identically to "decision" and "none" outcomes.
    if (outcome.extraContext !== undefined) {
      extraContext.push({ hookId: participant.id, ...(participant.name !== undefined ? { hookName: participant.name } : {}), context: outcome.extraContext });
    }
    if (outcome.classifierContext !== undefined) {
      classifierContext.push({ hookId: participant.id, ...(participant.name !== undefined ? { hookName: participant.name } : {}), context: outcome.classifierContext });
    }

    if (outcome.kind === "decision") {
      const rank = RANK[outcome.decision];
      if (rank > winnerRank) {
        winnerRank = rank;
        decision = outcome.decision;
        message = outcome.message;
        interrupt = outcome.interrupt;
      }
    }
  }

  // --- Pass 2: the transform chain (rule 3). Needs the FINAL winning rank (winnerRank, now
  // settled) before it can decide, per entry, whether that entry is a "co-winner" (rank equals the
  // final max — never actually beaten by anything stricter, so it chains) or a strict loser (rank
  // below the final max — overridden by a stricter one, so it's excluded). "none" outcomes always
  // chain (they proposed no decision, so nothing of theirs was ever overridden). error/timeout/
  // skipped are excluded identically to pass 1. ---
  let transformedInput: Record<string, unknown> | undefined;
  let transformedOutput: unknown;
  let hasTransformedOutput = false; // transformedOutput's own value can legitimately be falsy (e.g. ""), so track presence separately

  for (const { outcome } of results) {
    if (outcome.kind === "error" || outcome.kind === "timeout" || outcome.kind === "skipped") continue;
    const chains = outcome.kind === "none" || RANK[outcome.decision] === winnerRank;
    if (!chains) continue; // a strict loser -- rule 3's discard.
    if (outcome.transformedInput !== undefined) transformedInput = outcome.transformedInput;
    if (outcome.transformedOutput !== undefined) {
      transformedOutput = outcome.transformedOutput;
      hasTransformedOutput = true;
    }
  }

  return {
    ...(decision !== undefined ? { decision } : {}),
    ...(transformedInput !== undefined ? { transformedInput } : {}),
    ...(hasTransformedOutput ? { transformedOutput } : {}),
    ...(extraContext.length > 0 ? { extraContext } : {}),
    ...(classifierContext.length > 0 ? { classifierContext } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(interrupt !== undefined ? { interrupt } : {}),
    lifecycleMessages,
  };
}
