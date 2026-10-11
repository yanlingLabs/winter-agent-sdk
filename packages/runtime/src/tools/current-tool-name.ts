import type { RuntimeAgentDefinition } from "@yanlinglabs/winter-agent-sdk";
import { getRegisteredTool, registeredNameForMcpSpelling } from "./registry.ts";

/** A registered name wins over a legacy alias, as it does in the running engine. */
export function currentToolName(name: string, legacyToolNames: Readonly<Record<string, string>> = {}): string {
  if (getRegisteredTool(name) !== undefined) return name;
  const target = Object.hasOwn(legacyToolNames, name) ? legacyToolNames[name] : undefined;
  if (typeof target === "string" && getRegisteredTool(target) !== undefined) return target;
  return name.startsWith("mcp__") ? registeredNameForMcpSpelling(name) : name;
}

/** Denies retain both identities when an old spelling is still registered. */
export function currentToolRules(rules: readonly string[], legacyToolNames: Readonly<Record<string, string>> = {}): string[] {
  return [...new Set(rules.flatMap((rule) => {
    const head = /^([^(]+)(.*)$/s.exec(rule.trim());
    if (head === null) return [rule];
    const normalized = `${currentToolName(head[1]!, legacyToolNames)}${head[2]}`;
    const target = Object.hasOwn(legacyToolNames, head[1]!) ? legacyToolNames[head[1]!] : undefined;
    return typeof target === "string" && target.length > 0 ? [normalized, `${target}${head[2]}`] : [normalized];
  }))];
}

/** Shared fresh-spawn intersection; definition declarations never widen the parent pool. */
export function inheritDefinitionTools(parentTools: readonly string[], definition: Pick<RuntimeAgentDefinition, "tools">, legacyToolNames?: Readonly<Record<string, string>>): string[] {
  const parent = [...new Set(parentTools.map((name) => currentToolName(name, legacyToolNames)))];
  if (definition.tools === undefined || definition.tools.includes("*")) return parent;
  return [...new Set(definition.tools.map((name) => currentToolName(name, legacyToolNames)))].filter((name) => parent.includes(name));
}
