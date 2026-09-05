// Phase 5 Lane S slice 4 (WS-07 §3, WS-11 §2.3): "Skill permission rules match the skill name and
// argument prefix". Matching is anchored on the INVOKED skill's own identities, never on a
// pre-parsed rule -- see permission-rules.ts's header for why grammar.ts's parseRule cannot do it.
import { describe, test, expect } from "bun:test";
import { matchesSkillRule, parseSkillRule, skillRulesAllow } from "./permission-rules.ts";
import { evaluate, REAL_SPECIAL_CHECKS, NO_OPINION_HOOK_STAGE, NO_OPINION_PROMPT_STAGE, NO_OPINION_AUTO_ENGINE, type EvaluationContext } from "../permissions/evaluator.ts";
import { emptyRuleSet, sourceRule } from "../permissions/ruleset.ts";
import { parseRule } from "../permissions/grammar.ts";

const review = { identities: ["review", ".winter:review"] };

describe("parseSkillRule", () => {
  test("a bare tool name yields no content -- the match-everything form", () => {
    expect(parseSkillRule("Skill")).toEqual({ content: undefined });
    expect(parseSkillRule("Skill(*)")).toEqual({ content: "*" });
  });

  test("content is taken verbatim, colons and dots and all", () => {
    expect(parseSkillRule("Skill(.winter:review:src/*)")).toEqual({ content: ".winter:review:src/*" });
  });

  test("a rule for any OTHER tool is not a skill rule", () => {
    expect(parseSkillRule("Bash(ls:*)")).toBeUndefined();
    expect(parseSkillRule("Skills(review)")).toBeUndefined();
    expect(parseSkillRule("  Skill(review)  ")).toEqual({ content: "review" });
  });
});

describe("matchesSkillRule: name matching", () => {
  test("a bare rule and `*` match every skill and every argument", () => {
    expect(matchesSkillRule(undefined, review)).toBe(true);
    expect(matchesSkillRule("*", { ...review, args: "anything" })).toBe(true);
  });

  test("an exact name matches regardless of arguments", () => {
    expect(matchesSkillRule("review", review)).toBe(true);
    expect(matchesSkillRule("review", { ...review, args: "src/main.ts" })).toBe(true);
    expect(matchesSkillRule("lint", review)).toBe(false);
  });

  test("EVERY identity is tried, so a rule written on either branch matches one invocation", () => {
    expect(matchesSkillRule(".winter:review", review)).toBe(true);
    expect(matchesSkillRule(".winter:lint", review)).toBe(false);
  });

  test("a qualified plugin name is matched as a NAME, never split into name+argument", () => {
    const pluginSkill = { identities: ["acme:review"] };
    expect(matchesSkillRule("acme:review", pluginSkill)).toBe(true);
    // "acme" is not an identity of this skill, so `acme:review` can only be read as the whole name.
    expect(matchesSkillRule("acme:review", { identities: ["acme"] })).toBe(false);
  });
});

describe("matchesSkillRule: argument prefixes (WS-07 §3)", () => {
  test("`<name>:*` matches any arguments including none", () => {
    expect(matchesSkillRule("review:*", review)).toBe(true);
    expect(matchesSkillRule("review:*", { ...review, args: "src/main.ts" })).toBe(true);
  });

  test("a trailing `*` is a PREFIX match on the arguments", () => {
    expect(matchesSkillRule("review:src/*", { ...review, args: "src/main.ts" })).toBe(true);
    expect(matchesSkillRule("review:src/*", { ...review, args: "test/main.ts" })).toBe(false);
    expect(matchesSkillRule("review:src/*", { ...review, args: "src/" })).toBe(true);
  });

  test("no wildcard means the arguments must match EXACTLY", () => {
    expect(matchesSkillRule("review:src", { ...review, args: "src" })).toBe(true);
    expect(matchesSkillRule("review:src", { ...review, args: "src/main.ts" })).toBe(false);
  });

  test("an argument pattern never matches a DIFFERENT skill's invocation", () => {
    expect(matchesSkillRule("lint:*", { ...review, args: "x" })).toBe(false);
  });

  test("the LONGEST identity wins the name/argument split -- `.winter:review:x` is name `.winter:review`, argument `x`", () => {
    const both = { identities: ["review", ".winter:review"], args: "x" };
    expect(matchesSkillRule(".winter:review:x", both)).toBe(true);
    expect(matchesSkillRule(".winter:review:y", both)).toBe(false);
  });

  test("the sort DISCRIMINATES: a shorter identity that PREFIXES the rule content must not claim it first", () => {
    // Fix round 1, Nit 6. The case above cannot fail without the sort (the short identity is not a
    // prefix of the content, so the loop skips it). This one can: unsorted, `a` matches
    // `content.startsWith("a:")` and RETURNS from inside that branch, comparing argument pattern `b`
    // against args `""` -- false -- before `a:b` is ever tried. No identity set `SkillIndex` produces
    // reaches this today, so the sort is defensive; this fixture is what keeps it from being deleted
    // as dead code.
    expect(matchesSkillRule("a:b", { identities: ["a", "a:b"] })).toBe(true);
    expect(matchesSkillRule("a:b", { identities: ["a", "a:b"], args: "anything" })).toBe(true);
    // ...and the shorter identity still owns a content that is genuinely name+argument for it.
    expect(matchesSkillRule("a:b", { identities: ["a"], args: "b" })).toBe(true);
    expect(matchesSkillRule("a:b", { identities: ["a"], args: "zzz" })).toBe(false);
  });
});

