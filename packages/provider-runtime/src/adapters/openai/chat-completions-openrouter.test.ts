// 0.0.56: the Chat Completions adapter on OpenRouter -- W1 (Anthropic cache_control through OpenRouter,
// with W3's per-marker lifetimes), W5 (the reported cost and cache writes), and W7 (reasoning_details
// captured whole and replayed verbatim), driven offline: `fetch` is stubbed with a fixture shaped from
// OpenRouter's documented wire, and the whole host loop -- streamTurn, the stream assembler, the history
// renderer, the next request -- runs as a consumer would run it.
import { afterEach, describe, expect, test } from "bun:test";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import fixture from "./__fixtures__/openrouter-reasoning-tool-loop.json" with { type: "json" };
import { ChatStreamMapper, ReasoningDetailsAccumulator, buildChatBody, chatReasoningParameterFor, mapChatMessages, openRouterAnthropicCaching, withChatCacheMarkers } from "./chat-completions.ts";
import { resolveReasoning } from "./shared.ts";
import { testContext } from "./testing.ts";
import { createShippedAdapters } from "../index.ts";
import { createRegistry } from "../../registry.ts";
import { createHistoryRenderer } from "../../continuity/renderer.ts";
import { assembledToMessage, foldProviderStream } from "../../stream-assembler.ts";
import { ProviderRequestError } from "../../http.ts";
import type { ProviderEvent, ProviderMessageLike, TurnRequest } from "../../types.ts";

const catalog = loadCatalog();
const row = (key: string) => catalog.models.find((m) => m.key === key)!;
const SONNET = row("openrouter/anthropic/claude-sonnet-5.5");
const HAIKU = row("openrouter/anthropic/claude-haiku-5.5");
const SOL = row("openrouter/openai/gpt-6.1-sol");

const A = "You are the character.";
const B = "Notes for today.";
/** The consumer's exact shape: `system` = A + blank line + B, `systemBlocks` [A, B] at scope org, `cacheTtl: "1h"`, no system message in `messages`. */
const consumerRequest = (messages: ProviderMessageLike[], over: Partial<TurnRequest> = {}): TurnRequest => ({
  model: "anthropic/claude-sonnet-5.5",
  system: `${A}\n\n${B}`,
  systemBlocks: [
    { text: A, cacheScope: "org" },
    { text: B, cacheScope: "org" },
  ],
  cacheTtl: "1h",
  messages,
  ...over,
});

function body(req: TurnRequest, descriptor = SONNET, anthropicCacheControl = true): { messages: Array<Record<string, unknown>> } {
  return buildChatBody(req, resolveReasoning(req, descriptor), descriptor, false, { anthropicCacheControl, replayReasoningDetails: true }) as never;
}

