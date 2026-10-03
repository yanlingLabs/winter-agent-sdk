// Edge cases of the request layout's message normalisation: the attachment reorder, the user-turn
// merge (tool results first, the newline join, the attachment join and its fold into a tool result).
import { describe, expect, test } from "bun:test";
import type { ContentBlock, ProviderMessage } from "../engine.ts";
import { buildRequestMessages, foldTextIntoToolResult, isSmooshExempt, reorderAttachments } from "./request-layout.ts";

const att = (name: string): ProviderMessage => ({ role: "user", content: `<system-reminder>\n${name}\n</system-reminder>`, meta: { attachment: { type: `edge-${name}` } } });
const user = (text: string): ProviderMessage => ({ role: "user", content: text });
const asst = (text: string): ProviderMessage => ({ role: "assistant", content: text });
type ToolResult = Extract<ContentBlock, { type: "tool_result" }>;
const result = (id: string, content: string | ContentBlock[], extra: Record<string, unknown> = {}): ToolResult => ({ type: "tool_result", tool_use_id: id, content, ...extra }) as ToolResult;
const label = (m: ProviderMessage): string => (m.meta !== undefined ? `att:${m.meta.attachment.type.slice(5)}` : typeof m.content === "string" ? `${m.role}:${m.content}` : `${m.role}:[${m.content.map((b) => b.type).join(",")}]`);

describe("reorderAttachments", () => {
  test("a history with no attachment comes back as a NEW array with the same messages", () => {
    const history = [user("a"), asst("b")];
    const out = reorderAttachments(history);
    expect(out).not.toBe(history);
    expect(out).toEqual(history);
    expect(out[0]).toBe(history[0]!);
  });

  test("a run of attachments keeps its own order when it moves, and lands right after the stop message", () => {
    expect(reorderAttachments([asst("A"), user("P"), att("1"), att("2"), att("3")]).map(label)).toEqual(["assistant:A", "att:1", "att:2", "att:3", "user:P"]);
  });

  test("attachments separated by ordinary user messages gather into one run behind the stop", () => {
    expect(reorderAttachments([asst("A"), user("P"), att("1"), user("Q"), att("2")]).map(label)).toEqual(["assistant:A", "att:1", "att:2", "user:P", "user:Q"]);
  });

  test("a user message whose FIRST block is a tool_result stops the climb; one where it is not, does not", () => {
    const stop: ProviderMessage = { role: "tool", content: [result("t", "o"), { type: "text", text: "x" }] };
    const noStop: ProviderMessage = { role: "user", content: [{ type: "text", text: "x" }, result("t", "o")] };
    expect(reorderAttachments([user("P"), stop, att("1")]).map(label)).toEqual(["user:P", "tool:[tool_result,text]", "att:1"]);
    expect(reorderAttachments([user("P"), noStop, att("1")]).map(label)).toEqual(["att:1", "user:P", "user:[text,tool_result]"]);
  });

  test("a tool message with STRING content is not a stop", () => {
    expect(reorderAttachments([user("P"), { role: "tool", content: "str" }, att("1")]).map(label)).toEqual(["att:1", "user:P", "tool:str"]);
  });

  test("several stops: each run lands after the nearest stop above it", () => {
    expect(reorderAttachments([att("0"), user("P"), att("1"), asst("A"), user("Q"), att("2"), asst("B"), att("3")]).map(label)).toEqual([
      "att:0",
      "att:1",
      "user:P",
      "assistant:A",
      "att:2",
      "user:Q",
      "assistant:B",
      "att:3",
    ]);
  });

  test("an attachment the `stays` predicate keeps does not move, and others climb past it", () => {
    const keep = att("keep");
    const out = reorderAttachments([asst("A"), user("P"), keep, att("1")], (m) => m === keep);
    expect(out.map(label)).toEqual(["assistant:A", "att:1", "user:P", "att:keep"]);
  });
});

