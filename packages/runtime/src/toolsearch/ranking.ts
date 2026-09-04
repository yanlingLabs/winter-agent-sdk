// Phase 4 Task 5 (LANE B, WS-09 §8.3): the ToolSearch keyword-ranking scorer.
//
// WS-09 §8.3 is explicit that the REAL 2.1.251 keyword pipeline (exact-name -> MCP-prefix -> token
// scoring with `+term` mandatory prefilters and specific per-term weights) is "version-specific
// private implementation behavior, not a stable contract" -- Winter therefore MUST NOT try to clone
// it, and MAY ship its own scorer entirely, with exactly one quality obligation: "richer
// names/descriptions improving discovery." The only pinned behaviors (§8.3's own bullet list) are
// `select:` semantics (search.ts's job, not this file's), the result shape (search.ts), the 5s
// pending-server wait (search.ts), and "search-considers-names/descriptions" -- this file's tests
// assert exactly that last one (a candidate is discoverable via its own name/description/searchHint
// tokens), never an exact ranking ORDER, per §12 Q3's own proposed tolerance ("no assertion beyond
// requested tool discoverable via its own name/description tokens").
//
// Deliberately NOT reimplementing the inspected private pipeline's `+term` prefilters or per-term
// weight table -- those are exactly the "version-specific... not a stable contract" internals §8.3
// disclaims. This scorer is intentionally simple and REPLACEABLE (§8.3's own word): a future task may
// swap it for an embedding/reranker-backed implementation without touching search.ts's own contract
// (RankableCandidate/rankCandidates is the whole surface search.ts depends on).
export interface RankableCandidate {
  // The value returned in ToolSearch's own `matches[]` -- search.ts passes the tool's canonical name
  // here (LoadedToolSet/emitToolReference/getRegisteredTool are all canonical-name-keyed; see
  // search.ts's own header for why advertisedName is not a distinct concern in this codebase today).
  name: string;
  description: string;
  // ToolDescriptor.searchHint ([WS-06] §1.1, WS-09 §8.3's own "MUST populate searchHint" obligation)
  // -- a data-only discovery aid a descriptor may set to describe itself in terms a keyword query is
  // more likely to use than its own literal name/description. Absent for the overwhelming majority
  // of today's descriptors (none set it yet); treated as "" when missing, never a scoring error.
  searchHint?: string;
}

// Lowercase + split on any run of non-alphanumeric characters -- deliberately crude (no stemming, no
// stopword removal): good enough to tokenize both ordinary English descriptions AND
// `mcp__<server>__<tool>`-shaped canonical names into their meaningful parts ("mcp", "github",
// "list", "issues", ...), which is exactly what makes a namespaced MCP tool name discoverable by its
// server or bare-tool-name tokens without any MCP-specific parsing.
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

// Per-candidate score for one already-tokenized query. Deliberately simple, ordinal-only (never
// compared against a pinned threshold or exact value in any test) -- see this file's own header for
// why exact weights are not a contract. Name/searchHint matches outweigh description matches (a
// query that names the tool, or hits its own discovery hint, is a stronger signal than an incidental
// word in prose); a whole-string substring match on the name is a secondary, lower-weight signal so a
// partial-word query (e.g. "git" against "mcp__github__list_issues") still finds something even when
// it does not land on a whole token.
function scoreOne(queryTokens: readonly string[], candidate: RankableCandidate): number {
  const nameTokens = new Set(tokenize(candidate.name));
  const descriptionTokens = new Set(tokenize(candidate.description));
  const hintTokens = new Set(tokenize(candidate.searchHint ?? ""));
  const nameLower = candidate.name.toLowerCase();

  let score = 0;
  for (const token of queryTokens) {
    if (nameTokens.has(token)) score += 5;
    else if (nameLower.includes(token)) score += 3;
    if (hintTokens.has(token)) score += 3;
    if (descriptionTokens.has(token)) score += 1;
  }
  return score;
}

// WS-09 §8.2: keyword search over the candidate pool (search.ts hands this the CURRENT deferred set,
// never the full registry -- see exposure.ts). Returns canonical names only, most relevant first,
// capped at `maxResults` -- unlike `select:`, keyword results ARE truncated (§8.2: "direct selection
// is NOT truncated to max_results", implying ordinary keyword search is). A query with no recognized
// tokens (empty/punctuation-only) matches nothing, rather than degenerating into "score 0 ties, return
// arbitrary candidates" -- an empty result is the honest answer to an empty query.
export function rankCandidates(query: string, candidates: readonly RankableCandidate[], maxResults: number): string[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  return candidates
    .map((c) => ({ name: c.name, score: scoreOne(queryTokens, c) }))
    .filter((c) => c.score > 0)
    // Array.prototype.sort is stable (ES2019+, part of this project's ES2022 target) -- candidates
    // tied on score keep their original relative order rather than an engine-dependent shuffle.
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, maxResults))
    .map((c) => c.name);
}
