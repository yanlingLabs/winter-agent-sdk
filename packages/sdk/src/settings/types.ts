// Phase 5 Task 2 (R5-8 as AMENDED after Task 1 -- derived-shapes-p5.md item (a)): the settings
// surface.
//
// WHY THIS LIVES IN packages/sdk AND NOT packages/runtime. The Task 2 brief names
// `packages/runtime/src/settings/{resolve,sources,trust}.ts`, but Task 1's item (a) found that
// `resolveSettings`/`filterEscalatingDefaultMode` are PINNED PUBLIC EXPORTS of the SDK surface
// (`sdk.d.ts:2809`/`694`), not Winter extensions -- and the amendment directs both to be exported
// from `packages/sdk/src/index.ts` as public API. WS-02 §3 forbids the sdk package from importing
// the runtime (enforced twice: tsconfig.sdk-fence.json, and `winter-agent-runtime` being only a
// devDependency of packages/sdk), so a runtime-side implementation could never be re-exported from
// that barrel. The implementation therefore lands here, exactly as `paths/home.ts` and
// `store/session-store.ts` did when they turned out to be public-adjacent; the brief's
// `packages/runtime/src/settings/*` files exist as pass-through re-exports plus the runtime-only
// trust seam, and remain THE seam authority the lanes import from.
//
// Node-only: this module is inside tsconfig.sdk-fence.json's fence (packages/sdk/src production
// code type-checks with `types: ["node"]` and NO Bun ambient globals) -- `node:fs/promises` and
// `node:path` only, never `Bun.file`/`Bun.env`.
import type { BrandProfile } from "../brand.ts";

/**
 * P7a (D19): the brand fields the settings cascade needs — the project dot-dir it looks in, and the
 * env prefix + home dir the user tier resolves through. A `Pick`, not the whole profile, so a
 * caller can thread three fields rather than construct one.
 */
export type SettingsBrand = Pick<BrandProfile, "envPrefix" | "homeDirName" | "projectDirName">;

// --- The pinned tier vocabularies -----------------------------------------------------------------
//
// THREE separate vocabularies live next to each other in the pinned declaration and must never be
// collapsed into one (derived-shapes-p5.md item (a)): `SettingSource` (which file tiers to LOAD),
// `ResolvedSettingSource` (which tier a resolved value CAME FROM -- adds the two non-file tiers),
// and `PolicySettingsOrigin` (how a `managed` value reached the process). A fourth,
// `PermissionUpdateDestination` (permissions/types.ts), spells the same three file tiers a third
// way for permission WRITES. Winter's own `RuleSource` (permissions/types.ts) is a fifth and is a
// RULE ORIGIN, not a file tier: it additionally carries `cliArg`/`session`/`sdk`.

// WS-13c §5: `Settings.modelSlots` holds the SAME shape the public listing surface uses, imported
// rather than re-declared — a settings key and the API that reports it disagreeing about an optional
// field is precisely the drift `protocol/config.ts`'s own header describes.
import type { ModelSlotSetting } from "../protocol/config.ts";

/** The three settings FILE tiers a session may load. `sdk.d.ts:7917`, verbatim and in pinned order. */
export type SettingSource = "user" | "project" | "local";

/** Pinned order (`sdk.d.ts:7917`). Also the value `settingSources: undefined` means (all three). */
export const SETTING_SOURCES: readonly SettingSource[] = ["user", "project", "local"] as const;

/** `sdk.d.ts:2783`: `SettingSource | 'managed' | 'flag'`. `'flag'` is R5-8's "inline/sdk" position. */
export type ResolvedSettingSource = SettingSource | "managed" | "flag";

/** `sdk.d.ts:2310`, verbatim -- how a `managed` value reached this process. */
export type PolicySettingsOrigin = "helper" | "remote" | "plist" | "hklm" | "file" | "parent" | "hkcu";

// --- The settings document ------------------------------------------------------------------------
//
// The pinned `Settings` is a ~2500-line interface generated from a settings JSON schema
// (`sdk.d.ts:5426-7912`). Winter declares the keys P5 actually resolves, plus an index signature so
// every OTHER key a settings file carries is PRESERVED and inert rather than dropped -- the same
// "accepted, preserved, inert" posture WS-08 §1 pins for unknown hook event names, applied to the
// settings document as a whole. A key Winter does not know about still merges, still gets
// provenance, and still reaches whichever future consumer learns to read it.

