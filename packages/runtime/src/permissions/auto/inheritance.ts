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
// Root cause: there is no total order over these four modes, only two partial ones. P4 MUST
// re-examine this (likely a per-axis comparison, never a single scalar rank) BEFORE wiring any
// real subagent spawn/resume caller to `computeChildPolicy`/`resolveChildResumeMode` — this list
// and the two functions built on it are correct exactly as far as WS-07 §11's own two PINNED facts
// go (the two extremes, and "stricter of" as a bare concept), and no further. No behavior change
// in this fix round — this comment only states the boundary of what is proven versus assumed.
// Exported so a fixture (or a future task) can pin the exact order without re-deriving it.
export const AUTO_MODE_STRICTNESS_ORDER: readonly PermissionMode[] = ["dontAsk", "plan", "default", "acceptEdits", "auto", "bypassPermissions"];

function strictnessRank(mode: PermissionMode): number {
  const idx = AUTO_MODE_STRICTNESS_ORDER.indexOf(mode);
  if (idx === -1) throw new Error(`AUTO_MODE_STRICTNESS_ORDER is missing a PermissionMode member: ${JSON.stringify(mode)}`);
  return idx;
}

// The lower-ranked (earlier in AUTO_MODE_STRICTNESS_ORDER) of the two wins ties go to `a`.
export function stricterOf(a: PermissionMode, b: PermissionMode): PermissionMode {
  return strictnessRank(a) <= strictnessRank(b) ? a : b;
}

// ---------------------------------------------------------------------------------------------
// computeChildPolicy (WS-07 §11 forced-mode table)
// ---------------------------------------------------------------------------------------------
//
// "parent bypassPermissions, acceptEdits, and auto are FORCED onto descendants and the definition
// override is ignored." Everything else (default/dontAsk/plan) is overridable, subject to ONE
// documented veto: "a definition asking for bypassPermissions is also ignored when
// permissions.disableBypassPermissionsMode disables the mode -- the child uses the parent mode."
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
// KNOWN TENSION (documented, not silently absorbed): if the parent was `default` when the child
// was spawned with an override to `plan`, and the parent has SINCE moved to `auto` (which the
// forced-mode table would now force onto any NEWLY spawned child), stricter-of picks `plan`
// (stricter than `auto`) for the RESUMED child, not `auto`. That is deliberate at P2 — real
// resume/reconciliation semantics are P4's; this only pins the one comparison WS-07 §11 states.
export interface RecordedChildPolicy {
  effectiveMode: PermissionMode;
  parentPolicyVersion: number;
  parentPolicyHash: string;
}

export function resolveChildResumeMode(recorded: RecordedChildPolicy, currentParentMode: PermissionMode): PermissionMode {
  return stricterOf(recorded.effectiveMode, currentParentMode);
}
