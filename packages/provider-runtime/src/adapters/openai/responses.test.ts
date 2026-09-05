// The Responses request/stream mapping, as pure functions.
//
// The live half — "and this is what the fake actually received" — is in the conformance package.
// What these fixtures pin is the SHAPE, including the two shapes that were live-verified findings
// rather than choices: structured content items (the flat-string form was a 400) and the completed
// reasoning item taken from the DONE side of the stream.

import { describe, expect, test } from "bun:test";
import { ResponsesStreamMapper, buildResponsesBody, mapResponsesInput, mapResponsesTools } from "./responses.ts";
import { resolveReasoning } from "./shared.ts";
import { descriptor } from "./testing.ts";
import type { ProviderEvent, ProviderMessageLike, TurnRequest } from "../../types.ts";

function req(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return { model: "o4-mini", messages: [], ...overrides };
}

function drive(mapper: ResponsesStreamMapper, payloads: Array<Record<string, unknown>>): ProviderEvent[] {
  const out: ProviderEvent[] = [];
  for (const payload of payloads) out.push(...mapper.map(JSON.stringify(payload)));
  return out;
}

describe("mapResponsesInput", () => {
  test("messages become STRUCTURED content items — assistant `output_text`, everything else `input_text`", () => {
    // Live finding, not a style choice: `{ role, content: "string" }` was rejected with a 400.
    expect(
      mapResponsesInput([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ]),
    ).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
    ]);
  });

  test("a tool_use block becomes a `function_call`, and the assistant's own text keeps its position AHEAD of it", () => {
    expect(
      mapResponsesInput([
        {
          role: "assistant",
          content: [
            { type: "text", text: "reading it" },
            { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "/tmp/x" } },
          ],
        },
      ]),
    ).toEqual([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "reading it" }] },
      { type: "function_call", call_id: "call_1", name: "Read", arguments: '{"file_path":"/tmp/x"}' },
    ]);
  });

  test("a tool result becomes a `function_call_output` keyed on the ORIGINAL call id", () => {
    expect(mapResponsesInput([{ role: "tool", content: [{ type: "tool_result", tool_use_id: "call_1", content: "file contents" }] }])).toEqual([
      { type: "function_call_output", call_id: "call_1", output: "file contents" },
    ]);
  });

  test("an image block rides `input_image` with a PLAIN data-URL string, not the chat-completions object form", () => {
    expect(mapResponsesInput([{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }] }])).toEqual([
      { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,QUJD" }] },
    ]);
  });

  test("NATIVE STATE leads its own message, verbatim and in order (§5.3's replay rule)", () => {
    const messages: ProviderMessageLike[] = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "T", input: {} }],
        nativeState: { family: "openai", continuationDomain: "openai/o4-mini", items: [{ type: "reasoning", encrypted_content: "OPAQUE-A" }, { type: "reasoning", encrypted_content: "OPAQUE-B" }] },
      },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }] },
    ];
    expect(mapResponsesInput(messages)).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "q" }] },
      { type: "reasoning", encrypted_content: "OPAQUE-A" },
      { type: "reasoning", encrypted_content: "OPAQUE-B" },
      { type: "function_call", call_id: "call_1", name: "T", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ]);
  });

  test("Anthropic-family blocks have no Responses representation and are NOT dressed up as one", () => {
    // R6-8: a thinking block carries a signature only Anthropic can validate. Inventing an
    // equivalent here would be the impersonation the ruling exists to forbid.
    expect(
      mapResponsesInput([
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "secret chain", signature: "sig" },
            { type: "redacted_thinking", data: "REDACTED-OPAQUE" },
            { type: "text", text: "answer" },
          ],
        },
      ]),
    ).toEqual([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }]);
  });
});

