// Task 6 (WS-07 §2/§5/§6.1/§6.3/§6.4): the six-stage evaluator's fixture corpus.
//
// Scope: modes `default`, `dontAsk`, `bypassPermissions` fully; `acceptEdits`/`plan`/`auto` only as
// much as their T6 PLACEHOLDER arm promises (identical to `default`'s own baseline — see
// evaluator.ts's evaluateModeStage). Protected-path/critical-removal semantics are T7's
// (SpecialChecks seam, stubbed here as NOT_SPECIAL — see below); the AutoPermissionEngine's real
// pipeline is T12's (AutoEngine seam, stubbed here as NO-VERDICT).
//
// Every fixture builds its own EvaluationContext from scratch (baseCtx) — no shared mutable state
// between tests. MOST fixtures are pure in-memory strings with no fs/WINTER_HOME involvement (the
// PolicyStateStore section further down never touches disk either) — Task 7's own "Ruling P2-J
// proven at the evaluator layer" describe block is the one real-fs exception (mkdtemp + planted
// symlinks, mirroring paths.test.ts's own regime for the identical reason: symlink resolution is
// not something a string can answer).
//
// Task 7 (Ruling P2-J, rider 2) landmine, fixed here — READ BEFORE choosing a synthetic path: the
// file-rule matching path (matchesRuleForCall's FILE_RULE_TOOLS branch) and the cwd-read baseline
// are now symlink-aware (matchFileRuleAtBothEnds -> checkSymlinkBothEnds -> realpathSync), even
// though this whole file's OWN fixtures are meant to be pure in-memory strings with no real fs
// involvement. On macOS, `/home` and `/etc` are REAL symlinks (`/home` -> `/System/Volumes/Data/
// home`, `/etc` -> `/private/etc`) — a synthetic test path built on either prefix silently resolves
// through a REAL symlink to a DIFFERENT absolute path, which can make an "allow requires both link
// and target to match" check spuriously fail (deny/ask's "either" semantics are unaffected, since
// the un-resolved link path still matches directly either way — this is why only ALLOW-direction
// fixtures using `/home/...` broke when rider 2 landed, and why no *existing* `/etc` fixture broke:
// every one of them was deny-direction). `home` now uses `/synthetic/home/...` (matching paths.
// test.ts's own established, collision-free convention) for exactly this reason — prefer
// `/synthetic/...` over any path prefix that might collide with a real macOS mount/symlink for any
// NEW allow-direction file-rule fixture this file gains.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionMode, PermissionRuleValue, PermissionUpdate, RuleSource } from "@yanlinglabs/winter-agent-sdk";
import {
  evaluate,
  findMatchingRuleEntry,
  NO_OPINION_HOOK_STAGE,
  NO_OPINION_PROMPT_STAGE,
  NO_OPINION_AUTO_ENGINE,
  NO_SPECIAL_CHECKS,
  REAL_SPECIAL_CHECKS,
  PLAN_WRITE_WITHHELD_MESSAGE,
  type EvaluationContext,
  type PermissionCall,
  type PromptStage,
  type PromptStageMeta,
  type PromptDecision,
  type HookStage,
  type HookDecision,
} from "./evaluator.ts";
import { PolicyStateStore, WinterPermissionError, type PolicyState } from "./policy-state.ts";
import { emptyRuleSet, resolveRules, sourceRule, type SourcedRuleEntry, type SourcedRuleSet } from "./ruleset.ts";
// Task 9 (WS-08 §4): the real hooks engine, for the "Task 9 -- the real hooks engine wired through
// createHookStage" describe block below — every OTHER fixture in this file uses spyHookStage to pin
// the seam contract in isolation; this is the one place the actual registry/reducer/runner run.
import { createHookStage } from "../hooks/hook-stage.ts";
import { buildHookRegistry, type SourcedHookEntry } from "../hooks/registry.ts";
import { runHooks, type HookInvoker, type HookAuditRecorder } from "../hooks/runner.ts";

// --- fixture helpers -----------------------------------------------------------------------------

function rule(raw: string, behavior: "allow" | "deny" | "ask", source: RuleSource = "sdk"): SourcedRuleEntry {
  const m = /^([^\s(]+)\((.*)\)$/s.exec(raw.trim());
  const value: PermissionRuleValue = m ? { toolName: m[1]!, ruleContent: m[2]! } : { toolName: raw.trim() };
  return sourceRule(value, behavior, source);
}

function withRules(...entries: SourcedRuleEntry[]): SourcedRuleSet {
  return { ...emptyRuleSet(), entries };
}

function policy(overrides: Partial<PolicyState> = {}): PolicyState {
  return { mode: "default", version: 0, rules: emptyRuleSet(), ...overrides };
}

function baseCtx(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    policy: policy(),
    cwd: "/work",
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

function spyPromptStage(
  impl: (call: PermissionCall, ctx: EvaluationContext, meta: PromptStageMeta) => PromptDecision | null,
): { stage: PromptStage; calls: Array<{ call: PermissionCall; meta: PromptStageMeta }> } {
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

function spyHookStage(impl: (call: PermissionCall) => HookDecision): { stage: HookStage; calls: PermissionCall[] } {
  const calls: PermissionCall[] = [];
  return {
    calls,
    stage: {
      async preToolUse(c) {
        calls.push(c);
        return impl(c);
      },
    },
  };
}

// --- Stage order: hooks (advisory allow, terminal deny) -------------------------------------------

describe("stage 1: PreToolUse hooks", () => {
  test("hook deny short-circuits everything, even when an allow rule also matches", async () => {
    const ctx = baseCtx({
      hookStage: spyHookStage(() => ({ decision: "deny", message: "hook says no", hookId: "h1" })).stage,
      policy: policy({ rules: withRules(rule("Bash(ls *)", "allow")) }),
    });
    const record = await evaluate(call("Bash", { command: "ls" }), ctx);
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("hook");
    expect(record.hookId).toBe("h1");
    expect(record.message).toBe("hook says no");
  });

  test("hook allow is advisory only — a deny rule downstream still wins", async () => {
    const ctx = baseCtx({
      hookStage: spyHookStage(() => ({ decision: "allow" })).stage,
      policy: policy({ rules: withRules(rule("Bash(rm *)", "deny")) }),
    });
    const record = await evaluate(call("Bash", { command: "rm -rf x" }), ctx);
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("rule");
  });

  test("hook transformedInput becomes the effective call for every later stage", async () => {
    const hook = spyHookStage(() => ({ decision: "allow", transformedInput: { command: "rm -rf x" } }));
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({
      hookStage: hook.stage,
      promptStage: promptSpy.stage,
      policy: policy({ rules: withRules(rule("Bash(rm *)", "deny")) }),
    });
    // original input is a harmless "ls" — only the hook's transformed "rm -rf x" should ever be
    // checked against the deny rule.
    const record = await evaluate(call("Bash", { command: "ls" }), ctx);
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("rule");
  });

  // Fix round 1, item 4 (LOW — pin against future refactors): "allow" is advisory ONLY — the
  // existing test above already proves a downstream DENY RULE still wins over it; this proves the
  // OTHER downstream stage a hook-allow must never suppress: a matching ASK rule (stage 3) still
  // forces the prompt path even though stage 1 already said "allow". There must be no early
  // return anywhere in evaluate() for hookResult.decision === "allow".
  test("hook allow is advisory only — a matching ASK rule still forces the prompt path (no early return on hook-allow)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny", message: "human said no" }));
    const ctx = baseCtx({
      hookStage: spyHookStage(() => ({ decision: "allow" })).stage,
      promptStage: promptSpy.stage,
      policy: policy({ rules: withRules(rule("Bash(git push)", "ask")) }),
    });
    const record = await evaluate(call("Bash", { command: "git push" }), ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(promptSpy.calls[0]!.meta.matchedAskRule).toEqual({ source: "sdk", toolName: "Bash", ruleContent: "git push" });
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("canUseTool");
    expect(record.message).toBe("human said no");
  });
});

