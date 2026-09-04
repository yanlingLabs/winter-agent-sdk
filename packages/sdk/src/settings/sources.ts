// Phase 5 Task 2: per-tier settings FILE location + loading. See ./types.ts's header for why this
// module lives in packages/sdk rather than packages/runtime.
//
// Paths are WS-01 §2.2/§2.4's, verbatim:
//   user    -> <WINTER_HOME || ~/.winter>/settings.json
//   project -> <cwd>/.winter/settings.json          (repo-committed)
//   local   -> <cwd>/.winter/settings.local.json    (gitignored, personal)
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveWinterHome } from "../paths/home.ts";
import type { Settings, SettingSource } from "./types.ts";

export interface SettingsPathOptions {
  cwd: string;
  /** Explicit `~/.winter` root; when omitted it is resolved from `env` (WINTER_HOME || ~/.winter). */
  winterHome?: string;
  env?: Record<string, string | undefined>;
}

export function settingsPathFor(source: SettingSource, opts: SettingsPathOptions): string {
  switch (source) {
    case "user":
      return join(opts.winterHome ?? resolveWinterHome(opts.env), "settings.json");
    case "project":
      return join(opts.cwd, ".winter", "settings.json");
    case "local":
      return join(opts.cwd, ".winter", "settings.local.json");
  }
}

export interface LoadedSettingsFile {
  /** Absent entirely when the file does not exist -- an absent file contributes NO source entry. */
  present: boolean;
  loaded: boolean;
  error?: string;
  values: Settings;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Reads one settings file. NEVER throws: a missing file reports `present: false`; anything that
 * exists but cannot be used (unreadable, unparseable, or a non-object top level) reports
 * `present: true, loaded: false` with a human-readable `error` and an EMPTY value map, so a
 * malformed repo-committed file can never silently contribute a partial document.
 */
export async function loadSettingsFile(path: string): Promise<LoadedSettingsFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    // ENOENT/ENOTDIR are "no such settings file", the overwhelmingly common case -- not an error.
    if (code === "ENOENT" || code === "ENOTDIR") return { present: false, loaded: false, values: {} };
    return { present: true, loaded: false, error: `unreadable: ${(err as Error).message}`, values: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { present: true, loaded: false, error: `malformed JSON: ${(err as Error).message}`, values: {} };
  }
  if (!isPlainObject(parsed)) {
    return { present: true, loaded: false, error: `expected a JSON object at the top level, got ${Array.isArray(parsed) ? "an array" : typeof parsed}`, values: {} };
  }
  return { present: true, loaded: true, values: parsed as Settings };
}
