// Phase 5 Lane S (WS-11 §4, derived-shapes-p5 item (b)): `loadPlugins`.
//
// SCOPE, exactly: read local plugin directories, aggregate what they contribute, and hand back
// bundles with RESOLVED ABSOLUTE PATHS. This module registers nothing, connects nothing and
// validates no MCP config -- every consumer is a pure derivation in bundle.ts.
//
// REJECTIONS ARE RETURNED, NOT THROWN. `{ bundles, rejected }` follows T2's own
// `buildHookEntriesFromSettings` precedent (`{ entries, rejected }`), for the reason that made it
// right there too: several plugins are loaded at once and one bad entry must not erase the report on
// the others. `RejectedPlugin.kind` is the "typed error" the brief asks for -- a discriminated
// verdict a caller can branch on. T8 decides whether `kind: "unsupported-type"` aborts `query()`
// construction; it has everything it needs to.
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { BrandProfile, SdkPluginConfig } from "@yanlinglabs/winter-agent-sdk";
import { parseSkillFile } from "../skills/frontmatter.ts";
import { pluginNameError } from "../skills/frontmatter.ts";
import { parseAgentDefinitionFile } from "../subagents/definitions.ts";
import type { AgentDefinitionRejection, PluginAgentDefinition } from "../subagents/definitions.ts";
import { resolvesWithinPluginRoot } from "../permissions/file-rules.ts";
import { manifestAuthor, readPluginManifest, type PluginManifest } from "./manifest.ts";
import type { PluginBundle, PluginCommandEntry, PluginMetadata, PluginSkillEntry } from "./bundle.ts";

export type PluginRejectionKind = "unsupported-type" | "missing" | "invalid-manifest" | "invalid-name" | "duplicate";

export interface RejectedPlugin {
  /** The path exactly as the caller wrote it -- so a host can match a rejection to its own config entry. */
  path: string;
  kind: PluginRejectionKind;
  reason: string;
}

export interface LoadPluginsResult {
  bundles: PluginBundle[];
  rejected: RejectedPlugin[];
  /**
   * Review r2 finding 2 (whole-branch): rejected `<plugin>/agents/*.md` files -- a broken file
   * inside an OTHERWISE-loaded plugin (missing/invalid `name:`, missing `description:`) used to
   * vanish with no channel at all (`scanPluginAgents`'s own former header: "no rejection channel
   * exists at THIS call site the way `loadAgentDefinitions`'s own `onReject` does"). Distinct from
   * `rejected` above, which is per-PLUGIN (a whole directory that never became a bundle); this is
   * per-FILE within a plugin that DID load. `production-wiring.ts` folds these into its own
   * `warnings` (main.ts's stderr, once per session -- plugin loading runs once).
   */
  agentFileRejections: AgentDefinitionRejection[];
  /**
   * Fix round 3 (M-5): a `hooks/hooks.json` that exists, parses as an object, but carries no
   * top-level `"hooks"` key -- claude's own `hook-load-failed` diagnostic (`hooks.json must have
   * \`hooks\` (the hook matchers) or \`modules\` (hooks modules), or both`, dump-confirmed). The
   * plugin itself still loads (a malformed hooks file is not a whole-plugin rejection, matching
   * `agentFileRejections`'s own precedent immediately above), so this is the one channel that ever
   * names it. `production-wiring.ts` folds these into the same `warnings` list.
   */
  hookFileWarnings: string[];
  /**
   * WS-21 fix round 4/5 (minors, M-3's last bullet; generalised and renamed in round 5 from
   * `workflowsPathWarnings` -- ONE fold site, one channel, for every manifest custom-path override
   * this loader resolves, not a parallel field per component): a manifest `workflows`/`agents`/
   * `output-styles`/`commands`/`skills` entry that could not be used -- not a string, escapes the
   * plugin directory (lexically OR through a symlink -- fix round 5's own Aoe/KGe port), does not
   * exist, or (skills only) is a file where a directory is required -- plus a
   * `folder-shadowed-by-manifest` notice when an override silently drops an existing default
   * directory. Named per-plugin, per-entry, on the SAME "recoverable, not a whole-plugin rejection"
   * footing `hookFileWarnings` above already established for a malformed `hooks.json`.
   * `production-wiring.ts` folds these into the same `warnings` list too.
   */
  manifestPathWarnings: string[];
}

/**
 * The MCP config file at a plugin ROOT. Two spellings accepted, `.mcp.json` first.
 *
 * `.mcp.json` is what `skipMcpDiscovery`'s own pinned doc names (`sdk.d.ts:4609`), so it is the
 * authority. `mcp.json` is accepted as well for ONE concrete reason: WS-01 §2.4 makes
 * `<project>/.winter/mcp.json` the Winter-native project config, and WS-11 §4 has the official
 * branch load `<project>/.winter` ITSELF as a local plugin -- without this second spelling, the
 * exact directory both branches agree is a plugin would contribute its MCP servers on one branch
 * and not the other. Disclosed in the report.
 */
const PLUGIN_MCP_FILES: readonly string[] = [".mcp.json", "mcp.json"] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The plugin root as REPORTED: `resolve`d to an absolute path, and nothing more.
 *
 * Deliberately NOT `realpathSync`. `system/init.plugins[].path` is read by hosts, and a canonical
 * real path is a DIFFERENT string from the one the host configured whenever any ancestor is a
 * symlink -- on macOS that is true of `/tmp` and `/var` for every process. Symlinked roots still
 * work, because every `readdirSync`/`readFileSync` below follows links on its own.
 */
