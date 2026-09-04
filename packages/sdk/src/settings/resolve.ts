// Phase 5 Task 2 (R5-8 as AMENDED after Task 1): the settings cascade, its provenance, and the two
// trust filters. See ./types.ts's header for why this lives in packages/sdk.
//
// WS-15 §8 / phase Global Constraints: NO WATCHERS. Resolution happens once, when a session starts,
// exactly as the pinned contract does; hot-reload is a product concern above the SDK boundary.
import { loadSettingsFile, settingsPathFor } from "./sources.ts";
import {
  ESCALATING_PERMISSION_MODES,
  OVERLAY_NEVER_KEYS,
  PROJECT_PERMISSIVE_KEYS,
  SETTING_SOURCES,
  type DetailedResolvedSettings,
  type DetailedSettingsSourceEntry,
  type ProvenanceEntry,
  type ResolvedSettings,
  type ResolveSettingsDetailedOptions,
  type ResolveSettingsOptions,
  type Settings,
  type SettingSource,
} from "./types.ts";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Precedence-aware merge, HIGHEST-first accumulation is NOT what happens here -- callers hand
 * `entries` lowest-precedence first and each later entry overwrites. Nested plain objects merge
 * recursively (capture (1): `effective.permissions` carried `allow` from one tier and `defaultMode`
 * from another); arrays and scalars are REPLACED wholesale by the higher tier, never concatenated.
 *
 * Array replacement is deliberate and is why R5-8 keeps permission-rule arrays per-source: a merged
 * `effective.permissions.allow` is the winning tier's list alone, while `sources`/`perSource` still
 * carry every tier's own list for the P2 evaluator to fold in by `RuleSource`.
 */
function deepMergeInto(target: Record<string, unknown>, overlay: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    const existing = target[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      const merged: Record<string, unknown> = { ...existing };
      deepMergeInto(merged, value);
      target[key] = merged;
      continue;
    }
    target[key] = value;
  }
}

/**
 * RULING P5-A / OQ-P5-2: the PROJECT tier's contribution with the overlay-never keys removed.
 * Applied only when computing `effective`/`provenance` -- `sources`/`perSource` keep the RAW file
 * so the escape hatch never lies about what the repo-committed file actually said.
 */
function withoutOverlayNeverKeys(values: Settings): Settings {
  const out: Record<string, unknown> = { ...values };
  for (const key of OVERLAY_NEVER_KEYS) delete out[key];
  return out as Settings;
}

const SOURCE_ORDER_LOWEST_FIRST: readonly SettingSource[] = ["user", "project", "local"] as const;

/**
 * The Winter-side resolver. `resolveSettings` (the pinned export, below) is a thin projection of
 * this onto the pinned three fields.
 *
 * Precedence, highest first (R5-8): managed (server, then programmatic) > flag (inline/sdk) >
 * local > project > user. `local` above `project` is the pinned ordering capture (1) proves
 * behaviourally (cell J vs I: only a rule in the LOCAL file silences a prompt).
 */