describe("skillRulesAllow", () => {
  test("any matching rule in the list is enough", () => {
    expect(skillRulesAllow(["Bash(ls)", "Skill(review)"], review)).toBe(true);
    expect(skillRulesAllow(["Bash(ls)", "Skill(lint)"], review)).toBe(false);
    expect(skillRulesAllow([], review)).toBe(false);
    expect(skillRulesAllow(undefined, review)).toBe(false);
  });
});

// ================================================================================================
// T8 rider 18: the EVALUATOR routes `Skill(...)` rules here. Three failure modes, all silent.
// ================================================================================================
//
// Before this wiring a hand-written `Skill(...)` rule was inert in a live session, and the way it
// failed depended on the skill's NAME -- which is what makes this worth its own fixture block rather
// than a line in the module above. Driven through the REAL six-stage `evaluate()`, never through
// `matchesSkillRule` alone: the unit half is already covered above, and the thing that was broken
// was the routing.
describe("rider 18: Skill(...) rules reach the real evaluator", () => {
  const HOME = "/synthetic/home/tester";
  const CWD = "/synthetic/workspace";

  /** One raw rule STRING -> the sourced allow entry the evaluator's own rule set holds. */
  function toAllowEntry(raw: string) {
    const parsed = parseRule(raw);
    const source = parsed.specifier?.kind === "pattern" ? (parsed.specifier as { source: string }).source : undefined;
    return sourceRule({ toolName: parsed.toolName, ...(source !== undefined ? { ruleContent: source } : {}) }, "allow", "sdk");
  }

  function ctxWith(rules: string[], identities?: (name: string) => readonly string[]): EvaluationContext {
    return {
      policy: { mode: "default", rules: { ...emptyRuleSet(), entries: rules.map(toAllowEntry) }, version: 1 },
      cwd: CWD,
      sessionRoot: CWD,
      home: HOME,
      trustedWorkspace: false,
      sessionBypassEnabled: false,
      ...(identities !== undefined ? { skillIdentities: identities } : {}),
      hookStage: NO_OPINION_HOOK_STAGE,
      promptStage: NO_OPINION_PROMPT_STAGE,
      autoEngine: NO_OPINION_AUTO_ENGINE,
      specialChecks: REAL_SPECIAL_CHECKS,
      requiresInteraction: () => false,
    };
  }

  async function decide(rules: string[], input: Record<string, unknown>, identities?: (name: string) => readonly string[]): Promise<string> {
    const record = await evaluate({ toolName: "Skill", input, toolUseId: "t" }, ctxWith(rules, identities));
    return record.decision;
  }

  test("a per-name allow rule ALLOWS its own skill -- the whole family was inert before the routing", async () => {
    expect(await decide(["Skill(review)"], { skill: "review" })).toBe("allow");
  });

  test("a per-name allow rule does NOT allow a different skill", async () => {
    expect(await decide(["Skill(review)"], { skill: "deploy" })).not.toBe("allow");
  });

  test("the ARGUMENT PREFIX binds: `Skill(review:src*)` allows `src/a.ts` and refuses `test/a.ts`", async () => {
    expect(await decide(["Skill(review:src*)"], { skill: "review", args: "src/a.ts" })).toBe("allow");
    expect(await decide(["Skill(review:src*)"], { skill: "review", args: "test/a.ts" })).not.toBe("allow");
  });

  test("A HYPHENATED NAME BEHAVES IDENTICALLY -- the rule's CLASS no longer depends on the skill's name (P5-H companion)", async () => {
    // Before grammar.ts's Skill early return, `Skill(review:*)` parsed as `param` (never matching in
    // the allow direction) while `Skill(my-skill:*)` parsed as `pattern`. Same shape, same outcome
    // now, which is the whole claim.
    expect(parseRule("Skill(review:*)").specifier?.kind).toBe("pattern");
    expect(parseRule("Skill(my-skill:*)").specifier?.kind).toBe("pattern");
    expect(parseRule("Skill(.winter:review)").specifier?.kind).toBe("pattern");
    expect(await decide(["Skill(review:*)"], { skill: "review", args: "x" })).toBe("allow");
    expect(await decide(["Skill(my-skill:*)"], { skill: "my-skill", args: "x" })).toBe("allow");
  });

  test("the ALIAS dimension: `Skill(.winter:review)` matches a project skill invoked by its BARE name", async () => {
    // The identity set is what the session's own SkillIndex reports; without it the rule is
    // alias-blind (asserted both ways, so the injection is provably load-bearing).
    expect(await decide(["Skill(.winter:review)"], { skill: "review" }, (n) => (n === "review" ? ["review", ".winter:review"] : [n]))).toBe("allow");
    expect(await decide(["Skill(.winter:review)"], { skill: "review" })).not.toBe("allow");
  });

  test("a BARE `Skill` rule still allows everything -- `autoSkillPermissionEntries(\"all\")`'s own form is unchanged", async () => {
    expect(await decide(["Skill"], { skill: "anything", args: "whatever" })).toBe("allow");
  });
});
