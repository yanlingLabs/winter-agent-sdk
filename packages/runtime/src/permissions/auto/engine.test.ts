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

  test("a fresh classifier consultation emits permission_evaluated, classifier_started, classifier_result in order", async () => {
    const { records, audit } = collectingAudit();
    const engine = createAutoEngine({ sessionId: "s1", classifier: createScriptedClassifier({ verdict: "deny", category: "cat1" }), audit });
    await engine.classify(call("cmd"), ctx());
    expect(records.map((r) => r.type)).toEqual(["permission_evaluated", "classifier_started", "classifier_result"]);
    expect(records[2]).toMatchObject({ verdict: "deny", category: "cat1" });
  });

  test("a cache hit emits classifier_cache_hit instead of classifier_started/classifier_result", async () => {
    const { records, audit } = collectingAudit();
    const cache = createInMemoryVerdictCache();
    const engine = createAutoEngine({ sessionId: "s1", classifier: createScriptedClassifier({ verdict: "deny" }), cache, audit });
    const c = call("same");
    await engine.classify(c, ctx());
    records.length = 0;
    await engine.classify(c, ctx());
    expect(records.map((r) => r.type)).toEqual(["permission_evaluated", "classifier_cache_hit"]);
  });

  test("fallback-active emits fallback_state instead of consulting the classifier", async () => {
    const { records, audit } = collectingAudit();
    const engine = createAutoEngine({ sessionId: "s1", classifier: createScriptedClassifier({ verdict: "deny" }), audit });
    for (let i = 0; i < AUTO_FALLBACK_CONSECUTIVE_THRESHOLD; i++) await engine.classify(call(`cmd${i}`), ctx());
    records.length = 0;
    await engine.classify(call("cmd-after"), ctx());
    expect(records.map((r) => r.type)).toEqual(["permission_evaluated", "fallback_state"]);
    expect(records[1]).toMatchObject({ fallbackActive: true, consecutive: AUTO_FALLBACK_CONSECUTIVE_THRESHOLD });
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
