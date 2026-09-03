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
  probeReadAccess,
  findMatchingRuleEntry,
  NO_OPINION_HOOK_STAGE,
  NO_OPINION_PROMPT_STAGE,
  NO_OPINION_AUTO_ENGINE,
  NO_SPECIAL_CHECKS,
  REAL_SPECIAL_CHECKS,
  PLAN_WRITE_WITHHELD_MESSAGE,
  BLOCKED_BY_CLASSIFIER_MESSAGE,
  type EvaluationContext,
  type PermissionCall,
  type PromptStage,
  type PromptStageMeta,
  type PromptDecision,
  type HookStage,
  type HookDecision,
  type PermissionRequestHookDecision,
} from "./evaluator.ts";
import { PolicyStateStore, WinterPermissionError, type PolicyState } from "./policy-state.ts";
import { emptyRuleSet, resolveRules, sourceRule, type SourcedRuleEntry, type SourcedRuleSet } from "./ruleset.ts";
// Task 9 (WS-08 §4): the real hooks engine, for the "Task 9 -- the real hooks engine wired through
// createHookStage" describe block below — every OTHER fixture in this file uses spyHookStage to pin
// the seam contract in isolation; this is the one place the actual registry/reducer/runner run.
import { createHookStage } from "../hooks/hook-stage.ts";
import { buildHookRegistry, type SourcedHookEntry } from "../hooks/registry.ts";
import { runHooks, type HookInvoker, type HookAuditRecorder, type ToolInputValidator } from "../hooks/runner.ts";
// Task 12 (WS-07 §6.6/§10): the real AutoEngine, for the "Task 12 — auto mode arm" and "Task 12 —
// plan classifier borrow" describe blocks below — every OTHER fixture in this file uses the
// NO_OPINION_AUTO_ENGINE stub (always no_verdict) to pin the seam contract in isolation, exactly
// like NO_SPECIAL_CHECKS/NO_OPINION_PROMPT_STAGE/NO_OPINION_HOOK_STAGE's own precedent elsewhere in
// this file.
import { createAutoEngine, createScriptedClassifier } from "./auto/engine.ts";
import { AUTO_FALLBACK_CONSECUTIVE_THRESHOLD } from "./auto/caches.ts";

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

function spyHookStage(
  impl: (call: PermissionCall) => HookDecision,
  // T10: optional PermissionRequest opinion — every EXISTING caller of this helper is testing
  // stage-1 PreToolUse behavior only and never wants a PermissionRequest hook to answer in place of
  // the spied PromptStage, so the default (omitted) always returns null (no opinion, falls through
  // to promptStage.prompt exactly as before this task).
  permissionRequestImpl?: (call: PermissionCall, meta: PromptStageMeta) => PermissionRequestHookDecision | null,
): { stage: HookStage; calls: PermissionCall[] } {
  const calls: PermissionCall[] = [];
  return {
    calls,
    stage: {
      async preToolUse(c) {
        calls.push(c);
        return impl(c);
      },
      async permissionRequest(c, _ctx, meta) {
        return permissionRequestImpl ? permissionRequestImpl(c, meta) : null;
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

  // Fix round 1, item 4 (LOW — pin against future refactors): "allow" is advisory ONLY relative to
  // a downstream deny/ask/critical/protected/planWrite exception — the existing test above already
  // proves a downstream DENY RULE still wins over it; this proves the OTHER downstream stage a
  // hook-allow must never suppress: a matching ASK rule (stage 3) still forces the prompt path even
  // though stage 1 already said "allow".
  //
  // Finding 1 (P2 fix-wave, CRITICAL) supersedes this comment's ORIGINAL, stronger framing ("there
  // must be no early return anywhere in evaluate() for hookResult.decision === 'allow'") — that
  // framing was itself the bug WS-08 §3 flags: a hook allow now DOES resolve directly to
  // `{decision:"allow", mechanism:"hook"}` once stage 3's gate has cleared and no standing exception
  // (critical/protected/planWrite) applies (see evaluate()'s own new branch, right after stage 3).
  // This test's own scenario — a matching ASK rule — is exactly the case where that new branch is
  // never reached (the ask gate claims the call first, above), so it stays green, unchanged, under
  // the corrected (narrower) claim: no early return for hook-allow BEFORE stage 3 has had its say.
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

// --- Finding 1 (P2 fix-wave, CRITICAL): a PreToolUse hook 'allow' actually pre-approves -------------
//
// WS-08 §3's own table pins `allow` as "pre-approves — but does NOT override later deny rules, ask
// rules, interaction-required metadata, organization-required approval, or the critical-removal
// circuit breaker." Every fixture above this block (and T10-CARRY 1/Task 11's own hook-ask/hook-defer
// blocks) only ever tested the NON-OVERRIDE direction; nobody tested the PRE-APPROVAL direction
// itself — a hook allow that reaches this point (stage 2's deny rules already cleared, stage 3's
// ask/mandatory-interaction gate already cleared, no standing exception applies) must actually
// resolve the call, never silently fall through to a prompt/classifier/dontAsk-denial that a real
// canUseTool answer never gets a chance to prevent.
describe("Finding 1 (P2 fix-wave, CRITICAL): a PreToolUse hook 'allow' actually pre-approves once no standing exception applies", () => {
  test("dontAsk + hook allow + an unmatched, non-read-only tool call resolves to allow, mechanism 'hook' (WS-07 §6.3's verbatim 'Still permits' cell)", async () => {
    const ctx = baseCtx({
      hookStage: spyHookStage(() => ({ decision: "allow", hookId: "auto-approver" })).stage,
      policy: policy({ mode: "dontAsk" }),
    });
    const record = await evaluate(call("Bash", { command: "some-arbitrary-tool --flag" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "hook", hookId: "auto-approver" });
  });

  test("default + hook allow + zero rules: allow, without ever invoking canUseTool or a PermissionRequest hook", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" })); // would deny if ever reached -- proving it ISN'T
    let permissionRequestCalls = 0;
    const hook = spyHookStage(
      () => ({ decision: "allow" }),
      () => {
        permissionRequestCalls++;
        return null;
      },
    );
    const ctx = baseCtx({ hookStage: hook.stage, promptStage: promptSpy.stage, policy: policy({ mode: "default" }) });
    const record = await evaluate(call("Bash", { command: "some-arbitrary-tool" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "hook" });
    expect(promptSpy.calls.length).toBe(0);
    expect(permissionRequestCalls).toBe(0);
  });

  test("auto + hook allow: allow, without ever consulting the classifier", async () => {
    const scripted = createScriptedClassifier({ verdict: "deny" }); // would deny if consulted -- proving it ISN'T
    const ctx = baseCtx({
      hookStage: spyHookStage(() => ({ decision: "allow" })).stage,
      policy: policy({ mode: "auto" }),
      autoEngine: createAutoEngine({ sessionId: "s1", classifier: scripted }),
    });
    const record = await evaluate(call("Bash", { command: "some-arbitrary-tool" }), ctx);
    expect(scripted.calls.length).toBe(0);
    expect(record).toMatchObject({ decision: "allow", mechanism: "hook" });
  });

  test("keep-green: a hook allow does not clear a protected-path write — the ordinary mode-cell outcome still applies, never a silent allow", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({
      hookStage: spyHookStage(() => ({ decision: "allow" })).stage,
      promptStage: promptSpy.stage,
      policy: policy({ mode: "default" }),
      specialChecks: REAL_SPECIAL_CHECKS,
    });
    const record = await evaluate(call("Edit", { file_path: "/work/.git/config" }), ctx);
    expect(promptSpy.calls.length).toBe(1); // still reaches canUseTool, per the ordinary protected-write matrix (Task 7)
    expect(record.decision).toBe("deny");
  });

  test("keep-green: plan mode + hook allow + a write is still withheld unconditionally (§6.5)", async () => {
    const ctx = baseCtx({
      hookStage: spyHookStage(() => ({ decision: "allow" })).stage,
      policy: policy({ mode: "plan" }),
    });
    const record = await evaluate(call("Edit", { file_path: "/work/src/index.ts" }), ctx);
    expect(record).toMatchObject({ decision: "deny", mechanism: "mode", message: PLAN_WRITE_WITHHELD_MESSAGE });
  });
});

// --- T10-CARRY 1 (WS-08 §3): a PreToolUse hook's "ask" forces the interactive path -----------------

describe("T10-CARRY 1: a PreToolUse hook 'ask' forces stage 3's prompt path", () => {
  test("hook ask (no rule) reaches promptStage with no matchedAskRule, and a real answer resolves normally", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
    const ctx = baseCtx({
      hookStage: spyHookStage(() => ({ decision: "ask", hookId: "h1", message: "please review" })).stage,
      promptStage: promptSpy.stage,
    });
    const record = await evaluate(call("Bash", { command: "curl evil.example" }), ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(promptSpy.calls[0]!.meta.matchedAskRule).toBeUndefined();
    expect(promptSpy.calls[0]!.meta.decisionReason).toBe("please review");
    expect(record.decision).toBe("allow");
    expect(record.mechanism).toBe("canUseTool");
  });

  test("a stage-2 deny rule still wins over a hook-forced ask (deny > ask, WS-08 §4 rank order one level up)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
    const ctx = baseCtx({
      hookStage: spyHookStage(() => ({ decision: "ask", hookId: "h1" })).stage,
      promptStage: promptSpy.stage,
      policy: policy({ rules: withRules(rule("Bash(curl *)", "deny")) }),
    });
    const record = await evaluate(call("Bash", { command: "curl evil.example" }), ctx);
    expect(promptSpy.calls.length).toBe(0); // never reached — stage 2 already returned
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("rule");
  });

  test("dontAsk converts a hook-forced ask into denial (mechanism 'hook'), never invoking canUseTool", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
    const ctx = baseCtx({
      hookStage: spyHookStage(() => ({ decision: "ask", hookId: "h1", message: "needs review" })).stage,
      promptStage: promptSpy.stage,
      policy: policy({ mode: "dontAsk" }),
    });
    const record = await evaluate(call("Bash", { command: "curl evil.example" }), ctx);
    expect(promptSpy.calls.length).toBe(0);
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("hook");
    expect(record.hookId).toBe("h1");
    expect(record.message).toBe("needs review");
  });

  test("a null prompt answer to a hook-forced ask fails closed (mechanism 'hook', never implicitly allowed)", async () => {
    const ctx = baseCtx({
      hookStage: spyHookStage(() => ({ decision: "ask", hookId: "h1" })).stage,
      promptStage: NO_OPINION_PROMPT_STAGE, // always returns null
    });
    const record = await evaluate(call("Bash", { command: "curl evil.example" }), ctx);
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("hook");
    expect(record.hookId).toBe("h1");
    expect(record.message).toMatch(/no prompt handler answered/i);
  });

  test("a hook-forced ask still carries the hook's own transformedInput into the prompt call and the final record", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
    const ctx = baseCtx({
      hookStage: spyHookStage(() => ({ decision: "ask", hookId: "h1", transformedInput: { command: "curl safe.example" } })).stage,
      promptStage: promptSpy.stage,
    });
    const record = await evaluate(call("Bash", { command: "curl evil.example" }), ctx);
    expect(promptSpy.calls[0]!.call.input).toEqual({ command: "curl safe.example" });
    expect(record.transformedInput).toEqual({ command: "curl safe.example" });
  });

  test("bypassPermissions does not exempt a hook-forced ask (it must still prompt, unlike an ordinary unmatched action)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny", message: "still asked under bypass" }));
    const ctx = baseCtx({
      hookStage: spyHookStage(() => ({ decision: "ask", hookId: "h1" })).stage,
      promptStage: promptSpy.stage,
      policy: policy({ mode: "bypassPermissions" }),
    });
    const record = await evaluate(call("Bash", { command: "curl evil.example" }), ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(record.decision).toBe("deny");
    expect(record.message).toBe("still asked under bypass");
  });
});

