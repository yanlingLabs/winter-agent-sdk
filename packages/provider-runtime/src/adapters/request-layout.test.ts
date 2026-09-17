// 0.0.16 request layout (Lane C): "text after the tool results in one user turn", per adapter family.
//
// The engine (runtime `context/request-layout.ts`) merges a persisted attachment -- or, later, a
// queued notification -- onto the tool message it follows, exactly as claude 0.3.250 merges its
// attachment messages onto the preceding user message. Every family must carry that trailing text:
//
//   Anthropic Messages  natively -- the text blocks follow the `tool_result` blocks in the SAME user turn.
//   OpenAI Chat         a FOLLOW-ON `user` message after the `tool` replies (it used to be dropped).
//   OpenAI Responses    a FOLLOW-ON `user` message item after the `function_call_output` items.
//   Google              `text` parts after the `functionResponse` parts in the SAME `user` content --
//                       this endpoint rejects two consecutive same-role contents, so a separate user
//                       content is not an option here (disclosed, the brief's "follow-on message"
//                       wording is applied where the dialect allows it).
//   Bedrock Converse    `text` blocks after the `toolResult` blocks in the SAME user message.
import { describe, expect, test } from "bun:test";
import type { ProviderMessageLike } from "../types.ts";
import { toWireMessages } from "./anthropic/index.ts";
import { toWireSystemBlocks, withMessageCacheMarker } from "./anthropic/messages.ts";
import { mapChatMessages } from "./openai/chat-completions.ts";
import { mapResponsesInput } from "./openai/responses.ts";
import { toContents } from "./google/generate-content.ts";
import { toBedrockMessages } from "./bedrock/converse.ts";

const REMINDER = "<system-reminder>\nThe date has changed.\n</system-reminder>";

/** assistant tool call -> a tool message carrying the result AND a trailing text block. */
const HISTORY: ProviderMessageLike[] = [
  { role: "user", content: "go" },
  { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Read", input: { path: "a" } }] },
  { role: "tool", content: [{ type: "tool_result", tool_use_id: "c1", content: "out" }, { type: "text", text: REMINDER }] },
];

describe("text after tool results in one user turn", () => {
  test("Anthropic: the text rides in the SAME user turn, after the tool_result", () => {
    const wire = toWireMessages(HISTORY);
    expect(wire.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(wire[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "c1", content: "out" },
      { type: "text", text: REMINDER },
    ]);
  });

  test("Anthropic: a separate meta user message after the tool message merges into the same turn", () => {
    const wire = toWireMessages([
      ...HISTORY.slice(0, 2),
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "c1", content: "out" }] },
      { role: "user", content: REMINDER, meta: { attachment: { type: "date_change", newDate: "2026-09-18" } } },
    ]);
    expect(wire).toHaveLength(3);
    expect(wire[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "c1", content: "out" },
      { type: "text", text: REMINDER },
    ]);
  });

  test("OpenAI Chat: a follow-on user message AFTER the tool reply (never dropped, never between call and reply)", () => {
    const out = mapChatMessages(HISTORY, false) as Array<Record<string, unknown>>;
    expect(out.map((m) => m["role"])).toEqual(["user", "assistant", "tool", "user"]);
    expect(out[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "out" });
    expect(out[3]).toEqual({ role: "user", content: REMINDER });
  });

  test("OpenAI Chat: several results keep their order and the text follows all of them", () => {
    const out = mapChatMessages(
      [
        { role: "assistant", content: [{ type: "tool_use", id: "a", name: "Read", input: {} }, { type: "tool_use", id: "b", name: "Read", input: {} }] },
        { role: "tool", content: [{ type: "tool_result", tool_use_id: "a", content: "1" }, { type: "tool_result", tool_use_id: "b", content: "2" }, { type: "text", text: "x" }, { type: "text", text: "y" }] },
      ],
      false,
    ) as Array<Record<string, unknown>>;
    expect(out.map((m) => m["role"])).toEqual(["assistant", "tool", "tool", "user"]);
    expect(out[3]).toEqual({ role: "user", content: "x\ny" });
  });

  test("OpenAI Responses: a follow-on user message item after the function_call_output", () => {
    const out = mapResponsesInput(HISTORY) as Array<Record<string, unknown>>;
    expect(out.map((i) => (i["type"] === "message" ? `message:${String(i["role"])}` : String(i["type"])))).toEqual(["message:user", "function_call", "function_call_output", "message:user"]);
    expect(out[2]).toEqual({ type: "function_call_output", call_id: "c1", output: "out" });
    expect(out[3]).toEqual({ type: "message", role: "user", content: [{ type: "input_text", text: REMINDER }] });
  });

  test("Google: text parts after the functionResponse parts in the same user content", () => {
    const { contents } = toContents(HISTORY);
    const roles = (contents as Array<{ role: string }>).map((c) => c.role);
    expect(roles).toEqual(["user", "model", "user"]);
    const parts = (contents as Array<{ parts: Array<Record<string, unknown>> }>)[2]!.parts;
    expect(Object.keys(parts[0]!)).toEqual(["functionResponse"]);
    expect(parts[1]).toEqual({ text: REMINDER });
    expect(parts).toHaveLength(2);
  });

  test("Bedrock Converse: text blocks after the toolResult in the same user message", () => {
    const out = toBedrockMessages(HISTORY);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const content = out[2]!.content as Array<Record<string, unknown>>;
    expect(Object.keys(content[0]!)).toEqual(["toolResult"]);
    expect(content[1]).toEqual({ text: REMINDER });
  });
});

describe("Anthropic prompt-cache markers (claude's placement)", () => {
  test("system blocks: every non-null scope is marked ephemeral, null is not, empty blocks are dropped", () => {
    expect(
      toWireSystemBlocks([
        { text: "billing", cacheScope: null },
        { text: "static", cacheScope: "global" },
        { text: "", cacheScope: "org" },
        { text: "dynamic\n\ngitStatus: x", cacheScope: "org" },
      ]),
    ).toEqual([
      { type: "text", text: "billing" },
      { type: "text", text: "static", cache_control: { type: "ephemeral" } },
      { type: "text", text: "dynamic\n\ngitStatus: x", cache_control: { type: "ephemeral" } },
    ]);
  });

  test("messages: only the LAST block of the LAST message is marked, and the input is not mutated", () => {
    const wire = toWireMessages(HISTORY);
    const marked = withMessageCacheMarker(wire);
    expect(marked[2]!.content[1]).toEqual({ type: "text", text: REMINDER, cache_control: { type: "ephemeral" } });
    expect(marked[2]!.content[0]).toEqual({ type: "tool_result", tool_use_id: "c1", content: "out" });
    expect(JSON.stringify(marked.slice(0, 2))).not.toContain("cache_control");
    expect(JSON.stringify(wire)).not.toContain("cache_control");
  });
});
