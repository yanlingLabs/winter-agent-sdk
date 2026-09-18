// WHICH CATALOG PROVIDERS ARE ANTHROPIC'S OWN API -- one answer, because several unrelated behaviours
// turn on it and they must never disagree about the same session:
//
//   - the lean-prompt rule (the Agent tool's listing line, both web tools' descriptions);
//   - the provider-conditional web tool SCHEMAS (claude's own dialect bytes vs the portable shape);
//   - the Explore model cap (claude's `_Ut`);
//   - `AccountInfo.apiProvider: "firstParty"` (`session-provider.ts`, whose map is pinned against this
//     set by its own test).
//
// TWO ROWS, NOT ONE (whole-branch review MINOR 3). The catalog carries `anthropic` (an API key) AND
// `console` (the Anthropic Console profile) -- both `api.anthropic.com`, both the same models, and a
// Console-login session is exactly as first-party as a key one. Reading `providerId === "anthropic"`
// alone silently gave every `console/*` session the FULL texts and the portable schemas.
//
// AND NOT THE WHOLE `family: "anthropic"` COLUMN, which is a DIALECT statement, not an identity one:
// `agentrouter`, `deepseek-anthropic`, `kimi-coding`, `minimax-anthropic`, `tabitoken`, `wafer` and
// `zai-anthropic` all speak `anthropic-messages` at their own endpoints and are third parties. So the
// membership is an explicit, reviewed list -- extended only when a row really is Anthropic's own API.

/** The catalog provider ids that ARE Anthropic's own API. `cc` (claude.ai subscription auth) is deliberately absent: it does not ship. */
export const FIRST_PARTY_ANTHROPIC_PROVIDER_IDS: ReadonlySet<string> = new Set(["anthropic", "console"]);

/** Is this session on Anthropic's own API? `undefined` (no catalog identity at all -- the reserved test namespace, a refused session) is never first-party. */
export function isFirstPartyAnthropic(providerId: string | undefined): boolean {
  return providerId !== undefined && FIRST_PARTY_ANTHROPIC_PROVIDER_IDS.has(providerId);
}
