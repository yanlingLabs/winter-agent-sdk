import { describe, test, expect } from "bun:test";
import { availableAgentNames, isBuiltinAllToolsDenied } from "./availability.ts";
import type { SourcedAgentDefinition } from "./definitions.ts";

function def(over: Partial<SourcedAgentDefinition> = {}): SourcedAgentDefinition {
  return { description: "d", prompt: "p", _source: "builtin", ...over };
}

describe("availableAgentNames (SDK 0.0.16 Lane P, R3b §4)", () => {
  const defs = new Map<string, SourcedAgentDefinition>([
    ["general-purpose", def({ tools: ["*"] })],
    ["Explore", def({ disallowedTools: ["Agent"] })],
    ["Plan", def({ disallowedTools: ["Agent"] })],
    ["fork", def({ tools: ["*"] })],
  ]);

  test("no restrictions at all -> every name passes through, order preserved", () => {
    const out = availableAgentNames(defs, { isDenied: () => false, isAllToolsDenied: () => false });
    expect(out).toEqual(["general-purpose", "Explore", "Plan", "fork"]);
  });

  test("a denied name is removed and nothing else is affected", () => {
    const out = availableAgentNames(defs, { isDenied: (t) => t === "Explore", isAllToolsDenied: () => false });
    expect(out).toEqual(["general-purpose", "Plan", "fork"]);
  });

  test("allowedAgentTypes restricts to exactly that set", () => {
    const out = availableAgentNames(defs, { isDenied: () => false, allowedAgentTypes: ["Explore", "Plan"], isAllToolsDenied: () => false });
    expect(out).toEqual(["Explore", "Plan"]);
  });

  test("allowedAgentTypes naming a type that does not exist in defs simply contributes nothing", () => {
    const out = availableAgentNames(defs, { isDenied: () => false, allowedAgentTypes: ["Explore", "nonexistent"], isAllToolsDenied: () => false });
    expect(out).toEqual(["Explore"]);
  });

  test("all-tools-denied removes only the affected name", () => {
    const out = availableAgentNames(defs, { isDenied: () => false, isAllToolsDenied: (d) => d.tools?.includes("*") === true && defs.get("fork") === d });
    expect(out).toEqual(["general-purpose", "Explore", "Plan"]);
  });

  test("all three filters compose", () => {
    const out = availableAgentNames(defs, {
      isDenied: (t) => t === "Plan",
      allowedAgentTypes: ["Explore", "Plan", "fork"],
      isAllToolsDenied: (d) => d === defs.get("fork"),
    });
    expect(out).toEqual(["Explore"]);
  });
});

describe("isBuiltinAllToolsDenied (SDK 0.0.16 Lane P, R3b §4 zFn)", () => {
  test("a disallowedTools-only definition (Explore/Plan's own shape) is exempt -- no explicit tools list to check", () => {
    expect(isBuiltinAllToolsDenied({ tools: undefined }, [])).toBe(false);
  });

  test('tools: ["*"] is denied only when EVERY currently-advertised tool is gone', () => {
    expect(isBuiltinAllToolsDenied({ tools: ["*"] }, [])).toBe(true);
    expect(isBuiltinAllToolsDenied({ tools: ["*"] }, ["Bash", "Read"])).toBe(false);
  });

  test('tools: ["WebFetch"] is denied exactly when WebFetch itself is not advertised', () => {
    expect(isBuiltinAllToolsDenied({ tools: ["WebFetch"] }, ["Bash"])).toBe(true);
    expect(isBuiltinAllToolsDenied({ tools: ["WebFetch"] }, ["Bash", "WebFetch"])).toBe(false);
  });

  test("a multi-tool explicit list is denied only when ALL of them are gone -- one surviving tool keeps it available", () => {
    expect(isBuiltinAllToolsDenied({ tools: ["Bash", "Read"] }, ["Read"])).toBe(false);
    expect(isBuiltinAllToolsDenied({ tools: ["Bash", "Read"] }, ["WebFetch"])).toBe(true);
  });

  test("an Agent(a,b) scoping entry alongside a real tool checks only the real tool", () => {
    expect(isBuiltinAllToolsDenied({ tools: ["*", "Agent(Explore, Plan)"] }, ["Bash"])).toBe(false);
    expect(isBuiltinAllToolsDenied({ tools: ["WebFetch", "Agent(Explore)"] }, ["Bash"])).toBe(true);
  });

  test("an Agent(a,b) entry alone, with no other concrete tool, has nothing to check -- not denied", () => {
    expect(isBuiltinAllToolsDenied({ tools: ["Agent(Explore, Plan)"] }, [])).toBe(false);
  });
});
