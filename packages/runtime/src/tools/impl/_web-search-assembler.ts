// THE OUTPUT ASSEMBLER -- WebSearch's tool_result text, built by PURE functions over the inner
// search pass's event list (plus a capped variant of the render, added for the executor's own
// result-size ceiling -- see `renderWebSearchToolResultCapped` below). Registers nothing, imports
// nothing but its own types, so it is trivially importable from `impl/web-search.ts` and from a
// differential test that feeds it a scripted sequence and compares the returned string with a real
// `claude` binary's tool_result for the same sequence of searches.
//
// Two stages: a STREAM WALK (`flushWebSearchStream`) turns the raw event sequence (text deltas
// interleaved with search calls) into a list of items -- commentary strings and `{content}` links
// items -- and a RENDER pass (`renderWebSearchToolResult`) turns that list into the exact
// `tool_result` string the model reads. `assembleWebSearchOutput` is both stages composed, for a
// caller that has no use for the intermediate shape.

/** A search hit as the OUTER (main-loop) model is allowed to see it: title and url ONLY -- no highlight, no date, no encrypted content. */
export interface WebSearchOutputHit {
  title: string;
  url: string;
}

/**
 * The BLOCK STREAM: text deltas (accumulate), a search that returned hits (a
 * `web_search_tool_result` block), or a search that failed (rendered as the STRING
 * `Web search error: ${code}` -- NOT as an empty links item).
 */
export type WebSearchStreamEvent = { type: "text"; text: string } | { type: "search_result"; hits: readonly WebSearchOutputHit[] } | { type: "search_error"; code: string };

/** One assembled item: a commentary/error string, or a links item. */
export type WebSearchResultItem = string | { content: readonly WebSearchOutputHit[] };

/** Stage 1: the stream walk -- text events buffered, flushed as one trimmed item at each search and at the end. */
export function flushWebSearchStream(events: readonly WebSearchStreamEvent[]): WebSearchResultItem[] {
  const items: WebSearchResultItem[] = [];
  let buffer = "";
  const flush = (): void => {
    const text = buffer.trim();
    if (text !== "") items.push(text);
    buffer = "";
  };
  for (const event of events) {
    switch (event.type) {
      case "text":
        buffer += event.text;
        break;
      case "search_result":
        flush();
        items.push({ content: event.hits.map((hit) => ({ title: hit.title, url: hit.url })) });
        break;
      case "search_error":
        flush();
        items.push(`Web search error: ${event.code}`);
        break;
    }
  }
  flush();
  return items;
}

const REMINDER = "REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.";

/**
 * The most of the QUERY that reaches the header. The query is otherwise interpolated raw, but
 * the header is the one part of the render the size cap cannot drop -- so a 1 MB query defeated the
 * 100,000-char cap entirely (whole-branch review, NIT): every item could be dropped and the result was
 * still megabytes. A thousand characters is far longer than any real search query, so the capped and
 * the uncapped render are byte-identical for every input either side has been measured on.
 */
const HEADER_QUERY_CAP = 1_000;

function headerQuery(query: string): string {
  if (query.length <= HEADER_QUERY_CAP) return query;
  return `${query.slice(0, HEADER_QUERY_CAP)}[query truncated at ${HEADER_QUERY_CAP.toLocaleString("en-US")} characters]`;
}

/** Stage 2: the render -- the header, each item followed by a blank line, then the reminder footer. */
export function renderWebSearchToolResult(query: string, items: readonly WebSearchResultItem[]): string {
  let out = `Web search results for query: "${headerQuery(query)}"\n\n`;
  for (const item of items) out += `${renderItem(item)}\n\n`;
  return `${out}\n${REMINDER}`;
}

function renderItem(item: WebSearchResultItem): string {
  if (typeof item === "string") return item;
  return item.content.length > 0 ? `Links: ${JSON.stringify(item.content)}` : "No links found.";
}

/** Both stages composed -- what a caller with no use for the intermediate item list reaches for. */
export function assembleWebSearchOutput(query: string, events: readonly WebSearchStreamEvent[]): string {
  return renderWebSearchToolResult(query, flushWebSearchStream(events));
}

/**
 * `renderWebSearchToolResult`, but never longer than `cap` -- and the cap NEVER costs the header or
 * the REMINDER footer (review fix: a raw `text.slice(0, cap)` on the FULL render chops from the end,
 * which is exactly where the "you MUST include sources" trailer lives -- the one line most worth
 * keeping when there was the most to cite). Items are dropped from the END, in stream order (the
 * earliest results and commentary are kept), one at a time, until what remains renders under `cap`;
 * with zero items left the render is just the header and the reminder, which is the floor this
 * function can promise -- a `cap` smaller than THAT floor (an unrealistic value for a 100,000-char
 * default and an ordinary query) is the one input this cannot fully honour, and is left uncapped
 * further than that floor rather than truncating the header or the reminder itself.
 */
export function renderWebSearchToolResultCapped(query: string, items: readonly WebSearchResultItem[], cap: number): string {
  const full = renderWebSearchToolResult(query, items);
  if (full.length <= cap) return full;
  let kept = items;
  while (kept.length > 0 && renderWebSearchToolResult(query, kept).length > cap) kept = kept.slice(0, -1);
  return renderWebSearchToolResult(query, kept);
}

/** Both stages composed, capped -- what `impl/web-search.ts` calls instead of slicing the finished string. */
export function assembleWebSearchOutputCapped(query: string, events: readonly WebSearchStreamEvent[], cap: number): string {
  return renderWebSearchToolResultCapped(query, flushWebSearchStream(events), cap);
}
