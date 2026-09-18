import { describe, expect, test } from "bun:test";
import { backendExcludableDomains, hostMatchesDomain, isDomainBlocked, matchingDomain, mergeDomainLists, normalizeDomain } from "./_domains.ts";

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

  // --- the floor must not be walked around ----------------------------------------------------------
  test("a URL is parsed the way the FETCHER will parse it: every spelling `new URL()` resolves to a blocked host is blocked", () => {
    const floor = ["blocked.example"];
    for (const spelling of ["http:/blocked.example/p", "http:blocked.example/p", "https:\\\\blocked.example/p", "HTTPS://BLOCKED.example:8443/p", "https://user:pw@sub.blocked.example/", "blocked.example/p", "//blocked.example/p"]) {
      expect([spelling, isDomainBlocked(spelling, floor)]).toEqual([spelling, true]);
    }
    // A scheme-looking prefix with no host of its own (`host:port`) is still matched as a host.
    expect(isDomainBlocked("blocked.example:8080", floor)).toBe(true);
    expect(isDomainBlocked("fine.example:8080", floor)).toBe(false);
  });

  test("IDN: a unicode entry matches a punycode host and the reverse -- both sides are normalised through the URL parser", () => {
    expect(normalizeDomain("Bücher.example")).toBe("xn--bcher-kva.example");
    expect(isDomainBlocked("https://xn--bcher-kva.example/x", ["bücher.example"])).toBe(true);
    expect(isDomainBlocked("https://www.bücher.example/x", ["xn--bcher-kva.example"])).toBe(true);
    expect(isDomainBlocked("bücher.example", ["xn--bcher-kva.example"])).toBe(true);
  });

  test("IP LITERALS MATCH EXACTLY, never by suffix -- and in their canonical form", () => {
    // The suffix rule on an IP is nonsense with teeth: `0.1` must not block `127.0.0.1`.
    expect(isDomainBlocked("http://127.0.0.1/", ["0.1"])).toBe(false);
    expect(isDomainBlocked("http://127.0.0.1/", ["0.0.1"])).toBe(false);
    expect(isDomainBlocked("http://127.0.0.1:3000/admin", ["127.0.0.1"])).toBe(true);
    expect(isDomainBlocked("http://10.127.0.0.1.example/", ["127.0.0.1"])).toBe(false);
    // Every spelling of one address is that address.
    expect(isDomainBlocked("http://0x7f.1/", ["127.0.0.1"])).toBe(true);
    expect(isDomainBlocked("http://2130706433/", ["127.0.0.1"])).toBe(true);
    // IPv6: a bare entry and a bracketed one are the same entry.
    expect(normalizeDomain("::1")).toBe("[::1]");
    expect(isDomainBlocked("http://[::1]:8080/", ["::1"])).toBe(true);
    expect(isDomainBlocked("http://[::1]/", ["[::1]"])).toBe(true);
    expect(isDomainBlocked("http://[::2]/", ["::1"])).toBe(false);
  });

  test("a SINGLE-LABEL entry matches exactly and never as a suffix: `com` does not block every .com, `localhost` still blocks localhost", () => {
    expect(isDomainBlocked("https://example.com/", ["com"])).toBe(false);
    expect(isDomainBlocked("http://localhost:3000/", ["localhost"])).toBe(true);
    expect(isDomainBlocked("http://app.localhost/", ["localhost"])).toBe(false);
    expect(hostMatchesDomain("com", "com")).toBe(true);
  });
  test("IPv4-MAPPED IPv6 is the IPv4 address it carries: every spelling of `::ffff:a.b.c.d` normalises to the dotted quad", () => {
    // The URL parser rewrites the dotted tail to hex, so `127.0.0.1` and `[::ffff:7f00:1]` are two
    // strings for one loopback address -- and an exact-match rule makes that a way around the entry.
    expect(normalizeDomain("http://[::ffff:127.0.0.1]/")).toBe("127.0.0.1");
    expect(normalizeDomain("http://[::ffff:7f00:1]/")).toBe("127.0.0.1");
    expect(normalizeDomain("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeDomain("[0:0:0:0:0:FFFF:10.1.2.3]")).toBe("10.1.2.3");
    expect(normalizeDomain("::ffff:a9fe:a9fe")).toBe("169.254.169.254");
    expect(isDomainBlocked("http://[::ffff:127.0.0.1]:3000/admin", ["127.0.0.1"])).toBe(true);
    expect(isDomainBlocked("http://[::ffff:7f00:1]/", ["127.0.0.1"])).toBe(true);
    expect(isDomainBlocked("http://127.0.0.1/", ["::ffff:127.0.0.1"])).toBe(true);
    expect(isDomainBlocked("http://[::ffff:7f00:2]/", ["127.0.0.1"])).toBe(false);
    // Still an IP literal afterwards: exact only, never a suffix.
    expect(isDomainBlocked("http://[::ffff:127.0.0.1]/", ["0.1"])).toBe(false);
    // NOT the mapped block: a different prefix is a different address and keeps its IPv6 form.
    expect(normalizeDomain("http://[::fffe:7f00:1]/")).toBe("[::fffe:7f00:1]");
    expect(normalizeDomain("http://[64:ff9b::7f00:1]/")).toBe("[64:ff9b::7f00:1]");
  });

  test("an input that SAYS it is a URL (`://`) and does not parse names NO host -- it never falls through to the bare-host reading of its own scheme", () => {
    // Bare-host parsing of `http://[fe80::1%25eth0]/` is `http://http://[...` -> the host `http`.
    expect(normalizeDomain("http://[fe80::1%25eth0]/")).toBeUndefined();
    expect(normalizeDomain("https://exa mple.com/")).toBeUndefined();
    expect(normalizeDomain("http://[::1/")).toBeUndefined();
    expect(isDomainBlocked("http://[fe80::1%25eth0]/", ["http"])).toBe(false);
    expect(mergeDomainLists(["http://[fe80::1%25eth0]/", "ok.example"])).toEqual(["ok.example"]);
    // `host:port` ALSO looks like a scheme, has no `://`, and must keep falling through.
    expect(normalizeDomain("example.com:8080")).toBe("example.com");
    expect(normalizeDomain("localhost:3000/path")).toBe("localhost");
    expect(normalizeDomain("//example.com/path")).toBe("example.com");
  });

  test("what may be handed to a BACKEND's own exclude filter: multi-label names only -- an IP or a single label applies locally and is never forwarded", () => {
    // This module's rule for those two is EXACT match. A backend's rule for them is unknown: if it
    // reads `com` as a suffix, one typo'd entry silently removes every .com result.
    expect(backendExcludableDomains(["example.com", "com", "localhost", "127.0.0.1", "[::1]", "docs.example.org"])).toEqual(["example.com", "docs.example.org"]);
    expect(backendExcludableDomains(mergeDomainLists(["::ffff:10.0.0.1", "*.ads.example.com"]))).toEqual(["ads.example.com"]);
    expect(backendExcludableDomains([])).toEqual([]);
  });
});
