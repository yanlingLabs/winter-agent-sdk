// Phase 5 Task 8: THE ONE PLACE every P5 lane's implementation is wired into a live session.
//
// WHY A SHARED HELPER AND NOT TWO CALL SITES. Winter runs on three transport legs -- the in-memory
// harness (`testing.ts`'s `inMemoryProcess`), a real spawned `winter` child, and the compiled binary
// (both `main.ts`) -- and WS-04 §12 makes a divergence between them a release blocker rather than a
// test nuisance. Four P5 lanes shipped behind seams that are INERT until something registers them;
// registering them at one entrypoint and not the other would give a session a system prompt, skills,
// slash commands and compaction on two legs and not the third, silently. `subagents/
// register-default-factory.ts` is the established precedent for exactly this shape and exactly this
// reason -- both entrypoints call one function, so all three legs derive from one piece of code.
//
// WHAT IT DOES NOT DO. Three registrations that need values only reachable from INSIDE `runEngine`'s
// closure stay in `engine.ts`: the workflow session (its `sessionTempDir`, `ContextAccountant` and
// `structuredOutput` are engine-local), the MCP lifecycle (its `ElicitationSender` is the run's own
// `bridge`), and the command hook invoker (it must wrap the run's own `bridge` invoker). This module
// produces the plain-data INPUTS those need and hands them over as `EngineOptions` fields.
//
// EVERYTHING HERE IS RESOLVED ONCE PER SESSION, before the first turn. That is the SDK-level shape:
// WS-11 §5's "no setting may require a restart" is a PRODUCT rule above the SDK boundary (a daemon
// re-resolves and hands down a new getter), so this module starts no watchers. What it does supply
// is a live GETTER rather than a snapshot, so a host that re-resolves does not have to rebuild the
// assembler -- see `SystemPromptAssemblerDeps.settings`' own header for why a snapshot would fail
// invisibly.
import type { InitPluginInfo, RuntimeConfig, Settings, SettingSource } from "@yanlinglabs/winter-agent-sdk";
import { OVERLAY_NEVER_KEYS, resolveWinterHome } from "@yanlinglabs/winter-agent-sdk";
import { resolveSettingsDetailed } from "./settings/resolve.ts";
import type { DetailedResolvedSettings } from "./settings/resolve.ts";
import { defaultTrustSource } from "./settings/trust.ts";
import { loadPlugins } from "./plugins/loader.ts";
import { pluginAgentDefinitions, pluginCommandContributions, pluginInitInfo, pluginSkillContributions } from "./plugins/bundle.ts";
import { SkillIndex } from "./skills/store.ts";
import { buildSkillListing, type SkillOverrides } from "./skills/listing.ts";
import { autoSkillPermissionEntries, isSkillEnabled, validateSkillsOption } from "./skills/option.ts";
import { registerSkillSessionRuntime, clearSkillSessionRuntime } from "./skills/runtime.ts";
import { FilesystemCommandResolver } from "./commands/resolver.ts";
import { slashCommandNames } from "./commands/builtins-listing.ts";
import { settingsHookSourceInputs, pluginHookEntries } from "./settings/loaders/hooks.ts";
import { buildHookEntriesFromSettings } from "./hooks/from-config.ts";
import type { SourcedHookEntry } from "./hooks/registry.ts";
import { loadProjectMcpConfig, settingsMcpServerSources } from "./settings/loaders/mcp-config.ts";
import { pluginMcpServerSources } from "./settings/loaders/plugin-mcp.ts";
import type { McpServerSource } from "./mcp/lifecycle.ts";
import { createSystemPromptAssembler } from "./context/assembler.ts";
import type { SkillListing, SystemPromptAssembler } from "./context/seam.ts";
import { createCompactionController } from "./compaction/controller.ts";
import type { CompactionController } from "./compaction/seam.ts";
import { createStructuredOutputSeam } from "./structured/ajv-seam.ts";
import type { StructuredOutputSeam } from "./structured/seam.ts";
import { createFileCheckpointSink } from "./checkpoint/sink.ts";
import type { FileCheckpointSink } from "./checkpoint/seam.ts";
import { registerPluginAgents, clearPluginAgents } from "./subagents/plugin-agents.ts";
import type { PluginAgentDefinition } from "./subagents/definitions.ts";
import type { StrictPluginOnlyCustomization } from "./settings/loaders/strict-plugin-only.ts";
import { DEFAULT_OUTPUT_STYLE } from "@yanlinglabs/winter-agent-sdk";

