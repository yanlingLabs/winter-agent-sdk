// 2026-10-29 (continuation audit): the reasoning state each chat-completions surface takes back, proven on
// the wire. Every loop below is the consumer's: the SHIPPED catalog and adapters, the registry's own
// continuation domain, the history renderer, the stream assembler -- `fetch` alone is stubbed, with
// fixtures shaped from each vendor's documented wire (each fixture's `$comment` names the page). Turn 2
// must carry turn 1's state byte for byte, and a different model must never receive it.
import { afterEach, describe, expect, test } from "bun:test";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import googleFixture from "./__fixtures__/google-openai-thought-signature-tool-loop.json" with { type: "json" };
import mistralFixture from "./__fixtures__/mistral-think-chunk-tool-loop.json" with { type: "json" };
import reasoningFixture from "./__fixtures__/reasoning-content-tool-loop.json" with { type: "json" };
import { ChatStreamMapper, chatExposedReasoningFieldFor, chatPreserveThinkingFor, chatThinkChunksFor, chatToolCallExtraContentFor, mapChatMessages, replayableReasoningDetails } from "./chat-completions.ts";
import { toWireMessages } from "../anthropic/messages.ts";
import { testContext } from "./testing.ts";
import { createShippedAdapters } from "../index.ts";
import { createRegistry } from "../../registry.ts";
import { createHistoryRenderer } from "../../continuity/renderer.ts";
import { assembledToMessage, foldProviderStream } from "../../stream-assembler.ts";
import type { ProviderEvent, ProviderMessageLike } from "../../types.ts";

const catalog = loadCatalog();
const row = (key: string) => catalog.models.find((m) => m.key === key)!;

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

function shippedRegistry() {
  const registry = createRegistry(catalog);
  for (const adapter of createShippedAdapters(catalog)) registry.register(adapter);
  return registry;
}

const TOOLS = [{ name: "get_current_temperature", description: "The temperature at a place.", inputSchema: { type: "object", properties: { location: { type: "string" } } } }];

/**
 * Two turns of one tool loop through the shipped stack: turn 1 answers with tool calls, the results go
 * back, turn 2 is sent. Returns both request bodies and the assistant message turn 1 left in history.
 */
async function toolLoop(providerId: string, model: string, turns: { turn1: unknown[]; turn2: unknown[] }, results: Array<{ id: string; content: string }>) {
  const registry = shippedRegistry();
  const resolved = registry.resolve({ model, provider: { providerId } });
  if (!("adapter" in resolved)) throw new Error(`resolution failed: ${String(resolved)}`);
  const renderer = createHistoryRenderer(registry);
  const target = { family: resolved.adapter.family, ...(resolved.continuationDomain !== undefined ? { continuationDomain: resolved.continuationDomain } : {}), readableState: "none" as const, providerId: resolved.providerId, modelKey: resolved.modelKey };
  const origin = { providerId: resolved.providerId, modelKey: resolved.modelKey, family: resolved.adapter.family, ...(resolved.continuationDomain !== undefined ? { continuationDomain: resolved.continuationDomain } : {}) };
  const ctx = testContext({ providerId });
  const bodies = stubFetchSequence([turns.turn1, turns.turn2]);
  const history: ProviderMessageLike[] = [{ role: "user", content: "Check the weather in Paris and London." }];
  const first = await foldProviderStream(resolved.adapter.streamTurn({ model: resolved.providerModelId, messages: renderer.render(history, new Map(), target), tools: TOOLS }, ctx));
  expect(first.kind).toBe("tool_use");
  const assistant = assembledToMessage(first, origin);
  history.push(assistant);
  history.push({ role: "tool", content: results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.content })) });
  await foldProviderStream(resolved.adapter.streamTurn({ model: resolved.providerModelId, messages: renderer.render(history, new Map(), target), tools: TOOLS }, ctx));
  return { bodies, assistant, resolved, renderer };
}