export interface SettingsHookHandler {
  /** `"command"` is the only shape a settings file can express; see buildHookEntriesFromSettings. */
  type?: string;
  command?: string;
  /** SECONDS (HookCallbackMatcher.timeout's pinned unit) -- converted to ms exactly once, at entry-build time. */
  timeout?: number;
}

export interface SettingsHookMatcherGroup {
  matcher?: string;
  hooks?: SettingsHookHandler[];
}

/** Open-keyed for the same reason RuntimeHooksConfig is (protocol/config.ts): unknown event names are accepted, preserved and inert. */
export type SettingsHooksConfig = Partial<Record<string, SettingsHookMatcherGroup[]>>;

export interface SettingsPermissionsBlock {
  allow?: string[];
  ask?: string[];
  deny?: string[];
  /** An OPEN string at this layer: a settings file is JSON, so an invalid mode must degrade at the consumer, never be assumed pre-validated. */
  defaultMode?: string;
  disableBypassPermissionsMode?: boolean;
  additionalDirectories?: string[];
  [key: string]: unknown;
}

export interface Settings {
  permissions?: SettingsPermissionsBlock;
  hooks?: SettingsHooksConfig;
  env?: Record<string, string>;
  apiKeyHelper?: string;
  /** `sdk.d.ts:7270` */
  outputStyle?: string;
  /** `sdk.d.ts:7734` */
  autoMemoryEnabled?: boolean;
  /**
   * `sdk.d.ts:7738`. Its own pinned doc (`7736`) says a PROJECT-set value is ignored for security --
   * the one per-key project-source restriction the declaration actually states. See OVERLAY_NEVER_KEYS.
   */
  autoMemoryDirectory?: string;
  /** `sdk.d.ts:7693` */
  plansDirectory?: string;
  /** `sdk.d.ts:6047`: the value is `string[] | boolean | object`, NOT a boolean map. */
  enabledPlugins?: Record<string, string[] | boolean | Record<string, unknown>>;
  /**
   * `sdk.d.ts:7755`. NEGATIVE sense, one-member literal -- there is NO `autoMode` key in the pinned
   * declaration (OQ-P5-2). Restrictive, so it is safe from every tier and is NOT an overlay-never key.
   */
  disableAutoMode?: "disable";
  /**
   * WINTER-DEFINED (disclosed): WS-07 §3.2's "`autoMode` is never taken from project/local" names a
   * key the pin does not have. Winter keeps the key and the restriction, narrowed per RULING P5-A to
   * the PROJECT tier only (the pinned analogue at `autoMemoryDirectory` is project-only).
   */
  autoMode?: string;
  // --- Phase 5 Task 8 (rider 26): the six keys P5's lanes consume ---------------------------------
  //
  // Every one of them shipped in Phase 5 reaching a real consumer through this interface's `[key:
  // string]: unknown` index signature -- so a lane's typed parameter had to be fed by a cast at the
  // call site, and a typo in a key name was indistinguishable from an absent key. Declared here so
  // the narrowing happens once (production-wiring.ts) and the compiler carries the contract.
  //
  // NONE of them is an overlay-never key: `skillOverrides`/`disableBundledSkills`/
  // `strictPluginOnlyCustomization` only ever REMOVE capability, the two listing caps only bound a
  // prompt region, and `mcpServers` is already trust-gated at its own consumer (P5-A, via
  // `origin: "project"` on the project tier). Widening `OVERLAY_NEVER_KEYS` for a restrictive key
  // would let a repository lose a protection it is allowed to add.
  /** `sdk.d.ts:5651`. Per-skill visibility: `on` | `name-only` | `user-invocable-only` | `off`; an unrecognised value reads as `on`. */
  skillOverrides?: Record<string, string>;
  /** `sdk.d.ts:5657`. Removes the BUILTIN skill tier and nothing else. */
  disableBundledSkills?: boolean;
  /** `sdk.d.ts:5988`. `true`, or the areas (`skills`/`agents`/`hooks`/`mcp`) restricted to plugin contributions only. */
  strictPluginOnlyCustomization?: boolean | string[];
  /** `sdk.d.ts:5499`. Per-description cap in the model-facing skill listing (default 1536 chars). */
  skillListingMaxDescChars?: number;
  /** `sdk.d.ts:5503`. The listing's share of the context window (default 0.01). */
  skillListingBudgetFraction?: number;
  /**
   * A settings-tier MCP server block. Deliberately `Record<string, unknown>` rather than a typed
   * server union: `settings/loaders/mcp-config.ts` validates each entry and `resolveMcpServerSources`
   * is the sole authority on the shapes, so a type here would be a second, drift-prone declaration
   * of a contract that already has one.
   */
  mcpServers?: Record<string, unknown>;
  /**
   * WINTER-DEFINED (WS-13b R6b-7, disclosed): per-provider enablement, keyed by catalog provider id.
   *
   * Its whole reason for existing is the reversion condition. `xai-oauth` ships on prong 2 of the
   * admission rule -- a vendor's public product client used with an honest Winter identity -- and
   * WS-13b §4 requires that a vendor rejecting that identity can be answered WITHOUT a release. A
   * setting is that answer; a compile-time constant is not.
   *
   * ABSENT MEANS ENABLED. Silence is not a disablement, so an unlisted provider resolves normally
   * and only an explicit `enabled: false` refuses.
   *
   * RESTRICTIVE-ONLY ACROSS TIERS (RULING R6b-9), enforced by `restrictProviderEnables` in
   * `resolve.ts` rather than by the ordinary merge: the effective value is `false` if ANY tier says
   * `false`, and a lower tier's `true` never re-enables what a higher one disabled. Without that,
   * a cloned repository's PROJECT settings file could put back a provider its operator withdrew —
   * and this key IS the reversion switch (R6b-7 / WS-13b §4), so a switch a repository can flip back
   * would not be one.
   *
   * NOT an OVERLAY_NEVER_KEY, deliberately: a never-key drops the project tier's value entirely,
   * which would also drop a project's legitimate `false`. Disabling is a tightening every tier may
   * make; only the enabling direction is restricted — the same asymmetry `permissions.deny` and
   * `permissions.allow` already carry.
   */
  providers?: Record<string, { enabled?: boolean }>;
  /**
   * WINTER-DEFINED (WS-13c §5, D27, disclosed): the user's OWN four options, with the facing names
   * that show on the Agent tool and the default model switcher.
   *
   * 1–4 entries. Honoured from the USER tier and the TRUSTED project tier only (R13c-7) — an
   * untrusted project's set is ignored whole and recorded as `modelSlotsIgnored:
   * "untrusted-project"`. That gate is the point of the key, not a precaution around it: a cloned
   * repository that could map `cheap` to Astra would be choosing what the user's agent spends.
   *
   * Validated WHOLE (never partially): a set with one bad entry is ignored entirely and the failing
   * entry recorded, because a partially-applied set is a lineup the user did not ask for.
   */
  modelSlots?: ModelSlotSetting[];
  /**
   * WINTER-DEFINED (WS-13c §4 step 3-ii, disclosed): an ordered list of provider ids, consulted
   * after the family's own `vendorProviders` and before the admission-tier fallback.
   *
   * A PREFERENCE, never an admission: a provider named here still needs a credential and still
   * obeys `providers.<id>.enabled`. Same tiers and same hot-reload as `modelSlots`.
   */
  preferredProviders?: string[];
  /**
   * WINTER-DEFINED (D30, WS-06 §4's advisor amendment, disclosed): which model the ADVISOR consults.
   *
   * `model` names a slot name, a canonical model id or a catalog key, resolved through WS-13c §4 —
   * the same path the session model takes, so it obeys credentials, `providers.<id>.enabled` and the
   * vendor-first order, and an unresolvable value is a typed refusal rather than a substitution.
   *
   * SAME TIERS AS `modelSlots`, deliberately: the user tier and the TRUSTED project tier only. The
   * advisor sends this session's conversation to whatever this names, so a cloned repository that
   * could set it would be choosing where the user's transcript goes — the identical argument that
   * gates `modelSlots`, with a higher price for getting it wrong.
   *
   * HOT (a Global Constraint of this phase): it takes effect at the next quiescent boundary through
   * the live settings getter, never at a restart. Unset means the per-family default (D30: a gpt
   * session -> `astra`, a claude session -> `fable`, any other family -> its slot 1, a family with
   * no slots -> the session's own model). `Options.advisor.model` outranks it.
   *
   * DECLARED AT P7a'S SPINE; the resolution and the trust gate are Lane B's.
   */
  advisor?: { model?: string };
  /**
   * DERIVED provenance — written by `resolve.ts` / the runtime, NEVER read from a settings file.
   *
   * It records WHY a `modelSlots` set did not take effect, so a host can say so instead of showing
   * the default lineup with no explanation: the set came from an untrusted project tier, it failed
   * whole-set validation, or the session's effective main model is a Claude model and D25 pins that
   * enum. A file that sets this key is stating a conclusion it does not get to draw; the resolver
   * overwrites it.
   */
  modelSlotsIgnored?: "untrusted-project" | "invalid" | "claude-pinned";
  [key: string]: unknown;
}