describe("W1: Anthropic cache_control through OpenRouter", () => {
  test("gated on OpenRouter + an anthropic/* upstream id + promptCaching evidence", () => {
    expect(openRouterAnthropicCaching("openrouter", SONNET)).toBe(true);
    expect(openRouterAnthropicCaching("openrouter", HAIKU)).toBe(true);
    expect(openRouterAnthropicCaching("openrouter", SOL)).toBe(false);
    expect(openRouterAnthropicCaching("anthropic", SONNET)).toBe(false);
    expect(openRouterAnthropicCaching("openrouter", undefined)).toBe(false);
    expect(openRouterAnthropicCaching("openrouter", { ...SONNET, promptCaching: undefined } as never)).toBe(false);
  });

  test("the consumer's shape: system as two cache-marked text parts at 1h; the rolling marker at the default 5m", () => {
    const b = body(consumerRequest([{ role: "user", content: "hello" }]));
    expect(b.messages[0]).toEqual({
      role: "system",
      content: [
        { type: "text", text: A, cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "text", text: B, cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
    });
    expect(b.messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] });
    // Exactly one system message, and it is the first: nothing system-role inside the conversation.
    expect(b.messages.filter((m) => m["role"] === "system")).toHaveLength(1);
  });

  test("rolling and lookback markers at 1h on a long conversation; the lookback sits on the previous request's write", () => {
    // A text-only user turn collapses to ONE string on this wire, so the lookback window is crossed by a
    // turn that keeps its parts -- here ten screenshots, each with a caption (20 parts).
    const image = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: "iVBORw0KGgo=" } };
    const history: ProviderMessageLike[] = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: Array.from({ length: 10 }, (_, i) => [image, { type: "text" as const, text: `shot ${i}` }]).flat() },
    ];
    const b = body(consumerRequest(history, { messageCacheTtl: { rolling: "1h" } }));
    const msgs = b.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(msgs[1]!.content[0]!["cache_control"]).toEqual({ type: "ephemeral", ttl: "1h" }); // lookback, on q1
    expect(msgs[3]!.content[19]!["cache_control"]).toEqual({ type: "ephemeral", ttl: "1h" }); // rolling, on the last text part
    expect(JSON.stringify(b).match(/cache_control/g)).toHaveLength(4); // two system + two message: the limit
  });

  test("the rolling marker lands on the last TOOL reply when the request ends on tool results", () => {
    const history: ProviderMessageLike[] = [
      { role: "user", content: "check" },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "lookup", input: {} }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "c1", content: "sunny" }] },
    ];
    const msgs = body(consumerRequest(history)).messages;
    expect(msgs[3]).toEqual({ role: "tool", tool_call_id: "c1", content: [{ type: "text", text: "sunny", cache_control: { type: "ephemeral" } }] });
  });

  test("W3's order rule applies on this wire too: a 1h message marker after 5m system markers is refused, typed", () => {
    let caught: unknown;
    try {
      const { cacheTtl: _noSystemTtl, ...request } = consumerRequest([{ role: "user", content: "hi" }], { messageCacheTtl: { rolling: "1h" } });
      body(request);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderRequestError);
    expect((caught as ProviderRequestError).code).toBe("bad_request");
  });

  test("off the gate (an OpenAI model on OpenRouter, or no systemBlocks) the body is exactly as before: one plain system string, no markers", () => {
    const b = body(consumerRequest([{ role: "user", content: "hi" }], { model: "openai/gpt-6.1-sol" }), SOL, false);
    expect(b.messages[0]).toEqual({ role: "system", content: `${A}\n\n${B}` });
    expect(JSON.stringify(b)).not.toContain("cache_control");
    const noBlocks = body({ model: "anthropic/claude-sonnet-5.5", system: "plain", messages: [{ role: "user", content: "hi" }] });
    expect(noBlocks.messages[0]).toEqual({ role: "system", content: "plain" });
    expect(JSON.stringify(noBlocks)).not.toContain("cache_control");
  });

  test("withChatCacheMarkers respects the budget the system blocks left", () => {
    const wire = [{ role: "user", content: "x" }];
    expect(withChatCacheMarkers(wire, 0, { rolling: "5m", lookback: "5m" })).toEqual(wire);
  });
});

describe("W7 fix: OpenRouter takes the effort as its unified `reasoning` object", () => {
  test("chatReasoningParameterFor: the object on OpenRouter only", () => {
    expect(chatReasoningParameterFor("openrouter")).toBe("reasoning-object");
    expect(chatReasoningParameterFor("deepseek")).toBe("reasoning_effort");
    expect(chatReasoningParameterFor("openai")).toBe("reasoning_effort");
  });

  test("the shipped adapter's OpenRouter body carries reasoning: { effort }, the row's own value, and no reasoning_effort", async () => {
    const bodies = stubFetchSequence([fixture.turn2, fixture.turn2, fixture.turn2]);
    const adapter = createShippedAdapters(catalog).find((a) => a.id === "winter.openai-chat-completions")!;
    for (const effort of ["medium", "high"] as const) {
      await foldProviderStream(adapter.streamTurn({ model: "anthropic/claude-sonnet-5.5", effort, messages: [{ role: "user", content: "hi" }] }, testContext({ providerId: "openrouter" })));
    }
    await foldProviderStream(adapter.streamTurn({ model: "deepseek/deepseek-v4.1-flash", effort: "max", messages: [{ role: "user", content: "hi" }] }, testContext({ providerId: "openrouter" })));
    expect(bodies.map((b) => b["reasoning"])).toEqual([{ effort: "medium" }, { effort: "high" }, { effort: "max" }]);
    for (const b of bodies) expect("reasoning_effort" in b).toBe(false);
  });

  test("no effort, no reasoning object; an effort the row does not list is refused before sending", async () => {
    const bodies = stubFetchSequence([fixture.turn2]);
    const adapter = createShippedAdapters(catalog).find((a) => a.id === "winter.openai-chat-completions")!;
    await foldProviderStream(adapter.streamTurn({ model: "anthropic/claude-sonnet-5.5", messages: [{ role: "user", content: "hi" }] }, testContext({ providerId: "openrouter" })));
    expect("reasoning" in bodies[0]!).toBe(false);
    const refused = await foldProviderStream(adapter.streamTurn({ model: "anthropic/claude-sonnet-5.5", effort: "minimal" as never, messages: [{ role: "user", content: "hi" }] }, testContext({ providerId: "openrouter" }))).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(Error);
    expect(bodies).toHaveLength(1);
  });

  test("other chat surfaces keep reasoning_effort", () => {
    const req = { model: "deepseek-reasoner", effort: "high" as const, messages: [{ role: "user" as const, content: "hi" }] };
    const deepseek = catalog.models.find((m) => m.key === "deepseek/deepseek-reasoner") ?? SONNET;
    const b = buildChatBody(req, { effort: "high", wantsEncryptedContent: false, enabled: true }, deepseek, false, {});
    expect(b["reasoning_effort"]).toBe("high");
    expect("reasoning" in b).toBe(false);
  });
});

