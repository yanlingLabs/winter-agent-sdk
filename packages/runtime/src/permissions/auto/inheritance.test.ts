// Task 12 (WS-07 §11): subagent inheritance mechanics -- the forced-mode table cell-by-cell, the
// disableBypassPermissionsMode veto, and the child-resume stricter-of rule.
import { describe, test, expect } from "bun:test";
import type { PermissionMode } from "@yanlinglabs/winter-agent-sdk";
import { computeChildPolicy, resolveChildResumeMode, stricterOf, AUTO_MODE_STRICTNESS_ORDER, ChildResumeModeIncomparableError } from "./inheritance.ts";
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

// RULING P2-M (Phase 4, Task 3): the scalar AUTO_MODE_STRICTNESS_ORDER above is RETIRED as a total
// order -- see inheritance.ts's own header for the full per-axis model this replaces it with. These
// two cells are the ones the P2 fix-round comment identified as ACTIVELY UNSAFE under the old scalar
// order; they are written FIRST (RED against the pre-P2-M `stricterOf`) so the fix is provably a fix,
// not a reformulation that happens to still pass.
describe("RULING P2-M -- per-axis comparator: the two proven-widening cells", () => {
  test("cell (i): auto-recorded child resumed under a parent now at acceptEdits must NOT become acceptEdits's un-suspended Bash(*) allow -- auto (rule-silencing axis) wins over acceptEdits (non-silencing)", () => {
    // Old scalar order: rank(acceptEdits)=3 < rank(auto)=4, so stricterOf picked acceptEdits -- WRONG:
    // acceptEdits does not suspend a broad Bash(*) allow the way auto's isAutoSuspendedAllowRule does.
    expect(stricterOf("auto", "acceptEdits")).toBe("auto");
    expect(stricterOf("acceptEdits", "auto")).toBe("auto"); // order-independent
    expect(resolveChildResumeMode({ effectiveMode: "auto", parentPolicyVersion: 1, parentPolicyHash: "h" }, "acceptEdits")).toBe("auto");
  });

  test("cell (ii): plan-recorded child under a parent now at dontAsk must NOT gain dontAsk's rule-silent writes -- plan (rule-silencing axis) wins over dontAsk (non-silencing)", () => {
    // Old scalar order: rank(dontAsk)=0 < rank(plan)=1, so stricterOf picked dontAsk -- WRONG: dontAsk
    // lets an existing allow-rule match proceed unmodified (WS-07 §6.3), so a write plan withholds
    // UNCONDITIONALLY would execute silently under dontAsk if dontAsk won this comparison.
    expect(stricterOf("plan", "dontAsk")).toBe("plan");
    expect(stricterOf("dontAsk", "plan")).toBe("plan"); // order-independent
    expect(resolveChildResumeMode({ effectiveMode: "plan", parentPolicyVersion: 1, parentPolicyHash: "h" }, "dontAsk")).toBe("plan");
  });
});

describe("AUTO_MODE_STRICTNESS_ORDER / stricterOf", () => {
  test("the order is the six public modes, no more, no fewer (retained ONLY as the axis-2 tie-break table -- see inheritance.ts header)", () => {
    expect([...AUTO_MODE_STRICTNESS_ORDER].sort()).toEqual([...ALL_MODES].sort());
  });

  // RULING P2-M supersedes this claim in its old unqualified form: dontAsk is the global minimum
  // ONLY within the non-silencing partition {default, dontAsk, acceptEdits, bypassPermissions} --
  // it has NO rule-silencing property of its own (WS-07 §6.3: allow-rule/allowedTools matches still
  // proceed under dontAsk), so a rule-silencing mode (plan/auto) is judged stricter than it on axis 1.
  test("dontAsk is the strictest of the non-silencing partition (default/acceptEdits/bypassPermissions), and plan (rule-silencing) still wins over it -- but dontAsk vs auto is INCOMPARABLE, not a plan-like win (RULING P4-D)", () => {
    for (const other of ["default", "acceptEdits", "bypassPermissions", "dontAsk"] as const) {
      expect(stricterOf("dontAsk", other)).toBe("dontAsk");
    }
    expect(stricterOf("dontAsk", "plan")).toBe("plan"); // plan's rule-silencing genuinely dominates -- no offsetting weakness
    // RULING P4-D (fix round 1, MAJOR item 2): auto is NOT judged stricter than dontAsk the way plan
    // is -- dontAsk denies every unresolved (no-matching-rule) action outright but still HONORS a
    // pre-existing broad allow rule unmodified (WS-07 §6.3); auto classifies/auto-approves the
    // unresolved residual but SUSPENDS a broad allow rule to classifier review. Each dominates the
    // other on a DIFFERENT sub-question -- neither is "stricter." This is genuinely RED against the
    // pre-fix-round `stricterOf`, which returned "auto" here (axis 1 treated as a total dominance
    // order over ALL non-silencing modes, dontAsk included).
    expect(() => stricterOf("dontAsk", "auto")).toThrow(ChildResumeModeIncomparableError);
  });

  test("bypassPermissions is the least strict of all", () => {
    for (const other of ALL_MODES) expect(stricterOf("bypassPermissions", other)).toBe(other);
  });

  test("plan is stricter than default, acceptEdits, and bypassPermissions (non-silencing partition), and stricter than auto (same rule-silencing partition, narrower breadth)", () => {
    for (const other of ["default", "acceptEdits", "auto", "bypassPermissions"] as const) {
      expect(stricterOf("plan", other)).toBe("plan");
    }
  });

  test("axis 1 (rule-silencing) is lexicographically dominant over axis 2 (breadth) -- auto is judged stricter than default/acceptEdits/bypassPermissions despite auto's classifier auto-approving more in the ordinary case; dontAsk is the ONE documented exception (RULING P4-D), refused rather than judged", () => {
    for (const other of ["default", "acceptEdits", "bypassPermissions"] as const) {
      expect(stricterOf("auto", other)).toBe("auto");
    }
    expect(() => stricterOf("auto", "dontAsk")).toThrow(ChildResumeModeIncomparableError);
  });
});