// --- narrowing the six undeclared settings keys ---------------------------------------------------
//
// Lane S's "What T8 must wire" item 6b, verbatim: `skillOverrides`, `disableBundledSkills`,
// `strictPluginOnlyCustomization`, `skillListingMaxDescChars`, `skillListingBudgetFraction` and
// `mcpServers` are all consumed by a lane but NOT declared on Winter's `Settings`, so they arrive on
// its `[key: string]: unknown` index signature. Every consumer below takes a typed parameter, so
// each one is narrowed HERE, once, rather than cast at four call sites.
//
// A malformed value is DROPPED, never coerced: reading `skillListingMaxDescChars: "lots"` as a
// number would silently truncate the listing to nothing, and every one of these has a documented
// default that is safer than a guess. `types.ts` gains real declarations in the same commit as this
// module; these narrowings stay because the index signature remains reachable for keys written by a
// newer engine (WS-08 §1's "accepted, preserved, inert" posture).

function asBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function asFiniteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asSkillOverrides(v: unknown): SkillOverrides | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out as SkillOverrides;
}

function asStrictPluginOnly(v: unknown): StrictPluginOnlyCustomization | undefined {
  if (typeof v === "boolean") return v;
  if (Array.isArray(v) && v.every((item) => typeof item === "string")) return v as readonly string[];
  return undefined;
}

/**
 * RIDER 24: the assembler's `deps.settings` MUST be the post-`OVERLAY_NEVER_KEYS` EFFECTIVE getter.
 *
 * `resolveSettings`' `effective` already applies the filter (`withoutOverlayNeverKeys`, applied to
 * the project tier only). A caller reaching for `perSource[i].values` or a raw file would let a
 * repo-committed `.winter/settings.json` set `autoMemoryDirectory` -- pointing this session's memory
 * at a directory the repository chose, which is precisely the self-grant P5-A closes elsewhere.
 *
 * Asserted rather than merely documented: nothing about the two shapes differs structurally, so a
 * future edit swapping one for the other would type-check and pass every test. This throws at
 * session construction, which is loud and early, rather than degrading a live session.
 */
export function assertEffectiveSettings(settings: Settings | undefined, resolved: DetailedResolvedSettings): void {
  if (settings === undefined) return;
  const view = settings as Record<string, unknown>;
  const effective = resolved.effective as Record<string, unknown>;
  for (const key of OVERLAY_NEVER_KEYS) {
    // COMPARED BY VALUE, not by presence. A presence check is defeated by the case that matters most:
    // when the project tier AND a higher tier both set the key, a raw project view has the SAME
    // presence as `effective` and a different VALUE -- so the project's value would sail through a
    // presence test while being exactly what OVERLAY_NEVER_KEYS exists to drop.
    if (view[key] === effective[key]) continue;
    throw new Error(
      `winter: production wiring was handed a RAW settings view -- "${key}" differs from resolveSettings().effective, which is the only view OVERLAY_NEVER_KEYS has been applied to. Hand the assembler \`effective\`, never a per-source value.`,
    );
  }
}

export interface ProductionWiringOptions {
  /** The session's EFFECTIVE config (post-`resolveEngineSession`), never the raw pre-resolution one. */
  config: RuntimeConfig;
  /** The environment governing `WINTER_HOME` and every env-derived read below. Explicit at both entrypoints. */
  env: Record<string, string | undefined>;
  /**
   * The resolved `~/.winter` root -- `config.winterHome ?? resolveWinterHome(env)`. Passed rather
   * than re-derived so this module and `resolveEngineSession` can never disagree about where a
   * session lives (Lane S's judgment call 10: the two conventions in this codebase are not
   * interchangeable, and picking the wrong one silently empties the user tier).
   */
  winterHome?: string;
  // NO `permissionHome` HERE, deliberately. Nothing this module builds needs the OS home: the skill
  // index, the command resolver and the settings resolution are all addressed by the RESOLVED winter
  // root, and `loadAgentDefinitions` (the one consumer that takes an OS home and appends `.winter`
  // itself) is called from `engine.ts` and `tools/impl/agent.ts`, both of which already hold
  // `permissionHome`. An unused option here would be a second place for the two conventions to be
  // confused -- which is the exact hazard `SkillIndexOptions.winterHome`'s own header describes.
  /**
   * The session's durable transcript sink (`resolveEngineSession`'s own `store`), so the two P5
   * dialect entries have somewhere to land: Lane S's `invoked_skills` attachment and Lane K's
   * `file-history-*` records. Omitted for a non-persistent session, in which case both are simply
   * never written -- exactly as a session with no store has no durable anything.
   */
  persistence?: {
    recordInvokedSkills?(attachment: { type: string; skills: unknown[] }): void | Promise<void>;
    recordFileHistory?(record: { kind: "snapshot" | "delta"; userMessageUuid: string; path: string; pathHash: string; tool: string; at: string; version: number; absent?: boolean; parentRealPath?: string; anchorPath?: string; anchorRealPath?: string }): void | Promise<void>;
  };
}

