// WS-23 item 4: the compaction summary REUSES the session's own request -- its system blocks, tools,
// model, reasoning settings and every message the main loop already sent -- with the instruction
// appended as the last user message, so the largest request of a session reads its prefix from the
// prompt cache. Ground truth is the request the provider receives.
import { describe, expect, test } from "bun:test";
import type { WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { createContextAccountant, ProviderTurnError, runEngine, type EngineOptions, type ModelDescription, type ProviderMessage, type ProviderRequest, type ProviderTurn } from "../engine.ts";
import { stubExecutor } from "../provider/mock.ts";
import { createCompactionController } from "./controller.ts";
import { CARRIED_SUMMARY_NOTE, retainedExchangesNote, WINTER_PREFIX_SUMMARY_INSTRUCTION } from "./summarizer.ts";

const history = (pairs: number): ProviderMessage[] =>
  Array.from({ length: pairs }, (_, i) => [
    { role: "user" as const, content: `question ${i}` },
    { role: "assistant" as const, content: `answer ${i}` },
  ]).flat();

describe("the controller's prefix-reusing summary (WS-23 item 4)", () => {
  test("the session's own request goes out verbatim with the instruction appended as the last user message", async () => {
    const seen: ProviderRequest[] = [];
    const prefix: ProviderRequest = {
      messages: history(6),
      system: "SYS",
      systemBlocks: [{ text: "SYS", cacheScope: "org" }],
      tools: [{ name: "Bash", description: "run", inputSchema: { type: "object" } }],
      model: "claude-opus-5-5",
      effort: "high",
    };
    const controller = createCompactionController({ retainedPairs: 2 });
    const result = await controller.compact({
      messages: history(6),
      trigger: "manual",
      customInstructions: null,
      accountant: createContextAccountant(),
      provider: {
        async generate(req) {
          seen.push(req);
          return { kind: "text", text: "the summary" };
        },
      },
      prefixRequest: prefix,
    });
    expect(result.summary).toBe("the summary");
    expect(seen).toHaveLength(1);
    const sent = seen[0]!;
    expect(sent.messages.slice(0, prefix.messages.length)).toEqual(prefix.messages);
    // The instruction, scoped to what the compaction REPLACES: the two retained exchanges stay verbatim.
    expect(sent.messages.at(-1)).toEqual({ role: "user", content: `${WINTER_PREFIX_SUMMARY_INSTRUCTION} ${retainedExchangesNote(2)}` });
    expect(sent.systemBlocks).toEqual(prefix.systemBlocks);
    expect(sent.tools).toEqual(prefix.tools);
    expect(sent.effort).toBe("high");
    expect(sent.model).toBe("claude-opus-5-5");
  });

  test("a model that answers with a tool call instead of text falls back to the redacted, tool-less summary on the same provider", async () => {
    const seen: ProviderRequest[] = [];
    const controller = createCompactionController({ retainedPairs: 2 });
    const result = await controller.compact({
      messages: history(6),
      trigger: "auto",
      customInstructions: null,
      accountant: createContextAccountant(),
      provider: {
        async generate(req): Promise<ProviderTurn> {
          seen.push(req);
          return seen.length === 1 ? { kind: "tool_use", calls: [{ id: "x", name: "Bash", input: {} }] } : { kind: "text", text: "fallback summary" };
        },
      },
      prefixRequest: { messages: history(6), tools: [{ name: "Bash", description: "run", inputSchema: { type: "object" } }] },
    });
    expect(result.summary).toBe("fallback summary");
    expect(seen).toHaveLength(2);
    expect(seen[1]!.tools).toBeUndefined();
    expect(typeof seen[1]!.system).toBe("string");
  });

  test("a carried summary stays verbatim: the model is told to summarise only what follows it, and the result is concatenated", async () => {
    const seen: ProviderRequest[] = [];
    const controller = createCompactionController({ retainedPairs: 1 });
    const provider = {
      async generate(req: ProviderRequest): Promise<ProviderTurn> {
        seen.push(req);
        return { kind: "text", text: `summary ${seen.length}` };
      },
    };
    const first = await controller.compact({ messages: history(4), trigger: "auto", customInstructions: null, accountant: createContextAccountant(), provider, prefixRequest: { messages: history(4) } });
    const again: ProviderMessage[] = [{ role: "user", content: first.summary }, ...first.retained, ...history(3)];
    const second = await controller.compact({ messages: again, trigger: "auto", customInstructions: null, accountant: createContextAccountant(), provider, prefixRequest: { messages: again } });
    expect(seen[1]!.messages.at(-1)).toEqual({ role: "user", content: `${WINTER_PREFIX_SUMMARY_INSTRUCTION} ${CARRIED_SUMMARY_NOTE} ${retainedExchangesNote(1)}` });
    expect(second.summary).toBe("summary 1\n\nsummary 2");
  });
});

describe("fallbacks: the prefix is an optimisation, never a new way for compaction to fail (WS-23 fix round 1, C1)", () => {
  const prefix: ProviderRequest = { messages: history(6), tools: [{ name: "Bash", description: "run", inputSchema: { type: "object" } }], systemBlocks: [{ text: "SYS", cacheScope: "org" }], system: "SYS" };

  test("a provider 400 on the prefix request falls back to the redacted, tool-less summary", async () => {
    const seen: ProviderRequest[] = [];
    const result = await createCompactionController({ retainedPairs: 2 }).compact({
      messages: history(6),
      trigger: "auto",
      customInstructions: null,
      accountant: createContextAccountant(),
      provider: {
        async generate(req): Promise<ProviderTurn> {
          seen.push(req);
          if (seen.length === 1) throw new ProviderTurnError("provider request failed (bad_request): HTTP 400 — prompt is too long", { status: 400, code: "bad_request", retryable: false });
          return { kind: "text", text: "redacted summary" };
        },
      },
      prefixRequest: prefix,
    });
    expect(result.summary).toBe("redacted summary");
    expect(seen).toHaveLength(2);
    expect(seen[1]!.tools).toBeUndefined();
    expect(seen[1]!.systemBlocks).toBeUndefined();
  });

  test("an OVERFLOW-driven compaction never sends the full history: one redacted request, only the part being replaced", async () => {
    const seen: ProviderRequest[] = [];
    const result = await createCompactionController({ retainedPairs: 2 }).compact({
      messages: history(6),
      trigger: "auto",
      reason: "overflow",
      customInstructions: null,
      accountant: createContextAccountant(),
      provider: {
        async generate(req): Promise<ProviderTurn> {
          seen.push(req);
          return { kind: "text", text: "redacted summary" };
        },
      },
      prefixRequest: prefix,
    });
    expect(result.summary).toBe("redacted summary");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.tools).toBeUndefined();
    // Four of the six exchanges are summarised; the two retained ones never reach the summariser. The
    // ninth message is the instruction as the final user turn (WS-23 midconv live gate: no prefill).
    expect(seen[0]!.messages).toHaveLength(9);
    expect(seen[0]!.messages.at(-1)!.role).toBe("user");
    expect(JSON.stringify(seen[0]!.messages)).not.toContain("question 5");
  });

  test("a non-provider failure (a programming error) still propagates rather than being papered over", async () => {
    const run = createCompactionController({ retainedPairs: 2 }).compact({
      messages: history(6),
      trigger: "auto",
      customInstructions: null,
      accountant: createContextAccountant(),
      provider: {
        async generate(): Promise<ProviderTurn> {
          throw new TypeError("bug");
        },
      },
      prefixRequest: prefix,
    });
    await expect(run).rejects.toThrow("bug");
  });
});

