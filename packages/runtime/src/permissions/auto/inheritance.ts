// Task 12 (WS-07 §11): subagent permission inheritance — a PURE data shape at P2 ("real children
// are P4"): no subagent spawn/resume machinery exists anywhere in this codebase yet. This module
// only proves the MECHANICS (the forced-mode table, the bypass veto, the stricter-of resume rule)
// so P4's real child-spawn/resume code has something correct to call.
import type { PermissionMode } from "@yanlinglabs/winter-agent-sdk";
import type { PolicyState } from "../policy-state.ts";
import { computePolicyHash } from "./caches.ts";

// ---------------------------------------------------------------------------------------------
// Strictness order (JUDGMENT CALL — WS-07 §11 never enumerates a total order over all six modes;
// it only requires ONE comparison: "child resume applies the STRICTER of recorded vs current
// parent policy"). Ordered strictest-first:
//   dontAsk    -- every would-prompt outcome becomes an immediate denial; canUseTool is NEVER
//                 called (WS-07 §6.3) -- structurally the narrowest: it never grants anything
//                 `plan` would even have a CHANCE to prompt/classify into an allow.
//   plan       -- reads + built-in-read-only proceed; writes are withheld outright (no rule/prompt
//                 can convert one into execution short of leaving plan mode); non-write/non-read
//                 exploratory actions can still reach a prompt (or the classifier borrow) -- a real
//                 (if narrow) path to "allow" that dontAsk structurally forecloses.
//   default    -- the baseline: read-only free, everything else prompts.
//   acceptEdits -- default PLUS bounded-path edits auto-approved.
//   auto       -- read-only/bounded-edit PLUS classifier-mediated auto-approval of much more.
//   bypassPermissions -- everything except the hard-pinned exceptions (critical rm, deny/ask
//                 rules, mandatory interaction) auto-approved.
//
// Fix round 1, Ruling P2-M (this order's actual soundness, stated plainly — read before adding a
// caller): this scalar total order is sound ONLY at its two extremes. `dontAsk` is genuinely the
// global minimum (nothing is stricter: it forecloses every path to "allow" every other mode has)
// and `bypassPermissions` is genuinely the global maximum (nothing is looser). The FOUR modes in
// between are NOT actually comparable on one axis — this list flattens two DIFFERENT restriction
// axes into one number:
//   - rule-silencing: whether a PRE-EXISTING static allow rule can resolve a call at stage 5 at
//     all, vs. a whole category being withheld as a standing exception no rule can even reach
//     (plan's writes — §6.5's own "source edits are withheld... unconditional prose"; auto's own
//     broad-allow suspension, isAutoSuspendedAllowRule).
//   - auto-approval breadth: how much of "everything else" a mode grants WITHOUT a matching rule
//     at all (acceptEdits' bounded edits; auto's classifier-mediated grant).
// A mode can be narrower on one axis and wider on the other than a neighbor this list calls
// "stricter" — no single scalar is monotonic in both at once, so the middle four's placement is
// UNPROVEN, and at least two concrete `resolveChildResumeMode` cells built from it are ACTIVELY
// UNSAFE, not merely arguable:
//   (i) a child recorded `auto`, resumed under a parent now at `acceptEdits`, resolves to
//       `acceptEdits` (rank 3 < rank 4 — "stricter" on this list). But `acceptEdits` does NOT
//       suspend broad allow rules the way `auto` does (isAutoSuspendedAllowRule is an auto-mode-
//       only stage-5 filter) — a standing `Bash(*)` allow that `auto` would have suspended to the
//       classifier now resolves as a bare rule-allow, unreviewed. "Stricter" on the flattened
//       order; LOOSER on the rule-silencing axis that actually governs this exact call.
//   (ii) a child recorded `plan`, resumed under a parent now at `dontAsk`, resolves to `dontAsk`
//       (rank 0 < rank 1 — "stricter" on this list). But `dontAsk` has no concept of plan's own
//       write-withholding standing exception at all — it falls through to stage 5 like any other
//       unresolved action, so a pre-existing static allow rule can silently execute a write that
//       `plan` withholds UNCONDITIONALLY, with no prompt (dontAsk never prompts) and no classifier
//       borrow (that machinery is plan-mode-only). "Stricter" on the flattened order; a write
//       `plan` would never have let through at all now goes through silently.
// Root cause: there is no total order over these four modes, only two partial ones.
//
// RULING P2-M (Phase 4, Task 3) — the fix, stated as the axis model this file now implements:
//
// Rather than one scalar rank, `stricterOf` compares two INDEPENDENT axes, lexicographically, axis
// 1 dominant:
//
//   AXIS 1 — rule-silencing (categorical): does this mode impose a STANDING EXCEPTION that
//   withholds or reviews a whole category of actions REGARDLESS of what a pre-existing static rule
//   would otherwise do — i.e. a rule cannot even "reach" the call to resolve it? Exactly two modes
//   have this property: `plan` (source edits are withheld UNCONDITIONALLY — WS-07 §6.5's own "not
//   auto-approved... source edits are withheld" — no allow rule can convert one into execution) and
//   `auto` (broad allow rules are SUSPENDED to classifier review on auto entry — WS-07 §10.1 step 2,
//   `isAutoSuspendedAllowRule`). The other four (`default`, `dontAsk`, `acceptEdits`,
//   `bypassPermissions`) have NO such standing exception: an existing allow-rule match resolves
//   normally in every one of them. This is deliberately NOT the same grouping the brief's own gloss
//   suggests ("dontAsk/plan") — `dontAsk` does NOT silence a rule: WS-07 §6.3 lists "allow-rule/
//   allowedTools matches" among what dontAsk "still permits" unmodified. dontAsk only changes what
//   happens to an UNRESOLVED (would-prompt) call (denial instead of a prompt) — a fundamentally
//   different mechanism from a standing rule-silencing exception, and cell (ii) below is exactly the
//   fixture that tells the two apart: if dontAsk really did silence rules the way plan does, cell
//   (ii) would have no bug to fix in the first place.
//
//   AXIS 2 — auto-approval breadth (a tie-break, used ONLY when axis 1 agrees): how much of
//   "everything else" a mode grants WITHOUT a matching rule at all. Within the rule-silencing
//   partition {plan, auto}: plan is narrower (writes are NEVER auto-approved, and non-write
//   exploratory actions at best reach a prompt or a classifier BORROW — WS-07 §6.5) than auto
//   (auto auto-approves ordinary in-cwd edits outright once past its own suspension filter — WS-07
//   §6.6), so plan wins a same-partition comparison against auto. Within the non-silencing
//   partition {default, dontAsk, acceptEdits, bypassPermissions}: dontAsk (denies every unresolved
//   case outright) < default (prompts) < acceptEdits (auto-approves bounded edits) <
//   bypassPermissions (auto-approves everything else) — the ORIGINAL scalar order's own relative
//   placement of these four, which nothing in the P2-M finding disputes (both proven-widening cells
//   are CROSS-partition comparisons; this order was never the problem).
//
// Consequence, stated plainly because it reads as surprising at first: axis 1 is lexicographically
// DOMINANT, so `auto` and `plan` are judged stricter than every non-silencing mode they are actually
// COMPARABLE with — overturning the old comment's own claim that dontAsk is the unconditional
// "global minimum." That claim was true only within the non-silencing partition; it silently
// assumed dontAsk's mechanism (deny-the-unresolved-residual) dominates plan/auto's mechanism
// (silence-a-whole-category-regardless-of-rule), which cell (ii) disproves directly for `plan`. The
// two mechanisms answer different questions, and rule-silencing is the one that must never be
// lost on resume (a mode that reviews/withholds a category by construction can never be replaced by
// one that doesn't, no matter how "generally stricter" the replacement looks on a flattened scale).
//
// RULING P4-D (fix round 1, MAJOR item 2) — ONE documented exception to axis-1 dominance: `dontAsk`
// vs `auto` specifically is NOT comparable at all, in EITHER direction, and this function REFUSES to
// judge it (see `stricterOf`'s own doc comment + `INCOMPARABLE_MODE_PAIRS` below) rather than
// silently picking one. `plan` genuinely dominates every non-silencing mode including `dontAsk`
// (cell (ii): plan's write-withholding has no offsetting weakness dontAsk lacks) — but `auto` does
// NOT dominate `dontAsk` the same way, because the two mechanisms each protect against something the
// OTHER one doesn't:
//   - the NO-MATCHING-RULE residual: `dontAsk` denies it outright; `auto` classifies it (and may
//     auto-approve via the classifier) — `dontAsk` is stricter here.
//   - an EXISTING BROAD ALLOW RULE (e.g. a standing `Bash(*)`): `dontAsk` honors it unmodified
//     (WS-07 §6.3 — allow-rule/allowedTools matches "still permit" under dontAsk); `auto` SUSPENDS it
//     to classifier review (isAutoSuspendedAllowRule) — `auto` is stricter here.
// Neither sub-question's answer dominates the other, so "which of dontAsk/auto is stricter" has NO
// defensible single answer — this is a genuine gap in the axis model, not a placement this file
// merely didn't get around to fixing. `plan` has no such counterpart weakness (nothing dontAsk
// protects against that plan doesn't ALSO protect against at least as strongly), which is exactly
// why plan/dontAsk stays comparable while auto/dontAsk does not.
//
// `AUTO_MODE_STRICTNESS_ORDER` is kept ONLY as the axis-2 tie-break table (never again a
// cross-partition total order) — `computeChildPolicy` (below) does not consume it at all (WS-07
// §11's forced-mode table is a fixed per-mode set membership check, not a "which is stricter"
// comparison, so it needed no change for this ruling); nothing else in this codebase imports it
// (verified), so it survives here purely as a documented, tested constant a future fixture can pin
// against without re-deriving the within-partition order.
export const AUTO_MODE_STRICTNESS_ORDER: readonly PermissionMode[] = ["dontAsk", "plan", "default", "acceptEdits", "auto", "bypassPermissions"];