export interface ProductionWiring {
  /** Spread into `runEngine({...})`. Every field is one of `EngineOptions`' own P5 seams or init inputs. */
  engineOptions: {
    winterHome: string;
    systemPromptAssembler: SystemPromptAssembler;
    commandResolver: FilesystemCommandResolver;
    compactionController: CompactionController;
    structuredOutput: StructuredOutputSeam;
    fileCheckpointSink?: FileCheckpointSink;
    extraHookEntries: readonly SourcedHookEntry[];
    extraMcpServerSources: readonly McpServerSource[];
    initSlashCommands: readonly string[];
    initSkills: readonly string[];
    initPlugins: readonly InitPluginInfo[];
    initOutputStyle: string;
    skillListing: SkillListing;
  };
  /**
   * Mirrors handed to `registerDefaultChildEngineFactory`, so a CHILD engine gets the same context
   * surface its parent does -- see that function's own fields for the two gaps this closes.
   */
  childFactoryOptions: {
    systemPromptAssembler: SystemPromptAssembler;
    skillRuntime: { index: SkillIndex; skillOverrides?: SkillOverrides };
    structuredOutput: StructuredOutputSeam;
  };
  /**
   * Non-fatal problems worth telling a host about: a malformed `.winter/mcp.json`, a plugin that
   * would not load, a `skills` option naming something unknown. NEVER thrown -- Lane S's
   * `validateSkillsOption` returns a result precisely so the decision is the caller's, and a broken
   * plugin must not take a session down (`loadPlugins` returns rejections for the same reason).
   */
  warnings: readonly string[];
  /** Withdraws every session-keyed registration. Called on teardown; `main.ts` may skip it (the process exits). */
  dispose(): void;
}

/**
 * Build every P5 seam for one session.
 *
 * STARTUP ORDER IS LOAD-BEARING and follows Lane S's recipe exactly -- each step's input is the
 * previous step's output: settings -> plugins -> skill index -> skills-option validation -> command
 * resolver. Reordering it silently produces an index with no plugin skills, or a resolver whose
 * `/name` set disagrees with the model's own listing.
 */