/**
 * Narrows `Settings.providers` into the shape selection consumes: every declared id present, with an
 * explicit boolean.
 *
 * ONE narrowing, at one place (the rider-26 pattern the six P5 keys established), so a typo'd key or
 * a JSON file saying `"enabled": "false"` is handled here rather than at each reader with a cast.
 *
 * Total by construction: a settings file is JSON and may say anything. A non-object entry, an empty
 * provider id and a non-boolean `enabled` are all DROPPED rather than coerced -- coercing `"false"`
 * to `false` would disable a provider on the strength of a typo, and coercing it to `true` would
 * pretend the user said something they did not. Only a literal `false` disables.
 */
export function providerSettingsFrom(settings: Settings | undefined): Record<string, { enabled: boolean }> {
  const raw = settings?.["providers"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, { enabled: boolean }> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (id.length === 0) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const enabled = (value as { enabled?: unknown }).enabled;
    out[id] = { enabled: enabled === false ? false : true };
  }
  return out;
}

// --- Resolution results ---------------------------------------------------------------------------

/** `sdk.d.ts:2413-2419`, verbatim. */
export interface ProvenanceEntry {
  source: ResolvedSettingSource;
  path?: string;
  policyOrigin?: PolicySettingsOrigin;
}

/** One tier's contribution, RAW (never overlay-filtered) -- the pinned `sources` escape hatch (`sdk.d.ts:2764-2767`). */
export interface ResolvedSettingsSourceEntry {
  source: ResolvedSettingSource;
  settings: Settings;
  path?: string;
  policyOrigin?: PolicySettingsOrigin;
}

