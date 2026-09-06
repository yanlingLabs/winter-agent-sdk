// The Chat Completions mapping, as pure functions. The live half is in the conformance package.

import { describe, expect, test } from "bun:test";
import { ChatStreamMapper, buildChatBody, mapChatMessages, mapChatTools } from "./chat-completions.ts";
import { resolveReasoning } from "./shared.ts";
import { descriptor } from "./testing.ts";
import type { ProviderEvent, ProviderMessageLike, TurnRequest } from "../../types.ts";

function req(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return { model: "deepseek-reasoner", messages: [], ...overrides };
}

function drive(mapper: ChatStreamMapper, chunks: Array<Record<string, unknown> | "[DONE]">): ProviderEvent[] {
  const out: ProviderEvent[] = [];
  for (const chunk of chunks) out.push(...mapper.map(chunk === "[DONE]" ? "[DONE]" : JSON.stringify(chunk)));
  return out;
}

const DEEPSEEK = descriptor({ key: "deepseek/deepseek-reasoner", efforts: ["low", "medium", "high"], readableState: "full-exposed", continuation: "plaintext" });

describe("mapChatMessages", () => {
  test("a text-only user message goes as a plain string — some local servers accept nothing else", () => {
    expect(mapChatMessages([{ role: "user", content: "hello" }], false)).toEqual([{ role: "user", content: "hello" }]);
  });

  test("an image rides the OBJECT form `{ image_url: { url } }` — the opposite of the Responses surface", () => {
    expect(
      mapChatMessages([{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } }] }], false),
    ).toEqual([{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } }] }]);
  });

  test("assistant tool calls ride `tool_calls`, and results come back on their own `tool` role", () => {
    expect(
      mapChatMessages(
        [
          { role: "assistant", content: [{ type: "text", text: "reading" }, { type: "tool_use", id: "call_1", name: "Read", input: { p: 1 } }] },
          { role: "tool", content: [{ type: "tool_result", tool_use_id: "call_1", content: "contents" }] },
        ],
        false,
      ),
    ).toEqual([
      { role: "assistant", content: "reading", tool_calls: [{ id: "call_1", type: "function", function: { name: "Read", arguments: '{"p":1}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "contents" },
    ]);
  });

  test("DEEPSEEK REPLAY: exposed reasoning returns on the assistant message (§6.3's 400-avoidance)", () => {
    const messages: ProviderMessageLike[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "T", input: {} }],
        nativeState: { family: "openai", continuationDomain: "deepseek/deepseek-reasoner", items: [{ type: "winter.exposed_reasoning", text: "step one, step two" }] },
      },
    ];
    const replayed = mapChatMessages(messages, true);
    expect(replayed[0]).toMatchObject({ reasoning_content: "step one, step two" });
    // And with replay OFF (a model whose descriptor does not record exposed reasoning) it is not
    // fabricated onto the wire.
    expect(mapChatMessages(messages, false)[0]).not.toHaveProperty("reasoning_content");
  });
});

describe("decorations (minor 11)", () => {
  test("a Winter annotation leads its message, on both doors and both roles", () => {
    for (const door of ["tag", "thinking-channel"] as const) {
      expect(mapChatMessages([{ role: "user", content: "the question", decoration: { text: "prior model summarised: X", door } }], false)).toEqual([
        { role: "user", content: "prior model summarised: X\nthe question" },
      ]);
    }
    expect(mapChatMessages([{ role: "assistant", content: "answer", decoration: { text: "note", door: "tag" } }], false)).toEqual([
      { role: "assistant", content: "note\nanswer" },
    ]);
  });

  test("a decoration on a TOOL message prefixes the result's content — adjacency is a wire invariant (round 3)", () => {
    // Rendering it as a leading `user` message (round 2's prescription) produces
    // assistant(tool_calls) -> user -> tool, which OpenAI and Azure both reject outright.
    expect(
      mapChatMessages(
        [
          { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "Read", input: {} }] },
          { role: "tool", content: [{ type: "tool_result", tool_use_id: "call_1", content: "the file body" }], decoration: { text: "note", door: "tag" } },
        ],
        false,
      ),
    ).toEqual([
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "Read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "note\nthe file body" },
    ]);
  });

  test("a USER message carrying only tool results takes the same prefix rule (round 3)", () => {
    // A host-supplied history can put results on a `user` message; this branch dropped the
    // decoration entirely, and could not lead them for the same adjacency reason.
    expect(
      mapChatMessages(
        [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "the file body" }], decoration: { text: "note", door: "tag" } }],
        false,
      ),
    ).toEqual([{ role: "tool", tool_call_id: "call_1", content: "note\nthe file body" }]);
  });

  test("an annotation on a message carrying an IMAGE rides as its own text part", () => {
    const out = mapChatMessages(
      [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }], decoration: { text: "note", door: "tag" } }],
      false,
    );
    expect(out[0]).toEqual({ role: "user", content: [{ type: "text", text: "note" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] });
  });
});