// RULING P4-D (fix round 1, MAJOR item 2, WS-07 §11): dontAsk vs auto is the ONE pair this axis
// model refuses to judge at all -- see inheritance.ts's own header + stricterOf's own doc comment
// for the full mechanism-level reasoning. Fail-closed: never silently widen OR narrow, never invent
// a composite mode; a future resume path (P8) may offer the host/user an explicit choice instead.
describe("RULING P4-D -- dontAsk vs auto is INCOMPARABLE on axis 1: fail closed, both directions, both call sites", () => {
  test("stricterOf refuses both directions", () => {
    expect(() => stricterOf("dontAsk", "auto")).toThrow(ChildResumeModeIncomparableError);
    expect(() => stricterOf("auto", "dontAsk")).toThrow(ChildResumeModeIncomparableError);
  });

  test("resolveChildResumeMode refuses both directions -- never silently widens (recorded dontAsk, current auto) or narrows (recorded auto, current dontAsk)", () => {
    const recordedDontAsk = { effectiveMode: "dontAsk" as const, parentPolicyVersion: 1, parentPolicyHash: "h" };
    const recordedAuto = { effectiveMode: "auto" as const, parentPolicyVersion: 1, parentPolicyHash: "h" };
    expect(() => resolveChildResumeMode(recordedDontAsk, "auto")).toThrow(ChildResumeModeIncomparableError);
    expect(() => resolveChildResumeMode(recordedAuto, "dontAsk")).toThrow(ChildResumeModeIncomparableError);
  });

  test("the thrown error names both modes, in the order given", () => {
    try {
      stricterOf("dontAsk", "auto");
      throw new Error("expected stricterOf to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ChildResumeModeIncomparableError);
      const err = e as ChildResumeModeIncomparableError;
      expect(err.modeA).toBe("dontAsk");
      expect(err.modeB).toBe("auto");
    }
    try {
      resolveChildResumeMode({ effectiveMode: "auto", parentPolicyVersion: 1, parentPolicyHash: "h" }, "dontAsk");
      throw new Error("expected resolveChildResumeMode to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ChildResumeModeIncomparableError);
      const err = e as ChildResumeModeIncomparableError;
      // resolveChildResumeMode(recorded, current) delegates to stricterOf(recorded.effectiveMode,
      // current) positionally -- "recorded" first, "current" second -- so the error's own (modeA,
      // modeB) naming carries that same (recorded, current) meaning for this call site, without
      // resolveChildResumeMode needing its own separate error-construction path.
      expect(err.modeA).toBe("auto"); // recorded
      expect(err.modeB).toBe("dontAsk"); // current
    }
  });

  test("a genuinely comparable pair is unaffected -- no over-broad refusal", () => {
    expect(stricterOf("plan", "dontAsk")).toBe("plan");
    expect(stricterOf("auto", "acceptEdits")).toBe("auto");
    expect(resolveChildResumeMode({ effectiveMode: "bypassPermissions", parentPolicyVersion: 1, parentPolicyHash: "h" }, "dontAsk")).toBe("dontAsk");
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

  test("recorded plan, current auto -- resume keeps the stricter recorded `plan` (same rule-silencing partition, plan narrower than auto), not `auto`", () => {
    const recorded = { effectiveMode: "plan" as const, parentPolicyVersion: 1, parentPolicyHash: "h" };
    expect(resolveChildResumeMode(recorded, "auto")).toBe("plan");
  });
});

// --- Phase 4 fix wave (whole-branch M8): the FULL 36-cell comparator matrix ----------------------
//
// RULING P4-D's own process lesson, verbatim from the ledger: "comparator rulings get a full-matrix
// FIXTURE, not a hand trace." The tests above cover one full row (bypassPermissions) and hand-picked
// subsets elsewhere, which is exactly the shape that let the {dontAsk, auto} cell hide in the first
// place. Every cell below is written out BY HAND from the axis model in inheritance.ts's own header
// -- deliberately NOT re-derived from `stricterOf`'s implementation, which would make the table a
// tautology instead of a fixture:
//
//   axis 1 (dominant) -- rule-silencing = {plan, auto}: a silencing mode beats a non-silencing one.
//   axis 2 (tie-break, same partition) -- breadth rank dontAsk < plan < default < acceptEdits <
//     auto < bypassPermissions; the lower rank wins, ties return `a`.
//   the ONE documented exception: {dontAsk, auto}, either direction, is INCOMPARABLE and throws.
//
// A 7th mode, or any change to either axis, must land here as a deliberate full re-audit of 49
// cells -- which is the point.
const STRICTER_OF_MATRIX: Record<PermissionMode, Record<PermissionMode, PermissionMode | "INCOMPARABLE">> = {
  //          b:      default          acceptEdits        bypassPermissions  plan     dontAsk           auto
  default: { default: "default", acceptEdits: "default", bypassPermissions: "default", plan: "plan", dontAsk: "dontAsk", auto: "auto" },
  acceptEdits: { default: "default", acceptEdits: "acceptEdits", bypassPermissions: "acceptEdits", plan: "plan", dontAsk: "dontAsk", auto: "auto" },
  bypassPermissions: { default: "default", acceptEdits: "acceptEdits", bypassPermissions: "bypassPermissions", plan: "plan", dontAsk: "dontAsk", auto: "auto" },
  plan: { default: "plan", acceptEdits: "plan", bypassPermissions: "plan", plan: "plan", dontAsk: "plan", auto: "plan" },
  dontAsk: { default: "dontAsk", acceptEdits: "dontAsk", bypassPermissions: "dontAsk", plan: "plan", dontAsk: "dontAsk", auto: "INCOMPARABLE" },
  auto: { default: "auto", acceptEdits: "auto", bypassPermissions: "auto", plan: "plan", dontAsk: "INCOMPARABLE", auto: "auto" },
};

describe("RULING P4-D: the full 6x6 stricterOf matrix (fix wave M8)", () => {
  test("every one of the 36 cells matches the hand-written expectation", () => {
    const seen: string[] = [];
    for (const a of ALL_MODES) {
      for (const b of ALL_MODES) {
        const expected = STRICTER_OF_MATRIX[a][b];
        seen.push(`${a}:${b}`);
        if (expected === "INCOMPARABLE") {
          expect(() => stricterOf(a, b), `${a} vs ${b} must be refused`).toThrow(ChildResumeModeIncomparableError);
        } else {
          expect(stricterOf(a, b), `${a} vs ${b}`).toBe(expected);
        }
      }
    }
    expect(seen.length).toBe(36); // a mode added to ALL_MODES without extending the table fails above, loudly
  });

  test("the matrix is SYMMETRIC -- stricterOf(a,b) and stricterOf(b,a) agree on the winner (or both refuse)", () => {
    for (const a of ALL_MODES) {
      for (const b of ALL_MODES) {
        expect(STRICTER_OF_MATRIX[a][b], `${a}/${b} vs ${b}/${a}`).toBe(STRICTER_OF_MATRIX[b][a]);
      }
    }
  });

  test("resolveChildResumeMode agrees with the matrix in every comparable cell (recorded = a, current parent = b)", () => {
    for (const a of ALL_MODES) {
      for (const b of ALL_MODES) {
        const expected = STRICTER_OF_MATRIX[a][b];
        if (expected === "INCOMPARABLE") continue;
        expect(resolveChildResumeMode({ effectiveMode: a, parentPolicyVersion: 1, parentPolicyHash: "h" }, b), `recorded ${a}, parent now ${b}`).toBe(expected);
      }
    }
  });
});