describe("through the engine: /compact reuses the last main-loop request's prefix (WS-23 item 4)", () => {
  test("system blocks, tools, effort and every earlier message are byte-identical to the main loop's; only the instruction is new", async () => {
    const requests: ProviderRequest[] = [];
    const { host, runtime } = createInMemoryChannel();
    const describe: ModelDescription = { efforts: ["low", "medium", "high", "xhigh", "max"], wire: { perMessageEffort: true } };
    const done = runEngine({
      config: { sessionId: "ws23-compact", cwd: "/winter-fixture", model: "anthropic/claude-opus-5-5", effort: "high" },
      input: runtime.input,
      output: runtime.output,
      provider: {
        async generate(req) {
          requests.push({ ...req, messages: structuredClone(req.messages) });
          return { kind: "text", text: `reply ${requests.length}` };
        },
      },
      tools: stubExecutor,
      providerIdentity: { providerId: "anthropic", modelKey: "anthropic/claude-opus-5-5", family: "anthropic" },
      describeModel: () => describe,
      compactionController: createCompactionController({ retainedPairs: 1 }),
    } as EngineOptions);
    const frames: WinterFrame[] = [];
    const reader = (async () => {
      for await (const f of host.input) frames.push(f);
    })();
    const results = (): number => frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").length;
    const send = async (text: string, n: number): Promise<void> => {
      host.output.write({ type: "user", text });
      for (let i = 0; i < 2000 && results() < n; i++) await new Promise((r) => setTimeout(r, 2));
    };
    await send("one", 1);
    host.output.write({ type: "control_request", requestId: "e", subtype: "set_effort", payload: { effort: "low" } });
    for (let i = 0; i < 500 && !frames.some((f) => f.type === "control_response"); i++) await new Promise((r) => setTimeout(r, 2));
    await send("two", 2);
    await send("three", 3);
    await send("/compact", 4);
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    await done;
    await reader;

    const lastMain = requests[2]!;
    const summary = requests[3]!;
    expect(summary.messages.at(-1)).toEqual({ role: "user", content: `${WINTER_PREFIX_SUMMARY_INSTRUCTION} ${retainedExchangesNote(1)}` });
    // Everything the last main-loop request sent is a byte-identical prefix of the summary request --
    // the effort marker before `two` included -- and the reply it produced follows it.
    expect(summary.messages.slice(0, lastMain.messages.length)).toEqual(lastMain.messages);
    expect(summary.messages[lastMain.messages.length]).toMatchObject({ role: "assistant", content: "reply 3" });
    expect(summary.effort).toBe(lastMain.effort);
    expect(summary.tools).toEqual(lastMain.tools);
    expect(summary.system).toBe(lastMain.system);
  });
});