// --- Task 9 (WS-08 §4/§5): the REAL hooks engine (registry+reducer+runner), not a spy ---------------
//
// Every other "stage 1" fixture above uses `spyHookStage` to pin the SEAM CONTRACT in isolation; this
// block instead wires the REAL `createHookStage` (packages/runtime/src/hooks/hook-stage.ts) backed by
// a real `buildHookRegistry` + `runHooks`, to prove the actual T9 engine composes correctly with
// evaluate()'s stage order — exactly the task brief's own Step 3 list: deny stops before rules, allow
// + a later deny rule still denies, and a hook's transform is visible to rule matching. PostToolUse
// never runs inside evaluate() at all (it fires after a tool executes — engine.ts's round loop, wired
// by T10 alongside the lifecycle stream); the last describe block below proves the SAME registry
// composes correctly for a genuine post-execution `runHooks("PostToolUse", ...)` call, with the
// structural no-retroactive-denial property re-asserted at this integration layer.
describe("Task 9 — the real hooks engine wired through createHookStage (WS-08 §4)", () => {
  function fixedInvoker(raw: unknown): HookInvoker {
    return { invoke: async () => raw };
  }
  function noopAudit(): HookAuditRecorder {
    return { record: () => {} };
  }
  function preToolUseEntry(id: string, overrides?: Partial<SourcedHookEntry>): SourcedHookEntry {
    return { id, event: "PreToolUse", source: "sdk", ...overrides };
  }

  test("a real hook 'deny' stops the call before stage 2 ever runs — an allow rule that WOULD have matched never gets the chance", async () => {
    const registry = buildHookRegistry([preToolUseEntry("h1")]);
    const invoker = fixedInvoker({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "hook says no" } });
    const ctx = baseCtx({
      hookStage: createHookStage({ registry, invoker, audit: noopAudit(), sessionId: "s1" }),
      policy: policy({ rules: withRules(rule("Bash(ls *)", "allow")) }),
    });
    const record = await evaluate(call("Bash", { command: "ls" }), ctx);
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("hook");
    expect(record.hookId).toBe("h1");
    expect(record.message).toBe("hook says no");
  });

  test("a real hook 'allow' is advisory only — a later, unrelated deny rule still wins (matches an EARLIER spy-based fixture, now through the real engine)", async () => {
    const registry = buildHookRegistry([preToolUseEntry("h1")]);
    const invoker = fixedInvoker({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
    const ctx = baseCtx({
      hookStage: createHookStage({ registry, invoker, audit: noopAudit(), sessionId: "s1" }),
      policy: policy({ rules: withRules(rule("Bash(rm *)", "deny")) }),
    });
    const record = await evaluate(call("Bash", { command: "rm -rf x" }), ctx);
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("rule");
  });

  test("a real hook's transform is visible to rule matching — a transformed command matching a deny rule denies, even though the ORIGINAL command matched nothing", async () => {
    const registry = buildHookRegistry([preToolUseEntry("h1")]);
    const invoker = fixedInvoker({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "rm -rf x" } } });
    const ctx = baseCtx({
      hookStage: createHookStage({ registry, invoker, audit: noopAudit(), sessionId: "s1" }),
      policy: policy({ rules: withRules(rule("Bash(rm *)", "deny")) }),
    });
    const record = await evaluate(call("Bash", { command: "echo harmless" }), ctx);
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("rule");
    expect(record.transformedInput).toEqual({ command: "rm -rf x" });
  });

  test("multiple real hooks across sources still resolve deterministically through evaluate() (managed observes, sdk denies)", async () => {
    const registry = buildHookRegistry([preToolUseEntry("managed-1", { source: "managed" }), preToolUseEntry("sdk-1", { source: "sdk" })]);
    let calls = 0;
    const invoker: HookInvoker = {
      invoke: async () => {
        calls++;
        if (calls === 1) return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "observed" } }; // managed: no opinion
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "sdk hook denies" } };
      },
    };
    const ctx = baseCtx({ hookStage: createHookStage({ registry, invoker, audit: noopAudit(), sessionId: "s1" }) });
    const record = await evaluate(call("Bash", { command: "ls" }), ctx);
    expect(calls).toBe(2); // managed ran BEFORE sdk (WS-08 §2 merge order), and its no-opinion did not short-circuit anything
    expect(record.decision).toBe("deny");
    expect(record.hookId).toBe("sdk-1");
  });

  test("PostToolUse: the SAME registry mechanism fires post-execution with transformedOutput/classifierContext accumulated -- contribution-capable only, structurally incapable of a retroactive denial", async () => {
    const registry = buildHookRegistry([{ id: "post-1", event: "PostToolUse", source: "sdk" }]);
    const invoker = fixedInvoker({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: "sanitized output",
        classifierContext: "wrote outside the workspace",
        // A buggy/malicious hook trying to sneak a decision-shaped field into PostToolUse's output —
        // structurally ignored (PostToolUse's own interpreter never produces a "decision" outcome).
        permissionDecision: "deny",
      },
    });
    const composite = await runHooks("PostToolUse", { toolName: "Bash", input: { command: "ls" } }, { registry, invoker, audit: noopAudit(), sessionId: "s1", policyVersion: 1 });
    expect(composite.decision).toBeUndefined(); // no retroactive denial is even representable
    expect(composite.transformedOutput).toBe("sanitized output");
    expect(composite.classifierContext).toEqual([{ hookId: "post-1", context: "wrote outside the workspace" }]);
  });
});

// --- deny beats everything, including bypassPermissions -------------------------------------------

describe("deny-beats-everything-even-bypass (WS-07 §2 stage 2)", () => {
  test("a deny rule wins under bypassPermissions", async () => {
    const ctx = baseCtx({ policy: policy({ mode: "bypassPermissions", rules: withRules(rule("Bash(rm *)", "deny")) }) });
    const record = await evaluate(call("Bash", { command: "rm -rf /tmp/x" }), ctx);
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("rule");
    expect(record.source).toBe("sdk");
  });

  test("a deny rule wins under dontAsk", async () => {
    const ctx = baseCtx({ policy: policy({ mode: "dontAsk", rules: withRules(rule("Bash(rm *)", "deny")) }) });
    const record = await evaluate(call("Bash", { command: "rm -rf /tmp/x" }), ctx);
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("rule");
  });

  test("bare deny (schema-removal class) sets deniedBareSchemaRemoval; scoped deny does not", async () => {
    const bareCtx = baseCtx({ policy: policy({ rules: withRules(rule("Edit", "deny")) }) });
    const bareRecord = await evaluate(call("Edit", { file_path: "/work/a.txt" }), bareCtx);
    expect(bareRecord.decision).toBe("deny");
    expect(bareRecord.deniedBareSchemaRemoval).toBe(true);

    const scopedCtx = baseCtx({ policy: policy({ rules: withRules(rule("Edit(//etc/**)", "deny")) }) });
    const scopedRecord = await evaluate(call("Edit", { file_path: "/etc/passwd" }), scopedCtx);
    expect(scopedRecord.decision).toBe("deny");
    expect(scopedRecord.deniedBareSchemaRemoval).toBeUndefined();
  });
});

// --- ask beats allow, even in bypassPermissions; dontAsk converts ask to deny ----------------------

describe("ask-beats-allow (WS-07 §2 stage 3)", () => {
  for (const mode of ["default", "bypassPermissions"] as const) {
    test(`mode=${mode}: an ask rule wins over a narrower allow rule — the prompt stage decides, not the allow rule`, async () => {
      const promptSpy = spyPromptStage(() => ({ decision: "deny", message: "human said no" }));
      const ctx = baseCtx({
        promptStage: promptSpy.stage,
        policy: policy({ mode, rules: withRules(rule("Bash(git push)", "ask"), rule("Bash(git push)", "allow")) }),
      });
      const record = await evaluate(call("Bash", { command: "git push" }), ctx);
      expect(promptSpy.calls.length).toBe(1);
      expect(promptSpy.calls[0]!.meta.matchedAskRule).toEqual({ source: "sdk", toolName: "Bash", ruleContent: "git push" });
      expect(record.decision).toBe("deny");
      expect(record.mechanism).toBe("canUseTool");
      expect(record.message).toBe("human said no");
    });
  }

  test("dontAsk converts an ask-rule match into denial WITHOUT ever calling the prompt stage", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      policy: policy({ mode: "dontAsk", rules: withRules(rule("Bash(git push)", "ask")) }),
    });
    const record = await evaluate(call("Bash", { command: "git push" }), ctx);
    expect(record.decision).toBe("deny");
    expect(promptSpy.calls.length).toBe(0);
  });

  test("an ask rule with no answering host (no-opinion prompt stage) fails CLOSED — never silently allowed", async () => {
    const ctx = baseCtx({ policy: policy({ rules: withRules(rule("Bash(git push)", "ask")) }) });
    const record = await evaluate(call("Bash", { command: "git push" }), ctx);
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("rule");
  });
});

// --- Task 8 (WS-07 §8): AskUserQuestion as mandatory interaction -----------------------------------
//
// "AskUserQuestion routes through canUseTool ... mandatory interaction in the pipeline: allow
// rules, acceptEdits, auto, and bypassPermissions never invent an answer ... dontAsk denies it."
// Routed at stage 3, alongside (but independent of) an actual matched ask RULE — no ask rule need
// be configured for this tool to force the prompt path. The tool itself is P3 (no real schema/
// answer-application logic here); this only proves the EVALUATOR routes it correctly.
describe("Task 8 — AskUserQuestion as mandatory interaction (WS-07 §8)", () => {
  for (const mode of ["default", "acceptEdits", "auto", "bypassPermissions"] as const) {
    test(`mode=${mode}: AskUserQuestion reaches the prompt stage even with NO matching ask rule and NO allow rule ever invents an answer`, async () => {
      const promptSpy = spyPromptStage(() => ({ decision: "allow", transformedInput: { answers: ["blue"] } }));
      const ctx = baseCtx({
        promptStage: promptSpy.stage,
        policy: policy({ mode, rules: withRules(rule("AskUserQuestion", "allow")) }), // even a BARE allow rule must not shadow this
        specialChecks: REAL_SPECIAL_CHECKS,
      });
      const record = await evaluate(call("AskUserQuestion", { question: "which color?" }), ctx);
      expect(promptSpy.calls.length).toBe(1);
      expect(record.mechanism).toBe("canUseTool");
      expect(record).toMatchObject({ decision: "allow", transformedInput: { answers: ["blue"] } });
    });
  }

  test("dontAsk: AskUserQuestion is denied outright, the prompt stage is NEVER invoked", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode: "dontAsk" }) });
    const record = await evaluate(call("AskUserQuestion", { question: "which color?" }), ctx);
    expect(promptSpy.calls.length).toBe(0);
    expect(record.decision).toBe("deny");
  });

  test("no answering host (no-opinion prompt stage) fails CLOSED — never implicitly allowed (WS-07 §6.1)", async () => {
    const ctx = baseCtx({ policy: policy({ mode: "default" }) }); // NO_OPINION_PROMPT_STAGE
    const record = await evaluate(call("AskUserQuestion", { question: "which color?" }), ctx);
    expect(record.decision).toBe("deny");
  });

  test("an explicit ask RULE matching AskUserQuestion still populates matchedAskRule (the mandatory-interaction path does not clobber an actual rule match)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      policy: policy({ mode: "default", rules: withRules(rule("AskUserQuestion", "ask")) }),
    });
    const record = await evaluate(call("AskUserQuestion", { question: "which color?" }), ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(promptSpy.calls[0]!.meta.matchedAskRule).toEqual({ source: "sdk", toolName: "AskUserQuestion" });
  });

  test("no matching rule: matchedAskRule is absent, but decisionReason still names the mandatory interaction", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode: "default" }) });
    const record = await evaluate(call("AskUserQuestion", { question: "which color?" }), ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(promptSpy.calls[0]!.meta.matchedAskRule).toBeUndefined();
    expect(promptSpy.calls[0]!.meta.decisionReason).toContain("AskUserQuestion");
  });

  test("a deny rule targeting AskUserQuestion still wins outright (stage 2 runs before stage 3's mandatory interaction)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      policy: policy({ mode: "default", rules: withRules(rule("AskUserQuestion", "deny")) }),
    });
    const record = await evaluate(call("AskUserQuestion", { question: "which color?" }), ctx);
    expect(promptSpy.calls.length).toBe(0);
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("rule");
  });
});

