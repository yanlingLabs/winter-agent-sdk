// Edge cases of the WebSearch output assembler: the stream walk's buffering and flush rule, and the
// render's exact layout (raw string items, the links JSON, the header query, the reminder footer).
import { describe, expect, test } from "bun:test";
import { assembleWebSearchOutputCapped, flushWebSearchStream, renderWebSearchToolResult, renderWebSearchToolResultCapped, type WebSearchResultItem, type WebSearchStreamEvent } from "./_web-search-assembler.ts";

const REMINDER = "REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.";

describe("flushWebSearchStream", () => {
  test("text deltas join with no separator; inner whitespace is kept; only the ends are trimmed", () => {
    const events: WebSearchStreamEvent[] = [{ type: "text", text: " a " }, { type: "text", text: "b " }, { type: "text", text: "\n c\t" }];
    expect(flushWebSearchStream(events)).toEqual(["a b \n c"]);
  });

  test("whitespace-only text before or after a search contributes no item (any JS whitespace, including NBSP)", () => {
    const events: WebSearchStreamEvent[] = [{ type: "text", text: "  \n" }, { type: "search_error", code: "x" }, { type: "text", text: " \t" }];
    expect(flushWebSearchStream(events)).toEqual(["Web search error: x"]);
  });

  test("the buffer is cleared at every search: text is never carried across a search", () => {
    const events: WebSearchStreamEvent[] = [{ type: "text", text: "one" }, { type: "search_result", hits: [] }, { type: "text", text: "two" }, { type: "search_error", code: "e" }, { type: "text", text: "three" }];
    expect(flushWebSearchStream(events)).toEqual(["one", { content: [] }, "two", "Web search error: e", "three"]);
  });

  test("an error code is used as given, even empty or odd", () => {
    expect(flushWebSearchStream([{ type: "search_error", code: "" }])).toEqual(["Web search error: "]);
    expect(flushWebSearchStream([{ type: "search_error", code: " a\nb " }])).toEqual(["Web search error:  a\nb "]);
  });

  test("a hit is reduced to exactly `{title, url}` (in that key order), whatever else it carries", () => {
    const hit = { url: "https://u.example/", extra: 1, title: "T" } as unknown as { title: string; url: string };
    const [item] = flushWebSearchStream([{ type: "search_result", hits: [hit] }]);
    expect(JSON.stringify(item)).toBe('{"content":[{"title":"T","url":"https://u.example/"}]}');
  });

  test("no events -> no items", () => {
    expect(flushWebSearchStream([])).toEqual([]);
  });
});

describe("renderWebSearchToolResult", () => {
  test("zero items: the header, three newlines, the reminder", () => {
    expect(renderWebSearchToolResult("q", [])).toBe(`Web search results for query: "q"\n\n\n${REMINDER}`);
    expect(renderWebSearchToolResult("", [])).toBe(`Web search results for query: ""\n\n\n${REMINDER}`);
  });

  test("string items are rendered exactly as given -- empty and padded ones included -- each followed by a blank line", () => {
    expect(renderWebSearchToolResult("q", ["", "  pad  ", { content: [] }])).toBe(`Web search results for query: "q"\n\n\n\n  pad  \n\nNo links found.\n\n\n${REMINDER}`);
    expect(renderWebSearchToolResult(" ", ["\n"])).toBe(`Web search results for query: " "\n\n\n\n\n\n${REMINDER}`);
  });

  test("a links item is `Links: ` + compact JSON of its content array as given", () => {
    const item = { content: [{ title: 'a "q"', url: "https://x/", extra: true }] } as unknown as WebSearchResultItem;
    expect(renderWebSearchToolResult("q", [item])).toBe(`Web search results for query: "q"\n\nLinks: [{"title":"a \\"q\\"","url":"https://x/","extra":true}]\n\n\n${REMINDER}`);
  });

  test("the query is interpolated raw up to 1000 characters; longer is cut to 1000 plus a marker", () => {
    expect(renderWebSearchToolResult('a"\nb', [])).toBe(`Web search results for query: "a"\nb"\n\n\n${REMINDER}`);
    const exact = "x".repeat(1000);
    expect(renderWebSearchToolResult(exact, [])).toBe(`Web search results for query: "${exact}"\n\n\n${REMINDER}`);
    expect(renderWebSearchToolResult("y".repeat(1001), [])).toBe(`Web search results for query: "${"y".repeat(1000)}[query truncated at 1,000 characters]"\n\n\n${REMINDER}`);
  });
});

describe("the capped render", () => {
  test("under the cap it is the plain render; over it, items are dropped from the end until it fits", () => {
    const items: WebSearchResultItem[] = ["first", "second", "third"];
    const full = renderWebSearchToolResult("q", items);
    expect(renderWebSearchToolResultCapped("q", items, full.length)).toBe(full);
    expect(renderWebSearchToolResultCapped("q", items, full.length - 1)).toBe(renderWebSearchToolResult("q", ["first", "second"]));
  });

  test("a cap below the zero-item floor still returns the zero-item render", () => {
    expect(renderWebSearchToolResultCapped("q", ["a"], 5)).toBe(renderWebSearchToolResult("q", []));
    expect(assembleWebSearchOutputCapped("q", [{ type: "text", text: "a" }], 5)).toBe(renderWebSearchToolResult("q", []));
  });
});
