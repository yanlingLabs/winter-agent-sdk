// SDK 0.0.16 Lane C: the live request's layout, against bytes CAPTURED from the pinned claude
// 0.3.250 binary (a loopback fake recording its first three request bodies for a two-turn session
// with one tool round). The expected strings below are those captured bytes with this fixture's own
// values substituted.
import { describe, expect, test } from "bun:test";
import type { ProviderMessage } from "../engine.ts";
import { attachmentMessage } from "./attachments.ts";
import {
  buildRequestMessages,
  buildSystemBlocks,
  clearSessionRequestLayout,
  foldTextIntoToolResult,
  getSessionRequestLayout,
  joinSystemBlocks,
  recordSessionRequestLayout,
  renderSystemContext,
  renderUserContext,
  reorderAttachments,
} from "./request-layout.ts";

const CTX_ENTRIES = [
  ["claudeMd", "Codebase and user instructions are shown below.\n\nContents of /p/WINTER.md (project instructions, checked into the codebase):\n\nBODY"],
  ["currentDate", "Today's date is 2026-09-17."],
] as const;

const LISTING = attachmentMessage({ type: "agent_listing_delta", addedTypes: ["a"], addedLines: ["- a: A. (Tools: *)"], removedTypes: [], isInitial: true, showConcurrencyNote: false })!;
const SKILLS = attachmentMessage({ type: "skill_listing", content: "- s: S.", skillCount: 1, isInitial: true, names: ["s"] })!;
const DATE = attachmentMessage({ type: "date_change", newDate: "2026-09-18" })!;