// --- read-only allowed; unmatched -> mode-specific outcome -----------------------------------------

describe("§5 baseline matrix — read-only work and unmatched actions", () => {
  test("default: a recognized read-only Bash command is allowed with zero rules configured", async () => {
    const ctx = baseCtx({ policy: policy({ mode: "default" }) });
    const record = await evaluate(call("Bash", { command: "ls" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  test("dontAsk: the SAME recognized read-only Bash command is allowed too", async () => {
    const ctx = baseCtx({ policy: policy({ mode: "dontAsk" }) });
    const record = await evaluate(call("Bash", { command: "ls" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  test("default: a Read call within cwd is allowed with zero rules configured", async () => {
    const ctx = baseCtx({ cwd: "/work" });
    const record = await evaluate(call("Read", { file_path: "/work/src/index.ts" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  test("default: a Read call OUTSIDE cwd is NOT auto-allowed by the baseline (falls through to the prompt stage)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
    const ctx = baseCtx({ cwd: "/work", promptStage: promptSpy.stage });
    const record = await evaluate(call("Read", { file_path: "/etc/passwd" }), ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(record.mechanism).toBe("canUseTool");
  });

  test("default: an unmatched non-read-only action reaches the prompt stage (mechanism observable, not silently mode-decided)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny", message: "no" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode: "default" }) });
    const record = await evaluate(call("Bash", { command: "curl https://example.com" }), ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("canUseTool");
  });

  test("default: unmatched + a genuinely no-opinion prompt stage resolves DENIED (Ruling P2-I — flips the T6 interim allow fallback, WS-07 §6.1 'never implicitly allowed')", async () => {
    const ctx = baseCtx({ policy: policy({ mode: "default" }) }); // NO_OPINION_PROMPT_STAGE
    const record = await evaluate(call("Bash", { command: "curl https://example.com" }), ctx);
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("mode");
  });

  test("dontAsk: an unmatched non-read-only action is DENIED and the prompt stage is NEVER invoked", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode: "dontAsk" }) });
    const record = await evaluate(call("Bash", { command: "curl https://example.com" }), ctx);
    expect(promptSpy.calls.length).toBe(0);
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("mode");
  });

  test("bypassPermissions: an unmatched action (any tool) is ALLOWED and the prompt stage is never invoked", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode: "bypassPermissions" }) });
    const record = await evaluate(call("Edit", { file_path: "/etc/whatever.conf" }), ctx);
    expect(promptSpy.calls.length).toBe(0);
    expect(record.decision).toBe("allow");
    expect(record.mechanism).toBe("mode");
  });

  test("bypassPermissions: critical removal (SpecialChecks-flagged) still falls through to the prompt stage — the T7 seam contract", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny", message: "critical rm — still prompts even under bypass" }));
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      specialChecks: { isProtectedWrite: () => false, isCriticalRemoval: () => ({ critical: true, reason: "root fs" }) },
      policy: policy({ mode: "bypassPermissions" }),
    });
    const record = await evaluate(call("Bash", { command: "rm -rf /" }), ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(record.decision).toBe("deny");
  });
});

// --- acceptEdits / plan / auto: T6 placeholder arm (identical to default's own baseline) ----------

describe("acceptEdits/plan/auto — the shared baseline invariant (T6 origin; still true after T7's real acceptEdits/plan semantics land below; `auto` remains T12's placeholder)", () => {
  // Task 7: acceptEdits/plan get REAL semantics in their own describe blocks further down. This
  // block is retained (not deleted) because BOTH assertions below still hold true under the real
  // implementation — an out-of-root Edit is still not auto-approved by acceptEdits (WS-07 §2's
  // standing-exceptions list doesn't cover "acceptEdits out-of-root", so it falls through to the
  // ordinary pipeline exactly like `default`'s own unmatched-Edit case; plan withholds the SAME
  // Edit via its own mustPrompt path, which ALSO still calls promptStage before falling back —
  // see evaluateModeStage's own comments) and `pwd` is still built-in-read-only in every mode. A
  // future replacement of either invariant is therefore still a deliberate, reviewed diff here, not
  // a silent regression — exactly the property this block existed to protect under T6.
  for (const mode of ["acceptEdits", "plan", "auto"] as const) {
    test(`mode=${mode}: never auto-approves MORE than default would (an ordinary out-of-root Edit still reaches the prompt stage)`, async () => {
      const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
      const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode }) });
      const record = await evaluate(call("Edit", { file_path: "/etc/x" }), ctx);
      expect(promptSpy.calls.length).toBe(1);
      expect(record.decision).toBe("deny");
    });

    test(`mode=${mode}: still recognizes built-in read-only work (shares default's own baseline)`, async () => {
      const ctx = baseCtx({ policy: policy({ mode }) });
      const record = await evaluate(call("Bash", { command: "pwd" }), ctx);
      expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
    });
  }
});