describe("Gemini thought signatures on Google's OpenAI-compatible endpoint (google-openai)", () => {
  const GEMINI_3_PLUS = catalog.models.filter((m) => m.providerId === "google-openai" && /^gemini-(3|4)/.test(m.upstreamId));

  test("the gate: google-openai rows whose continuation is opaque state, and no other surface", () => {
    expect(GEMINI_3_PLUS.length).toBeGreaterThanOrEqual(9);
    for (const m of GEMINI_3_PLUS) expect([m.key, chatToolCallExtraContentFor("google-openai", m)]).toEqual([m.key, true]);
    // Gemini 2.5 on this endpoint documents no signatures ("Gemini 3 supports OpenAI compatibility for thought signatures").
    expect(chatToolCallExtraContentFor("google-openai", row("google-openai/gemini-2.5-pro"))).toBe(false);
    // The same row on any other connection: the field is Google's alone.
    expect(chatToolCallExtraContentFor("openrouter", row("google-openai/gemini-4-argon"))).toBe(false);
    expect(chatToolCallExtraContentFor("deepseek", row("google-openai/gemini-4-argon"))).toBe(false);
  });

  for (const upstream of ["gemini-4-argon", "gemini-3.8-flash", "gemini-3.1-pro-preview"]) {
    test(`${upstream}: turn 2 sends turn 1's extra_content back on the exact call, byte for byte; the unsigned parallel call stays unsigned`, async () => {
      const { bodies, resolved } = await toolLoop("google-openai", upstream, googleFixture, [
        { id: "function-call-synthetic-1", content: '{"temp":"15C"}' },
        { id: "function-call-synthetic-2", content: '{"temp":"12C"}' },
      ]);
      expect(resolved.continuationDomain).toBe(`google-openai/${upstream}`);
      const assistant = (bodies[1]!["messages"] as Array<Record<string, unknown>>).find((m) => m["role"] === "assistant")!;
      expect(assistant["tool_calls"]).toEqual(googleFixture.expectedToolCalls);
      // Turn 1 had no history to carry, so nothing was sent then.
      expect(JSON.stringify(bodies[0])).not.toContain("extra_content");
    });
  }

  test("a Gemini 2.5 row on the same endpoint neither captures nor sends the field", async () => {
    const { bodies, assistant } = await toolLoop("google-openai", "gemini-2.5-pro", googleFixture, [
      { id: "function-call-synthetic-1", content: '{"temp":"15C"}' },
      { id: "function-call-synthetic-2", content: '{"temp":"12C"}' },
    ]);
    expect(assistant.nativeState).toBeUndefined();
    expect(JSON.stringify(bodies[1])).not.toContain("extra_content");
  });

  test("the mapper captures nothing off the gate, and the message mapper replays nothing off the gate", () => {
    const off = new ChatStreamMapper(false);
    const events: ProviderEvent[] = [];
    for (const chunk of googleFixture.turn1) events.push(...off.map(JSON.stringify(chunk)));
    events.push(...off.map("[DONE]"));
    expect(events.some((e) => e.type === "native_state")).toBe(false);
    const message: ProviderMessageLike = {
      role: "assistant",
      content: [{ type: "tool_use", id: "c1", name: "t", input: {} }],
      nativeState: { family: "openai", continuationDomain: "d", items: [{ type: "winter.tool_call_extra_content", calls: [{ id: "c1", extra_content: { google: { thought_signature: "s" } } }] }] },
    };
    expect(JSON.stringify(mapChatMessages([message], false, {}))).not.toContain("extra_content");
    expect(mapChatMessages([message], false, { replayToolCallExtraContent: true })).toEqual([
      { role: "assistant", content: "", tool_calls: [{ extra_content: { google: { thought_signature: "s" } }, id: "c1", type: "function", function: { name: "t", arguments: "{}" } }] },
    ]);
  });

  test("a different model never receives the signature: the renderer strips it outside the route's own domain", async () => {
    const { assistant, renderer } = await toolLoop("google-openai", "gemini-4-argon", googleFixture, [
      { id: "function-call-synthetic-1", content: "x" },
      { id: "function-call-synthetic-2", content: "y" },
    ]);
    expect(assistant.nativeState?.items).toEqual([{ type: "winter.tool_call_extra_content", calls: [{ id: "function-call-synthetic-1", extra_content: { google: { thought_signature: "Q2lRQVZhZjhaU3ludGhldGljQQ==" } } }] }]);
    for (const other of [
      { providerId: "google-openai", modelKey: "google-openai/gemini-3.8-flash" },
      { providerId: "google", modelKey: "google/gemini-4-argon" },
      { providerId: "openrouter", modelKey: "openrouter/google/gemini-4-argon" },
    ]) {
      const [rendered] = renderer.render([assistant], new Map(), { family: "openai", continuationDomain: other.modelKey, readableState: "none", ...other });
      expect([other.modelKey, rendered!.nativeState]).toEqual([other.modelKey, undefined]);
    }
  });
});

