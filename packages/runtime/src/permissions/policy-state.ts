// Task 6 (WS-07 §2/§6.4): PolicyState — the live, per-session permission mode + rule set + version
// counter the six-stage evaluator (evaluator.ts) reads a SNAPSHOT of on every call, and the ONE
// mutation surface (PolicyStateStore) that changes it: mode switches (Query.setPermissionMode / the
// engine's own `set_permission_mode` control subtype) and PermissionUpdate application (T8's
// canUseTool `updatedPermissions`, applied over T5's already-built pure applyPermissionUpdate).
//
// Cross-task pin (the phase plan's own "Cross-task pins" section, verbatim shape):
//   PolicyState = { mode: PermissionMode; version: number; rules: SourcedRuleSet; autoConfig?: AutoModeConfig }
// "version increments on every mode/rule change; every pending decision, hook request, control-RPC
// payload, and durable approval carries policyVersion; stale answers are discarded and
// re-evaluated" (WS-04 §3.1, WS-07 §2).
import type { PermissionMode, PermissionUpdate, RuleSource } from "@yanlinglabs/winter-agent-sdk";
import { applyPermissionUpdate, type SourcedRuleSet } from "./ruleset.ts";

// Task 12 (WS-07 §10.2): relocated to the FULL AutoModeConfig module
// (packages/runtime/src/permissions/auto/config.ts — `$defaults` splice/replace mechanics,
// validation, user/managed/inline-only source restriction) — exactly the "one-line import-path
// change here, not a redesign" T6's own placeholder comment invited. Re-exported so every existing
// consumer of `./policy-state.ts`'s own `AutoModeConfig` name (evaluator.ts's own re-export
// included) keeps working unchanged.
export type { AutoModeConfig } from "./auto/config.ts";
import type { AutoModeConfig } from "./auto/config.ts";

export interface PolicyState {
  mode: PermissionMode;
  version: number;
  rules: SourcedRuleSet;
  autoConfig?: AutoModeConfig;
}

export class WinterPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WinterPermissionError";
  }
}

export const PERMISSION_MODES: ReadonlySet<PermissionMode> = new Set([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
]);

export function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as ReadonlySet<string>).has(value);
}

// Ruling 8 (phase plan): "an unknown mode in RuntimeConfig at engine start = typed config error (not
// a parse failure)." Called once, at engine startup, BEFORE the init frame is written — a throw here
// takes the SAME "exited before init" path a pre-init resolution failure already does (e.g.
// store/resume.ts's ResumeTargetError) — see engine.ts's own startup block.
export function assertKnownPermissionMode(mode: string | undefined): PermissionMode {
  if (mode === undefined) return "default";
  if (!isPermissionMode(mode)) {
    throw new WinterPermissionError(`invalid permissionMode in RuntimeConfig: ${JSON.stringify(mode)}`);
  }
  return mode;
}

export interface BypassGateConfig {
  allowDangerouslySkipPermissions: boolean;
  disableBypassPermissionsMode: boolean;
}

export interface SetModeResult {
  ok: true;
  effectiveMode: PermissionMode;
}
export interface SetModeError {
  ok: false;
  error: { code: string; message: string };
}
export interface ApplyUpdateOk {
  ok: true;
}

type GateCheck = { ok: true } | SetModeError;

// WS-07 §6.4: "requires allowDangerouslySkipPermissions ... and managed policy can disable the
// mode." The veto is checked FIRST and unconditionally: disabling is strictly stronger than merely
// requiring a flag, so it beats even an explicit allowDangerouslySkipPermissions:true.
function checkBypassGate(mode: PermissionMode, gate: BypassGateConfig): GateCheck {
  if (mode !== "bypassPermissions") return { ok: true };
  if (gate.disableBypassPermissionsMode) {
    return {
      ok: false,
      error: { code: "bypass_disabled", message: "bypassPermissions is disabled by managed configuration (permissions.disableBypassPermissionsMode)" },
    };
  }
  if (!gate.allowDangerouslySkipPermissions) {
    return { ok: false, error: { code: "bypass_not_allowed", message: "bypassPermissions requires allowDangerouslySkipPermissions: true" } };
  }
  return { ok: true };
}

// PolicyStateStore — the ONE mutation surface over an in-memory PolicyState. Pure/in-memory only:
// journaling a PermissionUpdate to <sessionId>.permission-journal.jsonl (phase ruling 2) is the
// CALLER's separate responsibility (T8's canUseTool wiring is the first real caller with something to
// journal) — this class never touches fs, matching PolicyState's own plain-data cross-task pin.
export class PolicyStateStore {
  private state: PolicyState;
  private readonly gate: BypassGateConfig;

