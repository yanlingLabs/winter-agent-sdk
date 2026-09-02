// Task 12 (WS-07 §10): createAutoEngine — classifier consultation, cache, counters, fallback
// signal, tier backstop, audit emission.
import { describe, test, expect } from "bun:test";
import {
  createAutoEngine,
  alwaysNoVerdictClassifier,
  createScriptedClassifier,
  BLOCKED_BY_CLASSIFIER_MESSAGE,
  redactAuditReason,
  type AutoAuditRecord,
} from "./engine.ts";
import { createInMemoryAutoCounterStore, createInMemoryVerdictCache, AUTO_FALLBACK_CONSECUTIVE_THRESHOLD } from "./caches.ts";
import {
  NO_OPINION_HOOK_STAGE,
  NO_OPINION_PROMPT_STAGE,
  NO_OPINION_AUTO_ENGINE,
  NO_SPECIAL_CHECKS,
  type EvaluationContext,
  type PermissionCall,
} from "../evaluator.ts";
import { emptyRuleSet } from "../ruleset.ts";
import type { PolicyState } from "../policy-state.ts";

function ctx(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  const policy: PolicyState = { mode: "auto", version: 0, rules: emptyRuleSet() };
  return {
    policy,
    cwd: "/work",
    home: "/home/u",
    trustedWorkspace: false,
    hookStage: NO_OPINION_HOOK_STAGE,
    promptStage: NO_OPINION_PROMPT_STAGE,
    autoEngine: NO_OPINION_AUTO_ENGINE,
    specialChecks: NO_SPECIAL_CHECKS,
    ...overrides,
  };
}

function call(command: string): PermissionCall {
  return { toolName: "Bash", input: { command } };
}

describe("createAutoEngine -- BLOCKED_BY_CLASSIFIER_MESSAGE is a stable, exact string (WS-07 §10.6-5)", () => {
  test("the exported constant is exactly 'Blocked by classifier', no prefix/suffix", () => {
    expect(BLOCKED_BY_CLASSIFIER_MESSAGE).toBe("Blocked by classifier");
  });
});

describe("createAutoEngine -- alwaysNoVerdictClassifier is P2's entire production classifier", () => {
  test("always returns no_verdict, never consults the call", async () => {
    const engine = createAutoEngine({ sessionId: "s1", classifier: alwaysNoVerdictClassifier });
    const result = await engine.classify(call("literally anything"), ctx());
    expect(result.verdict).toBe("no_verdict");
    expect(result.fallbackToPrompt).toBeUndefined();
  });
});

