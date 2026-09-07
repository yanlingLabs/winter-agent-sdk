// Phase 5 Lane S (WS-11 §4): the loaded-plugin SHAPE, plus the derivations every other subsystem
// consumes.
//
// A plugin is "a namespaced aggregator over those subsystems" (WS-11 §4) -- so this module holds the
// aggregate and the four small pure functions that project it onto each consumer's own input shape.
// Nothing here reads the filesystem (loader.ts does that) and nothing here connects anything: the
// MCP servers are RAW configs handed onward to Lane A's `resolveMcpServerSources`, exactly as that
// function's own header requires ("WHERE the project `mcp.json`/settings actually get read from disk...
// are integration concerns for whoever assembles `McpServerSource[]`").
import type { InitPluginInfo } from "@yanlinglabs/winter-agent-sdk";
import type { PluginCommandContribution } from "../commands/resolver.ts";
import type { PluginSkillContribution } from "../skills/store.ts";
import type { PluginAgentDefinition } from "../subagents/definitions.ts";

export interface PluginSkillEntry {
  /** The BARE name, as the skill's own frontmatter declares it. */
  name: string;
  /** `<plugin>:<skill>` -- the one place plugin skills get namespaced (WS-11 §4). */
  qualifiedName: string;
  description: string;
  /** Absolute. */
  path: string;
  author?: string;
}

export interface PluginCommandEntry {
  name: string;
  qualifiedName: string;
  /** Absolute. */
  path: string;
  description?: string;
  argumentHint?: string;
}

export interface PluginMetadata {
  description?: string;
  author?: string;
  homepage?: string;
  keywords?: string[];
}

export interface PluginBundle {
  /** Manifest `name`, else the root's basename (WS-11 §4's manifestless rule). */
  name: string;
  /** The RESOLVED absolute plugin root -- `system/init.plugins[].path`. */
  path: string;
  version?: string;
  /** Absolute path of the manifest that named it, absent for a manifestless plugin. */
  manifestPath?: string;
  metadata: PluginMetadata;
  skills: PluginSkillEntry[];
  commands: PluginCommandEntry[];
  /** Keyed by `subagent_type`, each already stamped with this plugin's name. */
  agents: Record<string, PluginAgentDefinition>;
  /** The manifest's `hooks` block, verbatim and unparsed. Absent when the plugin declares none. */
  hooks?: unknown;
  /** RAW per-name MCP configs (manifest + `.mcp.json`). Empty when `skipMcpDiscovery` is set. */
  mcpServers: Record<string, unknown>;
  /** Absolute path of the `.mcp.json` that contributed, when one did. */
  mcpConfigPath?: string;
  skipMcpDiscovery: boolean;
}

/**
 * `system/init.plugins` (`sdk.d.ts:4881-4889`): `{ name, path, version? }`. `version` is
 * plugin-author-controlled and its own pinned doc says to validate before trusting -- Winter carries
 * it through verbatim and asserts nothing about it, which is what "carried, not trusted" means here.
 */
export function pluginInitInfo(bundles: readonly PluginBundle[]): InitPluginInfo[] {
  return bundles.map((b) => ({ name: b.name, path: b.path, ...(b.version !== undefined ? { version: b.version } : {}) }));
}

/**
 * `loadAgentDefinitions`' `pluginAgents` input (subagents/definitions.ts, T2's fourth tier).
 *
 * FIRST PLUGIN WINS a name collision, matching `loadPlugins`' own first-wins order for every other
 * subsystem. The alternative (last wins) would make a plugin's agents depend on where the host
 * happened to put it in the array, in the opposite direction from skills and commands.
 */
export function pluginAgentDefinitions(bundles: readonly PluginBundle[]): Record<string, PluginAgentDefinition> {
  const out: Record<string, PluginAgentDefinition> = {};
  for (const bundle of bundles) {
    for (const [name, def] of Object.entries(bundle.agents)) {
      if (out[name] === undefined) out[name] = def;
    }
  }
  return out;
}

/** `SkillIndex.build`'s `plugins` input. BARE names -- the index does the qualification itself. */
export function pluginSkillContributions(bundles: readonly PluginBundle[]): PluginSkillContribution[] {
  return bundles.map((bundle) => ({
    plugin: bundle.name,
    skills: bundle.skills.map((s) => ({ name: s.name, description: s.description, path: s.path, ...(s.author !== undefined ? { author: s.author } : {}) })),
  }));
}

/** `FilesystemCommandResolver`'s `plugins` input. BARE names, for the same reason. */
export function pluginCommandContributions(bundles: readonly PluginBundle[]): PluginCommandContribution[] {
  return bundles.map((bundle) => ({
    plugin: bundle.name,
    commands: bundle.commands.map((c) => ({
      name: c.name,
      path: c.path,
      ...(c.description !== undefined ? { description: c.description } : {}),
      ...(c.argumentHint !== undefined ? { argumentHint: c.argumentHint } : {}),
    })),
  }));
}
