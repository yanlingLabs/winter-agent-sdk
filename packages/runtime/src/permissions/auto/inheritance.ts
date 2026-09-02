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