describe("createAutoEngine -- classifier consultation + counters", () => {
  test("a classifier 'allow' verdict resets consecutive (via a prior deny) and does not increment total further", async () => {
    const scripted = createScriptedClassifier({ verdict: "deny" });
    const counters = createInMemoryAutoCounterStore();
    const engine = createAutoEngine({ sessionId: "s1", classifier: scripted, counters });
    await engine.classify(call("cmd1"), ctx());
    expect(counters.get("s1")).toEqual({ consecutive: 1, total: 1 });

    const allowEngine = createAutoEngine({ sessionId: "s1", classifier: createScriptedClassifier({ verdict: "allow" }), counters });
    await allowEngine.classify(call("cmd2"), ctx());
    expect(counters.get("s1")).toEqual({ consecutive: 0, total: 1 });
  });

  test("a no_verdict result does not touch the counters at all", async () => {
    const counters = createInMemoryAutoCounterStore();
    const engine = createAutoEngine({ sessionId: "s1", classifier: createScriptedClassifier({ verdict: "no_verdict" }), counters });
    await engine.classify(call("cmd"), ctx());
    expect(counters.get("s1")).toEqual({ consecutive: 0, total: 0 });
  });

  test("3 consecutive classifier denies trip fallback; the 4th call signals fallbackToPrompt WITHOUT consulting the classifier again", async () => {
    const scripted = createScriptedClassifier({ verdict: "deny" });
    const counters = createInMemoryAutoCounterStore();
    const engine = createAutoEngine({ sessionId: "s1", classifier: scripted, counters });
    for (let i = 0; i < AUTO_FALLBACK_CONSECUTIVE_THRESHOLD; i++) await engine.classify(call(`cmd${i}`), ctx());
    expect(scripted.calls.length).toBe(AUTO_FALLBACK_CONSECUTIVE_THRESHOLD);

    const result = await engine.classify(call("cmd-after-fallback"), ctx());
    expect(result.fallbackToPrompt).toBe(true);
    expect(scripted.calls.length).toBe(AUTO_FALLBACK_CONSECUTIVE_THRESHOLD); // classifier never consulted again while fallback is active
  });

  test("noteFallbackResolution('allow') resets consecutive so the NEXT call reaches the classifier again", async () => {
    const scripted = createScriptedClassifier({ verdict: "deny" });
    const counters = createInMemoryAutoCounterStore();
    const engine = createAutoEngine({ sessionId: "s1", classifier: scripted, counters });
    for (let i = 0; i < AUTO_FALLBACK_CONSECUTIVE_THRESHOLD; i++) await engine.classify(call(`cmd${i}`), ctx());

    const fallbackResult = await engine.classify(call("during-fallback"), ctx());
    expect(fallbackResult.fallbackToPrompt).toBe(true);

    engine.noteFallbackResolution?.("allow"); // simulates evaluate()'s own post-prompt call
    expect(counters.get("s1").consecutive).toBe(0);

    const afterReset = await engine.classify(call("after-reset"), ctx());
    expect(afterReset.fallbackToPrompt).toBeUndefined();
    expect(scripted.calls.length).toBe(AUTO_FALLBACK_CONSECUTIVE_THRESHOLD + 1); // classifier consulted again
  });

  test("noteFallbackResolution('deny') does nothing -- a fallback-prompt denial is not a classifier verdict", async () => {
    const counters = createInMemoryAutoCounterStore();
    const engine = createAutoEngine({ sessionId: "s1", classifier: createScriptedClassifier({ verdict: "deny" }), counters });
    for (let i = 0; i < AUTO_FALLBACK_CONSECUTIVE_THRESHOLD; i++) await engine.classify(call(`cmd${i}`), ctx());
    const before = counters.get("s1");
    engine.noteFallbackResolution?.("deny");
    expect(counters.get("s1")).toEqual(before);
  });
});

describe("createAutoEngine -- verdict cache", () => {
  test("an identical repeated call hits the cache -- classifier consulted exactly once", async () => {
    const scripted = createScriptedClassifier({ verdict: "deny", category: "some-category" });
    const cache = createInMemoryVerdictCache();
    const engine = createAutoEngine({ sessionId: "s1", classifier: scripted, cache });
    const c = call("same command");
    const first = await engine.classify(c, ctx());
    const second = await engine.classify(c, ctx());
    expect(scripted.calls.length).toBe(1);
    expect(second).toEqual(first);
  });

  test("a no_verdict denial is ALSO cached (WS-07 §10.5: 'their own cache until new content or compaction')", async () => {
    const scripted = createScriptedClassifier({ verdict: "no_verdict" });
    const cache = createInMemoryVerdictCache();
    const engine = createAutoEngine({ sessionId: "s1", classifier: scripted, cache });
    const c = call("same command");
    await engine.classify(c, ctx());
    await engine.classify(c, ctx());
    expect(scripted.calls.length).toBe(1);
  });

  test("a different command (different action fingerprint) is NOT a cache hit", async () => {
    const scripted = createScriptedClassifier({ verdict: "deny" });
    const engine = createAutoEngine({ sessionId: "s1", classifier: scripted });
    await engine.classify(call("cmd1"), ctx());
    await engine.classify(call("cmd2"), ctx());
    expect(scripted.calls.length).toBe(2);
  });

  test("a cache hit does not move the counters again", async () => {
    const scripted = createScriptedClassifier({ verdict: "deny" });
    const counters = createInMemoryAutoCounterStore();
    const engine = createAutoEngine({ sessionId: "s1", classifier: scripted, counters });
    const c = call("same command");
    await engine.classify(c, ctx());
    await engine.classify(c, ctx());
    expect(counters.get("s1")).toEqual({ consecutive: 1, total: 1 }); // NOT 2 -- the second call was a cache hit
  });

  test("a different policyHash (e.g. a different mode) is NOT a cache hit", async () => {
    const scripted = createScriptedClassifier({ verdict: "deny" });
    const engine = createAutoEngine({ sessionId: "s1", classifier: scripted });
    const c = call("same command");
    await engine.classify(c, ctx());
    await engine.classify(c, ctx({ policy: { mode: "auto", version: 1, rules: emptyRuleSet(), autoConfig: { classifyAllShell: true } } }));
    expect(scripted.calls.length).toBe(2);
  });
});