// --- Task 11 (WS-08 §7): a PreToolUse hook 'defer' resolves between stage 2 and stage 3 -------------
//
// Mirrors the T10-CARRY 1 "ask" block above fixture-for-fixture (deny-rule precedence, dontAsk
// conversion, bypass non-exemption, transform carry) plus two fixtures unique to defer: it never
// reaches promptStage at all (a genuinely different resolution, not a shared interactive path), and
// it outranks a matched ask rule (WS-08 §4's rank table generalized one level up this pipeline —
// evaluator.ts's own comment at this branch).
describe("Task 11: a PreToolUse hook 'defer' resolves before stage 3, never reaching promptStage", () => {
  test("hook defer (no rule) resolves directly to decision 'defer', mechanism 'hook' -- promptStage never invoked", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
    const ctx = baseCtx({
      hookStage: spyHookStage(() => ({ decision: "defer", hookId: "h1", message: "needs durable approval" })).stage,
      promptStage: promptSpy.stage,
    });
    const record = await evaluate(call("Bash", { command: "long-running-thing" }), ctx);
    expect(promptSpy.calls.length).toBe(0);
    expect(record.decision).toBe("defer");
    expect(record.mechanism).toBe("hook");
    expect(record.hookId).toBe("h1");
    expect(record.message).toBe("needs durable approval");
  });

  test("a stage-2 deny rule still wins over a hook-forced defer (deny > defer, WS-08 §4 rank order one level up)", async () => {
    const ctx = baseCtx({
      hookStage: spyHookStage(() => ({ decision: "defer", hookId: "h1" })).stage,
      policy: policy({ rules: withRules(rule("Bash(long-running-thing)", "deny")) }),
    });
    const record = await evaluate(call("Bash", { command: "long-running-thing" }), ctx);
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("rule");
  });

  test("a hook-forced defer OUTRANKS a matched ask rule -- resolves to 'defer', never reaching the prompt path", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
    const ctx = baseCtx({
      hookStage: spyHookStage(() => ({ decision: "defer", hookId: "h1" })).stage,
      promptStage: promptSpy.stage,
      policy: policy({ rules: withRules(rule("Bash(long-running-thing)", "ask")) }),
    });
    const record = await evaluate(call("Bash", { command: "long-running-thing" }), ctx);
    expect(promptSpy.calls.length).toBe(0);
    expect(record.decision).toBe("defer");
    expect(record.mechanism).toBe("hook");
  });

  test("dontAsk converts a hook-forced defer into an immediate denial (mechanism 'hook'), never parking it", async () => {
    const ctx = baseCtx({
      hookStage: spyHookStage(() => ({ decision: "defer", hookId: "h1", message: "needs durable approval" })).stage,
      policy: policy({ mode: "dontAsk" }),
    });
    const record = await evaluate(call("Bash", { command: "long-running-thing" }), ctx);
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("hook");
    expect(record.hookId).toBe("h1");
    expect(record.message).toBe("needs durable approval");
  });

  test("dontAsk supplies its own message when the hook gave none", async () => {
    const ctx = baseCtx({
      hookStage: spyHookStage(() => ({ decision: "defer", hookId: "h1" })).stage,
      policy: policy({ mode: "dontAsk" }),
    });
    const record = await evaluate(call("Bash", { command: "long-running-thing" }), ctx);
    expect(record.decision).toBe("deny");
    expect(record.message).toMatch(/dontAsk mode denies/i);
  });

  test("bypassPermissions does not exempt a hook-forced defer (it must still park, unlike an ordinary unmatched action)", async () => {
    const ctx = baseCtx({
      hookStage: spyHookStage(() => ({ decision: "defer", hookId: "h1" })).stage,
      policy: policy({ mode: "bypassPermissions" }),
    });
    const record = await evaluate(call("Bash", { command: "long-running-thing" }), ctx);
    expect(record.decision).toBe("defer");
    expect(record.mechanism).toBe("hook");
  });

  test("a hook-forced defer carries the hook's own transformedInput into the final record", async () => {
    const ctx = baseCtx({
      hookStage: spyHookStage(() => ({ decision: "defer", hookId: "h1", transformedInput: { command: "sanitized-long-running-thing" } })).stage,
    });
    const record = await evaluate(call("Bash", { command: "long-running-thing" }), ctx);
    expect(record.decision).toBe("defer");
    expect(record.transformedInput).toEqual({ command: "sanitized-long-running-thing" });
  });
});

