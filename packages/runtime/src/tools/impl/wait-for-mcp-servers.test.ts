// Phase 4 Task 5 (LANE B, WS-09 §8.4): fixtures for both the pure `executeWaitForMcpServers`
// algorithm and the real ctx-adapter executor. `createFakeMcpServerStateSource` (mcp/state.ts,
// T2-authored) is the only McpServerStateSource this file ever touches.
import { describe, test, expect } from "bun:test";
import { createSessionReadState } from "../read-state.ts";
import { getRegisteredTool, buildAdvertisedSet, type ToolExecutionContext } from "../registry.ts";
import { createFakeMcpServerStateSource } from "../../mcp/state.ts";
import { registerToolSearchSessionRuntime, type ToolSearchSessionRuntime } from "../../toolsearch/search.ts";
import { WAIT_FOR_MCP_SERVERS_TOOL_NAME, waitForMcpServersExecutor, executeWaitForMcpServers } from "./wait-for-mcp-servers.ts";

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    cwd: "/work",
    home: "/synthetic/home/tester",
    sessionId: "t5-wfms-session",
    readState: createSessionReadState(),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: "/tmp/winter-test",
    sandboxSettings: {},
    session: {
      setCwd() {},
      addBoundedRoot() {},
      removeBoundedRoot() {},
      setPermissionMode() {},
      getBoundedRoots: () => [],
      getPermissionMode: () => "default",
      getSessionRoot: () => "/work",
      setSessionRoot() {},
    },
    ...overrides,
  };
}