function resolveRoot(path: string, cwd: string | undefined): string {
  return cwd !== undefined ? resolve(cwd, path) : resolve(path);
}

/**
 * The DUPLICATE-DETECTION key, which is where the canonical path does belong: two configs naming the
 * same directory through different symlinks are one plugin, and loading it twice would register
 * every skill and agent it ships a second time. Falls back to the resolved path when unresolvable.
 */
function identityKey(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/**
 * Admit a `readdirSync` entry as a directory, WS-21 §6.3 item 1 (F6, F7): claude follows a symlinked
 * plugin skill directory the same way it follows a symlinked user/project one (`skills/loader.ts`'s
 * own `isDirEntry`, mirrored here for the plugin scan). A dangling link, or a link to a non-directory,
 * is excluded silently -- the same fate an ordinary subdirectory with no `SKILL.md` already has.
 */
function isDirEntry(root: string, e: Dirent): boolean {
  if (e.isDirectory()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return statSync(join(root, e.name)).isDirectory();
  } catch {
    return false;
  }
}

/** The file-entry twin of `isDirEntry` (WS-21 §6.3 item 1, F6/F7), mirroring `commands/resolver.ts`'s own `isFileEntry`. */
function isFileEntry(dir: string, e: Dirent): boolean {
  if (e.isFile()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return statSync(join(dir, e.name)).isFile();
  } catch {
    return false;
  }
}

/**
 * ONE "parent of skill directories" scan -- shared by the default `skills/` directory and, fix
 * round 5, every entry a manifest `skills` override names (each an EQUALLY-shaped parent directory,
 * content-search confirmed against the installed claude CLI binary, 2.1.280: the consumer calls the
 * IDENTICAL scan function on the default `skillsPath` and on each `skillsPaths` entry).
 */
function scanPluginSkillsAt(skillsParentDir: string, pluginName: string): PluginSkillEntry[] {
  let dirs: string[];
  try {
    dirs = readdirSync(skillsParentDir, { withFileTypes: true })
      .filter((e) => isDirEntry(skillsParentDir, e))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const out: PluginSkillEntry[] = [];
  for (const dir of dirs) {
    const path = join(skillsParentDir, dir, "SKILL.md");
    let parsed: ReturnType<typeof parseSkillFile>;
    try {
      if (!statSync(path).isFile()) continue;
      parsed = parseSkillFile(readFileSync(path, "utf8"), dir);
    } catch {
      continue;
    }
    if (!parsed) continue;
    out.push({
      name: parsed.name,
      qualifiedName: `${pluginName}:${parsed.name}`,
      description: parsed.description,
      path,
      ...(parsed.author !== undefined ? { author: parsed.author } : {}),
    });
  }
  return out;
}

/**
 * Fix round 5: a manifest `skills` override, resolved and merged ADDITIVELY with the default
 * `skills/` directory -- see `PluginManifest.skills`'s own header for the dump evidence that skills
 * is the one component here that does NOT shadow. `requireDirectory: true` (claude's own `Tb` call
 * for `skills` is the one place it passes `!0`, unlike every other component's `!1` -- a skill is
 * inherently a directory containing `SKILL.md`, never a bare file). A name collision between the
 * default directory and an override entry -- or between two override entries -- keeps the LAST
 * occurrence, matching the "later wins" convention this round's own agents/commands overrides
 * already use; claude's own builder additionally excludes an override entry that resolves to
 * EXACTLY the default directory before assigning `skillsPaths` at all (`gr===qn`, dump-confirmed),
 * a pure double-scan optimisation this port skips: the eventual name-level dedup below produces the
 * identical final list either way, since re-scanning the same directory twice yields the same
 * entries.
 */
function resolvePluginSkills(root: string, pluginName: string, declared: PluginManifest["skills"], warnings: string[]): PluginSkillEntry[] {
  const defaultSkills = scanPluginSkillsAt(join(root, "skills"), pluginName);
  const overridePaths = resolveManifestComponentOverride(root, pluginName, "skills", declared, true, warnings);
  if (overridePaths === undefined) return defaultSkills;
  const overrideSkills = overridePaths.flatMap((path) => scanPluginSkillsAt(path, pluginName));
  const byName = new Map<string, PluginSkillEntry>();
  for (const entry of [...defaultSkills, ...overrideSkills]) byName.set(entry.name, entry);
  return [...byName.values()];
}

/**
 * A plugin command file's frontmatter, read for the listing only -- the BODY is re-read at resolve
 * time by `FilesystemCommandResolver`, which owns `$ARGUMENTS` and the frontmatter strip. Two
 * readers of one file, deliberately: this one must not retain bodies (the same lazy discipline the
 * skill index follows), and the resolver must see the file as it is when the command actually runs.
 */
/** ONE command file, parsed. Shared by the default-directory scan and a manifest override's own per-entry file case (fix round 5). `undefined` for an unreadable file, matching the default scan's own silent-skip posture. */
function scanPluginCommandFile(path: string, pluginName: string): PluginCommandEntry | undefined {
  const name = basename(path, ".md");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const attrs = frontmatterAttrs(raw);
  return {
    name,
    qualifiedName: `${pluginName}:${name}`,
    path,
    ...(attrs["description"] !== undefined ? { description: attrs["description"] } : {}),
    ...(attrs["argument-hint"] !== undefined ? { argumentHint: attrs["argument-hint"] } : {}),
  };
}

function scanPluginCommandsDir(dir: string, pluginName: string): PluginCommandEntry[] {
  let files: string[];
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => isFileEntry(dir, e) && e.name.endsWith(".md"))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const out: PluginCommandEntry[] = [];
  for (const file of files) {
    const entry = scanPluginCommandFile(join(dir, file), pluginName);
    if (entry !== undefined) out.push(entry);
  }
  return out;
}

function scanPluginCommands(root: string, pluginName: string): PluginCommandEntry[] {
  return scanPluginCommandsDir(join(root, "commands"), pluginName);
}

/**
 * Fix round 5: a manifest `commands` override's own array of paths (the PLAIN string/string[] shape
 * `commands` shares with `workflows`/`agents`/`output-styles` -- NOT the inline `{name:{source|
 * content}}` object-map form, which `resolveCommandsManifestOverride` below intercepts before this
 * is ever reached). Each entry a directory (scanned like the default) or a single file (one
 * command), matching the confirmed consumer shape (content search against the installed claude CLI
 * binary): `w.commandsPaths.map(async(j)=>{let stat=await fs.stat(j);if(stat.isDirectory()){...scan
 * the dir...}else if(stat.isFile()){...one file...}})`. A later entry's SAME command name overrides
 * an earlier one (deduped by name, mirroring `scanPluginAgentsOverride`'s own convention).
 */
function scanPluginCommandsOverride(paths: readonly string[], pluginName: string): PluginCommandEntry[] {
  const byName = new Map<string, PluginCommandEntry>();
  for (const path of paths) {
    let isDir: boolean;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      for (const entry of scanPluginCommandsDir(path, pluginName)) byName.set(entry.name, entry);
    } else {
      const entry = scanPluginCommandFile(path, pluginName);
      if (entry !== undefined) byName.set(entry.name, entry);
    }
  }
  return [...byName.values()];
}

