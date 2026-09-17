import { describe, test, expect } from "bun:test";
import { agentInputSchemaFor, renderAgentToolDescription, AGENT_TOOL_GATE_DEFAULTS, OMITTED_TYPE_SENTENCE_AVAILABLE, OMITTED_TYPE_SENTENCE_UNAVAILABLE, type AgentToolGateState } from "./agent.ts";
import { getRegisteredTool } from "../registry.ts";
import { resolveForegroundBackground, resolveBackgroundTasksDisabled, resolveBackgroundByDefaultEnabled } from "../../subagents/policy.ts";
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

  // C1 (fix wave, whole-branch review): these two tests used to pin the OLD, now-wrong claim that
  // foreground is the default and that Winter "never describes" a background default (R-S7). SDK
  // 0.0.16 supersedes R-S7 -- `subagents/policy.ts`'s own stage 5 default is background, and the
  // engine now tells the model about a background completion, which is what made the old claim
  // false. See the "agrees with policy.ts's actual default" block below for the exhaustive matrix.
  test("gate defaults (background-by-default) -> the paragraph says BACKGROUND, never claims foreground is the default", () => {
    const text = renderAgentToolDescription(AGENT_TOOL_GATE_DEFAULTS);
    expect(text).toContain("BACKGROUND");
    expect(text).not.toContain("By default, an agent you launch runs in the FOREGROUND");
  });

  test("a host that opted out (backgroundByDefault: false) gets the FOREGROUND paragraph instead", () => {
    const text = renderAgentToolDescription({ forkEnabled: false, backgroundDisabled: false, generalPurposeAvailable: true, backgroundByDefault: false });
    expect(text).toContain("FOREGROUND");
    expect(text).not.toContain("runs in the BACKGROUND");
  });

  test("fork enabled -> no run_in_background override, but the ordinary (non-fork) default is still named accurately", () => {
    const withBg = renderAgentToolDescription({ forkEnabled: true, backgroundDisabled: false, generalPurposeAvailable: true, backgroundByDefault: true });
    expect(withBg).toContain("no run_in_background override");
    expect(withBg).toContain("background by default");
    const withoutBg = renderAgentToolDescription({ forkEnabled: true, backgroundDisabled: false, generalPurposeAvailable: true, backgroundByDefault: false });
    expect(withoutBg).toContain("no run_in_background override");
    expect(withoutBg).toContain("foreground by default");
  });

  test("background disabled (kill switch) -> unconditional foreground, no flag mentioned", () => {
    const text = renderAgentToolDescription({ forkEnabled: false, backgroundDisabled: true, generalPurposeAvailable: true });
    expect(text).toContain("disabled background subagents entirely");
    expect(text).not.toContain("run_in_background");
  });
});

// C1 (fix wave): the description (both the schema field and the body paragraph) must never disagree
// with what `subagents/policy.ts`'s `resolveForegroundBackground` actually decides for an ordinary,
// unflagged spawn -- exercised as a real matrix over the kill switch and the I4 opt-out, in both
// directions, so a future edit to either side trips this test rather than shipping a lie.
describe("C1/I4: the description agrees with policy.ts's actual default (kill switch x backgroundByDefault)", () => {
  const CASES: Array<{ label: string; env: Record<string, string | undefined> }> = [
    { label: "kill switch off, knob unset -> background", env: {} },
    { label: "kill switch off, knob explicitly on -> background", env: { WINTER_BACKGROUND_BY_DEFAULT: "true" } },
    { label: "kill switch off, knob off -> foreground", env: { WINTER_BACKGROUND_BY_DEFAULT: "false" } },
    { label: "kill switch on, knob unset -> foreground (the kill switch wins)", env: { WINTER_DISABLE_BACKGROUND_TASKS: "1" } },
    { label: "kill switch on, knob explicitly on -> still foreground (the kill switch wins)", env: { WINTER_DISABLE_BACKGROUND_TASKS: "1", WINTER_BACKGROUND_BY_DEFAULT: "true" } },
  ];

  for (const { label, env } of CASES) {
    test(label, () => {
      const backgroundDisabled = resolveBackgroundTasksDisabled(env);
      const backgroundByDefault = resolveBackgroundByDefaultEnabled(env);
      const decision = resolveForegroundBackground({ isFork: false, env, backgroundByDefault });
      const gates: AgentToolGateState = { forkEnabled: false, backgroundDisabled, generalPurposeAvailable: true, backgroundByDefault };

      const schema = agentInputSchemaFor(gates);
      const field = schema.properties?.["run_in_background"] as { description?: string } | undefined;
      const text = renderAgentToolDescription(gates);

      if (backgroundDisabled) {
        // The kill switch drops the field from the schema entirely -- nothing left to agree or disagree.
        expect(field).toBeUndefined();
        expect(decision.background).toBe(false);
        expect(text.toLowerCase()).toContain("foreground");
        return;
      }
      expect(field).toBeDefined();
      expect(decision.background).toBe(backgroundByDefault);
      if (decision.background) {
        expect(field!.description).toContain("background by default");
        expect(text).toContain("BACKGROUND");
      } else {
        expect(field!.description?.toLowerCase()).toContain("foreground");
        expect(text).toContain("FOREGROUND");
      }
    });
  }
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
