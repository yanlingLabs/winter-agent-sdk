// A recorded input -> output corpus for `buildSkillListing` and `skillListingBudgetChars`: 2000
// generated skill lists (0-10 skills, every source tier, duplicate names, `.winter:` aliases, empty /
// unicode / emoji descriptions) with generated options (description caps including 0, negative,
// fractional and non-finite values; explicit, derived and invalid budgets; skill overrides of every
// state, including unknown values and alias-keyed ones) and the listing and budget recorded for them.
// Compact rows: a skill is [name, description, source, aliases?] with path `/fake/<index>/SKILL.md`; a
// listing entry is [name, description, source]. `{"$num": "NaN" | "Infinity" | "-Infinity"}` encodes
// the non-finite numbers JSON cannot carry.
import { expect, test } from "bun:test";
import type { SkillMeta } from "./store.ts";
import { buildSkillListing, skillListingBudgetChars, type BuildSkillListingOptions } from "./listing.ts";
import corpus from "./__corpus__/skill-listing.json";

type Row = { skills: Array<[string, string, SkillMeta["source"], string[]?]>; opts?: Record<string, unknown>; budget: unknown; expected: Array<[string, string, string]> };

function decode(v: unknown): unknown {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const num = (v as { $num?: string }).$num;
    if (num !== undefined) return Number(num);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)]));
  }
  return v;
}

test("the recorded corpus lists and budgets exactly as recorded", () => {
  const rows = corpus as unknown as Row[];
  expect(rows.length).toBe(2000);
  const mismatches: unknown[] = [];
  for (const row of rows) {
    const skills: SkillMeta[] = row.skills.map(([name, description, source, aliases], i) => ({ name, description, source, path: `/fake/${i}/SKILL.md`, ...(aliases ? { aliases } : {}) }));
    const opts = row.opts === undefined ? undefined : (decode(row.opts) as BuildSkillListingOptions);
    const listing = buildSkillListing(skills, opts).map((e) => [e.name, e.description, e.source]);
    const budget = skillListingBudgetChars(opts ?? {});
    if (JSON.stringify(listing) !== JSON.stringify(row.expected) || budget !== decode(row.budget)) mismatches.push({ row, listing, budget });
  }
  expect(mismatches).toEqual([]);
});
