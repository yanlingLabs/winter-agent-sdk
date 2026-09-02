// Task 12 (WS-07 §10.2/§10.6-6/§10.6-7): AutoModeConfig mechanics — $defaults splice/replace, tier
// semantics, source restriction, broad-allow suspension. Pure functions only, no fs/engine.
import { describe, test, expect } from "bun:test";
import {
  normalizeAutoModeConfig,
  AUTO_MODE_DEFAULT_ALLOW,
  AUTO_MODE_DEFAULT_SOFT_DENY,
  AUTO_MODE_DEFAULT_HARD_DENY,
  AUTO_MODE_DEFAULT_ENVIRONMENT,
  AUTO_MODE_DEFAULT_USE_AUTO_MODE_DURING_PLAN,
  assertAutoModeConfigSource,
  AutoModeConfigSourceError,
  resolveAutoTier,
  isAutoSuspendedAllowRule,
  type NormalizedAutoModeConfig,
} from "./config.ts";
import { parseRule } from "../grammar.ts";

describe("normalizeAutoModeConfig -- $defaults splice vs replace (WS-07 §10.2)", () => {
  test("omitted field -- defaults verbatim, NOT flagged as a replacement", () => {
    const n = normalizeAutoModeConfig(undefined);
    expect(n.allow).toEqual([...AUTO_MODE_DEFAULT_ALLOW]);
    expect(n.soft_deny).toEqual([...AUTO_MODE_DEFAULT_SOFT_DENY]);
    expect(n.hard_deny).toEqual([...AUTO_MODE_DEFAULT_HARD_DENY]);
    expect(n.environment).toEqual([...AUTO_MODE_DEFAULT_ENVIRONMENT]);
    expect(n.securityRelevantReplacements).toEqual([]);
  });

  test("['$defaults'] alone -- splices in the built-ins verbatim, not flagged as a replacement", () => {
    const n = normalizeAutoModeConfig({ allow: ["$defaults"] });
    expect(n.allow).toEqual([...AUTO_MODE_DEFAULT_ALLOW]);
    expect(n.securityRelevantReplacements).not.toContain("allow");
  });

  test("['my-extra-allow', '$defaults'] -- splices defaults AT the token's position, extra entries preserved", () => {
    const n = normalizeAutoModeConfig({ allow: ["my-extra-allow", "$defaults", "trailing-extra"] });
    expect(n.allow).toEqual(["my-extra-allow", ...AUTO_MODE_DEFAULT_ALLOW, "trailing-extra"]);
    expect(n.securityRelevantReplacements).not.toContain("allow");
  });

  test("an array WITHOUT '$defaults' -- REPLACES the full default list and is flagged security-relevant", () => {
    const n = normalizeAutoModeConfig({ hard_deny: ["only-this-category"] });
    expect(n.hard_deny).toEqual(["only-this-category"]);
    expect(n.securityRelevantReplacements).toContain("hard_deny");
  });

  test("an empty array (no token) -- REPLACES with nothing at all, still flagged", () => {
    const n = normalizeAutoModeConfig({ soft_deny: [] });
    expect(n.soft_deny).toEqual([]);
    expect(n.securityRelevantReplacements).toContain("soft_deny");
  });

  test("only the fields actually replaced are flagged -- untouched fields never appear", () => {
    const n = normalizeAutoModeConfig({ allow: ["custom-only"] });
    expect(n.securityRelevantReplacements).toEqual(["allow"]);
  });

  test("classifyAllShell defaults to false (parity default, WS-07 §10.6-7) and threads through when true", () => {
    expect(normalizeAutoModeConfig(undefined).classifyAllShell).toBe(false);
    expect(normalizeAutoModeConfig({ classifyAllShell: true }).classifyAllShell).toBe(true);
  });

  test("useAutoModeDuringPlan defaults to the §6.5 'current default' (true) and is overridable", () => {
    expect(normalizeAutoModeConfig(undefined).useAutoModeDuringPlan).toBe(AUTO_MODE_DEFAULT_USE_AUTO_MODE_DURING_PLAN);
    expect(normalizeAutoModeConfig({ useAutoModeDuringPlan: false }).useAutoModeDuringPlan).toBe(false);
  });
});

describe("assertAutoModeConfigSource -- user/managed/inline(sdk) ONLY (WS-07 §3.2/§10.6-6)", () => {
  test("user/managed/sdk all pass", () => {
    expect(() => assertAutoModeConfigSource("user")).not.toThrow();
    expect(() => assertAutoModeConfigSource("managed")).not.toThrow();
    expect(() => assertAutoModeConfigSource("sdk")).not.toThrow();
  });

  test("project is a typed rejection (spec names .winter/settings.json explicitly)", () => {
    expect(() => assertAutoModeConfigSource("project")).toThrow(AutoModeConfigSourceError);
  });

  test("local is a typed rejection (spec names .winter/settings.local.json explicitly)", () => {
    expect(() => assertAutoModeConfigSource("local")).toThrow(AutoModeConfigSourceError);
  });

  test("cliArg and session are also rejected (spec-silent, conservative default -- not one of the three named-safe categories)", () => {
    expect(() => assertAutoModeConfigSource("cliArg")).toThrow(AutoModeConfigSourceError);
    expect(() => assertAutoModeConfigSource("session")).toThrow(AutoModeConfigSourceError);
  });
});

