// Task 12 (WS-07 §10.5/§10.6-10/§10.6-11): verdict cache invalidation matrix + fallback counters,
// including restart-durability of the file-backed counter store.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computePolicyHash,
  computeEnvHash,
  computeActionFingerprint,
  createInMemoryVerdictCache,
  createInMemoryAutoCounterStore,
  createFileAutoCounterStore,
  isFallbackActive,
  AUTO_FALLBACK_CONSECUTIVE_THRESHOLD,
  AUTO_FALLBACK_TOTAL_THRESHOLD,
  type AutoVerdictCacheKey,
} from "./caches.ts";
import { emptyRuleSet, sourceRule } from "../ruleset.ts";
import type { PolicyState } from "../policy-state.ts";

function policy(overrides: Partial<PolicyState> = {}): PolicyState {
  return { mode: "auto", version: 0, rules: emptyRuleSet(), ...overrides };
}

describe("computePolicyHash -- content-based, independent of `version`", () => {
  test("identical mode/rules/autoConfig hash identically even with different `version` counters", () => {
    const a = policy({ version: 3 });
    const b = policy({ version: 99 });
    expect(computePolicyHash(a)).toBe(computePolicyHash(b));
  });

  test("a different mode changes the hash", () => {
    expect(computePolicyHash(policy({ mode: "auto" }))).not.toBe(computePolicyHash(policy({ mode: "default" })));
  });

  test("a different rule set changes the hash", () => {
    const withRule = policy({ rules: { ...emptyRuleSet(), entries: [sourceRule({ toolName: "Bash", ruleContent: "npm test" }, "allow", "sdk")] } });
    expect(computePolicyHash(withRule)).not.toBe(computePolicyHash(policy()));
  });

  test("a different autoConfig changes the hash", () => {
    expect(computePolicyHash(policy({ autoConfig: { classifyAllShell: true } }))).not.toBe(computePolicyHash(policy({ autoConfig: { classifyAllShell: false } })));
  });
});

describe("computeEnvHash -- trust-environment fingerprint", () => {
  const base = { cwd: "/work", home: "/home/u", trustedWorkspace: false };

  test("identical inputs hash identically", () => {
    expect(computeEnvHash(base)).toBe(computeEnvHash({ ...base }));
  });

  test("a different cwd changes the hash", () => {
    expect(computeEnvHash(base)).not.toBe(computeEnvHash({ ...base, cwd: "/other" }));
  });

  test("sessionBypassEnabled participates in the hash", () => {
    expect(computeEnvHash(base)).not.toBe(computeEnvHash({ ...base, sessionBypassEnabled: true }));
  });

  test("additionalDirectories order does not matter (sorted before hashing)", () => {
    expect(computeEnvHash({ ...base, additionalDirectories: ["/b", "/a"] })).toBe(computeEnvHash({ ...base, additionalDirectories: ["/a", "/b"] }));
  });
});

describe("computeActionFingerprint -- never reuses across materially different arguments", () => {
  test("identical tool+input fingerprint identically", () => {
    expect(computeActionFingerprint({ toolName: "Bash", input: { command: "ls" } })).toBe(computeActionFingerprint({ toolName: "Bash", input: { command: "ls" } }));
  });

  test("a different command changes the fingerprint", () => {
    expect(computeActionFingerprint({ toolName: "Bash", input: { command: "ls" } })).not.toBe(computeActionFingerprint({ toolName: "Bash", input: { command: "rm -rf /" } }));
  });
});

describe("AutoVerdictCache -- invalidation matrix (every key axis independently breaks a hit)", () => {
  const base: AutoVerdictCacheKey = { policyHash: "p1", envHash: "e1", sessionId: "s1", generation: 0, actionFingerprint: "a1" };
  const entry = { verdict: { verdict: "allow" as const }, cachedAt: "2026-01-01T00:00:00.000Z" };

  test("an exact key match is a hit", () => {
    const cache = createInMemoryVerdictCache();
    cache.set(base, entry);
    expect(cache.get({ ...base })).toEqual(entry);
  });

  test("a miss returns undefined", () => {
    const cache = createInMemoryVerdictCache();
    expect(cache.get(base)).toBeUndefined();
  });

  for (const [axis, override] of Object.entries({
    policyHash: { policyHash: "p2" },
    envHash: { envHash: "e2" },
    sessionId: { sessionId: "s2" },
    generation: { generation: 1 },
    actionFingerprint: { actionFingerprint: "a2" },
    host: { host: "example.com" },
    port: { port: 443 },
  })) {
    test(`changing ${axis} alone invalidates (misses) -- new content/turn/compaction is a generation bump; mode/rule/environment change is policyHash/envHash`, () => {
      const cache = createInMemoryVerdictCache();
      cache.set(base, entry);
      expect(cache.get({ ...base, ...override })).toBeUndefined();
    });
  }
});

