// task-graph.ts (TaskCreate/TaskGet/TaskList/TaskUpdate executors) tests -- Phase 3, Lane D, Task 6.
// `import "./task-graph.ts"` triggers the module's own four replaceExecutor(...) side effects,
// permanently upgrading the shared, process-wide registry singleton for the rest of this `bun test`
// invocation (registry.test.ts's own "Fix round 1" precedent: never use these four real names as a
// throwaway fixture name elsewhere). The STORE's own semantics (reflection, soft delete, atomicity)
// are exhaustively covered in ../task-graph-store.test.ts; this file covers the executor layer's OWN
// job -- unknown-input parsing/validation and wire-shape formatting -- plus enough end-to-end
// coverage to prove the two are wired together correctly.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import "./task-graph.ts";
import { getRegisteredTool, type ToolExecutionContext, type ToolResultPayload } from "../registry.ts";
import { createSessionReadState } from "../read-state.ts";
import { resetTaskGraphStoreForTest } from "../task-graph-store.ts";

function makeCtx(sessionId: string): ToolExecutionContext {
  return {
    cwd: "/work",
    home: "/home/test",
    sessionId,
    readState: createSessionReadState(),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: "/work/.tmp",
    sandboxSettings: {},
    session: { setCwd() {}, addBoundedRoot() {}, removeBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default", getSessionRoot: () => "/work", setSessionRoot() {} },
  };
}

async function run(name: string, input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  const tool = getRegisteredTool(name);
  if (!tool?.executor) throw new Error(`${name} executor is not registered`);
  return tool.executor.execute(input, ctx);
}

const SID = "exec-test-session";

beforeEach(() => {
  resetTaskGraphStoreForTest();
});
afterEach(() => {
  resetTaskGraphStoreForTest();
});

describe("TaskCreate", () => {
  // T8 envelope-reconciliation fix: the pinned TaskCreateOutput wraps under `task` (confirmed via
  // ephemeral capture, derived-shapes-p3-task8.md) -- WS-06's own prose ("-> id/subject") dropped the
  // wrapper key in paraphrase.
  test("success: returns exactly {task: {id, subject}}", async () => {
    const result = await run("TaskCreate", { subject: "s", description: "d" }, makeCtx(SID));
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output);
    expect(Object.keys(parsed).sort()).toEqual(["task"]);
    expect(Object.keys(parsed.task).sort()).toEqual(["id", "subject"]);
    expect(parsed.task.subject).toBe("s");
    expect(typeof parsed.task.id).toBe("string");
  });

  test("rejects a missing subject", async () => {
    const result = await run("TaskCreate", { description: "d" }, makeCtx(SID));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("subject");
  });

  test("rejects a missing description", async () => {
    const result = await run("TaskCreate", { subject: "s" }, makeCtx(SID));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("description");
  });

  test("rejects a non-object input", async () => {
    const result = await run("TaskCreate", "not an object", makeCtx(SID));
    expect(result.isError).toBe(true);
  });

  test("rejects a non-string activeForm", async () => {
    const result = await run("TaskCreate", { subject: "s", description: "d", activeForm: 5 }, makeCtx(SID));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("activeForm");
  });

  test("accepts and stores metadata", async () => {
    const created = JSON.parse((await run("TaskCreate", { subject: "s", description: "d", metadata: { a: 1 } }, makeCtx(SID))).output).task;
    const fetched = JSON.parse((await run("TaskGet", { taskId: created.id }, makeCtx(SID))).output).task;
    // TaskGet's own pinned shape omits metadata (T8 note) -- prove the create call didn't error,
    // not that metadata round-trips through TaskGet's narrower shape.
    expect(fetched.id).toBe(created.id);
  });
});

