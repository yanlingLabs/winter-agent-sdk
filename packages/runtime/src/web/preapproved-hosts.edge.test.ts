// Edge cases of the preapproved-host matchers: exact raw-string host matching, the path-prefix rule,
// the encoded-traversal guard, the www handling of the scope functions, and which host a scope names.
import { describe, expect, test } from "bun:test";
import { isPreapprovedHost, isPreapprovedUrl, preapprovedScopeOf, staysWithinScope } from "./preapproved-hosts.ts";

describe("isPreapprovedHost: raw strings, no normalisation", () => {
  test("the hostname is compared exactly: no www stripping or adding, case-sensitive, a trailing dot is a different host", () => {
    expect(isPreapprovedHost("www.react.dev", "/")).toBe(false);
    expect(isPreapprovedHost("React.dev", "/")).toBe(false);
    expect(isPreapprovedHost("php.net", "/")).toBe(false); // only `www.php.net` is listed
    expect(isPreapprovedHost("www.php.net", "/")).toBe(true);
    expect(isPreapprovedHost("react.dev.", "/")).toBe(false);
  });

  test("a hostname-only entry ignores the path entirely, encoded traversal included", () => {
    expect(isPreapprovedHost("react.dev", "/a%2f..")).toBe(true);
    expect(isPreapprovedHost("react.dev", "")).toBe(true);
    expect(isPreapprovedHost("react.dev", "anything at all")).toBe(true);
  });

  test("a path-scoped entry: the prefix itself, or the prefix followed by `/` and anything", () => {
    expect(isPreapprovedHost("github.com", "/anthropics/")).toBe(true);
    expect(isPreapprovedHost("github.com", "/Anthropics")).toBe(false); // the path is case-sensitive
    expect(isPreapprovedHost("github.com", "")).toBe(false);
    expect(isPreapprovedHost("github.com", "anthropics")).toBe(false);
    expect(isPreapprovedHost("go.dev", "/doc/x")).toBe(true);
    expect(isPreapprovedHost("go.dev", "/ref")).toBe(true);
    expect(isPreapprovedHost("go.dev", "/docs")).toBe(false);
    expect(isPreapprovedHost("claude.com", "/docsx")).toBe(false);
  });

  test("the traversal guard: `%` then any number of `25`, then `2f`/`5c`/`2e`, any letter case", () => {
    expect(isPreapprovedHost("github.com", "/anthropics/%2F")).toBe(false);
    expect(isPreapprovedHost("github.com", "/anthropics/%5C")).toBe(false);
    expect(isPreapprovedHost("github.com", "/anthropics/%2E")).toBe(false);
    expect(isPreapprovedHost("github.com", "/anthropics/%25%252e")).toBe(false);
    expect(isPreapprovedHost("github.com", "/anthropics/%2525252f")).toBe(false);
    expect(isPreapprovedHost("github.com", "/anthropics/x%2fy")).toBe(false); // anywhere in the path
    // ...but not a lone `%25`, a truncated `%2`, or another escape.
    expect(isPreapprovedHost("github.com", "/anthropics/%25")).toBe(true);
    expect(isPreapprovedHost("github.com", "/anthropics/%2")).toBe(true);
    expect(isPreapprovedHost("github.com", "/anthropics/%20x")).toBe(true);
    expect(isPreapprovedHost("github.com", "/anthropics/%252x")).toBe(true);
  });

  test("isPreapprovedUrl reads the parsed URL's hostname and pathname, never the query", () => {
    expect(isPreapprovedUrl(new URL("https://REACT.dev/"))).toBe(true); // the URL parser lower-cases the host
    expect(isPreapprovedUrl(new URL("https://github.com/x?y=/anthropics"))).toBe(false);
    expect(isPreapprovedUrl(new URL("https://github.com/anthropics?x=%2f"))).toBe(true);
  });
});