  constructor(initial: { mode: PermissionMode; rules: SourcedRuleSet; autoConfig?: AutoModeConfig }, gate: BypassGateConfig) {
    const check = checkBypassGate(initial.mode, gate);
    if (!check.ok) throw new WinterPermissionError(check.error.message);
    this.gate = gate;
    this.state = { mode: initial.mode, version: 0, rules: initial.rules, ...(initial.autoConfig !== undefined ? { autoConfig: initial.autoConfig } : {}) };
  }

  getState(): Readonly<PolicyState> {
    return this.state;
  }

  // DECISION (ledgered carry, task-6 brief: "the setMode managed-guard question is YOURS to
  // settle"): setMode carries NO authority/managed-source check beyond the bypass gate above. WS-07
  // pins no managed-mode-immutability text anywhere in scope for P2 — the only mode-related managed
  // control the spec documents at all is the bypass veto itself
  // (permissions.disableBypassPermissionsMode, implemented above). A broader "managed policy can
  // pin/lock the active mode against ANY later switch" concept arrives with managed settings at P5
  // (phase-boundary ruling 1: "P5's settings-file loader ... FEEDS these shapes, it does not reshape
  // them" — there is no `source`/`authority` concept for "who may change the live mode" to even
  // check against yet, unlike rules/directories which already carry one via SourcedRuleSet).
  // Implementing a broader guard now would mean inventing an unpinned rule; the safe default,
  // consistent with WS-00's own spec-silence tie-break, is "any caller may switch mode, subject only
  // to the one gate the spec DOES pin." Capture-pending: a future managed-settings pass may add one.
  setMode(mode: PermissionMode): SetModeResult | SetModeError {
    const check = checkBypassGate(mode, this.gate);
    if (!check.ok) return check;
    this.state = { ...this.state, mode, version: this.state.version + 1 };
    return { ok: true, effectiveMode: mode };
  }

  // Applies one PermissionUpdate to the live rule set (T5's pure applyPermissionUpdate underneath),
  // bumping the version so every in-flight/pending decision computed under the OLD version is
  // discoverably stale (evaluate()'s own policyVersion stamp + engine.ts's re-evaluation loop).
  //
  // A `type: "setMode"` update is a SECOND DOOR into the same room as setMode() above: T8's
  // canUseTool `updatedPermissions` can carry a `{type:"setMode", mode:"bypassPermissions", ...}`
  // suggestion just as easily as a direct Query.setPermissionMode() call — routing it through T5's
  // applyPermissionUpdate WITHOUT the SAME bypass gate would let that second door smuggle bypass in
  // ungated. The gate is checked FIRST, atomically: on rejection, NEITHER the rules' bookkeeping
  // `mode` field (applyPermissionUpdate's own setMode case) NOR this store's active mode/version
  // changes at all — never a partial application. No journaling here (see this class's own header).
  //
  // API-shape note (flagged for T8, this method's first real caller beyond this file's own unit
  // tests): the bypass gate above is the ONLY failure this method reports via a returned
  // `{ok:false}` value. T5's own applyPermissionUpdate (called below) still THROWS its established
  // typed errors for a malformed update — PermissionUpdateAuthorityError (unknown/unauthorized
  // destination) or PermissionRuleValidationError (an invalid rule inside an addRules/replaceRules
  // payload) — unchanged and uncaught here. This asymmetry is deliberate, not an oversight: the
  // bypass gate is a NEW, expected, recoverable outcome this task adds (worth a clean result value,
  // matching engine.ts's own control-request-handler convention); T5's exceptions represent
  // malformed/unauthorized input that was already throw-shaped before this class existed, and this
  // task's edit authorization does not extend to changing that. A caller wanting one uniform
  // try/catch-free interface needs its own wrapping try/catch around this call.
  applyUpdate(update: PermissionUpdate, opts: { authority: RuleSource }): ApplyUpdateOk | SetModeError {
    if (update.type === "setMode") {
      const check = checkBypassGate(update.mode, this.gate);
      if (!check.ok) return check;
    }
    const rules = applyPermissionUpdate(this.state.rules, update, opts);
    const nextMode = update.type === "setMode" ? update.mode : this.state.mode;
    this.state = { ...this.state, rules, mode: nextMode, version: this.state.version + 1 };
    return { ok: true };
  }
}
