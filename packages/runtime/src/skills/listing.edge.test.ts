// Edge cases of the model-facing skill listing: the whole-listing character budget, the per-skill
// description cap, and which entries keep their description when the full listing does not fit.
import { describe, expect, test } from "bun:test";
import type { SkillMeta } from "./store.ts";
import { buildSkillListing, renderSkillListingContent, skillListingBudgetChars, truncateSkillDescription } from "./listing.ts";

function meta(name: string, description: string, source: SkillMeta["source"] = "project", aliases?: string[]): SkillMeta {
  return { name, description, source, path: `/fake/${name}/SKILL.md`, ...(aliases ? { aliases } : {}) };
}

describe("skillListingBudgetChars", () => {
  test("defaults: a 200000-token window, 1% of it, 4 characters per token", () => {
    expect(skillListingBudgetChars({})).toBe(8000);
  });

  test("floor(window x 4 x fraction)", () => {
    expect(skillListingBudgetChars({ contextWindowTokens: 1000.7, budgetFraction: 0.013 })).toBe(52);
  });

  test("never below 1 on the derived path", () => {
    expect(skillListingBudgetChars({ contextWindowTokens: 1, budgetFraction: 0.01 })).toBe(1);
  });

  test("a zero, negative or non-finite window or fraction falls back to its default", () => {
    expect(skillListingBudgetChars({ contextWindowTokens: -5 })).toBe(8000);
    expect(skillListingBudgetChars({ contextWindowTokens: 0 })).toBe(8000);
    expect(skillListingBudgetChars({ contextWindowTokens: Number.NaN })).toBe(8000);
    expect(skillListingBudgetChars({ contextWindowTokens: Number.POSITIVE_INFINITY })).toBe(8000);
    expect(skillListingBudgetChars({ budgetFraction: 0 })).toBe(8000);
    expect(skillListingBudgetChars({ budgetFraction: -1 })).toBe(8000);
  });

  test("an explicit budgetChars wins, unrounded; zero, negative or non-finite means 0 (no budget)", () => {
    expect(skillListingBudgetChars({ budgetChars: 2.5, contextWindowTokens: 10 })).toBe(2.5);
    expect(skillListingBudgetChars({ budgetChars: 0 })).toBe(0);
    expect(skillListingBudgetChars({ budgetChars: -3 })).toBe(0);
    expect(skillListingBudgetChars({ budgetChars: Number.NaN })).toBe(0);
    expect(skillListingBudgetChars({ budgetChars: Number.POSITIVE_INFINITY })).toBe(0);
  });
});

describe("truncateSkillDescription", () => {
  test("cap - 1 characters plus an ellipsis, so the result is exactly cap long", () => {
    expect(truncateSkillDescription("abcdef", 4)).toBe("abc…");
  });

  test("a cap of 1 keeps only the ellipsis", () => {
    expect(truncateSkillDescription("abcd", 1)).toBe("…");
  });

  test("a zero, negative or non-finite cap disables truncation", () => {
    expect(truncateSkillDescription("abc", 0)).toBe("abc");
    expect(truncateSkillDescription("abc", -1)).toBe("abc");
    expect(truncateSkillDescription("abc", Number.NaN)).toBe("abc");
    expect(truncateSkillDescription("abc", Number.POSITIVE_INFINITY)).toBe("abc");
  });

  test("a fractional cap compares with the fraction and cuts toward zero", () => {
    expect(truncateSkillDescription("abc", 2.5)).toBe("a…");
    expect(truncateSkillDescription("ab", 2.5)).toBe("ab");
  });

  test("lengths are UTF-16 code units, so a cut may split a surrogate pair", () => {
    expect(truncateSkillDescription("😀b", 2)).toBe("\uD83D…");
  });
});