describe("W5: OpenRouter's reported cost and cache writes", () => {
  const usageChunk = { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 40, cost: 0.00123, prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 150 } } };
  test("on the OpenRouter connection: reportedCostUsd, and the writes split out of the non-cached input", () => {
    const usage = new ChatStreamMapper(false, { reportedCost: true }).map(JSON.stringify(usageChunk)).find((e) => e.type === "usage");
    expect(usage).toEqual({ type: "usage", inputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 150, outputTokens: 40, reportedCostUsd: 0.00123 });
  });
  test("on any other connection a `cost` field is not read (no unit is promised)", () => {
    const usage = new ChatStreamMapper(false).map(JSON.stringify(usageChunk)).find((e) => e.type === "usage");
    expect(usage && "reportedCostUsd" in usage).toBe(false);
  });
});

describe("W7: reasoning_details", () => {
  test("streamed fragments of one block (same index and type) join into the non-streaming shape", () => {
    const acc = new ReasoningDetailsAccumulator();
    acc.add([{ type: "reasoning.text", text: "a", index: 0, signature: null }]);
    acc.add([{ type: "reasoning.text", text: "b", index: 0 }]);
    acc.add([{ type: "reasoning.text", signature: "sig", index: 0 }]);
    acc.add([{ type: "reasoning.encrypted", data: "x", index: 1 }]);
    acc.add([{ type: "reasoning.summary", summary: "s" }]);
    expect(acc.complete).toEqual([
      { type: "reasoning.text", text: "ab", index: 0, signature: "sig" },
      { type: "reasoning.encrypted", data: "x", index: 1 },
      { type: "reasoning.summary", summary: "s" },
    ]);
  });

  test("not captured for a row whose continuation is not opaque state", () => {
    const events: ProviderEvent[] = [];
    const mapper = new ChatStreamMapper(false);
    for (const chunk of fixture.turn1) events.push(...mapper.map(JSON.stringify(chunk)));
    events.push(...mapper.map("[DONE]"));
    expect(events.some((e) => e.type === "native_state")).toBe(false);
  });

  test("replayed verbatim onto the assistant message, and merged across consecutive assistant messages in order", () => {
    const details = (d: unknown[]): ProviderMessageLike => ({ role: "assistant", content: "x", nativeState: { family: "openai", continuationDomain: "d", items: [{ type: "winter.reasoning_details", details: d }] } });
    const wire = mapChatMessages([details([{ n: 1 }]), details([{ n: 2 }])], false, { replayReasoningDetails: true }) as Array<Record<string, unknown>>;
    expect(wire).toEqual([{ role: "assistant", content: "x\nx", reasoning_details: [{ n: 1 }, { n: 2 }] }]);
    expect(mapChatMessages([details([{ n: 1 }])], false, {})).toEqual([{ role: "assistant", content: "x" }]);
  });
});

// --- the whole loop, as the consumer runs it ---------------------------------------------------------

let restoreFetch: (() => void) | undefined;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

function stubFetchSequence(turns: readonly unknown[][]): Array<Record<string, unknown>> {
  const original = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  let i = 0;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const chunks = turns[i++] ?? [];
    const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = original;
  };
  return bodies;
}

