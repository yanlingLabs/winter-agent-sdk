// Phase 5 Task 3 (R5-2): the SEAM AUTHORITY for `context/seam.ts`. Lane C (task 6) keeps this green
// against its real assembler; the engine keeps it green against its consumption. Where this file and
// a lane brief disagree, this file wins.
//
// Ground truth is the LIVE provider request, never the assembler's return value -- so the engine
// half of every claim below is asserted through a real `runEngine` with a recording provider, not by
// calling `assemble()` and trusting the engine to have used it.
import { test, expect, describe } from "bun:test";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type Provider, type ProviderRequest } from "../engine.ts";
import { stubExecutor } from "../provider/mock.ts";
import { fakeSystemPromptAssembler, type AssembledPrompt, type SkillListing, type SystemPromptAssembler, type SystemPromptInput } from "./seam.ts";

const baseConfig = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig => ({ sessionId: "s", cwd: "/tmp/x", model: "sonnet", ...overrides });

async function drain(source: AsyncIterable<WinterFrame>): Promise<WinterFrame[]> {
  const out: WinterFrame[] = [];
  for await (const f of source) out.push(f);
  return out;
}

/** Records every request the engine actually issued -- the only ground truth for prompt assembly. */
function recordingProvider(texts: string[]): { provider: Provider; requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  let i = 0;
  return {
    requests,
    provider: {
      async generate(input) {
        // Structured-clone the messages so a later in-place mutation by the engine cannot rewrite
        // history this recorder already captured (the engine copies `messages` per call, but a test
        // that trusts identity here would be pinning the copy, not the content).
        requests.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
        return { kind: "text", text: texts[Math.min(i++, texts.length - 1)] ?? "done" };
      },
    },
  };
}

async function runOneTurn(opts: { assembler?: SystemPromptAssembler; agentSystemPrompt?: string; text?: string; turns?: number }): Promise<ProviderRequest[]> {
  const { host, runtime } = createInMemoryChannel();
  const { provider, requests } = recordingProvider(["done"]);
  const done = runEngine({
    config: baseConfig(),
    input: runtime.input,
    output: runtime.output,
    provider,
    tools: stubExecutor,
    ...(opts.assembler !== undefined ? { systemPromptAssembler: opts.assembler } : {}),
    ...(opts.agentSystemPrompt !== undefined ? { agentSystemPrompt: opts.agentSystemPrompt } : {}),
  });
  for (let t = 0; t < (opts.turns ?? 1); t++) host.output.write({ type: "user", text: `${opts.text ?? "go"}${t === 0 ? "" : `-${t}`}` });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
  await drain(host.input);
  await done;
  return requests;
}