describe("createAutoEngine -- tier backstop (WS-07 §10.2/§10.6-7)", () => {
  test("a hard_deny category forces deny even when the raw classifier verdict is 'allow'", async () => {
    const scripted = createScriptedClassifier({ verdict: "allow", category: "disable-security" });
    const engine = createAutoEngine({ sessionId: "s1", classifier: scripted });
    const result = await engine.classify(call("cmd"), ctx({ policy: { mode: "auto", version: 0, rules: emptyRuleSet(), autoConfig: { hard_deny: ["disable-security"] } } }));
    expect(result.verdict).toBe("deny");
  });

  test("an uncleared soft_deny category forces deny even when the raw classifier verdict is 'allow'", async () => {
    const scripted = createScriptedClassifier({ verdict: "allow", category: "force-push" });
    const engine = createAutoEngine({ sessionId: "s1", classifier: scripted });
    const result = await engine.classify(
      call("cmd"),
      ctx({ policy: { mode: "auto", version: 0, rules: emptyRuleSet(), autoConfig: { soft_deny: ["force-push"] } } }),
    );
    expect(result.verdict).toBe("deny");
  });

  test("a soft_deny category CLEARED by a matching allow entry does NOT override the raw classifier verdict", async () => {
    const scripted = createScriptedClassifier({ verdict: "allow", category: "force-push" });
    const engine = createAutoEngine({ sessionId: "s1", classifier: scripted });
    const result = await engine.classify(
      call("cmd"),
      ctx({ policy: { mode: "auto", version: 0, rules: emptyRuleSet(), autoConfig: { soft_deny: ["force-push"], allow: ["force-push"] } } }),
    );
    expect(result.verdict).toBe("allow");
  });

  test("an unclassified category never overrides the raw verdict in either direction", async () => {
    const scripted = createScriptedClassifier({ verdict: "deny", category: "unlisted" });
    const engine = createAutoEngine({ sessionId: "s1", classifier: scripted });
    const result = await engine.classify(call("cmd"), ctx());
    expect(result.verdict).toBe("deny"); // still deny -- the backstop never flips deny TO allow
  });
});

describe("createAutoEngine -- classifierContext plumbing (T9's PostToolUse accumulation, §10.4/§10.6-8)", () => {
  test("getClassifierContext's return value reaches the classifier, attributed", async () => {
    const scripted = createScriptedClassifier({ verdict: "no_verdict" });
    const engine = createAutoEngine({
      sessionId: "s1",
      classifier: scripted,
      getClassifierContext: () => [{ hookId: "h1", context: "wrote outside the workspace" }],
    });
    await engine.classify(call("cmd"), ctx());
    expect(scripted.calls[0]!.context.classifierContext).toEqual([{ hookId: "h1", context: "wrote outside the workspace" }]);
  });

  test("omitted getClassifierContext -- an empty array reaches the classifier, never undefined", async () => {
    const scripted = createScriptedClassifier({ verdict: "no_verdict" });
    const engine = createAutoEngine({ sessionId: "s1", classifier: scripted });
    await engine.classify(call("cmd"), ctx());
    expect(scripted.calls[0]!.context.classifierContext).toEqual([]);
  });
});