describe("preapprovedScopeOf: three candidate hosts, in order", () => {
  test("the host, then the host without a leading `www.`, then that with `www.` added -- the scope names the candidate that matched", () => {
    expect(preapprovedScopeOf(new URL("https://www.bun.sh/"))).toEqual({ host: "bun.sh" });
    expect(preapprovedScopeOf(new URL("https://php.net/manual"))).toEqual({ host: "www.php.net" });
    expect(preapprovedScopeOf(new URL("https://kaggle.com/docs"))).toEqual({ host: "www.kaggle.com", pathPrefix: "/docs" });
    expect(preapprovedScopeOf(new URL("https://www.dev.wix.com/docs/x"))).toEqual({ host: "dev.wix.com", pathPrefix: "/docs" });
    expect(preapprovedScopeOf(new URL("https://REACT.dev/"))).toEqual({ host: "react.dev" });
  });

  test("only ONE leading `www.` is stripped, and nothing else is: no subdomain, no trailing dot", () => {
    expect(preapprovedScopeOf(new URL("https://www.www.bun.sh/"))).toBeUndefined();
    expect(preapprovedScopeOf(new URL("https://wix.com/docs/x"))).toBeUndefined();
    expect(preapprovedScopeOf(new URL("https://react.dev./"))).toBeUndefined();
  });

  test("a path-scoped candidate: the matched prefix is returned; a non-matching path tries the next candidate", () => {
    expect(preapprovedScopeOf(new URL("https://go.dev/ref/spec"))).toEqual({ host: "go.dev", pathPrefix: "/ref" });
    expect(preapprovedScopeOf(new URL("https://go.dev/docs"))).toBeUndefined();
    expect(preapprovedScopeOf(new URL("https://claude.com/docsx"))).toBeUndefined();
    expect(preapprovedScopeOf(new URL("https://www.claude.com/other"))).toBeUndefined();
    expect(preapprovedScopeOf(new URL("https://github.com/x?y=/anthropics"))).toBeUndefined();
  });

  test("an encoded traversal under a path-scoped candidate means no scope at all", () => {
    expect(preapprovedScopeOf(new URL("https://github.com/anthropics/%2f"))).toBeUndefined();
    expect(preapprovedScopeOf(new URL("https://www.claude.com/docs%2f"))).toBeUndefined();
    // a hostname-only candidate never looks at the path
    expect(preapprovedScopeOf(new URL("https://react.dev/%2f"))).toEqual({ host: "react.dev" });
  });
});

describe("staysWithinScope", () => {
  test("the target host must be the scope host, that host without one leading `www.`, or that with `www.` added", () => {
    expect(staysWithinScope({ host: "bun.sh" }, new URL("https://www.bun.sh/x"))).toBe(true);
    expect(staysWithinScope({ host: "www.bun.sh" }, new URL("https://bun.sh/x"))).toBe(true);
    expect(staysWithinScope({ host: "www.bun.sh" }, new URL("https://www.www.bun.sh/x"))).toBe(false);
    expect(staysWithinScope({ host: "bun.sh" }, new URL("https://sub.bun.sh/x"))).toBe(false);
  });

  test("a hostname-only scope covers every path, encoded traversal included", () => {
    expect(staysWithinScope({ host: "bun.sh" }, new URL("https://bun.sh/%2f"))).toBe(true);
  });

  test("a path scope: the prefix itself or a `/`-bounded child, and the traversal guard applies", () => {
    const scope = { host: "github.com", pathPrefix: "/anthropics" };
    expect(staysWithinScope(scope, new URL("https://github.com/anthropics"))).toBe(true);
    expect(staysWithinScope(scope, new URL("https://www.github.com/anthropics/x"))).toBe(true);
    expect(staysWithinScope(scope, new URL("https://github.com/anthropicsx"))).toBe(false);
    expect(staysWithinScope(scope, new URL("https://github.com/anthropics/%2f"))).toBe(false);
    expect(staysWithinScope(scope, new URL("https://github.com/anthropics/%255C"))).toBe(false);
  });

  test("the scope is taken as given -- it need not be a listed entry, and an empty prefix covers every path", () => {
    expect(staysWithinScope({ host: "x.y", pathPrefix: "/a/b" }, new URL("https://www.x.y/a/b/c"))).toBe(true);
    expect(staysWithinScope({ host: "x.y", pathPrefix: "" }, new URL("https://x.y/c"))).toBe(true);
  });
});