describe("the user-turn merge", () => {
  test("text joining text gets one newline appended to the PREVIOUS last text block", () => {
    expect(buildRequestMessages([user("a"), user("b")])).toEqual([{ role: "user", content: [{ type: "text", text: "a\n" }, { type: "text", text: "b" }] }]);
  });

  test("no newline when the previous last block or the next first block is not text", () => {
    const img: ContentBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } };
    expect(buildRequestMessages([user("a"), { role: "user", content: [img, { type: "text", text: "b" }] }])).toEqual([{ role: "user", content: [{ type: "text", text: "a" }, img, { type: "text", text: "b" }] }]);
    expect(buildRequestMessages([{ role: "user", content: [img] }, user("b")])).toEqual([{ role: "user", content: [img, { type: "text", text: "b" }] }]);
  });

  test("a merged turn is `tool` exactly when it carries a tool_result, with every tool_result first in order", () => {
    // The newline join looks at the blocks AFTER the previous merge hoisted its tool result: `a` is last.
    const out = buildRequestMessages([user("a"), { role: "tool", content: [result("1", "x")] }, { role: "user", content: [{ type: "text", text: "b" }, result("2", [])] }]);
    expect(out).toEqual([{ role: "tool", content: [result("1", "x"), result("2", []), { type: "text", text: "a\n" }, { type: "text", text: "b" }] }]);
  });

  test("the merged entry carries only role and content; a lone message keeps its other fields", () => {
    const lone = att("1");
    expect(buildRequestMessages([lone])).toEqual([{ ...lone }]);
    // The attachment climbs above `a`, and `a` (an ordinary message) joining it adds the newline.
    expect(buildRequestMessages([user("a"), lone])[0]).toEqual({ role: "user", content: [{ type: "text", text: `${lone.content as string}\n` }, { type: "text", text: "a" }] });
  });

  test("an attachment joining text adds NO newline", () => {
    const a1 = att("1");
    const a2 = att("2");
    expect(buildRequestMessages([a1, a2])).toEqual([{ role: "user", content: [{ type: "text", text: a1.content as string }, { type: "text", text: a2.content as string }] }]);
    expect(buildRequestMessages([asst("A"), user("x"), a1])[1]).toEqual({ role: "user", content: [{ type: "text", text: `${a1.content as string}\n` }, { type: "text", text: "x" }] });
  });

  test("an attachment is folded into a trailing STRING tool result: both sides trimmed, empty pieces dropped, other fields kept", () => {
    const a = att("1");
    const out = buildRequestMessages([asst("A"), { role: "tool", content: [result("t", "  out \n", { is_error: true })] }, a]);
    expect(out[1]).toEqual({ role: "tool", content: [result("t", `out\n\n${(a.content as string).trim()}`, { is_error: true })] });
    const blank = buildRequestMessages([asst("A"), { role: "tool", content: [result("t", "   ")] }, a]);
    expect(blank[1]).toEqual({ role: "tool", content: [result("t", (a.content as string).trim())] });
  });

  test("an EMPTY loadedTools list does not stop the fold; a non-empty one does", () => {
    const a = att("1");
    expect(buildRequestMessages([asst("A"), { role: "tool", content: [result("t", "o", { loadedTools: [] })] }, a])[1]).toEqual({ role: "tool", content: [result("t", `o\n\n${a.content as string}`, { loadedTools: [] })] });
    expect(buildRequestMessages([asst("A"), { role: "tool", content: [result("t", "o", { loadedTools: ["X"] })] }, a])[1]).toEqual({
      role: "tool",
      content: [result("t", "o", { loadedTools: ["X"] }), { type: "text", text: a.content as string }],
    });
  });

  test("an attachment with a non-text block is appended, not folded", () => {
    const img: ContentBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } };
    const mixed: ProviderMessage = { role: "user", content: [{ type: "text", text: "t" }, img], meta: { attachment: { type: "edge-mixed" } } };
    expect(buildRequestMessages([asst("A"), { role: "tool", content: [result("t", "o")] }, mixed])[1]).toEqual({ role: "tool", content: [result("t", "o"), { type: "text", text: "t" }, img] });
  });

  test("a smoosh-exempt reminder is appended after the tool result, never folded", () => {
    const exempt: ProviderMessage = { role: "user", content: "<system-reminder>\n<event x>\n</system-reminder>", meta: { attachment: { type: "edge-exempt" } } };
    expect(buildRequestMessages([asst("A"), { role: "tool", content: [result("t", "o")] }, exempt])[1]).toEqual({ role: "tool", content: [result("t", "o"), { type: "text", text: exempt.content as string }] });
  });

  test("an attachment only folds into the LAST block; an earlier tool result is untouched", () => {
    const a = att("1");
    const out = buildRequestMessages([asst("A"), { role: "tool", content: [result("t", "o"), { type: "text", text: "after" }] }, a]);
    expect(out[1]).toEqual({ role: "tool", content: [result("t", "o"), { type: "text", text: "after" }, { type: "text", text: a.content as string }] });
  });

  test("an ordinary user message after a tool result is appended (no fold), tool result still first", () => {
    expect(buildRequestMessages([asst("A"), { role: "tool", content: [result("t", "o")] }, user("next")])[1]).toEqual({ role: "tool", content: [result("t", "o"), { type: "text", text: "next" }] });
  });

  test("assistant messages are never merged", () => {
    expect(buildRequestMessages([asst("a"), asst("b")])).toEqual([asst("a"), asst("b")]);
  });
});