describe("fallback counters -- 3-consecutive / 20-total (WS-07 §10.5/§10.6-11)", () => {
  test("consecutive denies trip fallback at exactly the threshold", () => {
    const store = createInMemoryAutoCounterStore();
    for (let i = 0; i < AUTO_FALLBACK_CONSECUTIVE_THRESHOLD - 1; i++) store.recordDeny("s1");
    expect(isFallbackActive(store.get("s1"))).toBe(false);
    store.recordDeny("s1");
    expect(isFallbackActive(store.get("s1"))).toBe(true);
  });

  test("an allowed action resets consecutive, NOT total", () => {
    const store = createInMemoryAutoCounterStore();
    store.recordDeny("s1");
    store.recordDeny("s1");
    store.recordAllow("s1");
    const state = store.get("s1");
    expect(state.consecutive).toBe(0);
    expect(state.total).toBe(2); // total persists
    expect(isFallbackActive(state)).toBe(false);
  });

  test("resetting consecutive un-trips a PURELY consecutive-triggered fallback (not sticky, unlike total)", () => {
    const store = createInMemoryAutoCounterStore();
    for (let i = 0; i < AUTO_FALLBACK_CONSECUTIVE_THRESHOLD; i++) store.recordDeny("s1");
    expect(isFallbackActive(store.get("s1"))).toBe(true);
    store.recordAllow("s1");
    expect(isFallbackActive(store.get("s1"))).toBe(false);
  });

  test("20 total denies trip fallback even if never 3 in a row, and it is STICKY (an allow cannot clear it)", () => {
    const store = createInMemoryAutoCounterStore();
    for (let i = 0; i < AUTO_FALLBACK_TOTAL_THRESHOLD; i++) {
      store.recordDeny("s1");
      store.recordAllow("s1"); // resets consecutive every time -- never hits the 3-consecutive path
    }
    const state = store.get("s1");
    expect(state.total).toBe(AUTO_FALLBACK_TOTAL_THRESHOLD);
    expect(isFallbackActive(state)).toBe(true);
    store.recordAllow("s1");
    expect(isFallbackActive(store.get("s1"))).toBe(true); // total-triggered fallback persists for the rest of the session
  });

  test("no-verdict/refusal cases are simply never recorded -- counters stay at zero when neither recordDeny nor recordAllow is called", () => {
    const store = createInMemoryAutoCounterStore();
    expect(store.get("s1")).toEqual({ consecutive: 0, total: 0 });
  });

  test("different sessions have independent counters", () => {
    const store = createInMemoryAutoCounterStore();
    store.recordDeny("s1");
    expect(store.get("s2")).toEqual({ consecutive: 0, total: 0 });
  });
});

describe("createFileAutoCounterStore -- restart-durable (WS-07 §10.5: 'a daemon restart does not silently reset a safety fallback')", () => {
  function withTempHome<T>(fn: (winterHome: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "winter-auto-state-"));
    try {
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("counters survive a reopen against the same location", () => {
    withTempHome((winterHome) => {
      const location = { winterHome, projectKey: "proj1", sessionId: "sess1" };
      const first = createFileAutoCounterStore(location);
      first.recordDeny("sess1"); // sessionId param is the LOOKUP key on the interface; the file itself is already scoped to one session
      first.recordDeny("sess1");
      expect(first.get("sess1")).toEqual({ consecutive: 2, total: 2 });

      const reopened = createFileAutoCounterStore(location);
      expect(reopened.get("sess1")).toEqual({ consecutive: 2, total: 2 });
    });
  });

  test("a fresh session location with no prior file starts at zero", () => {
    withTempHome((winterHome) => {
      const store = createFileAutoCounterStore({ winterHome, projectKey: "proj1", sessionId: "brand-new" });
      expect(store.get("brand-new")).toEqual({ consecutive: 0, total: 0 });
    });
  });

  test("fallback state (3-consecutive) survives a reopen", () => {
    withTempHome((winterHome) => {
      const location = { winterHome, projectKey: "proj1", sessionId: "sess1" };
      const first = createFileAutoCounterStore(location);
      for (let i = 0; i < AUTO_FALLBACK_CONSECUTIVE_THRESHOLD; i++) first.recordDeny("sess1");
      expect(isFallbackActive(first.get("sess1"))).toBe(true);

      const reopened = createFileAutoCounterStore(location);
      expect(isFallbackActive(reopened.get("sess1"))).toBe(true);
    });
  });

  test("directory chain is created 0700 and the file is written 0600 (secure-dir discipline, mirrors approvals.ts)", () => {
    withTempHome((winterHome) => {
      const store = createFileAutoCounterStore({ winterHome, projectKey: "proj1", sessionId: "sess1" });
      store.recordDeny("sess1");
      const { statSync } = require("node:fs") as typeof import("node:fs");
      const filePath = join(winterHome, "projects", "proj1", "sess1.auto-state.json");
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
      expect(statSync(join(winterHome, "projects", "proj1")).mode & 0o777).toBe(0o700);
    });
  });
});