export async function buildProductionWiring(opts: ProductionWiringOptions): Promise<ProductionWiring> {
  const { config, env } = opts;
  const winterHome = opts.winterHome ?? config.winterHome ?? resolveWinterHome(env);
  const warnings: string[] = [];
  const settingSources: SettingSource[] | undefined = config.settingSources;

  // (1) SETTINGS. One resolution per session; `effective` is what every consumer below reads.
  const resolved = await resolveSettingsDetailed({
    cwd: config.cwd,
    winterHome,
    env,
    ...(settingSources !== undefined ? { settingSources } : {}),
  });
  const effective = resolved.effective;
  assertEffectiveSettings(effective, resolved);
  // A LIVE GETTER, not the value: see the field's own header on `SystemPromptAssemblerDeps`.
  const settingsGetter = (): Settings | undefined => effective;

  const skillOverrides = asSkillOverrides(effective["skillOverrides"]);
  const disableBundledSkills = asBoolean(effective["disableBundledSkills"]);
  const strictPluginOnlyCustomization = asStrictPluginOnly(effective["strictPluginOnlyCustomization"]);
  const skillListingMaxDescChars = asFiniteNumber(effective["skillListingMaxDescChars"]);
  const skillListingBudgetFraction = asFiniteNumber(effective["skillListingBudgetFraction"]);

  // `trustedWorkspace` is the SAME derivation engine.ts makes (`defaultTrustSource(config)`), so the
  // two can never disagree about a session's own trust. It reaches the MCP resolver through the
  // engine, which recomputes it -- this copy is for the loaders that need it here.
  const trustedWorkspace = defaultTrustSource(config).verdict(config.cwd).trusted;

  // (2) PLUGINS.
  const plugins = loadPlugins(config.plugins, { cwd: config.cwd });
  for (const rejection of plugins.rejected) {
    warnings.push(`plugin "${rejection.path}" was not loaded (${rejection.kind}): ${rejection.reason}`);
  }

  // (3) SKILL INDEX. Addressed by the RESOLVED winter root -- never `permissionHome`.
  const skillIndex = SkillIndex.build({
    cwd: config.cwd,
    winterHome,
    ...(settingSources !== undefined ? { settingSources } : {}),
    plugins: pluginSkillContributions(plugins.bundles),
    ...(disableBundledSkills !== undefined ? { disableBundledSkills } : {}),
    ...(strictPluginOnlyCustomization !== undefined ? { strictPluginOnlyCustomization } : {}),
  });

  // (4) SKILLS-OPTION VALIDATION, before the run starts (WS-11 §10: "`skills` list validation before
  // spawn"). A typed FAILURE naming every unknown name, surfaced as a warning rather than a throw:
  // the pin's own behaviour for an unknown name is uncaptured (report §60 records only that the
  // validation exists), and aborting a session over a stale skill name would be a failure mode
  // Winter invented. The names are dropped from the session's effective set either way, so the
  // model is never told about a skill it cannot load.
  const validation = validateSkillsOption(config.skills, skillIndex, {
    ...(config.disallowedTools !== undefined ? { disallowedTools: config.disallowedTools } : {}),
  });
  if (!validation.ok) warnings.push(validation.message);
  for (const warning of validation.warnings) warnings.push(warning);

  // (5) THE SKILL SESSION RUNTIME. Keyed exactly as the executor reads it (`agentId ?? sessionId`),
  // so a child engine constructed with its own `agentId` never resolves against the parent's set.
  const skillRuntimeKey = config.agentId ?? config.sessionId;
  registerSkillSessionRuntime(skillRuntimeKey, {
    index: skillIndex,
    ...(config.skills !== undefined ? { skills: config.skills } : {}),
    ...(skillOverrides !== undefined ? { skillOverrides } : {}),
    // Rider 16: the attachment SINK is the transcript now, where it used to be a host callback with
    // no default -- so a skill invocation left no durable record at all unless a host supplied one.
    // Best-effort and fire-and-forget, matching every other auxiliary durable sink in this codebase:
    // a store failure must never fail the `Skill` call it accompanies (the executor already guards a
    // throwing sink, and the body still reaches the model either way).
    ...(opts.persistence?.recordInvokedSkills !== undefined
      ? {
          onInvoked: (attachment) => {
            void Promise.resolve(opts.persistence?.recordInvokedSkills?.(attachment)).catch(() => {});
          },
        }
      : {}),
  });

  // (6) THE COMMAND RESOLVER. Skills come from the index built above -- never a second scan -- so
  // `/review` and `Skill("review")` can never resolve to different files.
  const commandResolver = FilesystemCommandResolver.build({
    cwd: config.cwd,
    winterHome,
    ...(settingSources !== undefined ? { settingSources } : {}),
    skills: skillIndex,
    plugins: pluginCommandContributions(plugins.bundles),
    ...(skillOverrides !== undefined ? { skillOverrides } : {}),
  });

  // (7) PLUGIN AGENT DEFINITIONS. `tools/impl/agent.ts` reads these out of a session-keyed registry:
  // `ToolExecutionContext` carries `agents` (the programmatic map) but nothing for plugins, and
  // precedence differs (programmatic > project > user > PLUGIN), so merging them into `config.agents`
  // would silently promote a plugin's default over a user's own definition.
  registerPluginAgents(config.sessionId, pluginAgentDefinitions(plugins.bundles) as Record<string, PluginAgentDefinition>);

  // (8) HOOKS. Settings-file blocks + plugin blocks, both through `buildHookEntriesFromSettings`,
  // NEVER straight into a runner (T2's divergence 8). The engine concatenates these with its own
  // `config.hooks` entries and hands the WHOLE array to both `buildHookRegistry` and
  // `createCommandHookInvoker` -- the invoker must be built from the same array the registry was, or
  // a `{type:"command"}` entry's id will not be found.
  const settingsHooks = buildHookEntriesFromSettings(settingsHookSourceInputs(resolved));
  const pluginHooks = pluginHookEntries(plugins.bundles);
  for (const rejection of [...settingsHooks.rejected, ...pluginHooks.rejected]) {
    warnings.push(`hook block from ${rejection.source}${rejection.path !== undefined ? ` (${rejection.path})` : ""} was rejected: ${rejection.reason}`);
  }
  const extraHookEntries: SourcedHookEntry[] = [...settingsHooks.entries, ...pluginHooks.entries];

  // (9) MCP SOURCES, in Lane S's stated precedence. The host's own explicit `config.mcpServers` is
  // the engine's (it prepends `{origin:"explicit"}`); these are the three filesystem/settings tiers
  // that follow it. ORDER 2-BEFORE-3 MATTERS: both may carry `origin:"project"`, and
  // `resolveMcpServerSources` breaks a within-origin tie by array order, so a project settings.json
  // entry is offered before the ambient `.winter/mcp.json`.
  const settingsMcp = settingsMcpServerSources(resolved.perSource);
  const projectMcp = loadProjectMcpConfig({ cwd: config.cwd, ...(settingSources !== undefined ? { settingSources } : {}) });
  for (const rejection of [...settingsMcp.rejected, ...projectMcp.rejected]) {
    warnings.push(`mcp config was rejected: ${JSON.stringify(rejection)}`);
  }
  const extraMcpServerSources: McpServerSource[] = [...settingsMcp.sources, ...projectMcp.sources, ...pluginMcpServerSources(plugins.bundles)];

  // (10) THE ASSEMBLER (Lane C). Its `home` is the resolved winter root and its `settings` is the
  // post-OVERLAY_NEVER_KEYS effective getter (rider 24, asserted above).
  const systemPromptAssembler = createSystemPromptAssembler({ home: winterHome, settings: settingsGetter });

  // (11) COMPACTION (Lane K). Registered unconditionally: with no controller the engine never
  // auto-compacts and `/compact` answers "no compaction controller", which is a permanent
  // degradation rather than a default. `compactionThreshold` falls through to the SDK's own
  // `DEFAULT_COMPACTION_THRESHOLD` when unset.
  const compactionController = createCompactionController({
    ...(config.compactionThreshold !== undefined ? { compactionThreshold: config.compactionThreshold } : {}),
  });

  // (12) STRUCTURED OUTPUT (Lane K). ALWAYS registered, never gated on `config.outputFormat`: the
  // engine already gates the descriptor registration on `outputFormat` being set (engine.ts), so an
  // unused seam costs one object -- while `outputFormat` set with NO seam is a hard
  // `error_during_execution` on the first round (T3's concern 3). Lane W's `WorkflowRunHost.structured`
  // takes THIS SAME INSTANCE, so the compiled-validator cache and the dialect selection are shared.
  const structuredOutput = createStructuredOutputSeam();

  // (13) FILE CHECKPOINTING (Lane K). Constructed only when the session asked for it -- unlike the
  // seams above, this one WRITES to disk the moment a mutating tool runs, so building it for a
  // session that never enabled it would create a backup store nothing reads.
  const fileCheckpointSink =
    config.enableFileCheckpointing === true
      ? createFileCheckpointSink({
          sessionUuid: config.sessionId,
          home: winterHome,
          cwd: config.cwd,
          env,
          // Rider 25: the rewind fence. The session's own writable roots, so a file genuinely edited
          // in a granted directory still restores while a tampered index cannot reach outside them.
          ...(config.additionalDirectories !== undefined ? { additionalDirectories: config.additionalDirectories } : {}),
          // Riders 9/16: the durable, transcript-visible MIRROR of each checkpoint record. The
          // sidecar next to the blobs stays this sink's own read authority.
          ...(opts.persistence?.recordFileHistory !== undefined ? { persistence: { recordFileHistory: opts.persistence.recordFileHistory } } : {}),
        })
      : undefined;

  // (14) THE INIT FRAME's four P5 fields.
  //
  // `slash_commands` comes from `slashCommandNames(resolver, cwd)` -- which ALREADY includes the
  // engine's own `/compact`, so the engine must not prepend it a second time. The construction cwd
  // and the live cwd are the same value at startup, which is when the init frame is emitted.
  const initSlashCommands = slashCommandNames(commandResolver, config.cwd);
  // `skills` reflects the session FILTER, not the whole index: a session configured with
  // `skills: ["review"]` should not advertise every skill on disk as available. `validateSkillsOption`
  // returns `index.names()` for `undefined`/`"all"` (capture (4): omission is not "skills off") and
  // the caller's own list otherwise -- including the empty one, which is a real configuration.
  const initSkills = validation.ok ? validation.skills : [];
  const initPlugins = pluginInitInfo(plugins.bundles);
  // The pinned field is REQUIRED (`sdk.d.ts:4879`). It reports the CONFIGURED name -- the same chain
  // the assembler resolves with -- never a name invented because the file behind it is missing:
  // `resolveOutputStyle` returning null means the name resolves to nothing, which is worth reporting
  // as the name the host asked for.
  const initOutputStyle = config.outputStyle ?? (typeof effective.outputStyle === "string" ? effective.outputStyle : undefined) ?? DEFAULT_OUTPUT_STYLE;

  // (15) THE MODEL-FACING SKILL LISTING (R5-17). Built POST-truncation here, by Lane S's own
  // producer, so Lane C's assembler places it and re-derives neither cap. Restricted to the
  // session's EFFECTIVE set for the same reason `initSkills` is: a listing advertising a skill the
  // session filtered out would tell the model to call something that refuses.
  //
  // The budget is a share of THIS session's context window (`skillListingBudgetFraction`, default
  // 0.01), so a session with a small window gets a proportionally smaller listing rather than one
  // sized for a window it does not have.
  //
  // FILTERED THROUGH LANE S'S OWN `isSkillEnabled`, never a re-derivation. A set-membership check
  // over `initSkills` reads correctly and is WRONG in two ways: `skills: []` is a legitimate "no
  // skills" configuration whose empty list a `size === 0 || ...` guard would read as "all" (the
  // exact inversion), and `isSkillEnabled` is alias-aware in both directions, so an option listing
  // `.winter:review` enables an invocation of `review` and vice versa.
  const listedSkills = skillIndex.list().filter((skill) => isSkillEnabled(config.skills, skill.name, skillIndex));
  const skillListing = buildSkillListing(listedSkills, {
    ...(skillOverrides !== undefined ? { skillOverrides } : {}),
    ...(skillListingMaxDescChars !== undefined ? { maxDescChars: skillListingMaxDescChars } : {}),
    ...(skillListingBudgetFraction !== undefined ? { budgetFraction: skillListingBudgetFraction } : {}),
    ...(config.contextWindowTokens !== undefined ? { contextWindowTokens: config.contextWindowTokens } : {}),
  });

  return {
    engineOptions: {
      winterHome,
      systemPromptAssembler,
      commandResolver,
      compactionController,
      structuredOutput,
      ...(fileCheckpointSink !== undefined ? { fileCheckpointSink } : {}),
      extraHookEntries,
      extraMcpServerSources,
      initSlashCommands,
      initSkills,
      initPlugins,
      initOutputStyle,
      skillListing,
    },
    childFactoryOptions: {
      systemPromptAssembler,
      skillRuntime: { index: skillIndex, ...(skillOverrides !== undefined ? { skillOverrides } : {}) },
      // THE SAME INSTANCE the parent runs with -- Lane K's NEEDS_CONTEXT 6: one seam per session so
      // the compiled-validator cache and the dialect selection are shared. A child needs it because
      // `SpawnChildRequest.outputFormat` reaches its own generation config (Lane W's
      // `agent({schema})` rides exactly that), and `outputFormat` with NO seam is a hard
      // `error_during_execution` on the first round (T3's concern 3).
      structuredOutput,
    },
    warnings,
    dispose(): void {
      clearSkillSessionRuntime(skillRuntimeKey);
      clearPluginAgents(config.sessionId);
    },
  };
}

/**
 * The automatic `Skill(...)` allow entries for a session, folded into `allowedTools` by BOTH
 * entrypoints before `runEngine` seeds its rule set.
 *
 * Separate from `buildProductionWiring` because it must be applied to the CONFIG, and the config is
 * what that function takes as input -- returning a mutated config from a builder whose job is to
 * produce seams would make the ordering between the two invisible at the call site.
 */
export function withAutoSkillPermissions(config: RuntimeConfig): RuntimeConfig {
  const entries = autoSkillPermissionEntries(config.skills);
  if (entries.length === 0) return config;
  const existing = config.allowedTools ?? [];
  const merged = [...existing];
  for (const entry of entries) {
    if (!merged.includes(entry)) merged.push(entry);
  }
  return { ...config, allowedTools: merged };
}
