// Phase 5 Lane S (RULING R5-17, derived-shapes-p5 item (i)): the POST-TRUNCATION `SkillListing`.
//
// `SkillListing` itself lives in `context/seam.ts` (the spine) so Lane S and Lane C cannot drift.
// This file is the PRODUCER, and it owns the two pinned caps in full -- Lane C receives a listing
// that is already budgeted and never re-derives either number:
//
//   `Settings.skillListingMaxDescChars`   (sdk.d.ts:5499, doc-stated default 1536) -- per-skill
//   `Settings.skillListingBudgetFraction` (sdk.d.ts:5503, doc-stated default 0.01) -- whole-listing
//
// The pinned surface BUDGETS AND TRUNCATES the listing rather than merely enumerating it; a producer
// that ignored the budget would ship a listing that grows without bound with the number of installed
// skills, which is exactly the failure the two settings exist to prevent.
import type { SkillListing } from "../context/seam.ts";
import type { SkillMeta } from "./store.ts";

/** `sdk.d.ts:5499`'s doc-stated default. */
export const DEFAULT_SKILL_LISTING_MAX_DESC_CHARS = 1536;

/** `sdk.d.ts:5503`'s doc-stated default: the fraction of the context window reserved for the listing. */
export const DEFAULT_SKILL_LISTING_BUDGET_FRACTION = 0.01;

/**
 * WINTER-DEFINED, disclosed: the budget setting is a fraction of a TOKEN window, and this producer
 * measures CHARACTERS. 4 chars/token is the conventional English-text approximation and is used
 * only to size a budget -- nothing downstream treats it as a real tokenizer, and the accountant
 * (T2's `ContextAccountant`) remains the only thing that counts real tokens. A caller that knows
 * better passes `budgetChars` directly and this constant is not consulted.
 */
export const SKILL_LISTING_CHARS_PER_TOKEN = 4;

/** Appended to a description cut by `maxDescChars`. One character, so it barely moves the budget. */
export const LISTING_TRUNCATION_SUFFIX = "…";

/**
 * `Settings.skillOverrides` (`sdk.d.ts:5651`) -- four states of per-skill visibility.
 *
 * `on` (or absent): listed to the model and invocable.
 * `name-only`: listed WITHOUT its description (the model sees it exists; the description costs nothing).
 * `user-invocable-only`: not listed to the model at all, but still resolvable by a user `/name`.
 * `off`: invisible and uninvocable.
 */
export type SkillOverride = "on" | "name-only" | "user-invocable-only" | "off";

/** Open-valued on purpose: a settings file is JSON and may carry a state a newer engine defines. */
export type SkillOverrides = Readonly<Record<string, string>>;

export interface BuildSkillListingOptions {
  maxDescChars?: number | undefined;
  budgetFraction?: number | undefined;
  contextWindowTokens?: number | undefined;
  /** An explicit character budget, bypassing the fraction x window x ratio derivation. `0` disables the budget. */
  budgetChars?: number | undefined;
  skillOverrides?: SkillOverrides | undefined;
}

/** Every name a listing/override lookup must consider: the primary plus every alias. */
function identities(skill: SkillMeta): string[] {
  return [skill.name, ...(skill.aliases ?? [])];
}

function overrideFor(overrides: SkillOverrides | undefined, skill: SkillMeta | string): string | undefined {
  if (!overrides) return undefined;
  const names = typeof skill === "string" ? [skill] : identities(skill);
  for (const name of names) {
    const value = overrides[name];
    // An override is matched against EVERY name a skill answers to, so a rule written against the
    // `.winter:<name>` spelling (the official branch's) governs the same skill Winter-native
    // discovery found under its bare name. Same obligation as permission-rules.ts's alias sweep.
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * True when the model may see this skill in the listing. An UNRECOGNISED override value reads as
 * `on`: a settings file written for a newer engine must never silently hide a skill on an older one
 * (the same "accepted, preserved, inert" posture WS-08 §1 pins for unknown hook event names).
 */
export function isModelVisible(overrides: SkillOverrides | undefined, skill: SkillMeta | string): boolean {
  const value = overrideFor(overrides, skill);
  return value !== "off" && value !== "user-invocable-only";
}

/** True when a USER `/name` may still reach this skill. Only `off` closes that door. */
export function isUserInvocable(overrides: SkillOverrides | undefined, skill: SkillMeta | string): boolean {
  return overrideFor(overrides, skill) !== "off";
}

/** The whole-listing character budget. `0`/non-finite means "no budget" -- never "no listing". */
export function skillListingBudgetChars(opts: { contextWindowTokens?: number | undefined; budgetFraction?: number | undefined; budgetChars?: number | undefined }): number {
  if (opts.budgetChars !== undefined) return Number.isFinite(opts.budgetChars) && opts.budgetChars > 0 ? opts.budgetChars : 0;
  const window = opts.contextWindowTokens;
  const fraction = opts.budgetFraction ?? DEFAULT_SKILL_LISTING_BUDGET_FRACTION;
  if (window === undefined || !Number.isFinite(window) || window <= 0 || !Number.isFinite(fraction) || fraction <= 0) return 0;
  return Math.floor(window * fraction) * SKILL_LISTING_CHARS_PER_TOKEN;
}

/**
 * Build the model-facing listing.
 *
 * ORDER IS PRECEDENCE ORDER (the index's own): project first, builtin last. That matters because the
 * budget is spent from the FRONT and stops HARD at the first entry that does not fit -- a later,
 * smaller entry never sneaks in past a dropped one. The alternative (skip-and-continue) makes the
 * listing's contents depend on description LENGTH rather than on precedence, which is neither
 * explainable to a user nor stable when one skill's description is edited.
 */
export function buildSkillListing(skills: readonly SkillMeta[], opts?: BuildSkillListingOptions): SkillListing {
  const maxDescChars = opts?.maxDescChars ?? DEFAULT_SKILL_LISTING_MAX_DESC_CHARS;
  const budget = skillListingBudgetChars({
    ...(opts?.contextWindowTokens !== undefined ? { contextWindowTokens: opts.contextWindowTokens } : {}),
    ...(opts?.budgetFraction !== undefined ? { budgetFraction: opts.budgetFraction } : {}),
    ...(opts?.budgetChars !== undefined ? { budgetChars: opts.budgetChars } : {}),
  });

  const listing: SkillListing = [];
  let spent = 0;
  for (const skill of skills) {
    if (!isModelVisible(opts?.skillOverrides, skill)) continue;
    const nameOnly = overrideFor(opts?.skillOverrides, skill) === "name-only";
    let description = nameOnly ? "" : skill.description;
    if (!nameOnly && Number.isFinite(maxDescChars) && maxDescChars > 0 && description.length > maxDescChars) {
      description = description.slice(0, maxDescChars) + LISTING_TRUNCATION_SUFFIX;
    }
    const cost = skill.name.length + description.length;
    if (budget > 0 && spent + cost > budget) break;
    spent += cost;
    listing.push({ name: skill.name, description, source: skill.source });
  }
  return listing;
}