describe("isSmooshExempt", () => {
  test("exactly the reminder prefix plus a newline, then one of the two openers", () => {
    expect(isSmooshExempt("<system-reminder>\n<event a>")).toBe(true);
    expect(isSmooshExempt("<system-reminder>\n<system>authentic event nonces for this delivery: n")).toBe(true);
    expect(isSmooshExempt("<system-reminder>\n<event")).toBe(false);
    expect(isSmooshExempt("<system-reminder><event a>")).toBe(false);
    expect(isSmooshExempt(" <system-reminder>\n<event a>")).toBe(false);
    expect(isSmooshExempt("<system-reminder>\n <event a>")).toBe(false);
    expect(isSmooshExempt("<system-reminder>\n<system>authentic event nonces for this delivery:")).toBe(false);
    expect(isSmooshExempt("<SYSTEM-REMINDER>\n<event a>")).toBe(false);
    expect(isSmooshExempt("")).toBe(false);
  });
});

describe("foldTextIntoToolResult", () => {
  const text = (t: string): Extract<ContentBlock, { type: "text" }> => ({ type: "text", text: t });

  test("no texts: the SAME result object comes back, whatever it carries", () => {
    const r = result("t", [{ type: "tool_reference", tool_names: ["X"] }], { loadedTools: ["X"] }) as Extract<ContentBlock, { type: "tool_result" }>;
    expect(foldTextIntoToolResult(r, [])).toBe(r);
  });

  test("array content: existing adjacent text blocks are joined too, non-text blocks split the runs", () => {
    const img: ContentBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } };
    const r = result("t", [text(" a "), text("b"), img, text("  ")]) as Extract<ContentBlock, { type: "tool_result" }>;
    expect(foldTextIntoToolResult(r, [text(" c"), text(""), text("d ")])).toEqual(result("t", [text("a\n\nb"), img, text("c\n\nd")]));
  });

  test("array content that ends up with no text keeps only the non-text blocks", () => {
    const r = result("t", []) as Extract<ContentBlock, { type: "tool_result" }>;
    expect(foldTextIntoToolResult(r, [text("  "), text("\n")])).toEqual(result("t", []));
  });

  test("string content: every piece trimmed, empty ones dropped, `\\n\\n` between", () => {
    const r = result("t", "", { is_error: true, interrupted: true }) as Extract<ContentBlock, { type: "tool_result" }>;
    expect(foldTextIntoToolResult(r, [text("  "), text(" x "), text("y\n")])).toEqual(result("t", "x\n\ny", { is_error: true, interrupted: true }));
  });

  test("a tool_reference ANYWHERE in array content refuses; loadedTools refuses for string and array content", () => {
    expect(foldTextIntoToolResult(result("t", [text("a"), { type: "tool_reference", tool_names: [] }]) as Extract<ContentBlock, { type: "tool_result" }>, [text("b")])).toBeNull();
    expect(foldTextIntoToolResult(result("t", [text("a")], { loadedTools: ["X"] }) as Extract<ContentBlock, { type: "tool_result" }>, [text("b")])).toBeNull();
    expect(foldTextIntoToolResult(result("t", "a", { loadedTools: [] }) as Extract<ContentBlock, { type: "tool_result" }>, [text("b")])).toEqual(result("t", "a\n\nb", { loadedTools: [] }));
  });

  test("the input result is never mutated", () => {
    const r = result("t", [text("a")]) as Extract<ContentBlock, { type: "tool_result" }>;
    const before = JSON.stringify(r);
    foldTextIntoToolResult(r, [text("b")]);
    expect(JSON.stringify(r)).toBe(before);
  });
});
