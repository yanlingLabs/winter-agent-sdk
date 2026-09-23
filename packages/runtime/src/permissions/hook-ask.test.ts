// WS-21 §6.3 item 14 (F16): "A PreToolUse hook `ask` reaches `canUseTool` in every mode, unless
// claude's own rule check already returned `ask`: under bypass the full pipeline then allows it."
//
// THE CLAIM THIS FILE TESTS: a hook-forced ask must reach the prompt stage (the seam
// `runtime-sdk/approval-bridge.ts` wires to the host's real `canUseTool` in production) EXACTLY
// ONCE, even in the two modes whose own baseline would otherwise auto-approve or auto-run a call
// with no prompt at all -- `acceptEdits` (an in-cwd Write is approved silently, `mechanism: "mode"`,
// per Task 7's own "Edit/Write recognized directly, in-bounds (cwd) -> auto-approved" fixture) and
// `bypassPermissions` (which skips every ordinary check outright). If a hook's `ask` did not
// override those, "the model ran a PreToolUse hook flagged as needing approval" would be silently
// unenforceable in exactly the two modes where enforcement matters most.
//
// PARITY VERDICT (recorded per the task brief's own "if parity already holds, keep the test and say
// so" instruction): it already holds. evaluator.ts's stage-3 gate
// (`askEntry || isMandatoryAskUserQuestion || isMandatoryMcpInteraction || isMandatoryPrivateAddressAsk
// || hookForcedAsk`) runs BEFORE stage 4's mode dispatch for EVERY mode except `dontAsk` (which
// converts it to a denial instead, per WS-07 §6.3 -- also pinned below), and
// `evaluator.test.ts`'s own T10-CARRY 1 block already proves the bypass half of this in isolation
// ("bypassPermissions does not exempt a hook-forced ask"). This file adds the acceptEdits half (not
// previously fixtured on its own) and states the bypass half here too, so both halves of the brief's
// own sentence live together, keyed on the SAME Write-shaped call the brief itself names.
//
// NO evaluator.ts CHANGE ACCOMPANIES THIS FILE: every test below is GREEN against the code as it
// stood before this task.
import { test, expect, describe } from "bun:test";
import {
  evaluate,
  NO_OPINION_HOOK_STAGE,
  NO_OPINION_PROMPT_STAGE,
  NO_OPINION_AUTO_ENGINE,
  NO_SPECIAL_CHECKS,
  REAL_SPECIAL_CHECKS,
  type EvaluationContext,
  type PermissionCall,
  type PromptStage,
  type PromptStageMeta,
  type PromptDecision,
  type HookStage,
  type HookDecision,
} from "./evaluator.ts";
import { emptyRuleSet } from "./ruleset.ts";
import { type PolicyState } from "./policy-state.ts";

// --- fixture helpers, mirroring evaluator.test.ts's own (private to that file, so restated here) ---

function policy(overrides: Partial<PolicyState> = {}): PolicyState {
  return { mode: "default", version: 0, rules: emptyRuleSet(), ...overrides };
}

function baseCtx(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    policy: policy(),
    cwd: "/work",
    sessionRoot: "/work",
    home: "/synthetic/home/tester",
    trustedWorkspace: false,
    hookStage: NO_OPINION_HOOK_STAGE,
    promptStage: NO_OPINION_PROMPT_STAGE,
    autoEngine: NO_OPINION_AUTO_ENGINE,
    specialChecks: NO_SPECIAL_CHECKS,
    ...overrides,
  };
}

function call(toolName: string, input: Record<string, unknown> = {}): PermissionCall {
  return { toolName, input };
}

function spyPromptStage(impl: (call: PermissionCall, ctx: EvaluationContext, meta: PromptStageMeta) => PromptDecision | null): {
  stage: PromptStage;
  calls: Array<{ call: PermissionCall; meta: PromptStageMeta }>;
} {
  const calls: Array<{ call: PermissionCall; meta: PromptStageMeta }> = [];
  return {
    calls,
    stage: {
      async prompt(c, _ctx, meta) {
        calls.push({ call: c, meta });
        return impl(c, _ctx, meta);
      },
    },
  };
}

/** A PreToolUse hook that always forces "ask" -- the fixed decision the brief's own scenario names. */
function alwaysAskHookStage(hookId = "h1"): HookStage {
  return {
    async preToolUse(): Promise<HookDecision> {
      return { decision: "ask", hookId, message: "a PreToolUse hook flagged this call for approval" };
    },
    async permissionRequest() {
      return null; // no PermissionRequest opinion -- falls through to promptStage.prompt, same as evaluator.test.ts's own spyHookStage default
    },
  };
}

describe("WS-21 §6.3 item 14 (F16): a hook ask reaches canUseTool in every mode", () => {
  for (const mode of ["acceptEdits", "bypassPermissions"] as const) {
    test(`mode=${mode}: a hook ask for an in-cwd Write causes EXACTLY ONE canUseTool (promptStage) call`, async () => {
      const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
      const ctx = baseCtx({
        hookStage: alwaysAskHookStage(),
        promptStage: promptSpy.stage,
        policy: policy({ mode }),
        specialChecks: REAL_SPECIAL_CHECKS,
      });
      // An IN-CWD Write: under acceptEdits alone (no hook), Task 7's own fixture proves this is
      // auto-approved SILENTLY (`mechanism: "mode"`, promptStage never invoked). Under
      // bypassPermissions alone, nothing prompts either. The hook is what must force the prompt.
      const record = await evaluate(call("Write", { file_path: "/work/src/b.ts" }), ctx);
      expect(promptSpy.calls.length).toBe(1);
      // The FINAL decision's mechanism is "canUseTool" -- it names what ANSWERED, not what forced
      // the ask (that attribution lives in `promptSpy.calls[0].meta.decisionReason`, asserted below).
      expect(record.mechanism).toBe("canUseTool");
      expect(record.decision).toBe("allow"); // the spied promptStage answered "allow" -- proves the ANSWER, not just the call count, reaches the record
      expect(promptSpy.calls[0]!.meta.decisionReason).toContain("PreToolUse hook");
    });
  }

  test("mode=dontAsk: the SAME hook ask is converted to a denial instead, and canUseTool is never called (WS-07 §6.3 -- dontAsk's own documented exception)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
    const ctx = baseCtx({
      hookStage: alwaysAskHookStage(),
      promptStage: promptSpy.stage,
      policy: policy({ mode: "dontAsk" }),
      specialChecks: REAL_SPECIAL_CHECKS,
    });
    const record = await evaluate(call("Write", { file_path: "/work/src/b.ts" }), ctx);
    expect(promptSpy.calls.length).toBe(0);
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("hook");
  });

  test("mode=default: the same hook ask also reaches canUseTool exactly once (the baseline every other mode is compared against)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
    const ctx = baseCtx({
      hookStage: alwaysAskHookStage(),
      promptStage: promptSpy.stage,
      policy: policy({ mode: "default" }),
      specialChecks: REAL_SPECIAL_CHECKS,
    });
    const record = await evaluate(call("Write", { file_path: "/work/src/b.ts" }), ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(record.mechanism).toBe("canUseTool");
  });
});
