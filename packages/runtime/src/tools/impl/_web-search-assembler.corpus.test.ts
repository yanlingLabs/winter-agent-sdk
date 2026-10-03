// A recorded input -> output corpus for the WebSearch output assembler: 1500 generated rows of three
// kinds -- `assemble` (`assembleWebSearchOutput(query, events)`), `flush` (`flushWebSearchStream(events)`)
// and `render` (`renderWebSearchToolResult(query, items)`) -- over text deltas padded with assorted
// whitespace, searches with zero to three hits, error codes (empty and padded included), raw string
// items, and queries from empty to just past the 1000-character header cap, with the output recorded
// at the time.
import { expect, test } from "bun:test";
import { assembleWebSearchOutput, flushWebSearchStream, renderWebSearchToolResult, type WebSearchResultItem, type WebSearchStreamEvent } from "./_web-search-assembler.ts";
import corpus from "./__corpus__/web-search-assembler.json";

type Row =
  | { fn: "assemble"; query: string; events: WebSearchStreamEvent[]; expected: string }
  | { fn: "flush"; events: WebSearchStreamEvent[]; expected: WebSearchResultItem[] }
  | { fn: "render"; query: string; items: WebSearchResultItem[]; expected: string };

const answer = (row: Row): unknown => {
  if (row.fn === "assemble") return assembleWebSearchOutput(row.query, row.events);
  if (row.fn === "flush") return flushWebSearchStream(row.events);
  return renderWebSearchToolResult(row.query, row.items);
};

test("the recorded corpus assembles exactly as recorded", () => {
  const rows = corpus as Row[];
  expect(rows.length).toBe(1500);
  const mismatches = rows.filter((row) => JSON.stringify(answer(row)) !== JSON.stringify(row.expected));
  expect(mismatches).toEqual([]);
});
