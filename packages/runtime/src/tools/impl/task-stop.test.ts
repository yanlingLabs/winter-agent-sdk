import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackgroundTaskMessage } from "@yanlinglabs/winter-agent-sdk";
import "./task-stop.ts";
import { getRegisteredTool } from "../registry.ts";
import type { ToolExecutionContext } from "../registry.ts";
import { createSessionReadState } from "../read-state.ts";
import { startTracking, getTask, resetBackgroundTaskRuntimeForTest, type BackgroundTaskKind } from "./background-task-runtime.ts";
import { parseTaskStopInput } from "./task-stop.ts";

function fakeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    cwd: "/work",
    home: "/home/test",
    sessionId: "s1",
    readState: createSessionReadState({ cwd: process.cwd() }),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: realpathSync(mkdtempSync(join(tmpdir(), "winter-taskstop-tempdir-"))),
    sandboxSettings: {},
    session: { setCwd() {}, addBoundedRoot() {}, removeBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default", getSessionRoot: () => "/work", setSessionRoot() {} },
    ...overrides,
  };
}

function taskStop() {
  const executor = getRegisteredTool("TaskStop")!.executor!;
  return (input: unknown, ctx: ToolExecutionContext) => executor.execute(input, ctx);
}

beforeEach(() => resetBackgroundTaskRuntimeForTest());
afterEach(() => resetBackgroundTaskRuntimeForTest());

describe("parseTaskStopInput", () => {
  test("accepts task_id alone", () => {
    expect("error" in parseTaskStopInput({ task_id: "t1" })).toBe(false);
  });
  test("accepts shell_id alone", () => {
    expect("error" in parseTaskStopInput({ shell_id: "s1" })).toBe(false);
  });
  test("accepts both", () => {
    expect("error" in parseTaskStopInput({ task_id: "t1", shell_id: "s1" })).toBe(false);
  });
  test("rejects neither being present", () => {
    const r = parseTaskStopInput({});
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("at least one");
  });
  test("rejects wrong-typed fields", () => {
    expect("error" in parseTaskStopInput({ task_id: 5 })).toBe(true);
    expect("error" in parseTaskStopInput({ shell_id: 5 })).toBe(true);
  });
  test("rejects non-object input", () => {
    expect("error" in parseTaskStopInput(null)).toBe(true);
  });
});