/**
 * Fix round 5, the disclosed scope decision for commands' own richer manifest shape: claude's `eqt`
 * ALSO accepts an inline `{<name>: {source?, content?}}` object map (dump-confirmed, content search:
 * `typeof n==="object"&&!Array.isArray(n)&&Ee&&typeof Ee==="object"&&(("source"in Ee)||("content"in
 * Ee))`), letting a manifest embed a command's TEXT directly rather than pointing at a file on disk.
 * This is a materially separate, larger mechanism than the plain path-array override every other
 * component shares (a per-entry metadata map, an inline-content registration path, its own merge
 * mode) -- not ported this round; the ruling's own `nk(...)`-style citation is the plain-paths shape.
 * SHADOW still fires (claude's own `j.commands` truthy check does not distinguish the two shapes),
 * with a LOUD warning naming the gap, so a plugin author sees why their default commands/ directory
 * stopped loading rather than the two runtimes silently disagreeing about it ("behave as one" per
 * this round's own ruling).
 */
function resolveCommandsManifestOverride(
  root: string,
  pluginName: string,
  declared: PluginManifest["commands"],
  warnings: string[],
): string[] | undefined {
  if (declared === undefined) return undefined;
  if (!Array.isArray(declared) && typeof declared === "object" && declared !== null) {
    const firstValue = Object.values(declared)[0];
    if (firstValue !== null && typeof firstValue === "object" && ("source" in (firstValue as object) || "content" in (firstValue as object))) {
      warnings.push(
        `plugin "${pluginName}"'s manifest "commands" uses the inline {name: {source|content}} form, which Winter does not support yet -- no commands were loaded from it (the default commands/ directory is still shadowed, matching claude's own behaviour whenever the key is present)`,
      );
      return [];
    }
  }
  return resolveManifestComponentOverride(root, pluginName, "commands", declared as string | string[], false, warnings);
}

/** Minimal frontmatter attribute read; the resolver owns the authoritative parse of the same shape. */
function frontmatterAttrs(raw: string): Record<string, string> {
  if (!raw.startsWith("---")) return {};
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return {};
  const attrs: Record<string, string> = {};
  for (const line of raw.slice(3, end).split("\n")) {
    const m = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    attrs[m[1]!.toLowerCase()] = v;
  }
  return attrs;
}

/**
 * `<plugin>/agents/*.md`, parsed by `parseAgentDefinitionFile` -- subagents/definitions.ts is the
 * ONE authority on that file format, and re-implementing it here is exactly the producer drift R5-2
 * exists to catch. Only the directory walk lives here (`loadAgentDirectory` is module-private there).
 *
 * Spawn-surface parity: `parseAgentDefinitionFile` now sources the agent's NAME from the file's own
 * frontmatter `name:` field (required, same as every other filesystem tier -- see that function's
 * own header) rather than the file's basename; a plugin agent file with no `name:` is skipped exactly
 * like an unreadable one -- but, as of review r2 finding 2, no longer SILENTLY: `rejected` (parallel
 * to `loadAgentDefinitions`'s own `onReject`) carries one `AgentDefinitionRejection` per bad file,
 * for `loadPlugins` to fold into `LoadPluginsResult.agentFileRejections`.
 */
