// Hand-built fixtures mirroring the research file's own "Output assembly" rules, one test per rule.
// This is the module a later differential test diffs against a real `claude` binary -- see
// `_web-search-assembler.ts`'s own header for the one interpretive choice (FLUSH_EMPTY_TEXT) these
// fixtures pin explicitly rather than leaving implicit.
import { describe, expect, test } from "bun:test";
import { assembleWebSearchOutput, flushWebSearchStream, renderWebSearchToolResult, type WebSearchStreamEvent } from "./_web-search-assembler.ts";

const REMINDER = "REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.";

// The render formula, spelled out once here so every fixture below is checked against an
// independent (if structurally identical) expression of the SAME rule rather than hand-counted
// newlines: `header + "\n\n"` once, `item + "\n\n"` for each item IN ORDER, then `"\n" + REMINDER`,
// the whole thing trimmed. A non-empty item list therefore ALWAYS ends `...lastItem\n\n\nREMINDER`
// (the item's own trailing blank line, plus the formula's own separating `"\n"`) -- three newlines,
// not two; an empty item list collapses to `header\n\n\nREMINDER` for the identical reason.
function expected(query: string, items: readonly string[]): string {
  const header = `Web search results for query: "${query}"`;
  return (header + "\n\n" + items.map((i) => i + "\n\n").join("") + "\n" + REMINDER).trim();
}

describe("renderWebSearchToolResult -- the string rules, in isolation from the stream walk", () => {
  test("text-only: a single string item, no links anywhere", () => {
    const out = renderWebSearchToolResult("hello", ["just an answer, no search was needed"]);
    expect(out).toBe(expected("hello", ["just an answer, no search was needed"]));
  });

  test("links-only: one non-empty links item renders `Links: ` + compact JSON", () => {
    const out = renderWebSearchToolResult("bun release", [{ content: [{ title: "Bun v1.4.2", url: "https://bun.com/blog/bun-v1.4.2" }] }]);
    expect(out).toBe(expected("bun release", [`Links: ${JSON.stringify([{ title: "Bun v1.4.2", url: "https://bun.com/blog/bun-v1.4.2" }])}`]));
  });

  test("empty links: `No links found.`", () => {
    const out = renderWebSearchToolResult("nothing found", [{ content: [] }]);
    expect(out).toBe(expected("nothing found", ["No links found."]));
  });

  test("an error item is a STRING, not a links item", () => {
    const out = renderWebSearchToolResult("q", ["Web search error: rate_limit"]);
    expect(out).toBe(expected("q", ["Web search error: rate_limit"]));
  });

  test("interleaved: string, links, string, links, in stream order, each on its own blank-line-separated block", () => {
    const out = renderWebSearchToolResult("q", [
      "Let me check two sources.",
      { content: [{ title: "A", url: "https://a.example/" }] },
      "Now the second.",
      { content: [{ title: "B", url: "https://b.example/" }] },
    ]);
    expect(out).toBe(
      expected("q", ["Let me check two sources.", `Links: ${JSON.stringify([{ title: "A", url: "https://a.example/" }])}`, "Now the second.", `Links: ${JSON.stringify([{ title: "B", url: "https://b.example/" }])}`]),
    );
  });

  test("zero items: header, then straight to the reminder (with no item's own trailing blank line to absorb the formula's separating newline)", () => {
    expect(renderWebSearchToolResult("q", [])).toBe(expected("q", []));
    expect(renderWebSearchToolResult("q", [])).toBe(`Web search results for query: "q"\n\n\n${REMINDER}`);
  });
});