describe("buildChatBody", () => {
  test("`stream_options.include_usage` is always on — usage does not arrive at all without it", () => {
    const body = buildChatBody(req(), resolveReasoning(req(), DEEPSEEK), DEEPSEEK, true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.stream).toBe(true);
  });

  test("the system prompt leads the message list", () => {
    const r = req({ system: "be brief", messages: [{ role: "user", content: "hi" }] });
    expect(buildChatBody(r, resolveReasoning(r, DEEPSEEK), DEEPSEEK, true).messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });

  test("`tools` and `tool_choice` are OMITTED together when there are none — a bare `tool_choice` is a 400 on several servers", () => {
    const body = buildChatBody(req(), resolveReasoning(req(), DEEPSEEK), DEEPSEEK, true);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
  });

  test("effort rides the top-level `reasoning_effort`, not a nested object", () => {
    const r = req({ effort: "high" });
    expect(buildChatBody(r, resolveReasoning(r, DEEPSEEK), DEEPSEEK, true).reasoning_effort).toBe("high");
  });

  test("the output budget's FIELD NAME follows the descriptor's reasoning evidence", () => {
    // A recorded fact about the model rather than a guess about the endpoint: reasoning models
    // require `max_completion_tokens`, and many local servers accept only `max_tokens`.
    const reasoning = req({ maxOutputTokens: 500 });
    expect(buildChatBody(reasoning, resolveReasoning(reasoning, DEEPSEEK), DEEPSEEK, true)).toHaveProperty("max_completion_tokens", 500);
    const plain = descriptor({ key: "ollama-local/llama3.1:8b", noReasoning: true });
    expect(buildChatBody(reasoning, resolveReasoning(reasoning, plain), plain, false)).toHaveProperty("max_tokens", 500);
  });

  test("tools carry their schema under `function.parameters`", () => {
    expect(mapChatTools([{ name: "Read", description: "d", inputSchema: { type: "object" } }])).toEqual([{ type: "function", function: { name: "Read", description: "d", parameters: { type: "object" } } }]);
  });
});

describe("ChatStreamMapper", () => {
  test("content and exposed reasoning separate, and the reasoning is captured as replayable state", () => {
    const events = drive(new ChatStreamMapper(true), [
      { id: "chatcmpl-1", model: "deepseek-reasoner", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "thinking..." } }] },
      { choices: [{ index: 0, delta: { content: "answer" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 4, prompt_cache_hit_tokens: 8 } },
      "[DONE]",
    ]);
    expect(events).toEqual([
      { type: "message_start", id: "chatcmpl-1", model: "deepseek-reasoner" },
      { type: "thinking_exposed_delta", text: "thinking..." },
      { type: "text_delta", text: "answer" },
      { type: "usage", inputTokens: 11, outputTokens: 4, cacheReadTokens: 8 },
      { type: "native_state", items: [{ type: "winter.exposed_reasoning", text: "thinking..." }] },
      { type: "done", stopReason: "end_turn" },
    ]);
  });

  test("exposed reasoning is NOT captured as state for a model whose descriptor does not record it", () => {
    const events = drive(new ChatStreamMapper(false), [{ choices: [{ index: 0, delta: { reasoning_content: "hmm" }, finish_reason: "stop" }] }, "[DONE]"]);
    expect(events.some((e) => e.type === "native_state")).toBe(false);
    // It is still surfaced as exposed reasoning: what the model said is observable either way.
    expect(events.some((e) => e.type === "thinking_exposed_delta")).toBe(true);
  });

  test("tool arguments assemble BY INDEX — only the first fragment carries the id and name", () => {
    const events = drive(new ChatStreamMapper(false), [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "A", arguments: "" } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "B", arguments: "" } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"x' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '{"y":2}' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '":1}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      "[DONE]",
    ]);
    expect(events.filter((e) => e.type === "tool_call_start")).toEqual([
      { type: "tool_call_start", id: "call_a", name: "A" },
      { type: "tool_call_start", id: "call_b", name: "B" },
    ]);
    expect(events.filter((e) => e.type === "tool_call_delta")).toEqual([
      { type: "tool_call_delta", id: "call_a", argumentsJsonDelta: '{"x' },
      { type: "tool_call_delta", id: "call_b", argumentsJsonDelta: '{"y":2}' },
      { type: "tool_call_delta", id: "call_a", argumentsJsonDelta: '":1}' },
    ]);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "tool_use" });
  });

  test("a NEW call slot with no id or name is an error, never an invented call (WS-13 §9)", () => {
    const events = drive(new ChatStreamMapper(false), [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }] }]);
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    expect(events.find((e) => e.type === "error")?.type === "error" ? (events.find((e) => e.type === "error") as { error: { code: string } }).error.code : "").toBe("capability");
  });

  test("finish_reason maps the three interesting arms", () => {
    for (const [finish, expected] of [["length", "max_tokens"], ["content_filter", "refusal"], ["stop", "end_turn"]] as const) {
      const events = drive(new ChatStreamMapper(false), [{ choices: [{ index: 0, delta: {}, finish_reason: finish }] }, "[DONE]"]);
      expect(events.at(-1)).toEqual({ type: "done", stopReason: expected });
    }
  });

  test("a stream that ends after a finish_reason but WITHOUT `[DONE]` still completes", () => {
    // Many OpenAI-compatible servers never send the terminator; treating that as truncation would
    // break every one of them.
    const mapper = new ChatStreamMapper(false);
    drive(mapper, [{ choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }] }]);
    expect(mapper.finish()).toEqual([{ type: "done", stopReason: "end_turn" }]);
  });

  test("a stream that ends with NO finish_reason is a typed, non-retryable truncation", () => {
    const mapper = new ChatStreamMapper(false);
    drive(mapper, [{ choices: [{ index: 0, delta: { content: "half" } }] }]);
    expect(mapper.finish()[0]).toMatchObject({ type: "error", error: { code: "network", retryable: false } });
  });

  test("an error reported INSIDE a 200 stream keeps the provider's own code", () => {
    const events = drive(new ChatStreamMapper(false), [{ error: { message: "upstream is down", code: "provider_unavailable" } }]);
    expect(events[0]).toMatchObject({ type: "error", error: { code: "server", providerCode: "provider_unavailable" } });
  });

  test("OpenRouter's `reasoning` spelling is the same exposed channel", () => {
    const events = drive(new ChatStreamMapper(true), [{ choices: [{ index: 0, delta: { reasoning: "via openrouter" }, finish_reason: "stop" }] }, "[DONE]"]);
    expect(events.some((e) => e.type === "thinking_exposed_delta" && e.text === "via openrouter")).toBe(true);
  });
});

describe("Lane A r3 residuals: the two mappers answer the same input the same way", () => {
  test("a tool-role message with STRING content renders a USER message, not `[]`", () => {
    // It used to render NOTHING: `asBlocks("just text")` yields a text block, the tool branch emits
    // only `tool_result` blocks, and the message — decoration included — vanished. Responses turned
    // the identical input into a user message, so a host-supplied history lost content on one
    // surface and not the other, silently.
    expect(mapChatMessages([{ role: "tool", content: "just text", decoration: { text: "note", door: "tag" } }], false)).toEqual([{ role: "user", content: "note\njust text" }]);
    // Without a decoration, likewise: it cannot be a `tool` message here (no `tool_call_id` to give
    // it), so it becomes what the other surface already makes it.
    expect(mapChatMessages([{ role: "tool", content: "just text" }], false)).toEqual([{ role: "user", content: "just text" }]);
    // A tool message that DOES carry a result is untouched by this arm.
    expect(mapChatMessages([{ role: "tool", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] }], false)).toEqual([{ role: "tool", tool_call_id: "c1", content: "ok" }]);
  });
});
