// Phase 5 Lane S slice 2: the POST-TRUNCATION `SkillListing` (R5-17). Lane C consumes this through
// `SystemPromptInput.skillListing` and never re-derives the caps, so every cap must be enforced HERE.
import { describe, test, expect } from "bun:test";
import type { SkillMeta } from "./store.ts";
import {
  buildSkillListing,
  skillListingBudgetChars,
  isModelVisible,
  isUserInvocable,
  DEFAULT_SKILL_LISTING_MAX_DESC_CHARS,
  DEFAULT_SKILL_LISTING_BUDGET_FRACTION,
  SKILL_LISTING_CHARS_PER_TOKEN,
  LISTING_TRUNCATION_SUFFIX,
  renderSkillListingContent,
  renderSkillListingLine,
} from "./listing.ts";

function meta(name: string, description: string, source: SkillMeta["source"] = "project"): SkillMeta {
  return { name, description, source, path: `/fake/${name}/SKILL.md` };
}

describe("buildSkillListing: the pinned defaults", () => {
  test("the pinned doc-stated defaults are what an option-free call uses", () => {
    expect(DEFAULT_SKILL_LISTING_MAX_DESC_CHARS).toBe(1536);
    expect(DEFAULT_SKILL_LISTING_BUDGET_FRACTION).toBe(0.01);
  });

  test("a small listing passes through untouched, carrying exactly name/description/source", () => {
    expect(buildSkillListing([meta("review", "reviews code"), meta("lint", "lints", "user")])).toEqual([
      { name: "review", description: "reviews code", source: "project" },
      { name: "lint", description: "lints", source: "user" },
    ]);
  });

  test("every SkillListing `source` value round-trips, including the Winter `self` tier", () => {
    const all = buildSkillListing([meta("a", "d", "project"), meta("b", "d", "user"), meta("c", "d", "plugin"), meta("d", "d", "builtin"), meta("e", "d", "self")]);
    expect(all.map((s) => s.source)).toEqual(["project", "user", "plugin", "builtin", "self"]);
  });
});

describe("buildSkillListing: `skillListingMaxDescChars` (sdk.d.ts:5499)", () => {
  test("an over-long description is cut to the cap and marked -- claude's `xkn`: cap - 1 characters plus the ellipsis", () => {
    const listing = buildSkillListing([meta("long", "x".repeat(50))], { maxDescChars: 10, contextWindowTokens: 200_000 });
    expect(listing[0]!.description).toBe("x".repeat(9) + LISTING_TRUNCATION_SUFFIX);
    expect(listing[0]!.description).toHaveLength(10);
  });

  test("a description exactly at the cap is NOT marked", () => {
    expect(buildSkillListing([meta("edge", "y".repeat(10))], { maxDescChars: 10 })[0]!.description).toBe("y".repeat(10));
  });

  test("the cap is applied BEFORE the budget, so the budget sees post-truncation sizes", () => {
    // 3 lines of `- aaaa: ` + 10 = 18 chars, plus 2 separators = 56; a 60-char budget keeps every
    // description only if the per-description cap ran first (uncapped each line is 158 chars).
    const skills = [meta("aaaa", "z".repeat(150)), meta("bbbb", "z".repeat(150)), meta("cccc", "z".repeat(150))];
    const listing = buildSkillListing(skills, { maxDescChars: 10, budgetChars: 60 });
    expect(listing).toHaveLength(3);
    expect(listing.every((s) => s.description.length === 10)).toBe(true);
  });
});

