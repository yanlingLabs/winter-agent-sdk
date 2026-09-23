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
//  - The userContext (`userContext()`) is LIVE-REQUEST-ONLY: the engine memoizes it per session and
//    renders it as the index-0 message of every request, never into its history or the transcript.
//    SDK 0.0.16 retired 0.0.15's `userContextBlocks` (prepended to the turn's user message and
//    re-read every turn) together with Ruling P5-F's re-anchoring of them across a compaction.
//
// WHAT GOES WHERE (SDK 0.0.16, P16-5 -- claude 0.3.250's request layout):
//
//   system (static half)   the authored prompt (minimal / caller string / caller blocks / preset) --
//                          fix round 4 (I-F): minus its coding-instructions section when a style asks
//                          to drop it (`dropCodingInstructionsSection`); never the whole region.
//   system (dynamic half)  the caller's post-boundary blocks, the output style, the child persona,
//                          the plan-mode block, `# auto memory`, `# Environment`. The engine appends
//                          the systemContext `gitStatus` after these (`systemContextPlacement`).
//   userContext()          the index-0 context entries: `claudeMd` (every instructions file and the
//                          MEMORY.md index, one value), then `currentDate` -- plus, under
//                          `excludeDynamicSections`, the `Environment` and `auto memory` sections.
//   (engine attachments)   the agent listing and the skill listing are persisted attachments now
//                          (context/attachments.ts); nothing here renders them.
//
// The instructions files and the memory index are FILE CONTENT that changes underneath a running
// session. claude builds them into the userContext ONCE per session context and rebuilds it after a
// compaction; the engine memoizes `userContext()` the same way (see engine.ts's session-context
// memo), so an edit is seen after the next compaction or in a new session.
import type { RuntimeConfig, Settings, SystemPromptPreset } from "@yanlinglabs/winter-agent-sdk";
import { DEFAULT_OUTPUT_STYLE, WINTER_BRAND, envName, resolveWinterHome, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@yanlinglabs/winter-agent-sdk";
import { join } from "node:path";
import type { AssembledPrompt, SystemPromptAssembler, SystemPromptInput } from "./seam.ts";
import { renderEnvironmentContextValue, renderEnvironmentSection, renderStaticEnvironmentSection, type EnvironmentInput } from "./dynamic-sections.ts";
import { MINIMAL_PROMPT, MINIMAL_PROMPT_VERSION } from "./minimal-prompt.ts";
import { dropCodingInstructionsSection, resolvePresetSystemPrompt, WINTER_CODE_PRESET_VERSION } from "./winter-code-preset.ts";
import { discoverWinterMd, projectInstructionRoot, renderInstructionsContext, type InstructionsContextFile } from "./winter-md.ts";
import { loadRules } from "./rules.ts";
import { autoMemoryEnabled, loadMemoryIndex, MEMORY_INDEX_BASENAME, renderAutoMemoryContextValue, renderAutoMemorySection } from "./memory.ts";
import { neutralizeReminderTags } from "./injection.ts";
import { gitInstructionsEnabled } from "./git-status.ts";
import type { ContextEntry } from "./request-layout.ts";
import { memoryDirFor } from "./memory-key.ts";
import { resolveOutputStyle, type PluginOutputStyleSource, type ResolvedOutputStyle } from "./output-styles.ts";
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
  /**
   * WS-21 §6.3 item 1 (fix round 2): the session's ENABLED plugins that ship an `output-styles/`
   * directory. A plain VALUE, not a live getter like `settings` above -- a session's loaded-plugin
   * set is resolved once per incarnation (production-wiring.ts's own precedent for skills/agents/
   * MCP: plugins are not something a settings-watcher hot-reloads mid-session), so there is nothing
   * to re-read on a later `assemble()` call. Omitted means no `<plugin>:<style>` name ever resolves,
   * exactly like every pre-fix-round-2 caller.
   */
  pluginOutputStyles?: readonly PluginOutputStyleSource[];
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
  /** SDK 0.0.16: a caller block array that named a dynamic boundary (claude's cache split applies to it). */
  callerBoundary?: boolean;
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
    return { staticBlocks: systemPrompt.slice(0, at), callerDynamicBlocks: systemPrompt.slice(at + 1), authored: false, excludeDynamicSections: false, callerBoundary: true };
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

/** Everything both halves of the assembler derive from one input. */
interface ResolvedContext {
  settings: Settings | undefined;
  brand: NonNullable<RuntimeConfig["brand"]> | typeof WINTER_BRAND;
  home: string;
  settingSources: RuntimeConfig["settingSources"];
  region: PromptRegion;
  memoryDir: string | undefined;
  environment: EnvironmentInput;
}

function resolveContext(deps: SystemPromptAssemblerDeps, input: SystemPromptInput): ResolvedContext {
  const settings = deps.settings?.();
  const config = input.config;
  // P7a (D19): the session's own profile, off the config it is already reading. `WINTER_BRAND`
  // is the fallback for the configs this repository hand-builds in tests -- a live session's
  // config always carries the resolved profile (`query()` never omits it).
  const brand = config.brand ?? WINTER_BRAND;
  const home = deps.home ?? resolveWinterHome(input.env, brand);
  const region = resolveRegion(config.systemPrompt);

  // --- auto-memory ----------------------------------------------------------------------------
  //
  // PRECEDENCE, per field, and every link is tested: the HOST's option (`RuntimeConfig.autoMemory`),
  // then the settings key, then the computed default -- enabled, at
  // `<home>/projects/<memory-key>/memory`. The host wins because a host that disables settings files
  // (`settingSources: []`) otherwise has no way at all to make this session agree with it about where
  // memory lives; the two could only match by computing the same path by coincidence.
  //
  // `input.memoryDir` stays in front of all three: it is the assembler's own programmatic seam (a
  // caller that already holds a resolved directory), and no production caller sets it.
  //
  // The host's `directory` rides `memoryDirFor`'s `override` rather than being used verbatim, so it
  // gets the settings key's exact treatment: `~` expanded, a relative path resolved against the cwd,
  // whitespace-only read as ABSENT (falling through to the settings key, not to the home itself).
  // The settings key is never taken from PROJECT settings -- `OVERLAY_NEVER_KEYS` enforces that
  // upstream, in the settings layer, and this consumes whatever survived it.
  const hostMemory = config.autoMemory;
  const memoryOn = hostMemory?.enabled ?? autoMemoryEnabled(settings);
  const hostDirectory = hostMemory?.directory !== undefined && hostMemory.directory.trim().length > 0 ? hostMemory.directory : undefined;
  const directoryOverride = hostDirectory ?? settings?.autoMemoryDirectory;
  const memoryDir = memoryOn
    ? (input.memoryDir ??
      memoryDirFor({
        cwd: input.cwd,
        home,
        env: input.env,
        // WS-21 §3.7: durable, so it prefers the shared store home over the per-run folder.
        ...(config.storeHome !== undefined ? { storeHome: config.storeHome } : {}),
        ...(directoryOverride !== undefined ? { override: directoryOverride } : {}),
      }))
    : undefined;

  const environment: EnvironmentInput = {
    cwd: input.cwd,
    isGitRepo: projectInstructionRoot(input.cwd) !== null,
    platform: input.platform,
    shell: input.shell,
    osVersion: input.osVersion,
    ...(config.additionalDirectories !== undefined && config.additionalDirectories.length > 0 ? { additionalDirectories: config.additionalDirectories } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.modelDisplayName !== undefined ? { modelDisplayName: input.modelDisplayName } : {}),
  };

  return { settings, brand, home, settingSources: config.settingSources, region, memoryDir, environment };
}

export function createSystemPromptAssembler(deps: SystemPromptAssemblerDeps = {}): SystemPromptAssembler {
  return {
    assemble(input: SystemPromptInput): AssembledPrompt {
      const config = input.config;
      const { settings, brand, home, settingSources, region, memoryDir, environment } = resolveContext(deps, input);

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
          // WS-21 §6.3 item 1 (fix round 2): plugin styles, off `deps` directly -- a fixed-per-
          // incarnation value, not something `resolveContext`'s settings-driven shape needs to carry.
          ...(deps.pluginOutputStyles !== undefined ? { pluginOutputStyles: deps.pluginOutputStyles } : {}),
        });
      }
      const styleBody = style !== null && style.body.trim().length > 0 ? style.body : undefined;
      // Fix round 4 (I-F), CORRECTING M-4's mis-port: claude drops ONLY the base prompt's
      // coding-instructions section when a style exists and does not ask to keep it
      // (`M===null||M.keepCodingInstructions===!0`, dump ~276873) -- it never swaps the WHOLE
      // authored region for the style. The gate is the STYLE OBJECT existing, not whether its body is
      // non-empty (claude's own condition does not test the body at all): an empty-bodied keyless
      // style still drops the section even though it then contributes nothing to the dynamic half.
      // The style's body -- for EVERY style, dropping or not -- always lands in the dynamic half now;
      // pre-fix-round-4 code put it in the static half on the (now-retired) full-replace branch.
      const dropCodingInstructions = style !== null && !style.keepCodingInstructions;

      // --- assembly ---------------------------------------------------------------------------
      //
      // SDK 0.0.16: the dynamic sections are claude's -- `# auto memory` then `# Environment` (its
      // `memory` then `env_info_simple`), in the dynamic half. Under `excludeDynamicSections` the
      // machine-specific half of both moves into the index-0 userContext (`userContext()` below) and
      // only the model/product half of the environment stays, in the STATIC half (claude's `MGn`).
      const staticHalf: (string | undefined)[] = [
        ...region.staticBlocks.map((block) => (dropCodingInstructions ? dropCodingInstructionsSection(block) : block)),
        region.excludeDynamicSections ? renderStaticEnvironmentSection(environment) : undefined,
      ];
      const dynamicHalf: (string | undefined)[] = [
        ...region.callerDynamicBlocks,
        styleBody,
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
        region.excludeDynamicSections || memoryDir === undefined ? undefined : renderAutoMemorySection(memoryDir, brand.instructionsFile),
        region.excludeDynamicSections ? undefined : renderEnvironmentSection(environment),
      ];
      const nonEmpty = (parts: (string | undefined)[]): string[] => parts.filter((part): part is string => part !== undefined && part.trim().length > 0);
      const staticParts = nonEmpty(staticHalf);
      const dynamicParts = nonEmpty(dynamicHalf);
      const system = [...staticParts, ...dynamicParts].join("\n\n");

      // --- where the systemContext goes (claude's `ko`) ----------------------------------------
      //
      // claude computes NO systemContext for a custom system prompt (string or array), and its
      // Explore/Plan agents drop `gitStatus`; `<PREFIX>DISABLE_GIT_INSTRUCTIONS` over the
      // `includeGitInstructions` setting is its kill switch. Under `excludeDynamicSections` the
      // snapshot becomes the FIRST index-0 entry instead of the last system part.
      const gitWanted =
        region.authored &&
        input.omitProjectContext !== true &&
        gitInstructionsEnabled(input.env[envName(brand, "DISABLE_GIT_INSTRUCTIONS")], settings?.includeGitInstructions);
      const systemContextPlacement = !gitWanted ? "none" : region.excludeDynamicSections ? "userContext" : "system";

      // Phase 5 Task 8 (rider 22, RULING P5-G): the downgrade is OBSERVABLE ON THE ASSEMBLED RESULT.
      // Present only when a project-tier style genuinely asked to replace and was refused.
      return {
        system,
        systemParts: { staticParts, dynamicParts, hasBoundary: region.authored || region.callerBoundary === true },
        systemContextPlacement,
        ...(region.presetVersion !== undefined ? { presetVersion: region.presetVersion } : {}),
        ...(style?.replacementDowngraded === true ? { replacementDowngraded: true } : {}),
      };
    },

    userContext(input: SystemPromptInput): ContextEntry[] {
      const { brand, home, settingSources, region, memoryDir, environment } = resolveContext(deps, input);
      const entries: ContextEntry[] = [];

      // `claudeMd`: every instructions file (user, then each directory from the repository root down,
      // checked-in before local) and the MEMORY.md index last, as ONE value. `omitProjectContext`
      // (claude's `omitClaudeMd`) drops the whole key.
      if (input.omitProjectContext !== true) {
        // WS-21 §6.3 item 2 (fix round 1, Critical 1), CORRECTED by the router's same-view test
        // (SV-1): UNCONDITIONAL rules ride the SAME claudeMd value the instructions files do,
        // rendered after them (winter-md.ts's own ordering). `loadRules`'s `home` param is
        // `WINTER_HOME` (the per-run folder), NOT `config.storeHome` -- rules/ is a DISCOVERY read,
        // like skills/agents/commands/output-styles/instructions/settings.json/`.winter.json`
        // (spec §3.7's own "WINTER_HOME stays the run folder, for discovery only"), never a durable
        // write. The router already merges the trusted project's items and applies tier rules INTO
        // that run folder before this session starts; reading `storeHome` instead reads the wrong
        // (unfiltered, shared) tree. The project walk root is the same `projectInstructionRoot` the
        // environment section's own `isGitRepo` already resolves -- SOURCE-gates the walk (exactly
        // like `discoverWinterMd`'s own `project ∈ settingSources` gate); this layer carries no
        // trust decision of its own (winter-md.ts/output-styles.ts's own precedent: trust is
        // either the daemon's settingSources choice upstream, or a narrower in-file rule, never a
        // second gate re-litigated here).
        const rulesSources = settingSources ?? (["user", "project", "local"] as const);
        const { unconditional } = loadRules({
          home,
          cwd: input.cwd,
          projectRoot: projectInstructionRoot(input.cwd),
          sources: rulesSources,
          brand,
        });
        const files: InstructionsContextFile[] = discoverWinterMd({
          cwd: input.cwd,
          home,
          brand,
          ...(settingSources !== undefined ? { settingSources } : {}),
          ...(unconditional.length > 0 ? { rules: unconditional.map((r) => ({ path: r.path, tier: r.tier, content: r.content })) } : {}),
        }).map((b) => ({
          path: b.path,
          kind: b.scope,
          content: b.text,
        }));
        if (memoryDir !== undefined) {
          const index = loadMemoryIndex(memoryDir);
          if (index !== null) files.push({ path: join(memoryDir, MEMORY_INDEX_BASENAME), kind: "auto-memory", content: neutralizeReminderTags(index) });
        }
        const claudeMd = renderInstructionsContext(files);
        if (claudeMd !== undefined) entries.push(["claudeMd", claudeMd]);
      }

      entries.push(["currentDate", `Today's date is ${input.date}.`]);

      if (region.excludeDynamicSections) {
        entries.push(["Environment", renderEnvironmentContextValue(environment)]);
        if (memoryDir !== undefined) entries.push(["auto memory", renderAutoMemoryContextValue(memoryDir, brand.instructionsFile)]);
      }
      return entries;
    },
  };
}