type ScannedAgents = { agents: Record<string, PluginAgentDefinition>; rejected: AgentDefinitionRejection[] };

/** ONE agent file, parsed. Shared by the default-directory scan and a manifest override's own per-entry file case (fix round 5). */
function scanPluginAgentFile(full: string, pluginName: string, out: Record<string, PluginAgentDefinition>, rejected: AgentDefinitionRejection[]): void {
  try {
    if (!statSync(full).isFile()) return;
    const parsed = parseAgentDefinitionFile(readFileSync(full, "utf8"), full);
    if (parsed.ok) out[parsed.name] = { ...parsed.definition, plugin: pluginName };
    else rejected.push({ source: "plugin", filePath: parsed.filePath, reason: parsed.reason });
  } catch {
    // unreadable -- silently skipped, matching the default directory scan's own posture for the same case
  }
}

function scanPluginAgentsDir(dir: string, pluginName: string): ScannedAgents {
  let files: string[];
  try {
    files = readdirSync(dir).sort();
  } catch {
    return { agents: {}, rejected: [] };
  }
  const out: Record<string, PluginAgentDefinition> = {};
  const rejected: AgentDefinitionRejection[] = [];
  for (const file of files) {
    if (!file.toLowerCase().endsWith(".md")) continue;
    scanPluginAgentFile(join(dir, file), pluginName, out, rejected);
  }
  return { agents: out, rejected };
}

function scanPluginAgents(root: string, pluginName: string): ScannedAgents {
  return scanPluginAgentsDir(join(root, "agents"), pluginName);
}

/**
 * Fix round 5: a manifest `agents` override's own array of paths -- each entry a DIRECTORY (scanned
 * the same way the default `agents/` directory is) or a single FILE (one agent), mirroring the
 * default-vs-file branch the real consumer takes (dump-confirmed by content search against the
 * installed claude CLI binary: `M.agentsPaths.map(...){let stat=await fs.stat(entry);if(stat.
 * isDirectory()){...scan the dir...}else if(...){...one file...}}`). A later entry's SAME agent name
 * overrides an earlier one, matching the default directory scan's own within-directory precedent.
 */
function scanPluginAgentsOverride(paths: readonly string[], pluginName: string): ScannedAgents {
  const out: Record<string, PluginAgentDefinition> = {};
  const rejected: AgentDefinitionRejection[] = [];
  for (const path of paths) {
    let isDir: boolean;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      continue; // vanished between resolution and this scan -- silently skipped, like the resolver's own unreadable-file posture
    }
    if (isDir) {
      const scanned = scanPluginAgentsDir(path, pluginName);
      Object.assign(out, scanned.agents);
      rejected.push(...scanned.rejected);
    } else {
      scanPluginAgentFile(path, pluginName, out, rejected);
    }
  }
  return { agents: out, rejected };
}

/** Manifest `mcpServers` merged over any root MCP config file. The MANIFEST wins a name collision. */
function collectMcpServers(root: string, manifest: PluginManifest | undefined): { servers: Record<string, unknown>; configPath?: string } {
  const servers: Record<string, unknown> = {};
  let configPath: string | undefined;
  for (const file of PLUGIN_MCP_FILES) {
    const path = join(root, file);
    let parsed: unknown;
    try {
      if (!statSync(path).isFile()) continue;
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue; // absent, unreadable or malformed -- a broken plugin file never fails the load
    }
    if (!isPlainObject(parsed)) continue;
    // Both shapes accepted: a `{ mcpServers: {...} }` wrapper (the pinned `.mcp.json` shape) and a
    // bare name->config map, which is what `Settings.mcpServers` itself looks like.
    const block = isPlainObject(parsed["mcpServers"]) ? (parsed["mcpServers"] as Record<string, unknown>) : parsed;
    for (const [name, config] of Object.entries(block)) if (servers[name] === undefined) servers[name] = config;
    configPath ??= path;
    break; // first spelling wins; never merge two files
  }
  const declared = manifest?.mcpServers;
  if (isPlainObject(declared)) {
    for (const [name, config] of Object.entries(declared)) servers[name] = config;
  }
  return { servers, ...(configPath !== undefined ? { configPath } : {}) };
}

/**
 * `<plugin>/hooks/hooks.json` (WS-21 §5.1/§6.3 item 5, F15): claude's OWN hooks file, a SEPARATE file
 * from the manifest -- not the manifest-embedded `hooks` block Winter's own plugin format also
 * accepts (`PluginManifest.hooks`, kept for backward compatibility with a manifest already written
 * that way).
 *
 * WRAPPED, corrected by the router's same-view test (SV-3): the file's own top-level document is
 * `{ "hooks": {<Event>: [{matcher?, hooks:[...]}]}, ...other keys such as "description" }`, NOT the
 * bare event-map itself -- confirmed by the same-view test running the WRAPPED shape on REAL claude
 * (it works) and the unwrapped one (it does not); the earlier L1b review's "flat map" reading of
 * this file was wrong. Unwrapped HERE, to the bare `{<Event>: [...]}` event-map, so this function's
 * result feeds `pluginHookEntries`'s own `{hooks: bundle.hooks}` wrap (settings/loaders/hooks.ts)
 * the identical bare shape the manifest-embedded fallback (`PluginManifest.hooks`, a Winter-only
 * convention with no wrapper of its own) already provides -- a caller reading `bundle.hooks` never
 * has to know which of the two files it came from.
 */
