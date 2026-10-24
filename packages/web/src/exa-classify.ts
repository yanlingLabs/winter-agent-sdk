// How an Exa backend's own words read, when a transport has no status to go by.

export type ExaErrorKind = "rate-limited" | "auth" | "timeout" | "other";

// WORDS ARE THE FALLBACK, and deliberately narrow: opening the breaker locks a keyless caller out for
// the whole cooldown, so a loose match is expensive. No bare `429` / `quota` (either can sit inside
// an echoed query), only phrases a server uses ABOUT ITSELF. A status, when a transport has one, is
// read first and decides on its own.
export const EXA_RATE_LIMIT_PATTERN = /rate.?limit(?:ed| exceeded| reached)?\b|too many requests|quota (?:exceeded|exhausted|reached)|credits? (?:exhausted|exceeded)|free tier/i;
export const EXA_AUTH_PATTERN = /unauthori[sz]ed|forbidden|invalid api.?key|api.?key (?:is )?(?:invalid|required|missing)/i;
export const EXA_UNREACHABLE_PATTERN = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|unable to connect|network/i;

/** The words-only reading of an error text: rate-limited, auth, timeout or other. */
export function classifyExaErrorText(text: string): ExaErrorKind {
  if (EXA_RATE_LIMIT_PATTERN.test(text)) return "rate-limited";
  if (EXA_AUTH_PATTERN.test(text)) return "auth";
  if (/timed? ?out|timeout/i.test(text)) return "timeout";
  return "other";
}