describe("resolveAutoTier -- hard unconditional, soft cleared by allow-exceptions (WS-07 §10.2/§10.6-7)", () => {
  const config: NormalizedAutoModeConfig = {
    environment: [],
    allow: ["push-to-working-repo"],
    soft_deny: ["force-push", "push-to-working-repo"],
    hard_deny: ["disable-security-control"],
    classifyAllShell: false,
    useAutoModeDuringPlan: true,
    securityRelevantReplacements: [],
  };

  test("a hard_deny category is unconditional", () => {
    expect(resolveAutoTier("disable-security-control", config)).toBe("hard_denied");
  });

  test("a soft_deny category with NO matching allow entry stays blocked", () => {
    expect(resolveAutoTier("force-push", config)).toBe("soft_denied");
  });

  test("a soft_deny category that ALSO appears in allow is cleared", () => {
    expect(resolveAutoTier("push-to-working-repo", config)).toBe("cleared");
  });

  test("a category naming neither list is unclassified", () => {
    expect(resolveAutoTier("some-unlisted-category", config)).toBe("unclassified");
  });

  test("no category at all is unclassified", () => {
    expect(resolveAutoTier(undefined, config)).toBe("unclassified");
  });

  test("hard_deny wins even if the SAME string also appears in allow (unconditional beats any exception)", () => {
    const c: NormalizedAutoModeConfig = { ...config, hard_deny: ["push-to-working-repo"] };
    expect(resolveAutoTier("push-to-working-repo", c)).toBe("hard_denied");
  });
});

describe("isAutoSuspendedAllowRule -- broad-allow suspension (WS-07 §10.1 step 2 / §10.6-7)", () => {
  const narrowConfig = { classifyAllShell: false };
  const classifyAllConfig = { classifyAllShell: true };

  test("bare Bash allow -- always suspended", () => {
    expect(isAutoSuspendedAllowRule(parseRule("Bash"), narrowConfig)).toBe(true);
  });

  test("Bash(*) -- always suspended (isBareEquivalent)", () => {
    expect(isAutoSuspendedAllowRule(parseRule("Bash(*)"), narrowConfig)).toBe(true);
  });

  test("bare PowerShell allow -- always suspended", () => {
    expect(isAutoSuspendedAllowRule(parseRule("PowerShell"), narrowConfig)).toBe(true);
  });

  test("a wildcarded interpreter rule (Bash(python *)) -- suspended even with classifyAllShell false", () => {
    expect(isAutoSuspendedAllowRule(parseRule("Bash(python *)"), narrowConfig)).toBe(true);
  });

  test("the :* trailing-wildcard spelling of an interpreter rule is recognized identically", () => {
    expect(isAutoSuspendedAllowRule(parseRule("Bash(node:*)"), narrowConfig)).toBe(true);
  });

  test("a wildcarded package-manager run-command grant (Bash(npm *)) -- suspended", () => {
    expect(isAutoSuspendedAllowRule(parseRule("Bash(npm *)"), narrowConfig)).toBe(true);
  });

  test("a narrow, fully-specific shell allow (Bash(npm test)) -- survives when classifyAllShell is false", () => {
    expect(isAutoSuspendedAllowRule(parseRule("Bash(npm test)"), narrowConfig)).toBe(false);
  });

  test("a narrow wildcarded-but-non-interpreter shell allow (Bash(ls *)) -- survives when classifyAllShell is false", () => {
    expect(isAutoSuspendedAllowRule(parseRule("Bash(ls *)"), narrowConfig)).toBe(false);
  });

  test("classifyAllShell: true suspends even the narrow survivors above", () => {
    expect(isAutoSuspendedAllowRule(parseRule("Bash(npm test)"), classifyAllConfig)).toBe(true);
    expect(isAutoSuspendedAllowRule(parseRule("Bash(ls *)"), classifyAllConfig)).toBe(true);
  });

  test("any Agent rule -- always suspended, regardless of specifier", () => {
    expect(isAutoSuspendedAllowRule(parseRule("Agent"), narrowConfig)).toBe(true);
    expect(isAutoSuspendedAllowRule(parseRule("Agent(Explore)"), narrowConfig)).toBe(true);
  });

  test("any Monitor rule -- always suspended, regardless of specifier", () => {
    expect(isAutoSuspendedAllowRule(parseRule("Monitor"), narrowConfig)).toBe(true);
  });

  test("a non-shell, non-Agent, non-Monitor tool (Read/WebFetch) is never suspended by this matcher", () => {
    expect(isAutoSuspendedAllowRule(parseRule("Read(**)"), narrowConfig)).toBe(false);
    expect(isAutoSuspendedAllowRule(parseRule("WebFetch(domain:example.com)"), narrowConfig)).toBe(false);
  });

  test("a param-kind Bash rule (Bash(run_in_background:true)) is not itself a broad allow", () => {
    expect(isAutoSuspendedAllowRule(parseRule("Bash(run_in_background:true)"), narrowConfig)).toBe(false);
  });
});