/**
 * `sdk.d.ts:2759-2774`, verbatim three fields.
 *
 * `provenance` is per TOP-LEVEL key only (`2762`) -- runtime-confirmed by capture (1): with
 * `permissions.allow` from project and `permissions.defaultMode` from local, the merged
 * `effective.permissions` carried both and `provenance.permissions.source` reported `local` alone.
 * A consumer that needs finer attribution reads `sources` (which this implementation orders
 * highest-precedence first), exactly as the pinned field's own doc directs.
 */
export interface ResolvedSettings {
  effective: Settings;
  provenance: Partial<Record<string, ProvenanceEntry>>;
  sources: ResolvedSettingsSourceEntry[];
}

/** `sdk.d.ts:2815-2843`, verbatim four fields -- ONE options object, not four positional parameters. */
export interface ResolveSettingsOptions {
  cwd?: string;
  settingSources?: SettingSource[];
  /**
   * Programmatic policy tier. The pinned doc (`2018-2040`) says the pinned runtime filters this tier
   * RESTRICTIVE-ONLY.
   *
   * WINTER DOES NOT APPLY THAT FILTER (Phase 5 fix wave, A-4 -- said plainly here, where the old
   * one-liner quoted the pin's behaviour in a way a reader could take for Winter's). A managed tier
   * is merged like any other, at the top of the precedence order, so a managed PERMISSIVE rule
   * widens where the pin would drop it. That is a DISCLOSED DIVERGENCE, not an oversight: the pinned
   * filter's exact rule is not stated anywhere in scope, no capture exercised it, and inventing one
   * would be Winter guessing at a security-relevant transformation. The direction of the divergence
   * is the permissive one, which is why it is disclosed here rather than buried in a report.
   */
  managedSettings?: Settings;
  /** Remote policy payload -- pinned doc `2838-2839`: explicitly UNfiltered where `managedSettings` is filtered. */
  serverManagedSettings?: Settings;
}

