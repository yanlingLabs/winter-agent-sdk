// WS-21 lane L1b, Task L1b.3 (spec §6.3 item 7; F15): a plugin-management API matching
// `claude plugin …`, exported for the Winter CLI's own `winter plugin` surface. Per the spec's own
// parity note: claude's management lives in ITS CLI, not its runtime -- this export is only that
// CLI's implementation (a future `winter plugin` verb calls it), never a runtime behaviour. It
// writes the same files, in the same way, as claude's own CLI.
//
// EVIDENCE (measured against the pinned `claude` binary, v0.3.250 / CLI 2.1.250, the same build the
// spec's F15/F17 cite -- `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.250`'s `claude` executable,
// read with the embedded-JS `grep`/offset technique the spec's own facts were measured with):
//
//   - `installed_plugins.json` is a V2 document, `{version: 2, plugins: {<key>: [<record>, …]}}` --
//     an ARRAY of records per key (one per scope a plugin is installed at), not a single record.
//     Confirmed by the binary's own V1->V2 converter: `function Soe(e){let t={};for(let[r,o]of
//     Object.entries(e.plugins)){let u=AM(r,o.version);t[r]=[{scope:"user",installPath:u,
//     version:o.version,installedAt:o.installedAt,lastUpdated:o.lastUpdated,
//     gitCommitSha:o.gitCommitSha}]}return{version:2,plugins:t}}` -- V1 held one record per key
//     (implicitly `scope:"user"`), and upgrading to V2 wraps it in a one-element array. The per-
//     record zod schema (same binary) declares `scope: enum(["managed","user","project","local"])`,
//     `installPath`, `version?`, `installedAt?`, `lastUpdated?`, `gitCommitSha?`. This module writes
//     the subset the WS-21 lane brief's `InstalledPlugin` needs: `scope`, `installPath`, `version?`,
//     `installedAt?`, `lastUpdated?`.
//   - the compound key is `"<name>@<marketplace>"` when a marketplace is named, confirmed by the
//     same binary's zod transform: `.transform((e)=>e.marketplace?\`${e.name}@${e.marketplace}\`:
//     e.name)`.
//   - `known_marketplaces.json` is an object keyed by marketplace NAME, each value
//     `{source, installLocation, lastUpdated, autoUpdate}` -- confirmed by the binary's own seed-
//     sync code: ``o.push([T,{source:E.source,installLocation:R,lastUpdated:E.lastUpdated,
//     autoUpdate:!1}])``. `source` is itself a discriminated object (`{source:"directory",path}` /
//     `{source:"git",url,…}` / `{source:"github",repo,…}` / `{source:"url",url,…}`, from the same
//     binary's marketplace-add zod union, `mJn=new Set(["url","github","git","npm","file",
//     "directory","skills-dir","hostPattern","pathPattern","settings"])`); this module supports the
//     four kinds the WS-21 lane brief's `MarketplaceInfo.kind` names.
//   - `known_marketplaces.json` is written under a lock (the binary passes `{lockfilePath:
//     \`${r}.lock\`, retries:{retries:5,minTimeout:100,maxTimeout:1000}, onCompromised}` to a
//     `proper-lockfile`-shaped call), and a lock that cannot be acquired is a LOGGED, NON-FATAL
//     degrade -- the write proceeds anyway (`"Failed to acquire known_marketplaces.json lock,
//     writing without it"`). This module's own lock (below) matches that shape: bounded retries,
//     then proceed regardless.
//   - `installed_plugins.json` has NO such lock -- the WS-21 lane brief states its write discipline
//     directly (temp file `<f>.tmp.<8hex>` opened `wx`, then `rename`; EXDEV/EPERM/EEXIST/EBUSY fall
//     back to an in-place write), matching the binary's own temp-name regexes for this family of
//     files (`^[0-9]+\.tmp\.[0-9a-f]{8}$`, `\.tmp[.~][0-9a-f]{8}$`).
//   - a directory marketplace's manifest lives at `.claude-plugin/marketplace.json`
//     (`F("directory")` source: `{source:"directory",path:"Local directory containing
//     .claude-plugin/marketplace.json"}`) and is READ IN PLACE, nothing copied (F15/§5.2). Its
//     top-level shape (same binary, the manifest's own zod object): `{$schema?, name, version?,
//     description?, owner, plugins: [...], forceRemoveDeletedPlugins?, metadata?:{pluginRoot?}}`.
//     A plugin entry's `source` may be a bare STRING -- "Path to the plugin root, relative to the
//     marketplace root (the directory containing .claude-plugin/, not .claude-plugin/ itself)" --
//     which is the only source shape this module resolves (no network); `metadata.pluginRoot`
//     ("Base directory for bare plugin source names… e.g. './plugins' resolves \"source\":
//     \"formatter\" as ./plugins/formatter") is honoured the same way.
//
// SCOPE (this build, this task): directory marketplaces only, added/read/updated in place, no
// network. `addMarketplace`/`updateMarketplace` on a `git`/`github`/`url` source, and
// `installPlugin`/`updatePlugin` on a plugin whose own entry names one of those sources, are refused
// typed rather than attempted -- there is no fetch, clone, or npm-install path here. A future lane
// that ships the network sources extends `classifySource`/`resolvePluginSourcePath`, not this
// module's shape.
//
// F21 (settings.local.json's global-git-excludes side effect) is NOT implemented here -- it is not
// in this task's brief, and a plugin manager has no occasion to write `localSettings` on its own.
//
// Bare-name plugin specs (`"p"` with no `@marketplace`, resolved by searching every known
// marketplace) are NOT implemented -- every `spec` here must be `"<name>@<marketplace>"`. The brief's
// own write-discipline tests only ever exercise the qualified form, and inferring a marketplace from
// an ambiguous bare name is exactly the kind of guess the qualified-tags precedent (WS-20) rules out
// elsewhere in this codebase; a `winter plugin install <name>` CLI verb can resolve that ambiguity
// itself (by listing marketplaces and asking) before calling down to this API.
import { mkdir, open, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { Settings } from "../settings/types.ts";
import { loadSettingsFile } from "../settings/sources.ts";

export class PluginManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginManagerError";
  }
}