describe("buildResponsesBody", () => {
  test("the five live-verified required fields are always present", () => {
    const body = buildResponsesBody(req(), resolveReasoning(req(), descriptor()), descriptor());
    expect(body.tools).toEqual([]);
    expect(body.tool_choice).toBe("auto");
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.store).toBe(false);
    expect(body.include).toEqual([]);
    expect(body.stream).toBe(true);
  });

  test("`instructions` is sent only for a non-empty system prompt — no invented default", () => {
    expect(buildResponsesBody(req(), resolveReasoning(req(), descriptor()), descriptor())).not.toHaveProperty("instructions");
    const withSystem = req({ system: "be brief" });
    expect(buildResponsesBody(withSystem, resolveReasoning(withSystem, descriptor()), descriptor()).instructions).toBe("be brief");
  });

  test("`include` asks for encrypted continuation exactly when reasoning is configured", () => {
    const withEffort = req({ effort: "high" });
    const body = buildResponsesBody(withEffort, resolveReasoning(withEffort, descriptor()), descriptor());
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  test("a requested summary rides `reasoning.summary` only when the descriptor names the value", () => {
    const asked = req({ effort: "high", requestSummary: true });
    const model = descriptor({ summaryValues: ["detailed"] });
    expect(buildResponsesBody(asked, resolveReasoning(asked, model), model).reasoning).toEqual({ effort: "high", summary: "detailed" });
  });

  test("tool_choice's three arms map to the wire's three spellings", () => {
    const model = descriptor();
    const arms: Array<[TurnRequest["toolChoice"], unknown]> = [
      [{ type: "auto" }, "auto"],
      [{ type: "any" }, "required"],
      [{ type: "tool", name: "Read" }, { type: "function", name: "Read" }],
    ];
    for (const [choice, expected] of arms) {
      const r = req({ toolChoice: choice });
      expect(buildResponsesBody(r, resolveReasoning(r, model), model).tool_choice).toEqual(expected);
    }
  });

  test("`parallel_tool_calls` follows the descriptor's evidence when it has any", () => {
    const model = descriptor({ parallelTools: false });
    expect(buildResponsesBody(req(), resolveReasoning(req(), model), model).parallel_tool_calls).toBe(false);
  });

  test("tools carry their schema verbatim under `parameters`", () => {
    expect(mapResponsesTools([{ name: "Read", description: "reads", inputSchema: { type: "object", properties: { p: { type: "string" } } } }])).toEqual([
      { type: "function", name: "Read", description: "reads", parameters: { type: "object", properties: { p: { type: "string" } } }, strict: false },
    ]);
  });
});

describe("ResponsesStreamMapper", () => {
  test("text and summary deltas separate: one is content, the other is FOREIGN reasoning", () => {
    const events = drive(new ResponsesStreamMapper(), [
      { type: "response.created", response: { id: "resp_1", model: "o4-mini" } },
      { type: "response.reasoning_summary_text.delta", delta: "weighing options" },
      { type: "response.output_text.delta", delta: "the answer" },
      { type: "response.completed", response: { usage: { input_tokens: 7, output_tokens: 3 } } },
    ]);
    expect(events).toEqual([
      { type: "message_start", id: "resp_1", model: "o4-mini" },
      { type: "thinking_summary_delta", text: "weighing options" },
      { type: "text_delta", text: "the answer" },
      { type: "usage", inputTokens: 7, outputTokens: 3 },
      { type: "done", stopReason: "end_turn" },
    ]);
  });

  test("continuation state comes from the DONE item only — the `added` copy is never used", () => {
    // The brief's hard rule, and the fixture is written so a regression is unmistakable: the two
    // copies carry DIFFERENT payloads, so taking the wrong one changes the assertion's value.
    const events = drive(new ResponsesStreamMapper(), [
      { type: "response.output_item.added", output_index: 0, item: { id: "rs_0", type: "reasoning", encrypted_content: "PARTIAL-A" } },
      { type: "response.output_item.done", output_index: 1, item: { id: "rs_1", type: "reasoning", encrypted_content: "COMPLETE-B", status: "completed" } },
      { type: "response.output_item.done", output_index: 0, item: { id: "rs_0", type: "reasoning", encrypted_content: "COMPLETE-A", status: "completed" } },
      { type: "response.completed", response: {} },
    ]);
    const state = events.find((e) => e.type === "native_state");
    // In OUTPUT order, not arrival order — §5.3 replays them in the order the response produced them.
    expect(state).toEqual({ type: "native_state", items: [{ type: "reasoning", encrypted_content: "COMPLETE-A" }, { type: "reasoning", encrypted_content: "COMPLETE-B" }] });
    // `id` and `status` are stripped: both are response-only fields a `store: false` replay clears.
    expect(JSON.stringify(state)).not.toContain("rs_0");
    expect(JSON.stringify(state)).not.toContain("PARTIAL");
  });

  test("a reasoning item with no encrypted content is not captured — replaying it would restore nothing", () => {
    const events = drive(new ResponsesStreamMapper(), [
      { type: "response.output_item.done", output_index: 0, item: { id: "rs_0", type: "reasoning", summary: [{ type: "summary_text", text: "s" }], encrypted_content: "" } },
      { type: "response.completed", response: {} },
    ]);
    expect(events.some((e) => e.type === "native_state")).toBe(false);
  });

  test("streamed tool arguments are forwarded as deltas, and the final item does NOT re-send them", () => {
    const events = drive(new ResponsesStreamMapper(), [
      { type: "response.output_item.added", output_index: 0, item: { id: "fc_0", type: "function_call", call_id: "call_1", name: "Read", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_0", delta: '{"file' },
      { type: "response.function_call_arguments.delta", item_id: "fc_0", delta: '_path":"/tmp/x"}' },
      { type: "response.output_item.done", output_index: 0, item: { id: "fc_0", type: "function_call", call_id: "call_1", name: "Read", arguments: '{"file_path":"/tmp/x"}' } },
      { type: "response.completed", response: {} },
    ]);
    expect(events).toEqual([
      { type: "tool_call_start", id: "call_1", name: "Read" },
      { type: "tool_call_delta", id: "call_1", argumentsJsonDelta: '{"file' },
      { type: "tool_call_delta", id: "call_1", argumentsJsonDelta: '_path":"/tmp/x"}' },
      { type: "tool_call_end", id: "call_1" },
      { type: "done", stopReason: "tool_use" },
    ]);
  });

  test("a backend that sends NO argument deltas still produces the whole argument string once", () => {
    // The codex backend's own behaviour, which the port relied on exclusively.
    const events = drive(new ResponsesStreamMapper(), [
      { type: "response.output_item.added", output_index: 0, item: { id: "fc_0", type: "function_call", call_id: "call_1", name: "Read" } },
      { type: "response.output_item.done", output_index: 0, item: { id: "fc_0", type: "function_call", call_id: "call_1", name: "Read", arguments: '{"a":1}' } },
      { type: "response.completed", response: {} },
    ]);
    expect(events.filter((e) => e.type === "tool_call_delta")).toEqual([{ type: "tool_call_delta", id: "call_1", argumentsJsonDelta: '{"a":1}' }]);
  });

  test("`max_output_tokens` incompleteness becomes stopReason `max_tokens`, and a refusal becomes `refusal`", () => {
    const truncated = drive(new ResponsesStreamMapper(), [{ type: "response.completed", response: { incomplete_details: { reason: "max_output_tokens" } } }]);
    expect(truncated.at(-1)).toEqual({ type: "done", stopReason: "max_tokens" });
    const refused = drive(new ResponsesStreamMapper(), [{ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] } }]);
    expect(refused.at(-1)).toEqual({ type: "done", stopReason: "refusal" });
  });

  test("an unrepresentable CALL is an error, never a skipped item (WS-13 §9)", () => {
    for (const itemType of ["computer_call", "mcp_call", "custom_tool_call", "local_shell_call"]) {
      const events = drive(new ResponsesStreamMapper(), [{ type: "response.output_item.done", output_index: 0, item: { id: "x", type: itemType } }]);
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("error");
      expect(events[0]!.type === "error" ? events[0]!.error.code : "").toBe("capability");
    }
  });

  test("a stream that ends before `response.completed` is a typed, NON-retryable failure", () => {
    // Bytes flowed, so R6-6 forbids replaying it; reporting the partial turn as complete would hand
    // a caller half an answer as if it were whole.
    const mapper = new ResponsesStreamMapper();
    drive(mapper, [{ type: "response.output_text.delta", delta: "half" }]);
    const tail = mapper.finish();
    expect(tail).toHaveLength(1);
    expect(tail[0]!.type === "error" ? tail[0]!.error : undefined).toMatchObject({ code: "network", retryable: false });
  });

  test("`[DONE]` and junk frames are tolerated rather than fatal", () => {
    const mapper = new ResponsesStreamMapper();
    expect(mapper.map("[DONE]")).toEqual([]);
    expect(mapper.map("{not json")).toEqual([]);
    expect(mapper.map(JSON.stringify({ type: "response.something.new", data: 1 }))).toEqual([]);
  });

  test("cached input tokens are carried through when the provider reports them", () => {
    const events = drive(new ResponsesStreamMapper(), [{ type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 80 } } } }]);
    expect(events[0]).toEqual({ type: "usage", inputTokens: 100, outputTokens: 5, cacheReadTokens: 80 });
  });
});
