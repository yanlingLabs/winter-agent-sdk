// Task 6 (WS-07 §2/§5/§6.1/§6.3/§6.4): the six-stage permission evaluator — RED-phase stub.
// Signatures only, thrown bodies, so evaluator.test.ts exercises real call sites (not
// module-resolution errors) before the real implementation lands.
import type { PermissionMode, PermissionUpdate, RuleSource } from "@yanlinglabs/winter-agent-sdk";
import type { PolicyState, AutoModeConfig } from "./policy-state.ts";

export type { AutoModeConfig };

// Verbatim WS-07 §7.2 pin. T8's own file-sectioning banner convention (sdk/permissions/types.ts)
// formally owns this; defined here now, byte-identical to the pinned union, purely so
// PermissionDecisionRecord (below) can reference it before T8 lands.
export type PermissionDecisionClassification = "user_temporary" | "user_permanent" | "user_reject";

export interface PermissionCall {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  agentId?: string;
}

export interface HookDecision {
  decision: "allow" | "deny" | "no_opinion";
  transformedInput?: Record<string, unknown>;
  message?: string;
  interrupt?: boolean;
  hookId?: string;
}
export interface HookStage {
  preToolUse(call: PermissionCall, ctx: EvaluationContext): Promise<HookDecision>;
}

export interface PromptStageMeta {
  decisionReason: string;
  toolUseID?: string;
  agentID?: string;
  matchedAskRule?: { source: RuleSource; toolName: string; ruleContent?: string };
}
export interface PromptDecision {
  decision: "allow" | "deny";
  transformedInput?: Record<string, unknown>;
  message?: string;
  interrupt?: boolean;
  updatedPermissions?: PermissionUpdate[];
  decisionClassification?: PermissionDecisionClassification;
}
export interface PromptStage {
  prompt(call: PermissionCall, ctx: EvaluationContext, meta: PromptStageMeta): Promise<PromptDecision | null>;
}

export interface AutoEngineVerdict {
  verdict: "allow" | "deny" | "no_verdict";
  category?: string;
  reasonCode?: string;
}
export interface AutoEngine {
  classify(call: PermissionCall, ctx: EvaluationContext): Promise<AutoEngineVerdict>;
}

export interface CriticalRemovalResult {
  critical: boolean;
  reason?: string;
}
export interface SpecialChecks {
  isProtectedWrite(call: PermissionCall, ctx: EvaluationContext): boolean;
  isCriticalRemoval(call: PermissionCall, ctx: EvaluationContext): CriticalRemovalResult;
}

export interface EvaluationContext {
  policy: PolicyState;
  cwd: string;
  home: string;
  trustedWorkspace: boolean;
  allowManagedPermissionRulesOnly?: boolean;
  hookStage: HookStage;
  promptStage: PromptStage;
  autoEngine: AutoEngine;
  specialChecks: SpecialChecks;
}

export interface PermissionDecisionRecord {
  decision: "allow" | "deny" | "ask" | "defer";
  mechanism: "hook" | "rule" | "mode" | "canUseTool" | "autoEngine";
  source?: RuleSource;
  hookId?: string;
  ruleRef?: string;
  transformedInput?: Record<string, unknown>;
  message?: string;
  interrupt?: boolean;
  updatedPermissions?: PermissionUpdate[];
  decisionClassification?: PermissionDecisionClassification;
  policyVersion: number;
  deniedBareSchemaRemoval?: boolean;
}

export const NO_OPINION_HOOK_STAGE: HookStage = {
  async preToolUse() {
    return { decision: "no_opinion" };
  },
};

export const NO_OPINION_PROMPT_STAGE: PromptStage = {
  async prompt() {
    return null;
  },
};

export const NO_OPINION_AUTO_ENGINE: AutoEngine = {
  async classify() {
    return { verdict: "no_verdict" };
  },
};

export const NO_SPECIAL_CHECKS: SpecialChecks = {
  isProtectedWrite: () => false,
  isCriticalRemoval: () => ({ critical: false }),
};

export async function evaluate(_call: PermissionCall, _ctx: EvaluationContext): Promise<PermissionDecisionRecord> {
  throw new Error("not implemented — RED phase");
}