describe("buildSkillListing: the budget", () => {
  test("the full listing fits exactly at the budget (lines plus one newline between each)", () => {
    // "- aa: 1234" (10) + "\n" + "- b: 12" (7) = 18
    const skills = [meta("aa", "1234"), meta("b", "12")];
    expect(buildSkillListing(skills, { budgetChars: 18 }).map((e) => e.description)).toEqual(["1234", "12"]);
    expect(renderSkillListingContent(buildSkillListing(skills, { budgetChars: 18 })).length).toBe(18);
  });

  test("over budget: start from bare names, then restore descriptions in order while each fits", () => {
    // Bare: "- aa" (4) + "- b" (3) + 1 = 8. Budget 14 leaves 6: `aa` costs 6 more and fits, then 0 is left.
    expect(buildSkillListing([meta("aa", "1234"), meta("b", "12")], { budgetChars: 14 }).map((e) => e.description)).toEqual(["1234", ""]);
    // Budget 13 leaves 5: `aa` (6) does not fit, `b` (4) does.
    expect(buildSkillListing([meta("aa", "1234"), meta("b", "12")], { budgetChars: 13 }).map((e) => e.description)).toEqual(["", "12"]);
  });

  test("the cost of restoring a description is the line length difference: ': ' plus the description", () => {
    // Bare total 3 + 3 + 1 = 7. Budget 10 leaves 3: "x" costs 3 ("- a: x" vs "- a") and fits exactly.
    expect(buildSkillListing([meta("a", "x"), meta("b", "yyyy")], { budgetChars: 10 }).map((e) => e.description)).toEqual(["x", ""]);
  });

  test("even the bare-name listing over budget: every entry stays, every restorable description is dropped", () => {
    expect(buildSkillListing([meta("a", ""), meta("b", "y".repeat(50)), meta("c", "z")], { budgetChars: 10 })).toEqual([
      { name: "a", description: "", source: "project" },
      { name: "b", description: "", source: "project" },
      { name: "c", description: "", source: "project" },
    ]);
  });

  test("builtin entries always keep their description and are charged in full first", () => {
    // Fixed cost: "- core: cccc" (12) + "- p" (3) + 1 = 16. Budget 20 leaves 4: "pp" costs 4, fits.
    expect(buildSkillListing([meta("core", "cccc", "builtin"), meta("p", "pp")], { budgetChars: 20 }).map((e) => e.description)).toEqual(["cccc", "pp"]);
    expect(buildSkillListing([meta("core", "cccc", "builtin"), meta("p", "pp")], { budgetChars: 19 }).map((e) => e.description)).toEqual(["cccc", ""]);
  });

  test("when only builtin / name-only entries exist the listing is returned as-is even over budget", () => {
    const listing = buildSkillListing([meta("a", "x".repeat(50), "builtin"), meta("b", "y".repeat(50), "builtin")], { budgetChars: 10 });
    expect(listing.map((e) => e.description.length)).toEqual([50, 50]);
  });

  test("a fractional budget is compared as-is", () => {
    // Full: "- a: x" (6). Budget 6.5 fits; 5.5 does not, and the bare line (3) leaves 2.5 < 3.
    expect(buildSkillListing([meta("a", "x")], { budgetChars: 6.5 })[0]!.description).toBe("x");
    expect(buildSkillListing([meta("a", "x")], { budgetChars: 5.5 })[0]!.description).toBe("");
  });

  test("lengths are counted in UTF-16 code units", () => {
    // "- 😀: 😀" is 8 code units.
    expect(buildSkillListing([meta("😀", "😀")], { budgetChars: 8 })[0]!.description).toBe("😀");
    expect(buildSkillListing([meta("😀", "😀")], { budgetChars: 7 })[0]!.description).toBe("");
  });

  test("the budget sees descriptions after the per-skill cap", () => {
    // Capped: "- a: xxx…" (9). Budget 9 fits.
    expect(buildSkillListing([meta("a", "x".repeat(40))], { maxDescChars: 4, budgetChars: 9 })[0]!.description).toBe("xxx…");
  });

  test("the derived budget is used when no budgetChars is given", () => {
    // window 100 x 4 x 0.02 = 8: "- a: xxxx" (9) does not fit, bare "- a" (3) leaves 5 < 6.
    expect(buildSkillListing([meta("a", "xxxx")], { contextWindowTokens: 100, budgetFraction: 0.02 })[0]!.description).toBe("");
    expect(buildSkillListing([meta("a", "xxx")], { contextWindowTokens: 100, budgetFraction: 0.02 })[0]!.description).toBe("xxx");
  });

  test("an empty skill list is an empty listing", () => {
    expect(buildSkillListing([], { budgetChars: 1 })).toEqual([]);
  });
});

describe("buildSkillListing: overrides and identity", () => {
  test("name-only entries are listed with an empty description and are never charged a description", () => {
    const listing = buildSkillListing([meta("n", "long description"), meta("p", "pp")], { budgetChars: 10, skillOverrides: { n: "name-only" } });
    // Bare: "- n" (3) + "- p" (3) + 1 = 7, leaving 3 < 4.
    expect(listing.map((e) => e.description)).toEqual(["", ""]);
    expect(buildSkillListing([meta("n", "long description"), meta("p", "pp")], { budgetChars: 11, skillOverrides: { n: "name-only" } }).map((e) => e.description)).toEqual(["", "pp"]);
  });

  test("off and user-invocable-only entries are absent and cost nothing", () => {
    const listing = buildSkillListing([meta("gone", "x".repeat(100)), meta("p", "pp")], { budgetChars: 7, skillOverrides: { gone: "off" } });
    expect(listing).toEqual([{ name: "p", description: "pp", source: "project" }]);
  });

  test("an override is looked up primary name first, then aliases, and the first value found wins", () => {
    expect(buildSkillListing([meta("r", "d", "project", ["x"])], { skillOverrides: { x: "off", r: "on" } })).toHaveLength(1);
    expect(buildSkillListing([meta("r", "d", "project", ["x"])], { skillOverrides: { x: "name-only" } })[0]!.description).toBe("");
  });

  test("duplicate names are listed twice -- the listing does not de-duplicate", () => {
    expect(buildSkillListing([meta("a", "d1"), meta("a", "d2")]).map((e) => e.description)).toEqual(["d1", "d2"]);
  });

  test("the listing entry carries only name, description and source", () => {
    const entry = buildSkillListing([{ name: "a", description: "d", source: "plugin", path: "/p", author: "z", plugin: "pk", aliases: ["b"] }])[0];
    expect(entry).toEqual({ name: "a", description: "d", source: "plugin" });
  });
});
