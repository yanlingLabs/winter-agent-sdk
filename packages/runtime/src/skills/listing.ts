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

/** The context window (tokens) a budget is sized against when the session reports none. */
export const DEFAULT_SKILL_LISTING_CONTEXT_WINDOW_TOKENS = 200_000;

/** The whole-listing character budget: an explicit `budgetChars` (`0` = no budget), or a share of the context window in characters. */
export function skillListingBudgetChars(opts: { contextWindowTokens?: number | undefined; budgetFraction?: number | undefined; budgetChars?: number | undefined }): number {
  // An explicit budget wins outright; anything that is not a usable positive number means "no budget".
  if (opts.budgetChars !== undefined) return isPositiveFinite(opts.budgetChars) ? opts.budgetChars : 0;
  const window = isPositiveFinite(opts.contextWindowTokens) ? opts.contextWindowTokens : DEFAULT_SKILL_LISTING_CONTEXT_WINDOW_TOKENS;
  const fraction = isPositiveFinite(opts.budgetFraction) ? opts.budgetFraction : DEFAULT_SKILL_LISTING_BUDGET_FRACTION;
  return Math.max(1, Math.floor(window * SKILL_LISTING_CHARS_PER_TOKEN * fraction));
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Length of an entry's rendered line (see `renderSkillListingLine`), without building the string. */
function lineLength(name: string, description: string): number {
  return description.length > 0 ? 4 + name.length + description.length : 2 + name.length;
}

/**
 * A description longer than the cap keeps `cap - 1` characters and gains the ellipsis, so the result
 * is exactly `cap` characters long (the same shape claude's listing uses).
 */
export function truncateSkillDescription(description: string, maxDescChars: number): string {
  if (!Number.isFinite(maxDescChars) || maxDescChars <= 0 || description.length <= maxDescChars) return description;
  return description.slice(0, maxDescChars - 1) + LISTING_TRUNCATION_SUFFIX;
}

/**
 * One listing line: `- <name>: <description>`, or `- <name>` for an entry whose description is
 * empty (a `name-only` override, or one the budget reduced to its name).
 */
export function renderSkillListingLine(entry: { name: string; description: string }): string {
  return entry.description.length > 0 ? `- ${entry.name}: ${entry.description}` : `- ${entry.name}`;
}

/** The `skill_listing` attachment's `content`: one line per entry, newline-joined. */
export function renderSkillListingContent(entries: readonly { name: string; description: string }[]): string {
  return entries.map(renderSkillListingLine).join("\n");
}

/** The model-facing listing: every visible skill, with the budget deciding which keep their description. */
export function buildSkillListing(skills: readonly SkillMeta[], opts?: BuildSkillListingOptions): SkillListing {
  const cap = opts?.maxDescChars ?? DEFAULT_SKILL_LISTING_MAX_DESC_CHARS;
  const budget = skillListingBudgetChars({
    contextWindowTokens: opts?.contextWindowTokens,
    budgetFraction: opts?.budgetFraction,
    budgetChars: opts?.budgetChars,
  });

  // One entry per model-visible skill, in the given order. `fixed` entries always keep their line
  // as is: a name-only override already has no description, and builtin skills are never trimmed.
  const entries: SkillListing = [];
  const fixed: boolean[] = [];
  for (const skill of skills) {
    if (!isModelVisible(opts?.skillOverrides, skill)) continue;
    const nameOnly = overrideFor(opts?.skillOverrides, skill) === "name-only";
    const description = nameOnly ? "" : truncateSkillDescription(skill.description, cap);
    entries.push({ name: skill.name, description, source: skill.source });
    fixed.push(nameOnly || skill.source === "builtin");
  }

  if (!(budget > 0) || entries.length === 0) return entries;

  const separators = entries.length - 1;
  let fullSize = separators;
  for (const e of entries) fullSize += lineLength(e.name, e.description);
  if (fullSize <= budget) return entries;

  if (fixed.every(Boolean)) return entries;

  // Start with every trimmable entry reduced to its bare name, then give descriptions back in
  // listing order to each one whose extra cost still fits; a skipped entry does not stop the walk.
  let remaining = budget - separators;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    remaining -= fixed[i] ? lineLength(e.name, e.description) : lineLength(e.name, "");
  }
  const out: SkillListing = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (fixed[i]) {
      out.push(e);
      continue;
    }
    const cost = lineLength(e.name, e.description) - lineLength(e.name, "");
    if (cost <= remaining) {
      remaining -= cost;
      out.push(e);
    } else {
      out.push({ name: e.name, description: "", source: e.source });
    }
  }
  return out;
}
