// Phase 4 Task 5 (LANE B): end-to-end fixtures for the REAL ToolSearch executor -- the ctx-adapter
// (session-runtime resolution + emitToolReference wiring) that toolsearch/search.test.ts's own
// pure-function fixtures cannot exercise, plus the brief's own explicitly-named "load ≠ permission"
// regression, run against the REAL six-stage evaluator (never a hand-rolled stand-in).
import { describe, test, expect } from "bun:test";
import { createSessionReadState } from "../read-state.ts";
import {
  getRegisteredTool,
  registerMcpServerTools,
  unregisterMcpServerTools,
  createLoadedToolSet,
  type ToolExecutionContext,
  type DeferralActivation,
} from "../registry.ts";
import { registerToolSearchSessionRuntime, type ToolSearchSessionRuntime } from "../../toolsearch/search.ts";
import { registerSessionMcpLifecycle, getSessionMcpLifecycle } from "../../mcp/lifecycle.ts";
import { createFakeMcpLifecycle, createFakeConnectedMcpClient } from "../../mcp/test-fixtures.ts";
import "./list-mcp-resources-tool.ts";
import { TOOL_SEARCH_TOOL_NAME, toolSearchExecutor } from "./tool-search.ts";
import {
  evaluate,
  NO_OPINION_HOOK_STAGE,
  NO_OPINION_PROMPT_STAGE,
  NO_OPINION_AUTO_ENGINE,
  NO_SPECIAL_CHECKS,
  type EvaluationContext,
} from "../../permissions/evaluator.ts";
import { emptyRuleSet, sourceRule } from "../../permissions/ruleset.ts";
import type { PolicyState } from "../../permissions/policy-state.ts";

const SRV = "t5implsrv";
const ACTIVE: DeferralActivation = { enableToolSearch: "true", providerSupportsToolSearch: true, deferrableContextShare: 100 };

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    cwd: "/work",
    home: "/synthetic/home/tester",
    sessionId: "t5-tool-search-session",
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

describe("toolSearchExecutor -- module load", () => {
  test("installs a real executor over the WS-06 stub", () => {
    const registered = getRegisteredTool(TOOL_SEARCH_TOOL_NAME);
    expect(registered?.executor).toBeDefined();
  });
});

