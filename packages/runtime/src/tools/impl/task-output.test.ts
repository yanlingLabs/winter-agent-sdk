import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./task-output.ts";
import { getRegisteredTool } from "../registry.ts";
import type { ToolExecutionContext } from "../registry.ts";
import { createSessionReadState } from "../read-state.ts";
import { startTracking, setTaskStatus, resetBackgroundTaskRuntimeForTest } from "./background-task-runtime.ts";
import { parseTaskOutputInput, resolveClampedTimeout } from "./task-output.ts";
import { CEILING_TIMEOUT_MS } from "./bash.ts";

function fakeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    cwd: "/work",
    home: "/home/test",
    sessionId: "s1",
    readState: createSessionReadState(),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: realpathSync(mkdtempSync(join(tmpdir(), "winter-taskoutput-tempdir-"))),
    sandboxSettings: {},
    session: { setCwd() {}, addBoundedRoot() {}, removeBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default", getSessionRoot: () => "/work", setSessionRoot() {} },
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
    // I5 (fix wave): the fallback now requires a UUID-shaped task_id (the ONLY shape
    // createBackgroundTask ever mints) -- "orphan" (pre-fix fixture id) is deliberately replaced by
    // a real UUID here; the traversal describe block below covers the rejection path.
    const ctx = fakeCtx();
    const orphanId = "11111111-2222-3333-4444-555555555555";
    const tasksDir = join(ctx.tempDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, `${orphanId}.output`), "orphaned content");
    const res = await taskOutput()({ task_id: orphanId, block: false, timeout: 0 }, ctx);
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
    const orphanId = "66666666-7777-8888-9999-aaaaaaaaaaaa";
    const tasksDir = join(ctx.tempDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, `${orphanId}.output`), "orphan content");
    const started = Date.now();
    const res = await taskOutput()({ task_id: orphanId, block: true, timeout: 5000 }, ctx);
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

// I5 (fix wave, P3 close-out): the untracked-task fallback built a filesystem path straight from a
// model-supplied task_id with no shape check -- `join` normalizes `..`, so a crafted task_id could
// read any file outside <tempDir>/tasks/ whose name happens to end in `.output`.
describe("TaskOutput -- I5 traversal guard (untracked-task fallback)", () => {
  test("a traversal-shaped task_id is rejected as unknown, not read", async () => {
    const ctx = fakeCtx();
    // Plant a secret OUTSIDE <tempDir>/tasks/, named so that `../escape.output` (joined against
    // <tempDir>/tasks/) resolves to it.
    const secretPath = join(ctx.tempDir, "escape.output");
    writeFileSync(secretPath, "TOP SECRET");
    const res = await taskOutput()({ task_id: "../escape", block: false, timeout: 0 }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("unknown task_id");
    expect(res.output).not.toContain("TOP SECRET");
  });

  test("an absolute-path-shaped task_id is also rejected (join() would otherwise honor an absolute second segment)", async () => {
    const ctx = fakeCtx();
    const secretDir = mkdtempSync(join(tmpdir(), "winter-taskoutput-secret-"));
    const secretPath = join(secretDir, "passwd.output");
    writeFileSync(secretPath, "root:x:0:0");
    const res = await taskOutput()({ task_id: secretPath.replace(/\.output$/, ""), block: false, timeout: 0 }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("unknown task_id");
    expect(res.output).not.toContain("root:x:0:0");
  });

  test("a non-UUID-shaped (but traversal-free) task_id is also rejected by the fallback -- shape, not just traversal, is enforced", async () => {
    const ctx = fakeCtx();
    const tasksDir = join(ctx.tempDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "not-a-uuid.output"), "should never be reachable via a crafted id");
    const res = await taskOutput()({ task_id: "not-a-uuid", block: false, timeout: 0 }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("unknown task_id");
  });
});

// M8 (fix wave, P3 close-out): block:true previously accepted any finite non-negative timeout with
// no ceiling -- a model-chosen `timeout: 1e12` parked the round for a multi-hour stall. Clamped to
// Bash's own CEILING_TIMEOUT_MS (imported, not a second hand-copied 600000 literal).
describe("resolveClampedTimeout (M7 fix wave)", () => {
  test("a timeout over the ceiling is clamped down to it", () => {
    expect(resolveClampedTimeout(1_000_000_000)).toEqual({ effective: CEILING_TIMEOUT_MS, wasClamped: true });
  });
  test("a timeout at exactly the ceiling is not reported as clamped", () => {
    expect(resolveClampedTimeout(CEILING_TIMEOUT_MS)).toEqual({ effective: CEILING_TIMEOUT_MS, wasClamped: false });
  });
  test("a timeout under the ceiling passes through unchanged", () => {
    expect(resolveClampedTimeout(5000)).toEqual({ effective: 5000, wasClamped: false });
  });
});

describe("TaskOutput -- M8 clamp note on the result (fix wave)", () => {
  test("block:true with an over-ceiling timeout reports the clamp in the result, even when no actual wait was needed (task already terminal)", async () => {
    const ctx = fakeCtx();
    const outputPath = join(ctx.tempDir, "already-done.output");
    writeFileSync(outputPath, "already done");
    startTracking({ taskId: "already-done", kind: "bash", outputPath, description: "d" });
    setTaskStatus("already-done", "completed");
    const res = await taskOutput()({ task_id: "already-done", block: true, timeout: 999_999_999 }, ctx);
    expect(res.output).toContain(`[timeout clamped from 999999999ms to the ${CEILING_TIMEOUT_MS}ms ceiling]`);
  });

  test("a timeout at or under the ceiling is never reported as clamped", async () => {
    const ctx = fakeCtx();
    const outputPath = join(ctx.tempDir, "already-done2.output");
    writeFileSync(outputPath, "already done");
    startTracking({ taskId: "already-done2", kind: "bash", outputPath, description: "d" });
    setTaskStatus("already-done2", "completed");
    const res = await taskOutput()({ task_id: "already-done2", block: true, timeout: CEILING_TIMEOUT_MS }, ctx);
    expect(res.output).not.toContain("clamped");
  });
});
