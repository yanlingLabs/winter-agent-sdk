// Phase 5 Lane C (task 6) -- the authored product preset, named `brand.presetName` (WS-11 §6.2, Ruling R5-9).
//
// INDEPENDENTLY AUTHORED, BY CONSTRUCTION. The vendor's own preset is observable for a pinned run
// and proprietary; copying it is prohibited (WS-11 §6.2). The text in `presets/winter-code.md` was
// written from two inputs only: WS-11 §6.2's list of CATEGORIES the preset must cover -- task
// execution, careful actions, tools, tone/style, session guidance, auto memory, environment,
// context management -- and Winter's own semantics for each. No vendor declaration file was opened
// for this lane and no vendor prompt text was read, quoted or paraphrased. Conformance against the
// pinned product is therefore STRUCTURAL and BEHAVIOURAL (does it cover the categories, does the
// agent behave the way the category demands), never textual, which is exactly what §6.2 asks for.
//
// THE ALIAS, AND WHERE IT IS RESOLVED. The pinned `systemPrompt` union carries the CLOSED literal
// `preset: 'claude_code'` (derived-shapes-p5 item (c)) -- a Claude-MIRRORING literal that stays
// fixed (WS-01 §5); the native spelling is `brand.presetName` (WS-01 §6). Task 2 deliberately did
// NOT widen the union type -- widening it would make Winter's own `Options` reject a value the
// pinned SDK accepts and vice versa, breaking drop-in status. So the alias is resolved HERE, at
// runtime, where `RuntimeConfig.systemPrompt` is interpreted: that value arrives as JSON over
// `--config-json`, so the native spelling can reach this code at runtime even though it cannot be
// written against the pinned type. `isWinterCodePreset` is the one place either spelling is
// recognised; nothing else in the runtime compares that literal.
//
// P7a (D19): the preset TEXT is unchanged by a rebrand -- only its NAME follows the profile. The
// version stamp below deliberately keeps Winter's own token: it attributes WHICH authored text a
// conformance run compared, and that text is Winter's whoever is running it.
import { WINTER_BRAND, type BrandProfile, type SystemPromptPreset } from "@yanlinglabs/winter-agent-sdk";
import presetText from "./presets/winter-code.md" with { type: "text" };

/**
 * The categories WS-11 §6.2 requires, in the order the document lists them. Each is a `## `
 * heading in the preset, which is what makes coverage checkable by a test rather than by a reader.
 */
export const WINTER_CODE_PRESET_CATEGORIES: readonly string[] = [
  "Task execution",
  "Careful actions",
  "Tools",
  "Tone and style",
  "Session guidance",
  "Auto memory",
  "Environment",
  "Context management",
] as const;

/**
 * Bump on any edit to `presets/winter-code.md`. WS-11 §6.2 requires the preset to be versioned so a
 * conformance run can say WHICH authored preset it compared, and so a behaviour change is
 * attributable to a prompt revision rather than to a model.
 */
export const WINTER_CODE_PRESET_VERSION = `${WINTER_BRAND.presetName}@1`;

/** The authored preset text. Trailing whitespace trimmed once, here, so no caller has to. */
export const WINTER_CODE_PRESET: string = presetText.trim();

/**
 * Both accepted spellings of the preset for a given brand. `claude_code` is the Claude-mirroring
 * compatibility alias (WS-01 §5, never rebranded); `brand.presetName` is the native one (WS-01 §6).
 */
export function winterCodePresetNames(brand?: Pick<BrandProfile, "presetName">): readonly string[] {
  return ["claude_code", (brand ?? WINTER_BRAND).presetName];
}

/** The default profile's pair, for every caller that has not threaded a brand. */
export const WINTER_CODE_PRESET_NAMES: readonly string[] = winterCodePresetNames();

export function isWinterCodePreset(preset: string, brand?: Pick<BrandProfile, "presetName">): boolean {
  return winterCodePresetNames(brand).includes(preset);
}

/**
 * The preset arm's system text: the preset, then `append`.
 *
 * `append` ADDS; it never replaces any part of the preset (WS-11 §6.2). A whitespace-only append is
 * treated as absent so a host that always sets the field from an optional config value does not get
 * a trailing blank section.
 */
export function resolvePresetSystemPrompt(preset: SystemPromptPreset): string {
  const append = preset.append?.trim();
  if (append === undefined || append.length === 0) return WINTER_CODE_PRESET;
  return `${WINTER_CODE_PRESET}\n\n${append}`;
}