describe("toolSearchExecutor -- session-runtime wiring (this lane's own NEEDS_CONTEXT boundary)", () => {
  test("a session with no registered runtime gets a typed, non-crashing error -- never a throw", async () => {
    const ctx = makeCtx({ sessionId: "t5-never-registered" });
    const result = await toolSearchExecutor.execute({ query: "select:Read" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output.toLowerCase()).toContain("no session runtime registered");
  });

  test("a registered runtime answers a real select: query end to end, including emitToolReference through ctx", async () => {
    try {
      registerMcpServerTools(SRV, [{ name: "e2e_tool", inputSchema: { type: "object" } }], { deferredDefault: true });
      const name = `mcp__${SRV}__e2e_tool`;
      const loadedToolSet = createLoadedToolSet();
      const sessionId = "t5-e2e-session";
      const runtime: ToolSearchSessionRuntime = { getMode: () => "default", activation: ACTIVE, capabilities: ["winter.mcp"] };
      const unregister = registerToolSearchSessionRuntime(sessionId, runtime);
      try {
        const ctx = makeCtx({ sessionId, emitToolReference: (names) => loadedToolSet.load(names) });
        const result = await toolSearchExecutor.execute({ query: `select:${name}` }, ctx);
        expect(result.isError).toBeUndefined();
        const parsed = JSON.parse(result.output);
        expect(parsed.matches).toEqual([name]);
        expect(loadedToolSet.isLoaded(name)).toBe(true); // ctx.emitToolReference really ran
      } finally {
        unregister();
      }
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("a malformed input still returns a typed tool-result error, never a thrown exception", async () => {
    const sessionId = "t5-bad-input-session";
    const unregister = registerToolSearchSessionRuntime(sessionId, { getMode: () => "default", activation: ACTIVE });
    try {
      const ctx = makeCtx({ sessionId });
      const result = await toolSearchExecutor.execute({ query: 12345 }, ctx);
      expect(result.isError).toBe(true);
    } finally {
      unregister();
    }
  });
});

// --- "Load != permission" (brief verbatim, WS-09 §8.2/§8.5): loading a deferred tool via ToolSearch
// must never itself grant an allow -- the standing evaluator still runs, unchanged, on the very next
// call to that tool. Proven against the REAL evaluate() pipeline (permissions/evaluator.ts), not a
// re-derivation, so this fixture cannot pass merely by agreeing with itself.
function evalCtx(canonicalName: string): EvaluationContext {
  const policy: PolicyState = {
    mode: "default",
    version: 0,
    // A deterministic "ask" rule for the exact tool under test -- the point is not "what does
    // default-mode inference happen to decide for an MCP-classed tool," it is "does the SAME
    // evaluate() call return the SAME verdict before and after ToolSearch loads the tool," so the
    // rule is pinned rather than left to mode-stage defaults.
    rules: { ...emptyRuleSet(), entries: [sourceRule({ toolName: canonicalName }, "ask", "sdk")] },
  };
  return {
    policy,
    cwd: "/work",
    sessionRoot: "/work",
    home: "/synthetic/home/tester",
    trustedWorkspace: false,
    hookStage: NO_OPINION_HOOK_STAGE,
    promptStage: NO_OPINION_PROMPT_STAGE,
    autoEngine: NO_OPINION_AUTO_ENGINE,
    specialChecks: NO_SPECIAL_CHECKS,
  };
}

describe("load != permission (WS-09 §8.2/§8.5, brief-named regression)", () => {
  test("loading a deferred tool via ToolSearch does not change the real evaluator's verdict for it", async () => {
    try {
      registerMcpServerTools(SRV, [{ name: "sensitive_write", inputSchema: { type: "object" } }], { deferredDefault: true });
      const name = `mcp__${SRV}__sensitive_write`;
      const loadedToolSet = createLoadedToolSet();
      const sessionId = "t5-load-ne-permission-session";
      const unregister = registerToolSearchSessionRuntime(sessionId, { getMode: () => "default", activation: ACTIVE, capabilities: ["winter.mcp"] });
      try {
        const ctx = makeCtx({ sessionId, emitToolReference: (names) => loadedToolSet.load(names) });

        const before = await evaluate({ toolName: name, input: {} }, evalCtx(name));
        // With NO_OPINION_PROMPT_STAGE (no real interactive answerer wired), a matched "ask" rule
        // fails CLOSED to "deny" (evaluator.ts's own ruleAskUnresolvedMessage path) rather than
        // hanging forever as an unresolved "ask" -- so the exact terminal value here is "deny", not
        // the rule's own nominal "ask" behavior. That exact value is incidental to this fixture's
        // actual claim, which is only ever "unchanged by loading, and never silently 'allow'".
        expect(before.decision).not.toBe("allow");

        // ToolSearch selects and loads it -- the WS-09 §8.2 "successful selection returns
        // tool_reference blocks making the tools callable" consequence, exercised for real.
        const searchResult = await toolSearchExecutor.execute({ query: `select:${name}` }, ctx);
        expect(searchResult.isError).toBeUndefined();
        expect(loadedToolSet.isLoaded(name)).toBe(true);

        const after = await evaluate({ toolName: name, input: {} }, evalCtx(name));
        expect(after.decision).toBe(before.decision); // UNCHANGED -- loading never touched policy/rules at all
        expect(after.decision).not.toBe("allow");
      } finally {
        unregister();
      }
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });
});

// --- Fix wave follow-up (5) / Lane X NEEDS_CONTEXT 1: a CHILD's ToolSearch uses its OWN runtime ----
//
// Lane X's I1 keys every session-scoped registration by `config.agentId ?? config.sessionId`, and
// gives a child its PARENT's `config.sessionId`. Two lookups therefore have to disagree on purpose:
//
//   * `getSessionMcpLifecycle(ctx.sessionId)` -- the four WS-09 §1.4 bridge tools -- must resolve the
//     OWNING SESSION's lifecycle, so a child is not an MCP island. That IS the I2 fix; it must not
//     move to `agentId`.
//   * `getToolSearchSessionRuntime(...)` -- ToolSearch and WaitForMcpServers -- must prefer the
//     CHILD's OWN runtime, because a child's advertised pool is narrower than its parent's
//     (`child-engine.ts` computes the complement of the inherited allowlist into the child's own
//     `disallowedTools`). Resolving the parent's runtime let a child `select:` a tool its own pool
//     excludes -- and, on the ToolSearch path, that name is exactly what `emitToolReference` then
//     marks LOADED.
describe("follow-up (5): the ToolSearch runtime lookup prefers ctx.agentId; the MCP lifecycle lookup does not", () => {
  const PARENT_ONLY = "t6fw_parent_only_tool";
  const SHARED = "t6fw_shared_tool";
  const PARENT_SESSION = "t6fw-owning-session";
  const CHILD_AGENT = "t6fw-child-agent-key";

  function runtimeFor(disallowed: readonly string[]): ToolSearchSessionRuntime {
    return { getMode: () => "default", activation: ACTIVE, capabilities: ["winter.mcp"], disallowedTools: disallowed };
  }

  test("a child selecting a tool its OWN pool excludes gets no match, though the parent's pool has it", async () => {
    try {
      registerMcpServerTools(SRV, [{ name: "parent_only_mcp", inputSchema: { type: "object" } }], { deferredDefault: true });
      const parentOnlyMcp = `mcp__${SRV}__parent_only_mcp`;
      // The parent denies nothing; the child's own runtime denies the name -- exactly the shape
      // `child-engine.ts` builds from the complement of the inherited allowlist.
      const disposeParent = registerToolSearchSessionRuntime(PARENT_SESSION, runtimeFor([]));
      const disposeChild = registerToolSearchSessionRuntime(CHILD_AGENT, runtimeFor([parentOnlyMcp]));
      try {
        // A child's ctx: the OWNING session's id, plus its own agent key (Lane X's I1 shape).
        const childCtx = makeCtx({ sessionId: PARENT_SESSION, agentId: CHILD_AGENT, insideSubagent: true });
        const inChild = await toolSearchExecutor.execute({ query: `select:${parentOnlyMcp}` }, childCtx);
        expect((JSON.parse(inChild.output) as { matches: string[] }).matches, "the child's own pool excludes it").toEqual([]);

        // The control: the identical call from the PARENT (no agentId) still matches, so the
        // assertion above is about the lookup and not about the fixture being unregistered.
        const inParent = await toolSearchExecutor.execute({ query: `select:${parentOnlyMcp}` }, makeCtx({ sessionId: PARENT_SESSION }));
        expect((JSON.parse(inParent.output) as { matches: string[] }).matches).toEqual([parentOnlyMcp]);
      } finally {
        disposeChild();
        disposeParent();
      }
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("a child whose own runtime is gone gets the typed error, NOT a silent fall-back to its parent's wider pool", async () => {
    const dispose = registerToolSearchSessionRuntime(PARENT_SESSION, runtimeFor([]));
    try {
      const out = await toolSearchExecutor.execute({ query: "select:anything" }, makeCtx({ sessionId: PARENT_SESSION, agentId: "unregistered-agent-key" }));
      // Deliberate: `??` falls back only when there is no agentId AT ALL (a main-engine call). A
      // child whose own registration is missing must not silently inherit the parent's pool -- that
      // is the exact widening this item closes, and in production it cannot happen anyway (a child's
      // own runEngine registers before its turn loop starts).
      expect(out.isError).toBe(true);
      expect(out.output).toContain("no session runtime registered");
    } finally {
      dispose();
    }
  });

  test("a MAIN-engine call (no agentId) resolves the session's own runtime exactly as before", async () => {
    const dispose = registerToolSearchSessionRuntime(PARENT_SESSION, runtimeFor([]));
    try {
      const out = await toolSearchExecutor.execute({ query: "select:anything" }, makeCtx({ sessionId: PARENT_SESSION }));
      expect(out.isError).toBeUndefined();
    } finally {
      dispose();
    }
  });

  // The guard rail on the other lookup, in the same file so a future edit that "makes them
  // consistent" trips here.
  test("the MCP bridge lookup is NOT moved to agentId -- a child still resolves the OWNING session's lifecycle (Lane X's I2)", async () => {
    const lifecycle = createFakeMcpLifecycle({ connectedServers: { "owned-by-parent": createFakeConnectedMcpClient("owned-by-parent", { listResources: async () => [{ uri: "parent://one" }] }) } });
    const dispose = registerSessionMcpLifecycle(PARENT_SESSION, lifecycle);
    try {
      const childCtx = makeCtx({ sessionId: PARENT_SESSION, agentId: CHILD_AGENT, insideSubagent: true });
      const out = await getRegisteredTool("ListMcpResourcesTool")!.executor!.execute({}, childCtx);
      expect(out.isError).toBeUndefined();
      expect(out.output).toContain("owned-by-parent");
      // ...and nothing is registered under the child's agent key, so a lookup that had moved to
      // `agentId` would have answered "no MCP lifecycle is configured for this session".
      expect(getSessionMcpLifecycle(CHILD_AGENT)).toBeUndefined();
    } finally {
      dispose();
    }
  });
});