describe("TaskGet", () => {
  // T8 envelope-reconciliation fix: the pinned TaskGetOutput is `{ task: {...6 fields...} | null }`
  // (confirmed via ephemeral capture, derived-shapes-p3-task8.md) -- both branches wrap under `task`.
  test("success: returns exactly {task: {...6 pinned fields}}", async () => {
    const created = JSON.parse((await run("TaskCreate", { subject: "s", description: "d" }, makeCtx(SID))).output).task;
    const result = await run("TaskGet", { taskId: created.id }, makeCtx(SID));
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output);
    expect(Object.keys(parsed).sort()).toEqual(["task"]);
    expect(Object.keys(parsed.task).sort()).toEqual(["blockedBy", "blocks", "description", "id", "status", "subject"]);
    expect(parsed).toEqual({ task: { id: created.id, subject: "s", description: "d", status: "pending", blocks: [], blockedBy: [] } });
  });

  test("unknown id: {task: null}, NOT an error (a pinned success branch)", async () => {
    const result = await run("TaskGet", { taskId: "no-such-id" }, makeCtx(SID));
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.output)).toEqual({ task: null });
  });

  // T8 advisor-caught gap: getTask() is a bare store lookup -- unlike TaskList's own listTasks(),
  // it does not exclude soft-deleted rows on its own. Without this, TaskGet on a deleted id would
  // surface `status: "deleted"`, a value outside the pinned status union (see item (b) of
  // derived-shapes-p3-task8.md). TaskGet must treat a deleted row exactly like a nonexistent one.
  test("a soft-deleted task is treated as not-found: {task: null}, not its deleted row", async () => {
    const created = JSON.parse((await run("TaskCreate", { subject: "s", description: "d" }, makeCtx(SID))).output).task;
    await run("TaskUpdate", { taskId: created.id, status: "deleted" }, makeCtx(SID));
    const result = await run("TaskGet", { taskId: created.id }, makeCtx(SID));
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.output)).toEqual({ task: null });
  });

  test("rejects a missing taskId", async () => {
    const result = await run("TaskGet", {}, makeCtx(SID));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("taskId");
  });
});

describe("TaskList", () => {
  // T8 envelope-reconciliation fix: the pinned TaskListOutput is `{ tasks: [...] }`, not a bare array
  // (confirmed via ephemeral capture, derived-shapes-p3-task8.md) -- WS-06's own prose ("-> compact
  // rows (...)") dropped the wrapper key in paraphrase, unlike its CronList sibling.
  test("empty session: {tasks: []}", async () => {
    const result = await run("TaskList", {}, makeCtx(SID));
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.output)).toEqual({ tasks: [] });
  });

  test("compact rows: id/subject/status/blockedBy unconditional, owner only when set", async () => {
    const created = JSON.parse((await run("TaskCreate", { subject: "s", description: "d" }, makeCtx(SID))).output).task;
    const result = await run("TaskList", {}, makeCtx(SID));
    const parsed = JSON.parse(result.output);
    expect(parsed).toEqual({ tasks: [{ id: created.id, subject: "s", status: "pending", blockedBy: [] }] });
  });

  // T8 rider (Lane D review, "owner wire-layer round-trip test"): the sibling test above only ever
  // proves owner's ABSENCE (never set, never appears) -- it does not prove owner actually reaches
  // TaskList once genuinely SET via TaskUpdate. Full wire round trip: TaskCreate -> TaskUpdate(owner)
  // -> TaskList shows it, through the real registered executors, not task-graph-store.ts's own
  // internal methods directly.
  test("owner wire round-trip: TaskUpdate(owner) -> TaskList's own compact row carries it", async () => {
    const created = JSON.parse((await run("TaskCreate", { subject: "s", description: "d" }, makeCtx(SID))).output).task;
    const updateResult = await run("TaskUpdate", { taskId: created.id, owner: "agent-2" }, makeCtx(SID));
    expect(updateResult.isError).toBeUndefined();
    const parsed = JSON.parse((await run("TaskList", {}, makeCtx(SID))).output);
    expect(parsed).toEqual({ tasks: [{ id: created.id, subject: "s", status: "pending", blockedBy: [], owner: "agent-2" }] });
  });

  test("a deleted task is excluded", async () => {
    const created = JSON.parse((await run("TaskCreate", { subject: "s", description: "d" }, makeCtx(SID))).output).task;
    await run("TaskUpdate", { taskId: created.id, status: "deleted" }, makeCtx(SID));
    const parsed = JSON.parse((await run("TaskList", {}, makeCtx(SID))).output);
    expect(parsed).toEqual({ tasks: [] });
  });
});

