// task-graph-store.ts tests (Phase 3, Lane D, Task 6, Step 1). Every test resets the module's
// process-wide singleton in BOTH beforeEach and afterEach (registry.ts / background-tasks.test.ts
// precedent: bun's test runner shares one module registry across every file in a `bun test`
// invocation, so a leftover session from a differently-ordered earlier file must never leak in, and
// this file must never leak into a later one either).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTask, getTask, listTasks, resetTaskGraphStoreForTest, updateTask, type TaskGraphRow } from "./task-graph-store.ts";

const SID = "session-under-test";

beforeEach(() => {
  resetTaskGraphStoreForTest();
});
afterEach(() => {
  resetTaskGraphStoreForTest();
});

describe("createTask", () => {
  test("returns a fresh row: pending status, empty blocks/blockedBy, generated id", () => {
    const row = createTask(SID, { subject: "s", description: "d" });
    expect(row.subject).toBe("s");
    expect(row.description).toBe("d");
    expect(row.status).toBe("pending");
    expect(row.blocks).toEqual([]);
    expect(row.blockedBy).toEqual([]);
    expect(typeof row.id).toBe("string");
    expect(row.id.length).toBeGreaterThan(0);
  });

  test("activeForm/metadata are carried through when provided, absent otherwise", () => {
    const withExtras = createTask(SID, { subject: "s", description: "d", activeForm: "Doing s", metadata: { k: 1 } });
    expect(withExtras.activeForm).toBe("Doing s");
    expect(withExtras.metadata).toEqual({ k: 1 });

    const withoutExtras = createTask(SID, { subject: "s2", description: "d2" });
    expect(withoutExtras.activeForm).toBeUndefined();
    expect(withoutExtras.metadata).toBeUndefined();
  });

  test("every call produces a fresh, distinct id", () => {
    const a = createTask(SID, { subject: "a", description: "d" });
    const b = createTask(SID, { subject: "b", description: "d" });
    expect(a.id).not.toBe(b.id);
  });
});

describe("getTask", () => {
  test("returns undefined for an unknown id", () => {
    expect(getTask(SID, "no-such-id")).toBeUndefined();
  });

  test("returns the full row for a known id", () => {
    const created = createTask(SID, { subject: "s", description: "d" });
    expect(getTask(SID, created.id)).toEqual(created);
  });
});

describe("listTasks", () => {
  test("returns compact rows (id, subject, status, blockedBy; owner only when set)", () => {
    const t = createTask(SID, { subject: "s", description: "d" });
    const rows = listTasks(SID);
    expect(rows).toEqual([{ id: t.id, subject: "s", status: "pending", blockedBy: [] }]);
    expect(rows[0]).not.toHaveProperty("owner");
  });

  test("owner appears when set via TaskUpdate", () => {
    const t = createTask(SID, { subject: "s", description: "d" });
    updateTask(SID, { taskId: t.id, owner: "agent-1" });
    const rows = listTasks(SID);
    expect(rows[0]?.owner).toBe("agent-1");
  });

  test("insertion order, oldest first", () => {
    const a = createTask(SID, { subject: "a", description: "d" });
    const b = createTask(SID, { subject: "b", description: "d" });
    expect(listTasks(SID).map((r) => r.id)).toEqual([a.id, b.id]);
  });

  test("a deleted task is excluded from listings", () => {
    const t = createTask(SID, { subject: "s", description: "d" });
    updateTask(SID, { taskId: t.id, status: "deleted" });
    expect(listTasks(SID)).toEqual([]);
  });
});