function readPluginHooksJson(root: string, pluginName: string, warnings: string[]): unknown {
  const path = join(root, "hooks", "hooks.json");
  try {
    if (!statSync(path).isFile()) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isPlainObject(parsed)) return undefined;
    const inner = parsed["hooks"];
    if (isPlainObject(inner)) return inner;
    // Fix round 3 (M-5): claude's own `hook-load-failed` -- a well-formed JSON document with no
    // `"hooks"` key (and, per its own schema, no `"modules"` key either -- Winter has no modules
    // concept to check, so a bare-object-without-"hooks" is the one shape this codebase can detect)
    // is a warning, not a silent no-op.
    warnings.push(`plugin "${pluginName}"'s hooks/hooks.json has no "hooks" key -- check that the file follows the required schema ({"hooks": {<Event>: [...]}})`);
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fix round 3 (M-5): the manifest's own `hooks` field is ADDITIVE to `hooks/hooks.json`, never a
 * fallback for it -- claude's own manifest schema (`xs`, dump-confirmed) describes every one of its
 * three accepted shapes as "in addition to those in hooks/hooks.json, if it exists": a bare event-map
 * object, an ARRAY of such objects, or a STRING path to a further hooks file. Per-event entries
 * CONCATENATE across every source, hooks.json's own entries first.
 *
 * DISCLOSED, CONTAINED SCOPE: `PluginManifest.hooks` is `unknown` (Winter's own type, "carried
 * verbatim; parsed by the hook loader") and this merges the object/array-of-objects shapes; a STRING
 * element (a path to ANOTHER hooks file, relative to the plugin root) is a materially separate
 * file-resolution feature this round does not add -- a manifest using that shape contributes nothing
 * from that element today, exactly as it did before this fix (manifest.hooks was not read at all
 * unless hooks.json was absent).
 */
function mergeHookSources(fromHooksJson: unknown, manifestHooks: unknown): Record<string, unknown> | undefined {
  // DELIBERATELY UNVALIDATED at the per-event level: whether an event's value is really an ARRAY
  // of matcher-shaped entries is `settings/loaders/hooks.ts`'s own `pluginHookEntries` job (it
  // REPORTS a malformed block against the plugin's path, never throws -- hooks.test.ts's own fixture
  // pins this). Folding a validation/rejection here would swallow that malformed shape before
  // `pluginHookEntries` ever sees it, turning a REPORTED rejection into a silent no-op. So a
  // non-array value for an event is preserved as-is when nothing else claims that event; two
  // genuinely ARRAY values for the same event concatenate (the actual "additive" case I-1 -- sorry,
  // M-5 -- asks for).
  //
  // Fix round 4 (minors): a VALID array is never REPLACED by a later malformed value for the same
  // event -- "keep the valid one" holds regardless of which source (hooks.json or the manifest) it
  // came from. The pre-fix rule (`Array.isArray(existing) && Array.isArray(entries) ? [...] :
  // entries`) fell to the `entries` branch whenever EITHER side was non-array, so a later malformed
  // manifest value silently discarded an earlier, real, working hooks.json array -- there is no
  // report for this the way there is for `pluginHookEntries`'s own per-event validation, because by
  // the time that runs the valid array is simply gone. A later value only wins outright when the
  // EARLIER one was itself not a usable array (nothing valid to protect).
  const merged: Record<string, unknown> = {};
  let sawAny = false;
  const foldObject = (obj: unknown): void => {
    if (!isPlainObject(obj)) return;
    for (const [event, entries] of Object.entries(obj)) {
      sawAny = true;
      const existing = merged[event];
      if (Array.isArray(existing) && Array.isArray(entries)) merged[event] = [...existing, ...entries];
      else if (Array.isArray(existing)) merged[event] = existing; // keep the valid one; drop the malformed later value
      else merged[event] = entries;
    }
  };
  foldObject(fromHooksJson);
  if (Array.isArray(manifestHooks)) {
    for (const item of manifestHooks) foldObject(item); // a string element (a further file path) is out of scope -- see this function's own header
  } else {
    foldObject(manifestHooks);
  }
  return sawAny ? merged : undefined;
}

/**
 * The remaining default component dirs (WS-21 §6.3 item 5, F15's own list) this build does not yet
 * wire into a consumer -- `output-styles/` and `workflows/` are owned by lane L1a's own subsystems
 * (`context/output-styles.ts`, `workflows/store.ts`), and `bin/` has no consumer of any kind yet.
 * Exposed as resolved ABSOLUTE PATHS only, present iff the directory exists, so a future consumer (in
 * either lane) can read them without this module inventing a wiring shape nothing has asked for yet.
 */
function componentDirIfPresent(root: string, dir: string): string | undefined {
  const path = join(root, dir);
  return isDirectory(path) ? path : undefined;
}

/**
 * WS-21 fix round 4/5 (minors, M-3's last bullet, generalised in round 5): a plugin manifest's own
 * custom-path override for ONE component -- the array-of-paths shape `workflows`/`agents`/
 * `output-styles`/the plain-array half of `commands` all share (claude's own `Tb`, dump-confirmed:
 * every one of these four call sites differs only in `componentKey`/label text and the
 * `requireDirectory` argument). `skills` has its own ADDITIVE variant (`resolveSkillsOverride`,
 * below -- round 5's re-review N-1/N-2 sibling advisor catch: skills does NOT shadow the default
 * directory, confirmed by `_t=Le` carrying no `!j.skills` negation unlike every other component's
 * `!j.X&&Y` gate, and by `skills` being ABSENT from the `folder-shadowed-by-manifest` tuple list).
 * `commands`' own inline `{name:{source|content}}` object-map form is a materially separate, larger
 * mechanism -- see `loadPlugins`'s own commands call site for the disclosed scope decision.
 *
 * `undefined` means the manifest declares no override at all (the caller falls back to the default
 * directory); an array (possibly empty) means it DOES, so the default directory is SHADOWED
 * regardless of how many entries survive validation.
 *
 * Each declared entry is resolved against the plugin root and kept only if it both stays within the
 * plugin directory -- REALPATH-aware (`resolvesWithinPluginRoot`, fix round 5's own Aoe/KGe port,
 * `permissions/file-rules.ts`; closes a round-4 gap where a manifest-declared relative path was
 * checked only LEXICALLY, letting a symlink planted inside the plugin root but resolving outside it
 * through) -- and exists on disk. `requireDirectory` mirrors claude's own `Tb`'s tenth argument:
 * `false` for workflows/agents/output-styles (a bare file is a valid single-entry override), and this
 * function is never called for skills (see above). An entry that fails a check is dropped with a
 * warning (`manifestPathWarnings`) rather than failing the whole plugin, on the same "recoverable,
 * not a whole-plugin rejection" footing `hookFileWarnings` already established.
 */
function resolveManifestComponentOverride(
  root: string,
  pluginName: string,
  componentKey: string,
  declared: string | string[] | undefined,
  requireDirectory: boolean,
  warnings: string[],
): string[] | undefined {
  if (declared === undefined) return undefined;
  const entries = Array.isArray(declared) ? declared : [declared];
  const resolved: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.length === 0) {
      warnings.push(`plugin "${pluginName}"'s manifest "${componentKey}" entry ${JSON.stringify(entry)} is not a non-empty string -- ignoring it`);
      continue;
    }
    const full = resolve(root, entry);
    if (!resolvesWithinPluginRoot(full, root)) {
      warnings.push(`plugin "${pluginName}"'s manifest "${componentKey}" path "${entry}" escapes the plugin directory -- ignoring it`);
      continue;
    }
    let stat: ReturnType<typeof statSync> | undefined;
    try {
      stat = statSync(full);
    } catch {
      stat = undefined;
    }
    if (stat === undefined) {
      warnings.push(`plugin "${pluginName}"'s manifest "${componentKey}" path "${entry}" was not found at ${full} -- ignoring it`);
      continue;
    }
    if (requireDirectory && !stat.isDirectory()) {
      // Claude's own `Tb` gives `skills` a SPECIFIC hint when the file is literally `SKILL.md` --
      // "path is a file; skills entries must be directories containing SKILL.md — point to the
      // parent directory ... instead" (dump-confirmed) -- the single author mistake this check
      // exists to catch (a manifest entry pointing AT the file rather than at its containing
      // directory). Ported only for `componentKey === "skills"`, the one caller this round passes
      // `requireDirectory: true` for at all.
      const skillHint = componentKey === "skills" && basename(entry).toLowerCase() === "skill.md" ? ` -- point to its parent directory instead` : "";
      warnings.push(
        `plugin "${pluginName}"'s manifest "${componentKey}" path "${entry}" is a file, not a directory${componentKey === "skills" ? " (skills entries must be directories containing SKILL.md)" : ""}${skillHint} -- ignoring it`,
      );
      continue;
    }
    resolved.push(full);
  }
  return resolved;
}

