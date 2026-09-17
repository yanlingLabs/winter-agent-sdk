import { describe, test, expect } from "bun:test";
import { resolveBuiltinAgents, resolveBuiltinAgentGates, resolveForkSubagentEnabled, BUILTIN_AGENT_NAMES } from "./builtin-agents.ts";
import { BUBBLE_PERMISSION_MODE } from "../permissions/policy-state.ts";

describe("resolveBuiltinAgentGates (R-S6 kill switches + R-S5 fork gate)", () => {
  test("every gate defaults off with no env at all", () => {
    const gates = resolveBuiltinAgentGates({});
    expect(gates).toEqual({
      allBuiltinsDisabled: false,
      explorePlanDisabled: false,
      agentViewDisabled: false,
      webFetchAgentEnabled: false,
      forkSubagentEnabled: false,
    });
  });

  test("each switch reads its own env var, truthy on '1' or 'true'", () => {
    expect(resolveBuiltinAgentGates({ WINTER_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "true" }).allBuiltinsDisabled).toBe(true);
    expect(resolveBuiltinAgentGates({ WINTER_DISABLE_EXPLORE_PLAN_AGENTS: "1" }).explorePlanDisabled).toBe(true);
    expect(resolveBuiltinAgentGates({ WINTER_DISABLE_AGENT_VIEW: "true" }).agentViewDisabled).toBe(true);
    expect(resolveBuiltinAgentGates({ WINTER_WEB_FETCH_AGENT: "true" }).webFetchAgentEnabled).toBe(true);
    expect(resolveBuiltinAgentGates({ WINTER_FORK_SUBAGENT: "true" }).forkSubagentEnabled).toBe(true);
  });

  test("a falsy or garbage value never flips a gate on", () => {
    expect(resolveBuiltinAgentGates({ WINTER_FORK_SUBAGENT: "false" }).forkSubagentEnabled).toBe(false);
    expect(resolveBuiltinAgentGates({ WINTER_FORK_SUBAGENT: "yes" }).forkSubagentEnabled).toBe(false);
    expect(resolveBuiltinAgentGates({}).forkSubagentEnabled).toBe(false);
  });

  test("resolveForkSubagentEnabled matches the gate's own field exactly", () => {
    expect(resolveForkSubagentEnabled({ WINTER_FORK_SUBAGENT: "true" })).toBe(true);
    expect(resolveForkSubagentEnabled({})).toBe(false);
  });
});