describe("W7 + W1 + W5 end to end: a Claude tool loop through OpenRouter", () => {
  test("turn 2 sends turn 1's reasoning_details back byte for byte, beside the tool call and its result", async () => {
    const registry = createRegistry(catalog);
    for (const adapter of createShippedAdapters(catalog)) registry.register(adapter);
    const resolved = registry.resolve({ model: "anthropic/claude-sonnet-5.5", provider: { providerId: "openrouter" } });
    if (!("adapter" in resolved)) throw new Error(`resolution failed: ${String(resolved)}`);
    expect(resolved.continuationDomain).toBe("openrouter/anthropic/claude-sonnet-5.5");
    const renderer = createHistoryRenderer(registry);
    const target = { family: resolved.adapter.family, ...(resolved.continuationDomain !== undefined ? { continuationDomain: resolved.continuationDomain } : {}), readableState: "none" as const, providerId: resolved.providerId, modelKey: resolved.modelKey };
    const origin = { providerId: resolved.providerId, modelKey: resolved.modelKey, family: resolved.adapter.family, ...(resolved.continuationDomain !== undefined ? { continuationDomain: resolved.continuationDomain } : {}) };
    const ctx = testContext({ providerId: "openrouter" });
    const bodies = stubFetchSequence([fixture.turn1, fixture.turn2]);
    const tools = [{ name: "lookup", description: "Look something up.", inputSchema: { type: "object", properties: { q: { type: "string" } } } }];

    const history: ProviderMessageLike[] = [{ role: "user", content: "What's the weather?" }];
    const first = await foldProviderStream(resolved.adapter.streamTurn(consumerRequest(renderer.render(history, new Map(), target), { model: resolved.providerModelId, tools }), ctx));
    expect(first.kind).toBe("tool_use");
    expect(first.usage).toEqual({ inputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 150, outputTokens: 40, reasoningTokens: 12, reportedCostUsd: 0.00123 });
    history.push(assembledToMessage(first, origin));
    history.push({ role: "tool", content: [{ type: "tool_result", tool_use_id: "toolu_synthetic_01", content: "sunny" }] });

    const second = await foldProviderStream(resolved.adapter.streamTurn(consumerRequest(renderer.render(history, new Map(), target), { model: resolved.providerModelId, tools }), ctx));
    expect(second.kind === "text" && second.text).toBe("Sunny today.");

    const sent = bodies[1]!["messages"] as Array<Record<string, unknown>>;
    const assistant = sent.find((m) => m["role"] === "assistant")!;
    expect(assistant["reasoning_details"]).toEqual(fixture.expectedReasoningDetails);
    expect(assistant["tool_calls"]).toEqual([{ id: "toolu_synthetic_01", type: "function", function: { name: "lookup", arguments: '{"q":"weather"}' } }]);
    // The tool reply ends the request, so it carries the rolling breakpoint.
    expect(sent.at(-1)).toEqual({ role: "tool", tool_call_id: "toolu_synthetic_01", content: [{ type: "text", text: "sunny", cache_control: { type: "ephemeral" } }] });
    expect(bodies[0]!["model"]).toBe("anthropic/claude-sonnet-5.5");
  });

  test("a different model never receives the state: the renderer strips it outside the route's own domain", () => {
    const registry = createRegistry(catalog);
    for (const adapter of createShippedAdapters(catalog)) registry.register(adapter);
    const renderer = createHistoryRenderer(registry);
    const message: ProviderMessageLike = {
      role: "assistant",
      content: "x",
      origin: { providerId: "openrouter", modelKey: "openrouter/anthropic/claude-sonnet-5.5", family: "openai", continuationDomain: "openrouter/anthropic/claude-sonnet-5.5" },
      nativeState: { family: "openai", continuationDomain: "openrouter/anthropic/claude-sonnet-5.5", items: [{ type: "winter.reasoning_details", details: [{ secret: true }] }] },
    };
    const [rendered] = renderer.render([message], new Map(), { family: "openai", continuationDomain: "openrouter/anthropic/claude-haiku-5.5", readableState: "none", providerId: "openrouter", modelKey: "openrouter/anthropic/claude-haiku-5.5" });
    expect(rendered!.nativeState).toBeUndefined();
  });
});
