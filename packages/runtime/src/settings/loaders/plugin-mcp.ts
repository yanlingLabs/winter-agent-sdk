// Phase 5 Lane S: plugin-contributed MCP servers, as Lane A's `McpServerSource[]` input.
//
// The lowest-precedence origin (WS-09 §1.2: explicit > settings > project > plugin), and NOT trust-
// gated: a plugin is loaded because the host listed it in `Options.plugins`, a decision made outside
// the repository -- the same reasoning subagents/definitions.ts records for `pluginAgents`, and the
// same reason `skipMcpDiscovery` exists as a per-plugin opt-out rather than a trust question.
//
// ONE SOURCE PER PLUGIN rather than one merged map, so `resolveMcpServerSources` can report a
// cross-plugin name collision as `shadowed` (naming the loser) instead of this module silently
// picking a winner. That is WS-09 §1.2's own "the losing declaration is reported, never silently
// merged" applied one level up.
import type { McpServerSource } from "../../mcp/lifecycle.ts";
import type { PluginBundle } from "../../plugins/bundle.ts";

export function pluginMcpServerSources(bundles: readonly PluginBundle[]): McpServerSource[] {
  const sources: McpServerSource[] = [];
  for (const bundle of bundles) {
    // `skipMcpDiscovery` already emptied `mcpServers` at load time (plugins/loader.ts); the explicit
    // check is here so a bundle constructed by hand cannot route around the flag.
    if (bundle.skipMcpDiscovery) continue;
    if (Object.keys(bundle.mcpServers).length === 0) continue;
    sources.push({ origin: "plugin", servers: bundle.mcpServers });
  }
  return sources;
}
