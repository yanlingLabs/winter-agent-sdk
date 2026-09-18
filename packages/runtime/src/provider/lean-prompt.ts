// The model-id half of claude's lean-prompt rule, kept pure so it can be pinned on its own: given a
// model on Anthropic's own API, does it take the FULL interface texts or the LEAN ones? The
// first-party half (which provider the session is on) is the engine's, where the live identity is.
//
// claude's own selector, from the pinned binary (`o` is the normalized model id):
//   o.includes("claude-3-") || o.includes("haiku") || o.includes("sonnet")
//   || o==="claude-opus-4-0" || o==="claude-opus-4-1" || o==="claude-opus-4-5"
//   || o==="claude-opus-4-6" || o==="claude-opus-4-7"            -> FULL
//   anything else first-party (Opus 4.8, Opus 5, the tier above Opus, an unknown id) -> LEAN

/** The five Opus builds claude names one by one. Everything newer on the Opus line is lean. */
const FULL_PROMPT_OPUS_MINORS = new Set(["0", "1", "5", "6", "7"]);

/**
 * `modelKey` is a provider-qualified key (`anthropic/claude-opus-5`) or a bare id. claude compares a
 * NORMALIZED id, so the Opus match tolerates the two spellings a catalog row really uses for the same
 * build: a trailing `-YYYYMMDD` snapshot date, and a dotted minor (`claude-opus-4.1`). The original
 * Opus 4 has no minor in its dated id (`claude-opus-4-20250514`); it is `claude-opus-4-0`.
 */
export function claudeModelTakesFullPrompt(modelKey: string): boolean {
  const id = modelKey.slice(modelKey.lastIndexOf("/") + 1).toLowerCase();
  if (id.includes("claude-3-") || id.includes("haiku") || id.includes("sonnet")) return true;
  const opus = /^claude-opus-4(?:[-.](\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (opus === null) return false;
  return FULL_PROMPT_OPUS_MINORS.has(opus[1] ?? "0");
}
