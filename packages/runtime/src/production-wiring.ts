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
import { resolveSettingsDetailed, filterEscalatingDefaultMode, providerSettingsFrom } from "./settings/resolve.ts";
import { sourceRule, rawToRuleValue, type SourcedRuleEntry } from "./permissions/ruleset.ts";
import type { RuleSource } from "@yanlinglabs/winter-agent-sdk";
import type { DetailedResolvedSettings } from "./settings/resolve.ts";
import { defaultTrustSource } from "./settings/trust.ts";
// rn-1 (residual round 2): the child-mirror seam is typed AGAINST the factory's own options, so an
// undeclared field is a compile error here rather than a silent drop there. Type-only, no cycle.
import type { DefaultChildEngineFactoryOptions } from "./subagents/register-default-factory.ts";
import { resolveOutputStyle } from "./context/output-styles.ts";
import { isAuthoredPromptRegion } from "./context/assembler.ts";
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
// Phase 6 Task 10: the provider half of the same "one function, three legs" argument this module's
// own header makes. Before this, `main.ts` picked a provider from an env var and `testing.ts` took
// one as a parameter -- two entrypoints, two policies, and NEITHER of them the catalog-first
// selection R6-9 requires. Now both call this module and this module calls one builder.
import { buildSessionProvider, type SessionProviderOptions, type SessionProviderWiring } from "./provider/session-provider.ts";
import type { Provider } from "./engine.ts";
import type { ClassifierInterface } from "./permissions/auto/engine.ts";
import { WinterProviderResolutionError } from "@yanlinglabs/winter-provider-runtime";
import { redactCredentialRef } from "./provider/selection.ts";
// WS-13c (P6.6): the family layer. `slots.ts` is Lane A's resolver, `family-listing.ts` Lane C's
// listing builder, `validateModelSlots` Lane B's whole-set validator -- one wiring composes all
// three, so the Agent tool, `set_model` and the listing can never disagree about a slot.
import { computeActiveSlotSet, resolveSlotToProvider, type SlotProviderResolution } from "./provider/slots.ts";
import { buildModelFamilyListing } from "./provider/family-listing.ts";
import { validateModelSlots, type ModelSlotsLookup } from "@yanlinglabs/winter-agent-sdk";
import type { ActiveSlotSet, ModelFamilyListing, ModelSlotSetting } from "@yanlinglabs/winter-agent-sdk";
import { rowsForCanonicalId } from "@yanlinglabs/winter-provider-catalog";

/**
 * The throwaway slot name the listing's `resolvesTo` probe resolves under.
 *
 * A one-slot CUSTOM set is how the listing reuses `resolveSlotToProvider`'s real §4 ordering instead
 * of re-deriving it -- the name is never advertised anywhere and exists only so the probe has
 * something to ask for.
 */
const LISTING_PROBE_SLOT_NAME = "probe";
import type { PricedUsage, ProviderUsage, ResolveModelSwitch } from "./engine.ts";

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
 *
 * WHOLE-BRANCH MINOR m7 -- WHY THIS COMPARES AGAINST `perSource`, NOT AGAINST `resolved.effective`.
 * It used to do the latter, and the production call site passes `resolved.effective`: `f(x, y)`
 * comparing `x` to `y.effective` where `x === y.effective` is an identity check, so the guard could
 * not fire in production no matter what went wrong. Its two fixtures tested the function; nothing
 * tested the wiring.
 *
 * Against the PROJECT TIER'S RAW VALUES the same call becomes a real question: "does the view I am
 * about to hand the assembler still carry the value the repository asked for?" `resolved.effective`
 * answers no (the filter ran) and answers YES the moment `withoutOverlayNeverKeys` regresses or a
 * caller substitutes a per-source view -- which is the property rider 24 wanted asserted all along.
 *
 * The one legitimate way a view may carry the project's value is if another tier independently set
 * the SAME value, so that is the single exemption. Comparing values rather than presence is still
 * load-bearing for the opposite case: when project and a higher tier both set the key with
 * DIFFERENT values, a raw project view has the same presence as `effective` and would sail through
 * any `key in settings` test.
 */
export function assertEffectiveSettings(settings: Settings | undefined, resolved: DetailedResolvedSettings): void {
  if (settings === undefined) return;
  const view = settings as Record<string, unknown>;
  const project = resolved.perSource.find((entry) => entry.source === "project");
  if (project === undefined) return; // no project tier -- there is nothing OVERLAY_NEVER_KEYS could have dropped
  const projectValues = project.values as Record<string, unknown>;
  for (const key of OVERLAY_NEVER_KEYS) {
    const projectValue = projectValues[key];
    if (projectValue === undefined) continue; // the repository never asked for this key
    if (view[key] !== projectValue) continue; // the view does not carry the repository's value -- the filter ran
    const sameValueElsewhere = resolved.perSource.some(
      (entry) => entry.source !== "project" && (entry.values as Record<string, unknown>)[key] === projectValue,
    );
    if (sameValueElsewhere) continue; // a tier that IS allowed to set it chose the same value
    throw new Error(
      `winter: production wiring was handed a RAW settings view -- "${key}" still holds the PROJECT tier's value, and \`${key}\` is an OVERLAY_NEVER_KEY that only resolveSettings().effective has filtered. Hand the assembler \`effective\`, never a per-source value.`,
    );
  }
}

/**
 * Phase 5 fix wave, C1: everything the engine needs from a settings file's `permissions` block.
 *
 * A SEED, not a policy: the engine folds `entries`/`directories` into its own initial rule set after
 * the managed baseline and before the `sdk` entries, and the per-entry trust filter downstream is
 * what makes a project-tier `allow` inert without host-declared trust.
 */
export interface SettingsRuleSeed {
  /** Tagged with the tier that asserted them, which is what the P5-A gate reads. */
  entries: SourcedRuleEntry[];
  /** `permissions.additionalDirectories`, tagged the same way (`effectiveDirectories` gates project-tier grants). */
  directories: Array<{ path: string; source: RuleSource }>;
  /**
   * The surviving `permissions.defaultMode`, AFTER the pinned `filterEscalatingDefaultMode` -- so a
   * repo-committed `bypassPermissions` never reaches the engine. A DEFAULT: an explicit
   * `config.permissionMode` still wins, because a file cannot override what the host asked for.
   */
  defaultMode?: string;
  /** WS-07 §6.4's veto, from ANY tier. `engine.ts` read `config.permissions` only. */
  disableBypassPermissionsMode?: boolean;
  /** Non-fatal problems, surfaced through `ProductionWiring.warnings`. */
  warnings: string[];
}