describe("Mistral thinking chunks (mistral)", () => {
  test("the gate: Mistral's own API, plaintext rows; nowhere else", () => {
    const rows = catalog.models.filter((m) => m.providerId === "mistral" && m.reasoning?.supported.value === true);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const m of rows) expect([m.key, chatThinkChunksFor("mistral", m)]).toEqual([m.key, true]);
    expect(chatThinkChunksFor("nvidia", row("mistral/mistral-medium-3-5"))).toBe(false);
    expect(chatThinkChunksFor("mistral", row("deepseek/deepseek-v4-pro"))).toBe(true);
    expect(chatThinkChunksFor("mistral", row("google-openai/gemini-4-argon"))).toBe(false);
  });

  for (const upstream of ["mistral-medium-3-5", "mistral-small-2603"]) {
    test(`${upstream}: the answer's first words survive the transition list, and turn 2 carries turn 1's ThinkChunk at the head of content -- no reasoning_content`, async () => {
      const { bodies, assistant } = await toolLoop("mistral", upstream, mistralFixture, [{ id: "Ab1Cd2Ef3", content: '{"temp":"15C"}' }]);
      // The fold kept the whole answer, including the words that rode the transition list.
      expect(assistant.content).toEqual([
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "Ab1Cd2Ef3", name: "get_current_temperature", input: { location: "Paris" } },
      ]);
      const sent = (bodies[1]!["messages"] as Array<Record<string, unknown>>).find((m) => m["role"] === "assistant")!;
      expect(sent["content"]).toEqual(mistralFixture.expectedContent);
      expect(sent["tool_calls"]).toEqual([{ id: "Ab1Cd2Ef3", type: "function", function: { name: "get_current_temperature", arguments: '{"location":"Paris"}' } }]);
      expect("reasoning_content" in sent).toBe(false);
    });
  }

  test("a chunk-list content on any other surface still streams its reasoning and its answer, and captures nothing", () => {
    const mapper = new ChatStreamMapper(false);
    const events: ProviderEvent[] = [];
    for (const chunk of mistralFixture.turn1) events.push(...mapper.map(JSON.stringify(chunk)));
    events.push(...mapper.map("[DONE]"));
    expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("")).toBe("Let me check.");
    expect(events.filter((e) => e.type === "thinking_exposed_delta").map((e) => (e as { text: string }).text).join("")).toBe("The user wants the weather, so I should call the tool for Paris.");
    expect(events.some((e) => e.type === "native_state")).toBe(false);
  });

  test("two runs of thinking are two chunks; a signature is kept and `closed` is not", () => {
    const mapper = new ChatStreamMapper(false, { captureThinkChunks: true });
    const chunk = (content: unknown, finish: string | null = null) => JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: finish }] });
    const events: ProviderEvent[] = [];
    for (const data of [
      chunk([{ type: "thinking", thinking: [{ type: "text", text: "a" }], closed: false }]),
      chunk([{ type: "thinking", thinking: [{ type: "text", text: "b" }], signature: "sig-1", closed: true }, { type: "text", text: "x" }]),
      chunk([{ type: "thinking", thinking: [{ type: "text", text: "c" }] }]),
      chunk("y", "stop"),
      "[DONE]",
    ]) events.push(...mapper.map(data));
    expect((events.find((e) => e.type === "native_state") as { items: unknown[] }).items).toEqual([
      {
        type: "winter.think_chunks",
        chunks: [
          { type: "thinking", thinking: [{ type: "text", text: "ab" }], signature: "sig-1" },
          { type: "thinking", thinking: [{ type: "text", text: "c" }] },
        ],
      },
    ]);
  });

  test("off the gate nothing is replayed, and a message with no chunks keeps its plain string content", () => {
    const message: ProviderMessageLike = { role: "assistant", content: "x", nativeState: { family: "openai", continuationDomain: "d", items: [{ type: "winter.think_chunks", chunks: [{ type: "thinking", thinking: [{ type: "text", text: "t" }] }] }] } };
    expect(mapChatMessages([message], false, {})).toEqual([{ role: "assistant", content: "x" }]);
    expect(mapChatMessages([message], false, { replayThinkChunks: true })).toEqual([{ role: "assistant", content: [{ type: "thinking", thinking: [{ type: "text", text: "t" }] }, { type: "text", text: "x" }] }]);
    expect(mapChatMessages([{ role: "assistant", content: "plain" }], false, { replayThinkChunks: true })).toEqual([{ role: "assistant", content: "plain" }]);
  });

  test("a different model never receives the chunks: the renderer strips them outside the route's own domain", async () => {
    const { assistant, renderer } = await toolLoop("mistral", "mistral-medium-3-5", mistralFixture, [{ id: "Ab1Cd2Ef3", content: "x" }]);
    expect(assistant.nativeState?.items).toEqual([{ type: "winter.think_chunks", chunks: [mistralFixture.expectedContent[0]] }]);
    const [rendered] = renderer.render([assistant], new Map(), { family: "openai", continuationDomain: "mistral/mistral-small-2603", readableState: "full-exposed", providerId: "mistral", modelKey: "mistral/mistral-small-2603" });
    expect(rendered!.nativeState).toBeUndefined();
  });
});

