// SDK 0.0.16 Lane P (R3b §4, "listing filters" `l8n`/`zFn`): the pure filter functions behind
// which `subagent_type` names a session shows right now -- `Agent(type)` deny rules,
// `allowedAgentTypes` (a running agent's own `tools: ["Agent(a,b)"]` restriction) and
// "all-tools-denied" (a built-in whose own explicit `tools` list is itself entirely denied).
//
// `isEnabled` (claude's own THIRD filter, "a required MCP server hasn't connected") is
// DELIBERATELY NOT implemented here: `RuntimeAgentDefinition` (packages/sdk) carries no
// "this definition requires MCP server X" field anywhere in this codebase, so there is nothing for
// a predicate to read. Recorded, not silently dropped -- see this lane's own report.
//
// engine.ts is the ONE caller: `sessionAvailableAgentDefinitions`/`sessionAvailableAgentNames`
// (the listing's own delta producer, `system/init.agents`, `list_agents`) and the Agent tool's
// own `ToolExecutionContext.agentAvailability` seam (tools/impl/agent.ts) all route through these
// same two functions, so none of them can disagree about which types exist right now.
import type { SourcedAgentDefinition } from "./definitions.ts";

export interface AgentAvailabilityInputs {
  /** R3b §4: a per-type `Agent(<type>)` DENY rule -- `findAgentDenyRule(rules, type) !== undefined`, injected so this module takes no dependency on evaluator.ts/ruleset.ts's own rule types. */
  isDenied: (agentType: string) => boolean;
  /** R3b §4: the running agent's (or the session's) own `tools: ["Agent(a,b)"]` restriction -- `allowedAgentTypesFromTools`'s own result. `undefined` = unrestricted. */
  allowedAgentTypes?: readonly string[];
  /** R3b §4 `zFn`: is EVERY tool this definition may use itself denied right now? See `isBuiltinAllToolsDenied` below for the one production implementation. */
  isAllToolsDenied: (def: SourcedAgentDefinition) => boolean;
}

/**
 * claude's `l8n`, composed: the filtered set of `subagent_type` names a session may list/resolve
 * right now. Order-preserving over `defs`' own iteration order (a `Map`'s insertion order) -- the
 * caller sorts if it wants a sorted list, exactly as `sessionAgentDefinitions()`'s existing
 * consumers already do for the unfiltered set.
 */
export function availableAgentNames(defs: ReadonlyMap<string, SourcedAgentDefinition>, inputs: AgentAvailabilityInputs): string[] {
  const out: string[] = [];
  for (const [name, def] of defs) {
    if (inputs.allowedAgentTypes !== undefined && !inputs.allowedAgentTypes.includes(name)) continue;
    if (inputs.isDenied(name)) continue;
    if (inputs.isAllToolsDenied(def)) continue;
    out.push(name);
  }
  return out;
}

// A `Agent(a,b)` entry inside a definition's own `tools` list is a SCOPING annotation on the Agent
// tool's own capability (allowedAgentTypesFromTools's own domain), never itself "a tool this
// definition may use" -- excluded here so a `tools: ["WebFetch", "Agent(Explore)"]` definition
// checks only `WebFetch` for this filter, never treating "Agent(Explore)" as a deniable tool name
// (it is not a registered canonical tool name at all, so it would trivially fail `advertised.
// includes(...)` and falsely mark the WHOLE definition all-tools-denied).
const AGENT_SCOPE_ENTRY_RE = /^Agent\(.*\)$/s;

/**
 * claude's `zFn`: a built-in with an EXPLICIT `tools` list, every one of whose (concrete) tools is
 * itself denied right now, is unavailable -- "Agent type '<x>' is unavailable because every tool it
 * may use is denied by the current permission settings." Winter's own Explore/Plan built-ins use
 * `disallowedTools` (an ADDITIVE restriction over "all tools"), never an explicit `tools` list, so
 * they are EXEMPT from this filter by construction (`def.tools === undefined` always reads false
 * here) -- exactly R3b §4's own "built-ins with explicit tools list only."
 *
 * `advertised` is the session's own currently-advertised canonical tool-name set (engine.ts's
 * `currentAdvertisedCanonicalNames`) -- the SAME ground truth the pre-existing "bare-denied" check
 * (engine.ts, disallowedTools:["t"] -> t absent from that set) already uses, not a second,
 * independently-derived notion of "denied."
 */
export function isBuiltinAllToolsDenied(def: Pick<SourcedAgentDefinition, "tools">, advertised: readonly string[]): boolean {
  const list = def.tools;
  if (list === undefined || list.length === 0) return false;
  const concrete = list.filter((t) => !AGENT_SCOPE_ENTRY_RE.test(t.trim()));
  if (concrete.length === 0) return false; // nothing concrete to check (e.g. tools: ["Agent(a,b)"] alone)
  if (concrete.includes("*")) return advertised.length === 0;
  return concrete.every((t) => !advertised.includes(t));
}
