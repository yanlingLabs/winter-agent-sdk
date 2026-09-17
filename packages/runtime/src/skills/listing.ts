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

/**
 * claude's `Ckn`: the context window a budget is sized against when the session reports none.
 */
export const DEFAULT_SKILL_LISTING_CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * The whole-listing character budget -- claude's `Ige`: `floor(window x chars-per-token x fraction)`,
 * with claude's 200k-token default window when the session reports none (or a non-finite one).
 * An explicit `budgetChars` wins (claude's `SLASH_COMMAND_TOOL_CHAR_BUDGET` analog), and there `0`
 * means "no budget" -- a Winter extension, never "no listing".
 */
export function skillListingBudgetChars(opts: { contextWindowTokens?: number | undefined; budgetFraction?: number | undefined; budgetChars?: number | undefined }): number {
  if (opts.budgetChars !== undefined) return Number.isFinite(opts.budgetChars) && opts.budgetChars > 0 ? opts.budgetChars : 0;
  const window = opts.contextWindowTokens !== undefined && Number.isFinite(opts.contextWindowTokens) && opts.contextWindowTokens > 0 ? opts.contextWindowTokens : DEFAULT_SKILL_LISTING_CONTEXT_WINDOW_TOKENS;
  const fraction = opts.budgetFraction !== undefined && Number.isFinite(opts.budgetFraction) && opts.budgetFraction > 0 ? opts.budgetFraction : DEFAULT_SKILL_LISTING_BUDGET_FRACTION;
  return Math.max(1, Math.floor(window * SKILL_LISTING_CHARS_PER_TOKEN * fraction));
}

/**
 * claude's `xkn`: a description longer than the cap keeps `cap - 1` characters and gains the
 * ellipsis, so the result is exactly `cap` characters long.
 */
export function truncateSkillDescription(description: string, maxDescChars: number): string {
  if (!Number.isFinite(maxDescChars) || maxDescChars <= 0 || description.length <= maxDescChars) return description;
  return description.slice(0, maxDescChars - 1) + LISTING_TRUNCATION_SUFFIX;
}

/**
 * claude's per-skill line (`Mkn`): `- <name>: <description>`, or `- <name>` for an entry whose
 * description is empty (a `name-only` override, or one the budget reduced to its name).
 */
export function renderSkillListingLine(entry: { name: string; description: string }): string {
  return entry.description.length > 0 ? `- ${entry.name}: ${entry.description}` : `- ${entry.name}`;
}

/** The `skill_listing` attachment's `content`: one line per entry, newline-joined (claude's `Rot` output). */
export function renderSkillListingContent(entries: readonly { name: string; description: string }[]): string {
  return entries.map(renderSkillListingLine).join("\n");
}

/**
 * Build the model-facing listing -- claude 0.3.250's `Rot`, applied here once so every consumer sees
 * the budgeted result.
 *
 * ORDER IS PRECEDENCE ORDER (the index's own): project first, builtin last. Every visible skill is
 * listed; the budget decides only which ones keep their DESCRIPTION:
 *   - everything fits -> every line is full;
 *   - over budget -> `name-only` entries and Winter's builtin (claude: bundled) skills stay full,
 *     every other entry starts as its bare name, and descriptions are restored in priority order
 *     while the remaining budget holds them. claude orders that priority by its per-skill usage
 *     score; Winter keeps no usage history, so every score ties and precedence order decides.
 */
export function buildSkillListing(skills: readonly SkillMeta[], opts?: BuildSkillListingOptions): SkillListing {
  const maxDescChars = opts?.maxDescChars ?? DEFAULT_SKILL_LISTING_MAX_DESC_CHARS;
  const budget = skillListingBudgetChars({
    ...(opts?.contextWindowTokens !== undefined ? { contextWindowTokens: opts.contextWindowTokens } : {}),
    ...(opts?.budgetFraction !== undefined ? { budgetFraction: opts.budgetFraction } : {}),
    ...(opts?.budgetChars !== undefined ? { budgetChars: opts.budgetChars } : {}),
  });

  const entries: SkillListing = [];
  const alwaysFull = new Set<number>();
  for (const skill of skills) {
    if (!isModelVisible(opts?.skillOverrides, skill)) continue;
    const nameOnly = overrideFor(opts?.skillOverrides, skill) === "name-only";
    if (nameOnly || skill.source === "builtin") alwaysFull.add(entries.length);
    entries.push({ name: skill.name, description: nameOnly ? "" : truncateSkillDescription(skill.description, maxDescChars), source: skill.source });
  }
  if (budget <= 0 || entries.length === 0) return entries;

  const fullLength = (i: number): number => renderSkillListingLine(entries[i]!).length;
  const nameLength = (i: number): number => entries[i]!.name.length + 2;
  const total = entries.reduce((sum, _e, i) => sum + fullLength(i), 0) + (entries.length - 1);
  if (total <= budget) return entries;

  const candidates = entries.map((_e, i) => i).filter((i) => !alwaysFull.has(i));
  if (candidates.length === 0) return entries;
  let remaining = budget - (entries.reduce((sum, _e, i) => sum + (alwaysFull.has(i) ? fullLength(i) : nameLength(i)), 0) + (entries.length - 1));
  const keep = new Set<number>();
  for (const i of candidates) {
    const cost = fullLength(i) - nameLength(i);
    if (cost <= remaining) {
      keep.add(i);
      remaining -= cost;
    }
  }
  return entries.map((e, i) => (alwaysFull.has(i) || keep.has(i) ? e : { ...e, description: "" }));
}
