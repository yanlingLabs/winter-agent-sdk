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
   * top-level `"hooks"` key -- claude reports the same file as a hook-load failure (`hooks.json must
   * have \`hooks\` (the hook matchers) or \`modules\` (hooks modules), or both`). The plugin itself still loads (a malformed hooks file is not a whole-plugin rejection, matching
   * `agentFileRejections`'s own precedent immediately above), so this is the one channel that ever
   * names it. `production-wiring.ts` folds these into the same `warnings` list.
   */
  hookFileWarnings: string[];
  /**
   * WS-21 fix round 4/5 (minors, M-3's last bullet; generalised and renamed in round 5 from
   * `workflowsPathWarnings` -- ONE fold site, one channel, for every manifest custom-path override
   * this loader resolves, not a parallel field per component): a manifest `workflows`/`agents`/
   * `output-styles`/`commands`/`skills` entry that could not be used -- not a string, escapes the
   * plugin directory (lexically OR through a symlink -- fix round 5's realpath fence), does not
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
 * round 5, every entry a manifest `skills` override names (each an equally-shaped parent directory,
 * scanned exactly the way the default one is).
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

/** Merge entries by `name`: each name stays where it first appeared but carries its last entry. */
function dedupeByName<T extends { name: string }>(entries: readonly T[]): T[] {
  const byName = new Map<string, T>();
  for (const entry of entries) byName.set(entry.name, entry);
  return [...byName.values()];
}

/** `realpathSync`, or the path unchanged when it cannot be resolved (missing file, broken link, ...). */
function realPathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Whether a manifest `commands` value uses the inline `{name: {source|content}}` map form. Only the
 * first value of the map is inspected.
 */
function isInlineCommandsMap(declared: unknown): boolean {
  if (typeof declared !== "object" || declared === null || Array.isArray(declared)) return false;
  const first: unknown = Object.values(declared)[0];
  if (typeof first !== "object" || first === null) return false;
  return "source" in first || "content" in first;
}

/** A manifest `skills` override, merged additively with the default `skills/` directory (spec: plugin-manifest-paths.md). */
function resolvePluginSkills(root: string, pluginName: string, declared: PluginManifest["skills"], warnings: string[]): PluginSkillEntry[] {
  const defaults = scanPluginSkillsAt(join(root, "skills"), pluginName);
  const override = resolveManifestComponentOverride(root, pluginName, "skills", declared, true, warnings);
  if (override === undefined) return defaults;
  const all: PluginSkillEntry[] = [...defaults];
  for (const dir of override) all.push(...scanPluginSkillsAt(dir, pluginName));
  return dedupeByName(all);
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

/** A manifest `commands` override's resolved paths, each a directory or a single command file (spec: plugin-manifest-paths.md). */
function scanPluginCommandsOverride(paths: readonly string[], pluginName: string): PluginCommandEntry[] {
  const all: PluginCommandEntry[] = [];
  for (const path of paths) {
    let isDir: boolean;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      continue; // vanished since it was resolved -- nothing to load
    }
    if (isDir) {
      all.push(...scanPluginCommandsDir(path, pluginName));
    } else {
      const entry = scanPluginCommandFile(path, pluginName);
      if (entry !== undefined) all.push(entry);
    }
  }
  return dedupeByName(all);
}

/** A manifest `commands` value: the plain path form, or the unsupported inline object-map form (spec: plugin-manifest-paths.md). */
function resolveCommandsManifestOverride(
  root: string,
  pluginName: string,
  declared: PluginManifest["commands"],
  warnings: string[],
): string[] | undefined {
  if (declared === undefined) return undefined;
  if (isInlineCommandsMap(declared)) {
    warnings.push(
      `plugin "${pluginName}"'s manifest "commands" uses the inline {name: {source|content}} form, which Winter does not support yet -- no commands were loaded from it (the default commands/ directory is still shadowed, matching claude's own behaviour whenever the key is present)`,
    );
    return [];
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

/** A manifest `agents` override's resolved paths, each a directory or a single agent file (spec: plugin-manifest-paths.md). */
function scanPluginAgentsOverride(paths: readonly string[], pluginName: string): ScannedAgents {
  const agents: Record<string, PluginAgentDefinition> = {};
  const rejected: AgentDefinitionRejection[] = [];
  for (const path of paths) {
    let isDir: boolean;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      const scanned = scanPluginAgentsDir(path, pluginName);
      // Plain assignment: a name seen earlier keeps its key position but takes the newer definition.
      for (const [name, def] of Object.entries(scanned.agents)) agents[name] = def;
      rejected.push(...scanned.rejected);
    } else {
      scanPluginAgentFile(path, pluginName, agents, rejected);
    }
  }
  return { agents, rejected };
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
/**
 * Reads and parses ONE hooks file at an already-resolved absolute PATH, wrapped-object shape
 * (`{"hooks": {<Event>: [...]}, "modules"?: [...] }`) -- Winter has no modules concept, so only the
 * `"hooks"` key is extracted. Generalised in fix round 5 from the pre-round-5 `readPluginHooksJson`
 * (which only ever read `<root>/hooks/hooks.json`) so the SAME reader serves a manifest `hooks`
 * STRING entry too: a manifest-referenced hooks file is WRAPPED the same way `hooks/hooks.json`
 * itself is, not a bare event-map.
 */
function readHooksFile(path: string, pluginName: string, sourceLabel: string, warnings: string[]): unknown {
  try {
    if (!statSync(path).isFile()) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isPlainObject(parsed)) return undefined;
    const inner = parsed["hooks"];
    if (isPlainObject(inner)) return inner;
    // Fix round 3 (M-5): a well-formed JSON document with no `"hooks"` key (claude also accepts a
    // `"modules"` key there -- Winter has no modules concept to check, so a bare-object-without-
    // "hooks" is the one shape this codebase can detect) is a warning, not a silent no-op, as it is
    // a hook-load failure in claude.
    warnings.push(`plugin "${pluginName}"'s ${sourceLabel} has no "hooks" key -- check that the file follows the required schema ({"hooks": {<Event>: [...]}})`);
    return undefined;
  } catch {
    return undefined;
  }
}

function readPluginHooksJson(root: string, pluginName: string, warnings: string[]): unknown {
  return readHooksFile(join(root, "hooks", "hooks.json"), pluginName, "hooks/hooks.json", warnings);
}

/**
 * Fix round 3 (M-5): the manifest's own `hooks` field is ADDITIVE to `hooks/hooks.json`, never a
 * fallback for it -- claude's manifest schema documents every one of its three accepted shapes as
 * "in addition to those in hooks/hooks.json, if it exists": a bare event-map
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
/** The STRING elements of a manifest `hooks` value: paths to further hooks files (spec: plugin-manifest-hooks-entries.md). */
function resolveManifestHooksStringEntries(root: string, pluginName: string, declared: unknown, warnings: { paths: string[]; content: string[] }): unknown[] {
  const entries: unknown[] = declared === undefined ? [] : Array.isArray(declared) ? declared : [declared];
  const standardPath = resolve(join(root, "hooks", "hooks.json"));
  const standardIdentity = realPathOr(standardPath);
  const accepted = new Set<string>();
  const out: unknown[] = [];
  for (const entry of entries) {
    // Object elements are folded by the caller; other non-strings and "" contribute nothing.
    if (typeof entry !== "string" || entry === "") continue;
    const full = resolve(root, entry);
    if (!resolvesWithinPluginRoot(full, root)) {
      warnings.paths.push(`plugin "${pluginName}"'s manifest "hooks" entry "${entry}" escapes the plugin directory -- ignoring it`);
      continue;
    }
    let isFile = false;
    try {
      isFile = statSync(full).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      warnings.paths.push(`plugin "${pluginName}"'s manifest "hooks" entry "${entry}" was not found at ${full} -- ignoring it`);
      continue;
    }
    const real = realPathOr(full);
    // The standard hooks/hooks.json is already loaded on its own; naming it again is a silent no-op.
    if (real === standardIdentity) continue;
    if (accepted.has(real)) {
      warnings.paths.push(`plugin "${pluginName}"'s manifest "hooks" entry "${entry}" duplicates another entry (both resolve to ${real}) -- loaded once`);
      continue;
    }
    accepted.add(real);
    const hooks = readHooksFile(full, pluginName, `manifest "hooks" entry "${entry}"`, warnings.content);
    if (hooks !== undefined) out.push(hooks);
  }
  return out;
}

function mergeHookSources(
  root: string,
  pluginName: string,
  fromHooksJson: unknown,
  manifestHooks: unknown,
  pathWarnings: string[],
  contentWarnings: string[],
): Record<string, unknown> | undefined {
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
      else if (Array.isArray(existing)) {
        // Fix round 5 (promoted minor, the re-review of 57e7fef..20b623e): a dropped malformed
        // value must be REPORTED, the same way every other hook-load problem is -- the pre-fix
        // silence made "kept the valid one" indistinguishable from "there was only ever one value."
        contentWarnings.push(`plugin "${pluginName}": a malformed "${event}" hooks value was dropped in favour of an earlier valid array for the same event`);
      } else merged[event] = entries;
    }
  };
  foldObject(fromHooksJson);
  if (Array.isArray(manifestHooks)) {
    for (const item of manifestHooks) foldObject(item); // a string element is the OTHER shape, folded below
  } else {
    foldObject(manifestHooks);
  }
  // Fix round 5: the string-element shape, ADDITIVE with everything folded above (claude's own
  // manifest schema describes every accepted `hooks` shape as additive to hooks/hooks.json; this
  // extends the SAME rule to a shape this codebase previously left unread).
  for (const hooksObject of resolveManifestHooksStringEntries(root, pluginName, manifestHooks, { paths: pathWarnings, content: contentWarnings })) {
    foldObject(hooksObject);
  }
  return sawAny ? merged : undefined;
}

