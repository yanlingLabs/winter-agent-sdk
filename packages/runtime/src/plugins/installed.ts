// WS-21 lane L1b, Task L1b.2 (spec §5.2/§6.3 item 5, Contract B): reads `<pluginsRoot>/installed_plugins.json`
// -- the SAME V2 document `@yanlinglabs/winter-agent-sdk`'s `packages/sdk/src/plugins/manage.ts`
// writes (`{version:2, plugins: {"<key>": [<record>, ...]}}`, one array per compound key because the
// identical plugin id can be installed at more than one scope; see `manage.ts`'s own header for the
// pinned-binary evidence this shape is measured against). This is the RUNTIME's own reader, called
// synchronously from `production-wiring.ts`'s plugin section (mirroring `loadPlugins`'s own
// synchronous file I/O), deliberately separate from `manage.ts`'s async, CLI-facing reader of the
// identical file -- the runtime reads once at startup, the CLI writes through its own locking
// discipline; two different concerns over one shared format, not two competing formats.
//
// `PluginRecord.id` is the file's own compound key ("<name>@<marketplace>", or whatever a host wrote
// with no marketplace) -- used ONLY to match against `enabledPlugins`' identically-spelled keys. The
// plugin's LOADED name (what skills/commands get qualified under, `p:skill`) comes from
// `loadPlugins`'s own manifest-or-basename rule, independent of this id: a marketplace-qualified
// `installPath` like `<marketplace>/plugins/p` resolves to the basename `p`, exactly the bare name
// test coverage expects.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface PluginRecord {
  /** The `installed_plugins.json` key this record came from -- see the header for why. */
  id: string;
  installPath: string;
  version?: string;
  scope: "user" | "project" | "local";
}

interface RawInstalledPluginRecord {
  scope?: unknown;
  installPath?: unknown;
  version?: unknown;
}

interface RawInstalledPluginsFile {
  plugins?: unknown;
}

const RECOGNIZED_SCOPES = new Set(["user", "project", "local"]);

/**
 * A scope this reader does not distinguish (claude's own `"managed"`, or anything a newer writer
 * mints) never drops the record -- only `manage.ts`'s three-member `PluginScope` union is
 * REPRESENTABLE here, so an unrecognized scope is read back as `"user"`. The record still loads
 * either way; only the reported `scope` field narrows. WS-21 §2.2's "both runtimes read the same
 * file" promise is about the PLUGIN loading, not about this field round-tripping losslessly for
 * every claude-native scope this build's own management API never writes.
 */
function normalizeScope(raw: unknown): PluginRecord["scope"] {
  return typeof raw === "string" && RECOGNIZED_SCOPES.has(raw) ? (raw as PluginRecord["scope"]) : "user";
}

/**
 * Every installed record, across every key and every scope. Never throws: an absent file, malformed
 * JSON, or a shape that is not the expected `{plugins: {...}}` object all read as `[]` -- a broken or
 * missing install ledger must never fail a session's whole plugin load (the same posture
 * `loadPlugins` takes toward one bad plugin directory).
 */