describe("context/seam.ts -- SystemPromptAssembler (Lane C implements, the engine consumes)", () => {
  test("the interface is structural: any object with assemble() satisfies it, no base class, no registration", () => {
    const inline: SystemPromptAssembler = { assemble: (): AssembledPrompt => ({ system: "s", userContextBlocks: [] }) };
    expect(inline.assemble({ config: baseConfig(), cwd: "/x", env: {}, platform: "darwin", osVersion: "26", shell: "/bin/zsh", date: "2026-09-04", planMode: false })).toEqual({
      system: "s",
      userContextBlocks: [],
    });
  });

  test("SkillListing is the shared S->C shape (R5-17): five sources, name+description only", () => {
    const listing: SkillListing = [
      { name: "a", description: "d", source: "project" },
      { name: "b", description: "d", source: "user" },
      { name: "c", description: "d", source: "plugin" },
      { name: "d", description: "d", source: "builtin" },
      { name: "e", description: "d", source: "self" },
    ];
    expect(listing.map((s) => s.source)).toEqual(["project", "user", "plugin", "builtin", "self"]);
  });

  // --- The engine's half of the contract -----------------------------------------------------------

  test("RULING R5-16: with NO assembler registered, the live request carries NO system prompt -- the engine authors no fallback text", async () => {
    const requests = await runOneTurn({});
    expect(requests).toHaveLength(1);
    expect(requests[0]!.system ?? "").toBe("");
  });

  test("a registered assembler's `system` reaches the LIVE request verbatim", async () => {
    const requests = await runOneTurn({ assembler: fakeSystemPromptAssembler({ system: "ASSEMBLED-SYSTEM" }) });
    expect(requests[0]!.system).toBe("ASSEMBLED-SYSTEM");
  });

  test("assemble() is called ONCE PER USER ENVELOPE, and every provider call in that turn carries the same result", async () => {
    const calls: SystemPromptInput[] = [];
    const requests = await runOneTurn({ assembler: fakeSystemPromptAssembler({ system: "S", calls }), turns: 2 });
    expect(calls).toHaveLength(2); // two envelopes -> two assemblies, never one cached for the session
    expect(requests.map((r) => r.system)).toEqual(["S", "S"]);
  });

  test("the assembler receives a plain-data snapshot: cwd/platform/date/planMode are populated from the live run, never left undefined", async () => {
    const calls: SystemPromptInput[] = [];
    await runOneTurn({ assembler: fakeSystemPromptAssembler({ calls }) });
    const input = calls[0]!;
    expect(input.cwd).toBe("/tmp/x");
    expect(input.config.sessionId).toBe("s");
    expect(typeof input.platform).toBe("string");
    expect(input.platform.length).toBeGreaterThan(0);
    expect(typeof input.osVersion).toBe("string");
    expect(typeof input.shell).toBe("string");
    expect(input.date).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(input.planMode).toBe(false);
    expect(input.env).toBeDefined();
  });

  test("planMode reflects THIS run's live permission mode, not a config snapshot taken before a mode switch", async () => {
    const calls: SystemPromptInput[] = [];
    const { host, runtime } = createInMemoryChannel();
    const { provider } = recordingProvider(["done", "done"]);
    const done = runEngine({
      config: baseConfig({ permissionMode: "plan" }),
      input: runtime.input,
      output: runtime.output,
      provider,
      tools: stubExecutor,
      systemPromptAssembler: fakeSystemPromptAssembler({ calls }),
    });
    host.output.write({ type: "user", text: "one" });
    host.output.write({ type: "control_request", requestId: "m", subtype: "set_permission_mode", payload: "default" });
    host.output.write({ type: "user", text: "two" });
    host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
    await drain(host.input);
    await done;
    expect(calls.map((c) => c.planMode)).toEqual([true, false]);
  });

  test("userContextBlocks are prepended to THIS TURN's user message on the live request -- and never enter the engine's own history", async () => {
    const requests = await runOneTurn({ assembler: fakeSystemPromptAssembler({ system: "S", userContextBlocks: ["BLOCK-A", "BLOCK-B"] }), turns: 2, text: "go" });
    // Turn 1's request: the single user message carries both blocks ahead of the prompt text.
    const first = requests[0]!;
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]!.content).toBe("BLOCK-A\n\nBLOCK-B\n\ngo");
    // Turn 2's request: history contains turn 1's user message WITHOUT the blocks (they never
    // entered `messages`), and only turn 2's own user message carries them.
    const second = requests[1]!;
    const userContents = second.messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(userContents[0]).toBe("go");
    expect(userContents[userContents.length - 1]).toBe("BLOCK-A\n\nBLOCK-B\n\ngo-1");
  });

  test("an assembler returning NO blocks leaves the user message byte-identical to the un-assembled one", async () => {
    const withAssembler = await runOneTurn({ assembler: fakeSystemPromptAssembler({ system: "S", userContextBlocks: [] }) });
    const without = await runOneTurn({});
    expect(withAssembler[0]!.messages[0]!.content).toBe(without[0]!.messages[0]!.content);
  });

  test("R5-3/P4-J: `agentPrompt` reaches the assembler, and with NO assembler it IS the system prompt (the engine forwards, never authors)", async () => {
    const calls: SystemPromptInput[] = [];
    await runOneTurn({ assembler: fakeSystemPromptAssembler({ calls }), agentSystemPrompt: "you are the reviewer" });
    expect(calls[0]!.agentPrompt).toBe("you are the reviewer");

    const noAssembler = await runOneTurn({ agentSystemPrompt: "you are the reviewer" });
    expect(noAssembler[0]!.system).toBe("you are the reviewer");
  });

  test("the fake echoes its inputs and records call order -- a lane can develop against it before Lane C lands", () => {
    const calls: SystemPromptInput[] = [];
    const fake = fakeSystemPromptAssembler({ calls, presetVersion: "v9" });
    const out = fake.assemble({ config: baseConfig(), cwd: "/w", env: {}, platform: "darwin", osVersion: "26", shell: "/bin/zsh", date: "2026-09-04", planMode: true });
    expect(out.system).toContain("cwd=/w");
    expect(out.system).toContain("planMode=true");
    expect(out.presetVersion).toBe("v9");
    expect(calls).toHaveLength(1);
  });
});
