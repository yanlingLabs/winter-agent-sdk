import { describe, test, expect } from "bun:test";
import { agentInputSchemaFor, renderAgentToolDescription, AGENT_TOOL_GATE_DEFAULTS, OMITTED_TYPE_SENTENCE_AVAILABLE, OMITTED_TYPE_SENTENCE_UNAVAILABLE } from "./agent.ts";
import { getRegisteredTool } from "../registry.ts";
import "./agent.ts"; // self-sufficiency: guarantee the static registration ran

describe("agentInputSchemaFor (research §A2, scope item 5)", () => {
  test("gate-off defaults: run_in_background present, model has no fork clause", () => {
    const schema = agentInputSchemaFor(AGENT_TOOL_GATE_DEFAULTS);
    expect(schema.properties?.["run_in_background"]).toBeDefined();
    expect((schema.properties?.["model"] as { description?: string })?.description).not.toContain("fork");
    expect(schema.required).toEqual(["description", "prompt"]);
  });

  test("fork on -> run_in_background dropped, model description gains the fork clause", () => {
    const schema = agentInputSchemaFor({ forkEnabled: true, backgroundDisabled: false, generalPurposeAvailable: true });
    expect(schema.properties?.["run_in_background"]).toBeUndefined();
    expect((schema.properties?.["model"] as { description?: string })?.description).toContain('Ignored for subagent_type: "fork"');
  });

  test("background disabled (fork off) -> run_in_background dropped too", () => {
    const schema = agentInputSchemaFor({ forkEnabled: false, backgroundDisabled: true, generalPurposeAvailable: true });
    expect(schema.properties?.["run_in_background"]).toBeUndefined();
  });

  test("the model enum stays Winter's own per-family slot names, in every gate combination (R-S9)", () => {
    for (const gates of [AGENT_TOOL_GATE_DEFAULTS, { forkEnabled: true, backgroundDisabled: true, generalPurposeAvailable: false }]) {
      const schema = agentInputSchemaFor(gates);
      expect((schema.properties?.["model"] as { enum?: string[] })?.enum).toEqual(["sonnet", "opus", "haiku", "fable"]);
    }
  });

  test("isolation keeps claude's own description verbatim regardless of gates", () => {
    const schema = agentInputSchemaFor({ forkEnabled: true, backgroundDisabled: true, generalPurposeAvailable: false });
    expect((schema.properties?.["isolation"] as { description?: string })?.description).toContain('"worktree" creates a temporary git worktree');
    expect((schema.properties?.["isolation"] as { enum?: string[] })?.enum).toEqual(["worktree", "remote"]);
  });

  test("name is never advertised, in any gate combination (pre-existing P4-J(d) ruling, untouched)", () => {
    const schema = agentInputSchemaFor({ forkEnabled: true, backgroundDisabled: false, generalPurposeAvailable: true });
    expect(schema.properties?.["name"]).toBeUndefined();
  });
});

describe("renderAgentToolDescription (research §A3, scope item 5)", () => {
  // Review r2 finding 3 (whole-branch, R-S10): the opening two sentences are now Winter-authored
  // (they used to match claude's own pinned text verbatim) -- this test now asserts the INFORMATION
  // survives the reword (an agent is spawned for a self-contained piece of work with its own tool
  // access; the available types are announced via an injected reminder), not any specific phrasing.
  test("carries the opening information (spawn mechanism + how types are announced) in Winter's own words, plus the shared omitted-type sentence", () => {
    const text = renderAgentToolDescription(AGENT_TOOL_GATE_DEFAULTS);
    expect(text).not.toContain("Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.");
    expect(text).not.toContain("Available agent types are listed in <system-reminder> messages in the conversation.");
    expect(text).toContain("runtime-injected reminder");
    expect(text).toContain(OMITTED_TYPE_SENTENCE_AVAILABLE);
  });

  test("the two omitted-type sentences are EXPORTED, so lane L2b's own runtime refusal can reuse them verbatim (never a second, drift-prone copy)", () => {
    expect(OMITTED_TYPE_SENTENCE_AVAILABLE).toBe("If omitted, the general-purpose agent is used.");
    expect(OMITTED_TYPE_SENTENCE_UNAVAILABLE).toBe("subagent_type is required: the general-purpose agent is not available in this session, so choose one of the listed agent types.");
    expect(renderAgentToolDescription({ forkEnabled: false, backgroundDisabled: false, generalPurposeAvailable: false })).toContain(OMITTED_TYPE_SENTENCE_UNAVAILABLE);
  });

  test("general-purpose unavailable -> the required-when-unavailable sentence replaces the omitted-type one", () => {
    const text = renderAgentToolDescription({ forkEnabled: false, backgroundDisabled: false, generalPurposeAvailable: false });
    expect(text).not.toContain("If omitted, the general-purpose agent is used.");
    expect(text).toContain("subagent_type is required: the general-purpose agent is not available in this session");
  });

  test("fork off -> no fork section", () => {
    expect(renderAgentToolDescription(AGENT_TOOL_GATE_DEFAULTS)).not.toContain("Forking:");
  });

  test("fork on -> the fork section is appended", () => {
    const text = renderAgentToolDescription({ forkEnabled: true, backgroundDisabled: false, generalPurposeAvailable: true });
    expect(text).toContain("Forking:");
    expect(text).toContain('subagent_type: "fork"');
  });

  test("background paragraph appears only when run_in_background is actually advertised", () => {
    const on = renderAgentToolDescription(AGENT_TOOL_GATE_DEFAULTS);
    expect(on).toContain("FOREGROUND");
    const off = renderAgentToolDescription({ forkEnabled: true, backgroundDisabled: false, generalPurposeAvailable: true });
    expect(off).not.toContain("FOREGROUND");
  });

  test("never describes claude's own 'background by default' behavior (R-S7)", () => {
    const text = renderAgentToolDescription(AGENT_TOOL_GATE_DEFAULTS);
    expect(text).not.toContain("Agents run in the background by default");
  });
});

describe("the static registration (gate-off defaults, byte-identical shape to the pre-parity descriptor's spirit)", () => {
  test("the registered Agent descriptor's schema matches agentInputSchemaFor(AGENT_TOOL_GATE_DEFAULTS)", () => {
    const registered = getRegisteredTool("Agent");
    expect(registered?.descriptor.inputSchema).toEqual(agentInputSchemaFor(AGENT_TOOL_GATE_DEFAULTS));
  });

  test("the registered description starts with the Winter-worded opening and still carries the model-slots marker block", () => {
    const registered = getRegisteredTool("Agent");
    expect(registered?.descriptor.description.startsWith("Spawn a subagent to carry a self-contained piece of a task on your behalf")).toBe(true);
    expect(registered?.descriptor.description).toContain("Model options for this session:");
  });
});
