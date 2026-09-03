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
    session: { setCwd() {}, addBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default" },
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
  test("success: returns exactly {id, subject}", async () => {
    const result = await run("TaskCreate", { subject: "s", description: "d" }, makeCtx(SID));
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output);
    expect(Object.keys(parsed).sort()).toEqual(["id", "subject"]);
    expect(parsed.subject).toBe("s");
    expect(typeof parsed.id).toBe("string");
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
    const created = JSON.parse((await run("TaskCreate", { subject: "s", description: "d", metadata: { a: 1 } }, makeCtx(SID))).output);
    const fetched = JSON.parse((await run("TaskGet", { taskId: created.id }, makeCtx(SID))).output);
    // TaskGet's own pinned shape omits metadata (T8 note) -- prove the create call didn't error,
    // not that metadata round-trips through TaskGet's narrower shape.
    expect(fetched.id).toBe(created.id);
  });
});

describe("TaskGet", () => {
  test("success: returns exactly the 6 pinned fields", async () => {
    const created = JSON.parse((await run("TaskCreate", { subject: "s", description: "d" }, makeCtx(SID))).output);
    const result = await run("TaskGet", { taskId: created.id }, makeCtx(SID));
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output);
    expect(Object.keys(parsed).sort()).toEqual(["blockedBy", "blocks", "description", "id", "status", "subject"]);
    expect(parsed).toEqual({ id: created.id, subject: "s", description: "d", status: "pending", blocks: [], blockedBy: [] });
  });

  test("unknown id: bare 'null' text, NOT an error (a pinned success branch)", async () => {
    const result = await run("TaskGet", { taskId: "no-such-id" }, makeCtx(SID));
    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("null");
  });

  test("rejects a missing taskId", async () => {
    const result = await run("TaskGet", {}, makeCtx(SID));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("taskId");
  });
});

describe("TaskList", () => {
  test("empty session: bare empty array", async () => {
    const result = await run("TaskList", {}, makeCtx(SID));
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.output)).toEqual([]);
  });

  test("compact rows: id/subject/status/blockedBy unconditional, owner only when set", async () => {
    const created = JSON.parse((await run("TaskCreate", { subject: "s", description: "d" }, makeCtx(SID))).output);
    const result = await run("TaskList", {}, makeCtx(SID));
    const rows = JSON.parse(result.output);
    expect(rows).toEqual([{ id: created.id, subject: "s", status: "pending", blockedBy: [] }]);
  });

  test("a deleted task is excluded", async () => {
    const created = JSON.parse((await run("TaskCreate", { subject: "s", description: "d" }, makeCtx(SID))).output);
    await run("TaskUpdate", { taskId: created.id, status: "deleted" }, makeCtx(SID));
    const rows = JSON.parse((await run("TaskList", {}, makeCtx(SID))).output);
    expect(rows).toEqual([]);
  });
});

describe("TaskUpdate", () => {
  test("success mirrors TaskGet's own 6-field shape", async () => {
    const created = JSON.parse((await run("TaskCreate", { subject: "s", description: "d" }, makeCtx(SID))).output);
    const result = await run("TaskUpdate", { taskId: created.id, status: "in_progress" }, makeCtx(SID));
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output);
    expect(Object.keys(parsed).sort()).toEqual(["blockedBy", "blocks", "description", "id", "status", "subject"]);
    expect(parsed.status).toBe("in_progress");
  });

  test("unknown taskId IS an error (unlike TaskGet's null branch)", async () => {
    const result = await run("TaskUpdate", { taskId: "no-such-id", status: "completed" }, makeCtx(SID));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("no such task");
  });

  test("rejects an invalid status enum value", async () => {
    const created = JSON.parse((await run("TaskCreate", { subject: "s", description: "d" }, makeCtx(SID))).output);
    const result = await run("TaskUpdate", { taskId: created.id, status: "bogus" }, makeCtx(SID));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("status");
  });

  test("rejects addBlocks that isn't an array of strings", async () => {
    const created = JSON.parse((await run("TaskCreate", { subject: "s", description: "d" }, makeCtx(SID))).output);
    const result = await run("TaskUpdate", { taskId: created.id, addBlocks: [1, 2] }, makeCtx(SID));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("addBlocks");
  });

  test("end-to-end dependency reflection through the executor layer", async () => {
    const a = JSON.parse((await run("TaskCreate", { subject: "a", description: "d" }, makeCtx(SID))).output);
    const b = JSON.parse((await run("TaskCreate", { subject: "b", description: "d" }, makeCtx(SID))).output);
    await run("TaskUpdate", { taskId: a.id, addBlocks: [b.id] }, makeCtx(SID));
    const bRow = JSON.parse((await run("TaskGet", { taskId: b.id }, makeCtx(SID))).output);
    expect(bRow.blockedBy).toEqual([a.id]);
  });

  test("an unknown reference surfaces a legible error naming the missing id", async () => {
    const a = JSON.parse((await run("TaskCreate", { subject: "a", description: "d" }, makeCtx(SID))).output);
    const result = await run("TaskUpdate", { taskId: a.id, addBlocks: ["ghost"] }, makeCtx(SID));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("ghost");
  });
});

describe("session scoping through the executor layer", () => {
  test("TaskList in a fresh session never sees another session's tasks", async () => {
    await run("TaskCreate", { subject: "s", description: "d" }, makeCtx(SID));
    const otherRows = JSON.parse((await run("TaskList", {}, makeCtx("other-session"))).output);
    expect(otherRows).toEqual([]);
  });
});
