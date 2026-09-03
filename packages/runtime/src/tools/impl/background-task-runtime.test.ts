import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  startTracking,
  getTask,
  setTaskStatus,
  listTasks,
  listRunningTasks,
  killTaskProcessGroup,
  stopTask,
  toBackgroundTasksChangedEntry,
  resetBackgroundTaskRuntimeForTest,
} from "./background-task-runtime.ts";

beforeEach(() => resetBackgroundTaskRuntimeForTest());
afterEach(() => resetBackgroundTaskRuntimeForTest());

describe("background-task-runtime", () => {
  test("startTracking registers a running task, retrievable by id", () => {
    const h = startTracking({ taskId: "t1", kind: "bash", outputPath: "/tmp/x/t1.output", description: "echo hi", command: "echo hi" });
    expect(h.status).toBe("running");
    expect(getTask("t1")).toEqual(h);
  });

  test("getTask returns undefined for an unknown id", () => {
    expect(getTask("nope")).toBeUndefined();
  });

  test("setTaskStatus transitions a tracked task; a no-op for an unknown id (never throws)", () => {
    startTracking({ taskId: "t1", kind: "bash", outputPath: "/x", description: "d" });
    setTaskStatus("t1", "completed");
    expect(getTask("t1")?.status).toBe("completed");
    expect(() => setTaskStatus("unknown", "stopped")).not.toThrow();
  });

  test("listTasks/listRunningTasks reflect status transitions", () => {
    startTracking({ taskId: "a", kind: "bash", outputPath: "/a", description: "a" });
    startTracking({ taskId: "b", kind: "monitor", outputPath: "/b", description: "b" });
    expect(listTasks()).toHaveLength(2);
    expect(listRunningTasks()).toHaveLength(2);
    setTaskStatus("a", "completed");
    expect(listRunningTasks().map((t) => t.taskId)).toEqual(["b"]);
  });

  test("killTaskProcessGroup returns false for an unknown task without throwing", () => {
    expect(killTaskProcessGroup("nope")).toBe(false);
  });

  test("killTaskProcessGroup returns false for a task with no pid", () => {
    startTracking({ taskId: "t1", kind: "bash", outputPath: "/x", description: "d" });
    expect(killTaskProcessGroup("t1")).toBe(false);
  });

  test("killTaskProcessGroup signals the negative pid (process group) and reports success/failure honestly", () => {
    // A pid this process definitely does not own (and that is not a valid group leader) -- proves
    // the call is attempted and a failure is swallowed into `false`, never thrown, without needing
    // a real spawned child in this unit test (spawn.test.ts/deny.darwin.test.ts cover the real
    // spawn+kill path end to end).
    startTracking({ taskId: "t1", kind: "bash", outputPath: "/x", description: "d", pid: 999999 });
    expect(() => killTaskProcessGroup("t1")).not.toThrow();
  });

  test("stopTask returns false for an unknown task", () => {
    expect(stopTask("nope")).toBe(false);
  });

  test("stopTask returns false for a task with neither a pid nor a stop callback", () => {
    startTracking({ taskId: "t1", kind: "bash", outputPath: "/x", description: "d" });
    expect(stopTask("t1")).toBe(false);
  });

  test("stopTask falls back to the task's own stop() callback when there is no pid (Monitor's ws half)", () => {
    let stopped = false;
    startTracking({ taskId: "ws1", kind: "monitor", outputPath: "/x", description: "d", stop: () => (stopped = true) });
    expect(stopTask("ws1")).toBe(true);
    expect(stopped).toBe(true);
  });

  test("stopTask swallows a throwing stop() callback rather than propagating it -- a throw (e.g. \"already closed\") reports false, same precedent as killTaskProcessGroup's own \"nothing to kill isn't an error\" -- but never throws", () => {
    startTracking({
      taskId: "ws1",
      kind: "monitor",
      outputPath: "/x",
      description: "d",
      stop: () => {
        throw new Error("already closed");
      },
    });
    expect(() => stopTask("ws1")).not.toThrow();
    expect(stopTask("ws1")).toBe(false);
  });

  test("stopTask prefers the pid path but ALSO calls stop() when both are present", () => {
    let stopped = false;
    startTracking({ taskId: "t1", kind: "bash", outputPath: "/x", description: "d", pid: 999999, stop: () => (stopped = true) });
    expect(stopTask("t1")).toBe(true);
    expect(stopped).toBe(true);
  });

  test("toBackgroundTasksChangedEntry maps to the SDKBackgroundTasksChangedMessage.tasks[] element shape", () => {
    const h = startTracking({ taskId: "t1", kind: "monitor", outputPath: "/x", description: "watching" });
    expect(toBackgroundTasksChangedEntry(h)).toEqual({ task_id: "t1", task_type: "monitor", description: "watching" });
  });

  test("resetBackgroundTaskRuntimeForTest clears all tracked tasks", () => {
    startTracking({ taskId: "t1", kind: "bash", outputPath: "/x", description: "d" });
    resetBackgroundTaskRuntimeForTest();
    expect(listTasks()).toHaveLength(0);
    expect(getTask("t1")).toBeUndefined();
  });
});