describe("reasoning_content replay on the surfaces that document it", () => {
  // [provider, upstream id, what the request must also carry]
  const CASES: Array<[string, string, Record<string, unknown>]> = [
    ["moonshot", "kimi-k3.1-pro", {}],
    ["moonshot-cn", "kimi-k2.6", {}],
    ["moonshot", "kimi-k2.7-code", {}],
    ["kimi-coding-openai", "k3.1-pro", {}],
    ["kimi-coding-intl-openai", "kimi-for-coding", {}],
    ["xiaomi", "mimo-v2.6-pro", {}],
    ["xiaomi-token-plan", "mimo-v2.5", {}],
    ["minimax", "MiniMax-M3.1-Flash", {}],
    ["minimax-cn", "MiniMax-M2.7", {}],
    ["zai", "glm-5.3-flashx", {}],
    ["zai-coding", "glm-5.3", {}],
    ["zhipu", "glm-4.6", {}],
    ["fireworks", "deepseek-v4-pro", {}],
    ["doubao", "doubao-seed-2-0-pro-260215", {}],
    ["volcengine-agent-plan", "glm-5-2-260617", {}],
    ["tencent-tokenhub", "hy3", {}],
    ["qianfan", "ernie-5.0", {}],
    ["alibaba", "qwen3.8-flash", { preserve_thinking: true }],
    ["qwen-cloud", "qwen3.8-flash", { preserve_thinking: true }],
    ["qwen-cloud", "qwen3.7-plus", { preserve_thinking: true }],
    ["alibaba", "kimi-k2.7-code", { preserve_thinking: true }],
    ["alibaba", "glm-5.2", {}],
  ];
  for (const [providerId, upstream, extra] of CASES) {
    test(`${providerId}/${upstream}: turn 2 carries turn 1's reasoning_content byte for byte${Object.keys(extra).length > 0 ? `, with ${JSON.stringify(extra)}` : ""}`, async () => {
      const { bodies, resolved } = await toolLoop(providerId, upstream, reasoningFixture, [{ id: "call_synthetic_1", content: '{"temp":"15C"}' }]);
      expect(resolved.continuationDomain).toBe(`${providerId}/${upstream}`);
      const assistant = (bodies[1]!["messages"] as Array<Record<string, unknown>>).find((m) => m["role"] === "assistant")!;
      expect(assistant["reasoning_content"]).toBe(reasoningFixture.expectedReasoning);
      expect(assistant["tool_calls"]).toEqual([{ id: "call_synthetic_1", type: "function", function: { name: "get_current_temperature", arguments: '{"location":"Paris"}' } }]);
      for (const body of bodies) {
        for (const [field, value] of Object.entries(extra)) expect(body[field]).toEqual(value);
        if (!("preserve_thinking" in extra)) expect("preserve_thinking" in body).toBe(false);
      }
    });
  }

  test("rows that keep nothing send nothing back: a `none` row's reasoning streams to the host and goes no further", async () => {
    for (const [providerId, upstream] of [
      ["xai-oauth", "grok-4.6"],
      ["nvidia", "nvidia/nemotron-3-super-120b-a12b"],
      ["qwen-coding", "qwen3.7-plus"],
      ["alibaba", "qwen3.5-plus"],
      ["tencent-token-plan", "deepseek-v4-pro-202606"],
      ["qwen-cloud-token-plan", "qwen3.8-flash"],
      ["zai", "glm-4.5"],
      ["novita", "moonshotai/kimi-k2.6"],
    ] as const) {
      const registry = shippedRegistry();
      const resolved = registry.resolve({ model: upstream, provider: { providerId } });
      if (!("adapter" in resolved)) throw new Error(`resolution failed: ${providerId}/${upstream}`);
      expect([providerId, upstream, resolved.descriptor?.reasoning?.continuation]).toEqual([providerId, upstream, "none"]);
      const { bodies, assistant } = await toolLoop(providerId, upstream, reasoningFixture, [{ id: "call_synthetic_1", content: "x" }]);
      expect([providerId, assistant.nativeState]).toEqual([providerId, undefined]);
      expect([providerId, JSON.stringify(bodies[1]).includes("reasoning_content")]).toEqual([providerId, false]);
      expect("preserve_thinking" in bodies[1]!).toBe(false);
    }
  });

  test("Cerebras: the reasoning goes back under its own field, `reasoning`, never as reasoning_content", async () => {
    expect(chatExposedReasoningFieldFor("cerebras")).toBe("reasoning");
    expect(chatExposedReasoningFieldFor("moonshot")).toBe("reasoning_content");
    const { bodies, resolved } = await toolLoop("cerebras", "qwen-3.8-27b", { turn1: reasoningFixture.turn1Reasoning, turn2: reasoningFixture.turn2 }, [{ id: "call_synthetic_1", content: '{"temp":"15C"}' }]);
    expect(resolved.continuationDomain).toBe("cerebras/qwen-3.8-27b");
    const assistant = (bodies[1]!["messages"] as Array<Record<string, unknown>>).find((m) => m["role"] === "assistant")!;
    expect(assistant["reasoning"]).toBe(reasoningFixture.expectedReasoning);
    expect("reasoning_content" in assistant).toBe(false);
  });

  test("preserve_thinking: Model Studio / Qwen Cloud rows on the documented list only -- never GLM, never the Coding Plan, never another provider", () => {
    expect(chatPreserveThinkingFor("alibaba", row("alibaba/qwen3.8-flash"))).toBe(true);
    expect(chatPreserveThinkingFor("qwen-cloud", row("qwen-cloud/qwen3.7-max-2026-06-08"))).toBe(true);
    // The plans' hosts are undocumented for the parameter: never sent there, whatever the row says.
    expect(chatPreserveThinkingFor("qwen-cloud-token-plan", { ...row("qwen-cloud-token-plan/qwen3.6-flash"), reasoning: { ...row("qwen-cloud-token-plan/qwen3.6-flash").reasoning!, continuation: "plaintext" } })).toBe(false);
    expect(row("qwen-cloud-token-plan/qwen3.6-flash").reasoning!.continuation).toBe("none");
    expect(chatPreserveThinkingFor("alibaba", row("alibaba/glm-5.2"))).toBe(false);
    expect(chatPreserveThinkingFor("alibaba", row("alibaba/qwen3.5-plus"))).toBe(false);
    expect(chatPreserveThinkingFor("qwen-coding", row("qwen-coding/qwen3.7-plus"))).toBe(false);
    expect(chatPreserveThinkingFor("moonshot", row("moonshot/kimi-k2.6"))).toBe(false);
  });

  test("a different model never receives the reasoning: stripped outside the route's own domain, the same model at another provider included", async () => {
    const { assistant, renderer } = await toolLoop("moonshot", "kimi-k3.1-pro", reasoningFixture, [{ id: "call_synthetic_1", content: "x" }]);
    expect(assistant.nativeState?.items).toEqual([{ type: "winter.exposed_reasoning", text: reasoningFixture.expectedReasoning }]);
    for (const other of [
      { providerId: "moonshot", modelKey: "moonshot/kimi-k3" },
      { providerId: "moonshot-cn", modelKey: "moonshot-cn/kimi-k3.1-pro" },
      { providerId: "kimi-coding-openai", modelKey: "kimi-coding-openai/k3.1-pro" },
      { providerId: "openrouter", modelKey: "openrouter/moonshotai/kimi-k3.1-pro" },
    ]) {
      const [rendered] = renderer.render([assistant], new Map(), { family: "openai", continuationDomain: other.modelKey, readableState: "full-exposed", ...other });
      expect([other.modelKey, rendered!.nativeState]).toEqual([other.modelKey, undefined]);
      expect(mapChatMessages([rendered!], true)).toEqual([expect.not.objectContaining({ reasoning_content: expect.anything() })]);
    }
  });
});

