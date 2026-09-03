// read-ladder.ts tests (Phase 3, Lane B / task-5). Pure-logic module -- no filesystem, no fixture
// trees needed here (unlike edit.test.ts/write.test.ts/notebook-edit.test.ts, which exercise the
// real executors against mkdtemp'd files). readState is populated DIRECTLY via the SessionReadState
// seam (createSessionReadState + recordRead), never through a Read executor -- lane independence,
// per this task's own brief ("T5 tests populate the T1 seam directly, never via T4's Read executor").
import { describe, test, expect } from "bun:test";
import { createSessionReadState } from "../read-state.ts";
import type { ReadAccessProbe } from "../../permissions/evaluator.ts";
import { evaluateReadLadder, recordPostOperationRead, DEFAULT_READ_LADDER_PROFILE, type ReadLadderDeps, type ReadLadderInput } from "./read-ladder.ts";

function deps(probe: ReadAccessProbe = "silent", state = createSessionReadState()): ReadLadderDeps {
  return { readState: state, probeReadAccess: () => probe };
}

function check(overrides: Partial<ReadLadderInput> = {}): ReadLadderInput {
  return { filePath: "/work/a.txt", currentMtimeMs: 1000, operation: "edit", ...overrides };
}

describe("evaluateReadLadder -- defaults", () => {
  test("DEFAULT_READ_LADDER_PROFILE is 'strict'", () => {
    expect(DEFAULT_READ_LADDER_PROFILE).toBe("strict");
  });

  test("an omitted profile behaves exactly like 'strict'", () => {
    const d = deps("silent");
    const withDefault = evaluateReadLadder(check(), d);
    const withExplicitStrict = evaluateReadLadder(check({ profile: "strict" }), d);
    expect(withDefault).toEqual(withExplicitStrict);
  });
});

describe("evaluateReadLadder -- rung 1 (complete + fresh read)", () => {
  test("a complete read at the current mtime is eligible under strict, for 'edit'", () => {
    const state = createSessionReadState();
    state.recordRead("/work/a.txt", { complete: true, mtimeMs: 1000 });
    const result = evaluateReadLadder(check({ profile: "strict" }), deps("deny", state));
    expect(result).toEqual({ eligible: true });
  });

  test("a complete read at the current mtime is eligible under relaxed, for 'overwrite'", () => {
    const state = createSessionReadState();
    state.recordRead("/work/a.txt", { complete: true, mtimeMs: 1000 });
    const result = evaluateReadLadder(check({ operation: "overwrite", profile: "relaxed" }), deps("deny", state));
    expect(result).toEqual({ eligible: true });
  });

  test("rung 1 does not even consult the probe (a deny probe does not defeat an already-clean read)", () => {
    const state = createSessionReadState();
    state.recordRead("/work/a.txt", { complete: true, mtimeMs: 1000 });
    let probed = false;
    const result = evaluateReadLadder(check(), { readState: state, probeReadAccess: () => ((probed = true), "deny") });
    expect(result).toEqual({ eligible: true });
    expect(probed).toBe(false);
  });

  test("a complete read at the current mtime is eligible even against a notebook path", () => {
    const state = createSessionReadState();
    state.recordRead("/work/nb.ipynb", { complete: true, mtimeMs: 1000 });
    const result = evaluateReadLadder(check({ filePath: "/work/nb.ipynb", operation: "overwrite" }), deps("deny", state));
    expect(result).toEqual({ eligible: true });
  });
});

