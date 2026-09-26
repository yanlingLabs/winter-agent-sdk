// WS-23 (reasoning-state): the Responses-side sidecar defects from the audit (inv-sidecar.md):
//   (a) a turn's reasoning items keep their place AMONG its messages and calls, and replay interleaved;
//   (b) a refused replay ("could not decrypt / verify the encrypted content") is retried ONCE without the
//       replayed reasoning -- see the loopback half in runtime's `responses-reasoning-state.e2e.test.ts`;
//   (d) summary parts are joined with a blank line;
// plus the OpenAI-family context-overflow classification the fit check's reactive half relies on.
import { describe, expect, test } from "bun:test";
import { ResponsesStreamMapper, RESPONSES_LAYOUT_ITEM_TYPE, mapResponsesInput } from "./responses.ts";
import { httpErrorFrom, isEncryptedContentRejection } from "./shared.ts";
import { normalizeHttpError } from "../../errors.ts";
import type { ProviderEvent, ProviderMessageLike } from "../../types.ts";

function drive(payloads: Array<Record<string, unknown>>): ProviderEvent[] {
  const mapper = new ResponsesStreamMapper();
  return payloads.flatMap((payload) => mapper.map(JSON.stringify(payload)));
}

const reasoningDone = (index: number, enc: string) => ({ type: "response.output_item.done", output_index: index, item: { id: `rs_${index}`, type: "reasoning", summary: [], encrypted_content: enc, status: "completed" } });
const messageDone = (index: number, text: string) => ({ type: "response.output_item.done", output_index: index, item: { id: `msg_${index}`, type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
const callDone = (index: number, callId: string) => ({ type: "response.output_item.done", output_index: index, item: { id: `fc_${index}`, type: "function_call", call_id: callId, name: "Read", arguments: "{}" } });
const completed = { type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } };

describe("(a) the output layout", () => {
  test("interleaved output records where each reasoning item sat; the replay puts it back there", () => {
    const events = drive([reasoningDone(0, "E0"), messageDone(1, "hi"), reasoningDone(2, "E2"), callDone(3, "call_1"), completed]);
    const native = events.find((e) => e.type === "native_state") as Extract<ProviderEvent, { type: "native_state" }>;
    expect(native.items).toEqual([
      { type: "reasoning", summary: [], encrypted_content: "E0" },
      { type: "reasoning", summary: [], encrypted_content: "E2" },
      { type: RESPONSES_LAYOUT_ITEM_TYPE, order: [{ r: 0 }, { m: true }, { r: 1 }, { c: "call_1" }] },
    ]);
    const turn: ProviderMessageLike = {
      role: "assistant",
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", id: "call_1", name: "Read", input: {} },
      ],
      nativeState: { family: "openai", continuationDomain: "xai/grok-4.20-multi-agent-0309", items: native.items },
    };
    expect(mapResponsesInput([turn])).toEqual([
      { type: "reasoning", summary: [], encrypted_content: "E0" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
      { type: "reasoning", summary: [], encrypted_content: "E2" },
      { type: "function_call", call_id: "call_1", name: "Read", arguments: "{}" },
    ]);
  });

  test("reasoning already first: NO layout item, so the native state and its replay are byte-identical to before", () => {
    const events = drive([reasoningDone(0, "E0"), reasoningDone(1, "E1"), callDone(2, "call_1"), completed]);
    const native = events.find((e) => e.type === "native_state") as Extract<ProviderEvent, { type: "native_state" }>;
    expect(native.items).toEqual([
      { type: "reasoning", summary: [], encrypted_content: "E0" },
      { type: "reasoning", summary: [], encrypted_content: "E1" },
    ]);
  });

  test("the layout item itself never reaches the wire, and a turn stored without one replays reasoning-first as before", () => {
    const layout = { type: RESPONSES_LAYOUT_ITEM_TYPE, order: [{ m: true }, { r: 0 }] };
    const withLayout = mapResponsesInput([{ role: "assistant", content: "hi", nativeState: { family: "openai", continuationDomain: "d", items: [{ type: "reasoning", encrypted_content: "E" }, layout] } }]);
    expect(JSON.stringify(withLayout)).not.toContain("winter.");
    expect(withLayout).toEqual([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
      { type: "reasoning", encrypted_content: "E" },
    ]);
    const old = mapResponsesInput([{ role: "assistant", content: "hi", nativeState: { family: "openai", continuationDomain: "d", items: [{ type: "reasoning", encrypted_content: "E" }] } }]);
    expect(old).toEqual([
      { type: "reasoning", encrypted_content: "E" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
    ]);
  });
});

describe("(d) summary parts", () => {
  test("two parts are joined with a blank line; deltas within one part are not", () => {
    const events = drive([
      { type: "response.reasoning_summary_text.delta", item_id: "rs_0", output_index: 0, summary_index: 0, delta: "First part, " },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_0", output_index: 0, summary_index: 0, delta: "continued." },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_0", output_index: 0, summary_index: 1, delta: "Second part." },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_2", output_index: 2, summary_index: 0, delta: "Next item." },
    ]);
    const text = events.flatMap((e) => (e.type === "thinking_summary_delta" ? [e.text] : [])).join("");
    expect(text).toBe("First part, continued.\n\nSecond part.\n\nNext item.");
  });
});

describe("(b) the encrypted-content refusal is recognised off the full body", () => {
  test.each([
    ["xAI", '{"code":"Client specified an invalid argument","error":"Could not decrypt the provided encrypted_content"}'],
    ["OpenAI", '{"error":{"message":"The encrypted content for item rs_68a could not be verified.","type":"invalid_request_error","param":null,"code":null}}'],
  ])("%s", async (_vendor, body) => {
    expect(isEncryptedContentRejection(await httpErrorFrom(new Response(body, { status: 400 })))).toBe(true);
  });

  test("any other 400 is not one", async () => {
    expect(isEncryptedContentRejection(await httpErrorFrom(new Response('{"error":{"message":"Invalid value: \'tool_search\'"}}', { status: 400 })))).toBe(false);
  });
});

describe("OpenAI-family context overflow is classified (WS-23 decision 5)", () => {
  test.each([
    ["OpenAI Responses", '{"error":{"message":"Your input exceeds the context window of this model. Please adjust your input and try again.","type":"invalid_request_error","param":"input","code":"context_length_exceeded"}}'],
    ["OpenAI Chat Completions", '{"error":{"message":"This model\'s maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.","type":"invalid_request_error","param":"messages","code":"context_length_exceeded"}}'],
    ["xAI", '{"code":"Client specified an invalid argument","error":"This model\'s maximum prompt length is 131072 but the request contains 150000 tokens."}'],
  ])("%s", async (_vendor, body) => {
    const normalized = normalizeHttpError(400, new Headers(), body);
    expect(normalized.contextOverflow).toBe(true);
    expect(normalized.code).toBe("bad_request");
    // And it survives into the thrown error the fold converts.
    expect((await httpErrorFrom(new Response(body, { status: 400 }))).contextOverflow).toBe(true);
  });

  test("an unrelated 400 is not an overflow", () => {
    expect(normalizeHttpError(400, new Headers(), '{"error":{"message":"bad tool","code":"invalid_value"}}').contextOverflow).toBeUndefined();
  });
});