describe("executeWaitForMcpServers -- pure algorithm", () => {
  test("no stateSource at all -> vacuously ready, unknown echoes back requested names", async () => {
    const outcome = await executeWaitForMcpServers({ servers: ["ghost"] }, {});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result).toEqual({ ready: true, connected: [], failed: [], stillPending: [], needsAuth: [], disabled: [], unknown: ["ghost"] });
  });

  test("a non-array/non-string `servers` input is a typed error, not a crash", async () => {
    const outcome = await executeWaitForMcpServers({ servers: "not-an-array" }, {});
    expect(outcome.ok).toBe(false);
  });

  test("dedicated regression: unconfigured is reported but excluded from the ready calculation (WS-09 §8.4 quirk)", async () => {
    const state = createFakeMcpServerStateSource([
      { name: "gh", state: "connected", toolNames: ["list_issues"] },
      { name: "ghost_server", state: "unconfigured", toolNames: [] },
    ]);
    const outcome = await executeWaitForMcpServers({}, { stateSource: state, pendingWaitMs: 50 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.ready).toBe(true); // NOT disqualified by the unconfigured entry
    expect(outcome.result.unconfigured).toEqual(["ghost_server"]);
    expect(outcome.result.failed).toEqual([]); // never double-counted as "failed" too
    expect(outcome.result.connected).toEqual(["gh"]);
  });

  test("cached counts as ready", async () => {
    const state = createFakeMcpServerStateSource([{ name: "cachedSrv", state: "cached", toolNames: ["t"] }]);
    const outcome = await executeWaitForMcpServers({}, { stateSource: state, pendingWaitMs: 50 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.ready).toBe(true);
    expect(outcome.result.cached).toEqual(["cachedSrv"]);
  });

  test("a real failure (not unconfigured) makes ready false and is reported in `failed`", async () => {
    const state = createFakeMcpServerStateSource([{ name: "broken", state: "failed", errorCode: "E1", error: "boom", toolNames: [] }]);
    const outcome = await executeWaitForMcpServers({}, { stateSource: state, pendingWaitMs: 50 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.ready).toBe(false);
    expect(outcome.result.failed).toEqual(["broken"]);
    expect(outcome.result.unconfigured).toBeUndefined();
  });

  test("still-pending, needsAuth, and disabled each independently make ready false", async () => {
    for (const state of ["pending", "needsAuth", "disabled"] as const) {
      const source = createFakeMcpServerStateSource([{ name: "srv", state, toolNames: [] }]);
      const outcome = await executeWaitForMcpServers({}, { stateSource: source, pendingWaitMs: 20 });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) continue;
      expect(outcome.result.ready).toBe(false);
    }
  });

  test("an explicitly-requested name absent from the snapshot is `unknown`, not silently dropped", async () => {
    const state = createFakeMcpServerStateSource([{ name: "real_server", state: "connected", toolNames: [] }]);
    const outcome = await executeWaitForMcpServers({ servers: ["real_server", "nonexistent"] }, { stateSource: state, pendingWaitMs: 20 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.unknown).toEqual(["nonexistent"]);
    expect(outcome.result.ready).toBe(false); // an unknown requested name also disqualifies readiness
  });

  test("omitting `servers` waits for every currently-known server, never producing a spurious `unknown`", async () => {
    const state = createFakeMcpServerStateSource([
      { name: "a", state: "connected", toolNames: [] },
      { name: "b", state: "connected", toolNames: [] },
    ]);
    const outcome = await executeWaitForMcpServers({}, { stateSource: state, pendingWaitMs: 20 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.unknown).toEqual([]);
    expect(outcome.result.connected.sort()).toEqual(["a", "b"]);
  });

  test("replRouted is never populated -- no signal exists on McpServerState to compute it from", async () => {
    const state = createFakeMcpServerStateSource([{ name: "a", state: "connected", toolNames: [] }]);
    const outcome = await executeWaitForMcpServers({}, { stateSource: state, pendingWaitMs: 20 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result).not.toHaveProperty("replRouted");
  });

  test("waits up to the deadline for a server that never leaves pending", async () => {
    const state = createFakeMcpServerStateSource([{ name: "stuck", state: "pending", toolNames: [] }]);
    const started = Date.now();
    const outcome = await executeWaitForMcpServers({ servers: ["stuck"] }, { stateSource: state, pendingWaitMs: 40 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.stillPending).toEqual(["stuck"]);
    expect(outcome.result.ready).toBe(false);
  });

  test("resolves early once a transition clears the awaited server, before the deadline", async () => {
    const state = createFakeMcpServerStateSource([{ name: "gh", state: "pending", toolNames: [] }]);
    setTimeout(() => state.transition("gh", "connected", { toolNames: ["list_issues"] }), 5);
    const started = Date.now();
    const outcome = await executeWaitForMcpServers({ servers: ["gh"] }, { stateSource: state, pendingWaitMs: 5000 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.connected).toEqual(["gh"]);
    expect(outcome.result.ready).toBe(true);
  });
});

describe("WaitForMcpServers -- advertised only when Tool Search is disabled (verify, don't edit the descriptor)", () => {
  test("advertised when toolSearchEnabled: false, absent when toolSearchEnabled: true", () => {
    const disabledSet = buildAdvertisedSet({ mode: "default", capabilities: ["winter.mcp"], toolSearchEnabled: false });
    expect(disabledSet.map((d) => d.canonicalName)).toContain(WAIT_FOR_MCP_SERVERS_TOOL_NAME);

    const enabledSet = buildAdvertisedSet({ mode: "default", capabilities: ["winter.mcp"], toolSearchEnabled: true });
    expect(enabledSet.map((d) => d.canonicalName)).not.toContain(WAIT_FOR_MCP_SERVERS_TOOL_NAME);
  });
});

describe("waitForMcpServersExecutor -- ctx-adapter", () => {
  test("module load installs a real executor over the WS-06 stub", () => {
    const registered = getRegisteredTool(WAIT_FOR_MCP_SERVERS_TOOL_NAME);
    expect(registered?.executor).toBeDefined();
  });

  test("a session with no registered runtime gets a typed, non-crashing error", async () => {
    const ctx = makeCtx({ sessionId: "t5-wfms-never-registered" });
    const result = await waitForMcpServersExecutor.execute({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.output.toLowerCase()).toContain("no session runtime registered");
  });

  test("a registered runtime with a real stateSource answers end to end", async () => {
    const sessionId = "t5-wfms-e2e-session";
    const state = createFakeMcpServerStateSource([{ name: "gh", state: "connected", toolNames: ["list_issues"] }]);
    const runtime: ToolSearchSessionRuntime = { getMode: () => "default", activation: { enableToolSearch: "false", providerSupportsToolSearch: true, deferrableContextShare: 0 }, stateSource: state, pendingWaitMs: 50 };
    const unregister = registerToolSearchSessionRuntime(sessionId, runtime);
    try {
      const ctx = makeCtx({ sessionId });
      const result = await waitForMcpServersExecutor.execute({}, ctx);
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.output);
      expect(parsed.ready).toBe(true);
      expect(parsed.connected).toEqual(["gh"]);
    } finally {
      unregister();
    }
  });

  test("a registered runtime with NO stateSource (genuinely zero MCP servers this session) answers vacuously ready, not an error", async () => {
    const sessionId = "t5-wfms-no-servers-session";
    const unregister = registerToolSearchSessionRuntime(sessionId, { getMode: () => "default", activation: { enableToolSearch: "false", providerSupportsToolSearch: true, deferrableContextShare: 0 } });
    try {
      const ctx = makeCtx({ sessionId });
      const result = await waitForMcpServersExecutor.execute({}, ctx);
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.output);
      expect(parsed.ready).toBe(true);
    } finally {
      unregister();
    }
  });
});