// --- T10 (WS-08 §6): PermissionRequest answers in place of canUseTool, at all three prompt sites ---
//
// One decision record, two mechanisms: PermissionRequest's answer and canUseTool's answer normalize
// into the IDENTICAL PermissionDecisionRecord shape (T6's own cross-task pin) with `mechanism`
// preserved ("hook" vs "canUseTool") — the tests below prove both directions: a non-null
// PermissionRequest answer takes canUseTool's place ENTIRELY (canUseTool/promptStage never called),
// and a null answer (no hook opinion) falls through to the SAME promptStage call site exactly as
// before this task, unchanged, mechanism "canUseTool".
describe("T10: PermissionRequest fires before every promptStage.prompt() call site and can answer in place of canUseTool", () => {
  test("stage 6 (generic unmatched action): a PermissionRequest hook 'allow' answers in place of canUseTool -- canUseTool never invoked", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny", message: "canUseTool should never see this" }));
    const ctx = baseCtx({
      hookStage: spyHookStage(
        () => ({ decision: "no_opinion" }),
        () => ({ decision: "allow", hookId: "pr-1" }),
      ).stage,
      promptStage: promptSpy.stage,
    });
    const record = await evaluate(call("Bash", { command: "curl example.com" }), ctx);
    expect(promptSpy.calls.length).toBe(0);
    expect(record.decision).toBe("allow");
    expect(record.mechanism).toBe("hook");
    expect(record.hookId).toBe("pr-1");
  });

  test("stage 6: a PermissionRequest hook 'deny' answers in place of canUseTool, carrying message/interrupt/hookId", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
    const ctx = baseCtx({
      hookStage: spyHookStage(
        () => ({ decision: "no_opinion" }),
        () => ({ decision: "deny", hookId: "pr-1", message: "hook says no", interrupt: true }),
      ).stage,
      promptStage: promptSpy.stage,
    });
    const record = await evaluate(call("Bash", { command: "curl example.com" }), ctx);
    expect(promptSpy.calls.length).toBe(0);
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("hook");
    expect(record.hookId).toBe("pr-1");
    expect(record.message).toBe("hook says no");
    expect(record.interrupt).toBe(true);
  });

  test("stage 6: a PermissionRequest hook returning null (no opinion) falls through to the REAL promptStage/canUseTool, mechanism 'canUseTool' -- the SAME record shape as the hook-answered case, just a different mechanism", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
    const ctx = baseCtx({
      hookStage: spyHookStage(
        () => ({ decision: "no_opinion" }),
        () => null,
      ).stage,
      promptStage: promptSpy.stage,
    });
    const record = await evaluate(call("Bash", { command: "curl example.com" }), ctx);
    expect(promptSpy.calls.length).toBe(1); // canUseTool WAS reached this time
    expect(record.decision).toBe("allow");
    expect(record.mechanism).toBe("canUseTool");
  });

  test("stage 3 (matched ask rule): a PermissionRequest hook answers in place of canUseTool -- the ask rule forced the prompt, the HOOK answered it", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny", message: "canUseTool should never see this" }));
    const ctx = baseCtx({
      hookStage: spyHookStage(
        () => ({ decision: "no_opinion" }),
        (_call, meta) => {
          // The ask rule's own matchedAskRule metadata is still visible to the PermissionRequest
          // hook via `meta` (same object the real promptStage.prompt call would have received).
          expect(meta.matchedAskRule).toEqual({ source: "sdk", toolName: "Bash", ruleContent: "git push" });
          return { decision: "allow", hookId: "pr-1" };
        },
      ).stage,
      promptStage: promptSpy.stage,
      policy: policy({ rules: withRules(rule("Bash(git push)", "ask")) }),
    });
    const record = await evaluate(call("Bash", { command: "git push" }), ctx);
    expect(promptSpy.calls.length).toBe(0);
    expect(record.decision).toBe("allow");
    expect(record.mechanism).toBe("hook");
  });

  test("the mustPrompt standing-exception site (critical removal): a PermissionRequest hook answers in place of canUseTool", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny", message: "canUseTool should never see this" }));
    const ctx = baseCtx({
      specialChecks: { isProtectedWrite: () => false, isCriticalRemoval: () => ({ critical: true, reason: "targets a filesystem root" }) },
      hookStage: spyHookStage(
        () => ({ decision: "no_opinion" }),
        () => ({ decision: "deny", hookId: "pr-1", message: "critical removal denied by hook" }),
      ).stage,
      promptStage: promptSpy.stage,
    });
    const record = await evaluate(call("Bash", { command: "rm -rf /" }), ctx);
    expect(promptSpy.calls.length).toBe(0);
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("hook");
    expect(record.message).toBe("critical removal denied by hook");
  });

  test("a PermissionRequest allow's updatedInput/updatedPermissions surface on the record exactly like canUseTool's own (WS-07 §7.2's shape, reused)", async () => {
    const suggestion: PermissionUpdate[] = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "curl *" }], behavior: "allow", destination: "session" }];
    const ctx = baseCtx({
      hookStage: spyHookStage(
        () => ({ decision: "no_opinion" }),
        () => ({ decision: "allow", hookId: "pr-1", transformedInput: { command: "curl safe.example" }, updatedPermissions: suggestion }),
      ).stage,
      promptStage: NO_OPINION_PROMPT_STAGE,
    });
    const record = await evaluate(call("Bash", { command: "curl example.com" }), ctx);
    expect(record.decision).toBe("allow");
    expect(record.mechanism).toBe("hook");
    expect(record.transformedInput).toEqual({ command: "curl safe.example" });
    expect(record.updatedPermissions).toEqual(suggestion);
  });

  test("stale-policy-during-hook-RPC: the SAME re-evaluation loop that already covers canUseTool also covers a PermissionRequest hook -- a policy change mid-flight is caught by the CALLER re-deriving policyVersion, not by anything new here", async () => {
    // This proves the structural claim, not a new mechanism: evaluate()'s own `policyVersion` is
    // stamped from `ctx.policy.version` at the TOP of the function (before stage 1 even runs) --
    // engine.ts's evaluateWithFreshPolicy (untouched by this task) already re-evaluates whenever the
    // returned record's policyVersion no longer matches the live store, uniformly regardless of
    // WHICH stage/mechanism produced the record. A PermissionRequest-answered record is exactly as
    // stale-checkable as a canUseTool-answered one, since both stamp policyVersion the identical way.
    let currentVersion = 1;
    const ctx = baseCtx({
      policy: policy({ version: 1 }),
      hookStage: spyHookStage(
        () => ({ decision: "no_opinion" }),
        () => {
          currentVersion = 2; // simulates a concurrent set_permission_mode landing WHILE this hook RPC is in flight
          return { decision: "allow", hookId: "pr-1" };
        },
      ).stage,
      promptStage: NO_OPINION_PROMPT_STAGE,
    });
    const record = await evaluate(call("Bash", { command: "curl example.com" }), ctx);
    expect(record.policyVersion).toBe(1); // stamped from the snapshot at evaluation START
    expect(record.policyVersion).not.toBe(currentVersion); // the caller (engine.ts) is what detects this mismatch and re-evaluates
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

  // Item 8(c) (P2 fix-wave): runner.test.ts already pins the UNIT-level contract ("a rejecting
  // validator double turns an invalid transform into that hook's contract error -- the ORIGINAL
  // input proceeds"); this is the same scenario's INTEGRATION re-verification at the real evaluator
  // level -- proving the void-both-decision-and-transform contract actually reaches evaluate()'s own
  // stage order, not merely runner.ts's own composite.
  test("Item 8(c): an invalid transform (schema-rejected updatedInput) is that hook's own contract error at the REAL evaluator level -- the ORIGINAL input proceeds untouched, the rejected transform never applies", async () => {
    const registry = buildHookRegistry([preToolUseEntry("h1")]);
    const rejecting: ToolInputValidator = { validate: () => ({ valid: false, reason: "does not match tool schema" }) };
    const invoker = fixedInvoker({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "rm -rf x" } } });
    const ctx = baseCtx({
      hookStage: createHookStage({ registry, invoker, audit: noopAudit(), sessionId: "s1", validator: rejecting }),
      policy: policy({ mode: "default", rules: withRules(rule("Bash(rm *)", "deny")) }),
    });
    const record = await evaluate(call("Bash", { command: "some-arbitrary-tool" }), ctx);
    // The hook's own "allow" decision is voided ALONG WITH its rejected transform (runner.ts's own
    // interpretPreToolUse returns {kind:"error"} for the WHOLE output the instant the transform
    // fails validation -- WS-07 §10.6-2 / WS-08 §3: "no decision, no transform survives"). evaluate()
    // therefore proceeds exactly as if the hook had said nothing: the deny rule never even sees the
    // rejected "rm -rf x" text (it never applied), and the ORIGINAL, unrecognized
    // "some-arbitrary-tool" command falls through to the generic bottom-of-pipeline fallback
    // (Ruling P2-I) -- denied, mechanism "mode", never "rule".
    expect(record.transformedInput).toBeUndefined();
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("mode");
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

// --- Task 8 (P3 close-out, RULING P3-J): a Bash call requesting dangerouslyDisableSandbox is
// mandatory interaction, structurally identical to AskUserQuestion above (WS-12 §4/§11: "the call is
// always surfaced for approval, under every policy, and no permission rule may silence it").
describe("Task 8 — RULING P3-J: Bash dangerouslyDisableSandbox as mandatory interaction (WS-12 §4/§11)", () => {
  const overrideCall = call("Bash", { command: "rm -rf /tmp/whatever", dangerouslyDisableSandbox: true });

  for (const mode of ["default", "acceptEdits", "auto", "bypassPermissions"] as const) {
    test(`mode=${mode}: the override reaches the prompt stage even with a BARE Bash(*) allow rule present — never rule-silenced, never auto-approved by acceptEdits/auto, spec-literal "under every policy" including bypass`, async () => {
      const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
      const ctx = baseCtx({
        promptStage: promptSpy.stage,
        policy: policy({ mode, rules: withRules(rule("Bash(*)", "allow")) }), // a maximally broad allow rule must not shadow this
        specialChecks: REAL_SPECIAL_CHECKS,
        sessionBypassEnabled: mode === "bypassPermissions",
      });
      const record = await evaluate(overrideCall, ctx);
      expect(promptSpy.calls.length).toBe(1);
      expect(record.mechanism).toBe("canUseTool");
      expect(record.decision).toBe("allow");
    });
  }

  test("dontAsk: the override is denied outright, the prompt stage is NEVER invoked", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode: "dontAsk", rules: withRules(rule("Bash(*)", "allow")) }) });
    const record = await evaluate(overrideCall, ctx);
    expect(promptSpy.calls.length).toBe(0);
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("mode");
    expect(record.message).toContain("dangerouslyDisableSandbox");
  });

  test("no answering host (no-opinion prompt stage) fails CLOSED — never implicitly allowed", async () => {
    const ctx = baseCtx({ policy: policy({ mode: "default" }) }); // NO_OPINION_PROMPT_STAGE
    const record = await evaluate(overrideCall, ctx);
    expect(record.decision).toBe("deny");
    expect(record.message).toContain("dangerouslyDisableSandbox");
  });

  test("a deny rule targeting Bash still wins outright (stage 2 runs before stage 3's mandatory interaction)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      policy: policy({ mode: "default", rules: withRules(rule("Bash(*)", "deny")) }),
    });
    const record = await evaluate(overrideCall, ctx);
    expect(promptSpy.calls.length).toBe(0);
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("rule");
  });

  test("decisionReason names the mandatory interaction explicitly (transcript legibility)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode: "default" }) });
    await evaluate(overrideCall, ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(promptSpy.calls[0]!.meta.matchedAskRule).toBeUndefined(); // no rule forced this -- the call's own input shape did
    expect(promptSpy.calls[0]!.meta.decisionReason).toContain("dangerouslyDisableSandbox");
  });

  test("an ordinary Bash call (no dangerouslyDisableSandbox) is completely unaffected — the mandatory-interaction gate is keyed on the input flag, not the tool name alone", async () => {
    const ctx = baseCtx({ policy: policy({ mode: "default" }) });
    const record = await evaluate(call("Bash", { command: "ls" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" }); // recognized read-only, unaffected
  });

  test("dangerouslyDisableSandbox: false is NOT mandatory interaction (only === true triggers it, matching the pinned boolean-flag semantics)", async () => {
    const ctx = baseCtx({ policy: policy({ mode: "default" }) });
    const record = await evaluate(call("Bash", { command: "ls", dangerouslyDisableSandbox: false }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  // "the result's override state stays recorded regardless of outcome" (WS-12 §4) — the ALLOWED
  // branch here proves the override flag survives evaluate() into `updatedInput`/the executed call
  // unchanged (no PreToolUse/canUseTool transform touched it), which is what lets bash.ts's own
  // executor (tools/impl/bash.ts, already fixed by Lane C's own fix round 1 item 3 --
  // formatSandboxAnnotation) still see and report it once the call actually runs; this evaluator
  // layer has no tool-result surface of its own to assert against directly.
  test("a real prompt-approved override carries the flag through to the effective/transformed call untouched, when the host does not itself transform it", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode: "default" }) });
    await evaluate(overrideCall, ctx);
    expect(promptSpy.calls[0]!.call.input["dangerouslyDisableSandbox"]).toBe(true);
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

describe("acceptEdits/plan — the shared baseline invariant (T6 origin; still true after T7's real acceptEdits/plan semantics land below)", () => {
  // Task 7: acceptEdits/plan get REAL semantics in their own describe blocks further down. This
  // block is retained (not deleted) because BOTH assertions below still hold true under the real
  // implementation — an out-of-root Edit is still not auto-approved by acceptEdits (WS-07 §2's
  // standing-exceptions list doesn't cover "acceptEdits out-of-root", so it falls through to the
  // ordinary pipeline exactly like `default`'s own unmatched-Edit case; plan withholds the SAME
  // Edit via its own mustPrompt path, which ALSO still calls promptStage before falling back —
  // see evaluateModeStage's own comments) and `pwd` is still built-in-read-only in every mode. A
  // future replacement of either invariant is therefore still a deliberate, reviewed diff here, not
  // a silent regression — exactly the property this block existed to protect under T6.
  //
  // Task 12: `auto` is DELIBERATELY REMOVED from this loop's first test — see the dedicated "Task
  // 12 — auto mode arm" describe block below for its own (now real) out-of-root-Edit behavior: an
  // out-of-root Edit is not built-in-read-only/bounded-edit at stage 4, not rescued by any allow
  // rule at stage 5 (none configured here), so it now reaches ctx.autoEngine.classify() — with the
  // default NO_OPINION_AUTO_ENGINE returning no_verdict, the call fails closed WITHOUT ever
  // reaching promptStage at all (mechanism "autoEngine", not "mode"), unlike acceptEdits/plan. The
  // read-only invariant (this block's second test) is UNCHANGED for `auto` — see that same describe
  // block for its own dedicated coverage.
  for (const mode of ["acceptEdits", "plan"] as const) {
    test(`mode=${mode}: never auto-approves MORE than default would (an ordinary out-of-root Edit still reaches the prompt stage)`, async () => {
      const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
      const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode }) });
      const record = await evaluate(call("Edit", { file_path: "/etc/x" }), ctx);
      expect(promptSpy.calls.length).toBe(1);
      expect(record.decision).toBe("deny");
    });
  }

  for (const mode of ["acceptEdits", "plan", "auto"] as const) {
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

// Finding 7 (P2 fix-wave, MINOR): WS-07 §6.1's "Reads within working OR ADDITIONAL directories ...
// run without prompting" — isReadWithinBounds (evaluator.ts, renamed from isReadWithinCwd) now
// reuses isWithinBounds instead of hard-coding `cwd: ctx.cwd`, closing the asymmetry against
// acceptEdits' own edit-bounding (which already honored the identical grant).
describe("Finding 7 (P2 fix-wave): Reads inside an addDirectories/additionalDirectories grant run without prompting, in every built-in-read-only mode", () => {
  test("default mode + an addDirectories rule grant (session-sourced, no trust needed) + a Read inside it -> allow, mechanism 'mode'", async () => {
    const ctx = baseCtx({
      policy: policy({
        mode: "default",
        rules: { ...emptyRuleSet(), directories: [{ path: "/rule-granted", source: "session" }] },
      }),
    });
    const record = await evaluate(call("Read", { file_path: "/rule-granted/notes.txt" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  test("dontAsk mode + ctx.additionalDirectories (direct config field, Finding 6) + a Read inside it -> allow, mechanism 'mode', canUseTool never invoked", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" })); // would deny if ever reached -- proving it ISN'T
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      policy: policy({ mode: "dontAsk" }),
      additionalDirectories: ["/extra/grant"],
    });
    const record = await evaluate(call("Read", { file_path: "/extra/grant/notes.txt" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
    expect(promptSpy.calls.length).toBe(0);
  });

  test("an UNTRUSTED project-sourced directory grant is inert for Reads too (effectiveDirectories' own trust gate, unaffected by this fix)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      trustedWorkspace: false,
      policy: policy({
        mode: "default",
        rules: { ...emptyRuleSet(), directories: [{ path: "/rule-granted", source: "project" }] },
      }),
    });
    const record = await evaluate(call("Read", { file_path: "/rule-granted/notes.txt" }), ctx);
    expect(promptSpy.calls.length).toBe(1); // never auto-approved via the untrusted grant
  });

  test("a Read outside every granted directory (and outside cwd) is unaffected -- still falls through to the ordinary pipeline", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      policy: policy({ mode: "default" }),
      additionalDirectories: ["/extra/grant"],
    });
    const record = await evaluate(call("Read", { file_path: "/somewhere/else/notes.txt" }), ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(record.decision).toBe("deny");
  });

  test("Ruling P2-J preserved: a symlink INSIDE a granted directory whose target resolves OUTSIDE every root is NOT routine-read-only -- still prompts", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-evaluator-f7-symlink-")));
    const grantedDir = join(root, "granted");
    mkdirSync(grantedDir);
    try {
      const outsideFile = join(root, "outside-secret.txt");
      writeFileSync(outsideFile, "secret");
      const linkPath = join(grantedDir, "escape-link"); // sits INSIDE the grant, resolves OUTSIDE every root
      symlinkSync(outsideFile, linkPath);

      const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
      const ctx = baseCtx({
        promptStage: promptSpy.stage,
        cwd: join(root, "unrelated-cwd"),
        policy: policy({ mode: "default" }),
        additionalDirectories: [grantedDir],
      });
      const record = await evaluate(call("Read", { file_path: linkPath }), ctx);
      // If this regressed to a plain (non-symlink-aware) cwd/bounds check, this would resolve
      // {decision:"allow", mechanism:"mode"} WITHOUT ever calling promptStage.
      expect(promptSpy.calls.length).toBe(1);
      expect(record.mechanism).toBe("canUseTool");

      // An ORDINARY (non-symlink) file actually inside the grant is unaffected.
      const ordinary = join(grantedDir, "ordinary.txt");
      writeFileSync(ordinary, "fine");
      const ordinaryRecord = await evaluate(call("Read", { file_path: ordinary }), ctx);
      expect(ordinaryRecord).toMatchObject({ decision: "allow", mechanism: "mode" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  test("plan (no session bypass): prompt -- the Task 12 classifier borrow is attempted (real wiring) but the default NO_OPINION_AUTO_ENGINE answers no_verdict, so it falls through to the identical pre-existing prompt path unchanged (see the dedicated 'Task 12 — plan classifier borrow' describe block below for the borrow's OWN wiring+outcome fixtures)", async () => {
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

  test("auto (Task 12, default NO_OPINION_AUTO_ENGINE): routes to the classifier, never canUseTool -- fails closed with the stable 'Blocked by classifier' string", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" })); // even if it WOULD allow, `auto`'s protected-write cell is "classifier", never canUseTool
    const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode: "auto" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(protectedCall, ctx);
    expect(promptSpy.calls.length).toBe(0);
    expect(record).toMatchObject({ decision: "deny", mechanism: "autoEngine", message: BLOCKED_BY_CLASSIFIER_MESSAGE });
  });

  test("auto with a scripted classifier ALLOW: the classifier genuinely gets consulted for a protected write (WS-07 §6.7's 'auto: classifier' cell)", async () => {
    const scripted = createScriptedClassifier({ verdict: "allow" });
    const autoEngine = createAutoEngine({ sessionId: "s1", classifier: scripted });
    const ctx = baseCtx({ policy: policy({ mode: "auto" }), specialChecks: REAL_SPECIAL_CHECKS, autoEngine });
    const record = await evaluate(protectedCall, ctx);
    expect(scripted.calls.length).toBe(1);
    expect(record).toMatchObject({ decision: "allow", mechanism: "autoEngine" });
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
      // Task 12: `auto` now routes to the classifier (mechanism "autoEngine"), never canUseTool --
      // 0 prompt calls, not 1, with the default NO_OPINION_AUTO_ENGINE (no_verdict -> fail closed).
      { mode: "auto", expectPromptCalls: 0, expectDecision: "deny" },
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

  for (const mode of ["default", "acceptEdits", "bypassPermissions", "plan"] as const) {
    test(`${mode}: never silently allowed — reaches the prompt stage, fails closed absent a real answer`, async () => {
      const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
      const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode }), specialChecks: REAL_SPECIAL_CHECKS });
      const record = await evaluate(criticalCall, ctx);
      expect(promptSpy.calls.length).toBe(1);
      expect(record.decision).toBe("deny");
    });
  }

  // Task 12: `auto` pulled out of the loop above -- §6.8's own "auto: classifier" cell routes to
  // ctx.autoEngine.classify(), never canUseTool (0 prompt calls, not 1), same shape as the §6.7
  // protected-write matrix's own dedicated auto tests above.
  test("auto: never silently allowed — reaches the classifier (never canUseTool), fails closed with the stable 'Blocked by classifier' string", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode: "auto" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(criticalCall, ctx);
    expect(promptSpy.calls.length).toBe(0);
    expect(record).toMatchObject({ decision: "deny", mechanism: "autoEngine", message: BLOCKED_BY_CLASSIFIER_MESSAGE });
  });

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

  test("Task 12 (WS-07 §6.8's own 'bypass unavailable' gate): plan + session bypass enabled NEVER even consults the classifier for critical removal, unlike plan without bypass", async () => {
    const scripted = createScriptedClassifier({ verdict: "allow" }); // would allow if consulted -- proving it ISN'T
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      policy: policy({ mode: "plan" }),
      specialChecks: REAL_SPECIAL_CHECKS,
      sessionBypassEnabled: true,
      autoEngine: createAutoEngine({ sessionId: "s1", classifier: scripted }),
    });
    const record = await evaluate(criticalCall, ctx);
    expect(scripted.calls.length).toBe(0); // the classifier borrow is gated off entirely here
    expect(promptSpy.calls.length).toBe(1); // falls straight through to the ordinary prompt path
    expect(record.decision).toBe("deny");
  });

  test("T6-review obligation: a broad `Bash(rm *)` allow rule does NOT rescue a critical rm at stage 5, in EVERY mode — fix round 1, item 2: dontAsk and plan added, the loop now covers all six", async () => {
    const cases: Array<{ mode: PermissionMode; expectPromptCalls: number }> = [
      { mode: "default", expectPromptCalls: 1 },
      { mode: "acceptEdits", expectPromptCalls: 1 },
      { mode: "dontAsk", expectPromptCalls: 0 }, // canUseTool is NEVER called in dontAsk (WS-07 §6.3)
      { mode: "bypassPermissions", expectPromptCalls: 1 },
      { mode: "plan", expectPromptCalls: 1 },
      // Task 12: `auto` routes to the classifier, never canUseTool -- 0 prompt calls, not 1.
      { mode: "auto", expectPromptCalls: 0 },
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

// --- Task 12 (WS-07 §6.6/§10): the real AutoEngine seam fill -----------------------------------------

describe("Task 12 — auto mode arm: pipeline order (WS-07 §10.1 — deterministic deny/ask stay ahead of the classifier)", () => {
  test("a stage-2 deny rule wins outright -- the classifier is never even consulted", async () => {
    const scripted = createScriptedClassifier({ verdict: "allow" }); // would allow if consulted -- proving it ISN'T
    const ctx = baseCtx({
      policy: policy({ mode: "auto", rules: withRules(rule("Bash(rm -rf /)", "deny")) }),
      autoEngine: createAutoEngine({ sessionId: "s1", classifier: scripted }),
    });
    const record = await evaluate(call("Bash", { command: "rm -rf /" }), ctx);
    expect(scripted.calls.length).toBe(0);
    expect(record).toMatchObject({ decision: "deny", mechanism: "rule" });
  });

  test("a matched ask rule forces the prompt path -- the classifier is never consulted, even in `auto`", async () => {
    const scripted = createScriptedClassifier({ verdict: "allow" });
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      policy: policy({ mode: "auto", rules: withRules(rule("Bash(curl *)", "ask")) }),
      autoEngine: createAutoEngine({ sessionId: "s1", classifier: scripted }),
    });
    const record = await evaluate(call("Bash", { command: "curl https://example.com" }), ctx);
    expect(scripted.calls.length).toBe(0);
    expect(promptSpy.calls.length).toBe(1);
    expect(record.decision).toBe("deny");
  });
});

describe("Task 12 — auto mode arm: read-only + ordinary in-cwd edits skip the classifier entirely (WS-07 §10.1 step 4)", () => {
  test("a built-in read-only Bash command resolves via mode, never reaching the classifier", async () => {
    const scripted = createScriptedClassifier({ verdict: "deny" }); // would deny if consulted -- proving it ISN'T
    const ctx = baseCtx({ policy: policy({ mode: "auto" }), autoEngine: createAutoEngine({ sessionId: "s1", classifier: scripted }) });
    const record = await evaluate(call("Bash", { command: "pwd" }), ctx);
    expect(scripted.calls.length).toBe(0);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  test("an ordinary in-cwd Edit resolves via mode, never reaching the classifier", async () => {
    const scripted = createScriptedClassifier({ verdict: "deny" });
    const ctx = baseCtx({ cwd: "/work", policy: policy({ mode: "auto" }), autoEngine: createAutoEngine({ sessionId: "s1", classifier: scripted }) });
    const record = await evaluate(call("Edit", { file_path: "/work/src/a.ts" }), ctx);
    expect(scripted.calls.length).toBe(0);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  test("an in-cwd recognized Bash fs-op resolves via mode, never reaching the classifier", async () => {
    const scripted = createScriptedClassifier({ verdict: "deny" });
    const ctx = baseCtx({ cwd: "/work", policy: policy({ mode: "auto" }), autoEngine: createAutoEngine({ sessionId: "s1", classifier: scripted }) });
    const record = await evaluate(call("Bash", { command: "touch ./notes.txt" }), ctx);
    expect(scripted.calls.length).toBe(0);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  test("an OUT-OF-ROOT edit is NOT auto-approved -- it reaches the classifier", async () => {
    const scripted = createScriptedClassifier({ verdict: "allow" });
    const ctx = baseCtx({ cwd: "/work", policy: policy({ mode: "auto" }), autoEngine: createAutoEngine({ sessionId: "s1", classifier: scripted }) });
    const record = await evaluate(call("Edit", { file_path: "/etc/x" }), ctx);
    expect(scripted.calls.length).toBe(1);
    expect(record).toMatchObject({ decision: "allow", mechanism: "autoEngine" });
  });
});

describe("Task 12 — auto mode arm: broad-allow suspension at stage 5 (WS-07 §10.1 steps 2/3)", () => {
  test("a blanket Bash(*) allow does NOT rescue an arbitrary command -- suspended, reaches the classifier instead", async () => {
    const scripted = createScriptedClassifier({ verdict: "deny" });
    const ctx = baseCtx({
      policy: policy({ mode: "auto", rules: withRules(rule("Bash(*)", "allow")) }),
      autoEngine: createAutoEngine({ sessionId: "s1", classifier: scripted }),
    });
    const record = await evaluate(call("Bash", { command: "curl https://example.com" }), ctx);
    expect(scripted.calls.length).toBe(1);
    expect(record).toMatchObject({ decision: "deny", mechanism: "autoEngine" });
  });

  test("a NARROW shell allow (Bash(npm test)) survives -- resolves as a rule, classifier never consulted", async () => {
    const scripted = createScriptedClassifier({ verdict: "deny" });
    const ctx = baseCtx({
      policy: policy({ mode: "auto", rules: withRules(rule("Bash(npm test)", "allow")) }),
      autoEngine: createAutoEngine({ sessionId: "s1", classifier: scripted }),
    });
    const record = await evaluate(call("Bash", { command: "npm test" }), ctx);
    expect(scripted.calls.length).toBe(0);
    expect(record).toMatchObject({ decision: "allow", mechanism: "rule" });
  });

  test("REGRESSION: a blanket Bash(*) allow rule is NOT suspended outside auto mode -- resolves as a rule through the FULL evaluate() pipeline (closes the 'suspension fixtured both ways' gap: the prior Bash(*) fixtures either called isAutoSuspendedAllowRule directly, bypassing evaluate() entirely, or only ever exercised auto mode)", async () => {
    const ctx = baseCtx({ policy: policy({ mode: "default", rules: withRules(rule("Bash(*)", "allow")) }) });
    const record = await evaluate(call("Bash", { command: "curl https://example.com" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "rule" });
  });

  test("classifyAllShell: true suspends even the narrow survivor above -- now reaches the classifier", async () => {
    const scripted = createScriptedClassifier({ verdict: "allow" });
    const ctx = baseCtx({
      policy: policy({ mode: "auto", rules: withRules(rule("Bash(npm test)", "allow")), autoConfig: { classifyAllShell: true } }),
      autoEngine: createAutoEngine({ sessionId: "s1", classifier: scripted }),
    });
    const record = await evaluate(call("Bash", { command: "npm test" }), ctx);
    expect(scripted.calls.length).toBe(1);
    expect(record).toMatchObject({ decision: "allow", mechanism: "autoEngine" });
  });

  test("an Agent allow rule is suspended regardless of specifier", async () => {
    const scripted = createScriptedClassifier({ verdict: "deny" });
    const ctx = baseCtx({
      policy: policy({ mode: "auto", rules: withRules(rule("Agent(Explore)", "allow")) }),
      autoEngine: createAutoEngine({ sessionId: "s1", classifier: scripted }),
    });
    const record = await evaluate(call("Agent", { subagent_type: "Explore", prompt: "x" }), ctx);
    expect(scripted.calls.length).toBe(1);
    expect(record.mechanism).not.toBe("rule");
  });

  test("a non-shell allow rule (Read) is UNAFFECTED by auto's suspension matcher -- still resolves as a rule", async () => {
    // /synthetic/... (not /etc -- a REAL macOS symlink to /private/etc, this file's own documented
    // landmine at its header) avoids a spurious allow-direction symlink mismatch.
    const ctx = baseCtx({
      cwd: "/work",
      policy: policy({ mode: "auto", rules: withRules(rule("Read(//synthetic/protected/**)", "allow")) }),
      specialChecks: REAL_SPECIAL_CHECKS,
    });
    const record = await evaluate(call("Read", { file_path: "/synthetic/protected/x" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "rule" });
  });
});

describe("Task 12 — auto mode arm: 3-consecutive/20-total fallback, end-to-end through evaluate() (WS-07 §10.5)", () => {
  test("3 consecutive classifier denies trip fallback; the next call routes to the SAME hook/canUseTool pathway, never the classifier again", async () => {
    const scripted = createScriptedClassifier({ verdict: "deny" });
    const autoEngine = createAutoEngine({ sessionId: "s1", classifier: scripted });
    const ctxFor = (promptStage: PromptStage) => baseCtx({ promptStage, policy: policy({ mode: "auto" }), autoEngine });
    for (let i = 0; i < AUTO_FALLBACK_CONSECUTIVE_THRESHOLD; i++) {
      const record = await evaluate(call("Bash", { command: `curl https://example.com/${i}` }), ctxFor(NO_OPINION_PROMPT_STAGE));
      expect(record.decision).toBe("deny");
    }
    expect(scripted.calls.length).toBe(AUTO_FALLBACK_CONSECUTIVE_THRESHOLD);

    const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
    const record = await evaluate(call("Bash", { command: "curl https://example.com/after" }), ctxFor(promptSpy.stage));
    expect(scripted.calls.length).toBe(AUTO_FALLBACK_CONSECUTIVE_THRESHOLD); // classifier never consulted again
    expect(promptSpy.calls.length).toBe(1); // routed to the ordinary prompt path instead
    expect(record).toMatchObject({ decision: "allow", mechanism: "canUseTool" }); // correct attribution: a HUMAN answered, not the classifier
  });

  test("headless during fallback (no prompt handler answers) -- denied and the run continues, never a hang", async () => {
    const scripted = createScriptedClassifier({ verdict: "deny" });
    const autoEngine = createAutoEngine({ sessionId: "s1", classifier: scripted });
    for (let i = 0; i < AUTO_FALLBACK_CONSECUTIVE_THRESHOLD; i++) {
      await evaluate(call("Bash", { command: `curl https://example.com/${i}` }), baseCtx({ policy: policy({ mode: "auto" }), autoEngine }));
    }
    const record = await evaluate(call("Bash", { command: "curl https://example.com/after" }), baseCtx({ policy: policy({ mode: "auto" }), autoEngine }));
    expect(record.decision).toBe("deny");
    expect(record.mechanism).toBe("autoEngine");
  });

  // Item 11 (P2 fix-wave): the SAME "headless during fallback" scenario above, now also proving the
  // audit gap is closed -- the real createAutoEngine's own noteHeadlessFallbackDenial seam method
  // (auto/engine.ts) fires exactly once, for the FINAL (headless-denied) call only, never for the
  // AUTO_FALLBACK_CONSECUTIVE_THRESHOLD calls that tripped the fallback in the first place (those
  // were genuine classifier denials, already separately audited via classify()'s own
  // "permission_denied" emission).
  test("Item 11: headless during fallback emits a permission_denied AUDIT record via the real AutoEngine seam, exactly once, for the headless call only", async () => {
    const auditRecords: Array<{ type: string; toolUseId?: string }> = [];
    const scripted = createScriptedClassifier({ verdict: "deny" });
    const autoEngine = createAutoEngine({
      sessionId: "s1",
      classifier: scripted,
      audit: { record: (entry) => void auditRecords.push(entry) },
    });
    for (let i = 0; i < AUTO_FALLBACK_CONSECUTIVE_THRESHOLD; i++) {
      await evaluate(call("Bash", { command: `curl https://example.com/${i}` }), baseCtx({ policy: policy({ mode: "auto" }), autoEngine }));
    }
    const headlessPermissionDeniedBefore = auditRecords.filter((r) => r.type === "permission_denied").length;

    const record = await evaluate({ toolName: "Bash", input: { command: "curl https://example.com/after" }, toolUseId: "headless-call" }, baseCtx({ policy: policy({ mode: "auto" }), autoEngine }));
    expect(record.decision).toBe("deny");

    const headlessPermissionDeniedRecords = auditRecords.filter((r) => r.type === "permission_denied").slice(headlessPermissionDeniedBefore);
    expect(headlessPermissionDeniedRecords).toHaveLength(1);
    expect(headlessPermissionDeniedRecords[0]!.toolUseId).toBe("headless-call");
  });
});

// --- Task 12 (WS-07 §6.5): plan mode's classifier borrow -- BOTH the wiring and the practical
// outcome are fixtured here. `useAutoModeDuringPlan` defaults to true (§6.5's own "current
// default"), so a scripted classifier proves the wiring is real; the default NO_OPINION_AUTO_ENGINE
// classifier (used everywhere else in this file's plan-mode fixtures, unchanged) proves the
// PRACTICAL P2 outcome is still "prompt" (a no_verdict falls through to the identical pre-existing
// hook/canUseTool path).

describe("Task 12 — plan classifier borrow: standing exceptions (WS-07 §6.7/§6.8's own plan rows)", () => {
  const protectedCall = call("Edit", { file_path: "/work/.git/config" });

  test("wiring: a scripted classifier ALLOW resolves a protected write in plan mode, without ever reaching canUseTool", async () => {
    const scripted = createScriptedClassifier({ verdict: "allow" });
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      policy: policy({ mode: "plan" }),
      specialChecks: REAL_SPECIAL_CHECKS,
      autoEngine: createAutoEngine({ sessionId: "s1", classifier: scripted }),
    });
    const record = await evaluate(protectedCall, ctx);
    expect(scripted.calls.length).toBe(1);
    expect(promptSpy.calls.length).toBe(0);
    expect(record).toMatchObject({ decision: "allow", mechanism: "autoEngine" });
  });

  test("wiring: a scripted classifier DENY resolves a protected write in plan mode with the stable classifier message, without reaching canUseTool", async () => {
    const scripted = createScriptedClassifier({ verdict: "deny" });
    const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      policy: policy({ mode: "plan" }),
      specialChecks: REAL_SPECIAL_CHECKS,
      autoEngine: createAutoEngine({ sessionId: "s1", classifier: scripted }),
    });
    const record = await evaluate(protectedCall, ctx);
    expect(scripted.calls.length).toBe(1);
    expect(promptSpy.calls.length).toBe(0);
    expect(record).toMatchObject({ decision: "deny", mechanism: "autoEngine", message: BLOCKED_BY_CLASSIFIER_MESSAGE });
  });

  test("practical outcome: a no_verdict from the classifier falls through to the IDENTICAL pre-existing prompt path, unchanged", async () => {
    const scripted = createScriptedClassifier({ verdict: "no_verdict" });
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      policy: policy({ mode: "plan" }),
      specialChecks: REAL_SPECIAL_CHECKS,
      autoEngine: createAutoEngine({ sessionId: "s1", classifier: scripted }),
    });
    const record = await evaluate(protectedCall, ctx);
    expect(scripted.calls.length).toBe(1); // the borrow WAS attempted (real wiring) ...
    expect(promptSpy.calls.length).toBe(1); // ... but fell through to the ordinary path (practical outcome)
    expect(record.decision).toBe("deny");
  });

  test("EXCLUSION: an ordinary plan-write-withheld Edit NEVER consults the classifier -- §6.5's borrow names 'exploratory commands', never writes", async () => {
    const scripted = createScriptedClassifier({ verdict: "allow" }); // would allow if consulted -- proving it ISN'T
    const promptSpy = spyPromptStage(() => null); // no real host answers -- the fallback synthesizes modeResult.message verbatim
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      policy: policy({ mode: "plan" }),
      autoEngine: createAutoEngine({ sessionId: "s1", classifier: scripted }),
    });
    const record = await evaluate(call("Edit", { file_path: "/work/src/a.ts" }), ctx);
    expect(scripted.calls.length).toBe(0); // the borrow was never even attempted
    expect(promptSpy.calls.length).toBe(1); // fell straight through to the ordinary (pre-Task-12) prompt path
    expect(record.message).toBe(PLAN_WRITE_WITHHELD_MESSAGE);
  });

  test("useAutoModeDuringPlan: false disables the borrow entirely -- the classifier is never consulted", async () => {
    const scripted = createScriptedClassifier({ verdict: "allow" });
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      policy: policy({ mode: "plan", autoConfig: { useAutoModeDuringPlan: false } }),
      specialChecks: REAL_SPECIAL_CHECKS,
      autoEngine: createAutoEngine({ sessionId: "s1", classifier: scripted }),
    });
    const record = await evaluate(protectedCall, ctx);
    expect(scripted.calls.length).toBe(0);
    expect(promptSpy.calls.length).toBe(1);
    expect(record.decision).toBe("deny");
  });
});

describe("Task 12 — plan classifier borrow: the exploratory-shell bucket (WS-07 §6.5's own stage-6 fallback)", () => {
  const exploratoryCall = call("Bash", { command: "curl https://example.com" }); // not read-only, not write-shaped

  test("wiring: a scripted classifier ALLOW resolves an exploratory shell command, without reaching canUseTool", async () => {
    const scripted = createScriptedClassifier({ verdict: "allow" });
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode: "plan" }), autoEngine: createAutoEngine({ sessionId: "s1", classifier: scripted }) });
    const record = await evaluate(exploratoryCall, ctx);
    expect(scripted.calls.length).toBe(1);
    expect(promptSpy.calls.length).toBe(0);
    expect(record).toMatchObject({ decision: "allow", mechanism: "autoEngine" });
  });

  test("wiring: a scripted classifier DENY resolves with the stable classifier message, without reaching canUseTool", async () => {
    const scripted = createScriptedClassifier({ verdict: "deny" });
    const promptSpy = spyPromptStage(() => ({ decision: "allow" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode: "plan" }), autoEngine: createAutoEngine({ sessionId: "s1", classifier: scripted }) });
    const record = await evaluate(exploratoryCall, ctx);
    expect(scripted.calls.length).toBe(1);
    expect(promptSpy.calls.length).toBe(0);
    expect(record).toMatchObject({ decision: "deny", mechanism: "autoEngine", message: BLOCKED_BY_CLASSIFIER_MESSAGE });
  });

  test("practical outcome: a no_verdict falls through to the ordinary prompt path, unchanged (this is the DEFAULT shape every other plan-mode fixture in this file already relies on)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, policy: policy({ mode: "plan" }) }); // NO_OPINION_AUTO_ENGINE default
    const record = await evaluate(exploratoryCall, ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(record.decision).toBe("deny");
  });

  test("useAutoModeDuringPlan: false disables the exploratory-shell borrow too", async () => {
    const scripted = createScriptedClassifier({ verdict: "allow" });
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      policy: policy({ mode: "plan", autoConfig: { useAutoModeDuringPlan: false } }),
      autoEngine: createAutoEngine({ sessionId: "s1", classifier: scripted }),
    });
    const record = await evaluate(exploratoryCall, ctx);
    expect(scripted.calls.length).toBe(0);
    expect(promptSpy.calls.length).toBe(1);
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

// Task 8 (P3 close-out, "Baseline read denial" MUST; WS-12 §2 / D6): the exact rule shapes engine.ts
// seeds into EVERY session (`BASELINE_DENY_RULES`) -- two `~`-anchored deny rules, source "managed".
// Per engine.ts's own documented testing convention ("tests that need a synthetic home construct an
// EvaluationContext directly against evaluator.ts instead of exercising [os.homedir()'s] real
// value"), this proves the RULE MECHANISM against a synthetic `ctx.home` -- never the real OS home
// (this file's own hard constraint: no test may touch a real ~/.winter). engine.ts's own
// construction is two `sourceRule(...)` calls; a throw there would fail EVERY test in the whole
// suite at import time (engine.ts is transitively imported everywhere), which the gate gave zero
// evidence of -- the wiring itself is a matter of reading engine.ts's own source, not something
// this file re-derives. TWO rules, not one: found empirically (this describe block's own first
// draft used only the bare pattern and a RED test caught it) that Ruling P2-D's "bare `~`-anchored
// segment reaches any depth on deny" special case is scoped to a SINGLE-segment pattern
// (paths.ts's own `isSingleSegmentDirectoryPattern`) -- `.winter/run` is two segments, so it
// compiles through the general, exact-match-only glob path instead; see engine.ts's own
// BASELINE_DENY_RULES comment for the full account.
describe("Task 8 (P3 close-out): the baseline `~/.winter/run` read denial (WS-12 §2 / D6, engine.ts's own BASELINE_DENY_RULES shape)", () => {
  function baselineDenyRules(): SourcedRuleSet {
    return withRules(rule("Read(~/.winter/run)", "deny", "managed"), rule("Read(~/.winter/run/**)", "deny", "managed"));
  }

  test("denies a Read of the bare path itself", async () => {
    const ctx = baseCtx({ home: "/synthetic/home", policy: policy({ mode: "default", rules: baselineDenyRules() }) });
    const record = await evaluate(call("Read", { file_path: "/synthetic/home/.winter/run" }), ctx);
    expect(record).toMatchObject({ decision: "deny", mechanism: "rule", source: "managed" });
  });

  test("denies a Read of a file NESTED under the path (Ruling P2-D: a bare `~`-anchored segment reaches any depth on deny)", async () => {
    const ctx = baseCtx({ home: "/synthetic/home", policy: policy({ mode: "default", rules: baselineDenyRules() }) });
    const record = await evaluate(call("Read", { file_path: "/synthetic/home/.winter/run/core.sock" }), ctx);
    expect(record).toMatchObject({ decision: "deny", mechanism: "rule", source: "managed" });
  });

  test("wins even under bypassPermissions -- a managed deny rule always outranks bypass (WS-07 §6.4)", async () => {
    const ctx = baseCtx({ home: "/synthetic/home", policy: policy({ mode: "bypassPermissions", rules: baselineDenyRules() }) });
    const record = await evaluate(call("Read", { file_path: "/synthetic/home/.winter/run/core.sock" }), ctx);
    expect(record).toMatchObject({ decision: "deny", mechanism: "rule" });
  });

  test("also blocks Edit/Write/NotebookEdit on the same path via the general Read-deny-blocks-edit composition (WS-07 §3.1) -- the tool-fence layer, not just Read itself", async () => {
    const ctx = baseCtx({ home: "/synthetic/home", policy: policy({ mode: "default", rules: baselineDenyRules() }) });
    for (const [toolName, field] of [
      ["Edit", "file_path"],
      ["Write", "file_path"],
      ["NotebookEdit", "notebook_path"],
    ] as const) {
      const record = await evaluate(call(toolName, { [field]: "/synthetic/home/.winter/run/core.sock" }), ctx);
      expect(record).toMatchObject({ decision: "deny", mechanism: "rule" });
    }
  });

  test("does NOT block a read of an unrelated path under the same home (the rule is scoped, not a blanket home-wide deny)", async () => {
    const ctx = baseCtx({ home: "/synthetic/home", cwd: "/synthetic/home", policy: policy({ mode: "default", rules: baselineDenyRules() }) });
    const record = await evaluate(call("Read", { file_path: "/synthetic/home/notes.txt" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });
});

describe("Task 8 (P3 close-out, RULING P3-E): NotebookEdit joins FILE_RULE_TOOLS/write-path extraction, exactly like Edit/Write", () => {
  test("a deny rule on a notebook path blocks NotebookEdit, before ever reaching the mode/prompt stage (mirrors the Edit/Write fixture above)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" })); // proves the denial happens BEFORE the prompt stage
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      cwd: "/work",
      policy: policy({ mode: "default", rules: withRules(rule("NotebookEdit(secrets/**)", "deny")) }),
    });
    const record = await evaluate(call("NotebookEdit", { notebook_path: "/work/secrets/analysis.ipynb", new_source: "1+1" }), ctx);
    expect(promptSpy.calls.length).toBe(0);
    expect(record).toMatchObject({ decision: "deny", mechanism: "rule" });
  });

  test("a Read deny on the SAME path ALSO blocks NotebookEdit — extractCandidateWritePaths now recognizes notebook_path, so the general Read-deny-blocks-edit check (WS-07 §3.1) covers this editing surface too, exactly as report §40 requires", async () => {
    const ctx = baseCtx({
      cwd: "/work",
      policy: policy({ mode: "default", rules: withRules(rule("Read(secrets/**)", "deny")) }),
    });
    const record = await evaluate(call("NotebookEdit", { notebook_path: "/work/secrets/analysis.ipynb", new_source: "1+1" }), ctx);
    expect(record).toMatchObject({ decision: "deny", mechanism: "rule" });
  });

  test("acceptEdits: a NotebookEdit within cwd is recognized and auto-approved, exactly like Edit (recognizeEditOperation now returns kind:'edit' for NotebookEdit)", async () => {
    const ctx = baseCtx({
      cwd: "/work",
      policy: policy({ mode: "acceptEdits" }),
      specialChecks: REAL_SPECIAL_CHECKS,
    });
    const record = await evaluate(call("NotebookEdit", { notebook_path: "/work/notes/analysis.ipynb", new_source: "1+1" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  test("acceptEdits: an OUT-OF-CWD NotebookEdit is NOT auto-approved by the acceptEdits path-bound (falls through to the ordinary pipeline, same as an out-of-root Edit)", async () => {
    const ctx = baseCtx({
      cwd: "/work",
      policy: policy({ mode: "acceptEdits" }),
      specialChecks: REAL_SPECIAL_CHECKS,
    });
    const record = await evaluate(call("NotebookEdit", { notebook_path: "/synthetic/outside/analysis.ipynb", new_source: "1+1" }), ctx);
    expect(record).not.toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  test("protected paths gate NotebookEdit exactly like Edit — a notebook inside .git is prompt/callback in default mode, never silently auto-approved", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, cwd: "/work", policy: policy({ mode: "default" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(call("NotebookEdit", { notebook_path: "/work/.git/analysis.ipynb", new_source: "1+1" }), ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(record).toMatchObject({ decision: "deny", mechanism: "canUseTool" });
  });

  test("protected paths gate NotebookEdit under acceptEdits too — never silently auto-approved just because it's 'recognized' (mirrors the Edit fixture at §6.7)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, cwd: "/work", policy: policy({ mode: "acceptEdits" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(call("NotebookEdit", { notebook_path: "/work/.git/analysis.ipynb", new_source: "1+1" }), ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(record.decision).toBe("deny");
  });

  test("plan mode withholds a NotebookEdit exactly like Edit/Write (isPlanWriteShaped now recognizes it)", async () => {
    const ctx = baseCtx({ cwd: "/work", policy: policy({ mode: "plan" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(call("NotebookEdit", { notebook_path: "/work/notes/analysis.ipynb", new_source: "1+1" }), ctx);
    expect(record).toMatchObject({ decision: "deny", mechanism: "mode" });
  });
});

// I1 (fix wave, P3 close-out): the evaluator predates Glob/Grep -- every input-aware read/exec
// judgment was keyed on `toolName === "Read"|"Bash"` alone, so Glob/Grep prompted in default mode
// (denied under dontAsk) and the `~/.winter/run` baseline deny never covered them.
describe("I1 (fix wave, P3 close-out): Glob/Grep join the dedicated-read-tool baseline (WS-07 §6.1 line 136)", () => {
  test("Glob(pattern:'*') in default mode, no rule/hook/canUseTool -- silent allow, mechanism mode (was: denied)", async () => {
    const ctx = baseCtx({ cwd: "/work", policy: policy({ mode: "default" }) });
    const record = await evaluate(call("Glob", { pattern: "*" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  test("Grep with a path INSIDE cwd -- silent allow (was: denied)", async () => {
    const ctx = baseCtx({ cwd: "/work", policy: policy({ mode: "default" }) });
    const record = await evaluate(call("Grep", { pattern: "x", path: "/work/sub" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  test("Grep with a path OUTSIDE cwd -- still prompts (unchanged: out-of-bounds is never silently allowed)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, cwd: "/work", policy: policy({ mode: "default" }) });
    const record = await evaluate(call("Grep", { pattern: "x", path: "/etc" }), ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(record.decision).toBe("deny");
  });

  test("Glob/Grep with NO path field at all default to cwd -- silent allow (mirrors the executors' own 'absent == scan from cwd')", async () => {
    const ctxGlob = baseCtx({ cwd: "/work", policy: policy({ mode: "default" }) });
    expect(await evaluate(call("Glob", { pattern: "*" }), ctxGlob)).toMatchObject({ decision: "allow", mechanism: "mode" });
    const ctxGrep = baseCtx({ cwd: "/work", policy: policy({ mode: "default" }) });
    expect(await evaluate(call("Grep", { pattern: "x" }), ctxGrep)).toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  test("dontAsk also silently permits Glob/Grep (shares default's built-in-read-only baseline)", async () => {
    const ctx = baseCtx({ cwd: "/work", policy: policy({ mode: "dontAsk" }) });
    const record = await evaluate(call("Glob", { pattern: "*" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  function baselineDenyRulesForAllThree(): SourcedRuleSet {
    return withRules(
      rule("Read(~/.winter/run)", "deny", "managed"),
      rule("Read(~/.winter/run/**)", "deny", "managed"),
      rule("Glob(~/.winter/run)", "deny", "managed"),
      rule("Glob(~/.winter/run/**)", "deny", "managed"),
      rule("Grep(~/.winter/run)", "deny", "managed"),
      rule("Grep(~/.winter/run/**)", "deny", "managed"),
    );
  }

  test("the baseline `~/.winter/run` deny, emitted for Grep too, denies a Grep whose OWN path field names the denied subtree (was: allow/prompt)", async () => {
    const ctx = baseCtx({ home: "/synthetic/home", cwd: "/work", policy: policy({ mode: "default", rules: baselineDenyRulesForAllThree() }) });
    const record = await evaluate(call("Grep", { pattern: "x", path: "/synthetic/home/.winter/run" }), ctx);
    expect(record).toMatchObject({ decision: "deny", mechanism: "rule", source: "managed" });
  });

  test("the baseline `~/.winter/run` deny, emitted for Glob too, denies a Glob whose OWN path field names the denied subtree", async () => {
    const ctx = baseCtx({ home: "/synthetic/home", cwd: "/work", policy: policy({ mode: "default", rules: baselineDenyRulesForAllThree() }) });
    const record = await evaluate(call("Glob", { pattern: "*", path: "/synthetic/home/.winter/run" }), ctx);
    expect(record).toMatchObject({ decision: "deny", mechanism: "rule", source: "managed" });
  });

  test("a Read(...) baseline deny rule alone does NOT cover a Grep call -- matchesRuleForCall requires an exact toolName match (documents why engine.ts must emit all three)", async () => {
    const readOnlyBaseline = withRules(rule("Read(~/.winter/run)", "deny", "managed"), rule("Read(~/.winter/run/**)", "deny", "managed"));
    const ctx = baseCtx({ home: "/synthetic/home", cwd: "/work", policy: policy({ mode: "default", rules: readOnlyBaseline }) });
    const record = await evaluate(call("Grep", { pattern: "x", path: "/synthetic/home/.winter/run" }), ctx);
    // Falls through to the ordinary built-in-read-only baseline (path outside cwd would normally
    // prompt, but /synthetic/home/.winter/run isn't within /work's bounds either -- so this call is
    // actually denied by the generic post-allow-stage fallback, NOT by a rule; the point of this
    // test is `record.mechanism !== "rule"`, proving a Read-only rule set is not itself sufficient).
    expect(record.mechanism).not.toBe("rule");
  });
});

// I2 (fix wave, P3 close-out): Monitor's command half is outside the Bash permission family -- no
// critical-removal breaker, no protected-write, no read-deny-blocks-edit, no plan-write withholding.
// `shellCommandOf` (edit-recognition.ts) closes this by covering Monitor's own `command` field
// everywhere Bash's is already consulted (except the read-only pre-approval, deliberately).
describe("I2 (fix wave, P3 close-out): Monitor's command half joins the Bash permission family", () => {
  const monitorCall = (command: string) => call("Monitor", { description: "d", timeout_ms: 1000, persistent: false, command });

  test("bypassPermissions does NOT silently allow a critical Monitor removal -- the WS-07 §6.8 breaker fires exactly like Bash's own (was: allow)", async () => {
    const ctx = baseCtx({ cwd: "/work", policy: policy({ mode: "bypassPermissions" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(monitorCall("rm -rf /"), ctx);
    expect(record.decision).not.toBe("allow");
  });

  test("a bare Monitor allow rule does NOT bypass the critical-removal breaker either", async () => {
    const ctx = baseCtx({
      cwd: "/work",
      policy: policy({ mode: "default", rules: withRules(rule("Monitor", "allow")) }),
      specialChecks: REAL_SPECIAL_CHECKS,
    });
    const record = await evaluate(monitorCall("rm -rf /"), ctx);
    expect(record.decision).not.toBe("allow");
  });

  test("plan mode withholds a Monitor write exactly like Bash's own recognized fs-op (isPlanWriteShaped)", async () => {
    const ctx = baseCtx({ cwd: "/work", policy: policy({ mode: "plan" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(monitorCall("touch /work/newfile"), ctx);
    expect(record).toMatchObject({ decision: "deny", mechanism: "mode" });
  });

  test("a protected-path write via Monitor prompts, exactly like Bash's own", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, cwd: "/work", policy: policy({ mode: "default" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(monitorCall("echo x > /work/.git/config"), ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(record.decision).toBe("deny");
  });

  test("Monitor is deliberately NOT included in the read-only pre-approval -- a read-only-LOOKING Monitor command still falls through, never silently allowed as a 'read'", async () => {
    const ctx = baseCtx({ cwd: "/work", policy: policy({ mode: "default" }) });
    const record = await evaluate(monitorCall("cat /work/somefile"), ctx);
    // Monitor has no dedicated schema field this evaluator recognizes as read-shaped, and
    // isBashCallReadOnly is Bash-only by design -- falls all the way to the generic post-allow-stage
    // fallback (Ruling P2-I: null PromptStage answer -> deny, mechanism "mode"), never silently
    // allowed the way a read-only Bash call would be.
    expect(record).toMatchObject({ decision: "deny", mechanism: "mode" });
  });

  // Advisor-flagged correction: the review's own I2 text scopes the fix to the bypass/allow-rule
  // hole ("acceptEdits: fine (Monitor never auto-approves)") -- widening `recognizeEditOperation`
  // itself must NOT hand Monitor a NEW acceptEdits/auto silent-allow path it never had before
  // (WS-07 §13: "stricter, never looser").
  test("acceptEdits does NOT auto-approve a Monitor bashFsOp command, even in-bounds -- Monitor never gains a new silent-allow path", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, cwd: "/work", policy: policy({ mode: "acceptEdits" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(monitorCall("mkdir /work/newdir"), ctx);
    expect(record.decision).not.toBe("allow");
  });

  test("auto mode does NOT auto-approve a Monitor bashFsOp command either", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({ promptStage: promptSpy.stage, cwd: "/work", policy: policy({ mode: "auto" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(monitorCall("mkdir /work/newdir"), ctx);
    expect(record.decision).not.toBe("allow");
  });

  test("the identical Bash command, by contrast, DOES auto-approve under acceptEdits (positive control -- proves the exclusion is Monitor-specific, not a general regression)", async () => {
    const ctx = baseCtx({ cwd: "/work", policy: policy({ mode: "acceptEdits" }), specialChecks: REAL_SPECIAL_CHECKS });
    const record = await evaluate(call("Bash", { command: "mkdir /work/newdir" }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });
});

// RULING P3-K (controller ruling, fix wave, P3 close-out): task/mode-class tools WS-06 §1.4's
// Manual-mode evidence column marks "No" get a default-mode silent allow at stage 4.
describe("RULING P3-K: task/mode-class tools get a default-mode silent allow (mechanism 'mode')", () => {
  const silentAllowTools = [
    "TaskCreate",
    "TaskGet",
    "TaskList",
    "TaskUpdate",
    "TodoWrite",
    "CronList",
    "CronDelete",
    "ScheduleWakeup",
    "ReportFindings",
    "PushNotification",
    "TaskOutput",
    "TaskStop",
    "EnterPlanMode",
  ];

  for (const toolName of silentAllowTools) {
    test(`${toolName}: silent allow in default mode (was: denied at stage 6)`, async () => {
      const ctx = baseCtx({ cwd: "/work", policy: policy({ mode: "default" }) });
      const record = await evaluate(call(toolName, {}), ctx);
      expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
    });

    test(`${toolName}: dontAsk also silently permits it ("still permits built-in operations")`, async () => {
      const ctx = baseCtx({ cwd: "/work", policy: policy({ mode: "dontAsk" }) });
      const record = await evaluate(call(toolName, {}), ctx);
      expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
    });
  }

  test("a deny rule still wins over the silent-allow class (stage 2 runs first)", async () => {
    const ctx = baseCtx({ cwd: "/work", policy: policy({ mode: "default", rules: withRules(rule("TaskCreate", "deny")) }) });
    const record = await evaluate(call("TaskCreate", {}), ctx);
    expect(record).toMatchObject({ decision: "deny", mechanism: "rule" });
  });

  test("non-durable CronCreate is silent-allow too (never touches the filesystem)", async () => {
    const ctx = baseCtx({ cwd: "/work", policy: policy({ mode: "default" }) });
    const record = await evaluate(call("CronCreate", { cron: "* * * * *", prompt: "p", recurring: true, durable: false }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  test("CronCreate omitting `durable` entirely is also silent-allow (defaults to false)", async () => {
    const ctx = baseCtx({ cwd: "/work", policy: policy({ mode: "default" }) });
    const record = await evaluate(call("CronCreate", { cron: "* * * * *", prompt: "p", recurring: true }), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });

  test("CronCreate(durable:true) is WRITE-SHAPED, not silent-allow -- it prompts in default mode, like any write", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      cwd: "/work",
      sessionRoot: "/work",
      policy: policy({ mode: "default" }),
      specialChecks: REAL_SPECIAL_CHECKS,
    });
    const record = await evaluate(call("CronCreate", { cron: "* * * * *", prompt: "p", recurring: true, durable: true }), ctx);
    expect(promptSpy.calls.length).toBe(1); // protected-write (`.winter/` is a protected dir) forces a prompt
    expect(record.decision).toBe("deny");
  });

  test("CronCreate(durable:true) is RECOGNIZED as write-shaped under acceptEdits too -- it still prompts (protected `.winter/` path), never silently auto-approved just because acceptEdits is active", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      cwd: "/work",
      sessionRoot: "/work",
      policy: policy({ mode: "acceptEdits" }),
      specialChecks: REAL_SPECIAL_CHECKS,
    });
    const record = await evaluate(call("CronCreate", { cron: "* * * * *", prompt: "p", recurring: true, durable: true }), ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(record.decision).toBe("deny");
  });

  test("CronCreate(durable:true) is denied outright by a deny rule targeting its actual write target", async () => {
    const ctx = baseCtx({
      cwd: "/work",
      sessionRoot: "/work",
      // Double-leading-slash is this rule grammar's own absolute-path anchor convention (mirrors
      // this file's own "file-rule routing" describe block, e.g. `Read(//etc/passwd)`) -- a single
      // `/`-anchored pattern is inert without a `sourceDir` no fixture here ever supplies.
      policy: policy({ mode: "default", rules: withRules(rule("Read(//work/.winter/**)", "deny")) }),
      specialChecks: REAL_SPECIAL_CHECKS,
    });
    const record = await evaluate(call("CronCreate", { cron: "* * * * *", prompt: "p", recurring: true, durable: true }), ctx);
    expect(record).toMatchObject({ decision: "deny", mechanism: "rule" });
  });
});

// RULING P3-K-2 (controller ruling, fix wave round 2, P3 close-out): a no-prompt class must never
// be stricter under a more permissive mode. P3-K's own silent-allow cell set (the 13 task/mode-class
// tools) extends from default/dontAsk to acceptEdits, plan, and auto too -- deny/ask rules at
// stages 2-3 still run first in every mode, exactly as before.
//
// Durable CronCreate is explicitly NOT part of this extension -- it was always P3-K's own named
// EXCEPTION ("write-shaped", never silent-allow), not a class member. See this file's own
// already-GREEN P3-K tests above (default/acceptEdits both prompt it via the SAME protected-write
// standing exception `.winter/scheduled_tasks.json` triggers for ANY tool) -- this ruling's per-mode
// table is honored for the SILENT-ALLOW CLASS ONLY; durable CronCreate's own mustPrompt-everywhere
// behavior (via isProtectedWrite, unconditional and tool-name-agnostic by design) is UNCHANGED and
// is proven again below under plan/auto for completeness, not because either arm's own logic needed
// a durable-CronCreate-specific branch.
describe("RULING P3-K-2: the task/mode-class silent allow extends to acceptEdits, plan, and auto (never stricter than default)", () => {
  const silentAllowTools = [
    "TaskCreate",
    "TaskGet",
    "TaskList",
    "TaskUpdate",
    "TodoWrite",
    "CronList",
    "CronDelete",
    "ScheduleWakeup",
    "ReportFindings",
    "PushNotification",
    "TaskOutput",
    "TaskStop",
    "EnterPlanMode",
  ];

  for (const toolName of silentAllowTools) {
    test(`${toolName}: silent allow under acceptEdits too (was: unresolved -> stage 6)`, async () => {
      const ctx = baseCtx({ cwd: "/work", policy: policy({ mode: "acceptEdits" }) });
      const record = await evaluate(call(toolName, {}), ctx);
      expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
    });

    test(`${toolName}: silent allow under plan too (it's not a write, so plan's own write-withholding never applies)`, async () => {
      const ctx = baseCtx({ cwd: "/work", policy: policy({ mode: "plan" }) });
      const record = await evaluate(call(toolName, {}), ctx);
      expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
    });

    test(`${toolName}: silent allow under auto too (skips the classifier entirely, exactly like built-in read-only)`, async () => {
      const ctx = baseCtx({ cwd: "/work", policy: policy({ mode: "auto" }) });
      const record = await evaluate(call(toolName, {}), ctx);
      expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
    });
  }

  test("a deny rule still wins over the silent-allow class under acceptEdits (stage 2 runs before stage 4 in every mode)", async () => {
    const ctx = baseCtx({ cwd: "/work", policy: policy({ mode: "acceptEdits", rules: withRules(rule("TaskCreate", "deny")) }) });
    const record = await evaluate(call("TaskCreate", {}), ctx);
    expect(record).toMatchObject({ decision: "deny", mechanism: "rule" });
  });

  test("a deny rule still wins over the silent-allow class under plan", async () => {
    const ctx = baseCtx({ cwd: "/work", policy: policy({ mode: "plan", rules: withRules(rule("TaskCreate", "deny")) }) });
    const record = await evaluate(call("TaskCreate", {}), ctx);
    expect(record).toMatchObject({ decision: "deny", mechanism: "rule" });
  });

  test("a deny rule still wins over the silent-allow class under auto", async () => {
    const ctx = baseCtx({ cwd: "/work", policy: policy({ mode: "auto", rules: withRules(rule("TaskCreate", "deny")) }) });
    const record = await evaluate(call("TaskCreate", {}), ctx);
    expect(record).toMatchObject({ decision: "deny", mechanism: "rule" });
  });

  test("non-durable CronCreate is silent-allow under acceptEdits/plan/auto too", async () => {
    for (const mode of ["acceptEdits", "plan", "auto"] as const) {
      const ctx = baseCtx({ cwd: "/work", policy: policy({ mode }) });
      const record = await evaluate(call("CronCreate", { cron: "* * * * *", prompt: "p", recurring: true, durable: false }), ctx);
      expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
    }
  });

  // Durable CronCreate is write-shaped, not a class member (see this describe block's own header
  // comment) -- plan withholds it via isPlanWriteShaped's own independent CronCreate(durable) check
  // (unaffected by anything this ruling changes), which happens to be moot in practice because
  // isProtectedWrite's standing exception (unconditional, before ANY mode arm) already intercepted
  // it first, same as default/acceptEdits above.
  test("CronCreate(durable:true) under plan is withheld like any write (protected-write intercepts before plan's own arm runs)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      cwd: "/work",
      sessionRoot: "/work",
      policy: policy({ mode: "plan" }),
      specialChecks: REAL_SPECIAL_CHECKS,
    });
    const record = await evaluate(call("CronCreate", { cron: "* * * * *", prompt: "p", recurring: true, durable: true }), ctx);
    expect(promptSpy.calls.length).toBe(1);
    expect(record.decision).toBe("deny");
  });

  // Session-bypass relaxes plan's OWN write-withholding (WS-07 §6.4/§6.5), which also happens to be
  // exactly what protected-write's own plan+bypass branch already grants -- both paths agree, so
  // this is unaffected by this ruling either way; pinned here for completeness alongside its sibling.
  test("CronCreate(durable:true) under plan WITH session bypass enabled is allowed (protected-write's own plan+bypass carve-out, WS-07 §6.7 -- pre-existing, unchanged by this ruling)", async () => {
    const ctx = baseCtx({
      cwd: "/work",
      sessionRoot: "/work",
      sessionBypassEnabled: true,
      policy: policy({ mode: "plan" }),
      specialChecks: REAL_SPECIAL_CHECKS,
    });
    const record = await evaluate(call("CronCreate", { cron: "* * * * *", prompt: "p", recurring: true, durable: true }), ctx);
    expect(record).toMatchObject({ decision: "allow" });
  });

  // Durable CronCreate's mustPrompt-under-auto cell did not previously have explicit coverage
  // (only default/acceptEdits did). Discovered while writing this test (not assumed): `auto` does
  // NOT route a protected-write mustPrompt to promptStage at all -- Task 12 (WS-07 §6.7's own "auto:
  // classifier" cell, evaluator.ts ~line 1429) routes EVERY protected/critical mustPrompt to
  // `resolveAutoDecision` (the classifier) under `auto`, unconditionally, before promptStage is ever
  // reached -- exactly like this file's own pre-existing "auto ... routes to the classifier, never
  // canUseTool" tests for an ordinary protected write. Durable CronCreate is no exception: it is
  // "just another protected write" to this routing, which is precisely the point -- no
  // durable-CronCreate-specific logic exists or is needed in auto's own arm.
  test("CronCreate(durable:true) under auto routes to the classifier (never canUseTool), never silently auto-approved by auto's own bounded-write recognition", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "allow" })); // even if it WOULD allow, auto's protected-write cell is "classifier", never canUseTool
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      cwd: "/work",
      sessionRoot: "/work",
      policy: policy({ mode: "auto" }),
      specialChecks: REAL_SPECIAL_CHECKS,
    });
    const record = await evaluate(call("CronCreate", { cron: "* * * * *", prompt: "p", recurring: true, durable: true }), ctx);
    expect(promptSpy.calls.length).toBe(0);
    expect(record).toMatchObject({ decision: "deny", mechanism: "autoEngine", message: BLOCKED_BY_CLASSIFIER_MESSAGE });
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

// ---------------------------------------------------------------------------------------------------
// P3 (WS-06 tool registry, task 1; widened fix round 1, RULING P3-B): probeReadAccess -- side-effect-
// free by construction
// ---------------------------------------------------------------------------------------------------
//
// Every ctx below wires hookStage/promptStage/autoEngine to seams that THROW the moment any of
// their methods is invoked -- not the ordinary NO_OPINION_* stubs baseCtx defaults to (those would
// pass even if the probe secretly called them, since "no opinion" is itself indistinguishable from
// "never asked"). The RED fixture immediately below proves these poisoned seams are load-bearing:
// evaluate() itself (a real six-stage run, not the probe) genuinely throws through them for a call
// that needs a prompt, so a probeReadAccess test that DOESN'T throw is real evidence the probe
// never reached stage 1's hooks, stage 3/6's canUseTool, or the auto classifier -- not an accident
// of a stub that would have stayed quiet either way.
//
// Fix round 1: the old boolean (`wouldPrompt: true|false`) is now a 3-state `ReadAccessProbe`
// (`"silent" | "prompt" | "deny"`) -- RULING P3-B. Every test below is named for the STATE it pins,
// not merely the stage that produces it, so this block visibly covers all three: a deny-rule path
// ("deny"), an allow-silent path ("silent"), and a would-prompt path ("prompt") -- plus the two cells
// where dontAsk converts an otherwise-interactive outcome to "deny" rather than "silent", which is
// the actual semantic change this ruling makes (the old boolean reported both as the same `false`).
describe("probeReadAccess (P3 seam, widened by RULING P3-B): side-effect-free by construction", () => {
  function poisonedSeams() {
    const fail = (label: string) => (): never => {
      throw new Error(`probeReadAccess must never invoke ${label}`);
    };
    return {
      hookStage: { preToolUse: fail("hookStage.preToolUse"), permissionRequest: fail("hookStage.permissionRequest") },
      promptStage: { prompt: fail("promptStage.prompt") },
      autoEngine: {
        classify: fail("autoEngine.classify"),
        noteFallbackResolution: fail("autoEngine.noteFallbackResolution"),
        noteHeadlessFallbackDenial: fail("autoEngine.noteHeadlessFallbackDenial"),
      },
    };
  }

  function poisonedCtx(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
    return baseCtx({ ...poisonedSeams(), specialChecks: REAL_SPECIAL_CHECKS, ...overrides });
  }

  test("RED fixture: with the SAME poisoned seams, a real evaluate() call that needs a prompt genuinely throws -- proves the seams are load-bearing, not merely quiet", async () => {
    const ctx = poisonedCtx();
    await expect(evaluate(call("Read", { file_path: "/outside/file.txt" }), ctx)).rejects.toThrow(/must never invoke/);
  });

  test("no decision record is ever produced: the return type itself is a closed 3-value string union, never a PermissionDecisionRecord", () => {
    const ctx = poisonedCtx(); // baseCtx cwd = "/work" -- /work/inside.txt resolves via stage 4's mode-allow
    const result: "silent" | "prompt" | "deny" = probeReadAccess("/work/inside.txt", ctx);
    expect(result).toBe("silent");
  });

  test('"deny" -- stage 2, a matched deny rule: an immediate rejection, never a prompt', () => {
    const ctx = poisonedCtx({ policy: policy({ rules: withRules(rule("Read(secrets/**)", "deny")) }) });
    expect(probeReadAccess("/work/secrets/key.pem", ctx)).toBe("deny");
  });

  test('"prompt" -- stage 3, a matched ask rule outside dontAsk: genuine interaction needed', () => {
    const ctx = poisonedCtx({ policy: policy({ rules: withRules(rule("Read(secrets/**)", "ask")) }) });
    expect(probeReadAccess("/work/secrets/key.pem", ctx)).toBe("prompt");
  });

  test('"deny" -- stage 3, a matched ask rule UNDER dontAsk: RULING P3-B\'s named cell -- interaction-needed-but-suppressed is "deny", not "silent"', () => {
    const ctx = poisonedCtx({ policy: policy({ mode: "dontAsk", rules: withRules(rule("Read(secrets/**)", "ask")) }) });
    expect(probeReadAccess("/work/secrets/key.pem", ctx)).toBe("deny");
  });

  test('"silent" -- stage 4, a read within cwd resolves via the built-in read-only baseline (mode-allow)', () => {
    const ctx = poisonedCtx(); // baseCtx cwd = "/work"
    expect(probeReadAccess("/work/inside.txt", ctx)).toBe("silent");
  });

  test('"silent" -- stage 4, bypassPermissions allows unconditionally (standing exceptions never fire for Read)', () => {
    const ctx = poisonedCtx({ policy: policy({ mode: "bypassPermissions" }) });
    expect(probeReadAccess("/outside/file.txt", ctx)).toBe("silent");
  });

  test('"silent" -- stage 5, an allow rule outside cwd resolves silently', () => {
    const ctx = poisonedCtx({ policy: policy({ rules: withRules(rule("Read(//synthetic/protected/**)", "allow")) }) });
    expect(probeReadAccess("/synthetic/protected/x", ctx)).toBe("silent");
  });

  test('"deny" -- post-allow-stage fallback, dontAsk denies unmatched actions silently: RULING P3-B\'s OTHER named cell (was folded into a bare `false` before this ruling)', () => {
    const ctx = poisonedCtx({ policy: policy({ mode: "dontAsk" }) });
    expect(probeReadAccess("/outside/file.txt", ctx)).toBe("deny");
  });

  test('"prompt" -- post-allow-stage fallback, default mode with nothing else resolving it would reach canUseTool', () => {
    const ctx = poisonedCtx();
    expect(probeReadAccess("/outside/file.txt", ctx)).toBe("prompt");
  });

  test('"prompt" -- post-allow-stage fallback, acceptEdits mode with nothing else resolving it would also reach canUseTool', () => {
    const ctx = poisonedCtx({ policy: policy({ mode: "acceptEdits" }) });
    expect(probeReadAccess("/outside/file.txt", ctx)).toBe("prompt");
  });

  test('"prompt" -- post-allow-stage fallback, auto mode with nothing else resolving it would consult the classifier: conservative "prompt" (never "silent", never "deny")', () => {
    const ctx = poisonedCtx({ policy: policy({ mode: "auto" }) });
    expect(probeReadAccess("/outside/file.txt", ctx)).toBe("prompt");
  });

  // These two cross-checks call evaluate() itself for real (stage 1's PreToolUse hook is
  // UNCONDITIONAL in evaluate() -- it runs even for a call a deny/allow rule will go on to resolve
  // outright -- so the poisoned ctx above cannot be reused for evaluate() the way it is for the
  // probe; evaluate() gets an ordinary NO_OPINION-seamed ctx over the IDENTICAL policy instead).
  // The probe call in each still uses the fully poisoned ctx -- this is what the cross-check is
  // actually proving: the probe reaches the SAME conclusion evaluate() does, without needing any of
  // the seams evaluate() itself unconditionally exercises.
  test('cross-check against the REAL evaluator for a resolvable case: an allow rule resolves BOTH the probe ("silent") and evaluate() itself to "no interaction needed"', async () => {
    const rules = withRules(rule("Read(//synthetic/protected/**)", "allow"));
    expect(probeReadAccess("/synthetic/protected/x", poisonedCtx({ policy: policy({ rules }) }))).toBe("silent");
    const record = await evaluate(call("Read", { file_path: "/synthetic/protected/x" }), baseCtx({ policy: policy({ rules }), specialChecks: REAL_SPECIAL_CHECKS }));
    expect(record).toMatchObject({ decision: "allow", mechanism: "rule" });
  });

  test('cross-check against the REAL evaluator for a deny case: both agree -- the probe reports "deny", evaluate() denies, and neither ever prompts', async () => {
    const rules = withRules(rule("Read(secrets/**)", "deny"));
    expect(probeReadAccess("/work/secrets/key.pem", poisonedCtx({ policy: policy({ rules }) }))).toBe("deny");
    const record = await evaluate(call("Read", { file_path: "/work/secrets/key.pem" }), baseCtx({ policy: policy({ rules }), specialChecks: REAL_SPECIAL_CHECKS }));
    expect(record).toMatchObject({ decision: "deny", mechanism: "rule" });
  });
});
