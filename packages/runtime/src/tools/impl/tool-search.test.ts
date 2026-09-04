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
