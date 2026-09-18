import { describe, expect, test } from "bun:test";
import { hostMatchesDomain, isDomainBlocked, matchingDomain, mergeDomainLists, normalizeDomain } from "./_domains.ts";

describe("the shared blockedDomains matcher", () => {
  test("normalises what people actually write in a block-list", () => {
    expect(normalizeDomain("  Example.COM. ")).toBe("example.com");
    expect(normalizeDomain("*.ads.example.com")).toBe("ads.example.com");
    expect(normalizeDomain(".example.com")).toBe("example.com");
    expect(normalizeDomain("https://user:pw@Ads.Example.com:8443/track?x=1#f")).toBe("ads.example.com");
    expect(normalizeDomain("example.com/path")).toBe("example.com");
    expect(normalizeDomain("   ")).toBeUndefined();
    expect(normalizeDomain("*.")).toBeUndefined();
  });

  test("SUFFIX ON A LABEL BOUNDARY: a listed domain blocks itself and its subdomains, and nothing that merely ends with the same letters", () => {
    expect(hostMatchesDomain("example.com", "example.com")).toBe(true);
    expect(hostMatchesDomain("docs.example.com", "example.com")).toBe(true);
    expect(hostMatchesDomain("a.b.example.com.", "EXAMPLE.com")).toBe(true);
    expect(hostMatchesDomain("notexample.com", "example.com")).toBe(false);
    expect(hostMatchesDomain("example.com.evil.test", "example.com")).toBe(false);
    // A subdomain entry does not block its parent.
    expect(hostMatchesDomain("example.com", "docs.example.com")).toBe(false);
  });

  test("matches a URL by its host, and says WHICH entry matched", () => {
    const floor = ["blocked.example", "ads.example.net"];
    expect(isDomainBlocked("https://sub.blocked.example/page?q=1", floor)).toBe(true);
    expect(matchingDomain("https://x.ads.example.net/", floor)).toBe("ads.example.net");
    expect(isDomainBlocked("https://fine.example/?next=blocked.example", floor)).toBe(false);
    expect(isDomainBlocked("sub.blocked.example", floor)).toBe(true);
    expect(isDomainBlocked("https://fine.example", [])).toBe(false);
  });

  test("merges lists normalised, de-duplicated, in first-seen order", () => {
    expect(mergeDomainLists(["Blocked.Example", "*.ads.example.net"], undefined, ["blocked.example.", "  ", "third.example"])).toEqual(["blocked.example", "ads.example.net", "third.example"]);
  });
});
