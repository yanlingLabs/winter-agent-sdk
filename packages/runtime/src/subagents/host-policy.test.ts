import { expect, test } from "bun:test";
import type { RuntimeAgentDefinition } from "@yanlinglabs/winter-agent-sdk";
import { resolveHostCodeDescendantPolicy } from "./host-policy.ts";
import { sourceRule } from "../permissions/ruleset.ts";
import { registerTool, unregisterToolForTest, type RegisteredTool } from "../tools/registry.ts";
import type { PolicyState } from "../permissions/policy-state.ts";

const parent: PolicyState = { mode: "default", version: 9, rules: { entries: [], directories: [] } };
const base = { parent, parentTools: ["Read", "Bash", "Write", "Agent", "Workflow"], mayNest: true, background: false, env: {} };
const custom = (extras: Partial<RuntimeAgentDefinition> = {}): RuntimeAgentDefinition => ({ description: "fixture", prompt: "fixture", ...extras });

test("host descendant lookup includes normalized builtin types and prepared overrides", () => {
  const builtin = resolveHostCodeDescendantPolicy({ ...base, agentType: " explore " });
  expect(builtin.agentType).toBe("Explore");
  expect(builtin.disallowedTools).toContain("Write");
  const prepared = resolveHostCodeDescendantPolicy({ ...base, agentType: "Explore", preparedDefinitions: { Explore: custom({ tools: ["Bash"] }) } });
  expect(prepared.tools).toEqual(["Bash"]);
  expect(() => resolveHostCodeDescendantPolicy({ ...base, agentType: "explorer" })).toThrow("not-found");
  expect(() => resolveHostCodeDescendantPolicy({ ...base, agentType: "Explore", env: { WINTER_DISABLE_EXPLORE_PLAN_AGENTS: "1" } })).toThrow("not-found");
});

test("descendants use the forced mode table, bubble and managed bypass veto", () => {
  for (const mode of ["acceptEdits", "auto", "bypassPermissions"] as const) {
    const resolved = resolveHostCodeDescendantPolicy({ ...base, parent: { ...parent, mode }, agentType: "child", preparedDefinitions: { child: custom({ permissionMode: "plan" }) } });
    expect(resolved.policy.effectiveMode).toBe(mode);
    expect(resolved.policy.parentPolicyVersion).toBe(9);
  }
  expect(resolveHostCodeDescendantPolicy({ ...base, agentType: "child", preparedDefinitions: { child: custom({ permissionMode: "bubble" }) } }).policy.effectiveMode).toBe("default");
  expect(resolveHostCodeDescendantPolicy({ ...base, agentType: "child", preparedDefinitions: { child: custom({ permissionMode: "bypassPermissions" }) }, disableBypassPermissionsMode: true }).policy.effectiveMode).toBe("default");
});

test("nested pools cannot widen ancestors; depth, background and forks retain SDK semantics", () => {
  const first = resolveHostCodeDescendantPolicy({ ...base, agentType: "first", preparedDefinitions: { first: custom({ tools: ["Read", "Bash", "Agent", "Forbidden"] }) } });
  const second = resolveHostCodeDescendantPolicy({ ...base, parentTools: first.tools, agentType: "second", preparedDefinitions: { second: custom({ tools: ["*"], disallowedTools: ["Bash(rm *)"] }) }, mayNest: false });
  expect(second.tools).toEqual(["Read", "Bash"]);
  expect(second.disallowedTools).toEqual(["Bash(rm *)"]);
  expect(resolveHostCodeDescendantPolicy({ ...base, agentType: "general-purpose" }).tools).not.toContain("Workflow");
  expect(resolveHostCodeDescendantPolicy({ ...base, agentType: "fork", fork: true, forkSubagentEnabled: true }).tools).toContain("Workflow");
});

test("host ancestor policy denies normalized Agent scopes and rejects ambiguous definitions", () => {
  expect(() => resolveHostCodeDescendantPolicy({ ...base, parent: { ...parent, rules: { entries: [sourceRule({ toolName: "Agent", ruleContent: "explore" }, "deny", "sdk")], directories: [] } }, agentType: "Explore" })).toThrow("denied");
  expect(() => resolveHostCodeDescendantPolicy({ ...base, agentType: "Explore", allowedAgentTypes: ["Plan"] })).toThrow("denied");
  expect(() => resolveHostCodeDescendantPolicy({ ...base, agentType: "a b", preparedDefinitions: { "a-b": custom(), a_b: custom() } })).toThrow("ambiguous");
});

test("legacy registered tool names and scoped denies use canonical SDK identities", () => {
  const name = "HostPolicyRenameProbe";
  registerTool({ descriptor: { canonicalName: name, advertisedName: name }, executor: async () => ({ output: "" }) } as unknown as RegisteredTool);
  try {
    const resolved = resolveHostCodeDescendantPolicy({ ...base, parentTools: [name], agentType: "child", preparedDefinitions: { child: custom({ tools: ["OldProbe"], disallowedTools: ["OldProbe(*)"] }) }, legacyToolNames: { OldProbe: name } });
    expect(resolved.tools).toEqual([name]);
    expect(resolved.disallowedTools).toEqual([`${name}(*)`]);
  } finally { unregisterToolForTest(name); }
});
