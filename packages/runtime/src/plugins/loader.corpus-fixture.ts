// Test-only helper for the recorded `loadPlugins` corpus (loader.corpus.test.ts): turns a JSON layout
// description into a real directory tree under a fresh temp dir, runs the loader on it, and returns
// the result with every absolute path rewritten relative to that temp dir, so a recording made on one
// machine replays on any other.
//
// Layout description (all paths relative to the temp dir; the plugin root is always `p/`, and `out/`
// is a sibling directory OUTSIDE the plugin root for escape cases):
//   dirs:     directories to create
//   files:    path -> text content; three shorthands keep the recorded corpus small:
//             "@skill:<desc>", "@cmd:<desc>" and "@agent:<name>:<desc>" (see `expandContent`)
//   links:    path -> target path (a symlink at `path` pointing at the absolute `<tmp>/<target>`)
//   manifest: the plugin manifest object (`<pluginManifestDir>/plugin.json`), or absent for a manifestless plugin
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadPlugins } from "./loader.ts";
import { CLAUDE_PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE, WINTER_PLUGIN_MANIFEST_DIR } from "./manifest.ts";

export interface PluginLayout {
  dirs?: string[];
  files?: Record<string, string>;
  links?: Record<string, string>;
  manifest?: unknown;
}

export type LoadPluginsFn = typeof loadPlugins;

/** Expands a content shorthand (see the header) into the file text it stands for; anything else is literal. */
export function expandContent(content: string): string {
  if (content.startsWith("@skill:")) return `---\ndescription: ${content.slice(7)}\n---\n\nBODY`;
  if (content.startsWith("@cmd:")) return `---\ndescription: ${content.slice(5)}\nargument-hint: <x>\n---\n\nDo $ARGUMENTS`;
  if (content.startsWith("@agent:")) {
    const [name, desc] = content.slice(7).split(":") as [string, string];
    return `---\nname: ${name}\ndescription: ${desc}\n---\nYou are ${name}.`;
  }
  return content;
}

export function materializeLayout(layout: PluginLayout): { base: string; root: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "winter-plugin-corpus-")));
  const root = join(base, "p");
  mkdirSync(root, { recursive: true });
  mkdirSync(join(base, "out"), { recursive: true });
  for (const d of layout.dirs ?? []) mkdirSync(join(base, d), { recursive: true });
  for (const [path, content] of Object.entries(layout.files ?? {})) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), expandContent(content), "utf8");
  }
  for (const [path, target] of Object.entries(layout.links ?? {})) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    symlinkSync(join(base, target), join(base, path));
  }
  if (layout.manifest !== undefined) {
    mkdirSync(join(root, WINTER_PLUGIN_MANIFEST_DIR), { recursive: true });
    writeFileSync(join(root, WINTER_PLUGIN_MANIFEST_DIR, "plugin.json"), JSON.stringify(layout.manifest), "utf8");
  }
  return { base, root };
}

/** Runs `load` (defaults to the real `loadPlugins`) on a materialised layout; the result is JSON with `<tmp>` in place of the temp dir. */
export function runLayout(layout: PluginLayout, load: LoadPluginsFn = loadPlugins): unknown {
  const { base, root } = materializeLayout(layout);
  try {
    const result = load([{ type: "local", path: root }]);
    return JSON.parse(JSON.stringify(result).split(base).join("<tmp>"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/** The names the loader itself looks for on disk. */
const LOADER_FIXED_NAMES = ["SKILL.md", "skills", "commands", "agents", "output-styles", "workflows", "hooks", "hooks.json", ".mcp.json", WINTER_PLUGIN_MANIFEST_DIR, CLAUDE_PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE];

/**
 * Whether a layout's result can depend on the file system folding case: some two distinct names it
 * involves -- a path segment of a created directory, file or link, a link target, any string (or key)
 * of the manifest, or a name the loader looks for -- differ only in case (`Skill.MD` beside the
 * loader's `SKILL.md`, a manifest's `./Commands` beside `commands/`). On a case-insensitive volume
 * (macOS, where the corpus was recorded) such names find each other; on a case-sensitive one they do
 * not. Deliberately coarse: it compares single segments, so it may flag a layout whose answer would
 * not in fact change, never miss one that would.
 */
export function dependsOnCaseFolding(layout: PluginLayout): boolean {
  const names = new Set<string>(LOADER_FIXED_NAMES);
  const addPath = (path: string): void => {
    for (const segment of path.split(/[\\/]+/)) if (segment !== "" && segment !== "." && segment !== "..") names.add(segment);
  };
  const addManifest = (value: unknown): void => {
    if (typeof value === "string") addPath(value);
    else if (Array.isArray(value)) value.forEach(addManifest);
    else if (value !== null && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        addPath(key);
        addManifest(inner);
      }
    }
  };
  for (const d of layout.dirs ?? []) addPath(d);
  for (const f of Object.keys(layout.files ?? {})) addPath(f);
  for (const [link, target] of Object.entries(layout.links ?? {})) {
    addPath(link);
    addPath(target);
  }
  addManifest(layout.manifest);
  const byFolded = new Map<string, string>();
  for (const name of names) {
    const folded = name.toLowerCase();
    const seen = byFolded.get(folded);
    if (seen !== undefined && seen !== name) return true;
    byFolded.set(folded, name);
  }
  return false;
}