describe("TaskStop executor", () => {
  test("bad args are a tool error, not a throw", async () => {
    const res = await taskStop()({}, fakeCtx());
    expect(res.isError).toBe(true);
  });

  test("an unknown task_id is a tool error", async () => {
    const res = await taskStop()({ task_id: "never-existed" }, fakeCtx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("unknown task_id");
  });

  // Fix round 1 (M4): TaskStop is the THIRD producer of the pinned `task_type` field and was emitting
  // the INTERNAL kind. `"workflow"` is Winter's ergonomic internal spelling; the pin says
  // `"local_workflow"` (derived-shapes item (g), confirmed on the running engine by capture (3)).
  // Both TaskStop result paths are covered -- the stop path and the already-finished path -- because
  // they are two separate `formatResult` call sites.
  test("M4: a WORKFLOW task reports the WIRE task_type `local_workflow`, never the internal `workflow`", async () => {
    startTracking({ taskId: "wf-1", kind: "workflow", outputPath: "/x/wf-1.output", description: "build" });
    const stopped = await taskStop()({ task_id: "wf-1" }, fakeCtx());
    const parsed = JSON.parse(stopped.output) as { task_type: string };
    expect(parsed.task_type).toBe("local_workflow");
    expect(parsed.task_type).not.toBe("workflow");

    // The already-finished arm is a SECOND formatResult call site with its own argument list.
    const again = await taskStop()({ task_id: "wf-1" }, fakeCtx());
    expect((JSON.parse(again.output) as { task_type: string }).task_type).toBe("local_workflow");
  });

  // Task-frames parity (2026-09-17 contract §2): every kind's wire task_type now follows the pinned
  // `claude` 0.3.250 spelling, not the internal kind name -- `workflow` was already right above;
  // this pins the other four (`monitor_ws` joins as its own kind, contract §2's Monitor-ws-half row).
  test("task-frames parity: task_type follows the pinned wire spelling for every kind, not the internal name", async () => {
    const cases: Array<{ kind: BackgroundTaskKind; expected: string }> = [
      { kind: "bash", expected: "local_bash" },
      { kind: "monitor", expected: "local_bash" },
      { kind: "monitor_ws", expected: "monitor_ws" },
      { kind: "agent", expected: "local_agent" },
    ];
    for (const { kind, expected } of cases) {
      startTracking({ taskId: `k-${kind}`, kind, outputPath: `/x/k-${kind}.output`, description: "d" });
      const result = await taskStop()({ task_id: `k-${kind}` }, fakeCtx());
      expect((JSON.parse(result.output) as { task_type: string }).task_type).toBe(expected);
    }
  });

  test("stops a running task: kills the process group, sets status stopped, emits frames, returns the pinned {message,task_id,task_type,command?} shape", async () => {
    const frames: BackgroundTaskMessage[] = [];
    const ctx = fakeCtx({ emitFrame: (f) => frames.push(f) });
    // Task-frames parity: task_updated/task_notification now go out through the row's OWN stored
    // emitter (background-task-runtime.ts's "one registry, three doors") rather than a literal
    // ctx.emitFrame call inside task-stop.ts itself -- so a test driving TaskStop against a task
    // registered elsewhere must register it WITH an emitter, exactly as every real producer
    // (bash.ts/monitor.ts/workflow.ts/agent.ts) now does at its own startTracking call.
    startTracking({ taskId: "t1", kind: "bash", outputPath: "/x/t1.output", description: "echo hi", command: "echo hi", emitter: { emitFrame: ctx.emitFrame, sessionId: ctx.sessionId } });
    const res = await taskStop()({ task_id: "t1" }, ctx);
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.output);
    expect(parsed.message).toContain("stopped");
    expect(parsed.task_id).toBe("t1");
    expect(parsed.task_type).toBe("local_bash");
    expect(parsed.command).toBe("echo hi");
    expect(getTask("t1")?.status).toBe("stopped");
    expect(frames.some((f) => f.subtype === "task_updated" && "patch" in f && (f.patch as { status?: string }).status === "killed")).toBe(true);
    expect(frames.some((f) => f.subtype === "task_notification" && "status" in f && f.status === "stopped")).toBe(true);
    // M9 (fix wave, lens 4, "frame exists, contents not"): the pre-existing assertion only checked
    // that a background_tasks_changed frame existed at all -- correct today only because status is
    // set BEFORE listRunningTasks() runs, an ordering fact this test never actually pinned. Assert
    // the load-bearing CONTENT: the just-stopped task is genuinely absent from the frame's own list.
    const changed = frames.find((f) => f.subtype === "background_tasks_changed") as { tasks: Array<{ task_id: string }> } | undefined;
    expect(changed).toBeDefined();
    expect(changed!.tasks.map((t) => t.task_id)).not.toContain("t1");
  });

  // Task-frames parity (2026-09-17 contract §4 "Summary wording", pin `CMe`): the pinned "killed"
  // strings for bash and Monitor's command half; a kind with no pinned kill wording (agent) keeps
  // this file's own established generic phrasing.
  test("the pinned kill-notification summary wording, per kind", async () => {
    const bashFrames: BackgroundTaskMessage[] = [];
    const bashCtx = fakeCtx({ emitFrame: (f) => bashFrames.push(f) });
    startTracking({ taskId: "b1", kind: "bash", outputPath: "/x/b1.output", description: "sleep 100", emitter: { emitFrame: bashCtx.emitFrame, sessionId: bashCtx.sessionId } });
    await taskStop()({ task_id: "b1" }, bashCtx);
    expect((bashFrames.find((f) => f.subtype === "task_notification") as { summary: string }).summary).toBe('Background command "sleep 100" was stopped');

    const monitorFrames: BackgroundTaskMessage[] = [];
    const monitorCtx = fakeCtx({ emitFrame: (f) => monitorFrames.push(f) });
    startTracking({ taskId: "m1", kind: "monitor", outputPath: "/x/m1.output", description: "watch logs", emitter: { emitFrame: monitorCtx.emitFrame, sessionId: monitorCtx.sessionId } });
    await taskStop()({ task_id: "m1" }, monitorCtx);
    expect((monitorFrames.find((f) => f.subtype === "task_notification") as { summary: string }).summary).toBe('Monitor "watch logs" stopped');

    const agentFrames: BackgroundTaskMessage[] = [];
    const agentCtx = fakeCtx({ emitFrame: (f) => agentFrames.push(f) });
    startTracking({ taskId: "a1", kind: "agent", outputPath: "/x/a1.output", description: "review the diff", emitter: { emitFrame: agentCtx.emitFrame, sessionId: agentCtx.sessionId } });
    await taskStop()({ task_id: "a1" }, agentCtx);
    // Review r1 finding 4: the SAME text the child's own settle() reports on a parent abort.
    expect((agentFrames.find((f) => f.subtype === "task_notification") as { summary: string }).summary).toBe("stopped by request");
  });

  test("shell_id is an alias for the same task-id namespace, never a second registry", async () => {
    startTracking({ taskId: "shell-1", kind: "bash", outputPath: "/x/shell-1.output", description: "d" });
    const res = await taskStop()({ shell_id: "shell-1" }, fakeCtx());
    expect(res.isError).toBeFalsy();
    expect(getTask("shell-1")?.status).toBe("stopped");
  });

  test("task_id takes precedence when both task_id and shell_id are given", async () => {
    startTracking({ taskId: "real-id", kind: "bash", outputPath: "/x/real-id.output", description: "d" });
    const res = await taskStop()({ task_id: "real-id", shell_id: "irrelevant" }, fakeCtx());
    expect(res.isError).toBeFalsy();
    expect(getTask("real-id")?.status).toBe("stopped");
  });

  test("stopping an already-terminal task is an informative non-error, not a duplicate kill/notification", async () => {
    const frames: BackgroundTaskMessage[] = [];
    const ctx = fakeCtx({ emitFrame: (f) => frames.push(f) });
    startTracking({ taskId: "t1", kind: "bash", outputPath: "/x/t1.output", description: "d" });
    // First stop -- transitions running -> stopped.
    await taskStop()({ task_id: "t1" }, ctx);
    frames.length = 0;
    // Second stop -- already terminal.
    const res = await taskStop()({ task_id: "t1" }, ctx);
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.output);
    expect(parsed.message).toContain("already stopped");
    expect(frames).toHaveLength(0); // no duplicate notification/background_tasks_changed
  });

  test("command is OMITTED from the result when the task has none (e.g. a future non-bash kind)", async () => {
    startTracking({ taskId: "t1", kind: "monitor", outputPath: "/x/t1.output", description: "ws watch" });
    const res = await taskStop()({ task_id: "t1" }, fakeCtx());
    const parsed = JSON.parse(res.output);
    expect("command" in parsed).toBe(false);
  });

  test("a torn-down session's throwing emitFrame does not fail the stop itself", async () => {
    const ctx = fakeCtx({
      emitFrame: () => {
        throw new Error("session gone");
      },
    });
    startTracking({ taskId: "t1", kind: "bash", outputPath: "/x/t1.output", description: "d" });
    const res = await taskStop()({ task_id: "t1" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(getTask("t1")?.status).toBe("stopped");
  });
});
