// Task 5 (WS-07 §3.2/§3.3): sourced rule store — precedence, PermissionUpdate application +
// authority validation, and the permission journal. RED-phase stub -- signatures only, thrown/
// trivial bodies so ruleset.test.ts exercises real call sites (not module-resolution errors)
// before the real implementation lands. See ruleset.test.ts's own header for fixture conventions.
import type { ParsedRule } from "./grammar.ts";
import type { PermissionBehavior, PermissionRuleValue, PermissionMode, PermissionUpdate, RuleSource } from "@yanlinglabs/winter-agent-sdk";

export interface SourcedRuleEntry {
  rule: ParsedRule;
  behavior: PermissionBehavior;
  source: RuleSource;
  ruleValue: PermissionRuleValue;
}

export interface SourcedRuleSet {
  entries: SourcedRuleEntry[];
  mode?: { value: PermissionMode; source: RuleSource };
  directories: Array<{ path: string; source: RuleSource }>;
}

export function emptyRuleSet(): SourcedRuleSet {
  return { entries: [], directories: [] };
}

export class PermissionRuleValidationError extends Error {
  constructor(
    message: string,
    public readonly rule: PermissionRuleValue,
    public readonly behavior: PermissionBehavior,
  ) {
    super(message);
    this.name = "PermissionRuleValidationError";
  }
}

export class PermissionUpdateAuthorityError extends Error {
  constructor(
    message: string,
    public readonly authority: RuleSource,
    public readonly destination: string,
  ) {
    super(message);
    this.name = "PermissionUpdateAuthorityError";
  }
}

export function sourceRule(_value: PermissionRuleValue, _behavior: PermissionBehavior, _source: RuleSource): SourcedRuleEntry {
  throw new Error("not implemented");
}

export function applyPermissionUpdate(_set: SourcedRuleSet, _update: PermissionUpdate, _opts: { authority: RuleSource }): SourcedRuleSet {
  throw new Error("not implemented");
}

export function resolveRules(
  _set: SourcedRuleSet,
  _call: { toolName: string; input: Record<string, unknown> },
  _opts: { trustedWorkspace: boolean; allowManagedPermissionRulesOnly?: boolean },
): { deny?: SourcedRuleEntry; ask?: SourcedRuleEntry; allow?: SourcedRuleEntry } {
  throw new Error("not implemented");
}

export function effectiveDirectories(_set: SourcedRuleSet, _opts: { trustedWorkspace: boolean }): string[] {
  throw new Error("not implemented");
}

export interface SdkOptionsRuleInputs {
  allowedTools?: string[];
  disallowedTools?: string[];
  permissions?: { allow?: string[]; ask?: string[]; deny?: string[] };
}

export function buildSdkSourcedEntries(_opts: SdkOptionsRuleInputs): SourcedRuleEntry[] {
  throw new Error("not implemented");
}

export function appendPermissionJournal(
  _location: { winterHome: string; projectKey: string; sessionId: string },
  _update: PermissionUpdate,
): void {
  throw new Error("not implemented");
}