export async function resolveSettingsDetailed(opts: ResolveSettingsDetailedOptions = {}): Promise<DetailedResolvedSettings> {
  const cwd = opts.cwd ?? process.cwd();
  const selected: readonly SettingSource[] = opts.settingSources ?? SETTING_SOURCES;
  const pathOpts = {
    cwd,
    ...(opts.winterHome !== undefined ? { winterHome: opts.winterHome } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  };

  // Built lowest-precedence first so the merge below is a plain left-to-right overwrite; reversed
  // once at the end so BOTH `sources` and `perSource` read highest-precedence first (which is what
  // `filterEscalatingDefaultMode`'s own winning-setter walk needs, and the least surprising order
  // for a consumer reading the escape hatch).
  const lowestFirst: DetailedSettingsSourceEntry[] = [];

  for (const source of SOURCE_ORDER_LOWEST_FIRST) {
    if (!selected.includes(source)) continue;
    const path = settingsPathFor(source, pathOpts);
    const file = await loadSettingsFile(path);
    if (!file.present) continue; // an absent file contributes no entry at all
    lowestFirst.push({
      source,
      path,
      settings: file.values,
      values: file.values,
      loaded: file.loaded,
      ...(file.error !== undefined ? { error: file.error } : {}),
    });
  }

  if (opts.inline !== undefined) {
    lowestFirst.push({ source: "flag", settings: opts.inline, values: opts.inline, loaded: true });
  }
  // Two `managed` entries are possible and both report `source: "managed"`, distinguished by
  // `policyOrigin` (the pinned sub-classification, `sdk.d.ts:2310`). `serverManagedSettings` is
  // ranked ABOVE `managedSettings`: it is the one the pinned doc calls explicitly UNfiltered
  // (`2838-2839`) where the programmatic tier is filtered restrictive-only, so it carries the
  // broader authority. A DOCUMENTED JUDGMENT CALL -- the declaration pins neither the relative order
  // nor the filter's exact rule, and no capture exercised two policy tiers at once.
  if (opts.managedSettings !== undefined) {
    lowestFirst.push({ source: "managed", policyOrigin: "file", settings: opts.managedSettings, values: opts.managedSettings, loaded: true });
  }
  if (opts.serverManagedSettings !== undefined) {
    lowestFirst.push({ source: "managed", policyOrigin: "remote", settings: opts.serverManagedSettings, values: opts.serverManagedSettings, loaded: true });
  }

  const effective: Record<string, unknown> = {};
  const provenance: Record<string, ProvenanceEntry> = {};
  for (const entry of lowestFirst) {
    const contribution = entry.source === "project" ? withoutOverlayNeverKeys(entry.values) : entry.values;
    deepMergeInto(effective, contribution as Record<string, unknown>);
    for (const key of Object.keys(contribution)) {
      if ((contribution as Record<string, unknown>)[key] === undefined) continue;
      provenance[key] = {
        source: entry.source,
        ...(entry.path !== undefined ? { path: entry.path } : {}),
        ...(entry.policyOrigin !== undefined ? { policyOrigin: entry.policyOrigin } : {}),
      };
    }
  }

  const perSource = [...lowestFirst].reverse();
  return {
    effective: effective as Settings,
    provenance,
    sources: perSource.map((e) => ({
      source: e.source,
      settings: e.settings,
      ...(e.path !== undefined ? { path: e.path } : {}),
      ...(e.policyOrigin !== undefined ? { policyOrigin: e.policyOrigin } : {}),
    })),
    perSource,
  };
}

/**
 * PINNED EXPORT (`sdk.d.ts:2809`): `resolveSettings(_opts?: ResolveSettingsOptions): Promise<ResolvedSettings>`.
 *
 * Task 1's item (a) found this is a MIRROR of a pinned function, not the "disclosed Winter
 * extension" R5-8 originally described -- one options object (never four positional parameters),
 * and exactly three result fields. Winter-side detail (per-source raw values, load errors, the
 * inline/`flag` tier, an explicit `winterHome`) lives on `resolveSettingsDetailed` above, which this
 * wraps: a caller writing against the pinned surface sees nothing extra.
 *
 * WS-03 disclosure: the pinned options object carries no environment/home injection point, so an
 * omitted `settingSources` (or one including `"user"`) reads the REAL resolved WINTER_HOME. Tests
 * must therefore either exclude the `user` tier or call `resolveSettingsDetailed` with an explicit
 * `winterHome`.
 */
export async function resolveSettings(opts?: ResolveSettingsOptions): Promise<ResolvedSettings> {
  const { effective, provenance, sources } = await resolveSettingsDetailed(opts ?? {});
  return { effective, provenance, sources };
}

/**
 * Finds which source actually SET a nested path, by walking `sources` (already highest-precedence
 * first) and returning the first tier that carries it.
 *
 * This is finer than `provenance`, which the pin defines per TOP-LEVEL key only, and it is derivable
 * from the pinned `ResolvedSettings` alone -- the `sources` array is the escape hatch the pinned
 * field's own doc (`2764-2767`) points at for exactly this.
 */
function winningSourceFor(resolved: ResolvedSettings, path: readonly string[]): ResolvedSettings["sources"][number] | undefined {
  for (const entry of resolved.sources) {
    let cursor: unknown = entry.settings;
    let found = true;
    for (const segment of path) {
      if (!isPlainObject(cursor) || !(segment in cursor)) {
        found = false;
        break;
      }
      cursor = cursor[segment];
    }
    if (found && cursor !== undefined) return entry;
  }
  return undefined;
}

/**
 * PINNED EXPORT (`sdk.d.ts:694`, doc `686-694`): drops `permissions.defaultMode` from the resolved
 * settings iff it is ESCALATING (`bypassPermissions`/`auto`/`acceptEdits`) AND was set by the
 * `project` tier -- the repo-committed one. Every other key, including `allow`/`deny`/`ask`, is
 * returned untouched, and a non-escalating project `defaultMode` (`plan`) survives. Verified against
 * the pinned runtime in capture (1)'s declared-API table, all four rows.
 *
 * The "which tier set it" question is answered by walking `sources`, NOT by reading
 * `provenance.permissions` -- the two disagree in one observable case, and only one of them is
 * safe: with an escalating `defaultMode` in project and an `allow` in local, the coarse per-top-
 * level-key provenance reports `local` (so a provenance-driven filter would RETAIN the escalating
 * repo-committed mode) while the walk correctly attributes `defaultMode` to `project` and drops it.
 * That specific combination was not captured against the pinned runtime; the walk is the fail-safe
 * direction and is what Winter ships. Recorded in the Task 2 report.
 *
 * Never mutates its input.
 */
export function filterEscalatingDefaultMode(resolved: ResolvedSettings): Settings {
  const permissions = resolved.effective["permissions"];
  if (!isPlainObject(permissions)) return { ...resolved.effective };
  const defaultMode = permissions["defaultMode"];
  if (typeof defaultMode !== "string" || !ESCALATING_PERMISSION_MODES.includes(defaultMode)) return { ...resolved.effective };
  if (winningSourceFor(resolved, ["permissions", "defaultMode"])?.source !== "project") return { ...resolved.effective };
  const nextPermissions: Record<string, unknown> = { ...permissions };
  delete nextPermissions["defaultMode"];
  return { ...resolved.effective, permissions: nextPermissions } as Settings;
}

export interface WorkspaceTrustFilterOptions {
  /** Host-declared workspace trust (RULING P5-A). Default false -- a repository never self-trusts (WS-07 §3.2). */
  trustedWorkspace?: boolean;
}

/**
 * RULING P5-A, the whole tier filter in one call -- what a lane should use.
 *
 * Capture (1)'s finding, verbatim: the pinned SDK's trust is a per-TIER filter on PERMISSIVE rules,
 * not a per-directory bit. A PROJECT-tier `allow`/`additionalDirectories` LOADS but does not widen;
 * `local`- and `user`-tier permissive rules do widen; `deny`/`ask` from every tier apply regardless
 * (cells K/L: a project `deny` is honored and beats a local `allow`).
 *
 * Winter layers ONE product extension above that: a host may declare the workspace trusted
 * (`RuntimeConfig.trustedWorkspace`), which lifts the project-tier restriction. The filter is never
 * DERIVED from that bit in the other direction -- an untrusted repo's project-tier `deny` stays
 * enforced, which is the thing capture (1) explicitly forbids losing.
 *
 * Also applies the pinned `filterEscalatingDefaultMode`, which is tier-based and therefore fires
 * even in a trusted workspace: a repo-committed escalating `defaultMode` never survives, trust or
 * no trust.
 *
 * Never mutates its input.
 */
export function applyWorkspaceTrust(resolved: ResolvedSettings, opts: WorkspaceTrustFilterOptions = {}): Settings {
  const afterModeFilter = filterEscalatingDefaultMode(resolved);
  if (opts.trustedWorkspace === true) return afterModeFilter;
  const permissions = afterModeFilter["permissions"];
  if (!isPlainObject(permissions)) return afterModeFilter;
  const nextPermissions: Record<string, unknown> = { ...permissions };
  let changed = false;
  for (const key of PROJECT_PERMISSIVE_KEYS) {
    if (!(key in nextPermissions)) continue;
    if (winningSourceFor(resolved, ["permissions", key])?.source !== "project") continue;
    delete nextPermissions[key];
    changed = true;
  }
  return changed ? ({ ...afterModeFilter, permissions: nextPermissions } as Settings) : afterModeFilter;
}