describe("resolveBuiltinAgents (R-S1 shipped set, R-S6 gating)", () => {
  test("the default set (no env) is general-purpose, Explore, Plan, claude -- web-fetch and fork withheld", () => {
    const defs = resolveBuiltinAgents({ env: {} });
    expect(Object.keys(defs).sort()).toEqual(["Explore", "Plan", "claude", "general-purpose"]);
  });

  test("names are IDENTICAL to claude's, case included (R-S2)", () => {
    expect(BUILTIN_AGENT_NAMES).toEqual(["general-purpose", "Explore", "Plan", "claude", "web-fetch", "fork"]);
  });

  test("WINTER_AGENT_SDK_DISABLE_BUILTIN_AGENTS withholds every built-in, even a gated one turned on", () => {
    const defs = resolveBuiltinAgents({
      env: { WINTER_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "true", WINTER_WEB_FETCH_AGENT: "true", WINTER_FORK_SUBAGENT: "true" },
    });
    expect(defs).toEqual({});
  });

  test("WINTER_DISABLE_EXPLORE_PLAN_AGENTS withholds Explore and Plan together, nothing else", () => {
    const defs = resolveBuiltinAgents({ env: { WINTER_DISABLE_EXPLORE_PLAN_AGENTS: "true" } });
    expect(Object.keys(defs).sort()).toEqual(["claude", "general-purpose"]);
  });

  test("WINTER_DISABLE_AGENT_VIEW withholds only claude", () => {
    const defs = resolveBuiltinAgents({ env: { WINTER_DISABLE_AGENT_VIEW: "true" } });
    expect(Object.keys(defs).sort()).toEqual(["Explore", "Plan", "general-purpose"]);
  });

  test("WINTER_WEB_FETCH_AGENT opts web-fetch in", () => {
    const defs = resolveBuiltinAgents({ env: { WINTER_WEB_FETCH_AGENT: "true" } });
    expect(defs["web-fetch"]).toBeDefined();
    expect(defs["web-fetch"]?.tools).toEqual(["WebFetch"]);
    expect(defs["web-fetch"]?.color).toBe("blue");
    expect(defs["web-fetch"]?.omitProjectContext).toBe(true);
  });

  test("WINTER_FORK_SUBAGENT opts fork in, with claude's own maxTurns/tools/permissionMode and no model override", () => {
    const defs = resolveBuiltinAgents({ env: { WINTER_FORK_SUBAGENT: "true" } });
    expect(defs["fork"]).toBeDefined();
    expect(defs["fork"]?.tools).toEqual(["*"]);
    expect(defs["fork"]?.maxTurns).toBe(200);
    expect(defs["fork"]?.model).toBe("inherit");
    // SDK 0.0.16 (P16-7): "bubble" replaces the prior "left unset" deviation -- see
    // permissions/policy-state.ts's own BUBBLE_PERMISSION_MODE header for what it means.
    expect(defs["fork"]?.permissionMode).toBe(BUBBLE_PERMISSION_MODE);
    // SDK 0.0.16 (P16-7, WS-10 §5): forks are always background, forced at the definition level so
    // `resolveForegroundBackground`'s own force-ranking (subagents/policy.ts, untouched by this lane)
    // applies without this file needing to touch that chain at all.
    expect(defs["fork"]?.background).toBe(true);
  });

  test("Explore/Plan disallow Agent/Artifact/ExitPlanMode/Edit/Write/NotebookEdit and omit project context", () => {
    const defs = resolveBuiltinAgents({ env: {} });
    for (const name of ["Explore", "Plan"] as const) {
      expect(defs[name]?.disallowedTools?.sort()).toEqual(["Agent", "Artifact", "Edit", "ExitPlanMode", "NotebookEdit", "Write"].sort());
      expect(defs[name]?.model).toBe("inherit");
      expect(defs[name]?.omitProjectContext).toBe(true);
    }
  });

  test("general-purpose has tools ['*'] and no disallow list", () => {
    const defs = resolveBuiltinAgents({ env: {} });
    expect(defs["general-purpose"]?.tools).toEqual(["*"]);
    expect(defs["general-purpose"]?.disallowedTools).toBeUndefined();
  });

  test("claude carries appendSystemPrompt:true and tools ['*'], no model override", () => {
    const defs = resolveBuiltinAgents({ env: {} });
    expect(defs["claude"]?.appendSystemPrompt).toBe(true);
    expect(defs["claude"]?.tools).toEqual(["*"]);
    expect(defs["claude"]?.model).toBeUndefined();
  });

  test("descriptions (whenToUse) drop the FleetView sentence from claude's own and keep the rest verbatim", () => {
    const defs = resolveBuiltinAgents({ env: {} });
    expect(defs["claude"]?.description).toBe("Catch-all for any task that doesn't fit a more specific agent.");
    expect(defs["claude"]?.description).not.toContain("FleetView");
    expect(defs["Explore"]?.description).toContain("Fast read-only search agent for locating code.");
    expect(defs["Explore"]?.description).toContain("very thorough");
  });

  test("prompts interpolate the passed brand's productName, never a hardcoded product name", () => {
    const acme = resolveBuiltinAgents({ env: {}, brand: { envPrefix: "ACME_", productName: "Acme" } });
    expect(acme["general-purpose"]?.prompt).toContain("Acme");
    expect(acme["general-purpose"]?.prompt).not.toContain("Winter");
  });

  test("every builtin's prompt and description is a non-empty string (well-formed RuntimeAgentDefinition)", () => {
    const defs = resolveBuiltinAgents({ env: { WINTER_WEB_FETCH_AGENT: "true", WINTER_FORK_SUBAGENT: "true" } });
    for (const name of Object.keys(defs)) {
      expect(defs[name]!.prompt.trim().length).toBeGreaterThan(0);
      expect(defs[name]!.description.trim().length).toBeGreaterThan(0);
    }
  });
});
