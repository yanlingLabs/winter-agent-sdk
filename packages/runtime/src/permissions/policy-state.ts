// Task 6 (WS-07 §2/§6.4): PolicyState — RED-phase stub. Signatures only, thrown bodies, so
// evaluator.test.ts exercises real call sites (not module-resolution errors) before the real
// implementation lands. See evaluator.test.ts's own header for fixture conventions.
import type { PermissionMode, PermissionUpdate, RuleSource } from "@yanlinglabs/winter-agent-sdk";
import type { SourcedRuleSet } from "./ruleset.ts";

export interface AutoModeConfig {
  environment?: string[];
  allow?: string[];
  soft_deny?: string[];
  hard_deny?: string[];
  classifyAllShell?: boolean;
}

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

export function isPermissionMode(_value: string): _value is PermissionMode {
  throw new Error("not implemented — RED phase");
}

export function assertKnownPermissionMode(_mode: string | undefined): PermissionMode {
  throw new Error("not implemented — RED phase");
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

export class PolicyStateStore {
  constructor(_initial: { mode: PermissionMode; rules: SourcedRuleSet; autoConfig?: AutoModeConfig }, _gate: BypassGateConfig) {
    throw new Error("not implemented — RED phase");
  }

  getState(): Readonly<PolicyState> {
    throw new Error("not implemented — RED phase");
  }

  setMode(_mode: PermissionMode): SetModeResult | SetModeError {
    throw new Error("not implemented — RED phase");
  }

  applyUpdate(_update: PermissionUpdate, _opts: { authority: RuleSource }): ApplyUpdateOk | SetModeError {
    throw new Error("not implemented — RED phase");
  }
}
