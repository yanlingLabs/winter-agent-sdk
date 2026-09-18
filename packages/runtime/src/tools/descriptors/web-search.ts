// WS-06 §3.2 "WebSearch" -- a faithful copy of claude's own descriptor, backed by Winter's own search
// backend instead of Anthropic's server-side one. Interface strings (both description variants,
// field docs) are claude's own, copied VERBATIM per the project's standing ruling that claude's
// interface text -- descriptions, field docs, result and error text -- ships as-is (only PROMPTS
// Winter authors itself stay Winter's own words). ONE line is deliberately NOT verbatim: see
// `US_ONLY_DEVIATION` below.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";
import type { ToolDescriptor } from "../registry.ts";

// --- The month, rendered exactly as claude's own template computes it -----------------------------

/** `new Date().toLocaleString("en-US",{month:"long",year:"numeric"})`, e.g. "September 2026" -- claude's own `${t}`. */
export function currentMonthYear(now: () => Date = () => new Date()): string {
  return now().toLocaleString("en-US", { month: "long", year: "numeric" });
}

// --- Both description variants, as TEMPLATES over the rendered month -------------------------------
//
// US_ONLY_DEVIATION: claude's text says "US-only" (lean) / "Web search is only available in the US"
// (full, under "Usage notes:"). That sentence describes ANTHROPIC's server-side search infrastructure
// -- it is FALSE for this tool, which searches through Exa's hosted backend with no US restriction of
// any kind. Per the task's own instruction this ONE line is dropped from BOTH variants; nothing else
// is reworded, reordered or rebranded -- including "Claude" itself, which ships verbatim per the
// project's interface-string ruling.

function leanWebSearchDescription(t: string): string {
  return `Search the web. Returns result blocks with titles and URLs.

- The current month is ${t} — use this when searching for recent information.
- \`allowed_domains\` / \`blocked_domains\` filter results.
- After answering from results, end with a "Sources:" list of the URLs you used as markdown links.`;
}

function fullWebSearchDescription(t: string): string {
  return `
- Allows Claude to search the web and use the results to inform responses
- Provides up-to-date information for current events and recent data
- Returns search result information formatted as search result blocks, including links as markdown hyperlinks
- Use this tool for accessing information beyond Claude's knowledge cutoff
- Searches are performed automatically within a single API call

CRITICAL REQUIREMENT - You MUST follow this:
  - After answering the user's question, you MUST include a "Sources:" section at the end of your response
  - In the Sources section, list all relevant URLs from the search results as markdown hyperlinks: [Title](URL)
  - This is MANDATORY - never skip including sources in your response
  - Example format:

    [Your answer here]

    Sources:
    - [Source Title 1](https://example.com/1)
    - [Source Title 2](https://example.com/2)

Usage notes:
  - Domain filtering is supported to include or block specific websites

IMPORTANT - Use the correct year in search queries:
  - The current month is ${t}. You MUST use this year when searching for recent information, documentation, or current events.
  - Example: If the user asks for "latest React docs", search for "React documentation" with the current year, NOT last year
`;
}

/**
 * Renders WebSearch's description AT THE CALL SITE -- so the month is always today's, whether the
 * caller is `toolSpecFor` at advertise time, a test, or a future spine hook (see the header on the
 * `Object.defineProperty` below for why that hook does not exist yet). `now` is injectable for tests.
 */
export function webSearchDescription(lean: boolean, now: () => Date = () => new Date()): string {
  const t = currentMonthYear(now);
  return lean ? leanWebSearchDescription(t) : fullWebSearchDescription(t);
}

// --- The descriptor -----------------------------------------------------------------------------

const descriptor: ToolDescriptor = {
  canonicalName: "WebSearch",
  advertisedName: "WebSearch",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 2, description: "The search query to use" },
      allowed_domains: { type: "array", items: { type: "string" }, description: "Only include search results from these domains" },
      blocked_domains: { type: "array", items: { type: "string" }, description: "Never include search results from these domains" },
    },
    required: ["query"],
  },
  // Placeholder -- overridden by the accessor installed below BEFORE registration. Present so the
  // object literal satisfies `ToolDescriptor`'s `description: string` field at the type level; the
  // registry never reads this literal value (the accessor always runs first).
  description: "",
  searchHint: "search the web for current information",
  annotations: { readOnlyHint: true, openWorldHint: true },
  exposure: "eager",
  permissionClass: "network",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: ["winter.search-backend"],
  disposition: "implement-now",
};

/**
 * THE DYNAMIC-DESCRIPTION MECHANISM, entirely within this file, no spine edit.
 *
 * `ToolDescriptor` is a PROCESS-WIDE singleton (`registry.ts`'s own header: "every engine run in one
 * process shares the identical set of tool DEFINITIONS") and `description` is typed as a plain
 * `string`. The generic (non-Agent) branch of `engine.ts`'s `toolSpecFor` reads it as a bare property
 * access -- `descriptor.description`, no arguments -- once per `providerToolSpecs()` build. A property
 * ACCESSOR is therefore the smallest correct way to make that read live: every future read re-runs
 * `currentMonthYear()`, so a daemon that stays up across a month boundary advertises the new month on
 * its very next generation, with zero engine.ts changes and zero caching to invalidate. `replaceExecutor`
 * (registry.ts) spreads the `RegisteredTool` wrapper, never the `descriptor` object inside it, so this
 * accessor survives `impl/web-search.ts` installing the real executor over this stub.
 *
 * WHAT THIS CANNOT DO, AND WHY (disclosed, not silently punted): claude's lean/full CHOICE depends on
 * which model the CURRENT SESSION is generating with (`engine.ts`'s own `sessionLeanModel`, a private
 * closure over `currentProviderIdentity`/`currentModel`). A descriptor accessor is invoked with NO
 * arguments and no session context -- there is no channel from "which session is asking" to "which
 * text to return" without either (a) an engine.ts change (the exact hook the Agent tool already uses:
 * `toolSpecFor`'s `canonicalName === AGENT_TOOL_CANONICAL_NAME` branch re-renders a descriptor clone
 * per call from session-derived gate state -- WebSearch would need the identical kind of branch,
 * keyed on `sessionLeanModel`), or (b) a global "which session is asking right now" side-channel,
 * which would be actively WRONG the moment two sessions run in one process concurrently. Neither is
 * available from a descriptor file alone, so this ships the FULL (non-lean) text as the static
 * default -- the SAME branch `sessionLeanModel` itself falls back to for every session that is not
 * Fable-tier-on-the-`anthropic`-provider (the overwhelming majority: every non-Claude-family model,
 * and haiku/sonnet/opus on Claude). `leanWebSearchDescription`/`webSearchDescription(true, ...)` are
 * exported so a future one-line `toolSpecFor` branch (mirroring the Agent tool's own) can select it
 * with no changes on this side. Named loudly in this lane's report as the one spine hook that would
 * complete real per-session parity.
 */
Object.defineProperty(descriptor, "description", {
  enumerable: true,
  configurable: true,
  get(): string {
    return webSearchDescription(false);
  },
});

stub(descriptor);
