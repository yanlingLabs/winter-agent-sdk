// Phase 5 Lane S slice 4 (WS-07 §3, WS-11 §2.3): "Skill permission rules match the skill name and
// argument prefix". Matching is anchored on the INVOKED skill's own identities, never on a
// pre-parsed rule -- see permission-rules.ts's header for why grammar.ts's parseRule cannot do it.
import { describe, test, expect } from "bun:test";
import { matchesSkillRule, parseSkillRule, skillRulesAllow } from "./permission-rules.ts";

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
