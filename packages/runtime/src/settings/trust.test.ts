// Phase 5 Task 2 (R5-6 as AMENDED into RULING P5-A by Task 1's capture (1)).
import { describe, test, expect } from "bun:test";
import { defaultTrustSource, fixedTrustSource, type WorkspaceTrustSource } from "./trust.ts";

describe("defaultTrustSource", () => {
  test("a host that declares trust gets a trusted verdict, reason host-declared", () => {
    const v = defaultTrustSource({ trustedWorkspace: true }).verdict("/anywhere");
    expect(v).toEqual({ trusted: true, reason: "host-declared" });
  });

  test("no declaration at all is UNTRUSTED (fail-closed) -- a repository never self-trusts", () => {
    expect(defaultTrustSource({}).verdict("/anywhere")).toEqual({ trusted: false, reason: "untrusted-default" });
  });

  test("an explicit false is untrusted", () => {
    expect(defaultTrustSource({ trustedWorkspace: false }).verdict("/anywhere")).toEqual({ trusted: false, reason: "untrusted-default" });
  });

  test("only an exact `true` grants trust -- no truthiness coercion", () => {
    const config = { trustedWorkspace: "true" } as unknown as { trustedWorkspace?: boolean };
    expect(defaultTrustSource(config).verdict("/anywhere").trusted).toBe(false);
  });

  test("SELECTING 'project' as a settings source is NOT trust (capture (1)'s decisive finding)", () => {
    expect(defaultTrustSource({ settingSources: ["project"] }).verdict("/repo").trusted).toBe(false);
    expect(defaultTrustSource({ settingSources: ["user", "project", "local"] }).verdict("/repo").trusted).toBe(false);
  });

  test("the verdict does not vary by cwd -- the pinned filter is per TIER, not per directory (OQ-P5-10)", () => {
    const source = defaultTrustSource({ trustedWorkspace: true });
    expect(source.verdict("/a")).toEqual(source.verdict("/b"));
    const untrusted = defaultTrustSource({});
    expect(untrusted.verdict("/a")).toEqual(untrusted.verdict("/b"));
  });
});

describe("fixedTrustSource (the seam's test/host double)", () => {
  test("it satisfies WorkspaceTrustSource and reports what it was built with", () => {
    const trusted: WorkspaceTrustSource = fixedTrustSource(true);
    expect(trusted.verdict("/x")).toEqual({ trusted: true, reason: "host-declared" });
    expect(fixedTrustSource(false).verdict("/x")).toEqual({ trusted: false, reason: "untrusted-default" });
  });
});
