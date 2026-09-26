// WS-23 (reasoning-state): the sidecar-carried Anthropic reasoning blocks -- separated off a turn's
// stream-order content, and spliced back byte-identically; inline blocks (a transcript written before
// the move) always win.
import { describe, expect, test } from "bun:test";
import type { ContentBlockLike, ProviderNativeState } from "../types.ts";
import { toWireMessages } from "../adapters/anthropic/messages.ts";
import {
  REASONING_BLOCK_ITEM_TYPE,
  contentWithReasoningBlocks,
  isReasoningBlockItem,
  reasoningBlockItems,
  reasoningBlocksVisibleText,
  separateReasoningBlocks,
  spliceReasoningBlocks,
} from "./reasoning-blocks.ts";

const T1: ContentBlockLike = { type: "thinking", thinking: "look first", signature: "sig-a" };
const T2: ContentBlockLike = { type: "thinking", thinking: "then act", signature: "" };
const R1: ContentBlockLike = { type: "redacted_thinking", data: "OPAQUE" };
const TEXT: ContentBlockLike = { type: "text", text: "Let me check." };
const CALL: ContentBlockLike = { type: "tool_use", id: "toolu_1", name: "Glob", input: { pattern: "*" } };

/** What the engine keeps in memory for a persisted entry (the resume collapse rule). */
const asRebuilt = (content: ContentBlockLike[]): string | ContentBlockLike[] => (content.length === 1 && content[0]!.type === "text" ? content[0]!.text : content);

function roundTrip(content: ContentBlockLike[]): ContentBlockLike[] {
  const { neutral, blocks } = separateReasoningBlocks(content);
  const state: ProviderNativeState = { family: "anthropic", continuationDomain: "anthropic/claude-opus-5-5", items: reasoningBlockItems(blocks) };
  return contentWithReasoningBlocks({ content: asRebuilt(neutral), nativeState: state }) as ContentBlockLike[];
}

describe("separate + splice round-trips every stream-order shape (WS-23 reasoning-state)", () => {
  test.each([
    ["interleaved [thinking, text, thinking, tool_use]", [T1, TEXT, T2, CALL]],
    ["redacted first, then an empty-signature block, then text", [R1, T2, TEXT]],
    ["thinking then a lone text block (collapsed to a string in memory)", [T1, TEXT]],
    ["thinking only (empty neutral content)", [T1, R1]],
    ["text split around a thinking block", [TEXT, T1, { type: "text", text: "and more" }]],
  ])("%s", (_name, content) => {
    expect(JSON.stringify(roundTrip(content as ContentBlockLike[]))).toBe(JSON.stringify(content));
  });

  test("the neutral half carries no reasoning, and each block keeps its stream index", () => {
    const { neutral, blocks } = separateReasoningBlocks([T1, TEXT, T2, CALL]);
    expect(neutral).toEqual([TEXT, CALL]);
    expect(blocks).toEqual([
      { at: 0, block: T1 },
      { at: 2, block: T2 },
    ]);
  });

  test("an `at` past the end appends rather than throws", () => {
    expect(spliceReasoningBlocks("x", [{ at: 9, block: T1 as never }])).toEqual([{ type: "text", text: "x" }, T1]);
  });
});

describe("inline wins, never merged (a transcript written before the move)", () => {
  test("content that already carries thinking is sent as it stands; the sidecar blocks are ignored", () => {
    const state: ProviderNativeState = { family: "anthropic", continuationDomain: "d", items: reasoningBlockItems([{ at: 0, block: T2 as never }]) };
    const inline = [T1, TEXT];
    expect(contentWithReasoningBlocks({ content: inline, nativeState: state })).toBe(inline);
  });

  test("no items: the content is returned by reference", () => {
    const content = [TEXT];
    expect(contentWithReasoningBlocks({ content })).toBe(content);
  });
});

describe("the tagged item", () => {
  test("only a well-formed tagged item is recognised", () => {
    expect(isReasoningBlockItem({ type: REASONING_BLOCK_ITEM_TYPE, at: 0, block: T1 })).toBe(true);
    expect(isReasoningBlockItem({ type: REASONING_BLOCK_ITEM_TYPE, at: -1, block: T1 })).toBe(false);
    expect(isReasoningBlockItem({ type: REASONING_BLOCK_ITEM_TYPE, at: 0, block: { type: "thinking", thinking: "x" } })).toBe(false);
    // A Responses reasoning item is someone else's.
    expect(isReasoningBlockItem({ type: "reasoning", encrypted_content: "e", summary: [] })).toBe(false);
  });

  test("the readable text is the thinking text only -- never a signature, never redacted data", () => {
    const state: ProviderNativeState = { family: "anthropic", continuationDomain: "d", items: reasoningBlockItems([{ at: 0, block: T1 as never }, { at: 1, block: R1 as never }, { at: 2, block: T2 as never }]) };
    const text = reasoningBlocksVisibleText(state)!;
    expect(text).toBe("look first\n\nthen act");
    expect(text).not.toContain("sig-a");
    expect(text).not.toContain("OPAQUE");
  });
});

describe("the Anthropic adapter puts the blocks back before anything reads the entry", () => {
  test("a thinking-only assistant turn (empty neutral content) still reaches the wire, leading-thinking order intact", () => {
    const { neutral, blocks } = separateReasoningBlocks([T1, CALL]);
    const wire = toWireMessages([
      { role: "user", content: "go" },
      { role: "assistant", content: asRebuilt(neutral), nativeState: { family: "anthropic", continuationDomain: "d", items: reasoningBlockItems(blocks) } },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
    ]);
    expect(wire[1]).toEqual({ role: "assistant", content: [{ type: "thinking", thinking: "look first", signature: "sig-a" }, { type: "tool_use", id: "toolu_1", name: "Glob", input: { pattern: "*" } }] });
    const onlyThinking = toWireMessages([{ role: "assistant", content: [], nativeState: { family: "anthropic", continuationDomain: "d", items: reasoningBlockItems([{ at: 0, block: R1 as never }]) } }]);
    expect(onlyThinking).toEqual([{ role: "assistant", content: [{ type: "redacted_thinking", data: "OPAQUE" }] }]);
  });

  test("a user or tool message is never spliced (the items ride assistant turns only)", () => {
    const wire = toWireMessages([{ role: "user", content: "hi", nativeState: { family: "anthropic", continuationDomain: "d", items: reasoningBlockItems([{ at: 0, block: T1 as never }]) } }]);
    expect(wire).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });
});