describe("buildSkillListing: `skillListingBudgetFraction` (sdk.d.ts:5503)", () => {
  test("the budget is fraction x context window x the disclosed chars-per-token ratio", () => {
    expect(skillListingBudgetChars({ contextWindowTokens: 200_000, budgetFraction: 0.01 })).toBe(200_000 * 0.01 * SKILL_LISTING_CHARS_PER_TOKEN);
  });

  test("over budget, EVERY skill stays listed and descriptions are restored in precedence order while they fit (claude's `Rot`)", () => {
    // Full lines: 27 + 27 + 29 + 2 separators = 85 > 50. Names only: 5 + 5 + 7 + 2 = 19, leaving 31;
    // `one` costs 22 more and fits, then 9 is left and neither 22-char description does.
    const skills = [meta("one", "1".repeat(20)), meta("two", "2".repeat(20)), meta("three", "3".repeat(20))];
    const listing = buildSkillListing(skills, { budgetChars: 50 });
    expect(listing.map((s) => [s.name, s.description])).toEqual([
      ["one", "1".repeat(20)],
      ["two", ""],
      ["three", ""],
    ]);
    expect(renderSkillListingContent(listing)).toBe(`- one: ${"1".repeat(20)}\n- two\n- three`);
  });

  test("a later, smaller description still fits after a larger one did not -- claude keeps scanning", () => {
    const skills = [meta("big", "b".repeat(80)), meta("tiny", "t")];
    expect(buildSkillListing(skills, { budgetChars: 40 })).toEqual([
      { name: "big", description: "", source: "project" },
      { name: "tiny", description: "t", source: "project" },
    ]);
  });

  test("over budget, a builtin skill keeps its description regardless (claude's bundled skills)", () => {
    const skills = [meta("proj", "p".repeat(60)), meta("core", "c".repeat(60), "builtin")];
    const listing = buildSkillListing(skills, { budgetChars: 30 });
    expect(listing.map((s) => s.description.length)).toEqual([0, 60]);
  });

  test("with no context window, claude's 200k-token default sizes the budget", () => {
    expect(skillListingBudgetChars({})).toBe(8000);
  });

  test("a budget of zero disables the budget, and a non-finite window falls back to the default -- never an empty listing", () => {
    const skills = [meta("a", "d"), meta("b", "d")];
    expect(buildSkillListing(skills, { budgetChars: 0 })).toHaveLength(2);
    expect(buildSkillListing(skills, { contextWindowTokens: Number.NaN })).toHaveLength(2);
  });
});

describe("buildSkillListing: `skillOverrides` four states (sdk.d.ts:5651)", () => {
  const skills = [meta("on-skill", "d1"), meta("named", "d2"), meta("user-only", "d3"), meta("gone", "d4")];
  const overrides = { named: "name-only", "user-only": "user-invocable-only", gone: "off" } as const;

  test("`name-only` keeps the name and drops the description", () => {
    expect(buildSkillListing(skills, { skillOverrides: overrides }).find((s) => s.name === "named")).toEqual({ name: "named", description: "", source: "project" });
  });

  test("`off` and `user-invocable-only` are both absent from the MODEL-facing listing", () => {
    expect(buildSkillListing(skills, { skillOverrides: overrides }).map((s) => s.name)).toEqual(["on-skill", "named"]);
  });

  test("`user-invocable-only` stays USER-invocable while `off` is invocable by nobody", () => {
    expect(isUserInvocable(overrides, "user-only")).toBe(true);
    expect(isUserInvocable(overrides, "gone")).toBe(false);
    expect(isModelVisible(overrides, "user-only")).toBe(false);
    expect(isModelVisible(overrides, "on-skill")).toBe(true);
  });

  test("an unknown override value is treated as `on` -- a settings file written for a newer engine never hides a skill by accident", () => {
    expect(isModelVisible({ x: "some-future-state" }, "x")).toBe(true);
    expect(buildSkillListing([meta("x", "d")], { skillOverrides: { x: "some-future-state" } })).toHaveLength(1);
  });

  test("an override is matched against EVERY name a skill answers to, so `.winter:<name>` works too", () => {
    const project: SkillMeta = { name: "review", description: "d", source: "project", path: "/p", aliases: [".winter:review"] };
    expect(buildSkillListing([project], { skillOverrides: { ".winter:review": "off" } })).toEqual([]);
  });
});