function strictnessRank(mode: PermissionMode): number {
  const idx = AUTO_MODE_STRICTNESS_ORDER.indexOf(mode);
  if (idx === -1) throw new Error(`AUTO_MODE_STRICTNESS_ORDER is missing a PermissionMode member: ${JSON.stringify(mode)}`);
  return idx;
}

// Axis 1: the two modes with a standing rule-silencing exception (see the header above for why
// dontAsk is deliberately NOT a member of this set).
const RULE_SILENCING_MODES: ReadonlySet<PermissionMode> = new Set<PermissionMode>(["plan", "auto"]);
function isRuleSilencing(mode: PermissionMode): boolean {
  return RULE_SILENCING_MODES.has(mode);
}

// Axis 2: a within-partition breadth rank, used only to break an axis-1 tie. Reuses
// AUTO_MODE_STRICTNESS_ORDER's own relative ordering (see header) rather than a second, independent
// table that could drift from it — the two partitions never need to be compared against each other
// on this axis (axis 1 already resolved every cross-partition case by the time this runs).
function breadthRank(mode: PermissionMode): number {
  return strictnessRank(mode);
}

// RULING P4-D (fix round 1, MAJOR item 2): thrown by `stricterOf` (and therefore by
// `resolveChildResumeMode`, its one production caller) for a documented INCOMPARABLE pair --
// currently just {dontAsk, auto} -- instead of silently returning one of the two modes. Named for
// its dominant real-world trigger (child resume is the only place this codebase compares two
// ARBITRARY modes against each other today; `computeChildPolicy`'s own forced-mode table is a fixed
// set-membership check and never reaches this class at all) even though the throw site is the
// generic comparator itself: `stricterOf` has exactly one non-test caller, so there is no other
// consumer to name this error after, and locating the check IN the comparator (rather than as a
// separate pre-check bolted onto `resolveChildResumeMode`) is what keeps `stricterOf` from becoming
// a comparator that LIES to some future second caller by claiming an answer that does not exist.
export class ChildResumeModeIncomparableError extends Error {
  constructor(
    public readonly modeA: PermissionMode,
    public readonly modeB: PermissionMode,
  ) {
    super(
      `stricterOf(${modeA}, ${modeB}): these two modes are INCOMPARABLE on axis 1 (RULING P4-D) -- ` +
        `neither dominates the other, so "which is stricter" has no defensible answer. Never silently ` +
        `widened, narrowed, or resolved to an invented composite; a future resume path (P8) may offer ` +
        `the host/user an explicit choice instead.`,
    );
    this.name = "ChildResumeModeIncomparableError";
  }
}

