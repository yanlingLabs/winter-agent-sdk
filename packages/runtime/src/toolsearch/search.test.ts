// WS-09 §8.2/§8.5 fixtures for `executeToolSearch`. Every scenario drives REAL registrations through
// the live registry (registerMcpServerTools/unregisterMcpServerTools) -- ground truth, never a
// hand-built candidate list. `createFakeMcpServerStateSource` (mcp/state.ts, Lane A's own seam,
// T2-authored) is the ONLY McpServerStateSource this file ever touches -- never a real transport.
import { describe, test, expect, afterEach } from "bun:test";
import {
  registerMcpServerTools,
  unregisterMcpServerTools,
  createLoadedToolSet,
  isLoadFirstBlocked,
  type DeferralActivation,
} from "../tools/registry.ts";
import { createFakeMcpServerStateSource } from "../mcp/state.ts";
import {
  executeToolSearch,
  registerToolSearchSessionRuntime,
  unregisterToolSearchSessionRuntime,
  getToolSearchSessionRuntime,
  type ToolSearchDeps,
  type ToolSearchSessionRuntime,
} from "./search.ts";

const SRV = "t5searchsrv";
const ACTIVE: DeferralActivation = { enableToolSearch: "true", providerSupportsToolSearch: true, deferrableContextShare: 100 };

function baseDeps(overrides: Partial<ToolSearchDeps> = {}): ToolSearchDeps {
  return {
    getMode: () => "default",
    activation: ACTIVE,
    capabilities: ["winter.mcp"],
    pendingWaitMs: 50, // short in every test unless a scenario overrides it -- never sleeps the real 5s
    ...overrides,
  };
}

describe("executeToolSearch -- input validation", () => {
  test("a non-string query is a typed error, not a crash", async () => {
    const outcome = await executeToolSearch({ query: 42 }, baseDeps());
    expect(outcome.ok).toBe(false);
  });
});