describe("updateTask -- basic fields", () => {
  test("not_found error for an unknown taskId", () => {
    const result = updateTask(SID, { taskId: "nope", subject: "x" });
    expect(result).toEqual({ ok: false, error: { kind: "not_found", taskId: "nope" } });
  });

  test("subject/description/activeForm/status/owner all update in place", () => {
    const t = createTask(SID, { subject: "s", description: "d" });
    const result = updateTask(SID, {
      taskId: t.id,
      subject: "s2",
      description: "d2",
      activeForm: "Doing s2",
      status: "in_progress",
      owner: "agent-1",
    });
    expect(result.ok).toBe(true);
    const row = (result as { ok: true; row: TaskGraphRow }).row;
    expect(row.subject).toBe("s2");
    expect(row.description).toBe("d2");
    expect(row.activeForm).toBe("Doing s2");
    expect(row.status).toBe("in_progress");
    expect(row.owner).toBe("agent-1");
    // The SAME row object is stored -- getTask reflects the mutation.
    expect(getTask(SID, t.id)?.subject).toBe("s2");
  });

  test("an update with no recognized fields besides taskId is a valid no-op", () => {
    const t = createTask(SID, { subject: "s", description: "d" });
    const result = updateTask(SID, { taskId: t.id });
    expect(result).toEqual({ ok: true, row: getTask(SID, t.id)! });
  });

  test("metadata SHALLOW-merges: new keys added, overlapping keys overwritten, untouched keys survive", () => {
    const t = createTask(SID, { subject: "s", description: "d", metadata: { a: 1, b: 2 } });
    updateTask(SID, { taskId: t.id, metadata: { b: 20, c: 3 } });
    expect(getTask(SID, t.id)?.metadata).toEqual({ a: 1, b: 20, c: 3 });
  });

  test("transitioning OUT of deleted (back to pending) is permitted", () => {
    const t = createTask(SID, { subject: "s", description: "d" });
    updateTask(SID, { taskId: t.id, status: "deleted" });
    expect(listTasks(SID)).toEqual([]);
    updateTask(SID, { taskId: t.id, status: "pending" });
    expect(listTasks(SID).map((r) => r.id)).toEqual([t.id]);
  });

  test("deleted task remains reachable via getTask with status: deleted (soft delete, not removal)", () => {
    const t = createTask(SID, { subject: "s", description: "d" });
    updateTask(SID, { taskId: t.id, status: "deleted" });
    expect(getTask(SID, t.id)?.status).toBe("deleted");
    expect(getTask(SID, t.id)?.subject).toBe("s");
  });
});