// RULING P4-D: enumerated EXPLICITLY, both directions, rather than derived from some structural
// property of the two modes -- this is a JUDGMENT CALL about these two SPECIFIC mechanisms (see the
// header's own mechanism-level walkthrough), not a pattern that generalizes to some rule a future
// mode addition could satisfy automatically. Extend this set (both directions) if a future mode
// audit finds another genuinely incomparable pair; do not infer one from axis membership alone.
const INCOMPARABLE_MODE_PAIRS: ReadonlySet<string> = new Set<string>(["dontAsk:auto", "auto:dontAsk"]);
function incomparablePairKey(a: PermissionMode, b: PermissionMode): string {
  return `${a}:${b}`;
}

// Per-axis comparator (RULING P2-M): axis 1 (rule-silencing) is checked first and is dominant --
// only when it TIES (both modes in the same partition) does axis 2 (breadth) decide. Returns one of
// {a, b} verbatim (never a synthesized third mode) for every COMPARABLE pair; ties (identical mode)
// return `a`. Throws `ChildResumeModeIncomparableError` for a documented incomparable pair
// (RULING P4-D) -- checked FIRST, before either axis, so an incomparable pair is refused
// unconditionally rather than accidentally judged by axis 1 agreeing on partition membership.
export function stricterOf(a: PermissionMode, b: PermissionMode): PermissionMode {
  if (INCOMPARABLE_MODE_PAIRS.has(incomparablePairKey(a, b))) {
    throw new ChildResumeModeIncomparableError(a, b);
  }
  const silA = isRuleSilencing(a);
  const silB = isRuleSilencing(b);
  if (silA !== silB) return silA ? a : b;
  return breadthRank(a) <= breadthRank(b) ? a : b;
}

