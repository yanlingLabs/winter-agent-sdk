// "WebFetch" -- the REAL descriptor (T1's own header called this "captured, verbatim schema... T1
// registers the descriptor only"; this file is that later registration). Interface strings below are
// COPIED VERBATIM from the pinned claude 2.1.250 binary per the project owner's ruling (memory:
// verbatim-claude-strings-allowed) -- only this comment block and the identifiers are Winter's own.
//
// TWO DESCRIPTION VARIANTS, ONE STATIC REGISTRATION. claude selects lean vs. full per `leanPrompt
// (model)`; this SDK's own equivalent lives in `engine.ts` (`sessionLeanModel`, used today only for
// the Agent tool's `whenToUseLean`) and is wired into the actual PROVIDER REQUEST by `toolSpecFor`
// (engine.ts ~6079), which today special-cases exactly one canonical name (`AGENT_TOOL_CANONICAL_NAME`)
// and has no general per-descriptor hook. Per this lane's own brief ("Do NOT edit the spine's
// files... make the smallest possible one, and call it out loudly"), wiring `toolSpecFor` for a
// SECOND tool is left to the lane that owns that file (plan: Phase A4, "both description variants
// behind Winter's lean-prompt rule") -- this module ships everything that lane needs and nothing it
// would have to redo: both verbatim texts, and the one pure selector function that applies the exact
// same rule engine.ts's own `sessionLeanModel` does. The STATIC registration below (what every
// session sees until that wiring lands) carries the FULL text -- `sessionLeanModel`'s own doc names
// it "the fuller, safer text... when the tier can't be determined," which is exactly this situation
// today: no consumer yet asks which tier a session is on.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";
// `_web-fetch-cache.ts` REGISTERS NOTHING (an underscore module, per this lane's own impl-isolation
// convention), so importing its constant here carries no registration side effect -- the reverse
// direction (the cache module importing FROM this descriptor) would, since this file's own
// `stub(...)` call below runs at module load and every underscore module must stay import-safe for
// anything, including a future `tools/impl-isolation.test.ts` entry, to pull in with zero side effects.
import { WEB_FETCH_CACHE_TTL_MS } from "../impl/_web-fetch-cache.ts";

/** `${r()}` in claude's own template -- rendered from the real constant, never a second "15 minutes" literal. */
function cacheTtlLabel(): string {
  const minutes = WEB_FETCH_CACHE_TTL_MS / 60_000;
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export const WEB_FETCH_DESCRIPTION_LEAN = `Fetches a URL, converts the page to markdown, and answers \`prompt\` against it using a small fast model.

- Fails on authenticated/private URLs -- use an authenticated MCP tool or \`gh\` for those instead.
- HTTP is upgraded to HTTPS. Cross-host redirects are returned to you rather than followed; call again with the redirect URL.
- Responses are cached for ${cacheTtlLabel()} per URL.`;

export const WEB_FETCH_DESCRIPTION_FULL = `IMPORTANT: WebFetch WILL FAIL for authenticated or private URLs. Before using this tool, check if the URL points to an authenticated service (e.g. Google Docs, Confluence, Jira, GitHub). If so, look for a specialized MCP tool that provides authenticated access.

- Fetches content from a specified URL and processes it using an AI model
- Takes a URL and a prompt as input
- Fetches the URL content, converts HTML to markdown
- Processes the content with the prompt using a small, fast model
- Returns the model's response about the content
- Use this tool when you need to retrieve and analyze web content

Usage notes:
  - IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions.
  - The URL must be a fully-formed valid URL
  - HTTP URLs will be automatically upgraded to HTTPS
  - The prompt should describe what information you want to extract from the page
  - This tool is read-only and does not modify any files
  - Results may be summarized if the content is very large
  - Includes a self-cleaning cache (entries expire after ${cacheTtlLabel()}) for faster responses when repeatedly accessing the same URL
  - When a URL redirects to a different host, the tool will inform you and provide the redirect URL in a special format. You should then make a new WebFetch request with the redirect URL to fetch the content.
  - For GitHub URLs, prefer using the gh CLI via Bash instead (e.g., gh pr view, gh issue view, gh api).`;

/** claude's own `leanPrompt(model)` gate, applied to WebFetch's description exactly as `sessionLeanModel` applies it to the Agent tool's `whenToUseLean` -- see the module header for the wiring gap this leaves for A4. */
export function webFetchDescriptionFor(leanModel: boolean): string {
  return leanModel ? WEB_FETCH_DESCRIPTION_LEAN : WEB_FETCH_DESCRIPTION_FULL;
}

stub({
  canonicalName: "WebFetch",
  advertisedName: "WebFetch",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch content from" },
      prompt: { type: "string", description: "The prompt to run on the fetched content" },
    },
    required: ["url", "prompt"],
  },
  description: WEB_FETCH_DESCRIPTION_FULL,
  searchHint: "fetch and extract content from a URL",
  exposure: "eager",
  permissionClass: "network",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: ["winter.fetch-extractor"],
  disposition: "implement-now",
});