/**
 * A default component directory (WS-21 §6.3 item 5, F15's own list), resolved to an ABSOLUTE PATH,
 * present iff the directory exists. `output-styles/` and `workflows/` are consumed downstream
 * (`context/output-styles.ts`'s plugin source, and `tools/registry.ts`'s `pluginWorkflows`, both reading
 * `PluginBundle.outputStylesPath(s)`/`workflowsPath(s)`); `bin/` is still exposed only
 * (`PluginBundle.binPath`), with no consumer yet.
 */
function componentDirIfPresent(root: string, dir: string): string | undefined {
  const path = join(root, dir);
  return isDirectory(path) ? path : undefined;
}

/**
 * A manifest custom-path override for ONE component: `undefined` when the key is absent, else the
 * entries that resolved (an array, possibly empty, which shadows the default directory for every
 * component but skills). Spec: plugin-manifest-paths.md.
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
  // Manifest values are untrusted JSON: a non-array value of any type is treated as one entry.
  const entries: unknown[] = Array.isArray(declared) ? declared : [declared];
  const label = `plugin "${pluginName}"'s manifest "${componentKey}"`;
  const kept: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || entry === "") {
      warnings.push(`${label} entry ${JSON.stringify(entry)} is not a non-empty string -- ignoring it`);
      continue;
    }
    const full = resolve(root, entry);
    if (!resolvesWithinPluginRoot(full, root)) {
      warnings.push(`${label} path "${entry}" escapes the plugin directory -- ignoring it`);
      continue;
    }
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      warnings.push(`${label} path "${entry}" was not found at ${full} -- ignoring it`);
      continue;
    }
    if (requireDirectory && !isDir) {
      const isSkills = componentKey === "skills";
      const why = isSkills ? " (skills entries must be directories containing SKILL.md)" : "";
      const hint = isSkills && basename(entry).toLowerCase() === "skill.md" ? " -- point to its parent directory instead" : "";
      warnings.push(`${label} path "${entry}" is a file, not a directory${why}${hint} -- ignoring it`);
      continue;
    }
    kept.push(full);
  }
  return kept;
}

/** Whether an override's resolved entries already include the default directory, which suppresses the folder-shadowed notice (spec: plugin-manifest-paths.md). */
function manifestOverrideIncludesDefaultDir(resolvedEntries: readonly string[], defaultDirPath: string): boolean {
  const beneath = defaultDirPath + sep;
  return resolvedEntries.some((entry) => entry === defaultDirPath || entry.startsWith(beneath));
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
    // `hooks` block are ADDITIVE, not either/or -- claude loads BOTH (its manifest schema documents
    // the manifest field as "in addition to those in hooks/hooks.json, if it exists"). The
    // pre-fix-round-3 `??` fallback silently dropped a manifest's own hooks whenever a hooks.json
    // ALSO existed.
    const hooks = mergeHookSources(root, name, readPluginHooksJson(root, name, hookFileWarnings), manifest?.hooks, manifestPathWarnings, hookFileWarnings);
    // Fix round 5: a manifest `agents` override SHADOWS the default `agents/` directory (the SAME
    // gate/warning shape workflows already has) -- `requireDirectory: false`, since a bare agent file
    // is a valid entry.
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
    // `!== undefined` rather than `.length > 0`. `requireDirectory: false` -- a bare workflow file
    // is a valid entry.
    const workflowsOverride = resolveManifestComponentOverride(root, name, "workflows", manifest?.workflows, false, manifestPathWarnings);
    const workflowsPath = workflowsOverride === undefined ? componentDirIfPresent(root, "workflows") : undefined;
    // Fix round 4 (minors, M-3's last bullet), advisor catch: claude tells the plugin author when the
    // override key is present AND the default directory ALSO exists on disk (a
    // `folder-shadowed-by-manifest` notice) rather than leaving them to notice the folder's absence
    // from the listing. Checked independently of whether any override entry resolved (the same
    // `!== undefined` reasoning `workflowsPath`'s own suppression above already uses).
    //
    // Fix round 5 (promoted minor, the re-review of 57e7fef..20b623e): the notice must NOT fire when
    // the override's own resolved entries already include the default `workflows/` directory itself
    // (an author who explicitly re-lists `./workflows` alongside a custom path is not losing it).
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
