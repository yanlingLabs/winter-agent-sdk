import { describe, test, expect } from "bun:test";
import { SUBAGENT_EXCLUDED_TOOLS, BACKGROUND_AGENT_TOOL_ALLOWLIST, BACKGROUND_AGENT_ALWAYS_ALLOWED_TOOL } from "./tool-pools.ts";
import { applySubagentToolPool } from "./tool-pools.ts";

describe("SUBAGENT_EXCLUDED_TOOLS (research §A6)", () => {
  test("carries every Winter-named entry from claude's own list", () => {
    expect(new Set(SUBAGENT_EXCLUDED_TOOLS)).toEqual(
      new Set(["TaskOutput", "ExitPlanMode", "EnterPlanMode", "AskUserQuestion", "WaitForMcpServers", "RefreshMcpTools", "Workflow", "ScheduleWakeup", "ReadNotifications", "ProposeGoal", "EndConversation"]),
    );
  });

  test("has no duplicate entries", () => {
    expect(SUBAGENT_EXCLUDED_TOOLS.length).toBe(new Set(SUBAGENT_EXCLUDED_TOOLS).size);
  });
});

describe("BACKGROUND_AGENT_TOOL_ALLOWLIST (research §A6)", () => {
  test("carries every Winter-named entry, GetTask mapped to TaskGet, SendMessage the builtin name", () => {
    expect(new Set(BACKGROUND_AGENT_TOOL_ALLOWLIST)).toEqual(
      new Set([
        "Read",
        "WebSearch",
        "TodoWrite",
        "Grep",
        "WebFetch",
        "Glob",
        "Bash",
        "PowerShell",
        "Edit",
        "Write",
        "NotebookEdit",
        "Skill",
        "StructuredOutput",
        "ToolSearch",
        "EnterWorktree",
        "ExitWorktree",
        "REPL",
        "Monitor",
        "TaskStop",
        "TaskGet",
        "SendMessage",
        "Artifact",
      ]),
    );
  });

  test("Agent is NOT a member -- it passes 'regardless', depth-gated by the caller, not by this list", () => {
    expect(BACKGROUND_AGENT_TOOL_ALLOWLIST).not.toContain("Agent");
    expect(BACKGROUND_AGENT_ALWAYS_ALLOWED_TOOL).toBe("Agent");
  });

  test("has no duplicate entries", () => {
    expect(BACKGROUND_AGENT_TOOL_ALLOWLIST.length).toBe(new Set(BACKGROUND_AGENT_TOOL_ALLOWLIST).size);
  });

  test("the exclusion set and the background allowlist do not fight over the same name", () => {
    const excluded = new Set(SUBAGENT_EXCLUDED_TOOLS);
    for (const name of BACKGROUND_AGENT_TOOL_ALLOWLIST) expect(excluded.has(name)).toBe(false);
  });
});

describe("applySubagentToolPool (lane L2b, research §A6)", () => {
  const pool = ["Read", "Bash", "Agent", "TaskOutput", "ExitPlanMode", "EnterPlanMode", "AskUserQuestion", "Workflow", "ReadNotifications", "SendMessage", "ListAgents", "TaskCreate", "mcp__winter__send_message", "mcp__winter__list_agents", "mcp__github__search"];

  test("foreground, below the depth limit: only the exclusion set is removed", () => {
    expect(applySubagentToolPool(pool, { planMode: false, mayNest: true, background: false })).toEqual(["Read", "Bash", "Agent", "SendMessage", "ListAgents", "TaskCreate", "mcp__winter__send_message", "mcp__winter__list_agents", "mcp__github__search"]);
  });

  test("plan mode keeps ExitPlanMode", () => {
    expect(applySubagentToolPool(pool, { planMode: true, mayNest: true, background: false })).toContain("ExitPlanMode");
  });

  test("at the depth limit the Agent tool is removed", () => {
    expect(applySubagentToolPool(pool, { planMode: false, mayNest: false, background: false })).not.toContain("Agent");
    expect(applySubagentToolPool(pool, { planMode: false, mayNest: false, background: true })).not.toContain("Agent");
  });

  test("background: the allowlist, plus Agent (depth-gated) and genuine MCP tools; Winter's twins follow their built-in names", () => {
    expect(applySubagentToolPool(pool, { planMode: false, mayNest: true, background: true })).toEqual(["Read", "Bash", "Agent", "SendMessage", "mcp__winter__send_message", "mcp__github__search"]);
  });

  test("a branded session's twins are recognised by ITS server name", () => {
    const branded = applySubagentToolPool(["mcp__acme__list_agents", "mcp__winter__list_agents"], { planMode: false, mayNest: true, background: true, brand: { mcpServerName: "acme" } });
    expect(branded).toEqual(["mcp__winter__list_agents"]); // under ACME, a `winter` server is just an MCP server
  });
});
