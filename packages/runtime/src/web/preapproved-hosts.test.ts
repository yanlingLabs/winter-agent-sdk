import { describe, expect, test } from "bun:test";
import { PREAPPROVED_HOST_ENTRIES, isPreapprovedHost, isPreapprovedUrl, preapprovedScopeOf, staysWithinScope } from "./preapproved-hosts.ts";

describe("the extracted preapproved-host list", () => {
  test("measured: 92 literals, 91 distinct, 9 path-scoped", () => {
    expect(PREAPPROVED_HOST_ENTRIES.length).toBe(92);
    expect(new Set(PREAPPROVED_HOST_ENTRIES).size).toBe(91);
    expect(PREAPPROVED_HOST_ENTRIES.filter((e) => e.includes("/")).length).toBe(9);
  });

  test("the nine path-scoped entries, verbatim", () => {
    const pathScoped = PREAPPROVED_HOST_ENTRIES.filter((e) => e.includes("/")).sort();
    expect(pathScoped).toEqual(
      ["claude.com/docs", "github.com/anthropics", "go.dev/doc", "go.dev/ref", "wordpress.org/documentation", "huggingface.co/docs", "www.kaggle.com/docs", "vercel.com/docs", "dev.wix.com/docs"].sort(),
    );
  });

  test("learn.microsoft.com is the one duplicate", () => {
    expect(PREAPPROVED_HOST_ENTRIES.filter((e) => e === "learn.microsoft.com").length).toBe(2);
  });
});

describe("isPreapprovedHost / isPreapprovedUrl", () => {
  test("an exact hostname-only entry matches", () => {
    expect(isPreapprovedHost("developer.mozilla.org", "/en-US/docs/Web")).toBe(true);
    expect(isPreapprovedHost("react.dev", "/")).toBe(true);
  });

  test("no subdomain matching -- a subdomain of a hostname-only entry is NOT preapproved", () => {
    expect(isPreapprovedHost("sub.react.dev", "/")).toBe(false);
    expect(isPreapprovedHost("evil.developer.mozilla.org", "/")).toBe(false);
  });

  test("a path-scoped entry matches its exact prefix and children, not siblings", () => {
    expect(isPreapprovedHost("github.com", "/anthropics")).toBe(true);
    expect(isPreapprovedHost("github.com", "/anthropics/repo")).toBe(true);
    expect(isPreapprovedHost("github.com", "/anthropics-other")).toBe(false);
    expect(isPreapprovedHost("github.com", "/other-org")).toBe(false);
    expect(isPreapprovedHost("github.com", "/")).toBe(false);
  });

  test("an unlisted host is never preapproved", () => {
    expect(isPreapprovedHost("example.com", "/")).toBe(false);
  });

  test("an encoded traversal in the path is rejected even under a real prefix", () => {
    expect(isPreapprovedHost("github.com", "/anthropics%2f..%2fadmin")).toBe(false);
    expect(isPreapprovedHost("github.com", "/anthropics%2e%2e")).toBe(false);
    expect(isPreapprovedHost("github.com", "/anthropics%5c..")).toBe(false);
    expect(isPreapprovedHost("github.com", "/anthropics%252f..")).toBe(false); // doubly-encoded
  });

  test("isPreapprovedUrl reads hostname/pathname off a real URL", () => {
    expect(isPreapprovedUrl(new URL("https://docs.python.org/3/library/"))).toBe(true);
    expect(isPreapprovedUrl(new URL("https://vercel.com/docs/functions"))).toBe(true);
    expect(isPreapprovedUrl(new URL("https://vercel.com/pricing"))).toBe(false);
  });
});

describe("preapprovedScopeOf / staysWithinScope", () => {
  test("a hostname-only scope covers the whole host on redirect", () => {
    const scope = preapprovedScopeOf(new URL("https://bun.sh/docs"));
    expect(scope).toEqual({ host: "bun.sh" });
    expect(staysWithinScope(scope!, new URL("https://bun.sh/anything/else"))).toBe(true);
    expect(staysWithinScope(scope!, new URL("https://other.host/"))).toBe(false);
  });

  test("a path-scoped scope only covers its own prefix on redirect", () => {
    const scope = preapprovedScopeOf(new URL("https://github.com/anthropics/repo"));
    expect(scope).toEqual({ host: "github.com", pathPrefix: "/anthropics" });
    expect(staysWithinScope(scope!, new URL("https://github.com/anthropics/other-repo"))).toBe(true);
    expect(staysWithinScope(scope!, new URL("https://github.com/some-other-org"))).toBe(false);
  });

  test("no scope for an unlisted host", () => {
    expect(preapprovedScopeOf(new URL("https://example.com/"))).toBeUndefined();
  });

  test("a www-variant of the scope's own host still counts -- security review corrections §4.8, measured against the binary", () => {
    // claude.com/docs -> www.claude.com/docs/x IS followed by claude (the corrected fact); the
    // reviewer's own probe.
    const scope = preapprovedScopeOf(new URL("https://claude.com/docs"));
    expect(scope).toEqual({ host: "claude.com", pathPrefix: "/docs" });
    expect(staysWithinScope(scope!, new URL("https://www.claude.com/docs/x"))).toBe(true);
    // and the reverse direction: a scope matched on a www-prefixed host still covers the bare host.
    const wwwScope = preapprovedScopeOf(new URL("https://www.kaggle.com/docs/api"));
    expect(wwwScope).toEqual({ host: "www.kaggle.com", pathPrefix: "/docs" });
    expect(staysWithinScope(wwwScope!, new URL("https://kaggle.com/docs/other"))).toBe(true);
    // an unrelated host is still refused.
    expect(staysWithinScope(scope!, new URL("https://evil.example/docs"))).toBe(false);
  });
});