/** `RuleSource` values a settings TIER can legitimately carry. `flag`/`cliArg`/`session`/`sdk` are not file tiers. */
const RULE_SOURCE_BY_SETTING_SOURCE: Partial<Record<string, RuleSource>> = {
  managed: "managed",
  user: "user",
  project: "project",
  local: "local",
};

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function isPlainSettings(v: unknown): v is Settings {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * One `SourcedRuleEntry` per (tier, behavior, rule string), in the pinned precedence order.
 *
 * ORDER IS `perSource`'s OWN (highest-precedence first), and it matters: `resolveRules` and
 * `findMatchingRuleEntry` both return the FIRST match within a behavior, so a managed deny must be
 * reached before a user one. `perSource` is already ordered that way.
 *
 * A MALFORMED RULE IS REPORTED, NEVER THROWN. `sourceRule` validates at add time and raises
 * `PermissionRuleValidationError`; that is the right behaviour for an `Options` field the host
 * controls (fail loud at startup) and the wrong one for a FILE a repository may have written --
 * a single bad string in a checked-in `.winter/settings.json` must not make the session unstartable.
 * The bad entry is dropped and named in `warnings`; every other rule in the same file still binds.
 */
export function buildSettingsRuleSeed(resolved: DetailedResolvedSettings, opts?: { allowDangerouslySkipPermissions?: boolean; disableBypassPermissionsMode?: boolean }): SettingsRuleSeed {
  const entries: SourcedRuleEntry[] = [];
  const directories: Array<{ path: string; source: RuleSource }> = [];
  const warnings: string[] = [];

  for (const tier of resolved.perSource) {
    const source = RULE_SOURCE_BY_SETTING_SOURCE[tier.source];
    if (source === undefined) continue; // `flag` (inline/sdk) is seeded by the engine's own sdk entries
    const permissions = (tier.values as Record<string, unknown> | undefined)?.["permissions"];
    if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) continue;
    const block = permissions as Record<string, unknown>;
    for (const [key, behavior] of [
      ["deny", "deny"],
      ["ask", "ask"],
      ["allow", "allow"],
    ] as const) {
      for (const raw of stringArray(block[key])) {
        try {
          entries.push(sourceRule(rawToRuleValue(raw), behavior, source));
        } catch (err) {
          warnings.push(`settings (${tier.source}${tier.path !== undefined ? ` at ${tier.path}` : ""}): dropping malformed ${key} rule ${JSON.stringify(raw)} -- ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    for (const path of stringArray(block["additionalDirectories"])) directories.push({ path, source });
  }

  // The pinned escalating-mode filter, on the whole resolution -- it answers "which TIER set this",
  // which no per-entry view can. Zero non-test callers before this.
  const filtered = filterEscalatingDefaultMode(resolved) as Record<string, unknown>;
  const filteredPermissions = filtered["permissions"];
  const rawDefaultMode =
    typeof filteredPermissions === "object" && filteredPermissions !== null && typeof (filteredPermissions as Record<string, unknown>)["defaultMode"] === "string"
      ? ((filteredPermissions as Record<string, unknown>)["defaultMode"] as string)
      : undefined;

  // The veto is restrictive, so it applies from EVERY tier with no trust question -- `true` anywhere
  // wins. Read off the tiers rather than off `effective` so a `false` in a higher tier cannot
  // un-veto a lower tier's `true`.
  const disableBypassPermissionsMode = resolved.perSource.some((tier) => {
    const permissions = (tier.values as Record<string, unknown> | undefined)?.["permissions"];
    return typeof permissions === "object" && permissions !== null && (permissions as Record<string, unknown>)["disableBypassPermissionsMode"] === true;
  });

  // NEW-3 (residual round): A SETTINGS FILE MAY NOT MAKE THE SESSION UNSTARTABLE.
  //
  // `filterEscalatingDefaultMode` drops an escalating mode from the PROJECT tier only -- correct,
  // and by design a USER-tier `bypassPermissions` survives, because it is the user's own file. But
  // C1 gave that value a consumer for the first time: `initialMode` now reads it, and
  // `PolicyStateStore`'s bypass gate then THROWS when `allowDangerouslySkipPermissions` is not set
  // or a managed veto is in force. That throw is startup validation -- it happens before the `init`
  // frame -- so the session emitted zero frames and exited 1. Before the wave the same line in the
  // same file was simply inert.
  //
  // The failure is silent in a way that is worth naming: on the in-memory leg nothing is printed at
  // all, and on a spawned leg the operator gets `winter: fatal` with no indication that a line in
  // their own `settings.json` is responsible.
  //
  // DEGRADED, NOT ABORTED, matching exactly how the project tier is already treated one function
  // up: the mode falls back to the pre-wave behaviour (no file-supplied default) and the reason is
  // reported. A file supplies a DEFAULT; a default that cannot be honoured is not an error, it is a
  // default that does not apply. An explicit `Options.permissionMode` is untouched either way --
  // it never passes through here.
  const bypassBlocked = opts?.allowDangerouslySkipPermissions !== true || disableBypassPermissionsMode || opts?.disableBypassPermissionsMode === true;
  const defaultMode = rawDefaultMode === "bypassPermissions" && bypassBlocked ? undefined : rawDefaultMode;
  if (defaultMode !== rawDefaultMode) {
    // NAME THE TIER. `perSource` is ordered highest-precedence-first, so the first tier still
    // declaring the value is the one that won -- and after `filterEscalatingDefaultMode` it can only
    // be user, local or managed. "Ignored" without a file to open sends the operator looking in the
    // wrong one of the three.
    const tier = resolved.perSource.find((t) => {
      const perms = (t.values as Record<string, unknown> | undefined)?.["permissions"];
      return typeof perms === "object" && perms !== null && (perms as Record<string, unknown>)["defaultMode"] === rawDefaultMode;
    });
    warnings.push(
      `settings (${tier?.source ?? "unknown"}${tier?.path !== undefined ? ` at ${tier.path}` : ""}): permissions.defaultMode "bypassPermissions" is ignored -- ${
        disableBypassPermissionsMode || opts?.disableBypassPermissionsMode === true
          ? "a managed policy disables bypassPermissions (WS-07 §6.4)"
          : "Options.allowDangerouslySkipPermissions is not set"
      }; this session starts in its default mode instead`,
    );
  }

  return {
    entries,
    directories,
    ...(defaultMode !== undefined ? { defaultMode } : {}),
    ...(disableBypassPermissionsMode ? { disableBypassPermissionsMode } : {}),
    warnings,
  };
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
  /**
   * Phase 6 Task 10: what the session's PROVIDER is built from.
   *
   * Every field is an injection point a TEST uses and production leaves alone: the catalog (a fixture
   * owns its own rows), the credential store (an in-memory one, never the Keychain), the reserved
   * `winter-test/<name>` namespace's scripted double, and the resumed continuation chain. Production
   * passes only `testProviders` (the harness alias R6-13 keeps) and the OS home.
   *
   * OMITTING THE WHOLE OBJECT still runs selection: there is no "skip the provider" mode, because a
   * mode that skipped it is exactly how a leg ends up with a different provider policy from the other
   * two.
   */
  provider?: Omit<SessionProviderOptions, "config" | "env">;
}

export interface ProductionWiring {
  /** Spread into `runEngine({...})`. Every field is one of `EngineOptions`' own P5 seams or init inputs. */
  engineOptions: {
    winterHome: string;
    settingsRules: SettingsRuleSeed;
    // --- Phase 6 Task 10 (R6-9/R6-14) -----------------------------------------------------------
    //
    // `providerIdentity` is what makes the write-ahead sidecar path and the `winter_provider` init
    // extension live; `apiKeySource` is the pinned REQUIRED init field; `classifier` is R6-14's
    // route, absent for a Manual fallback (which is `createAutoEngine`'s own default and must stay
    // distinguishable from "a classifier that always abstains").
    providerIdentity?: {
      providerId: string;
      modelKey: string;
      family: string;
      continuationDomain?: string;
      adapterId?: string;
      adapterVersion?: string;
      catalogVersion?: string;
      authRefKind?: string;
    };
    apiKeySource: string;
    providerSupportsToolSearch?: boolean;
    classifier?: ClassifierInterface;
    /** P6 fix wave (Ruling E-2): the switch seam, from the session's own wiring. */
    resolveModelSwitch?: ResolveModelSwitch;
    /** P6 fix wave (Ruling E-3): `fallbackModel`'s candidates as catalog keys, present only when configured. */
    fallbackModels?: string[];
    /** P6 fix wave (Ruling E-4): R6-H's price of one generation, from the session's own wiring. */
    priceUsage?: (modelKey: string, usage: ProviderUsage) => PricedUsage | undefined;
    /** P6 fix wave (Ruling E-5): the classifier model's key, for the session pin -- present exactly when `classifier` is. */
    classifierIdentity?: { modelKey: string };
    /** R6-I: the `list_models` control handler's source. */
    supportedModels: () => unknown[];
    /** The Winter-only `account_info` control handler's source. */
    accountInfo: () => unknown;
    // --- WS-13c (P6.6): model families and ranked slots -----------------------------------------
    //
    // All four are WITHHELD for the reserved `winter-test/<name>` namespace, exactly like
    // `resolveModelSwitch` above -- a scripted double has no catalog identity to derive a family
    // from, and every pre-P6.6 golden is driven by such a session.
    /** WS-13c §3: the active slot set for a given model key -- the Agent tool's `model` enum and description lines. */
    activeSlotSet?: (currentModelKey: string | undefined) => ActiveSlotSet;
    /** WS-13c §4: slot name -> provider + catalog key, for a child spawn and for `set_model`. */
    resolveSlot?: (requested: string, currentModelKey: string | undefined) => SlotProviderResolution;
    /** WS-13c §5: bumps when the resolved settings view changes, so a `modelSlots` edit re-renders with no restart. */
    settingsVersion?: () => number;
    /**
     * WS-13c §7: the `list_model_families` control handler's source.
     *
     * The parameter is Lane A's; the spine's `EngineOptions.listModelFamilies` is `() => …`, which
     * this is assignable to. See the producer for the one-line spine fix that makes the engine
     * actually pass the live key.
     */
    listModelFamilies?: (currentModelKey?: string) => ModelFamilyListing;
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
  /**
   * Mirrors handed to `registerDefaultChildEngineFactory`, so a CHILD engine gets the same context
   * surface its parent does.
   *
   * TYPED AS A `Pick` OF THE FACTORY'S OWN OPTIONS (rn-1, residual round 2), which is a tripwire and
   * not tidiness. This was an independent object literal spread into the factory, and a spread of a
   * property the destination has not declared is NOT an excess-property error -- so `skillListing`
   * was declared here, type-checked, arrived on `opts`, and was dropped one line before `deps`,
   * inert in production for a whole round while a review recorded it as landed. Against a `Pick`,
   * a field the factory has not declared is a compile error AT THE PRODUCER, where the mistake is
   * made, instead of a silent drop at the consumer, where nobody is looking.
   *
   * Adding a mirror is therefore now a two-file edit by construction: declare it on
   * `DefaultChildEngineFactoryOptions` first, then produce it here.
   */
  childFactoryOptions: Required<
    Pick<
      DefaultChildEngineFactoryOptions,
      "systemPromptAssembler" | "skillRuntime" | "skillListing" | "settingsRules" | "structuredOutput" | "extraHookEntries" | "compactionControllerFactory" | "resolveChildProvider"
    >
  >;
  /**
   * Phase 6 Task 10: the session's provider, and everything resolved with it.
   *
   * `provider` is spread into `runEngine` by both entrypoints; the rest is what the control handlers
   * (`supportedModels`/`accountInfo`) and the report read. See `session-provider.ts`.
   */
  providerWiring: SessionProviderWiring;
  /**
   * The config the ENGINE should run, which differs from the input config in the provider-derived
   * defaults only (`contextWindowTokens` from the descriptor when the host stated none).
   *
   * RETURNED rather than mutated: `ProductionWiringOptions.config` is what every other consumer in
   * this function reads, and a builder that silently rewrote its own input would make the ordering
   * between the two invisible at the call site -- the same argument `withAutoSkillPermissions`'
   * header already makes.
   */
  config: RuntimeConfig;
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
    // C1: the MANAGED tiers. Both were declared on the pinned `ResolveSettingsOptions` since T2 and
    // had no producer -- so `managed`, the one source `allowManagedPermissionRulesOnly` and every
    // "managed beats everything" rule in the evaluator are written for, was unreachable in a live
    // session. Narrowed from the wire's `Record<string, unknown>` (it arrives as JSON).
    ...(isPlainSettings(config.managedSettings) ? { managedSettings: config.managedSettings as Settings } : {}),
    ...(isPlainSettings(config.serverManagedSettings) ? { serverManagedSettings: config.serverManagedSettings as Settings } : {}),
  });
  const effective = resolved.effective;
  assertEffectiveSettings(effective, resolved);

  // NEW-1 (residual round): THE TIER `error` CHANNEL HAD NO PRODUCTION CONSUMER.
  //
  // `resolve.ts` merges four independent reports into `DetailedSettingsSourceEntry.error` -- A-2's
  // value-level malformed rule arrays, m1's `outputStyle` drop, RULING P5-L's `plansDirectory`
  // refusal, and plain JSON parse failures -- and this file read only `perSource[].values`. So four
  // separate fixes each landed a message that reached nobody: the reviewer's I3 probe recorded
  // `stderr mentions plansDirectory=false` against a refusal that had been implemented, tested and
  // shipped. A report with no consumer is not a report.
  //
  // ALSO THE I3 RESIDUAL. The `plansDirectory` refusal now names the key in the operator's line,
  // because `resolve.ts` writes the key into its own reason string and this simply carries it.
  for (const tier of resolved.perSource) {
    if (tier.error === undefined || tier.error.length === 0) continue;
    // `path` is `undefined` for the managed/flag tiers, which have no file. Same conditional shape
    // the malformed-rule warning below uses -- never "settings (managed at undefined)".
    warnings.push(`settings (${tier.source}${tier.path !== undefined ? ` at ${tier.path}` : ""}): ${tier.error}`);
  }
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

  // Lane Y addendum, item 3: the INDEX's own load errors, on the same channel as everything else
  // that half-loaded. `SkillIndex.build` drops a skill whose frontmatter will not parse, whose name
  // fails the jail, or whose directory is unreadable -- correct, and until now completely mute: the
  // model simply never saw the skill, and the author had no way to tell a broken skill from one
  // that was never discovered. `validateSkillsOption` above covers only names the HOST asked for;
  // this covers the ones the filesystem offered and the index refused.
  //
  for (const err of skillIndex.errors()) {
    warnings.push(`skill "${err.directory}" (${err.source}) was not loaded: ${err.reason} -- ${err.path}`);
  }

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
    // n3 (whole-branch review): a SENTENCE, not `JSON.stringify` of an internal record. This line
    // is the only thing an operator ever sees about a server that did not start, and it reached
    // them as `{"origin":"project","path":"...","reason":"..."}` -- every field they needed, in the
    // one shape that reads as a crash rather than as guidance. The three other `warnings.push`
    // sites in this file were already prose; this one was the outlier.
    warnings.push(`mcp config from ${rejection.origin}${rejection.path !== undefined ? ` (${rejection.path})` : ""} was rejected: ${rejection.reason}`);
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
          //
          // WHOLE-BRANCH MINOR m4, DISCLOSED (fix wave). The fence is FROZEN AT CONSTRUCTION:
          // `[config.cwd, ...additionalDirectories]`, taken once, here, before the session runs. The
          // engine's own live bounds -- `extraBoundedRoots` (a directory the user grants mid-session
          // through the approval flow) and `currentCwd` (which `EnterWorktree` relocates) -- never
          // reach the sink. So a Write inside a worktree the session moved into checkpoints
          // perfectly and is then REFUSED at rewind, counted as a `skippedLinks`: the user is told
          // their edit could not be restored, with no indication that the reason is a fence set
          // before the directory existed.
          //
          // NOT FIXED HERE because it cannot be: the fix is a sink that reads its roots through a
          // getter instead of an array, and `checkpoint/sink.ts` belongs to the other lane of this
          // wave. Recorded at the construction site rather than in a report so the next person to
          // widen a session's bounds sees the coupling at the point they would otherwise miss it.
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

  // Phase 5 fix wave (B-low): RULING P5-G's downgrade, SURFACED.
  //
  // Rider 22 moved `replacementDowngraded` onto the assembled result so the ruling's "observable"
  // clause held somewhere a caller could see it. Nothing in production reads it: the engine consumes
  // `assemble()` for its `system` and its context blocks and touches no other field, so a project
  // style that asked to replace the prompt and was refused still told nobody. The refusal is
  // CORRECT -- and silently correct is how a repository author concludes their style file is broken
  // and starts trying to work around a security boundary they were never told about.
  //
  // Resolved here rather than plumbed back out of the assembler: this is a pure filesystem read of
  // the same name through the same chain, and it keeps the disclosure in the one place every other
  // wiring warning already lives. The assembler remains the authority for the PROMPT.
  // T8 re-review NEW-1 (residual round): the guard the assembler has and this second resolution did
  // not. A caller-supplied `systemPrompt` suppresses output styles ENTIRELY -- Winter does not edit
  // a host's own text -- so warning that the style "has been applied as an ADDITION" on that arm
  // states something untrue about a real configuration. Errs toward more disclosure, which is not
  // the same as being right.
  const styleForWarning = !isAuthoredPromptRegion(config.systemPrompt) ? null : resolveOutputStyle(initOutputStyle, {
    cwd: config.cwd,
    home: winterHome,
    trustedWorkspace,
    ...(settingSources !== undefined ? { settingSources } : {}),
  });
  if (styleForWarning?.replacementDowngraded === true) {
    warnings.push(
      `output style "${initOutputStyle}" is a PROJECT-tier style asking to replace the base system prompt (\`keep-coding-instructions: false\`); this workspace is not host-trusted, so it has been applied as an ADDITION instead (RULING P5-G)`,
    );
  }

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

  // (16) C1 -- THE SETTINGS-FILE PERMISSION RULES, PER TIER.
  //
  // The single largest gap Phase 5 shipped: `resolveSettingsDetailed` ran here and its `permissions`
  // block had NO CONSUMER, so a `deny` a user wrote into `~/.winter/settings.json` was silently not a
  // deny, and the entire P5-A/P5-D trust matrix guarded a path only a `canUseTool` answer could
  // reach.
  //
  // BUILT PER TIER FROM `perSource`, NEVER FROM THE FLAT `effective`, and that is the load-bearing
  // choice rather than a stylistic one: the rule ARRAYS union across tiers (`resolve.ts`'s
  // `PERMISSION_RULE_ARRAY_KEYS`), so `effective.permissions.allow` is a merged list with no
  // attribution -- and attribution is exactly what the evaluator's P5-A gate needs (a PROJECT-tier
  // `allow` must not widen; the identical string from `local` must). T2's own seam contract (iii)/(iv)
  // pins that attribution lives on `sources`/`perSource`.
  //
  // NO `applyWorkspaceTrust` CALL HERE, deliberately. That helper collapses the tiers into one
  // filtered `Settings`, which would throw away the very attribution the entries carry -- and the
  // filter it applies is already implemented per-entry, downstream, where it belongs
  // (`ruleset.ts`'s `resolveRules` and `evaluator.ts`'s `findMatchingRuleEntry` both skip an
  // `allow` whose `source === "project"` unless `trustedWorkspace`; `effectiveDirectories` does the
  // same for directory grants). Seeding tagged entries gets P5-A for free and keeps ONE
  // implementation of it. `filterEscalatingDefaultMode` IS called -- it is a whole-resolution
  // question (which tier set the mode), not a per-entry one.
  // (17) THE PROVIDER (Phase 6 Task 10, R6-9/R6-13/R6-14/R6-17).
  //
  // A RESOLUTION FAILURE NO LONGER STOPS THE SESSION FROM STARTING (review round 1, Critical A).
  // R6-9's refusal is "surfaced in T1's captured failure shape", and that shape has a `system/init`
  // in it: the session constructs, reports no `winter_provider`, and its first generation lands on
  // R6-F's `is_error` result before `query()` throws. Refusing here produced zero frames and a
  // `CLIConnectionError` -- strictly less information, on a shape the pin does not have.
  //
  // The operator still gets the reason on STDERR, through the same `warnings` channel every other
  // non-fatal wiring problem uses. Two channels, deliberately: the host reads frames, the operator
  // reads stderr, and a session that cannot name its model owes both an answer.
  const providerWiring = buildSessionProvider({
    config,
    env,
    // WS-13b R6b-7: the per-provider enable setting, threaded as a GETTER over the SAME live
    // `settingsGetter` every other consumer reads. That is what makes it hot-reloadable within this
    // module's own contract (see this file's header): nothing here watches a file, but a host that
    // re-resolves and hands down a new view is seen at the session's next resolution and at every
    // `set_model`, with no restart and nothing rebuilt.
    providerSettings: () => providerSettingsFrom(settingsGetter()),
    // WS-13c §4 step 6: `set_model` by slot name. Forwarded rather than passed directly because
    // `resolveSlot` is declared BELOW and closes over `providerWiring` -- the binding it reads is
    // initialised long before anything calls it (nothing in `buildSessionProvider`'s construction
    // touches this field; it is read only inside `resolveModelSwitch`).
    resolveSlot: (requested, currentModelKey) => resolveSlot(requested, currentModelKey),
    ...(opts.provider ?? {}),
  });
  if (providerWiring.resolutionError !== undefined) {
    warnings.push(
      `provider selection failed (${providerWiring.resolutionError.code}): ${providerWiring.resolutionError.message} -- this session starts, but its first generation will fail with a provider error`,
    );
  }

  // --- (17b) WS-13c (P6.6): MODEL FAMILIES AND RANKED SLOTS -------------------------------------
  //
  // Everything below is a GETTER over `settingsGetter()` and the session's live model key, for the
  // same reason the provider-enable view above is: `modelSlots` and `preferredProviders` take effect
  // at the next quiescent boundary through the existing cascade, with no restart and nothing rebuilt.

  const slotCatalog = providerWiring.catalog;

  /**
   * WHETHER THIS SESSION HAS A SLOT SURFACE AT ALL.
   *
   * Withheld for the reserved `winter-test/<name>` namespace, exactly as `resolveModelSwitch` is and
   * for the same reason: a scripted double has no catalog identity, so a slot set derived for it
   * would be a statement about a test fixture -- and every pre-P6.6 golden is driven by exactly such
   * a session. A REFUSED session DOES get the surface: that is how it recovers.
   */
  const slotSurfaceLive = providerWiring.identity !== undefined || providerWiring.resolutionError !== undefined;

  /**
   * WS-13c §4 step 2: is a credential configured for this provider?
   *
   * A SYNCHRONOUS ANSWER OVER AN ASYNCHRONOUS FACT, and the shape is forced: `CredentialStore.get`
   * is async (a Keychain read), while `SlotProviderResolutionInput.hasCredential` and
   * `ResolveModelSwitch` are both synchronous. So this is a cache with three honest states:
   *
   *   - the SESSION's own provider -> `true` with no lookup at all. `describeTargetMaterial` answers
   *     `source: "session"` for it, so the session's own material is the credential by construction.
   *   - a provider this session has already probed -> the probe's answer.
   *   - a provider it has NOT probed -> `true`, OPTIMISTICALLY, and a probe is scheduled so the next
   *     resolution is exact. `false` would be the worse default: it would put "no credential
   *     configured" into a `wouldServe` line about a provider the user may well have configured,
   *     which is a false statement about their setup rather than a missing one. And an optimistic
   *     `true` never becomes a substitution -- the credential is verified again downstream, where
   *     `resolveChildProvider` refuses the spawn with `no-credential-for-provider` and
   *     `buildProvider` refuses the first generation, both naming the provider.
   *
   * NO PREWARM AT SESSION START, deliberately: warming the ~12 providers that can serve one active
   * set would put a dozen Keychain reads on every session's startup path (and into every test that
   * builds a real wiring). The cache instead fills from the probes this session was going to make
   * anyway -- `resolveChildProvider`'s own, plus one background read per cold provider the moment a
   * slot resolution first asks about it.
   */
  const CREDENTIAL_PRESENCE_TTL_MS = 5_000;
  const credentialPresence = new Map<string, { present: boolean; at: number }>();
  const credentialProbesInFlight = new Set<string>();
  const probeCredentialPresence = async (providerId: string): Promise<boolean> => {
    if (providerId === providerWiring.sessionProviderId()) return true;
    const rowKey = slotCatalog.models.find((m) => m.providerId === providerId)?.key;
    if (rowKey === undefined) return false; // a provider with no rows can serve nothing anyway
    const resolvedRow = providerWiring.registry.resolve({ model: rowKey });
    if (resolvedRow instanceof WinterProviderResolutionError) return false;
    const material = providerWiring.describeTargetMaterial(resolvedRow);
    // Only a `provider-record` target needs a store lookup; `route`/`session` material IS configured
    // (and a keyless `local-none` provider's `{ kind: "none" }` ref is a real, sufficient answer).
    if (material.source !== "provider-record") return true;
    try {
      return (await providerWiring.credentials.get(material.authRef)) !== null;
    } catch {
      return false; // a store that cannot answer is a store with no record to offer
    }
  };
  /** Records a probe result. Called by the background refresh AND by `resolveChildProvider`, whose probe is already real and paid for. */
  const recordCredentialPresence = (providerId: string, present: boolean): void => {
    credentialPresence.set(providerId, { present, at: Date.now() });
  };
  const refreshCredentialPresence = (providerId: string): void => {
    if (credentialProbesInFlight.has(providerId)) return;
    credentialProbesInFlight.add(providerId);
    void probeCredentialPresence(providerId)
      .then((present) => recordCredentialPresence(providerId, present))
      .catch(() => undefined) // a failed probe leaves the cache exactly as it was
      .finally(() => credentialProbesInFlight.delete(providerId));
  };
  const credentialPresent = (providerId: string): boolean => {
    const cached = credentialPresence.get(providerId);
    // The TTL is what keeps "no setting needs a restart" true for credentials too: a key stored
    // mid-session is visible at the next resolution rather than at the next process.
    if (cached === undefined || Date.now() - cached.at > CREDENTIAL_PRESENCE_TTL_MS) refreshCredentialPresence(providerId);
    return cached?.present ?? true;
  };
  const providerEnabled = (providerId: string): boolean => providerSettingsFrom(settingsGetter())[providerId]?.enabled !== false;
  const preferredProviders = (): string[] => {
    const raw = settingsGetter()?.preferredProviders;
    return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
  };

  /** WS-13c §5: the user's own four options, validated WHOLE (Lane B owns the validator; an invalid set is no set). */
  const modelSlotsLookup: ModelSlotsLookup = {
    rowsForCanonicalId: (id) => rowsForCanonicalId(slotCatalog, id).map((m) => ({ key: m.key, providerId: m.providerId })),
    keyToCanonicalId: (key) => slotCatalog.models.find((m) => m.key === key)?.canonicalModelId,
  };
  const customSlots = (): ModelSlotSetting[] | undefined => {
    const raw = settingsGetter()?.modelSlots;
    if (raw === undefined) return undefined;
    const validated = validateModelSlots(raw, modelSlotsLookup);
    // `ok: false` is "no custom slots" here rather than a warning: the provenance record
    // (`modelSlotsIgnored: "invalid"` / `"untrusted-project"`) belongs to the settings cascade, which
    // sees WHICH tier the set came from -- this module sees only the resolved value.
    return validated.ok ? validated.slots : undefined;
  };

  /**
   * THE SESSION'S LIVE MODEL KEY, as last reported by the engine.
   *
   * The wiring cannot see `set_model`: `providerWiring.resolved` is the SESSION-START snapshot and
   * `installIdentity` never writes back. But the engine passes its live key
   * (`currentProviderIdentity?.modelKey ?? currentModel`) into `activeSlotSet` once per generation
   * and into `resolveSlot` at every spawn, so recording it here gives every other consumer in this
   * module the same live value with no new seam and no watcher.
   *
   * Closes the staleness Lane D's investigation found in `resolveChildProvider` (its report §1.6):
   * that function judged a child's bare model id against the start snapshot, so after a mid-session
   * `set_model` a child naming the parent's NEW model was resolved under the OLD provider.
   */
  let liveEngineModelKey: string | undefined;
  const rememberEngineModelKey = (currentModelKey: string | undefined): void => {
    if (currentModelKey !== undefined && currentModelKey.length > 0) liveEngineModelKey = currentModelKey;
  };
  /** The parent identity a child is judged against: the LIVE model, falling back to the start snapshot. */
  const liveParentIdentity = (): { providerId: string; modelKey: string } | undefined => {
    const startSnapshot = providerWiring.resolved !== undefined ? { providerId: providerWiring.resolved.providerId, modelKey: providerWiring.resolved.modelKey } : undefined;
    if (liveEngineModelKey === undefined || liveEngineModelKey === startSnapshot?.modelKey) return startSnapshot;
    const resolvedLive = providerWiring.registry.resolve({ model: liveEngineModelKey });
    // An `allowUnlisted` pass-through key may not be in the catalog at all; the start snapshot is the
    // honest fallback rather than a provider id guessed from the string.
    return resolvedLive instanceof WinterProviderResolutionError ? startSnapshot : { providerId: resolvedLive.providerId, modelKey: resolvedLive.modelKey };
  };

  const activeSlotSet = (currentModelKey: string | undefined): ActiveSlotSet => {
    rememberEngineModelKey(currentModelKey);
    return computeActiveSlotSet({
      catalog: slotCatalog,
      // The ENGINE's live key wins; the wiring's own `resolved` is only the START model, and falling
      // back to it after a `set_model` would advertise the family the session began on.
      currentModelKey: currentModelKey ?? providerWiring.resolved?.modelKey ?? config.model,
      customSlots: customSlots(),
    });
  };

  const resolveSlot = (requested: string, currentModelKey: string | undefined): SlotProviderResolution => {
    const custom = customSlots();
    return resolveSlotToProvider({
      catalog: slotCatalog,
      active: activeSlotSet(currentModelKey),
      requested,
      hasCredential: credentialPresent,
      providerEnabled,
      preferredProviders: preferredProviders(),
      ...(custom !== undefined ? { customSlots: custom } : {}),
    });
  };

  /**
   * A monotonic number that changes when the resolved settings view does (WS-13c §5's hot-reload
   * obligation, as the engine's re-render memo consumes it).
   *
   * IDENTITY, not a deep compare: this module resolves settings once and hands down a live GETTER
   * (see the file header), so a host that re-resolves hands down a NEW object and the version bumps
   * at the engine's next turn boundary. A session whose settings never change keeps one version and
   * the Agent tool's render is computed once.
   */
  let settingsIdentity: Settings | undefined = settingsGetter();
  let settingsVersionCounter = 1;
  const settingsVersion = (): number => {
    const current = settingsGetter();
    if (current !== settingsIdentity) {
      settingsIdentity = current;
      settingsVersionCounter += 1;
    }
    return settingsVersionCounter;
  };

  // D25 "for now": a Claude session ignores custom slots, and the ignore is RECORDED rather than
  // swallowed -- a user who configured four options and sees the pinned four deserves to be told
  // why. Evaluated at session start against the session's own model; a session that later switches
  // INTO the claude family re-renders the pinned four (the enum is always right) but does not emit a
  // second warning, which is disclosed in this task's report rather than papered over.
  if (slotSurfaceLive && customSlots() !== undefined && activeSlotSet(undefined).source === "claude-pinned") {
    warnings.push(
      "settings: `modelSlots` is configured but this session's model is a Claude model, whose Agent-tool options are pinned to fable/opus/sonnet/haiku (WS-13c D25) -- the custom set was ignored (modelSlotsIgnored: \"claude-pinned\")",
    );
  }

  const settingsRules = buildSettingsRuleSeed(resolved, {
    // NEW-3: the two conditions `PolicyStateStore`'s bypass gate throws on, so the seed never hands
    // the engine a mode the engine will refuse. Passed rather than re-derived inside the seed
    // builder, which sees only settings.
    allowDangerouslySkipPermissions: config.allowDangerouslySkipPermissions === true,
    disableBypassPermissionsMode: config.permissions?.disableBypassPermissionsMode === true,
  });
  for (const warning of settingsRules.warnings) warnings.push(warning);

  return {
    providerWiring,
    // The provider-derived config defaults. `contextWindowTokens` is the only one today, and it is a
    // DEFAULT: an explicit host value always wins (see `session-provider.ts` for why).
    config: providerWiring.contextWindowTokens !== undefined ? { ...config, contextWindowTokens: providerWiring.contextWindowTokens } : config,
    engineOptions: {
      winterHome,
      settingsRules,
      ...(providerWiring.identity !== undefined
        ? {
            providerIdentity: {
              providerId: providerWiring.identity.providerId,
              modelKey: providerWiring.identity.modelKey,
              // The engine's `providerIdentity.family` is the ADAPTER family, which is what the
              // continuation-domain check compares; `WinterProviderIdentity` carries the catalog
              // half. `resolved.adapter.family` is the one authority for it.
              family: String(providerWiring.resolved?.adapter.family ?? ""),
              ...(providerWiring.identity.continuationDomain !== undefined ? { continuationDomain: providerWiring.identity.continuationDomain } : {}),
              adapterId: providerWiring.identity.adapterId,
              adapterVersion: providerWiring.identity.adapterVersion,
              catalogVersion: providerWiring.identity.catalogVersion,
              authRefKind: providerWiring.identity.authRefKind,
            },
          }
        : {}),
      apiKeySource: providerWiring.apiKeySource,
      supportedModels: () => providerWiring.supportedModels(),
      accountInfo: () => providerWiring.accountInfo(),
      // WS-13c (P6.6): the Agent tool's per-family render, the child/`set_model` slot resolver, the
      // hot-reload tripwire the render memoises on, and the "more options" listing -- WITHHELD for
      // the reserved `winter-test/<name>` namespace, exactly like `resolveModelSwitch` beside them.
      ...(slotSurfaceLive
        ? {
            activeSlotSet,
            resolveSlot,
            settingsVersion,
            // TAKES THE MODEL KEY (assignable to the spine's `() => ModelFamilyListing`, so no
            // spine type changes). The spine's handler calls it with no argument today, which means
            // a listing served after a cross-family `set_model` reports the START model's active set
            // -- §7's switcher would list the family the session has left. The one-line spine fix is
            // owed and recorded in this task's report: widen the option to
            // `(currentModelKey?: string) => ModelFamilyListing` and call it with
            // `currentProviderIdentity?.modelKey ?? currentModel`. This side is already correct.
            listModelFamilies: (currentModelKey?: string): ModelFamilyListing =>
              buildModelFamilyListing({
                catalog: slotCatalog,
                active: activeSlotSet(currentModelKey),
                servable: (providerId) => credentialPresent(providerId) && providerEnabled(providerId),
                // THE SAME §4 ORDERING the resolver uses, expressed as a one-slot custom set rather
                // than re-derived: a listing that showed a different first row than a `set_model`
                // would actually reach is a listing that lies about what clicking it does.
                resolveSlot: (canonicalModelId, provider) => {
                  const result = resolveSlotToProvider({
                    catalog: slotCatalog,
                    active: { family: "", source: "custom", slots: [{ name: LISTING_PROBE_SLOT_NAME, canonicalModelId, description: "", reason: "" }] },
                    requested: LISTING_PROBE_SLOT_NAME,
                    hasCredential: credentialPresent,
                    providerEnabled,
                    preferredProviders: preferredProviders(),
                    customSlots: [{ name: LISTING_PROBE_SLOT_NAME, model: canonicalModelId, ...(provider !== undefined ? { provider } : {}) }],
                  });
                  return result.ok ? { providerId: result.providerId, key: result.modelKey } : undefined;
                },
              }),
          }
        : {}),
      // P6 fix wave (Rulings E-2 / E-3): the switch seam and the fallback candidates, from the SAME
      // wiring the session's own provider came from -- one resolution path, on every leg. WITHHELD
      // for the reserved `winter-test/<name>` namespace: a scripted double has no catalog to resolve a
      // target against, so the seam could only ever refuse, and `set_model` on a double keeps its
      // pre-fix shape (the string is parked and applied verbatim) -- which is what every pre-P6
      // fixture drives. A refused session DOES get the seam: that is how it recovers.
      ...(providerWiring.identity !== undefined || providerWiring.resolutionError !== undefined ? { resolveModelSwitch: providerWiring.resolveModelSwitch } : {}),
      ...(providerWiring.fallbackModelKeys.length > 0 ? { fallbackModels: providerWiring.fallbackModelKeys } : {}),
      // P6 fix wave (Rulings E-4 / E-5): cost from the catalog's own pricing evidence; the classifier
      // model's key for the R6-14 pin.
      priceUsage: (modelKey, usage) => providerWiring.priceUsage(modelKey, usage),
      ...(providerWiring.classifierIdentity !== undefined ? { classifierIdentity: providerWiring.classifierIdentity } : {}),
      ...(providerWiring.providerSupportsToolSearch !== undefined ? { providerSupportsToolSearch: providerWiring.providerSupportsToolSearch } : {}),
      ...(providerWiring.classifier !== undefined ? { classifier: providerWiring.classifier } : {}),
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
      // B-low: the LISTING that goes with that index. Threaded as the same object the parent gets --
      // it is the session's skill surface, and a child resolving against the same index while being
      // shown a different (empty) menu was the inconsistency. (Declaring it here was only half the
      // job -- `register-default-factory.ts` had to name it too, or the spread dropped it silently;
      // see that file's own note.)
      skillListing,
      // NEW-4: the settings seed. Everything else in this object is a mirror of what the parent got;
      // this was the one whose absence was a security boundary rather than a context difference.
      settingsRules,
      // THE SAME INSTANCE the parent runs with -- Lane K's NEEDS_CONTEXT 6: one seam per session so
      // the compiled-validator cache and the dialect selection are shared. A child needs it because
      // `SpawnChildRequest.outputFormat` reaches its own generation config (Lane W's
      // `agent({schema})` rides exactly that), and `outputFormat` with NO seam is a hard
      // `error_during_execution` on the first round (T3's concern 3).
      structuredOutput,
      extraHookEntries,
      // A FACTORY, not an object (NEW-2, residual round). `createCompactionController` memoises the
      // prior summary per instance, so the parent must not share its own -- that was the stated
      // reason and it was met. What the code did NOT do is what the comment claimed: it built ONE
      // second instance for the whole session, so every SIBLING child shared a `lastSummary`, and
      // the reason given ("a child folding its own history into the parent's memo") applies between
      // siblings word for word. Called once per spawn by `child-engine.ts`.
      compactionControllerFactory: () =>
        createCompactionController({
          ...(config.compactionThreshold !== undefined ? { compactionThreshold: config.compactionThreshold } : {}),
        }),
      // R6-17: the per-child provider. Resolved through the SESSION's own registry, so a child's
      // `AgentDefinition.model` reaches the same catalog the parent did -- and returns `undefined`
      // when the model resolves to what the parent is already running, so the common case builds no
      // second adapter and every pre-P6 child is byte-identical.
      resolveChildProvider: async (model: string) => {
        const registry = providerWiring.registry;
        // WS-13c (Lane D investigation §1.6): the LIVE parent, not the session-start snapshot. A
        // mid-session `set_model` moves the session's model and provider; judging a child's bare id
        // against the model the session STARTED on resolved it under the old provider (and made
        // "same as the parent" compare against a model the parent had left), so a child naming the
        // parent's new model was either mis-provisioned or refused.
        const parent = liveParentIdentity();
        if (parent === undefined) return undefined; // a scripted double has no catalog to resolve against
        // R6-17 verbatim: a BARE id resolves against the PARENT's provider; a QUALIFIED
        // `<providerId>/<model>` key names its own. Passing the parent's id alongside a qualified key
        // would hit R6-K's `provider-mismatch` and silently fall back to the parent -- which is the
        // one outcome a child that explicitly named another provider must not get.
        const resolvedChild = model.includes("/") ? registry.resolve({ model }) : registry.resolve({ model, provider: { providerId: parent.providerId } });
        if (resolvedChild instanceof WinterProviderResolutionError) return undefined;
        if (resolvedChild.modelKey === parent.modelKey) return undefined;
        // RULING E-1 (whole-branch C-1, probe P1a): a child on ANOTHER provider gets that provider's
        // OWN material -- never the parent's `authRef`, never the parent's user `baseUrl`. When the
        // rule lands on the target provider's keychain record, its EXISTENCE is probed here, before
        // the spawn commits: a child that would only discover the missing key at its first
        // generation is a child that fails after the parent already delegated to it. The probe reads
        // presence only; the material itself never leaves the store (R6-10).
        const material = providerWiring.describeTargetMaterial(resolvedChild);
        if (material.source === "provider-record") {
          let present = false;
          try {
            present = (await providerWiring.credentials.get(material.authRef)) !== null;
          } catch {
            present = false; // a store that cannot answer is a store with no record to offer
          }
          // WS-13c §4 step 2: this probe is real and already paid for, so the slot layer's own
          // (synchronous) credential view learns from it -- see `credentialPresent` for why that
          // cache exists at all and why it must never fabricate an absence.
          recordCredentialPresence(resolvedChild.providerId, present);
          if (!present) {
            const reason = `no keychain record ${redactCredentialRef(material.authRef)} and no \`authRef\` on the child's own route (a child on another provider never inherits the parent's credential, Ruling E-1)`;
            // R-E3 (fix wave round 2): the refused child gets the DEFERRED-REFUSAL provider -- the same
            // shape an unresolvable session model gets. Its first generation lands on R6-F with NO
            // request anywhere: never the parent's provider with the foreign key on the parent's wire.
            const refusal = new WinterProviderResolutionError("no-credential-for-provider", `no credential is configured for provider "${resolvedChild.providerId}": ${reason}`);
            return {
              refused: { providerId: resolvedChild.providerId, modelKey: resolvedChild.modelKey, reason },
              provider: {
                async generate(): Promise<never> {
                  throw refusal;
                },
              },
              identity: {
                providerId: resolvedChild.providerId,
                modelKey: resolvedChild.modelKey,
                family: String(resolvedChild.adapter.family),
                ...(resolvedChild.continuationDomain !== undefined ? { continuationDomain: resolvedChild.continuationDomain } : {}),
                adapterId: resolvedChild.adapterId,
                adapterVersion: resolvedChild.adapter.version,
                catalogVersion: resolvedChild.catalogVersion,
                authRefKind: material.authRef.kind,
              },
            };
          }
        }
        return {
          provider: providerWiring.buildProvider(resolvedChild),
          identity: {
            providerId: resolvedChild.providerId,
            modelKey: resolvedChild.modelKey,
            family: String(resolvedChild.adapter.family),
            ...(resolvedChild.continuationDomain !== undefined ? { continuationDomain: resolvedChild.continuationDomain } : {}),
            adapterId: resolvedChild.adapterId,
            adapterVersion: resolvedChild.adapter.version,
            catalogVersion: resolvedChild.catalogVersion,
            // M-7: the CHILD's own material's kind -- the parent's `authRefKind` was stamped here
            // before, misreporting a cross-provider child's credential as its parent's.
            authRefKind: material.authRef.kind,
          },
        };
      },
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
