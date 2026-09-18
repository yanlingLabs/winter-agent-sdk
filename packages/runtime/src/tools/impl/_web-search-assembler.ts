// THE OUTPUT ASSEMBLER -- claude's own WebSearch stream-walk and tool_result rendering, reproduced as
// PURE functions over a claude-shaped event/item list (plus a capped variant of the render, added for
// the executor's own result-size ceiling -- see `renderWebSearchToolResultCapped` below). Registers
// nothing, imports nothing but its own types, so it is trivially importable from `impl/web-search.ts`
// and from a future differential test that feeds it a scripted sequence and diffs the RETURNED STRING
// byte-for-byte against a real `claude` binary's tool_result for the same sequence of searches.
//
// THE SPLIT MIRRORS CLAUDE'S OWN TWO-STAGE SHAPE (research file, "Output assembly"): a STREAM WALK
// (`flushWebSearchStream`) turns the raw block sequence (text deltas interleaved with search calls)
// into claude's own STRUCTURED type -- literally `results: (string | { tool_use_id, content:
// {title,url}[] })[]` in the research file, reproduced here as `WebSearchResultItem[]` (tool_use_id
// dropped: nothing downstream of the walk ever reads it, since the STRING rendering rules quoted in
// the research file only ever consult `content`) -- and a RENDER pass (`renderWebSearchToolResult`)
// turns that structured list into the exact `tool_result` string the model reads. `assembleWebSearchOutput`
// is both stages composed, for a caller that has no use for the intermediate shape.
//
// THE FLUSH RULE, SETTLED (independent review): claude's own code is `if(u.trim().length>0)
// o.push(u.trim())` -- a flush contributes an item ONLY when the trimmed buffer is non-empty. A
// forced round 1 with no leading commentary therefore contributes NO item before its first search
// (not an empty string), and a call ending on a search contributes no trailing item either.

/** A search hit as the OUTER (main-loop) model is allowed to see it: title and url ONLY -- no highlight, no date, no encrypted content. */
export interface WebSearchOutputHit {
  title: string;
  url: string;
}

/**
 * The claude-shaped BLOCK STREAM: text deltas (accumulate), a search that returned hits (a
 * `web_search_tool_result` block), or a search that failed (a result-block error, which claude
 * renders as the STRING `Web search error: ${code}` -- NOT as an empty links item; see the research
 * file's own "a result-block error pushes the string" line).
 */
export type WebSearchStreamEvent = { type: "text"; text: string } | { type: "search_result"; hits: readonly WebSearchOutputHit[] } | { type: "search_error"; code: string };

/** claude's own structured shape (research file, verbatim, `tool_use_id` dropped -- see the module header). */
export type WebSearchResultItem = string | { content: readonly WebSearchOutputHit[] };

/**
 * Stage 1: the stream walk. Text concatenates (raw block-delta accumulation, no separator -- the
 * research file's "text blocks accumulate"); a search boundary flushes the trimmed buffer as a STRING
 * item WHEN IT IS NON-EMPTY (see the module header), then pushes the search's own item (a links item
 * for a result, a string for an error); the buffer flushes once more at the end for any trailing
 * commentary, under the identical non-empty rule.
 */
export function flushWebSearchStream(events: readonly WebSearchStreamEvent[]): WebSearchResultItem[] {
  const items: WebSearchResultItem[] = [];
  let buffer = "";
  const flush = (): void => {
    const text = buffer.trim();
    if (text.length > 0) items.push(text);
    buffer = "";
  };
  for (const event of events) {
    if (event.type === "text") {
      buffer += event.text;
      continue;
    }
    flush();
    items.push(event.type === "search_result" ? { content: event.hits.map((h) => ({ title: h.title, url: h.url })) } : `Web search error: ${event.code}`);
  }
  flush();
  return items;
}

const REMINDER = "REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.";

/**
 * Stage 2: the render. Verbatim from the research file: header + `"\n\n"`; each item + `"\n\n"`
 * (a string item as-is; a links item as `Links: ` + COMPACT `JSON.stringify` of `[{title,url}]`, or
 * `No links found.` when its `content` is empty); then `"\n"` + the reminder; the WHOLE string
 * `.trim()`ed once at the end (which is what removes the header's own leading blank-line pair when
 * there happen to be zero items, and any trailing blank line before the reminder).
 */
export function renderWebSearchToolResult(query: string, items: readonly WebSearchResultItem[]): string {
  const header = `Web search results for query: "${query}"`;
  const body = items.map((item) => (typeof item === "string" ? item : item.content.length > 0 ? `Links: ${JSON.stringify(item.content)}` : "No links found.")).reduce((acc, rendered) => acc + rendered + "\n\n", "");
  return (header + "\n\n" + body + "\n" + REMINDER).trim();
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
 * with zero items left the render is just `header + "\n\n" + REMINDER`, which is the floor this
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
