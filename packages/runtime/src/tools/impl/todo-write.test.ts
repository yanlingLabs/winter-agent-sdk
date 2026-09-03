// todo-write.ts tests -- Phase 3, Lane D, Task 6. `import "./todo-write.ts"` triggers the module's
// own replaceExecutor("TodoWrite", ...) side effect (registry.test.ts's "Fix round 1" precedent:
// never use "TodoWrite" as a throwaway fixture name elsewhere in this suite).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import "./todo-write.ts";
import { resetTodoStoreForTest } from "./todo-write.ts";
import { getRegisteredTool, type ToolExecutionContext, type ToolResultPayload } from "../registry.ts";
import { createSessionReadState } from "../read-state.ts";

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

async function run(input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  const tool = getRegisteredTool("TodoWrite");
  if (!tool?.executor) throw new Error("TodoWrite executor is not registered");
  return tool.executor.execute(input, ctx);
}

const SID = "todo-test-session";

beforeEach(() => {
  resetTodoStoreForTest();
});
afterEach(() => {
  resetTodoStoreForTest();
});

describe("TodoWrite", () => {
  test("first call on a session: oldTodos is an empty array, newTodos is the input, whole-list", async () => {
    const todos = [{ content: "write tests", status: "pending", activeForm: "Writing tests" }];
    const result = await run({ todos }, makeCtx(SID));
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.output)).toEqual({ oldTodos: [], newTodos: todos });
  });

  test("second call: oldTodos is exactly the prior newTodos, newTodos REPLACES (not merges)", async () => {
    const first = [{ content: "a", status: "pending", activeForm: "Doing a" }];
    await run({ todos: first }, makeCtx(SID));
    const second = [{ content: "b", status: "in_progress", activeForm: "Doing b" }];
    const result = await run({ todos: second }, makeCtx(SID));
    expect(JSON.parse(result.output)).toEqual({ oldTodos: first, newTodos: second });
  });

  test("an empty todos array is valid (clears the list)", async () => {
    await run({ todos: [{ content: "a", status: "pending", activeForm: "Doing a" }] }, makeCtx(SID));
    const result = await run({ todos: [] }, makeCtx(SID));
    const parsed = JSON.parse(result.output);
    expect(parsed.newTodos).toEqual([]);
    expect(parsed.oldTodos.length).toBe(1);
  });

  test("rejects a non-object input", async () => {
    const result = await run("nope", makeCtx(SID));
    expect(result.isError).toBe(true);
  });

  test("rejects a missing todos field", async () => {
    const result = await run({}, makeCtx(SID));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("todos");
  });

  test("rejects a non-array todos field", async () => {
    const result = await run({ todos: "nope" }, makeCtx(SID));
    expect(result.isError).toBe(true);
  });

  test("rejects an item missing content", async () => {
    const result = await run({ todos: [{ status: "pending", activeForm: "x" }] }, makeCtx(SID));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("content");
  });

  test("rejects an item with an invalid status", async () => {
    const result = await run({ todos: [{ content: "c", status: "deleted", activeForm: "x" }] }, makeCtx(SID));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("status");
  });

  test("rejects an item missing activeForm", async () => {
    const result = await run({ todos: [{ content: "c", status: "pending" }] }, makeCtx(SID));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("activeForm");
  });

  test("a validation failure applies NOTHING -- the session's stored list is unchanged", async () => {
    const first = [{ content: "a", status: "pending", activeForm: "Doing a" }];
    await run({ todos: first }, makeCtx(SID));
    await run({ todos: [{ content: "bad" }] }, makeCtx(SID)); // fails validation
    const result = await run({ todos: [] }, makeCtx(SID));
    expect(JSON.parse(result.output).oldTodos).toEqual(first);
  });

  test("session scoping: two sessions never see each other's todos", async () => {
    await run({ todos: [{ content: "a", status: "pending", activeForm: "Doing a" }] }, makeCtx(SID));
    const result = await run({ todos: [] }, makeCtx("other-session"));
    expect(JSON.parse(result.output).oldTodos).toEqual([]);
  });
});