/**
 * `O1t`'s own suppression check, dump-confirmed: a `folder-shadowed-by-manifest` warning does NOT
 * fire when the override's own resolved entries already include the default directory itself (an
 * author who explicitly re-lists `./workflows` alongside a custom path is not silently losing it --
 * round 5's own promoted minor: "the 'workflows folder is shadowed' warning fires even when the
 * manifest's `workflows` names `./workflows` itself"). Matches `O1t`'s own `(resolved+sep).
 * startsWith(default+sep)` test, which also catches an entry pointing INSIDE the default directory,
 * not only an exact match.
 */
function manifestOverrideIncludesDefaultDir(resolvedEntries: readonly string[], defaultDirPath: string): boolean {
  const normalizedDefault = defaultDirPath + sep;
  return resolvedEntries.some((entry) => (entry + sep).startsWith(normalizedDefault));
}

/** The `folder-shadowed-by-manifest` warning itself, shared by every component that can shadow a default directory (workflows/agents/output-styles/commands -- never skills, which is additive). */
function shadowedFolderWarning(pluginName: string, componentDirName: string, manifestFieldName: string): string {
  return `plugin "${pluginName}": the "${componentDirName}/" folder exists but is not auto-loaded because the manifest sets "${manifestFieldName}"`;
}

function metadataOf(manifest: PluginManifest | undefined): PluginMetadata {
  if (!manifest) return {};
  const author = manifestAuthor(manifest.author);
  return {
    ...(typeof manifest.description === "string" ? { description: manifest.description } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(typeof manifest.homepage === "string" ? { homepage: manifest.homepage } : {}),
    ...(Array.isArray(manifest.keywords) ? { keywords: manifest.keywords.filter((k): k is string => typeof k === "string") } : {}),
  };
}

/**
 * Load every configured plugin.
 *
 * FIRST OCCURRENCE WINS throughout: a repeated path is a `duplicate` rejection rather than a second
 * bundle, and every downstream derivation (bundle.ts) keeps the same direction.
 */
export function loadPlugins(plugins: readonly SdkPluginConfig[] | undefined, opts?: { cwd?: string; brand?: Pick<BrandProfile, "pluginManifestDir"> }): LoadPluginsResult {
  const bundles: PluginBundle[] = [];
  const rejected: RejectedPlugin[] = [];
  const agentFileRejections: AgentDefinitionRejection[] = [];
  const hookFileWarnings: string[] = [];
  const manifestPathWarnings: string[] = [];
  const seenRoots = new Set<string>();
  const seenNames = new Set<string>();

  for (const config of plugins ?? []) {
    const declaredPath = config?.path;
    if (config?.type !== "local") {
      rejected.push({
        path: typeof declaredPath === "string" ? declaredPath : String(declaredPath),
        kind: "unsupported-type",
        reason: `plugin type ${JSON.stringify(config?.type)} is not supported -- "local" is the only accepted type (WS-11 §4; the pinned union is a closed one-member literal, sdk.d.ts:4597). A remote or marketplace plugin must exist locally first.`,
      });
      continue;
    }
    if (typeof declaredPath !== "string" || declaredPath.length === 0) {
      rejected.push({ path: String(declaredPath), kind: "missing", reason: 'a local plugin config requires a non-empty "path"' });
      continue;
    }
    const root = resolveRoot(declaredPath, opts?.cwd);
    if (!isDirectory(root)) {
      rejected.push({ path: declaredPath, kind: "missing", reason: `${root} is not a directory` });
      continue;
    }
    const identity = identityKey(root);
    if (seenRoots.has(identity)) {
      rejected.push({ path: declaredPath, kind: "duplicate", reason: `${root} is already loaded; the first occurrence wins` });
      continue;
    }

    // P7a fix r1 (Important-3): the ONE production reader of a plugin manifest. `readPluginManifest`
    // and `pluginManifestDirs` derived from the profile, but nothing ever handed them one, so a
    // reuser's `.acme-plugin/plugin.json` was never discovered -- only Winter's own spelling and the
    // Claude-mirroring `.claude-plugin`. A derivation nothing threads is exactly what the sweep gate
    // cannot see.
    const manifestResult = readPluginManifest(root, opts?.brand);
    if (manifestResult.error !== undefined) {
      rejected.push({ path: declaredPath, kind: "invalid-manifest", reason: manifestResult.error });
      continue;
    }
    const manifest = manifestResult.manifest;
    // WS-11 §4's manifestless rule: a plugin directory without a manifest is named by its BASENAME.
    // A manifest `name` overrides it -- and both paths run through the identical jail, which is what
    // makes the project dot-dir qualify as `<projectDir>:<skill>` the same way whichever route named it.
    const name = typeof manifest?.name === "string" && manifest.name.length > 0 ? manifest.name : basename(root);
    if (pluginNameError(name) !== null) {
      rejected.push({ path: declaredPath, kind: "invalid-name", reason: `${JSON.stringify(name)} is not a valid plugin name (a qualified skill is "<plugin>:<skill>", so the plugin name may not contain separators)` });
      continue;
    }
    if (seenNames.has(name)) {
      rejected.push({ path: declaredPath, kind: "duplicate", reason: `a plugin named ${JSON.stringify(name)} is already loaded; the first occurrence wins` });
      continue;
    }

    const skipMcpDiscovery = config.skipMcpDiscovery === true;
    const mcp = skipMcpDiscovery ? { servers: {} } : collectMcpServers(root, manifest);
    // Fix round 3 (M-5), CORRECTED: `hooks/hooks.json` (claude's own file) and a manifest-embedded
    // `hooks` block are ADDITIVE, not either/or -- claude loads BOTH (its own manifest schema
    // describes the manifest field as "in addition to those in hooks/hooks.json, if it exists",
    // dump-confirmed). The pre-fix-round-3 `??` fallback silently dropped a manifest's own hooks
    // whenever a hooks.json ALSO existed.
    const hooks = mergeHookSources(readPluginHooksJson(root, name, hookFileWarnings), manifest?.hooks);
    // Fix round 5: a manifest `agents` override SHADOWS the default `agents/` directory (the SAME
    // gate/warning shape workflows already has, `!j.agents&&Fe` dump-confirmed) -- `requireDirectory:
    // false` since claude's own `Tb` call for `agents` accepts a bare file.
    const agentsOverridePaths = resolveManifestComponentOverride(root, name, "agents", manifest?.agents, false, manifestPathWarnings);
    const scannedAgents = agentsOverridePaths === undefined ? scanPluginAgents(root, name) : scanPluginAgentsOverride(agentsOverridePaths, name);
    agentFileRejections.push(...scannedAgents.rejected);
    if (
      agentsOverridePaths !== undefined &&
      componentDirIfPresent(root, "agents") !== undefined &&
      !manifestOverrideIncludesDefaultDir(agentsOverridePaths, join(root, "agents"))
    ) {
      manifestPathWarnings.push(shadowedFolderWarning(name, "agents", "agents"));
    }
    // Fix round 5: a manifest `commands` override, same shadow-on-presence shape -- the inline
    // {name:{source|content}} form is intercepted inside resolveCommandsManifestOverride (its own
    // header has the disclosed-scope note); everything else behaves exactly like `agents` above.
    const commandsOverridePaths = resolveCommandsManifestOverride(root, name, manifest?.commands, manifestPathWarnings);
    const scannedCommands = commandsOverridePaths === undefined ? scanPluginCommands(root, name) : scanPluginCommandsOverride(commandsOverridePaths, name);
    if (
      commandsOverridePaths !== undefined &&
      componentDirIfPresent(root, "commands") !== undefined &&
      !manifestOverrideIncludesDefaultDir(commandsOverridePaths, join(root, "commands"))
    ) {
      manifestPathWarnings.push(shadowedFolderWarning(name, "commands", "commands"));
    }
    // Fix round 5: a manifest `outputStyles` override (note the CAMEL-CASE manifest key, unlike the
    // kebab-case default directory name) -- same shadow-on-presence shape as agents/commands/
    // workflows. The warning text still says "output-styles" (the folder name), matching the
    // pre-existing `componentDirIfPresent(root, "output-styles")` spelling everywhere else in this
    // file.
    const outputStylesOverridePaths = resolveManifestComponentOverride(root, name, "output-styles", manifest?.outputStyles, false, manifestPathWarnings);
    const outputStylesPath = outputStylesOverridePaths === undefined ? componentDirIfPresent(root, "output-styles") : undefined;
    if (
      outputStylesOverridePaths !== undefined &&
      componentDirIfPresent(root, "output-styles") !== undefined &&
      !manifestOverrideIncludesDefaultDir(outputStylesOverridePaths, join(root, "output-styles"))
    ) {
      manifestPathWarnings.push(shadowedFolderWarning(name, "output-styles", "outputStyles"));
    }
    // Fix round 4/5 (minors, M-3's last bullet): a manifest `workflows` override SHADOWS the default
    // directory the moment the key is present, regardless of how many of its entries resolve --
    // `resolveManifestComponentOverride`'s own header has the citation for why this checks
    // `!== undefined` rather than `.length > 0`. `requireDirectory: false` -- claude's own `Tb` call
    // for `workflows` accepts a bare file.
    const workflowsOverride = resolveManifestComponentOverride(root, name, "workflows", manifest?.workflows, false, manifestPathWarnings);
    const workflowsPath = workflowsOverride === undefined ? componentDirIfPresent(root, "workflows") : undefined;
    // Fix round 4 (minors, M-3's last bullet), advisor catch: claude's own `Tb` call site is guarded
    // by `if(j.workflows&&Be){...D.push({type:"folder-shadowed-by-manifest",...})}` a few lines
    // above the citation `resolveManifestComponentOverride`'s own header quotes -- a warning fires
    // whenever the override key is present AND the default directory ALSO exists on disk, telling the
    // plugin author their `workflows/` folder is being ignored rather than leaving them to notice by
    // its absence from the listing. Checked independently of whether any override entry resolved (the
    // same `!== undefined` reasoning `workflowsPath`'s own suppression above already uses).
    //
    // Fix round 5 (promoted minor, the re-review of 57e7fef..20b623e): round 4 omitted `O1t`'s own
    // suppression -- the warning must NOT fire when the override's own resolved entries already
    // include the default `workflows/` directory itself (an author who explicitly re-lists
    // `./workflows` alongside a custom path is not silently losing it).
    const defaultWorkflowsDir = join(root, "workflows");
    if (
      workflowsOverride !== undefined &&
      componentDirIfPresent(root, "workflows") !== undefined &&
      !manifestOverrideIncludesDefaultDir(workflowsOverride, defaultWorkflowsDir)
    ) {
      manifestPathWarnings.push(shadowedFolderWarning(name, "workflows", "workflows"));
    }
    const binPath = componentDirIfPresent(root, "bin");

    seenRoots.add(identity);
    seenNames.add(name);
    bundles.push({
      name,
      path: root,
      ...(typeof manifest?.version === "string" ? { version: manifest.version } : {}),
      ...(manifestResult.path !== undefined ? { manifestPath: manifestResult.path } : {}),
      metadata: metadataOf(manifest),
      skills: resolvePluginSkills(root, name, manifest?.skills, manifestPathWarnings),
      commands: scannedCommands,
      agents: scannedAgents.agents,
      ...(hooks !== undefined ? { hooks } : {}),
      mcpServers: mcp.servers,
      ...(mcp.configPath !== undefined ? { mcpConfigPath: mcp.configPath } : {}),
      skipMcpDiscovery,
      ...(outputStylesPath !== undefined ? { outputStylesPath } : {}),
      ...(outputStylesOverridePaths !== undefined && outputStylesOverridePaths.length > 0 ? { outputStylesPaths: outputStylesOverridePaths } : {}),
      ...(workflowsPath !== undefined ? { workflowsPath } : {}),
      ...(workflowsOverride !== undefined && workflowsOverride.length > 0 ? { workflowsPaths: workflowsOverride } : {}),
      ...(binPath !== undefined ? { binPath } : {}),
    });
  }

  return { bundles, rejected, agentFileRejections, hookFileWarnings, manifestPathWarnings };
}
