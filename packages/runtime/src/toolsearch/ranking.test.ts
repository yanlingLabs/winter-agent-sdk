// WS-09 §8.3: the ONLY pinned ranking behaviors this file may assert are "search-considers-
// names/descriptions" (extended here to searchHint, per [WS-06] §1.1's own field this scorer reads)
// and that `max_results` caps the returned count -- never an exact ranking ORDER (§12 Q3's own
// proposed tolerance). Every multi-match assertion below therefore uses `toContain`/`toHaveLength`,
// never `toEqual` on a specific order.
import { describe, test, expect } from "bun:test";
import { rankCandidates, type RankableCandidate } from "./ranking.ts";

const CANDIDATES: RankableCandidate[] = [
  { name: "mcp__github__list_issues", description: "Lists open issues on a GitHub repository", searchHint: "bug tracker" },
  { name: "mcp__slack__post_message", description: "Posts a message to a Slack channel" },
  { name: "mcp__weather__forecast", description: "Fetches a multi-day weather forecast", searchHint: "climate meteorology" },
];

describe("rankCandidates (WS-09 §8.3, replaceable ranking)", () => {
  test("a name token finds its own candidate", () => {
    expect(rankCandidates("github", CANDIDATES, 5)).toContain("mcp__github__list_issues");
  });

  test("a description token finds its own candidate", () => {
    expect(rankCandidates("channel", CANDIDATES, 5)).toContain("mcp__slack__post_message");
  });

  test("a searchHint token finds its own candidate even when absent from name/description", () => {
    expect(rankCandidates("meteorology", CANDIDATES, 5)).toContain("mcp__weather__forecast");
  });

  test("a multi-word query matching several candidates returns all of them (order unasserted)", () => {
    const results = rankCandidates("message issues", CANDIDATES, 5);
    expect(results).toContain("mcp__github__list_issues");
    expect(results).toContain("mcp__slack__post_message");
  });

  test("max_results caps the returned count even when more candidates match", () => {
    const results = rankCandidates("mcp", CANDIDATES, 2);
    expect(results).toHaveLength(2);
  });

  test("a query with no matching tokens returns no candidates", () => {
    expect(rankCandidates("nonexistent_zzz_query", CANDIDATES, 5)).toEqual([]);
  });

  test("an empty/punctuation-only query matches nothing (never an arbitrary tie-break dump)", () => {
    expect(rankCandidates("   ...  ", CANDIDATES, 5)).toEqual([]);
  });

  test("case-insensitive: an upper-case query still finds a lower-case name token", () => {
    expect(rankCandidates("GITHUB", CANDIDATES, 5)).toContain("mcp__github__list_issues");
  });
});