describe("createAutoEngine -- audit records (WS-07 §10.6-12)", () => {
  function collectingAudit() {
    const records: AutoAuditRecord[] = [];
    return { records, audit: { record: (entry: AutoAuditRecord) => void records.push(entry) } };
  }

  test("a fresh classifier consultation emits permission_evaluated, classifier_started, classifier_result, permission_denied in order", async () => {
    const { records, audit } = collectingAudit();
    const engine = createAutoEngine({ sessionId: "s1", classifier: createScriptedClassifier({ verdict: "deny", category: "cat1" }), audit });
    await engine.classify(call("cmd"), ctx());
    // Fix round 1: a genuine classifier "deny" is ALSO a denial-as-tool_result outcome -- the auto
    // arm's own permission_denied fires as the fourth, final record.
    expect(records.map((r) => r.type)).toEqual(["permission_evaluated", "classifier_started", "classifier_result", "permission_denied"]);
    expect(records[2]).toMatchObject({ verdict: "deny", category: "cat1" });
    expect(records[3]).toMatchObject({ verdict: "deny", category: "cat1" });
  });

  test("a fresh classifier 'allow' does NOT emit permission_denied", async () => {
    const { records, audit } = collectingAudit();
    const engine = createAutoEngine({ sessionId: "s1", classifier: createScriptedClassifier({ verdict: "allow" }), audit });
    await engine.classify(call("cmd"), ctx());
    expect(records.map((r) => r.type)).toEqual(["permission_evaluated", "classifier_started", "classifier_result"]);
  });

  test("P2's real production path -- alwaysNoVerdictClassifier's no_verdict ALSO emits permission_denied under auto (fail-closed denial-as-tool_result, WS-07 §10.6-5)", async () => {
    const { records, audit } = collectingAudit();
    const engine = createAutoEngine({ sessionId: "s1", classifier: alwaysNoVerdictClassifier, audit });
    await engine.classify(call("cmd"), ctx());
    expect(records.map((r) => r.type)).toEqual(["permission_evaluated", "classifier_started", "classifier_result", "permission_denied"]);
    expect(records[3]).toMatchObject({ verdict: "no_verdict", reasonCode: "p2_no_real_classifier" });
  });

  test("Fix round 1 (advisor review): under PLAN mode, a no_verdict result does NOT emit permission_denied -- classify() cannot know the plan classifier borrow (evaluator.ts) will fall through to a human prompt that may still allow", async () => {
    const { records, audit } = collectingAudit();
    const planPolicy: PolicyState = { mode: "plan", version: 0, rules: emptyRuleSet() };
    const engine = createAutoEngine({ sessionId: "s1", classifier: alwaysNoVerdictClassifier, audit });
    await engine.classify(call("cmd"), ctx({ policy: planPolicy }));
    expect(records.map((r) => r.type)).toEqual(["permission_evaluated", "classifier_started", "classifier_result"]);
  });

  test("Fix round 1 (advisor review): under PLAN mode, a genuine classifier 'deny' STILL emits permission_denied -- deny is terminal in every mode classify() is ever called from", async () => {
    const { records, audit } = collectingAudit();
    const planPolicy: PolicyState = { mode: "plan", version: 0, rules: emptyRuleSet() };
    const engine = createAutoEngine({ sessionId: "s1", classifier: createScriptedClassifier({ verdict: "deny" }), audit });
    await engine.classify(call("cmd"), ctx({ policy: planPolicy }));
    expect(records.map((r) => r.type)).toEqual(["permission_evaluated", "classifier_started", "classifier_result", "permission_denied"]);
  });

  test("a cache hit REPLAYING a denial emits classifier_cache_hit THEN permission_denied, both carrying the full pinned shape", async () => {
    const { records, audit } = collectingAudit();
    const cache = createInMemoryVerdictCache();
    const policy: PolicyState = { mode: "auto", version: 3, rules: emptyRuleSet() };
    const engine = createAutoEngine({ sessionId: "s1", classifier: createScriptedClassifier({ verdict: "deny" }), cache, audit });
    const c = call("same");
    await engine.classify(c, ctx({ policy }));
    records.length = 0;
    await engine.classify(c, ctx({ policy }));
    // Fix round 1: the cache-hit path produces a genuine denial-as-tool_result for THIS call too --
    // a consumer watching permission_denied alone must not miss cache-served denials.
    expect(records.map((r) => r.type)).toEqual(["permission_evaluated", "classifier_cache_hit", "permission_denied"]);
    for (const record of records) {
      expect(record.policyVersion).toBe(3);
      expect(typeof record.policyHash).toBe("string");
      expect(record.policyHash.length).toBeGreaterThan(0);
      expect(typeof record.latencyMs).toBe("number");
      expect(record.latencyMs).toBeGreaterThanOrEqual(0);
      expect(record.model).toBeUndefined();
    }
    expect(new Set(records.map((r) => r.policyHash)).size).toBe(1);
  });

  test("Fix round 1 (advisor review): a cache hit REPLAYING a plan-mode no_verdict does NOT emit permission_denied", async () => {
    const { records, audit } = collectingAudit();
    const cache = createInMemoryVerdictCache();
    const planPolicy: PolicyState = { mode: "plan", version: 0, rules: emptyRuleSet() };
    const engine = createAutoEngine({ sessionId: "s1", classifier: alwaysNoVerdictClassifier, cache, audit });
    const c = call("same");
    await engine.classify(c, ctx({ policy: planPolicy }));
    records.length = 0;
    await engine.classify(c, ctx({ policy: planPolicy }));
    expect(records.map((r) => r.type)).toEqual(["permission_evaluated", "classifier_cache_hit"]);
  });

  test("a cache hit REPLAYING an allow does NOT emit permission_denied", async () => {
    const { records, audit } = collectingAudit();
    const cache = createInMemoryVerdictCache();
    const engine = createAutoEngine({ sessionId: "s1", classifier: createScriptedClassifier({ verdict: "allow" }), cache, audit });
    const c = call("same");
    await engine.classify(c, ctx());
    records.length = 0;
    await engine.classify(c, ctx());
    expect(records.map((r) => r.type)).toEqual(["permission_evaluated", "classifier_cache_hit"]);
  });

  test("fallback-active emits fallback_state instead of consulting the classifier, carrying the full pinned shape", async () => {
    const { records, audit } = collectingAudit();
    const policy: PolicyState = { mode: "auto", version: 5, rules: emptyRuleSet() };
    const engine = createAutoEngine({ sessionId: "s1", classifier: createScriptedClassifier({ verdict: "deny" }), audit });
    for (let i = 0; i < AUTO_FALLBACK_CONSECUTIVE_THRESHOLD; i++) await engine.classify(call(`cmd${i}`), ctx({ policy }));
    records.length = 0;
    await engine.classify(call("cmd-after"), ctx({ policy }));
    expect(records.map((r) => r.type)).toEqual(["permission_evaluated", "fallback_state"]);
    expect(records[1]).toMatchObject({ fallbackActive: true, consecutive: AUTO_FALLBACK_CONSECUTIVE_THRESHOLD });
    for (const record of records) {
      expect(record.policyVersion).toBe(5);
      expect(typeof record.policyHash).toBe("string");
      expect(record.policyHash.length).toBeGreaterThan(0);
      expect(typeof record.latencyMs).toBe("number");
      expect(record.latencyMs).toBeGreaterThanOrEqual(0);
      expect(record.model).toBeUndefined();
    }
  });

  test("an audit recorder that throws never fails the permission decision (auxiliary, mirrors HookAuditRecorder)", async () => {
    const throwingAudit = { record: () => { throw new Error("audit sink is down"); } };
    const engine = createAutoEngine({ sessionId: "s1", classifier: createScriptedClassifier({ verdict: "allow" }), audit: throwingAudit });
    const result = await engine.classify(call("cmd"), ctx());
    expect(result.verdict).toBe("allow");
  });

  test("auditReason is redacted (cwd/home stripped) before it reaches the audit record", async () => {
    const { records, audit } = collectingAudit();
    const scripted = createScriptedClassifier({ verdict: "deny", auditReason: "wrote a secret under /work/.env" });
    const engine = createAutoEngine({ sessionId: "s1", classifier: scripted, audit });
    await engine.classify(call("cmd"), ctx({ cwd: "/work" }));
    const resultRecord = records.find((r) => r.type === "classifier_result")!;
    expect(resultRecord.auditReason).toBe("wrote a secret under <redacted-cwd>/.env");
  });

  test("Fix round 1: every record carries policyVersion/policyHash/latencyMs, computed ONCE and reused; model stays absent (§10.6-12 pinned fields)", async () => {
    const { records, audit } = collectingAudit();
    const policy: PolicyState = { mode: "auto", version: 7, rules: emptyRuleSet() };
    const engine = createAutoEngine({ sessionId: "s1", classifier: createScriptedClassifier({ verdict: "deny" }), audit });
    await engine.classify(call("cmd"), ctx({ policy }));
    expect(records.map((r) => r.type)).toEqual(["permission_evaluated", "classifier_started", "classifier_result", "permission_denied"]);
    for (const record of records) {
      expect(record.policyVersion).toBe(7);
      expect(typeof record.policyHash).toBe("string");
      expect(record.policyHash.length).toBeGreaterThan(0);
      expect(typeof record.latencyMs).toBe("number");
      expect(record.latencyMs).toBeGreaterThanOrEqual(0);
      expect(record.model).toBeUndefined(); // typed-optional, unpopulated until P6/D13
    }
    // Reused, never recomputed per event: identical policyHash on every record from this ONE call.
    expect(new Set(records.map((r) => r.policyHash)).size).toBe(1);
  });

  test("Fix round 1: toolUseId/agentId are stamped on EVERY record kind a single call produces, not just permission_evaluated", async () => {
    const { records, audit } = collectingAudit();
    const engine = createAutoEngine({ sessionId: "s1", classifier: createScriptedClassifier({ verdict: "deny" }), audit });
    const identifiedCall: PermissionCall = { toolName: "Bash", input: { command: "cmd" }, toolUseId: "tu-1", agentId: "agent-1" };
    await engine.classify(identifiedCall, ctx());
    expect(records.length).toBe(4); // permission_evaluated, classifier_started, classifier_result, permission_denied
    for (const record of records) {
      expect(record.toolUseId).toBe("tu-1");
      expect(record.agentId).toBe("agent-1");
    }
  });

  test("Fix round 1: toolUseId/agentId are stamped on fallback_state and on a cache-hit's classifier_cache_hit + permission_denied too", async () => {
    const { records: fallbackRecords, audit: fallbackAudit } = collectingAudit();
    const fallbackEngine = createAutoEngine({ sessionId: "s1", classifier: createScriptedClassifier({ verdict: "deny" }), audit: fallbackAudit });
    for (let i = 0; i < AUTO_FALLBACK_CONSECUTIVE_THRESHOLD; i++) {
      await fallbackEngine.classify({ toolName: "Bash", input: { command: `cmd${i}` }, toolUseId: `tu-${i}`, agentId: "agent-1" }, ctx());
    }
    fallbackRecords.length = 0;
    await fallbackEngine.classify({ toolName: "Bash", input: { command: "cmd-after" }, toolUseId: "tu-after", agentId: "agent-1" }, ctx());
    const fallbackStateRecord = fallbackRecords.find((r) => r.type === "fallback_state")!;
    expect(fallbackStateRecord.toolUseId).toBe("tu-after");
    expect(fallbackStateRecord.agentId).toBe("agent-1");

    const { records: cacheRecords, audit: cacheAudit } = collectingAudit();
    const cache = createInMemoryVerdictCache();
    const cacheEngine = createAutoEngine({ sessionId: "s1", classifier: createScriptedClassifier({ verdict: "deny" }), cache, audit: cacheAudit });
    const identifiedCall: PermissionCall = { toolName: "Bash", input: { command: "same" }, toolUseId: "tu-cache", agentId: "agent-2" };
    await cacheEngine.classify(identifiedCall, ctx());
    cacheRecords.length = 0;
    await cacheEngine.classify(identifiedCall, ctx());
    expect(cacheRecords.map((r) => r.type)).toEqual(["permission_evaluated", "classifier_cache_hit", "permission_denied"]);
    for (const record of cacheRecords) {
      expect(record.toolUseId).toBe("tu-cache");
      expect(record.agentId).toBe("agent-2");
    }
  });

  // Item 11 (P2 fix-wave): the headless-fallback audit gap. A fallback trip's own "fallback_state"
  // record (above) fires BEFORE any human involvement is even attempted -- it does NOT itself mean
  // the call was denied, only that the classifier was skipped. The actual denial only happens later,
  // in evaluator.ts's resolveAutoDecision, once NEITHER a PermissionRequest hook NOR canUseTool
  // answers -- structurally outside classify()'s own call, which already returned. Pre-fix, that
  // denial had no matching AutoAuditRecord anywhere.
  test("Item 11: noteHeadlessFallbackDenial emits a permission_denied audit record carrying the pinned policy/latency shape", async () => {
    const { records, audit } = collectingAudit();
    const engine = createAutoEngine({ sessionId: "s1", audit });
    const policy: PolicyState = { mode: "auto", version: 3, rules: emptyRuleSet() };
    const evalCtx = ctx({ policy });
    const identifiedCall: PermissionCall = { toolName: "Bash", input: { command: "long-task" }, toolUseId: "tu-headless", agentId: "agent-3" };

    await engine.noteHeadlessFallbackDenial?.(identifiedCall, evalCtx);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: "permission_denied",
      sessionId: "s1",
      toolName: "Bash",
      toolUseId: "tu-headless",
      agentId: "agent-3",
      policyVersion: 3,
      reasonCode: "auto_fallback_no_prompt_handler",
    });
    expect(typeof records[0]!.policyHash).toBe("string");
    expect(records[0]!.policyHash.length).toBeGreaterThan(0);
    expect(typeof records[0]!.at).toBe("string");
  });

  test("Item 11: the NO_OP audit sink (createAutoEngine's own default) makes noteHeadlessFallbackDenial a safe no-op -- never throws", async () => {
    const engine = createAutoEngine({ sessionId: "s1" }); // no `audit` option -- defaults to NO_OP_AUTO_AUDIT_RECORDER
    await expect(engine.noteHeadlessFallbackDenial?.(call("cmd"), ctx())).resolves.toBeUndefined();
  });
});

describe("redactAuditReason -- unit", () => {
  test("undefined passes through as undefined", () => {
    expect(redactAuditReason(undefined, { cwd: "/work", home: "/home/u" })).toBeUndefined();
  });

  test("strips both cwd and home occurrences", () => {
    expect(redactAuditReason("saw /home/u/.ssh and /work/secrets", { cwd: "/work", home: "/home/u" })).toBe("saw <redacted-home>/.ssh and <redacted-cwd>/secrets");
  });

  test("a reason with neither path is returned unchanged", () => {
    expect(redactAuditReason("nothing sensitive here", { cwd: "/work", home: "/home/u" })).toBe("nothing sensitive here");
  });
});