export type PluginScope = "user" | "project" | "local";

export interface PluginManagerOptions {
  /** claude's plugins root (WS-21 §6.3 item 5: `storeHome/plugins`) -- `installed_plugins.json` and `known_marketplaces.json` live directly under it. */
  pluginsRoot: string;
  /** The `enabledPlugins` carrier for one scope -- the settings file at that tier (`sdk/settings.json`, `.winter/settings.json`, `.winter/settings.local.json`). */
  settingsPathFor(scope: PluginScope): string;
}

export interface MarketplaceInfo {
  name: string;
  /** The human-facing locator: the directory path, the repo `owner/repo`, or the URL -- whichever the source kind carries. */
  source: string;
  kind: "directory" | "git" | "github" | "url";
  /** Where the marketplace's own content lives on disk. For `directory`, this IS the source (read in place, F15). */
  path: string;
}

export interface InstalledPlugin {
  id: string;
  version?: string;
  installPath: string;
  scope: PluginScope;
}

export interface PluginListing extends InstalledPlugin {
  enabled: boolean;
  marketplace: string;
}

// --- on-disk shapes (F15, evidence above) --------------------------------------------------------

interface InstalledPluginRecordV2 {
  scope: PluginScope;
  installPath: string;
  version?: string;
  installedAt?: string;
  lastUpdated?: string;
}

interface InstalledPluginsFileV2 {
  version: 2;
  plugins: Record<string, InstalledPluginRecordV2[]>;
}

interface KnownMarketplaceSource {
  source: MarketplaceInfo["kind"];
  path?: string;
  url?: string;
  repo?: string;
}

interface KnownMarketplaceRecord {
  source: KnownMarketplaceSource;
  installLocation: string;
  lastUpdated: string;
  autoUpdate: boolean;
}

type KnownMarketplacesFile = Record<string, KnownMarketplaceRecord>;

interface MarketplaceManifestPluginEntry {
  name: string;
  source: string | Record<string, unknown>;
  version?: string;
  description?: string;
}

interface MarketplaceManifest {
  name: string;
  version?: string;
  description?: string;
  plugins: MarketplaceManifestPluginEntry[];
  metadata?: { pluginRoot?: string };
}

function installedPluginsPath(o: PluginManagerOptions): string {
  return join(o.pluginsRoot, "installed_plugins.json");
}

function knownMarketplacesPath(o: PluginManagerOptions): string {
  return join(o.pluginsRoot, "known_marketplaces.json");
}

function isEnoent(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === "ENOENT";
}