export function readInstalledPlugins(pluginsRoot: string): PluginRecord[] {
  let raw: string;
  try {
    raw = readFileSync(join(pluginsRoot, "installed_plugins.json"), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const plugins = (parsed as RawInstalledPluginsFile).plugins;
  if (typeof plugins !== "object" || plugins === null || Array.isArray(plugins)) return [];

  const out: PluginRecord[] = [];
  for (const [id, value] of Object.entries(plugins as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value as RawInstalledPluginRecord[]) {
      if (typeof entry?.installPath !== "string" || entry.installPath.length === 0) continue;
      out.push({
        id,
        installPath: entry.installPath,
        scope: normalizeScope(entry.scope),
        ...(typeof entry.version === "string" ? { version: entry.version } : {}),
      });
    }
  }
  return out;
}

// --- SV-4 (router same-view test): a DIRECTORY marketplace is read IN PLACE -- an `enabledPlugins`
// key plus a `known_marketplaces.json` entry is enough, even with NO `installed_plugins.json`
// record at all. Real claude resolves `enabledPlugins`' `<name>@<marketplace>` keys against
// `known_marketplaces.json` + the marketplace's own `.claude-plugin/marketplace.json` directly;
// Winter's runtime only ever consulted `installed_plugins.json`, so a plugin the user enabled in
// settings.json without ever running an explicit "install" step (which only WRITES that record --
// `@yanlinglabs/winter-agent-sdk`'s `packages/sdk/src/plugins/manage.ts` is where that happens)
// silently never loaded.
//
// MIRRORS `manage.ts`'s OWN `resolvePluginSourcePath`/`readKnownMarketplacesFile`/
// `readDirectoryMarketplaceManifest` algorithm and on-disk shapes -- SYNCHRONOUSLY (`readFileSync`,
// matching this file's own "called synchronously from production-wiring.ts" posture, `manage.ts`'s
// own header), a SEPARATE implementation rather than a shared import because that module is
// entirely `fs/promises`-based (the CLI's own async writer/reader, under its own locking
// discipline) and this runtime reader is not. Any change to `known_marketplaces.json`'s or a
// marketplace manifest's shape must update BOTH readers.

interface KnownMarketplaceRecordRaw {
  source?: { source?: unknown };
  installLocation?: unknown;
}

/** `{<name>: {sourceKind, installLocation}}`, skipping any entry that isn't shaped as expected -- a malformed or unreadable file resolves to `{}`, never a throw. */
function readKnownDirectoryMarketplaces(pluginsRoot: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(join(pluginsRoot, "known_marketplaces.json"), "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    const rec = value as KnownMarketplaceRecordRaw;
    // Only "directory" marketplaces are read in place -- the other three kinds (git/github/url)
    // need a fetch this synchronous, offline reader cannot perform (manage.ts's own
    // resolvePluginSourcePath refuses them identically, for the identical reason).
    if (rec.source?.source !== "directory") continue;
    if (typeof rec.installLocation !== "string" || rec.installLocation.length === 0) continue;
    out[name] = rec.installLocation;
  }
  return out;
}

interface MarketplaceManifestPluginEntryRaw {
  name?: unknown;
  source?: unknown;
}

/** `<installLocation>/.claude-plugin/marketplace.json`'s own `plugins[]`, resolved to `pluginName`'s absolute install path -- `undefined` for a missing/malformed manifest, an unlisted plugin, or a non-local (object-shaped) source. */
function resolveDirectoryMarketplacePluginPath(installLocation: string, pluginName: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(installLocation, ".claude-plugin", "marketplace.json"), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const manifest = parsed as { plugins?: unknown; metadata?: { pluginRoot?: unknown } };
  if (!Array.isArray(manifest.plugins)) return undefined;
  const entry = (manifest.plugins as MarketplaceManifestPluginEntryRaw[]).find((p) => p.name === pluginName);
  if (entry === undefined || typeof entry.source !== "string") return undefined;
  const pluginRoot = typeof manifest.metadata?.pluginRoot === "string" ? manifest.metadata.pluginRoot : ".";
  return resolve(installLocation, pluginRoot, entry.source);
}

/**
 * Every installed record whose id is `true` in `enabled` -- `enabledPlugins` (settings.json's own
 * field, the same one `manage.ts`'s `setEnabledInSettings` writes). `false`, absent, or a non-boolean
 * value (`enabledPlugins`' own type also admits `string[]`/an object, claude-native shapes this
 * build's own management API never writes) all resolve to "not loaded" -- the exact strict-`true`
 * check `manage.ts`'s own `readEnabledFromSettings` makes, so the two readers of one settings field
 * can never disagree about which plugins are on.
 *
 * SV-4: an enabled key with NO `installed_plugins.json` record falls back to resolving it against a
 * DIRECTORY marketplace named by the key's own `@<marketplace>` suffix, read in place -- see the
 * describe block above this function for the full citation. `scope` defaults to `"user"` for a
 * marketplace-resolved plugin (there is no install record to read a real scope from; `"user"` is
 * this file's own established fallback for exactly this "nothing to narrow from" case, see
 * `normalizeScope`).
 */
export function resolveEnabledPlugins(pluginsRoot: string, enabled: Record<string, boolean> | undefined): PluginRecord[] {
  if (enabled === undefined) return [];
  const installed = readInstalledPlugins(pluginsRoot);
  const out = installed.filter((record) => enabled[record.id] === true);
  const installedIds = new Set(installed.map((r) => r.id));

  let directoryMarketplaces: Record<string, string> | undefined;
  for (const [key, isEnabled] of Object.entries(enabled)) {
    if (isEnabled !== true || installedIds.has(key)) continue;
    // The SAME "<name>@<marketplace>" compound key installed_plugins.json's own ids use
    // (manage.ts's `keyFor`/`parseSpec`) -- the LAST "@" is the separator, so a plugin name
    // containing "@" still splits correctly.
    const at = key.lastIndexOf("@");
    if (at <= 0 || at === key.length - 1) continue;
    const name = key.slice(0, at);
    const marketplace = key.slice(at + 1);
    directoryMarketplaces ??= readKnownDirectoryMarketplaces(pluginsRoot);
    const installLocation = directoryMarketplaces[marketplace];
    if (installLocation === undefined) continue;
    const installPath = resolveDirectoryMarketplacePluginPath(installLocation, name);
    if (installPath === undefined) continue;
    out.push({ id: key, installPath, scope: "user" });
  }
  return out;
}