describe("TaskUpdate", () => {
  // T8 envelope-reconciliation fix: TaskUpdate's result shape WAS entirely unpinned in WS-06 §3.4
  // prose; ephemeral capture against the pinned 0.3.250 artifact (derived-shapes-p3-task8.md) found
  // it: `{ success, taskId, updatedFields, error?, statusChange? }` -- superseding task-6's own
  // choice of mirroring TaskGet's 6-field shape. Domain failures (not-found / self-reference /
  // unknown-reference) are now reported via `success:false` at the PAYLOAD level, never isError --
  // only input-shape failures (missing/malformed taskId etc) remain isError:true.
  test("success: {success:true, taskId, updatedFields}, no statusChange when status wasn't touched", async () => {
    const created = JSON.parse((await run("TaskCreate", { subject: "s", description: "d" }, makeCtx(SID))).output).task;
    const result = await run("TaskUpdate", { taskId: created.id, subject: "s2" }, makeCtx(SID));
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output);
    expect(Object.keys(parsed).sort()).toEqual(["success", "taskId", "updatedFields"]);
    expect(parsed).toEqual({ success: true, taskId: created.id, updatedFields: ["subject"] });
  });

  test("statusChange is reported when status actually transitions", async () => {
    const created = JSON.parse((await run("TaskCreate", { subject: "s", description: "d" }, makeCtx(SID))).output).task;
    const result = await run("TaskUpdate", { taskId: created.id, status: "in_progress" }, makeCtx(SID));
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output);
    expect(parsed).toEqual({
      success: true,
      taskId: created.id,
      updatedFields: ["status"],
      statusChange: { from: "pending", to: "in_progress" },
    });
  });

  test("statusChange is OMITTED when status is set to the value it already had", async () => {
    const created = JSON.parse((await run("TaskCreate", { subject: "s", description: "d" }, makeCtx(SID))).output).task;
    const result = await run("TaskUpdate", { taskId: created.id, status: "pending" }, makeCtx(SID));
    const parsed = JSON.parse(result.output);
    expect(parsed).toEqual({ success: true, taskId: created.id, updatedFields: ["status"] });
    expect(parsed).not.toHaveProperty("statusChange");
  });

  test("addBlocks/addBlockedBy report as the row's own field names (blocks/blockedBy) in updatedFields", async () => {
    const a = JSON.parse((await run("TaskCreate", { subject: "a", description: "d" }, makeCtx(SID))).output).task;
    const b = JSON.parse((await run("TaskCreate", { subject: "b", description: "d" }, makeCtx(SID))).output).task;
    const result = await run("TaskUpdate", { taskId: a.id, addBlocks: [b.id] }, makeCtx(SID));
    expect(JSON.parse(result.output).updatedFields).toEqual(["blocks"]);
  });

  test("unknown taskId: non-error, {success:false, taskId, updatedFields:[], error} (unlike TaskGet's null branch, this echoes success:false rather than a bare null)", async () => {
    const result = await run("TaskUpdate", { taskId: "no-such-id", status: "completed" }, makeCtx(SID));
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output);
    expect(parsed.success).toBe(false);
    expect(parsed.taskId).toBe("no-such-id");
    expect(parsed.updatedFields).toEqual([]);
    expect(parsed.error).toContain("no such task");
  });

  test("rejects an invalid status enum value (input-shape failure -- still isError:true)", async () => {
    const created = JSON.parse((await run("TaskCreate", { subject: "s", description: "d" }, makeCtx(SID))).output).task;
    const result = await run("TaskUpdate", { taskId: created.id, status: "bogus" }, makeCtx(SID));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("status");
  });

  test("rejects addBlocks that isn't an array of strings (input-shape failure -- still isError:true)", async () => {
    const created = JSON.parse((await run("TaskCreate", { subject: "s", description: "d" }, makeCtx(SID))).output).task;
    const result = await run("TaskUpdate", { taskId: created.id, addBlocks: [1, 2] }, makeCtx(SID));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("addBlocks");
  });

  test("end-to-end dependency reflection through the executor layer", async () => {
    const a = JSON.parse((await run("TaskCreate", { subject: "a", description: "d" }, makeCtx(SID))).output).task;
    const b = JSON.parse((await run("TaskCreate", { subject: "b", description: "d" }, makeCtx(SID))).output).task;
    await run("TaskUpdate", { taskId: a.id, addBlocks: [b.id] }, makeCtx(SID));
    const bRow = JSON.parse((await run("TaskGet", { taskId: b.id }, makeCtx(SID))).output).task;
    expect(bRow.blockedBy).toEqual([a.id]);
  });

  test("an unknown reference surfaces a non-error {success:false, error} naming the missing id", async () => {
    const a = JSON.parse((await run("TaskCreate", { subject: "a", description: "d" }, makeCtx(SID))).output).task;
    const result = await run("TaskUpdate", { taskId: a.id, addBlocks: ["ghost"] }, makeCtx(SID));
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("ghost");
  });
});

describe("session scoping through the executor layer", () => {
  test("TaskList in a fresh session never sees another session's tasks", async () => {
    await run("TaskCreate", { subject: "s", description: "d" }, makeCtx(SID));
    const otherParsed = JSON.parse((await run("TaskList", {}, makeCtx("other-session"))).output);
    expect(otherParsed).toEqual({ tasks: [] });
  });
});
