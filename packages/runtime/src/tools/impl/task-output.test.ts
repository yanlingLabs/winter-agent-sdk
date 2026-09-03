import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./task-output.ts";
import { getRegisteredTool } from "../registry.ts";
import type { ToolExecutionContext } from "../registry.ts";
import { createSessionReadState } from "../read-state.ts";
import { startTracking, setTaskStatus, resetBackgroundTaskRuntimeForTest } from "./background-task-runtime.ts";
import { parseTaskOutputInput } from "./task-output.ts";

function fakeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    cwd: "/work",
    home: "/home/test",
    sessionId: "s1",
    readState: createSessionReadState(),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: realpathSync(mkdtempSync(join(tmpdir(), "winter-taskoutput-tempdir-"))),
    session: { setCwd() {}, addBoundedRoot() {}, setPermissionMode() {} },
    ...overrides,
  };
}

function taskOutput() {
  const executor = getRegisteredTool("TaskOutput")!.executor!;
  return (input: unknown, ctx: ToolExecutionContext) => executor.execute(input, ctx);
}

beforeEach(() => resetBackgroundTaskRuntimeForTest());
afterEach(() => resetBackgroundTaskRuntimeForTest());

describe("parseTaskOutputInput", () => {
  test("accepts a valid input", () => {
    expect("error" in parseTaskOutputInput({ task_id: "t1", block: false, timeout: 0 })).toBe(false);
  });
  test("rejects a missing task_id", () => {
    expect("error" in parseTaskOutputInput({ block: false, timeout: 0 })).toBe(true);
  });
  test("rejects a missing block", () => {
    expect("error" in parseTaskOutputInput({ task_id: "t1", timeout: 0 })).toBe(true);
  });
  test("rejects a missing or negative timeout", () => {
    expect("error" in parseTaskOutputInput({ task_id: "t1", block: false })).toBe(true);
    expect("error" in parseTaskOutputInput({ task_id: "t1", block: false, timeout: -1 })).toBe(true);
  });
  test("rejects non-object input", () => {
    expect("error" in parseTaskOutputInput(null)).toBe(true);
    expect("error" in parseTaskOutputInput("x")).toBe(true);
  });
});

describe("TaskOutput executor", () => {
  test("an entirely unknown task_id (no registry entry, no file) is a tool error", async () => {
    const ctx = fakeCtx();
    const res = await taskOutput()({ task_id: "never-existed", block: false, timeout: 0 }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("unknown task_id");
  });

  test("reads a tracked task's current output and reports its status", async () => {
    const ctx = fakeCtx();
    const outputPath = join(ctx.tempDir, "t1.output");
    writeFileSync(outputPath, "hello from the task");
    startTracking({ taskId: "t1", kind: "bash", outputPath, description: "d" });
    const res = await taskOutput()({ task_id: "t1", block: false, timeout: 0 }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("hello from the task");
    expect(res.output).toContain("[task status: running]");
    expect(res.output).toContain("deprecated in favor of Read");
  });

  test("falls back to the D18 path under ctx.tempDir/tasks/<id>.output when untracked but the file exists", async () => {
    const ctx = fakeCtx();
    const tasksDir = join(ctx.tempDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "orphan.output"), "orphaned content");
    const res = await taskOutput()({ task_id: "orphan", block: false, timeout: 0 }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("orphaned content");
    expect(res.output).not.toContain("[task status:"); // untracked -- no live status to report
  });

  test("large output is capped inline with a note pointing at the real file", async () => {
    const ctx = fakeCtx();
    const outputPath = join(ctx.tempDir, "big.output");
    writeFileSync(outputPath, "x".repeat(40_000));
    startTracking({ taskId: "big", kind: "bash", outputPath, description: "d" });
    const res = await taskOutput()({ task_id: "big", block: false, timeout: 0 }, ctx);
    expect(res.output).toContain("truncated at 30000 chars");
    expect(res.output).toContain(outputPath);
  });

  test("block: false never waits, even for a still-running task", async () => {
    const ctx = fakeCtx();
    const outputPath = join(ctx.tempDir, "running.output");
    writeFileSync(outputPath, "partial");
    startTracking({ taskId: "running", kind: "bash", outputPath, description: "d" });
    const started = Date.now();
    const res = await taskOutput()({ task_id: "running", block: false, timeout: 5000 }, ctx);
    expect(Date.now() - started).toBeLessThan(200);
    expect(res.output).toContain("partial");
    expect(res.output).toContain("[task status: running]");
  });

  test("block: true returns immediately once the task is already terminal", async () => {
    const ctx = fakeCtx();
    const outputPath = join(ctx.tempDir, "done.output");
    writeFileSync(outputPath, "all done");
    startTracking({ taskId: "done", kind: "bash", outputPath, description: "d" });
    setTaskStatus("done", "completed");
    const started = Date.now();
    const res = await taskOutput()({ task_id: "done", block: true, timeout: 5000 }, ctx);
    expect(Date.now() - started).toBeLessThan(200);
    expect(res.output).toContain("[task status: completed]");
  });

  test("block: true waits for a running task to reach a terminal status, then returns the final content", async () => {
    const ctx = fakeCtx();
    const outputPath = join(ctx.tempDir, "async.output");
    writeFileSync(outputPath, "still going");
    startTracking({ taskId: "async", kind: "bash", outputPath, description: "d" });
    setTimeout(() => {
      writeFileSync(outputPath, "finished!");
      setTaskStatus("async", "completed");
    }, 150);
    const started = Date.now();
    const res = await taskOutput()({ task_id: "async", block: true, timeout: 5000 }, ctx);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(res.output).toContain("finished!");
    expect(res.output).toContain("[task status: completed]");
  });

  test("block: true on an UNTRACKED task returns immediately rather than waiting out the full timeout", async () => {
    const ctx = fakeCtx();
    const tasksDir = join(ctx.tempDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "orphan2.output"), "orphan content");
    const started = Date.now();
    const res = await taskOutput()({ task_id: "orphan2", block: true, timeout: 5000 }, ctx);
    expect(Date.now() - started).toBeLessThan(300);
    expect(res.output).toContain("orphan content");
  });

  test("block: true that times out still returns the current (incomplete) content, not an error", async () => {
    const ctx = fakeCtx();
    const outputPath = join(ctx.tempDir, "slow.output");
    writeFileSync(outputPath, "not done yet");
    startTracking({ taskId: "slow", kind: "bash", outputPath, description: "d" });
    const res = await taskOutput()({ task_id: "slow", block: true, timeout: 150 }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("not done yet");
    expect(res.output).toContain("[task status: running]");
  });
});