describe("Task 7 — acceptEdits real semantics (WS-07 §6.2)", () => {
  test("Edit/Write recognized directly, in-bounds (cwd) -> auto-approved", async () => {
    const ctx = baseCtx({ policy: policy({ mode: "acceptEdits" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(call("Edit", { file_path: "/work/src/a.ts" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
    const writeRecord = await evaluate(call("Write", { file_path: "/work/src/b.ts" }), ctx);
    expect(writeRecord).toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  test("a recognized Bash fs-op, in-bounds (the brief's own fixture: in-root `sed -i` approved in acceptEdits)", async () => {
    const ctx = baseCtx({ policy: policy({ mode: "acceptEdits" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(call("Bash", { command: "sed -i 's/x/y/' ./notes.txt" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  test("every recognized fs-op verb auto-approves when in-bounds", async () => {
    const ctx = baseCtx({ policy: policy({ mode: "acceptEdits" }), specialChecks: REAL_SPECIAL_CHECKS });
    for (const command of ["mkdir ./scratch", "touch ./scratch/f.txt", "rm ./scratch/f.txt", "rmdir ./scratch", "mv ./a.txt ./b.txt", "cp ./a.txt ./c.txt"]) {
      const record = await evaluate(call("Bash", { command }), ctx);
      expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
    }
  });

  test("a compound of recognized fs-ops, ALL in-bounds, auto-approves", async () => {
    const ctx = baseCtx({ policy: policy({ mode: "acceptEdits" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(call("Bash", { command: "mkdir ./foo && touch ./foo/bar" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  test("the brief's own fixture: out-of-root write prompts (not silently allowed by acceptEdits' own arm)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny", message: "no" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode: "acceptEdits" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(call("Edit", { file_path: "/etc/x" }), ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(record).toMatchObject({ decision: "deny", mechanism: "canUseTool" });
  });

  test("out-of-root is NOT a standing exception — an explicit allow rule can still rescue it at stage 5 (unlike protected/critical)", async () => {
    // "/synthetic/..." per this file's own header comment — NOT "/etc" (a real macOS symlink to
    // /private/etc, which would make rider 2's OWN symlink-aware allow-rule matching spuriously
    // fail: the resolved target no longer matches a pattern written against the un-resolved link).
    const ctx = baseCtx({
      policy: policy({ mode: "acceptEdits", rules: withRules(rule("Edit(//synthetic/outside/x)", "allow")) }),
      specialChecks: REAL_SPECIAL_CHECKS,
    });
    const record = await evaluate(call("Edit", { file_path: "/synthetic/outside/x" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "rule" });
  });

  test("additionalDirectories (EvaluationContext's own config field) widen the bound, beyond cwd", async () => {
    const ctx = baseCtx({
      policy: policy({ mode: "acceptEdits" }),
      specialChecks: REAL_SPECIAL_CHECKS,
      additionalDirectories: ["/extra/grant"],
    });
    const record = await evaluate(call("Edit", { file_path: "/extra/grant/notes.txt" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  test("T5's rule-derived (trusted, addDirectories-sourced) directories ALSO widen the bound — boundedRoots unions both sources", async () => {
    const ctx = baseCtx({
      trustedWorkspace: true,
      policy: policy({
        mode: "acceptEdits",
        rules: { ...emptyRuleSet(), directories: [{ path: "/rule-granted", source: "session" }] },
      }),
      specialChecks: REAL_SPECIAL_CHECKS,
    });
    const record = await evaluate(call("Edit", { file_path: "/rule-granted/notes.txt" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  test("an UNTRUSTED project-sourced rule directory grant is inert (effectiveDirectories' own trust gate, unaffected by this task)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      trustedWorkspace: false,
      policy: policy({
        mode: "acceptEdits",
        rules: { ...emptyRuleSet(), directories: [{ path: "/rule-granted", source: "project" }] },
      }),
      specialChecks: REAL_SPECIAL_CHECKS,
    });
    const record = await evaluate(call("Edit", { file_path: "/rule-granted/notes.txt" }), ctx);
    expect(promptSpy.calls.length).toBe(1); // never auto-approved via the untrusted grant
  });

  test("mv/cp: BOTH source and destination must be in-bounds — an out-of-root source is not rescued by an in-bounds destination", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode: "acceptEdits" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(call("Bash", { command: "mv /etc/passwd ./local-copy" }), ctx);
    expect(promptSpy.calls.length).toBe(1); // never silently allowed just because the destination is in-bounds
    expect(record.decision).toBe("deny");
  });

  test("unrecognized Bash (not one of the seven verbs, no redirect) falls to the ordinary pipeline, same as default's own 'other unmatched action'", async () => {
    const ctx = baseCtx({ policy: policy({ mode: "acceptEdits" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(call("Bash", { command: "npm test" }), ctx);
    // NO_OPINION_PROMPT_STAGE (default in baseCtx) -> post-Ruling-P2-I, the generic bottom-of-
    // pipeline fallback denies, mechanism "mode" -- IDENTICAL to how `default` mode treats it now.
    expect(record).toMatchObject({ decision: "deny", mechanism: "mode" });
  });

  test("a redirect (kind:'other') never auto-approves even though it's write-shaped", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode: "acceptEdits" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(call("Bash", { command: "echo hi > ./notes.txt" }), ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(record.decision).toBe("deny");
  });
});

describe("Task 7 — plan mode real semantics (WS-07 §6.5, phase ruling 6)", () => {
  test("reads proceed: built-in read-only work is still allowed", async () => {
    const ctx = baseCtx({ policy: policy({ mode: "plan" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(call("Bash", { command: "pwd" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  test("a write (Edit) is withheld with the plan-specific message when unanswered (denial-as-tool_result)", async () => {
    const ctx = baseCtx({ policy: policy({ mode: "plan" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(call("Edit", { file_path: "/work/src/a.ts" }), ctx);
    expect(record).toMatchObject({ decision: "deny", mechanism: "mode", message: PLAN_WRITE_WITHHELD_MESSAGE });
  });

  test("a write still routes through promptStage first — 'unresolved plan-mode operations can still route through canUseTool' (WS-07 §6.5)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode: "plan" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(call("Edit", { file_path: "/work/src/a.ts" }), ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(record).toMatchObject({ decision: "allow", mechanism: "canUseTool" });
  });

  test("a recognized Bash write (fs-op or redirect) is ALSO withheld, not just Edit/Write", async () => {
    const ctx = baseCtx({ policy: policy({ mode: "plan" }), specialChecks: REAL_SPECIAL_CHECKS });
    const fsOp = await evaluate(call("Bash", { command: "rm ./tmp/x" }), ctx);
    expect(fsOp).toMatchObject({ decision: "deny", mechanism: "mode", message: PLAN_WRITE_WITHHELD_MESSAGE });
    const redirect = await evaluate(call("Bash", { command: "echo x > ./log.txt" }), ctx);
    expect(redirect).toMatchObject({ decision: "deny", mechanism: "mode", message: PLAN_WRITE_WITHHELD_MESSAGE });
  });

  test("ordinary allow rules do NOT silently convert a plan-mode write into execution (WS-07 §6.5)", async () => {
    const ctx = baseCtx({
      policy: policy({ mode: "plan", rules: withRules(rule("Edit(**)", "allow")) }),
      specialChecks: REAL_SPECIAL_CHECKS,
    });
    const record = await evaluate(call("Edit", { file_path: "/work/src/a.ts" }), ctx);
    expect(record.decision).toBe("deny"); // never resolves via mechanism "rule" here — stage 5 is never reached
  });

  test("a non-write exploratory action falls to the ordinary pipeline (classifier borrow OFF at P2)", async () => {
    const ctx = baseCtx({ policy: policy({ mode: "plan" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(call("Bash", { command: "npm test" }), ctx);
    expect(record).toMatchObject({ decision: "deny", mechanism: "mode" }); // post-Ruling-P2-I, same as default's own "other unmatched action"
  });

  test("bypass-relaxation: session bypass-enabled + plan = writes execute (§6.4/§6.5) — an unconditional auto-allow at stage 4, deliberately NOT routed through stage 5/6 (advisor-reviewed: must survive T8's future flip of the generic bottom-of-pipeline fallback)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" })); // proves this does NOT fall through to the prompt stage at all
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      policy: policy({ mode: "plan" }),
      specialChecks: REAL_SPECIAL_CHECKS,
      sessionBypassEnabled: true,
    });
    const record = await evaluate(call("Edit", { file_path: "/work/src/a.ts" }), ctx);
    // WINTER_SDK note (WS-15's UI-surfacing obligation): a session that enabled bypass at startup
    // loses plan's own enforcement boundary the instant it's in plan mode — the host UI MUST show
    // this loss of protection (WS-07 §6.4: "Winter preserves that interaction for compatibility and
    // its UI MUST surface the loss of plan enforcement"). This evaluator has no UI surface of its
    // own; the obligation is discharged by whichever host renders canUseTool/mode state (WS-15),
    // not by this function — flagged here so the obligation isn't lost between specs.
    expect(promptSpy.calls.length).toBe(0);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  test("bypass-relaxation does NOT need an allow rule — an out-of-cwd write also executes unconditionally (proves this is a direct allow, not merely 'ordinary pipeline, and this path happens to be in cwd')", async () => {
    const ctx = baseCtx({
      cwd: "/work",
      policy: policy({ mode: "plan" }),
      specialChecks: REAL_SPECIAL_CHECKS,
      sessionBypassEnabled: true,
    });
    const record = await evaluate(call("Edit", { file_path: "/synthetic/outside/x" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  test("critical removal is NEVER relaxed by session bypass in plan mode (§6.8's plan row has no bypass carve-out, unlike §6.7's)", async () => {
    const ctx = baseCtx({
      policy: policy({ mode: "plan" }),
      specialChecks: REAL_SPECIAL_CHECKS,
      sessionBypassEnabled: true,
    });
    const record = await evaluate(call("Bash", { command: "rm -rf /" }), ctx);
    expect(record.decision).toBe("deny"); // still fails closed absent a real prompt handler -- never auto-allowed
    expect(record.mechanism).toBe("mode");
  });
});

describe("Task 7 — §6.7 protected-path write matrix (mode × protected write, cell-by-cell, verbatim table)", () => {
  const protectedCall = call("Edit", { file_path: "/work/.git/config" });

  test("default: prompt/callback", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode: "default" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(protectedCall, ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(record).toMatchObject({ decision: "deny", mechanism: "canUseTool" });
  });

  test("Task 8 (WS-07 §7.1 blockedPath): the prompt meta carries the resolved candidate path that made isProtectedWrite fire", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, cwd: "/work", policy: policy({ mode: "default" }), specialChecks: REAL_SPECIAL_CHECKS });
    await evaluate(protectedCall, ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(promptSpy.calls[0]!.meta.blockedPath).toBe("/work/.git/config");
  });

  test("acceptEdits: prompt/callback — never silently auto-approved just because Edit is 'recognized'", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode: "acceptEdits" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(protectedCall, ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(record.decision).toBe("deny");
  });

  test("dontAsk: deny, canUseTool never called", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" })); // even if it WOULD allow, dontAsk must never ask at all
    const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode: "dontAsk" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(protectedCall, ctx);
    expect(promptSpy.calls.length).toBe(0);
    expect(record).toMatchObject({ decision: "deny", mechanism: "mode" });
  });

  test("bypassPermissions: allow, unconditionally (the ONE matrix cell where protected differs from critical)", async () => {
    const ctx = baseCtx({ policy: policy({ mode: "bypassPermissions" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(protectedCall, ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  test("plan (no session bypass): prompt (classifier-active branch never applies at P2)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode: "plan" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(protectedCall, ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(record.decision).toBe("deny");
  });

  test("plan + session bypass enabled: allowed (§6.7's own bypass carve-out)", async () => {
    const ctx = baseCtx({ policy: policy({ mode: "plan" }), specialChecks: REAL_SPECIAL_CHECKS, sessionBypassEnabled: true });
    const record = await evaluate(protectedCall, ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  test("auto: prompt (classifier not yet wired at P2 — T12's job; never silently allow)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode: "auto" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(protectedCall, ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(record.decision).toBe("deny");
  });

  test("an explicit allow rule does NOT clear this check, in ANY mode (WS-07 §6.7: 'an ordinary settings allow rule does NOT clear this check') — fix round 1, item 2: the loop now actually covers all six modes, matching this test's own title", async () => {
    // Per-mode expected shape differs (bypassPermissions' OWN §6.7 cell is "allow"; dontAsk never
    // calls the prompt stage at all) -- the universal invariant this test exists to prove is
    // `mechanism !== "rule"` in every case: the explicit `Edit(**)` allow rule never wins, whatever
    // the mode's own baseline otherwise resolves to.
    const cases: Array<{ mode: PermissionMode; expectPromptCalls: number; expectDecision: "allow" | "deny" }> = [
      { mode: "default", expectPromptCalls: 1, expectDecision: "deny" },
      { mode: "acceptEdits", expectPromptCalls: 1, expectDecision: "deny" },
      { mode: "dontAsk", expectPromptCalls: 0, expectDecision: "deny" },
      { mode: "bypassPermissions", expectPromptCalls: 0, expectDecision: "allow" },
      { mode: "plan", expectPromptCalls: 1, expectDecision: "deny" },
      { mode: "auto", expectPromptCalls: 1, expectDecision: "deny" },
    ];
    for (const { mode, expectPromptCalls, expectDecision } of cases) {
      const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
      const ctx = baseCtx({
        promptStage: promptSpy.stage,
        policy: policy({ mode, rules: withRules(rule("Edit(**)", "allow")) }),
        specialChecks: REAL_SPECIAL_CHECKS,
      });
      const record = await evaluate(protectedCall, ctx);
      expect(promptSpy.calls.length).toBe(expectPromptCalls);
      expect(record.decision).toBe(expectDecision);
      expect(record.mechanism).not.toBe("rule");
    }
  });

  test("reads are unaffected — a plain Read of a protected path is untouched by this primitive (write-shaped only)", async () => {
    const ctx = baseCtx({ cwd: "/work", policy: policy({ mode: "default" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(call("Read", { file_path: "/work/.git/config" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" }); // ordinary cwd-read baseline, never routed through the protected-write check
  });
});

describe("Task 7 — §6.8 critical-removal matrix (mode × critical rm, cell-by-cell) — the brief's own `rm -rf /` fixture, every mode", () => {
  const criticalCall = call("Bash", { command: "rm -rf /" });

  for (const mode of ["default", "acceptEdits", "bypassPermissions", "plan", "auto"] as const) {
    test(`${mode}: never silently allowed — reaches the prompt stage, fails closed absent a real answer`, async () => {
      const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
      const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode }), specialChecks: REAL_SPECIAL_CHECKS });
      const record = await evaluate(criticalCall, ctx);
      expect(promptSpy.calls.length).toBe(1);
      expect(record.decision).toBe("deny");
    });
  }

  test("dontAsk: deny outright, canUseTool never called", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode: "dontAsk" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(criticalCall, ctx);
    expect(promptSpy.calls.length).toBe(0);
    expect(record).toMatchObject({ decision: "deny", mechanism: "mode" });
  });

  test("bypassPermissions specifically: 'still prompts/callback' — a REAL prompt answer of allow DOES execute (unlike the fail-closed-absent-a-host default)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode: "bypassPermissions" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(criticalCall, ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(record).toMatchObject({ decision: "allow", mechanism: "canUseTool" });
  });

  test("plan + session bypass enabled: critical removal is STILL prompted, never relaxed (§6.8's plan row has no bypass carve-out, unlike §6.7's)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      policy: policy({ mode: "plan" }),
      specialChecks: REAL_SPECIAL_CHECKS,
      sessionBypassEnabled: true,
    });
    const record = await evaluate(criticalCall, ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(record.decision).toBe("deny");
  });

  test("T6-review obligation: a broad `Bash(rm *)` allow rule does NOT rescue a critical rm at stage 5, in EVERY mode — fix round 1, item 2: dontAsk and plan added, the loop now covers all six", async () => {
    const cases: Array<{ mode: PermissionMode; expectPromptCalls: number }> = [
      { mode: "default", expectPromptCalls: 1 },
      { mode: "acceptEdits", expectPromptCalls: 1 },
      { mode: "dontAsk", expectPromptCalls: 0 }, // canUseTool is NEVER called in dontAsk (WS-07 §6.3)
      { mode: "bypassPermissions", expectPromptCalls: 1 },
      { mode: "plan", expectPromptCalls: 1 },
      { mode: "auto", expectPromptCalls: 1 },
    ];
    for (const { mode, expectPromptCalls } of cases) {
      const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
      const ctx = baseCtx({
        promptStage: promptSpy.stage,
        policy: policy({ mode, rules: withRules(rule("Bash(rm *)", "allow")) }),
        specialChecks: REAL_SPECIAL_CHECKS,
      });
      const record = await evaluate(criticalCall, ctx);
      expect(record.mechanism).not.toBe("rule"); // never resolved by the allow rule
      expect(promptSpy.calls.length).toBe(expectPromptCalls);
      // critical NEVER auto-allows in ANY mode (unlike protected-write's own bypassPermissions cell)
      expect(record.decision).toBe("deny");
    }
  });

  test("a PreToolUse hook 'allow' does not clear the critical-removal circuit breaker either (WS-07 §2 stage 1 / §6.8)", async () => {
    const hookSpy = spyHookStage(() => ({ decision: "allow" }));
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({
      hookStage: hookSpy.stage,
      promptStage: promptSpy.stage,
      policy: policy({ mode: "default" }),
      specialChecks: REAL_SPECIAL_CHECKS,
    });
    const record = await evaluate(criticalCall, ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(record.decision).toBe("deny");
  });

  test("`rm $VAR/…` — variable-rooted conservative-critical, reaches the standing exception (the task's own fixture)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode: "default" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(call("Bash", { command: "rm -rf $SOME_DIR/sub" }), ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(record.decision).toBe("deny");
  });
});

describe("Task 7 — T6-review obligation: Read-deny-blocks-Edit enforced generally at stage 2 (WS-07 §3.1), not merely inside acceptEdits", () => {
  test("default mode: a Read deny on the path blocks an Edit, before ever reaching the mode/prompt stage", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" })); // proves the denial happens BEFORE the prompt stage, not merely "would deny if asked"
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      cwd: "/work",
      policy: policy({ mode: "default", rules: withRules(rule("Read(secrets/**)", "deny")) }),
    });
    const record = await evaluate(call("Edit", { file_path: "/work/secrets/key.pem" }), ctx);
    expect(promptSpy.calls.length).toBe(0);
    expect(record).toMatchObject({ decision: "deny", mechanism: "rule" });
  });

  test("acceptEdits: the SAME Read-deny-blocked path is denied, not auto-approved despite being in-bounds and recognized", async () => {
    const ctx = baseCtx({
      cwd: "/work",
      policy: policy({ mode: "acceptEdits", rules: withRules(rule("Read(secrets/**)", "deny")) }),
      specialChecks: REAL_SPECIAL_CHECKS,
    });
    const record = await evaluate(call("Edit", { file_path: "/work/secrets/key.pem" }), ctx);
    expect(record).toMatchObject({ decision: "deny", mechanism: "rule" });
  });

  test("bypassPermissions: the Read-deny-blocks-Edit check is a stage-2 DENY rule, so it wins even under bypass", async () => {
    const ctx = baseCtx({
      cwd: "/work",
      policy: policy({ mode: "bypassPermissions", rules: withRules(rule("Read(secrets/**)", "deny")) }),
    });
    const record = await evaluate(call("Edit", { file_path: "/work/secrets/key.pem" }), ctx);
    expect(record).toMatchObject({ decision: "deny", mechanism: "rule" });
  });

  test("a Write call is blocked identically to Edit", async () => {
    const ctx = baseCtx({
      cwd: "/work",
      policy: policy({ mode: "default", rules: withRules(rule("Read(secrets/**)", "deny")) }),
    });
    const record = await evaluate(call("Write", { file_path: "/work/secrets/new-key.pem" }), ctx);
    expect(record).toMatchObject({ decision: "deny", mechanism: "rule" });
  });

  test("a Read ASK rule (not deny) does not block Edit — WS-07 §3.1 names deny specifically", async () => {
    const ctx = baseCtx({
      cwd: "/work",
      policy: policy({ mode: "default", rules: withRules(rule("Read(secrets/**)", "ask")) }),
    });
    const record = await evaluate(call("Edit", { file_path: "/work/secrets/key.pem" }), ctx);
    expect(record.mechanism).not.toBe("rule"); // the ask rule is Read-scoped and never matches an Edit call at all
  });

  test("a non-matching Read deny does not block an unrelated path (falls through to the ordinary pipeline, denied post-Ruling-P2-I absent a real prompt handler)", async () => {
    const ctx = baseCtx({
      cwd: "/work",
      policy: policy({ mode: "default", rules: withRules(rule("Read(secrets/**)", "deny")) }),
    });
    const record = await evaluate(call("Edit", { file_path: "/work/public/readme.txt" }), ctx);
    // "does not block" means the Read-deny-blocks-Edit primitive never fires (mechanism is never
    // "rule") -- an ordinary Edit in `default` mode still reaches the (here, no-opinion) prompt
    // stage exactly like any other unmatched action, which now denies rather than allows.
    expect(record).toMatchObject({ decision: "deny", mechanism: "mode" });
  });

  // Fix round 1, item 1 (MAJOR, reviewer-caught): WS-07 §3.1 says outright "Recognized Bash file
  // operations consult these rules," and §6.2 lists "Read/Edit deny rules" in acceptEdits' own
  // bounding sequence — the pre-fix `findReadDenyBlockingEdit` only ever looked at Edit/Write calls,
  // and its own comment's claimed compensating control ("caught by the ordinary Bash deny-rule
  // stage instead") does not exist: a `Read`-toolName rule can never match a `Bash`-toolName call
  // through matchesRuleForCall (tool-name mismatch, checked first). Concretely, before this fix,
  // `Read(secrets/**) deny` + acceptEdits + `sed -i 's/x/y/' secrets/key.pem` was silently
  // auto-approved. These three fixtures were run and CONFIRMED FAILING against the pre-fix
  // Edit/Write-only findReadDenyBlockingEdit before the fix below was applied (task-7-report.md
  // fix-round section has the transcript).
  test("MAJOR fix round 1: a recognized Bash fs-op (sed -i) touching a Read-denied path is blocked, not silently auto-approved by acceptEdits", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" })); // proves the denial happens BEFORE the prompt stage
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      cwd: "/work",
      policy: policy({ mode: "acceptEdits", rules: withRules(rule("Read(secrets/**)", "deny")) }),
      specialChecks: REAL_SPECIAL_CHECKS,
    });
    const record = await evaluate(call("Bash", { command: "sed -i 's/x/y/' secrets/key.pem" }), ctx);
    expect(promptSpy.calls.length).toBe(0);
    expect(record).toMatchObject({ decision: "deny", mechanism: "rule" });
  });

  test("a redirect target touching a Read-denied path is ALSO blocked (redirect targets come free via recognizeEditOperation's own path union)", async () => {
    const ctx = baseCtx({
      cwd: "/work",
      policy: policy({ mode: "acceptEdits", rules: withRules(rule("Read(secrets/**)", "deny")) }),
      specialChecks: REAL_SPECIAL_CHECKS,
    });
    const record = await evaluate(call("Bash", { command: "echo x > secrets/out" }), ctx);
    expect(record).toMatchObject({ decision: "deny", mechanism: "rule" });
  });

  test("negative control: the SAME sed -i command with no matching Read-deny rule is still auto-approved (the fix doesn't over-block)", async () => {
    const ctx = baseCtx({
      cwd: "/work",
      policy: policy({ mode: "acceptEdits" }),
      specialChecks: REAL_SPECIAL_CHECKS,
    });
    const record = await evaluate(call("Bash", { command: "sed -i 's/x/y/' secrets/key.pem" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });
});

describe("Task 7 — Ruling P2-J (rider 2) proven at the evaluator layer, not just paths.ts (real mkdtemp + planted symlinks — see this file's own header)", () => {
  // Real fs, exactly like paths.test.ts's own checkSymlinkBothEnds regime: realpath the mkdtemp
  // root immediately (the macOS $TMPDIR-resolves-through-a-symlink trap; see paths.test.ts's
  // freshRoot comment) so a matcher built from the un-realpath'd mkdtemp path never disagrees with
  // this module's own realpathSync-based resolution.
  function freshRoot(): string {
    return realpathSync(mkdtempSync(join(tmpdir(), "winter-evaluator-symlink-")));
  }

  test("deny-via-target: a Read deny on secrets/** fires on a symlink OUTSIDE secrets/ whose target resolves INTO it — mechanism 'rule', at stage 2", async () => {
    const root = freshRoot();
    try {
      const secretsDir = join(root, "secrets");
      mkdirSync(secretsDir);
      const secretFile = join(secretsDir, "key.pem");
      writeFileSync(secretFile, "top secret");
      const outsideDir = join(root, "outside");
      mkdirSync(outsideDir);
      const linkPath = join(outsideDir, "link-to-secret"); // lives OUTSIDE secrets/, resolves INTO it
      symlinkSync(secretFile, linkPath);

      const promptSpy = spyPromptStage(() => ({ decision: "allow" })); // proves the deny fires BEFORE ever reaching the prompt stage
      const ctx = baseCtx({
        promptStage: promptSpy.stage,
        cwd: root,
        policy: policy({ rules: withRules(rule("Read(secrets/**)", "deny")) }),
      });
      const record = await evaluate(call("Read", { file_path: linkPath }), ctx);
      expect(promptSpy.calls.length).toBe(0);
      expect(record).toMatchObject({ decision: "deny", mechanism: "rule" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cwd-baseline-escape: default mode, a symlink INSIDE cwd whose target resolves OUTSIDE it is NOT routine-read-only-in-cwd — falls through to the prompt stage instead of auto-allowing", async () => {
    const root = freshRoot();
    const cwd = join(root, "work");
    mkdirSync(cwd);
    try {
      const outsideFile = join(root, "outside-secret.txt");
      writeFileSync(outsideFile, "secret");
      const linkPath = join(cwd, "escape-link"); // sits INSIDE cwd, resolves OUTSIDE it
      symlinkSync(outsideFile, linkPath);

      const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
      const ctx = baseCtx({ promptStage: promptSpy.stage, cwd, policy: policy({ mode: "default" }) });
      const record = await evaluate(call("Read", { file_path: linkPath }), ctx);
      // if the wiring regressed to plain matchFileRule (link-text-only), this would resolve
      // {decision:"allow", mechanism:"mode"} WITHOUT ever calling promptStage — exactly the fail-
      // open rider 2 exists to close.
      expect(promptSpy.calls.length).toBe(1);
      expect(record.mechanism).toBe("canUseTool");

      // an ORDINARY (non-symlink) file actually inside cwd is unaffected by the same wiring.
      const ordinary = join(cwd, "ordinary.txt");
      writeFileSync(ordinary, "fine");
      const ordinaryRecord = await evaluate(call("Read", { file_path: ordinary }), ctx);
      expect(ordinaryRecord).toMatchObject({ decision: "allow", mechanism: "mode" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("allow requires BOTH ends: an allow rule scoped to project/** does not fire through a link planted outside it whose target resolves in", async () => {
    const root = freshRoot();
    try {
      const projectDir = join(root, "project");
      mkdirSync(projectDir);
      const realFile = join(projectDir, "real.txt");
      writeFileSync(realFile, "content");
      const outsideDir = join(root, "outside");
      mkdirSync(outsideDir);
      const linkPath = join(outsideDir, "link");
      symlinkSync(realFile, linkPath);

      const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
      const ctx = baseCtx({
        promptStage: promptSpy.stage,
        cwd: root,
        policy: policy({ rules: withRules(rule("Edit(project/**)", "allow")) }),
      });
      const record = await evaluate(call("Edit", { file_path: linkPath }), ctx);
      expect(record.mechanism).not.toBe("rule"); // never silently allowed via the rule
      expect(promptSpy.calls.length).toBe(1); // falls through to the ordinary pipeline instead
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Task 7 — advisor-flagged gap, fixed: protected-write is symlink-aware too (a live fail-open this task's own matrix would otherwise miss)", () => {
  function freshRoot(): string {
    return realpathSync(mkdtempSync(join(tmpdir(), "winter-evaluator-protected-symlink-")));
  }

  test("acceptEdits: writing through an in-bounds symlink whose REAL TARGET lands inside .git is still protected — not silently auto-approved", async () => {
    const root = freshRoot();
    try {
      const gitDir = join(root, ".git");
      mkdirSync(gitDir);
      const gitConfig = join(gitDir, "config");
      writeFileSync(gitConfig, "[core]");
      const linkPath = join(root, "innocent-link"); // sits in cwd, LOOKS unrelated to .git
      symlinkSync(gitConfig, linkPath);

      const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
      const ctx = baseCtx({
        promptStage: promptSpy.stage,
        cwd: root,
        policy: policy({ mode: "acceptEdits" }),
        specialChecks: REAL_SPECIAL_CHECKS,
      });
      const record = await evaluate(call("Edit", { file_path: linkPath }), ctx);
      // Without the fix, isProtectedPath (link-text-only) sees no ".git" segment in "innocent-link"
      // and isWithinBounds sees both ends inside cwd -> this would silently auto-approve.
      expect(promptSpy.calls.length).toBe(1);
      expect(record.decision).toBe("deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- Trap 1: compound Bash commands must be split before recognition/matching ----------------------

describe("compound Bash commands — split before recognition/matching (lens item 1)", () => {
  test("`ls && rm -rf /` is NOT read-only recognized (one dangerous subcommand taints the whole thing)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode: "default" }) });
    const record = await evaluate(call("Bash", { command: "ls && rm -rf /" }), ctx);
    // reached the prompt stage — proves stage 4's baseline did NOT recognize it as read-only
    expect(promptSpy.calls.length).toBe(1);
    expect(record.mechanism).toBe("canUseTool");
  });

  test("`ls; pwd` IS read-only allowed — every subcommand independently recognized", async () => {
    const ctx = baseCtx({ policy: policy({ mode: "default" }) });
    const record = await evaluate(call("Bash", { command: "ls; pwd" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  test("a deny rule fires if ANY subcommand of a compound command matches it", async () => {
    const ctx = baseCtx({ policy: policy({ rules: withRules(rule("Bash(rm *)", "deny")) }) });
    const record = await evaluate(call("Bash", { command: "ls && rm -rf /tmp/x" }), ctx);
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("rule");
  });

  test("an allow rule only covers a compound command when it matches EVERY subcommand (conservative reading)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      policy: policy({ mode: "default", rules: withRules(rule("Bash(git status)", "allow")) }),
    });
    // "git status && git push" — the allow rule matches only the FIRST subcommand, not both.
    const record = await evaluate(call("Bash", { command: "git status && git push" }), ctx);
    expect(promptSpy.calls.length).toBe(1); // never silently allowed via the partial match
    expect(record.mechanism).toBe("canUseTool");
  });

  test("an unparseable command containing an allow-matching SUBSTRING does not match the allow rule (raw text never reaches matchesRule)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      policy: policy({ mode: "default", rules: withRules(rule("Bash(rm -rf /)", "allow")) }),
    });
    // unterminated quote -> splitCompound returns null; the raw string literally CONTAINS "rm -rf /"
    const record = await evaluate(call("Bash", { command: "echo 'rm -rf /" }), ctx);
    expect(promptSpy.calls.length).toBe(1); // never silently allowed by matching the raw substring
    expect(record.mechanism).toBe("canUseTool");
  });

  test("an unparseable command is also never denied via a scoped pattern deny rule (fails to the mode baseline either way)", async () => {
    const ctx = baseCtx({ policy: policy({ mode: "dontAsk", rules: withRules(rule("Bash(rm -rf /)", "deny")) }) });
    const record = await evaluate(call("Bash", { command: "echo 'rm -rf /" }), ctx);
    // dontAsk's own unmatched-fallback still denies it — but via mechanism "mode", not "rule",
    // proving the scoped deny rule itself never matched the unparseable raw text.
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("mode");
  });

  test("a BARE Bash deny still applies to an unparseable command (schema-level deny needs no command text)", async () => {
    const ctx = baseCtx({ policy: policy({ rules: withRules(rule("Bash", "deny")) }) });
    const record = await evaluate(call("Bash", { command: "echo 'unterminated" }), ctx);
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("rule");
    expect(record.deniedBareSchemaRemoval).toBe(true);
  });

  // Fix round 1, item 1 (IMPORTANT — vacuous allow-match): splitCompound("") returns `[]`, not
  // null (empty/all-separator/missing-command input scans OK, it just has zero non-empty
  // subcommands) — so `parts.every(matchesSub)`, unguarded, is vacuously TRUE for ANY configured
  // Bash allow rule regardless of what it says, falsely attributing mechanism:"rule"/ruleRef and
  // defeating dontAsk's own deny-unmatched fallback for this whole input class. Mirrors the
  // guard `isBashCallReadOnly` (above in evaluator.ts) already has: `parts.length > 0 && ...`.
  describe("empty/degenerate Bash commands never vacuously match an allow rule (fix round 1, item 1)", () => {
    const degenerateInputs: Array<{ label: string; input: Record<string, unknown> }> = [
      { label: "input: {} (no command field at all)", input: {} },
      { label: 'command: ""', input: { command: "" } },
      { label: 'command: ";" (splits to zero non-empty subcommands)', input: { command: ";" } },
    ];

    for (const { label, input } of degenerateInputs) {
      test(`default mode: ${label} does NOT match a configured Bash(npm test) allow rule`, async () => {
        const promptSpy = spyPromptStage(() => ({ decision: "deny", message: "no" }));
        const ctx = baseCtx({
          promptStage: promptSpy.stage,
          policy: policy({ mode: "default", rules: withRules(rule("Bash(npm test)", "allow")) }),
        });
        const record = await evaluate(call("Bash", input), ctx);
        // Must NOT be silently allowed via the allow rule — falls through to the prompt stage
        // instead, exactly like any other unmatched action in default mode.
        expect(record.mechanism).not.toBe("rule");
        expect(promptSpy.calls.length).toBe(1);
      });

      test(`dontAsk mode: ${label} does NOT match a configured Bash(npm test) allow rule — resolves via dontAsk's own deny-unmatched fallback`, async () => {
        const ctx = baseCtx({
          policy: policy({ mode: "dontAsk", rules: withRules(rule("Bash(npm test)", "allow")) }),
        });
        const record = await evaluate(call("Bash", input), ctx);
        // The vacuous bug would report decision:"allow"/mechanism:"rule" here. Correct behavior:
        // dontAsk's generic unmatched-action fallback denies it, mechanism "mode" — never "rule".
        expect(record.decision).toBe("deny");
        expect(record.mechanism).toBe("mode");
      });
    }
  });
});

// --- Lens item 2: FILE_RULE_TOOLS (Read/Edit) route to matchFileRule, never matchesRule ------------

describe("file-rule routing — Read/Edit scoped rules route to matchFileRule (lens item 2)", () => {
  test("a scoped Read deny rule denies a matching path (would silently never-match via matchesRule's command lookup)", async () => {
    const ctx = baseCtx({ cwd: "/work", policy: policy({ rules: withRules(rule("Read(//etc/passwd)", "deny")) }) });
    const record = await evaluate(call("Read", { file_path: "/etc/passwd" }), ctx);
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("rule");
  });

  test("the SAME deny rule does not block a different path", async () => {
    const ctx = baseCtx({ cwd: "/work", policy: policy({ rules: withRules(rule("Read(//etc/passwd)", "deny")) }) });
    const record = await evaluate(call("Read", { file_path: "/work/ok.txt" }), ctx);
    expect(record.decision).toBe("allow"); // falls through to the cwd read-only baseline
  });

  test("a scoped Edit deny rule denies a matching path", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      cwd: "/work",
      policy: policy({ rules: withRules(rule("Edit(//etc/**)", "deny")) }),
    });
    const record = await evaluate(call("Edit", { file_path: "/etc/hosts" }), ctx);
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("rule");
    expect(promptSpy.calls.length).toBe(0); // deny short-circuits before ever reaching the prompt stage
  });

  test("a scoped allow rule (outside cwd, ~-anchored) allows via matchFileRule — isolated from the cwd baseline", async () => {
    const ctx = baseCtx({
      cwd: "/work",
      home: "/synthetic/home/tester",
      policy: policy({ rules: withRules(rule("Read(~/.config/app/**)", "allow")) }),
    });
    const record = await evaluate(call("Read", { file_path: "/synthetic/home/tester/.config/app/settings.json" }), ctx);
    expect(record.decision).toBe("allow");
    expect(record.mechanism).toBe("rule");
    expect(record.source).toBe("sdk");
  });

  test("a project-sourced Read allow rule is INERT in an untrusted workspace (duplicated trust gate)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      cwd: "/work",
      home: "/synthetic/home/tester",
      trustedWorkspace: false,
      policy: policy({ rules: withRules(rule("Read(~/.config/app/**)", "allow", "project")) }),
    });
    const record = await evaluate(call("Read", { file_path: "/synthetic/home/tester/.config/app/settings.json" }), ctx);
    expect(promptSpy.calls.length).toBe(1); // the allow rule never fired
    expect(record.mechanism).toBe("canUseTool");
  });

  test("the SAME project-sourced allow rule fires once trustedWorkspace flips true", async () => {
    const ctx = baseCtx({
      cwd: "/work",
      home: "/synthetic/home/tester",
      trustedWorkspace: true,
      policy: policy({ rules: withRules(rule("Read(~/.config/app/**)", "allow", "project")) }),
    });
    const record = await evaluate(call("Read", { file_path: "/synthetic/home/tester/.config/app/settings.json" }), ctx);
    expect(record.decision).toBe("allow");
    expect(record.mechanism).toBe("rule");
  });

  test("bare Read/Edit rules (no specifier) are handled directly — never routed through matchFileRule at all", async () => {
    const ctx = baseCtx({ policy: policy({ rules: withRules(rule("Read", "deny")) }) });
    const record = await evaluate(call("Read", { file_path: "/anything/at/all" }), ctx);
    expect(record.decision).toBe("deny");
    expect(record.deniedBareSchemaRemoval).toBe(true);
  });
});

// --- Fix round 1, item 2 (MODERATE): parity between the two rule-lookup copies --------------------
//
// evaluator.ts's own header comment ("Rule lookup — deliberately NOT ruleset.ts's resolveRules()")
// already documents WHY findMatchingRuleEntry/matchesRuleForCall duplicate resolveRules()'s
// precedence loop (trust gate + allowManagedPermissionRulesOnly filter) instead of calling it:
// resolveRules() cannot correctly evaluate FILE_RULE_TOOLS patterns or compound Bash commands.
// That duplication stopped being hypothetical risk the moment item 1's vacuous-allow-match bug
// was found: resolveRules() (via plain matchesRule, no compound-splitting) was ALREADY fail-closed
// on an empty Bash command, while this file's own copy was fail-open. This table pins agreement
// between the two copies on every case that is NOT one of the two structurally-necessary
// divergences (a FILE_RULE_TOOLS pattern rule, or a Bash pattern rule against a genuinely compound
// command) — i.e. every specifier kind resolveRules' own matchesRule call already handles
// correctly on its own, plus the shared precedence-loop mechanics (trust gate, managed-only
// filter), plus the degenerate-Bash-command case item 1 just fixed. If this table ever fails, one
// copy drifted from the other: treat ruleset.ts's resolveRules() as ground truth for these
// specifier kinds (it is the ORIGINAL, undisputed implementation T5 built and T6/T7 never had
// authorization to edit) and re-align findMatchingRuleEntry/matchesRuleForCall in THIS file to
// match — never the reverse, and never by making the evaluator call resolveRules() directly (see
// this file's own header for why that still can't work generally).
//
// NOTE for a future editor of ruleset.ts specifically: this file (evaluator.test.ts) is the one
// place that pins cross-copy agreement — Task 6/7's edit authorization never extended to
// ruleset.ts itself, so no equivalent pointer could be left there. If you change resolveRules()'s
// precedence-loop mechanics, run this describe block.
describe("parity: findMatchingRuleEntry (evaluator.ts) vs. resolveRules (ruleset.ts) agree on every case that routes through both", () => {
  function compare(
    entries: SourcedRuleEntry[],
    theCall: PermissionCall,
    opts: { trustedWorkspace: boolean; allowManagedPermissionRulesOnly?: boolean },
  ): void {
    const rules = withRules(...entries);
    const resolved = resolveRules(rules, theCall, opts);
    const ctx = baseCtx({
      trustedWorkspace: opts.trustedWorkspace,
      ...(opts.allowManagedPermissionRulesOnly !== undefined ? { allowManagedPermissionRulesOnly: opts.allowManagedPermissionRulesOnly } : {}),
      policy: policy({ rules }),
    });
    // Referential equality (toBe), not just presence: both copies must find the exact SAME entry
    // object by walking the identical pool in the identical order — a stronger guarantee than "both
    // say yes/no", and it degrades gracefully to `undefined === undefined` when neither matches.
    expect(findMatchingRuleEntry(rules, theCall, "deny", ctx)).toBe(resolved.deny);
    expect(findMatchingRuleEntry(rules, theCall, "ask", ctx)).toBe(resolved.ask);
    expect(findMatchingRuleEntry(rules, theCall, "allow", ctx)).toBe(resolved.allow);
  }

  test("bare rule", () => {
    compare([rule("Bash", "deny")], call("Bash", { command: "anything" }), { trustedWorkspace: false });
  });

  test("wildcardAll rule — Tool(*)", () => {
    compare([rule("Bash(*)", "allow")], call("Bash", { command: "anything" }), { trustedWorkspace: true });
  });

  test("param rule — denyAsk direction matches on equal scalar value", () => {
    compare([rule("Agent(model:opus)", "ask")], call("Agent", { model: "opus" }), { trustedWorkspace: false });
  });

  test("param rule — allow direction never matches (WS-07 §3: param rules cannot pre-approve)", () => {
    compare([rule("Agent(model:opus)", "allow")], call("Agent", { model: "opus" }), { trustedWorkspace: true });
  });

  test("webFetchDomain rule", () => {
    compare([rule("WebFetch(domain:example.com)", "deny")], call("WebFetch", { domain: "example.com" }), { trustedWorkspace: false });
  });

  for (const source of ["project", "local"] as const) {
    for (const trustedWorkspace of [false, true]) {
      test(`trust gate (Ruling P2-H) — ${source}-sourced allow rule (wildcardAll), trustedWorkspace=${trustedWorkspace}`, () => {
        compare([rule("Bash(*)", "allow", source)], call("Bash", { command: "anything" }), { trustedWorkspace });
      });
    }
  }

  test("allowManagedPermissionRulesOnly filters BOTH copies identically (managed entry found, sdk-sourced sibling excluded)", () => {
    compare(
      [rule("Bash", "allow", "sdk"), rule("Bash", "allow", "managed")],
      call("Bash", { command: "anything" }),
      { trustedWorkspace: true, allowManagedPermissionRulesOnly: true },
    );
  });

  describe("empty-command Bash pattern rule (item 1's fix) — both copies agree post-fix", () => {
    const degenerateInputs: Record<string, Record<string, unknown>> = {
      "input: {}": {},
      'command: ""': { command: "" },
      'command: ";"': { command: ";" },
    };
    for (const [label, input] of Object.entries(degenerateInputs)) {
      test(label, () => {
        compare([rule("Bash(npm test)", "allow")], call("Bash", input), { trustedWorkspace: true });
      });
    }
  });
});

// --- policyVersion stamping + stale-decision detection (unit-level primitive) ----------------------

describe("policyVersion stamping (WS-07 §2's stale-policy-rejection contract)", () => {
  test("the returned record's policyVersion reflects the snapshot passed in ctx.policy, not any later mutation", async () => {
    const store = new PolicyStateStore({ mode: "default", rules: emptyRuleSet() }, {
      allowDangerouslySkipPermissions: false,
      disableBypassPermissionsMode: false,
    });
    const snapshotBefore = store.getState();
    // A seam stub that simulates a concurrent mode/rule change landing WHILE this call's evaluation
    // is in flight (e.g. a set_permission_mode control request processed by the pump mid-await) —
    // gated on a released promise so the timing is deterministic, never racy.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
    const ctxPromise = (async (): Promise<EvaluationContext> => {
      await gate;
      return baseCtx({ policy: snapshotBefore, promptStage: promptSpy.stage });
    })();

    const evalPromise = ctxPromise.then((ctx) => evaluate(call("Bash", { command: "curl https://x" }), ctx));
    store.setMode("dontAsk"); // bumps version 0 -> 1 WHILE the evaluation above is still pending
    release();
    const record = await evalPromise;

    expect(record.policyVersion).toBe(0); // stamped from the SNAPSHOT taken at evaluate() start
    expect(store.getState().version).toBe(1); // the live store has already moved on
    // The caller (engine.ts) is the one that compares these two and re-evaluates on a mismatch —
    // this fixture only pins the PRIMITIVE the re-evaluation loop depends on: a stale record must be
    // observably distinguishable from a fresh one by comparing policyVersion against the store's
    // CURRENT version. A true end-to-end engine race is not exercised here — see the report for why
    // (the window is not reachable from outside with instantaneous stub seams).
    expect(record.policyVersion).not.toBe(store.getState().version);
  });
});

// --- PolicyStateStore: setMode + bypassPermissions gating ------------------------------------------

describe("PolicyStateStore.setMode", () => {
  function store(gate: Partial<{ allowDangerouslySkipPermissions: boolean; disableBypassPermissionsMode: boolean }> = {}): PolicyStateStore {
    return new PolicyStateStore(
      { mode: "default", rules: emptyRuleSet() },
      { allowDangerouslySkipPermissions: false, disableBypassPermissionsMode: false, ...gate },
    );
  }

  test("an ordinary mode switch bumps the version by exactly 1 and carries no authority/managed guard", async () => {
    const s = store();
    expect(s.getState().version).toBe(0);
    const res = s.setMode("acceptEdits");
    expect(res).toEqual({ ok: true, effectiveMode: "acceptEdits" });
    expect(s.getState()).toMatchObject({ mode: "acceptEdits", version: 1 });
    // no authority parameter exists on setMode at all — ANY caller may switch mode (documented
    // decision: WS-07 pins no managed-mode-immutability text in scope for P2; see policy-state.ts).
    const res2 = s.setMode("plan");
    expect(res2.ok).toBe(true);
    expect(s.getState().version).toBe(2);
  });

  test("switching INTO bypassPermissions without allowDangerouslySkipPermissions is rejected, mode unchanged", () => {
    const s = store({ allowDangerouslySkipPermissions: false });
    const res = s.setMode("bypassPermissions");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("bypass_not_allowed");
    expect(s.getState()).toMatchObject({ mode: "default", version: 0 });
  });

  test("switching INTO bypassPermissions succeeds when allowDangerouslySkipPermissions is true", () => {
    const s = store({ allowDangerouslySkipPermissions: true });
    const res = s.setMode("bypassPermissions");
    expect(res).toEqual({ ok: true, effectiveMode: "bypassPermissions" });
    expect(s.getState()).toMatchObject({ mode: "bypassPermissions", version: 1 });
  });

  test("disableBypassPermissionsMode vetoes bypass even when allowDangerouslySkipPermissions is true", () => {
    const s = store({ allowDangerouslySkipPermissions: true, disableBypassPermissionsMode: true });
    const res = s.setMode("bypassPermissions");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("bypass_disabled");
  });

  test("constructing a PolicyStateStore already IN bypassPermissions is gated identically at startup", () => {
    expect(
      () => new PolicyStateStore({ mode: "bypassPermissions", rules: emptyRuleSet() }, { allowDangerouslySkipPermissions: false, disableBypassPermissionsMode: false }),
    ).toThrow(WinterPermissionError);
    expect(
      () => new PolicyStateStore({ mode: "bypassPermissions", rules: emptyRuleSet() }, { allowDangerouslySkipPermissions: true, disableBypassPermissionsMode: false }),
    ).not.toThrow();
    expect(
      () => new PolicyStateStore({ mode: "bypassPermissions", rules: emptyRuleSet() }, { allowDangerouslySkipPermissions: true, disableBypassPermissionsMode: true }),
    ).toThrow(WinterPermissionError);
  });
});

// --- PolicyStateStore: applyUpdate (rule mutation + the setMode-via-update door) --------------------

describe("PolicyStateStore.applyUpdate", () => {
  function store(gate: Partial<{ allowDangerouslySkipPermissions: boolean; disableBypassPermissionsMode: boolean }> = {}): PolicyStateStore {
    return new PolicyStateStore(
      { mode: "default", rules: emptyRuleSet() },
      { allowDangerouslySkipPermissions: false, disableBypassPermissionsMode: false, ...gate },
    );
  }

  test("addRules mutates the live rule set and bumps the version", () => {
    const s = store();
    const update: PermissionUpdate = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls *" }], behavior: "allow", destination: "session" };
    const res = s.applyUpdate(update, { authority: "session" });
    expect(res.ok).toBe(true);
    expect(s.getState().version).toBe(1);
    expect(s.getState().rules.entries).toHaveLength(1);
    expect(s.getState().mode).toBe("default"); // unrelated to mode
  });

  test("a `type: setMode` update routes through the SAME bypassPermissions gate as setMode() itself — the two-doors hazard", () => {
    const s = store({ allowDangerouslySkipPermissions: false });
    const update: PermissionUpdate = { type: "setMode", mode: "bypassPermissions", destination: "session" };
    const res = s.applyUpdate(update, { authority: "session" });
    expect(res.ok).toBe(false);
    // veto beats the flag: NEITHER the active mode NOR the rules' bookkeeping mode field changed —
    // no partial application.
    expect(s.getState()).toMatchObject({ mode: "default", version: 0 });
    expect(s.getState().rules.mode).toBeUndefined();
  });

  test("the SAME setMode-via-update succeeds once allowDangerouslySkipPermissions is true, and bumps version once", () => {
    const s = store({ allowDangerouslySkipPermissions: true });
    const update: PermissionUpdate = { type: "setMode", mode: "bypassPermissions", destination: "session" };
    const res = s.applyUpdate(update, { authority: "session" });
    expect(res.ok).toBe(true);
    expect(s.getState()).toMatchObject({ mode: "bypassPermissions", version: 1 });
  });
});

// --- assertKnownPermissionMode (Ruling 8: typed config error, not a parse failure) ------------------

describe("assertKnownPermissionMode", () => {
  test("undefined defaults to \"default\"", async () => {
    const { assertKnownPermissionMode } = await import("./policy-state.ts");
    expect(assertKnownPermissionMode(undefined)).toBe("default");
  });

  test("every one of the six public values round-trips unchanged", async () => {
    const { assertKnownPermissionMode } = await import("./policy-state.ts");
    const modes: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"];
    for (const m of modes) expect(assertKnownPermissionMode(m)).toBe(m);
  });

  test("an unrecognized value throws WinterPermissionError", async () => {
    const { assertKnownPermissionMode } = await import("./policy-state.ts");
    expect(() => assertKnownPermissionMode("not_a_real_mode")).toThrow(WinterPermissionError);
  });
});
