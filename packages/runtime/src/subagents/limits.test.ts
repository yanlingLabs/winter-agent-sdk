import { describe, test, expect, beforeEach } from "bun:test";
import {
  checkAndRegisterSpawn,
  releaseSpawn,
  currentRunningSubagentCount,
  resetSpawnLimitsForTest,
  resolveMaxSpawnDepth,
  resolveMaxConcurrentSubagents,
  SpawnDepthExceededError,
  SpawnConcurrencyExceededError,
} from "./limits.ts";

beforeEach(() => resetSpawnLimitsForTest());

describe("resolveMaxSpawnDepth / resolveMaxConcurrentSubagents (WS-10 §6 defaults + env)", () => {
  test("defaults: depth 3, concurrency 20", () => {
    expect(resolveMaxSpawnDepth({})).toBe(3);
    expect(resolveMaxConcurrentSubagents({})).toBe(20);
  });

  test("env overrides both", () => {
    expect(resolveMaxSpawnDepth({ WINTER_MAX_SUBAGENT_SPAWN_DEPTH: "5" })).toBe(5);
    expect(resolveMaxConcurrentSubagents({ WINTER_MAX_CONCURRENT_SUBAGENTS: "1" })).toBe(1);
  });

  test("a non-positive-integer env value falls back to the default rather than adopting garbage", () => {
    expect(resolveMaxSpawnDepth({ WINTER_MAX_SUBAGENT_SPAWN_DEPTH: "0" })).toBe(3);
    expect(resolveMaxSpawnDepth({ WINTER_MAX_SUBAGENT_SPAWN_DEPTH: "-1" })).toBe(3);
    expect(resolveMaxSpawnDepth({ WINTER_MAX_SUBAGENT_SPAWN_DEPTH: "abc" })).toBe(3);
    expect(resolveMaxSpawnDepth({ WINTER_MAX_SUBAGENT_SPAWN_DEPTH: "1.5" })).toBe(3);
  });
});

describe("checkAndRegisterSpawn / releaseSpawn (depth chain)", () => {
  test("a first-level child (unknown parent id) gets depth 1", () => {
    const { depth } = checkAndRegisterSpawn({ parentSessionId: "top", childSessionId: "child-a", env: {} });
    expect(depth).toBe(1);
  });

  test("a grandchild registers at depth 2, keyed by the CHILD's own sessionId as the next parent", () => {
    checkAndRegisterSpawn({ parentSessionId: "top", childSessionId: "child-a", env: {} });
    const { depth } = checkAndRegisterSpawn({ parentSessionId: "child-a", childSessionId: "child-a-1", env: {} });
    expect(depth).toBe(2);
  });

  test("depth 4 with the default max of 3 throws SpawnDepthExceededError, naming both values", () => {
    checkAndRegisterSpawn({ parentSessionId: "top", childSessionId: "c1", env: {} }); // depth 1
    checkAndRegisterSpawn({ parentSessionId: "c1", childSessionId: "c2", env: {} }); // depth 2
    checkAndRegisterSpawn({ parentSessionId: "c2", childSessionId: "c3", env: {} }); // depth 3 (== max, allowed)
    expect(() => checkAndRegisterSpawn({ parentSessionId: "c3", childSessionId: "c4", env: {} })).toThrow(SpawnDepthExceededError);
    try {
      checkAndRegisterSpawn({ parentSessionId: "c3", childSessionId: "c4-again", env: {} });
      throw new Error("unreachable");
    } catch (err) {
      expect(err).toBeInstanceOf(SpawnDepthExceededError);
      expect((err as SpawnDepthExceededError).depth).toBe(4);
      expect((err as SpawnDepthExceededError).max).toBe(3);
    }
  });

  test("a custom WINTER_MAX_SUBAGENT_SPAWN_DEPTH is honored", () => {
    const env = { WINTER_MAX_SUBAGENT_SPAWN_DEPTH: "1" };
    checkAndRegisterSpawn({ parentSessionId: "top", childSessionId: "c1", env }); // depth 1, at the max
    expect(() => checkAndRegisterSpawn({ parentSessionId: "c1", childSessionId: "c2", env })).toThrow(SpawnDepthExceededError);
  });

  test("releaseSpawn frees the depth-table entry -- a NEW spawn reusing that same id starts fresh at depth 1", () => {
    checkAndRegisterSpawn({ parentSessionId: "top", childSessionId: "c1", env: {} });
    releaseSpawn("c1");
    const { depth } = checkAndRegisterSpawn({ parentSessionId: "c1", childSessionId: "c1-child", env: {} });
    expect(depth).toBe(1); // "c1" is no longer registered, so it reads back as an unknown (depth-0) parent
  });

  test("releaseSpawn is idempotent -- a second call for an already-released id is a silent no-op", () => {
    checkAndRegisterSpawn({ parentSessionId: "top", childSessionId: "c1", env: {} });
    expect(currentRunningSubagentCount()).toBe(1);
    releaseSpawn("c1");
    expect(currentRunningSubagentCount()).toBe(0);
    releaseSpawn("c1");
    expect(currentRunningSubagentCount()).toBe(0);
  });
});

describe("checkAndRegisterSpawn (concurrency)", () => {
  test("the 21st concurrent spawn (default max 20) throws SpawnConcurrencyExceededError", () => {
    for (let i = 0; i < 20; i++) {
      checkAndRegisterSpawn({ parentSessionId: "top", childSessionId: `c${i}`, env: {} });
    }
    expect(currentRunningSubagentCount()).toBe(20);
    expect(() => checkAndRegisterSpawn({ parentSessionId: "top", childSessionId: "c20", env: {} })).toThrow(SpawnConcurrencyExceededError);
  });

  test("releasing one running child frees a concurrency slot for a new one", () => {
    const env = { WINTER_MAX_CONCURRENT_SUBAGENTS: "1" };
    checkAndRegisterSpawn({ parentSessionId: "top", childSessionId: "c1", env });
    expect(() => checkAndRegisterSpawn({ parentSessionId: "top", childSessionId: "c2", env })).toThrow(SpawnConcurrencyExceededError);
    releaseSpawn("c1");
    expect(() => checkAndRegisterSpawn({ parentSessionId: "top", childSessionId: "c2", env })).not.toThrow();
  });

  test("a depth violation is checked (and throws) even when concurrency has headroom -- both gates apply independently", () => {
    const env = { WINTER_MAX_SUBAGENT_SPAWN_DEPTH: "1", WINTER_MAX_CONCURRENT_SUBAGENTS: "20" };
    checkAndRegisterSpawn({ parentSessionId: "top", childSessionId: "c1", env });
    expect(() => checkAndRegisterSpawn({ parentSessionId: "c1", childSessionId: "c2", env })).toThrow(SpawnDepthExceededError);
    expect(currentRunningSubagentCount()).toBe(1); // the rejected spawn never incremented the counter
  });
});
