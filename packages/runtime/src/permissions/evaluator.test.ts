// Task 6 (WS-07 §2/§5/§6.1/§6.3/§6.4): the six-stage evaluator's fixture corpus.
//
// Scope: modes `default`, `dontAsk`, `bypassPermissions` fully; `acceptEdits`/`plan`/`auto` only as
// much as their T6 PLACEHOLDER arm promises (identical to `default`'s own baseline — see
// evaluator.ts's evaluateModeStage). Protected-path/critical-removal semantics are T7's
// (SpecialChecks seam, stubbed here as NOT_SPECIAL — see below); the AutoPermissionEngine's real
// pipeline is T12's (AutoEngine seam, stubbed here as NO-VERDICT).
//
// Every fixture builds its own EvaluationContext from scratch (baseCtx) — no shared mutable state
// between tests, no fs, no real WINTER_HOME (pure in-memory PolicyState objects throughout; the
// PolicyStateStore section further down never touches disk either).
import { test, expect, describe } from "bun:test";
import type { PermissionMode, PermissionRuleValue, PermissionUpdate, RuleSource } from "@yanlinglabs/winter-agent-sdk";
import {
  evaluate,
  NO_OPINION_HOOK_STAGE,
  NO_OPINION_PROMPT_STAGE,
  NO_OPINION_AUTO_ENGINE,
  NO_SPECIAL_CHECKS,
  type EvaluationContext,
  type PermissionCall,
  type PromptStage,
  type PromptStageMeta,
  type PromptDecision,
  type HookStage,
  type HookDecision,
} from "./evaluator.ts";
import { PolicyStateStore, WinterPermissionError, type PolicyState } from "./policy-state.ts";
import { emptyRuleSet, sourceRule, type SourcedRuleEntry, type SourcedRuleSet } from "./ruleset.ts";

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
    home: "/home/tester",
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

  test("default: unmatched + a genuinely no-opinion prompt stage resolves ALLOW (T6 interim decision — see evaluator.ts header)", async () => {
    const ctx = baseCtx({ policy: policy({ mode: "default" }) }); // NO_OPINION_PROMPT_STAGE
    const record = await evaluate(call("Bash", { command: "curl https://example.com" }), ctx);
    expect(record.decision).toBe("allow");
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

describe("acceptEdits/plan/auto placeholder arm (T7/T12 own the real semantics)", () => {
  for (const mode of ["acceptEdits", "plan", "auto"] as const) {
    test(`mode=${mode}: never auto-approves MORE than default would (an ordinary Edit still reaches the prompt stage)`, async () => {
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
      home: "/home/tester",
      policy: policy({ rules: withRules(rule("Read(~/.config/app/**)", "allow")) }),
    });
    const record = await evaluate(call("Read", { file_path: "/home/tester/.config/app/settings.json" }), ctx);
    expect(record.decision).toBe("allow");
    expect(record.mechanism).toBe("rule");
    expect(record.source).toBe("sdk");
  });

  test("a project-sourced Read allow rule is INERT in an untrusted workspace (duplicated trust gate)", async () => {
    const promptSpy = spyPromptStage(() => ({ decision: "deny" }));
    const ctx = baseCtx({
      promptStage: promptSpy.stage,
      cwd: "/work",
      home: "/home/tester",
      trustedWorkspace: false,
      policy: policy({ rules: withRules(rule("Read(~/.config/app/**)", "allow", "project")) }),
    });
    const record = await evaluate(call("Read", { file_path: "/home/tester/.config/app/settings.json" }), ctx);
    expect(promptSpy.calls.length).toBe(1); // the allow rule never fired
    expect(record.mechanism).toBe("canUseTool");
  });

  test("the SAME project-sourced allow rule fires once trustedWorkspace flips true", async () => {
    const ctx = baseCtx({
      cwd: "/work",
      home: "/home/tester",
      trustedWorkspace: true,
      policy: policy({ rules: withRules(rule("Read(~/.config/app/**)", "allow", "project")) }),
    });
    const record = await evaluate(call("Read", { file_path: "/home/tester/.config/app/settings.json" }), ctx);
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