// ---------------------------------------------------------------------------------------------
// computeChildPolicy (WS-07 §11 forced-mode table)
// ---------------------------------------------------------------------------------------------
//
// "parent bypassPermissions, acceptEdits, and auto are FORCED onto descendants and the definition
// override is ignored." Everything else (default/dontAsk/plan) is overridable, subject to ONE
// documented veto: "a definition asking for bypassPermissions is also ignored when
// permissions.disableBypassPermissionsMode disables the mode -- the child uses the parent mode."
//
// RULING P2-M note: this function needs NO change for the per-axis comparator above and does not
// call `stricterOf`/`resolveChildResumeMode` at all. WS-07 §11's forced-mode table is a fixed
// per-PARENT-MODE set-membership check ("is the parent's live mode one of these three fixed
// literals"), never a "which of two modes is stricter" comparison — there is nothing here for an
// axis model to correct. Only `resolveChildResumeMode` (below), which genuinely compares two
// arbitrary modes against each other, was in scope for this ruling.
const FORCED_MODES: ReadonlySet<PermissionMode> = new Set<PermissionMode>(["bypassPermissions", "acceptEdits", "auto"]);

export interface ChildAgentDefinition {
  permissionMode?: PermissionMode;
}

export interface ComputeChildPolicyOptions {
  // Managed-policy veto (WS-07 §6.4's own field, threaded one level further — see
  // policy-state.ts's BypassGateConfig for the SAME flag's other consumer).
  disableBypassPermissionsMode?: boolean;
}