describe("in-dialect thinking blocks on the Anthropic-compatible endpoints that document them", () => {
  const THINKING = { type: "thinking" as const, thinking: "own step-1 reasoning", signature: "sig-synthetic" };
  const turn = (origin: { providerId: string; modelKey: string; family: string; continuationDomain?: string }): ProviderMessageLike[] => [
    { role: "user", content: "what is in this directory?" },
    { role: "assistant", origin, content: [THINKING, { type: "text", text: "Let me look." }, { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] },
    { role: "tool", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "README.md" }] },
  ];
  const resolveKey = (key: string) => {
    const registry = shippedRegistry();
    const resolved = registry.resolve({ model: key });
    if (!("adapter" in resolved)) throw new Error(`resolution failed: ${key}`);
    return { registry, resolved, origin: { providerId: resolved.providerId, modelKey: resolved.modelKey, family: resolved.adapter.family, ...(resolved.continuationDomain !== undefined ? { continuationDomain: resolved.continuationDomain } : {}) } };
  };

  for (const [key, foreign] of [
    ["moonshot-anthropic/kimi-k3.1-pro", "kimi-coding/k3.1-pro"],
    ["kimi-coding/k3.1-pro", "moonshot-anthropic/kimi-k3.1-pro"],
    ["minimax-anthropic/MiniMax-M3.1-Flash", "minimax-cn-anthropic/MiniMax-M3.1-Flash"],
    ["xiaomi-anthropic/mimo-v2.6-pro", "xiaomi-token-plan-anthropic/mimo-v2.6-pro"],
    ["meta-anthropic/muse-spark-1.3", "meta-anthropic/muse-spark-1.2"],
    ["deepseek-anthropic/deepseek-v4-pro", "deepseek-anthropic/deepseek-flash"],
  ] as const) {
    test(`${key}: its own domain; the block goes back to the model itself and never to ${foreign}`, () => {
      const { registry, resolved, origin } = resolveKey(key);
      expect(resolved.descriptor?.reasoning?.continuation).toBe("opaque-provider-state");
      expect(resolved.continuationDomain).toBe(key);
      const renderer = createHistoryRenderer(registry);
      const own = renderer.render(turn(origin), new Map(), { family: "anthropic", continuationDomain: key, readableState: "none", providerId: resolved.providerId, modelKey: resolved.modelKey });
      expect(JSON.stringify(toWireMessages(own))).toContain('"signature":"sig-synthetic"');
      const other = resolveKey(foreign);
      const theirs = renderer.render(turn(origin), new Map(), { family: "anthropic", continuationDomain: other.resolved.continuationDomain!, readableState: "none", providerId: other.resolved.providerId, modelKey: other.resolved.modelKey });
      expect(JSON.stringify(toWireMessages(theirs))).not.toContain("sig-synthetic");
    });
  }

  test("MiniMax M2.x on the Messages API stays `none`: MiniMax lists only text and tool-call blocks as its input", () => {
    for (const key of ["minimax-anthropic/MiniMax-M2.7", "minimax-anthropic/MiniMax-M2.5", "minimax-anthropic/MiniMax-M2"]) expect([key, row(key).reasoning!.continuation]).toEqual([key, "none"]);
  });
});

