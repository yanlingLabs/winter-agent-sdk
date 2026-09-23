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
import { join } from "node:path";

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

/**
 * Every installed record whose id is `true` in `enabled` -- `enabledPlugins` (settings.json's own
 * field, the same one `manage.ts`'s `setEnabledInSettings` writes). `false`, absent, or a non-boolean
 * value (`enabledPlugins`' own type also admits `string[]`/an object, claude-native shapes this
 * build's own management API never writes) all resolve to "not loaded" -- the exact strict-`true`
 * check `manage.ts`'s own `readEnabledFromSettings` makes, so the two readers of one settings field
 * can never disagree about which plugins are on.
 */
export function resolveEnabledPlugins(pluginsRoot: string, enabled: Record<string, boolean> | undefined): PluginRecord[] {
  if (enabled === undefined) return [];
  return readInstalledPlugins(pluginsRoot).filter((record) => enabled[record.id] === true);
}