describe("updateTask -- dependency reflection (addBlocks/addBlockedBy)", () => {
  test("addBlocks reflects on BOTH sides: A.blocks gains X, and X.blockedBy gains A", () => {
    const a = createTask(SID, { subject: "a", description: "d" });
    const x = createTask(SID, { subject: "x", description: "d" });
    const result = updateTask(SID, { taskId: a.id, addBlocks: [x.id] });
    expect(result.ok).toBe(true);
    expect(getTask(SID, a.id)?.blocks).toEqual([x.id]);
    expect(getTask(SID, x.id)?.blockedBy).toEqual([a.id]);
    // The non-mirrored lists stay empty.
    expect(getTask(SID, a.id)?.blockedBy).toEqual([]);
    expect(getTask(SID, x.id)?.blocks).toEqual([]);
  });

  test("addBlockedBy reflects on BOTH sides: A.blockedBy gains Y, and Y.blocks gains A", () => {
    const a = createTask(SID, { subject: "a", description: "d" });
    const y = createTask(SID, { subject: "y", description: "d" });
    const result = updateTask(SID, { taskId: a.id, addBlockedBy: [y.id] });
    expect(result.ok).toBe(true);
    expect(getTask(SID, a.id)?.blockedBy).toEqual([y.id]);
    expect(getTask(SID, y.id)?.blocks).toEqual([a.id]);
  });

  test("union-merge dedupes: re-adding an id already present does not duplicate on either side", () => {
    const a = createTask(SID, { subject: "a", description: "d" });
    const x = createTask(SID, { subject: "x", description: "d" });
    updateTask(SID, { taskId: a.id, addBlocks: [x.id] });
    const result = updateTask(SID, { taskId: a.id, addBlocks: [x.id] });
    expect(result.ok).toBe(true);
    expect(getTask(SID, a.id)?.blocks).toEqual([x.id]);
    expect(getTask(SID, x.id)?.blockedBy).toEqual([a.id]);
  });

  test("union-merge preserves first-seen order across multiple calls", () => {
    const a = createTask(SID, { subject: "a", description: "d" });
    const x = createTask(SID, { subject: "x", description: "d" });
    const y = createTask(SID, { subject: "y", description: "d" });
    updateTask(SID, { taskId: a.id, addBlocks: [x.id] });
    updateTask(SID, { taskId: a.id, addBlocks: [y.id] });
    expect(getTask(SID, a.id)?.blocks).toEqual([x.id, y.id]);
  });

  test("addBlocks and addBlockedBy in the SAME call both apply and both reflect", () => {
    const a = createTask(SID, { subject: "a", description: "d" });
    const x = createTask(SID, { subject: "x", description: "d" });
    const y = createTask(SID, { subject: "y", description: "d" });
    updateTask(SID, { taskId: a.id, addBlocks: [x.id], addBlockedBy: [y.id] });
    expect(getTask(SID, a.id)?.blocks).toEqual([x.id]);
    expect(getTask(SID, a.id)?.blockedBy).toEqual([y.id]);
    expect(getTask(SID, x.id)?.blockedBy).toEqual([a.id]);
    expect(getTask(SID, y.id)?.blocks).toEqual([a.id]);
  });

  test("an unknown reference in addBlocks is rejected and mutates NOTHING (atomic, no partial apply)", () => {
    const a = createTask(SID, { subject: "a", description: "d" });
    const x = createTask(SID, { subject: "x", description: "d" });
    const result = updateTask(SID, { taskId: a.id, addBlocks: [x.id, "ghost-id"], subject: "should-not-apply" });
    expect(result).toEqual({ ok: false, error: { kind: "unknown_reference", taskId: a.id, field: "addBlocks", missing: "ghost-id" } });
    // Neither the valid reference NOR the unrelated subject field was applied.
    expect(getTask(SID, a.id)?.blocks).toEqual([]);
    expect(getTask(SID, a.id)?.subject).toBe("a");
    expect(getTask(SID, x.id)?.blockedBy).toEqual([]);
  });

  test("an unknown reference in addBlockedBy is rejected and mutates nothing", () => {
    const a = createTask(SID, { subject: "a", description: "d" });
    const result = updateTask(SID, { taskId: a.id, addBlockedBy: ["ghost-id"] });
    expect(result).toEqual({ ok: false, error: { kind: "unknown_reference", taskId: a.id, field: "addBlockedBy", missing: "ghost-id" } });
    expect(getTask(SID, a.id)?.blockedBy).toEqual([]);
  });

  test("self-reference in addBlocks is rejected", () => {
    const a = createTask(SID, { subject: "a", description: "d" });
    const result = updateTask(SID, { taskId: a.id, addBlocks: [a.id] });
    expect(result).toEqual({ ok: false, error: { kind: "self_reference", taskId: a.id, field: "addBlocks" } });
    expect(getTask(SID, a.id)?.blocks).toEqual([]);
  });

  test("self-reference in addBlockedBy is rejected", () => {
    const a = createTask(SID, { subject: "a", description: "d" });
    const result = updateTask(SID, { taskId: a.id, addBlockedBy: [a.id] });
    expect(result).toEqual({ ok: false, error: { kind: "self_reference", taskId: a.id, field: "addBlockedBy" } });
  });

  test("blocking against a soft-deleted task is still a valid reference (the row still exists)", () => {
    const a = createTask(SID, { subject: "a", description: "d" });
    const x = createTask(SID, { subject: "x", description: "d" });
    updateTask(SID, { taskId: x.id, status: "deleted" });
    const result = updateTask(SID, { taskId: a.id, addBlocks: [x.id] });
    expect(result.ok).toBe(true);
    expect(getTask(SID, x.id)?.blockedBy).toEqual([a.id]);
  });
});

describe("session scoping", () => {
  test("two sessions never see each other's tasks", () => {
    const other = "other-session";
    const t = createTask(SID, { subject: "s", description: "d" });
    expect(listTasks(other)).toEqual([]);
    expect(getTask(other, t.id)).toBeUndefined();
  });

  test("resetTaskGraphStoreForTest(sessionId) clears only that session", () => {
    const other = "other-session";
    createTask(SID, { subject: "s", description: "d" });
    createTask(other, { subject: "s2", description: "d2" });
    resetTaskGraphStoreForTest(SID);
    expect(listTasks(SID)).toEqual([]);
    expect(listTasks(other).length).toBe(1);
  });

  test("resetTaskGraphStoreForTest() with no args clears every session", () => {
    const other = "other-session";
    createTask(SID, { subject: "s", description: "d" });
    createTask(other, { subject: "s2", description: "d2" });
    resetTaskGraphStoreForTest();
    expect(listTasks(SID)).toEqual([]);
    expect(listTasks(other)).toEqual([]);
  });
});