export interface ChildPolicyResult {
  effectiveMode: PermissionMode;
  parentPolicyVersion: number;
  parentPolicyHash: string;
}

export function computeChildPolicy(parent: PolicyState, def: ChildAgentDefinition, opts?: ComputeChildPolicyOptions): ChildPolicyResult {
  const parentPolicyHash = computePolicyHash(parent);
  let effectiveMode: PermissionMode = parent.mode;

  if (!FORCED_MODES.has(parent.mode) && def.permissionMode !== undefined) {
    const wantsBypass = def.permissionMode === "bypassPermissions";
    const bypassVetoed = wantsBypass && opts?.disableBypassPermissionsMode === true;
    effectiveMode = bypassVetoed ? parent.mode : def.permissionMode;
  }

  return { effectiveMode, parentPolicyVersion: parent.version, parentPolicyHash };
}

// ---------------------------------------------------------------------------------------------
// Child resume (WS-07 §11): "Winter persists the effective mode + parent policy-version/hash on
// every child; child resume applies the STRICTER of its recorded policy and the parent's current
// policy -- never reviving a child in a mode the parent can no longer use."
// ---------------------------------------------------------------------------------------------
//
// STRUCTURAL NOTE (not a shortcut): the recorded triple below carries no `def` (WS-07 §11 pins
// exactly {effectiveMode, parentPolicyVersion, parentPolicyHash} as what gets persisted) — a fresh
// `computeChildPolicy` re-run is NOT reconstructable from it (the original AgentDefinition is
// gone). `stricterOf(recorded.effectiveMode, currentParentMode)` is therefore the only
// structurally-available reading, and it is the PROTECTIVE one: "never reviving in a mode the
// parent can no longer use" is about never GAINING permissiveness at resume, not about
// re-deriving what a fresh spawn would compute today.
//
// RESOLVED under RULING P2-M (was flagged "KNOWN TENSION" at P2; the per-axis model above resolves
// it rather than merely tolerating it): if the parent was `default` when the child was spawned with
// an override to `plan`, and the parent has SINCE moved to `auto` (which the forced-mode table would
// now force onto any NEWLY spawned child), `stricterOf` picks `plan` for the RESUMED child, not
// `auto` — and this is now the PROVEN-CORRECT answer, not an accepted gap: plan and auto share the
// rule-silencing axis (§1 above), and within that shared partition plan is strictly narrower (its
// write-withholding is unconditional; auto still auto-approves ordinary in-cwd edits). A resumed
// child that kept `plan`'s stricter write posture is exactly "never reviving in a mode the parent
// can no longer use" in its safest reading — it is MORE conservative than what a fresh spawn would
// now compute (`auto`, forced), never less.
export interface RecordedChildPolicy {
  effectiveMode: PermissionMode;
  parentPolicyVersion: number;
  parentPolicyHash: string;
}

// RULING P4-D: throws `ChildResumeModeIncomparableError` (via `stricterOf`) when `recorded.
// effectiveMode`/`currentParentMode` form the one documented incomparable pair ({dontAsk, auto}, in
// either direction) -- a genuine resume-path failure mode, not swallowed here: the caller (Lane C's
// own future resume call site) must surface it as a legible error rather than reviving the child in
// a silently wrong mode.
export function resolveChildResumeMode(recorded: RecordedChildPolicy, currentParentMode: PermissionMode): PermissionMode {
  return stricterOf(recorded.effectiveMode, currentParentMode);
}
