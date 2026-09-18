import { describe, expect, test } from "bun:test";
import { WEB_FETCH_DESCRIPTION_FULL, WEB_FETCH_DESCRIPTION_LEAN, webFetchDescriptionFor } from "./web-fetch.ts";

describe("WebFetch description variants", () => {
  test("the lean text renders the cache TTL and names the redirect/auth behaviour", () => {
    expect(WEB_FETCH_DESCRIPTION_LEAN).toContain("15 minutes");
    expect(WEB_FETCH_DESCRIPTION_LEAN).toContain("Fetches a URL, converts the page to markdown");
    expect(WEB_FETCH_DESCRIPTION_LEAN).toContain("Cross-host redirects are returned to you rather than followed");
  });

  test("the full text carries the IMPORTANT preamble and the usage-notes block", () => {
    expect(WEB_FETCH_DESCRIPTION_FULL).toStartWith("IMPORTANT: WebFetch WILL FAIL for authenticated or private URLs.");
    expect(WEB_FETCH_DESCRIPTION_FULL).toContain("Usage notes:");
    expect(WEB_FETCH_DESCRIPTION_FULL).toContain("entries expire after 15 minutes");
    expect(WEB_FETCH_DESCRIPTION_FULL).toContain("gh pr view, gh issue view, gh api");
  });

  test("webFetchDescriptionFor selects by the leanModel flag", () => {
    expect(webFetchDescriptionFor(true)).toBe(WEB_FETCH_DESCRIPTION_LEAN);
    expect(webFetchDescriptionFor(false)).toBe(WEB_FETCH_DESCRIPTION_FULL);
  });
});
