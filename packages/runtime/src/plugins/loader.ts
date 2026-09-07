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
import { basename, join, resolve } from "node:path";
import type { BrandProfile, SdkPluginConfig } from "@yanlinglabs/winter-agent-sdk";
import { parseSkillFile } from "../skills/frontmatter.ts";
import { pluginNameError } from "../skills/frontmatter.ts";
import { parseAgentDefinitionFile } from "../subagents/definitions.ts";
import type { PluginAgentDefinition } from "../subagents/definitions.ts";
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

function scanPluginSkills(root: string, pluginName: string): PluginSkillEntry[] {
  const skillsRoot = join(root, "skills");
  let dirs: string[];
  try {
    dirs = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const out: PluginSkillEntry[] = [];
  for (const dir of dirs) {
    const path = join(skillsRoot, dir, "SKILL.md");
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
 * A plugin command file's frontmatter, read for the listing only -- the BODY is re-read at resolve
 * time by `FilesystemCommandResolver`, which owns `$ARGUMENTS` and the frontmatter strip. Two
 * readers of one file, deliberately: this one must not retain bodies (the same lazy discipline the
 * skill index follows), and the resolver must see the file as it is when the command actually runs.
 */
function scanPluginCommands(root: string, pluginName: string): PluginCommandEntry[] {
  const commandsRoot = join(root, "commands");
  let files: string[];
  try {
    files = readdirSync(commandsRoot, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const out: PluginCommandEntry[] = [];
  for (const file of files) {
    const path = join(commandsRoot, file);
    const name = basename(file, ".md");
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const attrs = frontmatterAttrs(raw);
    out.push({
      name,
      qualifiedName: `${pluginName}:${name}`,
      path,
      ...(attrs["description"] !== undefined ? { description: attrs["description"] } : {}),
      ...(attrs["argument-hint"] !== undefined ? { argumentHint: attrs["argument-hint"] } : {}),
    });
  }
  return out;
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
 */
function scanPluginAgents(root: string, pluginName: string): Record<string, PluginAgentDefinition> {
  const agentsRoot = join(root, "agents");
  let files: string[];
  try {
    files = readdirSync(agentsRoot).sort();
  } catch {
    return {};
  }
  const out: Record<string, PluginAgentDefinition> = {};
  for (const file of files) {
    if (!file.toLowerCase().endsWith(".md")) continue;
    const full = join(agentsRoot, file);
    try {
      if (!statSync(full).isFile()) continue;
      const name = basename(file).replace(/\.md$/i, "");
      const def = parseAgentDefinitionFile(readFileSync(full, "utf8"), name);
      if (def !== undefined) out[name] = { ...def, plugin: pluginName };
    } catch {
      continue;
    }
  }
  return out;
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
    // reuser's `.acme-plugin/plugin.json` was never discovered -- only `.winter-plugin` and the
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
    const hooks = manifest?.hooks;

    seenRoots.add(identity);
    seenNames.add(name);
    bundles.push({
      name,
      path: root,
      ...(typeof manifest?.version === "string" ? { version: manifest.version } : {}),
      ...(manifestResult.path !== undefined ? { manifestPath: manifestResult.path } : {}),
      metadata: metadataOf(manifest),
      skills: scanPluginSkills(root, name),
      commands: scanPluginCommands(root, name),
      agents: scanPluginAgents(root, name),
      ...(hooks !== undefined ? { hooks } : {}),
      mcpServers: mcp.servers,
      ...(mcp.configPath !== undefined ? { mcpConfigPath: mcp.configPath } : {}),
      skipMcpDiscovery,
    });
  }

  return { bundles, rejected };
}
