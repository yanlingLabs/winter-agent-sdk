import { WINTER_BRAND, type BrandProfile, type RuntimeAgentDefinition } from "@yanlinglabs/winter-agent-sdk";
import { computeChildPolicy, type ChildPolicyResult } from "../permissions/auto/inheritance.ts";
import { isPermissionMode, type PolicyState } from "../permissions/policy-state.ts";
import { findAgentDenyRule } from "../permissions/evaluator.ts";
import { currentToolName, currentToolRules, inheritDefinitionTools } from "../tools/current-tool-name.ts";
import { findAgentByType, allowedAgentTypesFromTools, type SourcedAgentDefinition } from "./definitions.ts";
import { resolveBuiltinAgents, resolveBuiltinAgentGates } from "./builtin-agents.ts";
import { applySubagentToolPool } from "./tool-pools.ts";
import { isBuiltinAllToolsDenied } from "./availability.ts";

export interface HostCodeDescendantPolicyOptions {
  parent: PolicyState;
  /** The host's current advertised canonical pool, already narrowed by its ancestors. */
  parentTools: readonly string[];
  /** Captured host definitions, including allowed filesystem/plugin tiers, override builtins. */
  preparedDefinitions?: Readonly<Record<string, RuntimeAgentDefinition>>;
  agentType: string;
  legacyToolNames?: Readonly<Record<string, string>>;
  allowedAgentTypes?: readonly string[];
  brand?: BrandProfile;
  env?: Record<string, string | undefined>;
  forkSubagentEnabled?: boolean;
  disableBypassPermissionsMode?: boolean;
  /** Taken from the host's validated ancestry, never guest execution snapshots. */
  mayNest: boolean;
  background: boolean;
  fork?: boolean;
}

export interface HostCodeDescendantPolicy {
  agentType: string;
  definition: RuntimeAgentDefinition;
  policy: ChildPolicyResult;
  tools: string[];
  disallowedTools: string[];
  allowedAgentTypes?: string[];
}

/** Pure policy reconstruction for one verified descendant. The host owns ancestry/identity.
 * No filesystem stores, guest snapshots or guest permission state are read here. */
export function resolveHostCodeDescendantPolicy(options: HostCodeDescendantPolicyOptions): HostCodeDescendantPolicy {
  const brand = options.brand ?? WINTER_BRAND;
  const env = options.env ?? process.env;
  const builtin = resolveBuiltinAgents({ brand, env, ...(options.forkSubagentEnabled !== undefined ? {
    gates: { ...resolveBuiltinAgentGates(env, brand), forkSubagentEnabled: options.forkSubagentEnabled },
  } : {}) });
  const definitions = new Map<string, SourcedAgentDefinition>();
  for (const [name, definition] of Object.entries(builtin)) definitions.set(name, { ...definition, _source: "builtin" });
  for (const [name, definition] of Object.entries(options.preparedDefinitions ?? {})) definitions.set(name, { ...definition, _source: "programmatic" });
  const found = findAgentByType(definitions, options.agentType);
  if (found.kind !== "found") throw new Error(`Host descendant agent type ${JSON.stringify(options.agentType)} is ${found.kind}`);
  if ((options.allowedAgentTypes !== undefined && !options.allowedAgentTypes.includes(found.name)) || findAgentDenyRule(options.parent.rules, found.name) !== undefined) {
    throw new Error(`Host descendant agent type ${JSON.stringify(found.name)} is denied`);
  }
  const { _source: _source, _plugin: _plugin, ...definition } = found.definition;
  if (isBuiltinAllToolsDenied({ ...(definition.tools !== undefined ? { tools: definition.tools.map((name) => currentToolName(name, options.legacyToolNames)) } : {}) }, options.parentTools)) {
    throw new Error(`Host descendant agent type ${JSON.stringify(found.name)} is unavailable: all declared tools are denied`);
  }
  const requested = definition.permissionMode;
  const policy = computeChildPolicy(options.parent, {
    ...(requested !== undefined && isPermissionMode(requested) ? { permissionMode: requested } : {}),
  }, { disableBypassPermissionsMode: options.disableBypassPermissionsMode === true });
  const inherited = inheritDefinitionTools(options.parentTools, definition, options.legacyToolNames);
  const tools = options.fork === true ? inherited : applySubagentToolPool(inherited, {
    planMode: policy.effectiveMode === "plan", mayNest: options.mayNest, background: options.background, brand,
  });
  const disallowedTools = currentToolRules(definition.disallowedTools ?? [], options.legacyToolNames);
  const allowedAgentTypes = allowedAgentTypesFromTools(definition.tools);
  return { agentType: found.name, definition: structuredClone(definition), policy, tools, disallowedTools,
    ...(allowedAgentTypes !== undefined ? { allowedAgentTypes } : {}) };
}
