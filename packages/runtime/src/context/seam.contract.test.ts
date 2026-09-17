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
    const inline: SystemPromptAssembler = { assemble: (): AssembledPrompt => ({ system: "s" }) };
    expect(inline.assemble({ config: baseConfig(), cwd: "/x", env: {}, platform: "darwin", osVersion: "26", shell: "/bin/zsh", date: "2026-09-04", planMode: false })).toEqual({
      system: "s",
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

  test("SDK 0.0.16: the userContext is ONE index-0 message, merged ahead of the prompt, identical on every request, and never in history", async () => {
    const CTX = [["claudeMd", "RULES"], ["currentDate", "Today's date is 2026-09-04."]] as const;
    const requests = await runOneTurn({ assembler: fakeSystemPromptAssembler({ system: "S", userContext: [...CTX] }), turns: 2, text: "go" });
    const ctxText = "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# claudeMd\nRULES\n# currentDate\nToday's date is 2026-09-04.\n\n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>\n";
    const first = requests[0]!;
    expect(first.messages).toHaveLength(1);
    // The Agent tool is advertised here, so the persisted agent listing leads the message (claude's
    // reorder puts attachments above the index-0 context); the context and the prompt follow.
    const blocks = first.messages[0]!.content as Array<{ type: string; text: string }>;
    expect(blocks[0]!.text.startsWith("<system-reminder>\nAvailable agent types for the Agent tool:")).toBe(true);
    expect(blocks.slice(1)).toEqual([{ type: "text", text: `${ctxText}\n` }, { type: "text", text: "go" }]);
    // Turn 2 repeats turn 1's message byte for byte, and the new prompt carries NOTHING extra.
    const second = requests[1]!;
    expect(second.messages[0]).toEqual(first.messages[0]);
    expect(second.messages.at(-1)).toEqual({ role: "user", content: "go-1" });
  });

  test("the userContext is built ONCE per session context (memoized), not once per turn", async () => {
    let built = 0;
    const assembler: SystemPromptAssembler = {
      assemble: () => ({ system: "S" }),
      userContext: () => {
        built++;
        return [["currentDate", "d"]];
      },
    };
    await runOneTurn({ assembler, turns: 3 });
    expect(built).toBe(1);
  });

  test("an assembler with NO userContext prepends no index-0 context; with NO assembler the message is untouched (R5-16)", async () => {
    const withAssembler = await runOneTurn({ assembler: fakeSystemPromptAssembler({ system: "S" }) });
    const texts = JSON.stringify(withAssembler[0]!.messages);
    expect(texts).not.toContain("As you answer the user's questions");
    // The only thing ahead of the prompt is the persisted agent listing (an assembler is registered).
    const blocks = withAssembler[0]!.messages[0]!.content as Array<{ text: string }>;
    expect(blocks.at(-1)!.text).toBe("go");
    expect(blocks.slice(0, -1).every((b) => b.text.startsWith("<system-reminder>\nAvailable agent types"))).toBe(true);
    const without = await runOneTurn({});
    expect(without[0]!.messages).toEqual([{ role: "user", content: "go" }]);
  });

  test("R5-3/P4-J: `agentPrompt` reaches the assembler, and with NO assembler it IS the system prompt (the engine forwards, never authors)", async () => {
    const calls: SystemPromptInput[] = [];
    await runOneTurn({ assembler: fakeSystemPromptAssembler({ calls }), agentSystemPrompt: "you are the reviewer" });
    expect(calls[0]!.agentPrompt).toBe("you are the reviewer");

    const noAssembler = await runOneTurn({ agentSystemPrompt: "you are the reviewer" });
    expect(noAssembler[0]!.system).toBe("you are the reviewer");
  });

  // SDK 0.0.16 retires RULING P5-F's re-anchoring (nothing rides the last user message any more); what
  // replaces it is claude's: a compaction CLEARS the session context memo, and the next request
  // rebuilds the index-0 message from scratch -- ahead of the summary, exactly once.
  describe("a MID-TURN compaction rebuilds the index-0 context", () => {
    async function withCompaction(keep: number): Promise<{ requests: ProviderRequest[]; built: number }> {
      const { host, runtime } = createInMemoryChannel();
      const { provider, requests } = recordingProvider(["done", "done"]);
      let compacted = false;
      let built = 0;
      const done = runEngine({
        config: baseConfig(),
        input: runtime.input,
        output: runtime.output,
        provider,
        tools: stubExecutor,
        systemPromptAssembler: {
          assemble: () => ({ system: "S" }),
          userContext: () => {
            built++;
            return [["claudeMd", `WINTER-MD-BLOCK-${built}`]];
          },
        },
        compactionController: {
          // Compacts exactly once, on the SECOND envelope, so request 1 is the un-compacted control
          // and request 2 is the post-compaction case.
          shouldCompact: () => {
            if (compacted) return false;
            return requests.length > 0;
          },
          async compact(input) {
            compacted = true;
            return { summary: "THE SUMMARY", retained: keep > 0 ? input.messages.slice(-keep) : [], preTokens: 1, evidencedToolNames: [] };
          },
        },
      });
      host.output.write({ type: "user", text: "first" });
      host.output.write({ type: "user", text: "second" });
      host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
      await drain(host.input);
      await done;
      return { requests, built };
    }

    test("retained: [] -- the rebuilt context leads the summary, once, and the summary text is intact", async () => {
      const { requests, built } = await withCompaction(0);
      expect(requests).toHaveLength(2);
      expect(built).toBe(2);
      const post = requests[1]!.messages;
      expect(post).toHaveLength(1);
      const blocks = post[0]!.content as Array<{ type: string; text: string }>;
      // [the re-announced agent listing, the rebuilt context, the summary]
      expect(blocks.map((b) => b.text.includes("WINTER-MD-BLOCK-2"))).toEqual([false, true, false]);
      expect(blocks[0]!.text).toContain("Available agent types for the Agent tool:");
      expect(blocks[2]!.text).toBe("THE SUMMARY");
      expect(JSON.stringify(post)).not.toContain("WINTER-MD-BLOCK-1");
    });

    test("retained: N -- the context is still present exactly once, at the front", async () => {
      const { requests } = await withCompaction(1);
      const joined = JSON.stringify(requests[1]!.messages);
      expect(joined.match(/WINTER-MD-BLOCK-2/g)).toHaveLength(1);
      expect(joined.indexOf("WINTER-MD-BLOCK-2")).toBeLessThan(joined.indexOf("THE SUMMARY"));
    });
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