// --- Winter-side detail (NOT part of the pinned surface) ------------------------------------------

/** A per-tier record carrying what the pinned `sources` entry cannot: whether the file loaded, and why not. */
export interface DetailedSettingsSourceEntry extends ResolvedSettingsSourceEntry {
  /** True iff a file/inline value existed AND parsed to a JSON object. */
  loaded: boolean;
  /** Present iff `loaded` is false because something existed but could not be used (parse error, wrong shape, unreadable). */
  error?: string;
  /** Alias of `settings`, kept under the brief's own field name so lane code can use either. */
  values: Settings;
}

export interface DetailedResolvedSettings extends ResolvedSettings {
  /** Highest-precedence first, same order as `sources`; a superset of it. */
  perSource: DetailedSettingsSourceEntry[];
}

export interface ResolveSettingsDetailedOptions extends ResolveSettingsOptions {
  /** RULING P5-A's host-declared workspace-trust bit, threaded by production-wiring. Absent = untrusted (fail-safe): the project tier's `modelSlots`/`preferredProviders` are dropped (WS-13c §5, R-6c-16). */
  trustedWorkspace?: boolean;
  /** Explicit resolved home root. Tests MUST pass this rather than mutating process.env (a shared-process `bun test` run would race). */
  winterHome?: string;
  /** Injectable environment for home resolution; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * P7a (D19): the session's resolved brand profile, which decides the PROJECT tier's directory
   * (`<cwd>/<projectDirName>/settings.json`) and the env name the user tier's home is read from.
   * Absent means Winter's own profile — every caller predating it keeps today's paths exactly.
   */
  brand?: SettingsBrand;
  /** The `'flag'` tier -- R5-8's "inline/sdk" position. Unreachable from the pinned options object, which has no inline input. */
  inline?: Settings;
}

/**
 * Keys that are NEVER taken from PROJECT settings.
 *
 * Scope correction vs the Task 2 brief: the brief said "project/local"; RULING P5-A (and the one
 * pinned per-key restriction this can mirror, `autoMemoryDirectory`'s own doc at `sdk.d.ts:7736`)
 * make it PROJECT-only. `local` is gitignored and personal -- it carries the same authority as
 * `user` under the captured per-tier filter; only the repo-committed tier is restricted.
 *
 * `disableAutoMode` is deliberately ABSENT: it is restrictive (`'disable'` is its only value), so a
 * repo-committed file setting it can only ever tighten, which every tier is allowed to do.
 *
 * `outputStyle` JOINED IN THE PHASE 5 FIX WAVE (whole-branch m1). RULING P5-G gates a project-tier
 * style FILE to append-only -- a checked-in project-tier output-style file may add to the prompt but
 * never replace it. It says nothing about SELECTION, and selection is the other half of the same
 * power: a project `settings.json` naming one of the USER's own styles -- one the user wrote with
 * `keep-coding-instructions: false` -- would replace the authored prompt on the strength of a
 * repository's choice. The style file is the user's; the decision to apply it was not. Same
 * self-grant shape P5-A closes, arriving through selection rather than through content.
 *
 * A host that genuinely wants a per-repository style still has one: `Options.outputStyle`, which is
 * the host's own configuration and outranks every file tier.
 */
export const OVERLAY_NEVER_KEYS: readonly string[] = ["autoMemoryDirectory", "autoMode", "outputStyle"] as const;

/**
 * The permission modes `filterEscalatingDefaultMode` treats as escalating (pinned doc `686-694`).
 * `plan`/`default` are non-escalating and survive from any tier.
 */
export const ESCALATING_PERMISSION_MODES: readonly string[] = ["bypassPermissions", "auto", "acceptEdits"] as const;

/**
 * PROJECT-tier permission keys that LOAD but never WIDEN in an untrusted workspace (RULING P5-A,
 * capture (1) cells B/I/O). `deny`/`ask` are deliberately absent: they only ever tighten, and
 * capture (1) cells K/L prove a project `deny` is honored and beats a local `allow`.
 */
export const PROJECT_PERMISSIVE_KEYS: readonly string[] = ["allow", "additionalDirectories"] as const;
