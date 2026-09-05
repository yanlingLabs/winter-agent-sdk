// Phase 5 Lane S (WS-11 §4): the plugin MANIFEST.
//
// TWO MANIFEST DIRECTORY SPELLINGS, both honoured, `.winter-plugin` preferred.
//
//   `.winter-plugin/plugin.json`  -- Winter-native, WS-01 §2.5's rewrite of the pinned spelling.
//   `.claude-plugin/plugin.json`  -- the PINNED branch's own. Honoured deliberately, not by accident:
//                                    Winter is a DROP-IN for `@anthropic-ai/claude-agent-sdk`, and a
//                                    host that swaps the package while still passing
//                                    `plugins: [{type:"local", path: "./some-existing-plugin"}]`
//                                    must keep working. Refusing it would make the swap a rewrite of
//                                    every plugin the host already ships. DISCLOSED in the report.
//
// WS-01 §2.5's rename rule governs what WINTER CREATES and what Winter reads for its OWN files; a
// plugin directory is third-party content that predates the swap, so reading both is the same
// posture the settings loader takes toward unknown keys -- accept, preserve, do not invent.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const WINTER_PLUGIN_MANIFEST_DIR = ".winter-plugin";
export const CLAUDE_PLUGIN_MANIFEST_DIR = ".claude-plugin";
export const PLUGIN_MANIFEST_FILE = "plugin.json";

/** Preference order. `.winter-plugin` first, so a plugin shipping both is read as Winter-native. */
export const PLUGIN_MANIFEST_DIRS: readonly string[] = [WINTER_PLUGIN_MANIFEST_DIR, CLAUDE_PLUGIN_MANIFEST_DIR] as const;

/**
 * Open-keyed for the same reason `Settings` is: a manifest key Winter does not know about is
 * PRESERVED and inert rather than dropped, so a plugin authored for a newer engine still loads.
 */
export interface PluginManifest {
  name?: string;
  version?: string;
  description?: string;
  author?: unknown;
  homepage?: string;
  keywords?: string[];
  /** Settings-shaped `{ <Event>: [{matcher?, hooks: [...]}] }` -- carried verbatim; parsed by the hook loader. */
  hooks?: unknown;
  /** RAW per-name configs; validated by Lane A's `resolveMcpServerSources`, never here. */
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ReadPluginManifestResult {
  manifest?: PluginManifest;
  /** Absolute path of the manifest that was read. */
  path?: string;
  /** Set iff a manifest EXISTED but could not be used. A missing manifest sets neither field. */
  error?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Read a plugin root's manifest.
 *
 * `{}` (all three fields absent) means NO manifest -- the manifestless case, which WS-11 §4 makes a
 * first-class shape (the root is then named by its basename). A manifest that exists but is
 * unparseable or is not a JSON object returns `error` instead: loading it as though it were absent
 * would silently rename the plugin and drop everything it declared.
 */
export function readPluginManifest(root: string): ReadPluginManifestResult {
  for (const dir of PLUGIN_MANIFEST_DIRS) {
    const path = join(root, dir, PLUGIN_MANIFEST_FILE);
    let raw: string;
    try {
      if (!statSync(path).isFile()) continue;
      raw = readFileSync(path, "utf8");
    } catch {
      continue; // not present at this spelling -- try the next
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { path, error: `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!isPlainObject(parsed)) {
      return { path, error: `${path} must contain a JSON object, got ${Array.isArray(parsed) ? "an array" : typeof parsed}` };
    }
    return { manifest: parsed as PluginManifest, path };
  }
  return {};
}

/** A manifest's `author`, reduced to a display string. Accepts the bare-string and `{name}` forms. */
export function manifestAuthor(author: unknown): string | undefined {
  if (typeof author === "string") return author;
  if (isPlainObject(author) && typeof author["name"] === "string") return author["name"];
  return undefined;
}