describe("flushWebSearchStream -- the walk", () => {
  test("text-only: no search at all, the whole answer is one flushed (trimmed) item", () => {
    const events: WebSearchStreamEvent[] = [{ type: "text", text: "  the answer, no search needed  " }];
    expect(flushWebSearchStream(events)).toEqual(["the answer, no search needed"]);
  });

  test("links-only, round 1 forced: NO leading text -- with FLUSH_EMPTY_TEXT=false an empty flush contributes NO item, so item 0 is the links item itself", () => {
    const events: WebSearchStreamEvent[] = [{ type: "search_result", hits: [{ title: "A", url: "https://a.example/" }] }];
    expect(flushWebSearchStream(events)).toEqual([{ content: [{ title: "A", url: "https://a.example/" }] }]);
  });

  test("interleaved: text before a search flushes as its own item; two searches with nothing between them produce NO item between them", () => {
    const events: WebSearchStreamEvent[] = [
      { type: "text", text: "Let me look that up." },
      { type: "search_result", hits: [{ title: "A", url: "https://a.example/" }] },
      { type: "search_result", hits: [{ title: "B", url: "https://b.example/" }] },
      { type: "text", text: "Done." },
    ];
    expect(flushWebSearchStream(events)).toEqual(["Let me look that up.", { content: [{ title: "A", url: "https://a.example/" }] }, { content: [{ title: "B", url: "https://b.example/" }] }, "Done."]);
  });

  test("a search with zero hits is a links item with an EMPTY content array (not dropped, not a string)", () => {
    const events: WebSearchStreamEvent[] = [{ type: "search_result", hits: [] }];
    expect(flushWebSearchStream(events)).toEqual([{ content: [] }]);
  });

  test("a failed search pushes the exact string `Web search error: <code>`, never a links item", () => {
    const events: WebSearchStreamEvent[] = [{ type: "text", text: "Trying." }, { type: "search_error", code: "quota-exhausted" }];
    expect(flushWebSearchStream(events)).toEqual(["Trying.", "Web search error: quota-exhausted"]);
  });

  test("trailing text after the last search is flushed at the end, and a search with no trailing text contributes no extra empty item", () => {
    const withTrailing: WebSearchStreamEvent[] = [{ type: "search_result", hits: [{ title: "A", url: "https://a.example/" }] }, { type: "text", text: "Based on that, here is the summary." }];
    expect(flushWebSearchStream(withTrailing)).toEqual([{ content: [{ title: "A", url: "https://a.example/" }] }, "Based on that, here is the summary."]);
    const withoutTrailing: WebSearchStreamEvent[] = [{ type: "search_result", hits: [{ title: "A", url: "https://a.example/" }] }];
    expect(flushWebSearchStream(withoutTrailing)).toEqual([{ content: [{ title: "A", url: "https://a.example/" }] }]);
  });

  test("only titles and urls survive into a links item, even when the caller's event carries nothing else (the type has no room for a highlight)", () => {
    const events: WebSearchStreamEvent[] = [{ type: "search_result", hits: [{ title: "Only Title", url: "https://only.example/" }] }];
    const [links] = flushWebSearchStream(events);
    expect(links).toEqual({ content: [{ title: "Only Title", url: "https://only.example/" }] });
    expect(Object.keys((links as { content: unknown[] }).content[0]!)).toEqual(["title", "url"]);
  });
});

describe("assembleWebSearchOutput -- both stages composed, end to end", () => {
  test("a full multi-search pass, trimmed, with the verbatim reminder", () => {
    const out = assembleWebSearchOutput("bun 1.4 release notes", [
      { type: "text", text: "Let me check the release notes." },
      { type: "search_result", hits: [{ title: "Bun v1.4.2 | Bun Blog", url: "https://bun.com/blog/bun-v1.4.2" }] },
      { type: "text", text: "Bun 1.4.2 fixed two regressions." },
    ]);
    expect(out).toBe(
      expected("bun 1.4 release notes", [
        "Let me check the release notes.",
        `Links: ${JSON.stringify([{ title: "Bun v1.4.2 | Bun Blog", url: "https://bun.com/blog/bun-v1.4.2" }])}`,
        "Bun 1.4.2 fixed two regressions.",
      ]),
    );
    // No leading/trailing whitespace survives the final .trim().
    expect(out.startsWith("Web search results")).toBe(true);
    expect(out.endsWith(REMINDER)).toBe(true);
  });

  test("zero successful searches (every call errored) still names the searches and their errors, never fabricated results", () => {
    const out = assembleWebSearchOutput("q", [{ type: "search_error", code: "unreachable" }, { type: "search_error", code: "timeout" }]);
    expect(out).toBe(expected("q", ["Web search error: unreachable", "Web search error: timeout"]));
  });
});