// --- installed_plugins.json: write-temp-then-rename, NO lock (F15) -------------------------------
//
// "last writer wins, exactly as concurrent claude sessions" -- see manage-concurrency.fixture.ts and
// its test: two processes each read-modify-write this file with no coordination, and the ACCEPTED
// outcomes are (a) both survive, if the two read/write windows happened not to overlap, or (b) only
// the later `rename()`'s writer survives, if they did. Both are legitimate; there is no third
// outcome, because `rename()` is atomic and this module never writes a torn file.
const RETRYABLE_RENAME_CODES = new Set(["EXDEV", "EPERM", "EEXIST", "EBUSY"]);

async function writeJsonAtomicNoLock(path: string, data: unknown): Promise<void> {
  const body = `${JSON.stringify(data, null, 2)}\n`;
  const tmp = `${path}.tmp.${randomBytes(4).toString("hex")}`;
  // Tracks whether THIS call actually created `tmp`, so the fallback below never unlinks a file it
  // does not own -- an `open(tmp,"wx")` EEXIST means some OTHER writer already holds that exact
  // (randomized) temp name, and `tmp` was never ours to clean up.
  let created = false;
  try {
    const handle = await open(tmp, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(body, "utf8");
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (code === undefined || !RETRYABLE_RENAME_CODES.has(code)) throw err;
    // The brief's own fallback for this file: write in place rather than refuse the operation.
    await writeFile(path, body, { encoding: "utf8", mode: 0o600 });
    if (created) {
      try {
        await unlink(tmp);
      } catch (cleanupErr) {
        if (!isEnoent(cleanupErr)) throw cleanupErr;
      }
    }
  }
}

async function readInstalledPluginsFile(o: PluginManagerOptions): Promise<InstalledPluginsFileV2> {
  try {
    const raw = await readFile(installedPluginsPath(o), "utf8");
    const parsed = JSON.parse(raw) as Partial<InstalledPluginsFileV2> | null;
    const plugins = parsed !== null && typeof parsed === "object" && typeof parsed.plugins === "object" && parsed.plugins !== null ? (parsed.plugins as Record<string, InstalledPluginRecordV2[]>) : {};
    return { version: 2, plugins };
  } catch (err) {
    if (isEnoent(err)) return { version: 2, plugins: {} };
    throw err;
  }
}

// --- known_marketplaces.json: written under a `.lock`, bounded retries, degrade-not-refuse (F15) --
//
// A DIRECTORY lock (`mkdir`/`rmdir`), not a file (`open wx`) -- deliberately, for cross-runtime
// interop. §2.2 has BOTH runtimes writing this same `sdk/plugins/known_marketplaces.json`, and the
// pinned binary's own call (this file's header) passes `proper-lockfile`-shaped options
// (`lockfilePath`, `retries:{retries,minTimeout,maxTimeout}`, `onCompromised`) -- and
// `proper-lockfile` itself locks with `fs.mkdir`/`fs.rmdir`, not a plain file, because a directory
// create/remove pair is what it uses to detect and reclaim a STALE lock (by the lock directory's own
// mtime) across process crashes. A file-based lock here would be invisible to claude's own stale-
// lock reclaim (its `rmdir` on a `.lock` that is actually a FILE fails `ENOTDIR`, so a Winter crash
// holding the lock would wedge claude's own marketplace writes forever); matching the primitive is
// what makes a crash mid-lock recoverable by EITHER runtime.
//
// This module does NOT itself reclaim a stale lock (no mtime check) -- only claude's own runtime
// does that, per the retries above. A Winter-only crash-recovery story is a real gap, flagged in the
// report; claude's 10s-scale default staleness window is what eventually frees a wedged lock today.
const MARKETPLACES_LOCK_ATTEMPTS = 25;
const MARKETPLACES_LOCK_RETRY_DELAY_MS = 20;

async function withMarketplacesLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  let acquired = false;
  for (let attempt = 0; attempt < MARKETPLACES_LOCK_ATTEMPTS; attempt++) {
    try {
      await mkdir(lockPath);
      acquired = true;
      break;
    } catch (err) {
      if ((err as { code?: string } | undefined)?.code !== "EEXIST") throw err;
      await new Promise((r) => setTimeout(r, MARKETPLACES_LOCK_RETRY_DELAY_MS));
    }
  }
  // Claude's own measured fallback: a lock nobody could acquire is logged and the write proceeds
  // anyway, never a hang and never a refusal. This module has no logger of its own to hand a host,
  // so the degrade is silent here; a host wiring this in can wrap it to log the `acquired: false`
  // case if it wants claude's own log line.
  try {
    return await fn();
  } finally {
    if (acquired) {
      try {
        await rmdir(lockPath);
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
    }
  }
}

async function readKnownMarketplacesFile(o: PluginManagerOptions): Promise<KnownMarketplacesFile> {
  try {
    const raw = await readFile(knownMarketplacesPath(o), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as KnownMarketplacesFile) : {};
  } catch (err) {
    if (isEnoent(err)) return {};
    throw err;
  }
}

async function writeKnownMarketplacesFile(path: string, file: KnownMarketplacesFile): Promise<void> {
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

// --- directory marketplace manifests (read in place, F15/§5.2) -----------------------------------

async function readDirectoryMarketplaceManifest(marketplaceDir: string): Promise<MarketplaceManifest> {
  const manifestPath = join(marketplaceDir, ".claude-plugin", "marketplace.json");
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (err) {
    if (isEnoent(err)) throw new PluginManagerError(`${manifestPath}: no marketplace manifest there (expected .claude-plugin/marketplace.json under ${marketplaceDir})`);
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PluginManagerError(`${manifestPath}: malformed JSON (${(err as Error).message})`);
  }
  if (typeof parsed !== "object" || parsed === null) throw new PluginManagerError(`${manifestPath}: expected a JSON object at the top level`);
  const obj = parsed as Partial<MarketplaceManifest>;
  if (typeof obj.name !== "string" || obj.name.length === 0) throw new PluginManagerError(`${manifestPath}: missing required "name"`);
  if (!Array.isArray(obj.plugins)) throw new PluginManagerError(`${manifestPath}: missing required "plugins" array`);
  return {
    name: obj.name,
    plugins: obj.plugins as MarketplaceManifestPluginEntry[],
    ...(obj.version !== undefined ? { version: obj.version } : {}),
    ...(obj.description !== undefined ? { description: obj.description } : {}),
    ...(obj.metadata !== undefined ? { metadata: obj.metadata } : {}),
  };
}

// --- source classification (kind only; only "directory" is actually fetched) ---------------------

interface SourceClassification {
  kind: MarketplaceInfo["kind"];
  /** For `directory`: the resolved local path. For the other three: the source string itself (there is nothing to resolve without network). */
  locator: string;
}

function classifySource(source: string): SourceClassification {
  if (/^https?:\/\//i.test(source)) return { kind: "url", locator: source };
  if (/^git@[^:]+:/i.test(source) || /^git\+/i.test(source) || /\.git$/i.test(source)) return { kind: "git", locator: source };
  // GitHub shorthand: "owner/repo", never a filesystem-looking string (no leading "/", ".", "~", and no path separators beyond the one slash).
  if (/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?\/[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/.test(source) && !source.includes("..")) {
    return { kind: "github", locator: source };
  }
  return { kind: "directory", locator: isAbsolute(source) ? source : resolve(source) };
}

function marketplaceInfoOf(name: string, record: KnownMarketplaceRecord): MarketplaceInfo {
  const kind = record.source.source;
  const source = record.source.path ?? record.source.url ?? record.source.repo ?? record.installLocation;
  return { name, source, kind, path: record.installLocation };
}

// --- spec parsing: "<name>@<marketplace>" (F15's own compound key, see the header's citation) -----

function parseSpec(spec: string): { name: string; marketplace: string } {
  const at = spec.lastIndexOf("@");
  if (at <= 0 || at === spec.length - 1) {
    throw new PluginManagerError(`plugin spec must be "<name>@<marketplace>" (got ${JSON.stringify(spec)}) -- bare-name marketplace inference is not implemented in this build`);
  }
  return { name: spec.slice(0, at), marketplace: spec.slice(at + 1) };
}

function keyFor(name: string, marketplace: string): string {
  return `${name}@${marketplace}`;
}

// --- enabledPlugins (settings.json's own field, F7/Contract B) -----------------------------------

async function readEnabledFromSettings(o: PluginManagerOptions, scope: PluginScope, key: string): Promise<boolean> {
  const loaded = await loadSettingsFile(o.settingsPathFor(scope));
  return loaded.values.enabledPlugins?.[key] === true;
}

async function setEnabledInSettings(o: PluginManagerOptions, scope: PluginScope, key: string, enabled: boolean | undefined): Promise<void> {
  const path = o.settingsPathFor(scope);
  const loaded = await loadSettingsFile(path);
  // `loadSettingsFile` reports a PRESENT-but-unparseable file as `{loaded:false, values:{}}` so a
  // READER never crashes on it -- but a WRITER must never treat that empty stand-in as "this
  // settings file has no other keys" and overwrite the real (merely malformed) file with a document
  // holding only `enabledPlugins`. Every other key -- permissions, hooks, env, everything -- would be
  // silently gone. Refuse instead: fixing a hand-edited settings file is the user's job, not this
  // call's to paper over.
  if (loaded.present && !loaded.loaded) {
    throw new PluginManagerError(`${path}: cannot update enabledPlugins -- the file exists but ${loaded.error ?? "could not be read"}; fix it by hand first`);
  }
  const settings: Settings = { ...loaded.values };
  const enabledPlugins = { ...(settings.enabledPlugins ?? {}) };
  if (enabled === undefined) delete enabledPlugins[key];
  else enabledPlugins[key] = enabled;
  settings.enabledPlugins = enabledPlugins;
  await mkdir(dirname(path), { recursive: true });
  // Same write discipline as installed_plugins.json (F15): temp file, then rename -- this file is
  // read by a live settings watcher and by both runtimes, never a plain in-place write.
  await writeJsonAtomicNoLock(path, settings);
}

// --- marketplaces -----------------------------------------------------------------------------

export async function listMarketplaces(o: PluginManagerOptions): Promise<MarketplaceInfo[]> {
  const file = await readKnownMarketplacesFile(o);
  return Object.entries(file).map(([name, rec]) => marketplaceInfoOf(name, rec));
}

export async function addMarketplace(o: PluginManagerOptions, source: string): Promise<MarketplaceInfo> {
  const classification = classifySource(source);
  if (classification.kind !== "directory") {
    throw new PluginManagerError(`marketplace source kind "${classification.kind}" is not supported in this build (no network) -- only local directory marketplaces can be added; got ${JSON.stringify(source)}`);
  }
  const dir = classification.locator;
  const manifest = await readDirectoryMarketplaceManifest(dir);
  await mkdir(o.pluginsRoot, { recursive: true });
  const path = knownMarketplacesPath(o);
  const record: KnownMarketplaceRecord = {
    source: { source: "directory", path: dir },
    installLocation: dir, // read in place -- nothing copied (F15/§5.2)
    lastUpdated: new Date().toISOString(),
    autoUpdate: false,
  };
  await withMarketplacesLock(path, async () => {
    const file = await readKnownMarketplacesFile(o);
    file[manifest.name] = record;
    await writeKnownMarketplacesFile(path, file);
  });
  return marketplaceInfoOf(manifest.name, record);
}

export async function removeMarketplace(o: PluginManagerOptions, name: string): Promise<void> {
  const path = knownMarketplacesPath(o);
  await withMarketplacesLock(path, async () => {
    const file = await readKnownMarketplacesFile(o);
    if (!(name in file)) throw new PluginManagerError(`marketplace "${name}" is not known`);
    delete file[name];
    await writeKnownMarketplacesFile(path, file);
  });
}

export async function updateMarketplace(o: PluginManagerOptions, name?: string): Promise<void> {
  const path = knownMarketplacesPath(o);
  await withMarketplacesLock(path, async () => {
    const file = await readKnownMarketplacesFile(o);
    const names = name !== undefined ? [name] : Object.keys(file);
    for (const n of names) {
      const rec = file[n];
      if (rec === undefined) throw new PluginManagerError(`marketplace "${n}" is not known`);
      if (rec.source.source !== "directory") {
        throw new PluginManagerError(`marketplace "${n}" has source kind "${rec.source.source}", which this build cannot refresh (no network)`);
      }
      // Read in place: nothing to fetch, but re-validate the manifest is still there and parseable,
      // exactly what claude's own "Validating local marketplace" step does for this source kind.
      await readDirectoryMarketplaceManifest(rec.installLocation);
      rec.lastUpdated = new Date().toISOString();
    }
    await writeKnownMarketplacesFile(path, file);
  });
}

// --- plugins -----------------------------------------------------------------------------------

async function resolvePluginSourcePath(o: PluginManagerOptions, name: string, marketplace: string): Promise<{ installPath: string; version: string | undefined }> {
  const marketplaces = await readKnownMarketplacesFile(o);
  const rec = marketplaces[marketplace];
  if (rec === undefined) throw new PluginManagerError(`marketplace "${marketplace}" is not known -- add it first`);
  if (rec.source.source !== "directory") {
    throw new PluginManagerError(`marketplace "${marketplace}" has source kind "${rec.source.source}", which this build cannot install from (no network)`);
  }
  const manifest = await readDirectoryMarketplaceManifest(rec.installLocation);
  const entry = manifest.plugins.find((p) => p.name === name);
  if (entry === undefined) throw new PluginManagerError(`plugin "${name}" is not listed by marketplace "${marketplace}"`);
  if (typeof entry.source !== "string") {
    throw new PluginManagerError(`plugin "${name}@${marketplace}" declares a non-local source, which this build cannot install (no network)`);
  }
  const pluginRoot = manifest.metadata?.pluginRoot ?? ".";
  const installPath = resolve(rec.installLocation, pluginRoot, entry.source);
  return { installPath, version: entry.version };
}

export async function installPlugin(o: PluginManagerOptions, spec: string, scope: PluginScope): Promise<InstalledPlugin> {
  const { name, marketplace } = parseSpec(spec);
  const { installPath, version } = await resolvePluginSourcePath(o, name, marketplace);
  const key = keyFor(name, marketplace);
  await mkdir(o.pluginsRoot, { recursive: true });
  const now = new Date().toISOString();
  const record: InstalledPluginRecordV2 = { scope, installPath, installedAt: now, ...(version !== undefined ? { version } : {}) };

  const file = await readInstalledPluginsFile(o);
  const existing = file.plugins[key] ?? [];
  file.plugins[key] = [...existing.filter((r) => r.scope !== scope), record];
  await writeJsonAtomicNoLock(installedPluginsPath(o), file);

  await setEnabledInSettings(o, scope, key, true);
  return { id: name, installPath, scope, ...(version !== undefined ? { version } : {}) };
}

export async function uninstallPlugin(o: PluginManagerOptions, spec: string, scope: PluginScope): Promise<void> {
  const { name, marketplace } = parseSpec(spec);
  const key = keyFor(name, marketplace);

  const file = await readInstalledPluginsFile(o);
  const existing = file.plugins[key];
  const remaining = (existing ?? []).filter((r) => r.scope !== scope);
  if (existing === undefined || remaining.length === existing.length) {
    throw new PluginManagerError(`plugin "${key}" is not installed at scope "${scope}"`);
  }
  if (remaining.length > 0) file.plugins[key] = remaining;
  else delete file.plugins[key];
  await writeJsonAtomicNoLock(installedPluginsPath(o), file);

  await setEnabledInSettings(o, scope, key, undefined);
}

export async function setPluginEnabled(o: PluginManagerOptions, spec: string, scope: PluginScope, enabled: boolean): Promise<void> {
  const { name, marketplace } = parseSpec(spec);
  const key = keyFor(name, marketplace);
  const file = await readInstalledPluginsFile(o);
  if (!(file.plugins[key]?.some((r) => r.scope === scope) ?? false)) {
    throw new PluginManagerError(`plugin "${key}" is not installed at scope "${scope}"`);
  }
  await setEnabledInSettings(o, scope, key, enabled);
}

export async function updatePlugin(o: PluginManagerOptions, spec: string): Promise<InstalledPlugin> {
  const { name, marketplace } = parseSpec(spec);
  const key = keyFor(name, marketplace);
  const file = await readInstalledPluginsFile(o);
  const records = file.plugins[key];
  if (records === undefined || records.length === 0) throw new PluginManagerError(`plugin "${key}" is not installed`);

  const { installPath, version } = await resolvePluginSourcePath(o, name, marketplace);
  const now = new Date().toISOString();
  const updated = records.map((r) => ({ ...r, installPath, lastUpdated: now, ...(version !== undefined ? { version } : {}) }));
  file.plugins[key] = updated;
  await writeJsonAtomicNoLock(installedPluginsPath(o), file);

  const last = updated[updated.length - 1]!;
  return { id: name, installPath, scope: last.scope, ...(version !== undefined ? { version } : {}) };
}

export async function listPlugins(o: PluginManagerOptions): Promise<PluginListing[]> {
  const file = await readInstalledPluginsFile(o);
  const out: PluginListing[] = [];
  for (const [key, records] of Object.entries(file.plugins)) {
    const at = key.lastIndexOf("@");
    const name = at > 0 ? key.slice(0, at) : key;
    const marketplace = at > 0 ? key.slice(at + 1) : "";
    for (const rec of records) {
      const enabled = await readEnabledFromSettings(o, rec.scope, key);
      out.push({ id: name, installPath: rec.installPath, scope: rec.scope, enabled, marketplace, ...(rec.version !== undefined ? { version: rec.version } : {}) });
    }
  }
  return out;
}
