// "Search" -- Exa's ANSWER mode as a built-in: one call, a written answer with the pages it was grounded
// in. A Winter tool with no claude counterpart, for a session whose model has no page-reading surface to
// chase `WebSearch`'s links with (a chat). Ported from the Winter daemon's own `Search` (served by its
// `research` capability server, retired once this shipped), behaviour for behaviour -- see
// `impl/search.ts` for the request, the rendering and the error vocabulary.
//
// OPT-IN, and KEYED -- two gates, both needed:
//   * `availability.optIn`: advertised only when the host's `tools` list names it (claude's own pattern
//     for a non-default tool). No default session gains a tool claude does not have.
//   * `winter.search-answer`: the engine derives this token only when the session can actually call
//     `/answer` -- the search backend is not switched off and a key is NAMED (`web.search.authRef`) and
//     resolvable through the session's tool-secret resolver. `/answer` has no anonymous tier, so a
//     session without a key is never offered a tool whose every call would fail; such a host offers
//     `WebSearch` (which does have one) instead.
import { stub } from "./_shared.ts";
import type { ToolDescriptor } from "../registry.ts";

export const SEARCH_CANONICAL_NAME = "Search";
export const SEARCH_ANSWER_CAPABILITY = "winter.search-answer";

/** The Winter daemon's own description, verbatim (it is the interface the models were shown). */
export const SEARCH_DESCRIPTION =
  "Search the web and get back a written answer with its sources, in a single call. Ask a real question, not keywords — a search engine answers it and the answer comes back already synthesized, followed by the pages it came from. Use it freely whenever a fact might be newer than you are, or when the user asks about something current, and cite the URLs you used.";

const descriptor: ToolDescriptor = {
  canonicalName: SEARCH_CANONICAL_NAME,
  advertisedName: SEARCH_CANONICAL_NAME,
  source: "builtin",
  // ONE field, and that is the schema: `/answer` returns an answer, not a page of rows, and how many
  // sources it consulted is the backend's judgement, not a caller's dial. Exa's other request fields
  // (`model`, `systemPrompt`, `outputSchema`, `stream`, `text`) are deliberately not exposed -- each is a
  // knob whose wrong setting the model could not diagnose, and `text: true` would return every cited
  // page's full body, which this tool does not render and would only pay for.
  inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, description: "The question to answer" } }, required: ["query"] },
  description: SEARCH_DESCRIPTION,
  searchHint: "answer a question from the web with sources",
  annotations: { readOnlyHint: true, openWorldHint: true },
  exposure: "eager",
  permissionClass: "network",
  availability: { optIn: true },
  capabilityRequirements: [SEARCH_ANSWER_CAPABILITY],
  disposition: "implement-now",
};

stub(descriptor);
