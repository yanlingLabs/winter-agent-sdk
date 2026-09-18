// "WebFetch" -- the REAL descriptor (T1's own header called this "captured, verbatim schema... T1
// registers the descriptor only"; this file is that later registration). Interface strings below are
// COPIED VERBATIM from the pinned claude 2.1.250 binary per the project owner's ruling -- only this
// comment block and the identifiers are Winter's own.
//
// TWO DESCRIPTION VARIANTS, ONE STATIC REGISTRATION. claude selects lean vs. full per
// `leanPrompt(model)`; this SDK's equivalent is `engine.ts`'s `sessionLeanModel`, and the choice is
// made per REQUEST in `toolSpecFor` (a descriptor is a process-wide singleton and cannot see a
// session's model). This module ships both verbatim texts and the pure selector; the static
// registration below carries the FULL text, which is also what any reader outside a session sees.
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

/** The name `engine.ts`'s `toolSpecFor` branches on for the lean/full choice, mirroring `WEB_SEARCH_CANONICAL_NAME` -- so no tool name is a literal there. */
export const WEB_FETCH_CANONICAL_NAME = "WebFetch";

export const WEB_FETCH_DESCRIPTION_LEAN = `Fetches a URL, converts the page to markdown, and answers \`prompt\` against it using a small fast model.

- Fails on authenticated/private URLs — use an authenticated MCP tool or \`gh\` for those instead.
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
  - For GitHub URLs, prefer using the gh CLI via Bash instead (e.g., gh pr view, gh issue view, gh api).
`;

/** claude's own `leanPrompt(model)` gate, applied to WebFetch's description exactly as `sessionLeanModel` applies it to the Agent tool's `whenToUseLean`. */
export function webFetchDescriptionFor(leanModel: boolean): string {
  return leanModel ? WEB_FETCH_DESCRIPTION_LEAN : WEB_FETCH_DESCRIPTION_FULL;
}

// --- The input schema: one shape, two renderings ----------------------------------------------------
//
// claude's own schema for this tool carries three keywords the rest of this catalog deliberately does
// not: the `$schema` dialect marker, `additionalProperties: false`, and `format: "uri"` on `url`.
//
// They are rendered ONLY for a session talking to Anthropic's own API (`webFetchInputSchemaFor(true)`,
// chosen per request in engine.ts's `toolSpecFor`, beside the lean/full description choice), where the
// advertised schema is byte-for-byte what claude itself sends. Every other provider keeps the
// PORTABLE rendering registered below. Two reasons, both about this runtime rather than claude:
//   - an eager tool's schema rides EVERY request to EVERY provider, and the adapters forward it
//     untouched; several function-calling dialects are an OpenAPI-style SUBSET that refuses keywords
//     it does not know (`$schema` above all). A parity gain on one provider must not become a refused
//     request on another.
//   - nothing in this runtime validates a call against a descriptor's schema (see cron-list.ts's own
//     note: `additionalProperties: false` was dropped catalog-wide as decorative for exactly that
//     reason). The keywords are therefore ADVERTISEMENT, not enforcement -- worth carrying where they
//     are claude's own wire bytes, and nowhere else.
const URL_DESCRIPTION = "The URL to fetch content from";
const PROMPT_PROPERTY = { type: "string", description: "The prompt to run on the fetched content" } as const;

const WEB_FETCH_INPUT_SCHEMA_PORTABLE = {
  type: "object",
  properties: { url: { type: "string", description: URL_DESCRIPTION }, prompt: PROMPT_PROPERTY },
  required: ["url", "prompt"],
} as const;

const WEB_FETCH_INPUT_SCHEMA_FIRST_PARTY = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { url: { type: "string", format: "uri", description: URL_DESCRIPTION }, prompt: PROMPT_PROPERTY },
  required: ["url", "prompt"],
  additionalProperties: false,
} as const;

/** The schema to ADVERTISE: claude's own bytes for a first-party Anthropic session, the portable rendering for every other provider (see the block comment above). */
export function webFetchInputSchemaFor(firstPartyAnthropic: boolean): Record<string, unknown> {
  return firstPartyAnthropic ? WEB_FETCH_INPUT_SCHEMA_FIRST_PARTY : WEB_FETCH_INPUT_SCHEMA_PORTABLE;
}

stub({
  canonicalName: "WebFetch",
  advertisedName: "WebFetch",
  source: "builtin",
  inputSchema: WEB_FETCH_INPUT_SCHEMA_PORTABLE,
  description: WEB_FETCH_DESCRIPTION_FULL,
  searchHint: "fetch and extract content from a URL",
  exposure: "eager",
  permissionClass: "network",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: ["winter.fetch-extractor"],
  disposition: "implement-now",
});
