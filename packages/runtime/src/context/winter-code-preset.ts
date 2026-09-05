// Phase 5 Lane C (task 6) -- the `winter_code` preset (WS-11 §6.2, Ruling R5-9).
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
// `preset: 'claude_code'` (derived-shapes-p5 item (c)); Winter's native spelling is `winter_code`
// (WS-01 §6). Task 2 deliberately did NOT widen the union type -- widening it would make Winter's
// own `Options` reject a value the pinned SDK accepts and vice versa, breaking drop-in status. So
// the alias is resolved HERE, at runtime, where `RuntimeConfig.systemPrompt` is interpreted: that
// value arrives as JSON over `--config-json`, so `"winter_code"` can reach this code at runtime
// even though it cannot be written against the pinned type. `isWinterCodePreset` is the one place
// either spelling is recognised; nothing else in the runtime compares that literal.
import type { SystemPromptPreset } from "@yanlinglabs/winter-agent-sdk";
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
export const WINTER_CODE_PRESET_VERSION = "winter_code@1";

/** The authored preset text. Trailing whitespace trimmed once, here, so no caller has to. */
export const WINTER_CODE_PRESET: string = presetText.trim();

/**
 * Both accepted spellings of the preset. The pinned `claude_code` is a compatibility alias in
 * Winter's direction of travel; `winter_code` is the native one (WS-01 §6).
 */
export const WINTER_CODE_PRESET_NAMES: readonly string[] = ["claude_code", "winter_code"] as const;

export function isWinterCodePreset(preset: string): boolean {
  return WINTER_CODE_PRESET_NAMES.includes(preset);
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
