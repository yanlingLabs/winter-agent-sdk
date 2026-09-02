// Task 12 (WS-07 §11): subagent inheritance mechanics -- the forced-mode table cell-by-cell, the
// disableBypassPermissionsMode veto, and the child-resume stricter-of rule.
import { describe, test, expect } from "bun:test";
import type { PermissionMode } from "@yanlinglabs/winter-agent-sdk";
import { computeChildPolicy, resolveChildResumeMode, stricterOf, AUTO_MODE_STRICTNESS_ORDER } from "./inheritance.ts";
import { emptyRuleSet } from "../ruleset.ts";
import type { PolicyState } from "../policy-state.ts";

const ALL_MODES: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"];

function policy(mode: PermissionMode, version = 5): PolicyState {
  return { mode, version, rules: emptyRuleSet() };
}

describe("computeChildPolicy -- forced-mode table (WS-07 §11), FORCED parent modes", () => {
  const forced: PermissionMode[] = ["bypassPermissions", "acceptEdits", "auto"];

  for (const parentMode of forced) {
    test(`parent=${parentMode}: forced onto every child regardless of definition override`, () => {
      for (const requested of [...ALL_MODES, undefined]) {
        const result = computeChildPolicy(policy(parentMode), requested !== undefined ? { permissionMode: requested } : {});
        expect(result.effectiveMode).toBe(parentMode);
      }
    });
  }
});

describe("computeChildPolicy -- forced-mode table (WS-07 §11), OVERRIDABLE parent modes", () => {
  const overridable: PermissionMode[] = ["default", "dontAsk", "plan"];

  for (const parentMode of overridable) {
    test(`parent=${parentMode}: no override requested -- child inherits the parent mode unchanged`, () => {
      const result = computeChildPolicy(policy(parentMode), {});
      expect(result.effectiveMode).toBe(parentMode);
    });

    for (const requested of ALL_MODES) {
      if (requested === "bypassPermissions") continue; // covered separately below (the one gated cell)
      test(`parent=${parentMode}: definition override to ${requested} is honored`, () => {
        const result = computeChildPolicy(policy(parentMode), { permissionMode: requested });
        expect(result.effectiveMode).toBe(requested);
      });
    }

    test(`parent=${parentMode}: override to bypassPermissions is honored when NOT vetoed`, () => {
      const result = computeChildPolicy(policy(parentMode), { permissionMode: "bypassPermissions" });
      expect(result.effectiveMode).toBe("bypassPermissions");
    });

    test(`parent=${parentMode}: override to bypassPermissions is IGNORED when disableBypassPermissionsMode is set -- child uses the parent mode`, () => {
      const result = computeChildPolicy(policy(parentMode), { permissionMode: "bypassPermissions" }, { disableBypassPermissionsMode: true });
      expect(result.effectiveMode).toBe(parentMode);
    });
  }
});

describe("computeChildPolicy -- parentPolicyVersion / parentPolicyHash", () => {
  test("parentPolicyVersion is the parent's live version counter", () => {
    const result = computeChildPolicy(policy("default", 42), {});
    expect(result.parentPolicyVersion).toBe(42);
  });

  test("parentPolicyHash is content-based -- identical rules/mode/autoConfig hash identically regardless of version", () => {
    const a = computeChildPolicy(policy("default", 1), {});
    const b = computeChildPolicy(policy("default", 2), {});
    expect(a.parentPolicyHash).toBe(b.parentPolicyHash);
  });
});

describe("AUTO_MODE_STRICTNESS_ORDER / stricterOf", () => {
  test("the order is the six public modes, no more, no fewer", () => {
    expect([...AUTO_MODE_STRICTNESS_ORDER].sort()).toEqual([...ALL_MODES].sort());
  });

  test("dontAsk is the strictest of all", () => {
    for (const other of ALL_MODES) expect(stricterOf("dontAsk", other)).toBe("dontAsk");
  });

  test("bypassPermissions is the least strict of all", () => {
    for (const other of ALL_MODES) expect(stricterOf("bypassPermissions", other)).toBe(other);
  });

  test("plan is stricter than default, acceptEdits, auto, and bypassPermissions", () => {
    for (const other of ["default", "acceptEdits", "auto", "bypassPermissions"] as const) {
      expect(stricterOf("plan", other)).toBe("plan");
    }
  });
});

describe("resolveChildResumeMode -- stricter of recorded vs current parent policy (WS-07 §11)", () => {
  test("parent unchanged since spawn -- recorded mode wins trivially (both sides equal)", () => {
    expect(resolveChildResumeMode({ effectiveMode: "acceptEdits", parentPolicyVersion: 1, parentPolicyHash: "h" }, "acceptEdits")).toBe("acceptEdits");
  });

  test("parent became MORE permissive since spawn -- resume does NOT gain the new permissiveness (recorded, stricter, wins)", () => {
    expect(resolveChildResumeMode({ effectiveMode: "default", parentPolicyVersion: 1, parentPolicyHash: "h" }, "bypassPermissions")).toBe("default");
  });

  test("parent became MORE restrictive since spawn -- resume adopts the new restriction (current, stricter, wins)", () => {
    expect(resolveChildResumeMode({ effectiveMode: "bypassPermissions", parentPolicyVersion: 1, parentPolicyHash: "h" }, "dontAsk")).toBe("dontAsk");
  });

  test("KNOWN TENSION (documented): parent was default (child overridden to plan), parent is now auto (forced-mode would force auto onto a FRESH child) -- resume keeps the stricter recorded `plan`, not `auto`", () => {
    const recorded = { effectiveMode: "plan" as const, parentPolicyVersion: 1, parentPolicyHash: "h" };
    expect(resolveChildResumeMode(recorded, "auto")).toBe("plan");
  });
});