describe("executeToolSearch -- select: (WS-09 §8.2, untruncated, resolves against eager+deferred only)", () => {
  test("select:A,B resolves multiple names and is NOT truncated by max_results", async () => {
    try {
      registerMcpServerTools(SRV, [{ name: "alpha", inputSchema: { type: "object" } }, { name: "beta", inputSchema: { type: "object" } }, { name: "gamma", inputSchema: { type: "object" } }], {
        deferredDefault: true,
      });
      const [a, b, c] = [`mcp__${SRV}__alpha`, `mcp__${SRV}__beta`, `mcp__${SRV}__gamma`];
      const outcome = await executeToolSearch({ query: `select:${a},${b},${c}`, max_results: 1 }, baseDeps());
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.result.matches).toHaveLength(3); // max_results:1 never applies to select:
      expect(outcome.result.matches).toEqual(expect.arrayContaining([a, b, c]));
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("select: silently omits an unresolvable name from matches (no error field exists in the pinned shape)", async () => {
    const outcome = await executeToolSearch({ query: "select:__totally_unknown_tool__" }, baseDeps());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.matches).toEqual([]);
  });

  test("select: can resolve an EAGER (non-deferred) name too -- WS-09 §8.2 does not scope selection to the deferred pool", async () => {
    try {
      registerMcpServerTools(SRV, [{ name: "already_eager", inputSchema: { type: "object" } }], { deferredDefault: false });
      const name = `mcp__${SRV}__already_eager`;
      const outcome = await executeToolSearch({ query: `select:${name}` }, baseDeps());
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.result.matches).toEqual([name]);
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("select: never resolves a name excluded from the advertised set -- ground truth is the live partition, not the raw registry", async () => {
    try {
      // NOTE: `partition.hidden` itself is structurally always `[]` here -- buildAdvertisedSet
      // filters exposure==="hidden" and any mode mismatch out BEFORE resolveDeferral ever runs
      // (registry.ts), so there is no live "hidden" descriptor this fixture could select against
      // directly. What this proves instead is the broader, equally load-bearing claim: select:
      // checks membership in the partition's own eager+deferred union (computeExposurePartition),
      // never a raw getRegisteredTool(name) lookup that would ignore availability entirely -- using
      // the capability-gate axis as the concrete exclusion mechanism. Every live MCP registration is
      // gated on "winter.mcp" -- omit it from deps entirely to prove select can't bypass that gate.
      registerMcpServerTools(SRV, [{ name: "capability_gated", inputSchema: { type: "object" } }], { deferredDefault: true });
      const name = `mcp__${SRV}__capability_gated`;
      const outcome = await executeToolSearch({ query: `select:${name}` }, baseDeps({ capabilities: [] }));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.result.matches).toEqual([]); // not selectable without the capability that makes it exist at all
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });
});

describe("executeToolSearch -- keyword search (WS-09 §8.3, search-considers-names/descriptions)", () => {
  test("a deferred tool is discoverable by its own name token", async () => {
    try {
      registerMcpServerTools(SRV, [{ name: "list_issues", description: "Lists GitHub issues", inputSchema: { type: "object" } }], { deferredDefault: true });
      const name = `mcp__${SRV}__list_issues`;
      const outcome = await executeToolSearch({ query: "list_issues" }, baseDeps());
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.result.matches).toContain(name);
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("a deferred tool is discoverable by a description token", async () => {
    try {
      registerMcpServerTools(SRV, [{ name: "opaque_name_1", description: "posts a message to a chat channel", inputSchema: { type: "object" } }], { deferredDefault: true });
      const name = `mcp__${SRV}__opaque_name_1`;
      const outcome = await executeToolSearch({ query: "channel" }, baseDeps());
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.result.matches).toContain(name);
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("keyword search does NOT resurface an already-eager tool as a match", async () => {
    try {
      registerMcpServerTools(SRV, [{ name: "eager_findme", description: "findme description", inputSchema: { type: "object" } }], { deferredDefault: false });
      const name = `mcp__${SRV}__eager_findme`;
      const outcome = await executeToolSearch({ query: "findme" }, baseDeps());
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.result.matches).not.toContain(name);
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("total_deferred_tools reflects the live deferred pool size", async () => {
    try {
      registerMcpServerTools(SRV, [{ name: "one", inputSchema: { type: "object" } }, { name: "two", inputSchema: { type: "object" } }], { deferredDefault: true });
      const outcome = await executeToolSearch({ query: "nonmatchingquery" }, baseDeps());
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.result.total_deferred_tools).toBeGreaterThanOrEqual(2);
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });
});

describe("executeToolSearch -- result shape (WS-09 §8.2, exact fields)", () => {
  test("query is echoed verbatim; optional fields are omitted, not present-as-empty, when there is nothing to report", async () => {
    const outcome = await executeToolSearch({ query: "select:nothing_matches_this" }, baseDeps());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.query).toBe("select:nothing_matches_this");
    expect(outcome.result).not.toHaveProperty("pending_mcp_servers");
    expect(outcome.result).not.toHaveProperty("failed_mcp_servers");
    expect(Object.keys(outcome.result).sort()).toEqual(["matches", "query", "total_deferred_tools"]);
  });
});

describe("executeToolSearch -- tool_reference emission (WS-09 §8.2, T3 seam)", () => {
  test("emitToolReference is called with the resolved matches on a successful selection", async () => {
    try {
      registerMcpServerTools(SRV, [{ name: "ref_me", inputSchema: { type: "object" } }], { deferredDefault: true });
      const name = `mcp__${SRV}__ref_me`;
      const seen: string[][] = [];
      await executeToolSearch({ query: `select:${name}` }, baseDeps({ emitToolReference: (names) => seen.push(names) }));
      expect(seen).toEqual([[name]]);
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("emitToolReference is NOT called when nothing matched", async () => {
    const seen: string[][] = [];
    await executeToolSearch({ query: "select:__nope__" }, baseDeps({ emitToolReference: (names) => seen.push(names) }));
    expect(seen).toEqual([]);
  });
});

describe("executeToolSearch -- 5s pending-server wait + retry (WS-09 §8.2, dedicated fixture)", () => {
  test("select: waits for a relevant pending server, then retries and finds the tool once it connects", async () => {
    const name = `mcp__${SRV}__connects_later`;
    const state = createFakeMcpServerStateSource([{ name: SRV, state: "pending", toolNames: [] }]);
    try {
      const first = await executeToolSearch({ query: `select:${name}` }, baseDeps({ stateSource: state }));
      // Sanity: not yet registered, so an immediate (non-waiting) resolution would find nothing --
      // proven by NOT awaiting the wait ourselves; executeToolSearch does the waiting internally.
      // (This call already waited internally: the assertion below is on ITS OWN outcome directly.)
      expect(first.ok).toBe(true);

      // Re-run with the server connecting DURING the wait, proving the retry (not just the wait)
      // actually happens: schedule the registration+transition partway through the deadline.
      setTimeout(() => {
        registerMcpServerTools(SRV, [{ name: "connects_later", inputSchema: { type: "object" } }], { deferredDefault: true });
        state.transition(SRV, "connected", { toolNames: ["connects_later"] });
      }, 5);
      const second = await executeToolSearch({ query: `select:${name}` }, baseDeps({ stateSource: state, pendingWaitMs: 2000 }));
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.result.matches).toEqual([name]);
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("keyword search waits for ALL pending servers (relevance is undeterminable ahead of connecting)", async () => {
    const state = createFakeMcpServerStateSource([{ name: SRV, state: "pending", toolNames: [] }]);
    try {
      setTimeout(() => {
        registerMcpServerTools(SRV, [{ name: "keyword_target", description: "a distinctive marker phrase", inputSchema: { type: "object" } }], { deferredDefault: true });
        state.transition(SRV, "connected", { toolNames: ["keyword_target"] });
      }, 5);
      const outcome = await executeToolSearch({ query: "distinctive marker phrase" }, baseDeps({ stateSource: state, pendingWaitMs: 2000 }));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.result.matches).toContain(`mcp__${SRV}__keyword_target`);
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("waits at most the deadline when a relevant server never leaves pending, then returns whatever was found (none)", async () => {
    const name = `mcp__${SRV}__never_connects`;
    const state = createFakeMcpServerStateSource([{ name: SRV, state: "pending", toolNames: [] }]);
    const started = Date.now();
    const outcome = await executeToolSearch({ query: `select:${name}` }, baseDeps({ stateSource: state, pendingWaitMs: 40 }));
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.matches).toEqual([]);
    expect(outcome.result.pending_mcp_servers).toEqual([SRV]);
  });

  test("does NOT wait at all when the initial attempt already fully resolved (no pending servers consulted)", async () => {
    try {
      registerMcpServerTools(SRV, [{ name: "already_here", inputSchema: { type: "object" } }], { deferredDefault: true });
      const name = `mcp__${SRV}__already_here`;
      const state = createFakeMcpServerStateSource([{ name: "unrelated_server", state: "pending", toolNames: [] }]);
      const started = Date.now();
      const outcome = await executeToolSearch({ query: `select:${name}` }, baseDeps({ stateSource: state, pendingWaitMs: 5000 }));
      expect(Date.now() - started).toBeLessThan(1000); // did not consume the (irrelevant, since select: already resolved) full deadline
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.result.matches).toEqual([name]);
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("failed_mcp_servers reports a currently-failed server with its errorCode/error", async () => {
    const state = createFakeMcpServerStateSource([{ name: "broken_server", state: "failed", errorCode: "ECONNREFUSED", error: "connection refused", toolNames: [] }]);
    const outcome = await executeToolSearch({ query: "select:__nope__" }, baseDeps({ stateSource: state }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.failed_mcp_servers).toEqual([{ name: "broken_server", errorCode: "ECONNREFUSED", error: "connection refused" }]);
  });
});

describe("executeToolSearch -- post-compaction re-discovery (WS-09 §8.5, R4-6 reset(evidenced) seam)", () => {
  test("after reset(evidenced) drops a loaded tool, it is searchable again but NOT callable", async () => {
    try {
      registerMcpServerTools(SRV, [{ name: "rediscover_me", inputSchema: { type: "object" } }], { deferredDefault: true });
      const name = `mcp__${SRV}__rediscover_me`;
      const loadedToolSet = createLoadedToolSet();
      const deps = baseDeps({ emitToolReference: (names) => loadedToolSet.load(names) });

      const firstSelect = await executeToolSearch({ query: `select:${name}` }, deps);
      expect(firstSelect.ok).toBe(true);
      expect(isLoadFirstBlocked(name, "default", ACTIVE, loadedToolSet)).toBe(false); // loaded -> callable

      loadedToolSet.reset([]); // compaction: nothing survived in the evidenced transcript
      expect(isLoadFirstBlocked(name, "default", ACTIVE, loadedToolSet)).toBe(true); // re-hidden: back to load-first

      const secondSelect = await executeToolSearch({ query: `select:${name}` }, deps);
      expect(secondSelect.ok).toBe(true);
      if (!secondSelect.ok) return;
      expect(secondSelect.result.matches).toEqual([name]); // still discoverable/selectable
      expect(isLoadFirstBlocked(name, "default", ACTIVE, loadedToolSet)).toBe(false); // re-selecting re-loads it
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });
});

// ================================================================================================
// Phase 4 Task 8 (rider 7): the default `max_results` of 5, end to end.
// ================================================================================================
//
// WS-09 §8.2's own pinned input shape is `{ query: string; max_results?: number /* default 5 */ }`.
// Lane B's ranking honours a supplied value; what had no fixture was the DEFAULT -- i.e. that
// omitting the field truncates a keyword result to exactly 5, while `select:` (WS-09 §8.2: "direct
// selection is NOT truncated to max_results") stays untruncated past it.
describe("rider 7: max_results defaults to 5", () => {
  const SRV = "t8maxresults";
  afterEach(() => unregisterMcpServerTools(SRV));

  function registerDeferred(count: number): string[] {
    const names = Array.from({ length: count }, (_, i) => `probe_widget_${i}`);
    registerMcpServerTools(
      SRV,
      names.map((n) => ({ name: n, description: "a probe widget for the max_results default fixture", inputSchema: { type: "object" } })),
      { deferredDefault: true },
    );
    return names.map((n) => `mcp__${SRV}__${n}`);
  }

  // The file's own shared deps -- `capabilities: ["winter.mcp"]` matters: every live-registered MCP
  // descriptor carries that capability requirement, so without it the pool is empty and every
  // assertion below would vacuously read 0.
  const activeDeps = () => baseDeps();

  test("a KEYWORD query with no max_results returns at most 5 matches, out of a deferred pool of 12", async () => {
    const all = registerDeferred(12);
    const res = await executeToolSearch({ query: "probe widget" }, activeDeps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.matches.length).toBe(5);
    // Every returned name is a REAL member of the pool (never an invented or duplicated entry).
    for (const m of res.result.matches) expect(all).toContain(m);
    expect(new Set(res.result.matches).size).toBe(res.result.matches.length);
    expect(res.result.total_deferred_tools).toBeGreaterThanOrEqual(12);
  });

  test("an EXPLICIT max_results overrides the default in both directions", async () => {
    registerDeferred(12);
    const two = await executeToolSearch({ query: "probe widget", max_results: 2 }, activeDeps());
    expect(two.ok && two.result.matches.length).toBe(2);
    const nine = await executeToolSearch({ query: "probe widget", max_results: 9 }, activeDeps());
    expect(nine.ok && nine.result.matches.length).toBe(9);
  });

  test("`select:` is NOT truncated by the default -- 8 explicitly selected names all come back (WS-09 §8.2)", async () => {
    const all = registerDeferred(12);
    const selected = all.slice(0, 8);
    const res = await executeToolSearch({ query: `select:${selected.join(",")}` }, activeDeps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.matches.sort()).toEqual([...selected].sort());
  });
});

// --- Fix wave follow-up (2) / whole-branch M3(c): the disposer is identity-checked ----------------
describe("session runtime registry: a stale generation's disposer cannot delete a live one (M3(c))", () => {
  const KEY = "m3c-shared-agent-key";
  const runtimeA: ToolSearchSessionRuntime = { getMode: () => "default", activation: { enableToolSearch: "true", providerSupportsToolSearch: true, deferrableContextShare: 100 } };
  const runtimeB: ToolSearchSessionRuntime = { getMode: () => "plan", activation: { enableToolSearch: "true", providerSupportsToolSearch: true, deferrableContextShare: 100 } };

  test("generation 1's late teardown is a NO-OP once generation 2 has registered under the same key", () => {
    try {
      const disposeA = registerToolSearchSessionRuntime(KEY, runtimeA);
      // A `stop()` immediately followed by `resume()`: generation 2 registers under the SAME agent
      // key while generation 1's teardown is still draining.
      registerToolSearchSessionRuntime(KEY, runtimeB);
      expect(getToolSearchSessionRuntime(KEY)).toBe(runtimeB);

      disposeA(); // generation 1's teardown finally runs

      // Pre-fix this deleted by KEY, so the LIVE generation's runtime vanished and every
      // ToolSearch/WaitForMcpServers call in that child answered "no session runtime registered".
      expect(getToolSearchSessionRuntime(KEY), "a dead generation's disposer must not remove the live one").toBe(runtimeB);
    } finally {
      unregisterToolSearchSessionRuntime(KEY);
    }
  });

  test("the disposer still removes its OWN registration when nothing displaced it", () => {
    const dispose = registerToolSearchSessionRuntime(KEY, runtimeA);
    expect(getToolSearchSessionRuntime(KEY)).toBe(runtimeA);
    dispose();
    expect(getToolSearchSessionRuntime(KEY)).toBeUndefined();
  });
});