describe("the index-0 context message (claude's mbt)", () => {
  test("exact bytes and key order, one trailing newline", () => {
    expect(renderUserContext(CTX_ENTRIES)).toBe(
      "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n" +
        "# claudeMd\nCodebase and user instructions are shown below.\n\nContents of /p/WINTER.md (project instructions, checked into the codebase):\n\nBODY\n" +
        "# currentDate\nToday's date is 2026-09-17.\n\n" +
        "      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n" +
        "</system-reminder>\n",
    );
  });

  test("an empty map prepends nothing", () => {
    expect(renderUserContext([])).toBeUndefined();
    expect(buildRequestMessages([{ role: "user", content: "hi" }], undefined)).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("the systemContext part and cache blocks (claude's pbt / VEe)", () => {
  test("`key: value` lines", () => {
    expect(renderSystemContext([["gitStatus", "This is a snapshot.\n\nCurrent branch: main"]])).toBe("gitStatus: This is a snapshot.\n\nCurrent branch: main");
    expect(renderSystemContext([])).toBeUndefined();
  });

  test("with a boundary: static is global, dynamic plus systemContext is org, parts joined by a blank line", () => {
    const blocks = buildSystemBlocks({ staticParts: ["S1", "S2"], dynamicParts: ["D1", ""], systemContext: "gitStatus: g", hasBoundary: true });
    expect(blocks).toEqual([
      { text: "S1\n\nS2", cacheScope: "global" },
      { text: "D1\n\ngitStatus: g", cacheScope: "org" },
    ]);
    expect(joinSystemBlocks(blocks)).toBe("S1\n\nS2\n\nD1\n\ngitStatus: g");
  });

  test("without a boundary everything is one org block", () => {
    expect(buildSystemBlocks({ staticParts: ["caller"], dynamicParts: ["D"], hasBoundary: false })).toEqual([{ text: "caller\n\nD", cacheScope: "org" }]);
  });
});

describe("attachment reorder (claude's SJn)", () => {
  test("attachments after the first prompt bubble to the very top, above the index-0 context", () => {
    const ctx: ProviderMessage = { role: "user", content: "CTX", isMeta: true };
    const prompt: ProviderMessage = { role: "user", content: "P" };
    expect(reorderAttachments([ctx, prompt, LISTING, SKILLS])).toEqual([LISTING, SKILLS, ctx, prompt]);
  });

  test("attachments stop right after an assistant message or a tool-result message", () => {
    const history: ProviderMessage[] = [
      { role: "user", content: "P1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "P2" },
      DATE,
    ];
    expect(reorderAttachments(history).map((m) => (m.meta !== undefined ? "att" : String(m.content)))).toEqual(["P1", "A1", "att", "P2"]);
    const tool: ProviderMessage = { role: "tool", content: [{ type: "tool_result", tool_use_id: "t", content: "out" }] };
    expect(reorderAttachments([{ role: "assistant", content: "A" }, tool, DATE])).toEqual([{ role: "assistant", content: "A" }, tool, DATE]);
  });
});

describe("the merged request (claude's Noe / mIt / IMe)", () => {
  test("turn 1 is ONE user message: attachments, the context + newline, the prompt", () => {
    const history: ProviderMessage[] = [{ role: "user", content: "FIRST" }, LISTING, SKILLS];
    const ctx = renderUserContext(CTX_ENTRIES)!;
    const out = buildRequestMessages(history, ctx);
    expect(out).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: LISTING.content as string },
          // An attachment joining an attachment adds nothing between them (mIt).
          { type: "text", text: `${SKILLS.content as string}\n` },
          // ...an ordinary message joining one adds a newline to the previous text (Noe) -- which is why
          // the captured context block ends with TWO newlines.
          { type: "text", text: `${ctx}\n` },
          { type: "text", text: "FIRST" },
        ],
      },
    ]);
    // The history itself is untouched.
    expect(history[0]).toEqual({ role: "user", content: "FIRST" });
  });

  test("attachments after a tool round are folded INTO a string tool result, trimmed and blank-line joined", () => {
    const history: ProviderMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "t1", content: "hi\n" }] },
      DATE,
    ];
    const out = buildRequestMessages(history);
    expect(out[2]).toEqual({ role: "tool", content: [{ type: "tool_result", tool_use_id: "t1", content: `hi\n\n${DATE.content as string}` }] });
  });

  test("WS-23 midconv live gate: an attachment is NEVER folded into a ToolSearch result that loaded tools -- it stays a trailing text block", () => {
    const history: ProviderMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "ToolSearch", input: {} }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "t1", content: '{"matches":["X"]}', loadedTools: ["X"] }] },
      DATE,
    ];
    const out = buildRequestMessages(history);
    expect(out[2]).toEqual({ role: "tool", content: [{ type: "tool_result", tool_use_id: "t1", content: '{"matches":["X"]}', loadedTools: ["X"] }, { type: "text", text: DATE.content as string }] });
  });

  test("a tool result with block content keeps the text as trailing blocks (the adapters' 'text after tool results')", () => {
    const history: ProviderMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "page" }] }] },
      DATE,
    ];
    const out = buildRequestMessages(history);
    expect(out[1]).toEqual({ role: "tool", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "page" }] }, { type: "text", text: DATE.content as string }] });
  });

  test("turn 2's request repeats turn 1's prefix byte for byte", () => {
    const ctx = renderUserContext(CTX_ENTRIES)!;
    const history: ProviderMessage[] = [{ role: "user", content: "FIRST" }, LISTING];
    const turn1 = buildRequestMessages(history, ctx);
    history.push({ role: "assistant", content: "done" }, { role: "user", content: "SECOND" });
    const turn2 = buildRequestMessages(history, ctx);
    expect(JSON.stringify(turn2.slice(0, turn1.length))).toBe(JSON.stringify(turn1));
    expect(turn2.slice(turn1.length)).toEqual([{ role: "assistant", content: "done" }, { role: "user", content: "SECOND" }]);
  });

  test("tool results are hoisted to the front of a merged turn", () => {
    const out = buildRequestMessages([
      { role: "user", content: "x" },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "t", content: [] }] },
    ]);
    expect(out).toEqual([{ role: "tool", content: [{ type: "tool_result", tool_use_id: "t", content: [] }, { type: "text", text: "x" }] }]);
  });

  test("foldTextIntoToolResult: array content merges adjacent text, refuses a tool_reference", () => {
    const folded = foldTextIntoToolResult({ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: " a " }] }, [{ type: "text", text: " b" }]);
    expect(folded).toEqual({ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "a\n\nb" }] });
    expect(foldTextIntoToolResult({ type: "tool_result", tool_use_id: "t", content: [{ type: "tool_reference", tool_names: ["X"] }] }, [{ type: "text", text: "b" }])).toBeNull();
  });
});

describe("the per-session layout record (for the fork lane)", () => {
  test("record, read, clear -- keyed by session and agent", () => {
    const layout = { systemBlocks: [{ text: "s", cacheScope: "org" as const }], userContext: [["currentDate", "d"] as const], tools: [] };
    recordSessionRequestLayout("sess-layout", undefined, layout);
    recordSessionRequestLayout("sess-layout", "agent-1", { ...layout, tools: [{ name: "Read", description: "r", inputSchema: {} }] });
    expect(getSessionRequestLayout("sess-layout")).toBe(layout);
    expect(getSessionRequestLayout("sess-layout", "agent-1")?.tools).toHaveLength(1);
    clearSessionRequestLayout("sess-layout");
    clearSessionRequestLayout("sess-layout", "agent-1");
    expect(getSessionRequestLayout("sess-layout")).toBeUndefined();
  });
});
