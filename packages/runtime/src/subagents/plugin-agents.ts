// Phase 5 Task 8 (Lane S's "What T8 must wire" item 3): the session-keyed channel plugin-contributed
// `AgentDefinition`s reach `tools/impl/agent.ts` on.
//
// WHY A SIDE REGISTRY RATHER THAN `config.agents`. `loadAgentDefinitions` already takes a
// `pluginAgents` parameter, and precedence across its four sources is programmatic > project > user
// > PLUGIN (definitions.ts's own order). Folding plugin agents into `config.agents` -- the only
// channel `ToolExecutionContext` carries today -- would promote them to PROGRAMMATIC precedence, so
// a plugin's default would silently override a user's own `~/.winter/agents/<name>.md`. That is a
// behaviour change disguised as plumbing.
//
// WHY NOT A NEW `ToolExecutionContext` FIELD. `registry.ts`'s context is threaded from
// `buildDefaultToolExecutor` inside `runEngine`'s closure, and the plugin bundles are resolved one
// level up (production-wiring.ts, before `runEngine` is called). A session-keyed side registry is
// this codebase's established answer for exactly that shape -- `skills/runtime.ts`,
// `toolsearch/search.ts`, `mcp/lifecycle.ts` and `workflows/host-registry.ts` all take it, each for
// the same reason and each with the same `register`/`get`/`clear` trio.
//
// KEYED BY `sessionId`, NOT `agentId ?? sessionId` -- deliberately the opposite of the skills
// registry's key, and the difference is the point. A session's SKILLS are a per-engine option a
// child may legitimately be restricted out of, so a child must not resolve against its parent's set.
// A session's PLUGINS are a host-level fact: the same plugins are loaded for the whole session, and
// a child engine (which carries its parent's `config.sessionId`) should see the same agent
// definitions its parent does. Keying this by `agentId` would make a plugin-defined `subagent_type`
// resolvable from the top level and mysteriously absent one level down.
import type { PluginAgentDefinition } from "./definitions.ts";

const bySession = new Map<string, Record<string, PluginAgentDefinition>>();

export function registerPluginAgents(sessionId: string, agents: Record<string, PluginAgentDefinition>): void {
  if (Object.keys(agents).length === 0) {
    // An empty map is not a registration. `getPluginAgents` returning `undefined` is what lets
    // `loadAgentDefinitions`' own conditional spread omit the parameter entirely, keeping a session
    // with no plugins byte-identical to one from before this wiring existed.
    bySession.delete(sessionId);
    return;
  }
  bySession.set(sessionId, agents);
}

export function getPluginAgents(sessionId: string): Record<string, PluginAgentDefinition> | undefined {
  return bySession.get(sessionId);
}

/** Called on run teardown. A registry that only ever grows would leak a plugin set per session. */
export function clearPluginAgents(sessionId: string): void {
  bySession.delete(sessionId);
}
