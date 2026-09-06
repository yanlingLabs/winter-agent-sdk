// The Google serializer's merge and ordering edges, as a pure function.
//
// WHY THIS FILE EXISTS (Lane B re-review r4): `bun test packages/provider-runtime/src/adapters/google`
// matched ZERO files. `toContents` was pinned only through the conformance corpus, where every
// assertion goes through a fake and a stream — so an edge the corpus does not phrase had nowhere to
// be stated, and the two edges below are exactly the kind a corpus case will not think to ask about.
// The Anthropic family has had `messages.test.ts` for the same reason since its own round 1.
//
// The corpus fixtures are NOT replaced by these: a pure mapping test cannot prove what the endpoint
// accepts, which is the corpus's job (and, since this wave, the Vertex fake's too). These pin the
// decisions the mapper's own header explains, so a refactor that loses one fails here rather than in
// a 400 nobody reproduces.

import { describe, expect, test } from "bun:test";
import { toContents } from "./generate-content.ts";
import type { ProviderMessageLike } from "../../types.ts";

const user = (content: ProviderMessageLike["content"]): ProviderMessageLike => ({ role: "user", content });

describe("toContents: adjacent same-role messages MERGE, and an empty one never splits them", () => {
  test("two consecutive tool messages become ONE `user` entry, in order", () => {
    // Consecutive same-role entries are a shape the endpoint rejects, and a two-tool-loop history is
    // the ordinary way to produce them.
    const { contents } = toContents([
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Read", input: {} }, { type: "tool_use", id: "c2", name: "Write", input: {} }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "c1", content: "one" }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "c2", content: "two" }] },
    ]);
    expect(contents.map((c) => c.role)).toEqual(["model", "user"]);
    expect(contents[1]!.parts).toEqual([
      { functionResponse: { name: "Read", response: { output: "one" } } },
      { functionResponse: { name: "Write", response: { output: "two" } } },
    ]);
  });

  test("a message rendering to ZERO parts leaves the chain untouched, so its neighbours still merge", () => {
    // The bug the mapper's header records: creating the entry up front left an EMPTY entry between
    // two same-role neighbours and broke their adjacency, and the trailing non-empty filter could
    // not save it because by then the split had already happened. Three shapes render to nothing —
    // an empty string, an empty block list, and a message carrying only ANOTHER dialect's thinking.
    for (const empty of [
      { role: "assistant", content: "" },
      { role: "assistant", content: [] },
      { role: "assistant", content: [{ type: "thinking", thinking: "another dialect's chain", signature: "sig" }] },
    ] satisfies ProviderMessageLike[]) {
      const { contents } = toContents([user("a"), empty, user("b")]);
      expect([empty.content, contents.map((c) => c.role)]).toEqual([empty.content, ["user"]]);
      expect(contents[0]!.parts).toEqual([{ text: "a" }, { text: "b" }]);
    }
  });

  test("foreign reasoning is dropped as a COUNT, never as content", () => {
    const { contents, droppedForeignReasoning } = toContents([
      { role: "assistant", content: [{ type: "text", text: "kept" }, { type: "thinking", thinking: "SECRET-CHAIN", signature: "sig" }, { type: "redacted_thinking", data: "REDACTED" }] },
    ]);
    expect(droppedForeignReasoning).toBe(2);
    expect(JSON.stringify(contents)).not.toContain("SECRET-CHAIN");
    expect(contents[0]!.parts).toEqual([{ text: "kept" }]);
  });
});

describe("toContents: ordering within an assembled entry", () => {
  test("functionResponses lead, decorations follow them, ordinary content comes last — ACROSS a merge", () => {
    // The dialect wants the responses first; a decoration rendered at index 0 was wire-invalid. The
    // rule is a property of the assembled ENTRY, not of a message, which is only visible when two
    // messages merge into one entry — the case the corpus reaches through a fake and this states.
    const { contents } = toContents([
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Read", input: {} }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "c1", content: "out" }], decoration: { text: "<note>carried</note>", door: "tag" } },
      { role: "user", content: "and now this" },
    ]);
    expect(contents[1]!.parts).toEqual([{ functionResponse: { name: "Read", response: { output: "out" } } }, { text: "<note>carried</note>" }, { text: "and now this" }]);
  });

  test("a decoration does not consume the text ordinal a `thoughtSignature` is keyed to", () => {
    // Signatures are re-attached to the model's own text part by ORDINAL. A decoration filed into
    // the text stream would shift it onto Winter's prose — mis-attaching a signature the provider
    // minted for something else.
    const { contents } = toContents([
      {
        role: "assistant",
        content: [{ type: "text", text: "the answer" }],
        decoration: { text: "<note>carried</note>", door: "tag" },
        nativeState: { family: "google", continuationDomain: "google/gemini-2.5-pro", items: [{ type: "winter.google_thought_signature", kind: "text", partIndex: 0, signature: "SIG-FOR-THE-ANSWER" }] },
      },
    ]);
    expect(contents[0]!.parts).toEqual([{ text: "<note>carried</note>" }, { text: "the answer", thoughtSignature: "SIG-FOR-THE-ANSWER" }]);
  });

  test("a tool_result resolves to the NEAREST PRECEDING call of that id, not the last one in the history", () => {
    // The incremental name map, stated. This family's `functionCall` carries no id, so Winter mints
    // one and a per-stream counter re-mints the same first id every turn: a flat pre-pass is
    // last-write-wins, and turn 1's response went out naming turn 2's tool. Wrong tool, silently, on
    // the ordinary multi-tool-loop shape.
    const { contents } = toContents([
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "Read", input: {} }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "call_1", content: "first" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "Write", input: {} }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "call_1", content: "second" }] },
    ]);
    expect(contents.map((c) => c.parts)).toEqual([
      [{ functionCall: { name: "Read", args: {} } }],
      [{ functionResponse: { name: "Read", response: { output: "first" } } }],
      [{ functionCall: { name: "Write", args: {} } }],
      [{ functionResponse: { name: "Write", response: { output: "second" } } }],
    ]);
  });

  test("a tool_result with no matching tool_use is REFUSED, never dropped", () => {
    // A silently missing tool response is indistinguishable to the model from a tool that was never
    // called (WS-13 §9).
    expect(() => toContents([{ role: "tool", content: [{ type: "tool_result", tool_use_id: "never-called", content: "out" }] }])).toThrow(/no matching tool_use/);
  });
});