describe("Vertex Gemini keeps its thought signatures, inside its own domain", () => {
  test("every Vertex Gemini reasoning row is opaque state on its own key; never shared with the Gemini API row of the same model", () => {
    const rows = catalog.models.filter((m) => m.providerId === "vertex" && m.upstreamId.startsWith("gemini-") && m.reasoning?.supported.value === true);
    expect(rows.length).toBeGreaterThanOrEqual(13);
    for (const m of rows) {
      expect([m.key, m.reasoning!.continuation, m.reasoning!.continuationDomain?.value]).toEqual([m.key, "opaque-provider-state", [m.key]]);
    }
    const registry = shippedRegistry();
    const vertex = registry.resolve({ model: "gemini-4-argon", provider: { providerId: "vertex" } });
    const google = registry.resolve({ model: "gemini-4-argon", provider: { providerId: "google" } });
    if (!("adapter" in vertex) || !("adapter" in google)) throw new Error("resolution failed");
    expect(vertex.continuationDomain).toBe("vertex/gemini-4-argon");
    expect(vertex.continuationDomain).not.toBe(google.continuationDomain);
  });
});

describe("Gemini through OpenRouter: encrypted blobs stay whole, unsigned thought text stays home", () => {
  // Shaped from OpenRouter's documented reasoning_details types and the format `google-gemini-v1`
  // (https://openrouter.ai/docs/use-cases/reasoning-tokens): Gemini streams its readable thought text
  // with no `signature`, then one `reasoning.encrypted` blob per signed step -- here two parallel calls,
  // both blobs at index 0. 0.0.61 joined the two blobs' `data` into one and sent the unsigned text back;
  // the second request of every tool loop was refused.
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ id: "gen-1", object: "chat.completion.chunk", created: 1, model: "google/gemini-4-argon", choices: [{ index: 0, delta, finish_reason: finish }] });
  const text = { type: "reasoning.text", text: "Two cities, two lookups.", format: "google-gemini-v1", index: 0 };
  const blobA = { type: "reasoning.encrypted", data: "c2lnLXBhcmlz", id: "tool_paris", format: "google-gemini-v1", index: 0 };
  const blobB = { type: "reasoning.encrypted", data: "c2lnLWxvbmRvbg==", id: "tool_london", format: "google-gemini-v1", index: 0 };
  const turns = {
    turn1: [
      chunk({ role: "assistant", content: "", reasoning: "Two cities, ", reasoning_details: [{ ...text, text: "Two cities, " }] }),
      chunk({ reasoning: "two lookups.", reasoning_details: [{ ...text, text: "two lookups." }] }),
      chunk({ reasoning_details: [blobA], tool_calls: [{ index: 0, id: "tool_paris", type: "function", function: { name: "get_current_temperature", arguments: '{"location":"Paris"}' } }] }),
      chunk({ reasoning_details: [blobB], tool_calls: [{ index: 1, id: "tool_london", type: "function", function: { name: "get_current_temperature", arguments: '{"location":"London"}' } }] }),
      chunk({}, "tool_calls"),
    ],
    turn2: [chunk({ role: "assistant", content: "Paris 18, London 14." }), chunk({}, "stop")],
  };

  test("turn 2 carries both blobs exactly as streamed, in order, and none of the unsigned text", async () => {
    const { bodies } = await toolLoop("openrouter", "google/gemini-4-argon", turns, [
      { id: "tool_paris", content: "18" },
      { id: "tool_london", content: "14" },
    ]);
    const assistant = (bodies[1]!["messages"] as Array<Record<string, unknown>>).find((m) => m["role"] === "assistant")!;
    expect(assistant["reasoning_details"]).toEqual([blobA, blobB]);
  });

  test("the replay filter: unsigned Claude or Gemini text is dropped; signed text, other formats, unlabelled text and every non-text entry go back verbatim", () => {
    const kept = [
      { type: "reasoning.text", text: "signed", format: "anthropic-claude-v1", signature: "sig" },
      { type: "reasoning.text", text: "kimi", format: "unknown" },
      { type: "reasoning.text", text: "no format" },
      { type: "reasoning.summary", summary: "s", format: "google-gemini-v1" },
      blobA,
    ];
    const dropped = [
      { type: "reasoning.text", text: "unsigned", format: "anthropic-claude-v1" },
      { type: "reasoning.text", text: "gemini", format: "google-gemini-v1" },
    ];
    expect(replayableReasoningDetails([dropped[0], ...kept, dropped[1]])).toEqual(kept);
  });
});
