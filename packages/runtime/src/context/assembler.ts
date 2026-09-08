// Phase 5 Lane C (task 6) -- `createSystemPromptAssembler`: the ONE producer of a system prompt in
// the Winter runtime, implementing Ruling R5-9 as amended by derived-shapes-p5 item (c).
//
// THE SEAM'S AUTHORITY IS `seam.contract.test.ts` (Task 3). This file implements
// `SystemPromptAssembler`; the engine calls `assemble()` ONCE PER USER ENVELOPE and puts the result
// on the live request. Three consequences that shape everything below:
//
//  - `assemble()` is SYNCHRONOUS, so every filesystem read here is synchronous. That is not an
//    oversight in the seam: the assembler runs on the turn's critical path, once, and an async
//    seam would put an await between the engine deciding to generate and generating.
//  - The result must be STABLE ACROSS THE TURN'S TOOL ROUNDS. Nothing here reads a clock or a
//    counter; every input arrives on `SystemPromptInput`, so the same envelope cannot produce two
//    different prompts and break provider prompt caching mid-turn.
//  - `userContextBlocks` are LIVE-REQUEST-ONLY. They never enter the engine's history and are
//    never persisted -- see the seam's own doc, and Ruling P5-F for how they re-anchor across a
//    compaction. Nothing in this file assumes anything about where they land beyond "the turn's
//    user message".
//
// WHAT GOES IN `system` VS `userContextBlocks`:
//
//   system            the authored prompt (minimal / caller string / caller blocks / preset),
//                     the output style, the child persona, the plan-mode block, the skill listing,
//                     and -- unless moved -- the dynamic sections.
//   userContextBlocks the dynamic sections WHEN MOVED (always first, per R5-9), then WINTER.md
//                     (user, then project outermost-to-innermost), then auto-memory.
//
// The split is not stylistic. `system` is the cacheable, session-stable half; the user-context
// blocks are file content that changes underneath a running session, and putting them in `system`
// would either poison prompt caching or go stale for the rest of a long session. The seam's own
// doc names WINTER.md and the memory index as exactly what R5-9's "always injected as
// user-context" means operationally.
import type { RuntimeConfig, Settings, SystemPromptPreset } from "@yanlinglabs/winter-agent-sdk";
import { DEFAULT_OUTPUT_STYLE, WINTER_BRAND, resolveWinterHome, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@yanlinglabs/winter-agent-sdk";
import type { AssembledPrompt, SkillListing, SystemPromptAssembler, SystemPromptInput } from "./seam.ts";
import { renderDynamicSections } from "./dynamic-sections.ts";
import { MINIMAL_PROMPT, MINIMAL_PROMPT_VERSION } from "./minimal-prompt.ts";
import { resolvePresetSystemPrompt, WINTER_CODE_PRESET_VERSION } from "./winter-code-preset.ts";
import { discoverWinterMd } from "./winter-md.ts";
import { autoMemoryEnabled, renderMemoryBlock } from "./memory.ts";
import { memoryDirFor } from "./memory-key.ts";
import { resolveOutputStyle, type ResolvedOutputStyle } from "./output-styles.ts";
import { renderPlanModeBlock } from "./plan-mode.ts";

export interface SystemPromptAssemblerDeps {
  /**
   * The resolved winter home. Omitted resolves from `SystemPromptInput.env` (so `<PREFIX>HOME` is
   * honoured per session, not per process). Tests pass an mkdtemp directory here rather than
   * touching a real home.
   */
  home?: string;
  /**
   * A LIVE GETTER over the resolved effective settings, read afresh on every `assemble()`.
   *
   * A getter and not a value, deliberately: the product rule (WS-11 §5, and Norma's shipped
   * settings-watcher convention) is that no setting may require a restart to take effect. Handing
   * the assembler a settings SNAPSHOT at construction would make `outputStyle`, `autoMemoryEnabled`,
   * `autoMemoryDirectory` and `plansDirectory` frozen for the life of a session, and the failure
   * would be invisible -- the assembler would keep working, just with stale values.
   */
  settings?: () => Settings | undefined;
}

/** A `{ type: "preset" }` object, recognised structurally: it arrives as JSON over `--config-json`. */
function isPresetOption(value: RuntimeConfig["systemPrompt"]): value is SystemPromptPreset {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (value as { type?: unknown }).type === "preset";
}

/** The authored prompt region, plus everything about the arm the rest of assembly needs to know. */
interface PromptRegion {
  /** Blocks that form the cacheable prefix. Only the `string[]` arm can contribute more than one. */
  staticBlocks: string[];
  /** The caller's own session-specific blocks (the `string[]` arm's half after the boundary). */
  callerDynamicBlocks: string[];
  /** Winter's own authored text produced this region, so a style may replace it and a version is stamped. */
  authored: boolean;
  presetVersion?: string;
  /** WS-11 §6.3, and INERT unless the preset arm asked for it (item (c): its own pinned doc says so). */
  excludeDynamicSections: boolean;
}

/**
 * Phase 5 residual round (T8 re-review NEW-1): "would an output style apply at all?", for a caller
 * that needs the answer WITHOUT assembling a prompt.
 *
 * `production-wiring.ts` resolves the style a second time to report RULING P5-G's downgrade as an
 * operator warning, and had no equivalent of the `region.authored` guard below -- so with a
 * caller-supplied `systemPrompt` it told the operator the style "has been applied as an ADDITION"
 * when it was not applied in any form.
 *
 * EXPORTED RATHER THAN HAND-MIRRORED. The condition is one line today ("a string or an array
 * replaces the prompt"), and one line is exactly what gets copied and then drifts -- this codebase
 * has four hand-mirrored copies of one trust predicate already, kept in step only by a tripwire
 * test. One implementation, two callers, no drift possible.
 */
export function isAuthoredPromptRegion(systemPrompt: RuntimeConfig["systemPrompt"]): boolean {
  return resolveRegion(systemPrompt).authored;
}

function resolveRegion(systemPrompt: RuntimeConfig["systemPrompt"]): PromptRegion {
  if (systemPrompt === undefined) {
    return { staticBlocks: [MINIMAL_PROMPT], callerDynamicBlocks: [], authored: true, presetVersion: MINIMAL_PROMPT_VERSION, excludeDynamicSections: false };
  }

  if (typeof systemPrompt === "string") {
    // R5-9: a string REPLACES the authored prompt entirely. No version is stamped -- nothing Winter
    // authored produced this region, and `presetVersion` exists to identify Winter's own text.
    return { staticBlocks: [systemPrompt], callerDynamicBlocks: [], authored: false, excludeDynamicSections: false };
  }

  if (Array.isArray(systemPrompt)) {
    // Item (c): a STANDALONE `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` element splits the globally-cacheable
    // prefix from the session-specific suffix. `indexOf` is exact element equality, which is what
    // makes an element that merely CONTAINS the sentinel ordinary text rather than a boundary.
    // Only the FIRST boundary splits; later ones are ordinary blocks in the dynamic half.
    const at = systemPrompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    if (at === -1) return { staticBlocks: [...systemPrompt], callerDynamicBlocks: [], authored: false, excludeDynamicSections: false };
    return { staticBlocks: systemPrompt.slice(0, at), callerDynamicBlocks: systemPrompt.slice(at + 1), authored: false, excludeDynamicSections: false };
  }

  if (isPresetOption(systemPrompt)) {
    // An UNRECOGNISED preset spelling still gets the one preset Winter has. `type: "preset"` is
    // itself the request, the pinned union is a closed one-member literal so any other value is a
    // typo or a future alias, and falling back to the MINIMAL prompt would hand a caller who asked
    // for the full product preset the exact opposite of it, silently. `isWinterCodePreset`
    // (winter-code-preset.ts) remains the recogniser for the two canonical spellings.
    return {
      staticBlocks: [resolvePresetSystemPrompt(systemPrompt)],
      callerDynamicBlocks: [],
      authored: true,
      presetVersion: WINTER_CODE_PRESET_VERSION,
      excludeDynamicSections: systemPrompt.excludeDynamicSections === true,
    };
  }

  // Structurally unrecognised (a malformed `--config-json` payload). Behave as if unset rather than
  // throwing: `assemble()` has no error channel and a throw here would kill the turn.
  return { staticBlocks: [MINIMAL_PROMPT], callerDynamicBlocks: [], authored: true, presetVersion: MINIMAL_PROMPT_VERSION, excludeDynamicSections: false };
}

/**
 * The skill listing (R5-17). Lane S owns discovery, ordering and truncation; this only places the
 * listing, so nothing here re-derives `skillListingMaxDescChars` / `skillListingBudgetFraction`.
 */
function renderSkillListing(listing: SkillListing): string {
  return [
    "## Available skills",
    "Call the `Skill` tool with one of these names to load its full instructions before you rely on it. The one-line description is all you have until you do.",
    ...listing.map((s) => `- **${s.name}** (${s.source}) — ${s.description}`),
  ].join("\n");
}

export function createSystemPromptAssembler(deps: SystemPromptAssemblerDeps = {}): SystemPromptAssembler {
  return {
    assemble(input: SystemPromptInput): AssembledPrompt {
      const settings = deps.settings?.();
      const config = input.config;
      // P7a (D19): the session's own profile, off the config it is already reading. `WINTER_BRAND`
      // is the fallback for the configs this repository hand-builds in tests -- a live session's
      // config always carries the resolved profile (`query()` never omits it).
      const brand = config.brand ?? WINTER_BRAND;
      const home = deps.home ?? resolveWinterHome(input.env, brand);
      const settingSources = config.settingSources;
      const region = resolveRegion(config.systemPrompt);

      // --- auto-memory ------------------------------------------------------------------------
      //
      // PRECEDENCE, and every link is tested: an explicit host-supplied directory, then the
      // settings key, then the computed `<home>/projects/<memory-key>/memory`. The settings key is
      // never taken from PROJECT settings -- `OVERLAY_NEVER_KEYS` enforces that upstream, in the
      // settings layer, and this consumes whatever survived it.
      const memoryOn = autoMemoryEnabled(settings);
      const memoryDir = memoryOn ? (input.memoryDir ?? memoryDirFor({ cwd: input.cwd, home, env: input.env, ...(settings?.autoMemoryDirectory !== undefined ? { override: settings.autoMemoryDirectory } : {}) })) : undefined;

      // --- the dynamic block ------------------------------------------------------------------
      const dynamic = renderDynamicSections({
        cwd: input.cwd,
        platform: input.platform,
        osVersion: input.osVersion,
        shell: input.shell,
        date: input.date,
        ...(input.gitSummary !== undefined ? { gitSummary: input.gitSummary } : {}),
        ...(memoryDir !== undefined ? { memoryDir } : {}),
      });

      // --- the output style -------------------------------------------------------------------
      //
      // PRECEDENCE: the assembler input (a child inheriting its parent's style, §6.5), then the
      // session's own config, then the settings file, then the pinned default name.
      //
      // SUPPRESSED ENTIRELY FOR A CALLER-SUPPLIED PROMPT. When the caller passed a string or a
      // block array they replaced the prompt; Winter does not then edit their text. This is Norma's
      // shipped `basePromptOverride` rule, which skips styles for exactly the same reason. A style
      // that could rewrite an explicit `systemPrompt` would make that option non-deterministic from
      // the host's side, which is the one thing R5-9's "replaces it entirely" rules out.
      let style: ResolvedOutputStyle | null = null;
      if (region.authored) {
        const styleName = input.outputStyle ?? config.outputStyle ?? settings?.outputStyle ?? DEFAULT_OUTPUT_STYLE;
        style = resolveOutputStyle(styleName, {
          cwd: input.cwd,
          home,
          brand,
          ...(settingSources !== undefined ? { settingSources } : {}),
          ...(config.trustedWorkspace !== undefined ? { trustedWorkspace: config.trustedWorkspace } : {}),
        });
      }
      const styleBody = style !== null && style.body.trim().length > 0 ? style.body : undefined;
      // A replacing style substitutes for the AUTHORED region only -- never for a caller's blocks
      // (they cannot reach here) and never for the mechanics below it.
      const replaceRegion = styleBody !== undefined && style !== null && !style.keepBasePrompt;

      // --- assembly ---------------------------------------------------------------------------
      const staticHalf = replaceRegion ? [styleBody as string] : region.staticBlocks;
      const dynamicHalf: (string | undefined)[] = [
        ...region.callerDynamicBlocks,
        replaceRegion ? undefined : styleBody,
        input.agentPrompt,
        // P7a (D19): the plans-directory default follows the session's OWN project dot-dir, not the
        // module-level `DEFAULT_PLANS_DIRECTORY` (which is Winter's). Byte-identical under
        // `WINTER_BRAND`; a reuser gets `<their dir>/plans` instead of being sent into Winter's own.
        input.planMode
          ? renderPlanModeBlock({
              plansDirectory: config.plansDirectory ?? settings?.plansDirectory ?? `${brand.projectDirName}/plans`,
              // P7a fix r1 (Minor-1): and the REFUSAL fallback follows the brand too, or a malformed
              // project setting sends the model to Winter's own directory.
              plansDirectoryFallback: `${brand.projectDirName}/plans`,
              ...(input.hostPlanBody !== undefined ? { hostPlanBody: input.hostPlanBody } : {}),
            })
          : undefined,
        input.skillListing !== undefined && input.skillListing.length > 0 ? renderSkillListing(input.skillListing) : undefined,
        region.excludeDynamicSections ? undefined : dynamic,
      ];

      const system = [...staticHalf, ...dynamicHalf]
        .filter((part): part is string => part !== undefined && part.trim().length > 0)
        .join("\n\n");

      // --- user context, in the pinned order --------------------------------------------------
      //
      // The moved dynamic block is FIRST, which is R5-9's own wording ("the first user-context
      // block") and not an ordering choice: a host that moved it did so to get a cacheable prefix,
      // and the environment has to precede the instructions that depend on it.
      const userContextBlocks: string[] = [];
      if (region.excludeDynamicSections) userContextBlocks.push(dynamic);
      for (const block of discoverWinterMd({ cwd: input.cwd, home, brand, ...(settingSources !== undefined ? { settingSources } : {}) })) userContextBlocks.push(block.text);
      if (memoryDir !== undefined) userContextBlocks.push(renderMemoryBlock(memoryDir, brand.instructionsFile));

      // Phase 5 Task 8 (rider 22, RULING P5-G): the downgrade is OBSERVABLE ON THE ASSEMBLED RESULT,
      // not only on `resolveOutputStyle`'s return value -- which no host calls and no frame carries,
      // so the ruling's "observable" clause held nowhere a caller could see it. Present only when a
      // project-tier style genuinely asked to replace and was refused; absent (never `false`)
      // otherwise, so nothing about a session with no project style moves.
      return {
        system,
        userContextBlocks,
        ...(region.presetVersion !== undefined ? { presetVersion: region.presetVersion } : {}),
        ...(style?.replacementDowngraded === true ? { replacementDowngraded: true } : {}),
      };
    },
  };
}