describe("evaluateReadLadder -- rung 2 (never read, or partially read with no drift)", () => {
  test("strict + never read -> ineligible, reason mentions 'not been read'", () => {
    const result = evaluateReadLadder(check({ profile: "strict" }), deps("silent"));
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toContain("has not been read");
  });

  test("relaxed + never read + probe silent -> eligible", () => {
    const result = evaluateReadLadder(check({ profile: "relaxed" }), deps("silent"));
    expect(result).toEqual({ eligible: true });
  });

  test("relaxed + never read + probe prompt -> ineligible (RULING P3-B: only 'silent' satisfies)", () => {
    const result = evaluateReadLadder(check({ profile: "relaxed" }), deps("prompt"));
    expect(result.eligible).toBe(false);
  });

  test("relaxed + never read + probe deny -> ineligible (RULING P3-B: 'deny' never satisfies)", () => {
    const result = evaluateReadLadder(check({ profile: "relaxed" }), deps("deny"));
    expect(result.eligible).toBe(false);
  });

  test("strict + partially read, unchanged mtime, operation 'edit' -> ineligible", () => {
    const state = createSessionReadState();
    state.recordRead("/work/a.txt", { complete: false, mtimeMs: 1000 });
    const result = evaluateReadLadder(check({ profile: "strict" }), deps("silent", state));
    expect(result.eligible).toBe(false);
  });

  test("relaxed + partially read, unchanged mtime, operation 'edit' + probe silent -> eligible", () => {
    const state = createSessionReadState();
    state.recordRead("/work/a.txt", { complete: false, mtimeMs: 1000 });
    const result = evaluateReadLadder(check({ profile: "relaxed" }), deps("silent", state));
    expect(result).toEqual({ eligible: true });
  });
});

describe("evaluateReadLadder -- the Write-overwrite-only override", () => {
  test("a notebook path, operation 'overwrite', never read -> ineligible under EITHER profile", () => {
    for (const profile of ["strict", "relaxed"] as const) {
      const result = evaluateReadLadder(check({ filePath: "/work/nb.ipynb", operation: "overwrite", profile }), deps("silent"));
      expect(result.eligible).toBe(false);
    }
  });

  test("a notebook path, operation 'edit', never read, relaxed + silent probe -> ELIGIBLE (override does not apply to 'edit')", () => {
    const result = evaluateReadLadder(check({ filePath: "/work/nb.ipynb", operation: "edit", profile: "relaxed" }), deps("silent"));
    expect(result).toEqual({ eligible: true });
  });

  test("a partial record, operation 'overwrite', unchanged mtime -> ineligible under relaxed too (override beats rung 2)", () => {
    const state = createSessionReadState();
    state.recordRead("/work/a.txt", { complete: false, mtimeMs: 1000 });
    const result = evaluateReadLadder(check({ operation: "overwrite", profile: "relaxed" }), deps("silent", state));
    expect(result.eligible).toBe(false);
  });

  test("a partial record, operation 'edit', unchanged mtime, relaxed + silent -> eligible (override does not extend to 'edit')", () => {
    const state = createSessionReadState();
    state.recordRead("/work/a.txt", { complete: false, mtimeMs: 1000 });
    const result = evaluateReadLadder(check({ operation: "edit", profile: "relaxed" }), deps("silent", state));
    expect(result).toEqual({ eligible: true });
  });
});

describe("evaluateReadLadder -- rung 3 (drift rescue, 'edit' only)", () => {
  function driftedState(): ReturnType<typeof createSessionReadState> {
    const state = createSessionReadState();
    state.recordRead("/work/a.txt", { complete: true, mtimeMs: 1000 });
    return state;
  }

  test("drifted + unambiguous match + probe silent -> eligible under strict (profile-independent)", () => {
    const result = evaluateReadLadder(check({ profile: "strict", currentMtimeMs: 2000, hasUnambiguousCurrentMatch: true }), deps("silent", driftedState()));
    expect(result).toEqual({ eligible: true });
  });

  test("drifted + unambiguous match + probe silent -> eligible under relaxed too", () => {
    const result = evaluateReadLadder(check({ profile: "relaxed", currentMtimeMs: 2000, hasUnambiguousCurrentMatch: true }), deps("silent", driftedState()));
    expect(result).toEqual({ eligible: true });
  });

  test("drifted + unambiguous match + probe PROMPT -> ineligible", () => {
    const result = evaluateReadLadder(check({ currentMtimeMs: 2000, hasUnambiguousCurrentMatch: true }), deps("prompt", driftedState()));
    expect(result.eligible).toBe(false);
  });

  test("drifted + unambiguous match + probe DENY -> ineligible", () => {
    const result = evaluateReadLadder(check({ currentMtimeMs: 2000, hasUnambiguousCurrentMatch: true }), deps("deny", driftedState()));
    expect(result.eligible).toBe(false);
  });

  test("drifted + AMBIGUOUS match (flag omitted) + probe silent -> ineligible", () => {
    const result = evaluateReadLadder(check({ currentMtimeMs: 2000 }), deps("silent", driftedState()));
    expect(result.eligible).toBe(false);
  });

  test("drifted + hasUnambiguousCurrentMatch explicitly false + probe silent -> ineligible", () => {
    const result = evaluateReadLadder(check({ currentMtimeMs: 2000, hasUnambiguousCurrentMatch: false }), deps("silent", driftedState()));
    expect(result.eligible).toBe(false);
  });

  test("drifted + operation 'overwrite' is NEVER rescued, even with a (structurally impossible) match flag set", () => {
    const result = evaluateReadLadder(check({ operation: "overwrite", currentMtimeMs: 2000, hasUnambiguousCurrentMatch: true }), deps("silent", driftedState()));
    expect(result.eligible).toBe(false);
  });

  test("drifted + a PARTIAL prior record + operation 'edit' + unambiguous + silent -> still rescuable (override is overwrite-only)", () => {
    const state = createSessionReadState();
    state.recordRead("/work/a.txt", { complete: false, mtimeMs: 1000 });
    const result = evaluateReadLadder(check({ operation: "edit", currentMtimeMs: 2000, hasUnambiguousCurrentMatch: true }), deps("silent", state));
    expect(result).toEqual({ eligible: true });
  });

  test("reason string mentions the drift when the rescue fails", () => {
    const result = evaluateReadLadder(check({ currentMtimeMs: 2000 }), deps("silent", driftedState()));
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toContain("changed on disk");
  });
});

describe("recordPostOperationRead", () => {
  test("'full' always records complete:true, regardless of any prior record", () => {
    const state = createSessionReadState();
    state.recordRead("/work/a.txt", { complete: false, mtimeMs: 1 });
    recordPostOperationRead({ readState: state, probeReadAccess: () => "silent" }, "/work/a.txt", "full", 999);
    expect(state.lookup("/work/a.txt")).toEqual({ complete: true, mtimeMs: 999 });
  });

  test("'full' with no prior record at all still records complete:true", () => {
    const state = createSessionReadState();
    recordPostOperationRead({ readState: state, probeReadAccess: () => "silent" }, "/work/new.txt", "full", 42);
    expect(state.lookup("/work/new.txt")).toEqual({ complete: true, mtimeMs: 42 });
  });

  test("'carryForward' preserves a prior complete:true", () => {
    const state = createSessionReadState();
    state.recordRead("/work/a.txt", { complete: true, mtimeMs: 1 });
    recordPostOperationRead({ readState: state, probeReadAccess: () => "silent" }, "/work/a.txt", "carryForward", 999);
    expect(state.lookup("/work/a.txt")).toEqual({ complete: true, mtimeMs: 999 });
  });

  test("'carryForward' preserves a prior complete:false", () => {
    const state = createSessionReadState();
    state.recordRead("/work/a.txt", { complete: false, mtimeMs: 1 });
    recordPostOperationRead({ readState: state, probeReadAccess: () => "silent" }, "/work/a.txt", "carryForward", 999);
    expect(state.lookup("/work/a.txt")).toEqual({ complete: false, mtimeMs: 999 });
  });

  test("'carryForward' with no prior record records complete:false (an unread-eligible relaxed edit still doesn't know the whole file)", () => {
    const state = createSessionReadState();
    recordPostOperationRead({ readState: state, probeReadAccess: () => "silent" }, "/work/new.txt", "carryForward", 42);
    expect(state.lookup("/work/new.txt")).toEqual({ complete: false, mtimeMs: 42 });
  });
});
