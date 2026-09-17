import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { BackgroundTaskMessage } from "@yanlinglabs/winter-agent-sdk";
import {
  startTracking,
  getTask,
  updateTask,
  removeTask,
  emitTaskNotification,
  listTasks,
  listRunningTasks,
  killTaskProcessGroup,
  killOrphanedSpawn,
  stopTask,
  stopSessionShellTasks,
  killedTaskSummary,
  toBackgroundTasksChangedEntry,
  resetBackgroundTaskRuntimeForTest,
} from "./background-task-runtime.ts";

function fakeEmitter(): { emitFrame: (f: BackgroundTaskMessage) => void; sessionId: string; frames: BackgroundTaskMessage[] } {
  const frames: BackgroundTaskMessage[] = [];
  return { emitFrame: (f) => frames.push(f), sessionId: "s1", frames };
}

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

  test("updateTask transitions a tracked task; a no-op for an unknown id (never throws) -- the ONE status door (review r1 finding 12: setTaskStatus is gone)", async () => {
    startTracking({ taskId: "t1", kind: "bash", outputPath: "/x", description: "d" });
    updateTask("t1", { status: "completed" });
    expect(getTask("t1")?.status).toBe("completed");
    expect(() => updateTask("unknown", { status: "stopped" })).not.toThrow();
    const mod = await import("./background-task-runtime.ts");
    expect("setTaskStatus" in mod).toBe(false);
  });

  test("listTasks/listRunningTasks reflect status transitions", () => {
    startTracking({ taskId: "a", kind: "bash", outputPath: "/a", description: "a" });
    startTracking({ taskId: "b", kind: "monitor", outputPath: "/b", description: "b" });
    expect(listTasks()).toHaveLength(2);
    expect(listRunningTasks()).toHaveLength(2);
    updateTask("a", { status: "completed" });
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

  // Review r2 finding 10's own companion: killOrphanedSpawn is the bare process-group kill bash.ts/
  // monitor.ts fall back to when startTracking hands back a row that is NOT "running" (the
  // stop-before-onSpawned window) -- it never touches the registry at all, since the registry has
  // no record of a pid that was never merged in.
  test("killOrphanedSpawn signals the negative pid directly, with no registry row required, and never throws", () => {
    expect(killOrphanedSpawn(999999)).toBe(false); // not a real, owned process group -- reports honestly
    expect(() => killOrphanedSpawn(999999)).not.toThrow();
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

  // Task-frames parity (2026-09-17 contract §2): the wire spelling, never the internal kind --
  // Monitor's command half ("monitor") is registered as a plain background shell task on the wire.
  test("toBackgroundTasksChangedEntry maps to the SDKBackgroundTasksChangedMessage.tasks[] element shape", () => {
    const h = startTracking({ taskId: "t1", kind: "monitor", outputPath: "/x", description: "watching" });
    expect(toBackgroundTasksChangedEntry(h)).toEqual({ task_id: "t1", task_type: "local_bash", description: "watching" });
  });

  test("resetBackgroundTaskRuntimeForTest clears all tracked tasks", () => {
    startTracking({ taskId: "t1", kind: "bash", outputPath: "/x", description: "d" });
    resetBackgroundTaskRuntimeForTest();
    expect(listTasks()).toHaveLength(0);
    expect(getTask("t1")).toBeUndefined();
  });

  // ---------------------------------------------------------------------------------------------
  // Task-frames parity (2026-09-17 contract §1): startTracking's own re-register merge.
  // ---------------------------------------------------------------------------------------------
  describe("startTracking: merges into an existing non-terminal row (the pre-spawn -> onSpawned pid update)", () => {
    test("a second call for the same, still-running id merges rather than replacing -- startedAt survives, pid arrives", () => {
      const h1 = startTracking({ taskId: "t1", kind: "bash", outputPath: "/x", description: "d", command: "echo hi" });
      const h2 = startTracking({ taskId: "t1", kind: "bash", outputPath: "/x", description: "d", command: "echo hi", pid: 4242 });
      expect(h2).toBe(h1); // the SAME object, mutated in place
      expect(h2.startedAt).toBe(h1.startedAt);
      expect(h2.pid).toBe(4242);
    });

    test("re-registering a still-running id clears any (impossible here, but structurally checked) prior notification claim", () => {
      const emitter = fakeEmitter();
      startTracking({ taskId: "t1", kind: "bash", outputPath: "/x", description: "d", emitter });
      // No terminal transition has happened yet, so nothing has claimed the id -- re-registering is
      // a plain merge and the row is still tracked, still running.
      startTracking({ taskId: "t1", kind: "bash", outputPath: "/x", description: "d", pid: 1 });
      expect(getTask("t1")?.status).toBe("running");
    });

    // Review r2 finding 10 (whole-branch): REWRITTEN. This test used to prove the opposite of the
    // fix -- that re-registering a TERMINAL id built a fresh, "running" replacement row. See the
    // corrected test in the "updateTask" describe block below for why that was the actual bug: no
    // production caller re-registers a terminal id to mean "a genuinely new task" (there is no
    // "resume/replacement" concept startTracking's own contract ever named) -- every real call
    // site's SECOND `startTracking` call is the SAME in-flight task's onSpawned pid update, and the
    // window where the row has ALREADY gone terminal by the time that second call arrives is a real,
    // if narrow, race with TaskStop -- not a signal to start over.
    test("re-registering a TERMINAL id returns the SAME row, untouched -- never a fresh 'running' replacement", () => {
      startTracking({ taskId: "t1", kind: "bash", outputPath: "/x", description: "d" });
      updateTask("t1", { status: "completed", endTime: 1000 });
      const before = getTask("t1")!;
      const after = startTracking({ taskId: "t1", kind: "bash", outputPath: "/y", description: "d2" });
      expect(after).toBe(before);
      expect(after.status).toBe("completed");
      expect(after.outputPath).toBe("/x"); // the new input's own fields were never merged in
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Task-frames parity (2026-09-17 contract §1): the update/notify/remove doors.
  // ---------------------------------------------------------------------------------------------
  describe("updateTask: diffs the six pinned fields, emits task_updated, then the once-per-id terminal notification", () => {
    test("a status change alone patches {status, end_time} and, crossing into terminal, notifies", () => {
      const emitter = fakeEmitter();
      startTracking({ taskId: "t1", kind: "bash", outputPath: "/x", description: "d", emitter });
      updateTask("t1", { status: "completed", endTime: 1234, notification: { summary: "done" } });

      expect(emitter.frames).toHaveLength(2);
      const updated = emitter.frames[0] as { subtype: string; task_id: string; patch: Record<string, unknown> };
      expect(updated.subtype).toBe("task_updated");
      expect(updated.task_id).toBe("t1");
      expect(updated.patch).toEqual({ status: "completed", end_time: 1234 });

      const notification = emitter.frames[1] as { subtype: string; status: string; summary: string; output_file: string };
      expect(notification.subtype).toBe("task_notification");
      expect(notification.status).toBe("completed");
      expect(notification.summary).toBe("done");
      expect(notification.output_file).toBe("/x"); // defaults to the task's own outputPath
    });

    // §1's patch status vocabulary: Winter's internal "stopped" is "killed" on the PATCH and
    // "stopped" on the NOTIFICATION -- two different wire words from the ONE internal value.
    test("internal status 'stopped' patches as 'killed' but notifies as 'stopped'", () => {
      const emitter = fakeEmitter();
      startTracking({ taskId: "t1", kind: "bash", outputPath: "/x", description: "d", emitter });
      updateTask("t1", { status: "stopped", endTime: 1, notification: { summary: "stopped by request" } });

      const updated = emitter.frames[0] as { patch: { status?: string } };
      expect(updated.patch.status).toBe("killed");
      const notification = emitter.frames[1] as { status: string };
      expect(notification.status).toBe("stopped");
    });

    test("error is patched only when the new value is defined", () => {
      const emitter = fakeEmitter();
      startTracking({ taskId: "t1", kind: "agent", outputPath: "/x", description: "d", emitter });
      updateTask("t1", { status: "failed", endTime: 1, error: "boom", notification: { summary: "boom" } });
      const updated = emitter.frames[0] as { patch: Record<string, unknown> };
      expect(updated.patch).toEqual({ status: "failed", end_time: 1, error: "boom" });
    });

    test("isBackgrounded is patched only when the new value is defined and differs", () => {
      const emitter = fakeEmitter();
      startTracking({ taskId: "t1", kind: "agent", outputPath: "/x", description: "d", isBackgrounded: false, emitter });
      updateTask("t1", { isBackgrounded: true });
      const updated = emitter.frames[0] as { patch: Record<string, unknown> };
      expect(updated.patch).toEqual({ is_backgrounded: true });
    });

    test("an empty diff (no field actually changed) emits nothing", () => {
      const emitter = fakeEmitter();
      startTracking({ taskId: "t1", kind: "bash", outputPath: "/x", description: "d", emitter });
      updateTask("t1", { description: "d" }); // identical value -- not a real change
      expect(emitter.frames).toHaveLength(0);
    });

    test("a second terminal attempt (status already terminal) emits no second notification, and no stray task_updated for an unchanged status", () => {
      const emitter = fakeEmitter();
      startTracking({ taskId: "t1", kind: "bash", outputPath: "/x", description: "d", emitter });
      updateTask("t1", { status: "completed", endTime: 1, notification: { summary: "first" } });
      expect(emitter.frames).toHaveLength(2);
      updateTask("t1", { status: "completed", endTime: 1, notification: { summary: "second" } });
      expect(emitter.frames).toHaveLength(2); // no new frames -- nothing changed, nothing to notify
    });

    test("updateTask on an unknown id returns undefined and never throws", () => {
      expect(updateTask("nope", { status: "completed" })).toBeUndefined();
    });

    test("a row with no emitter still mutates state; frame emission is a silent no-op", () => {
      startTracking({ taskId: "t1", kind: "bash", outputPath: "/x", description: "d" });
      const result = updateTask("t1", { status: "completed", endTime: 1, notification: { summary: "d" } });
      expect(result?.status).toBe("completed");
    });
  });

  describe("emitTaskNotification: the once-per-id claim, shared by updateTask and a foreground remove-then-notify caller", () => {
    test("a second direct call for the same id is a silent no-op even with a fresh emitter", () => {
      const emitter = fakeEmitter();
      emitTaskNotification({ taskId: "t1", emitter }, { status: "completed", outputFile: "", summary: "a" });
      emitTaskNotification({ taskId: "t1", emitter }, { status: "completed", outputFile: "", summary: "b" });
      expect(emitter.frames).toHaveLength(1);
      expect((emitter.frames[0] as { summary: string }).summary).toBe("a");
    });

    test("a background natural-exit handler racing a TaskStop that already removed+notified the SAME row never gets a second attempt through to the wire, because it never sees status:'running' at all", () => {
      // The real shape this guards: bash.ts's own completion.then() checks `getTask(taskId)?.status
      // !== "running"` and returns WITHOUT calling updateTask at all once a status is already
      // terminal -- so the claim set is a second, structural line of defense (§1's own "Ik"), not the
      // only one. This proves the claim itself holds even if a caller skipped that guard.
      const emitter = fakeEmitter();
      startTracking({ taskId: "t1", kind: "bash", outputPath: "/x", description: "d", emitter });
      updateTask("t1", { status: "stopped", endTime: 1, notification: { summary: "stopped by TaskStop" } }); // TaskStop's own door
      expect(emitter.frames.filter((f) => (f as { subtype: string }).subtype === "task_notification")).toHaveLength(1);
      // The natural-exit handler runs anyway (it did not check status first) and tries its own
      // terminal update -- the row is already terminal, so NOTHING moves (review r1 finding 6): no
      // second notification, no stray task_updated, and the first verdict ("stopped") stands.
      const before = emitter.frames.length;
      updateTask("t1", { status: "completed", endTime: 2, notification: { summary: "completed naturally" } });
      expect(emitter.frames).toHaveLength(before);
      expect(getTask("t1")?.status).toBe("stopped");
      expect(getTask("t1")?.endTime).toBe(1);
    });

    // Review r2 finding 10 (whole-branch): REWRITTEN. `startTracking` over a TERMINAL row used to
    // re-arm it (a fresh `{...input, status:"running", startedAt: Date.now()}`, the once-per-id
    // notification claim cleared) as if it were "a genuinely new registration" -- but every real
    // production call site (bash.ts/monitor.ts's own pre-spawn-then-onSpawned pattern) calls
    // `startTracking` a SECOND time for the SAME still-in-flight task, not to start a new one. If a
    // TaskStop lands in the window between those two calls (finalizing the row BEFORE the real pid
    // even arrives), the old behavior resurrected a STOPPED task back to "running" and let it notify
    // a SECOND time once it later reached ITS OWN terminal status -- exactly the "at most once per
    // task id" contract §1 pins, broken here rather than by any caller. `startTracking` now returns
    // the terminal row UNTOUCHED: no re-arm, no claim reset, so no second notification is possible.
    test("§1 (CORRECTED by review r2 finding 10): startTracking over a TERMINAL row never re-arms it -- the existing terminal handle comes back untouched, and no second notification is ever possible", () => {
      const emitter = fakeEmitter();
      startTracking({ taskId: "t1", kind: "bash", outputPath: "/x", description: "d", emitter });
      updateTask("t1", { status: "completed", endTime: 1, notification: { summary: "first run" } });
      expect(emitter.frames.filter((f) => (f as { subtype: string }).subtype === "task_notification")).toHaveLength(1);

      // The "stop landed before onSpawned's real pid arrived" window: a second startTracking call
      // for the SAME id, now terminal, carrying a pid the first call never had.
      const reArmed = startTracking({ taskId: "t1", kind: "bash", outputPath: "/x", description: "d", emitter, pid: 4242 });
      expect(reArmed.status).toBe("completed"); // still terminal -- never flipped back to "running"
      expect(reArmed.startedAt).toBe(getTask("t1")!.startedAt); // untouched, not reset to Date.now()
      expect(reArmed).toBe(getTask("t1")!); // the SAME object -- no fresh handle was built at all
      expect(reArmed.pid).toBeUndefined(); // the input was never merged in either

      // updateTask already refuses a further transition on a terminal row (review r1 finding 6) --
      // together the two fixes make a second notification for this id structurally unreachable.
      updateTask("t1", { status: "completed", endTime: 2, notification: { summary: "second run" } });
      expect(emitter.frames.filter((f) => (f as { subtype: string }).subtype === "task_notification")).toHaveLength(1);
    });

    test("defaults tool_use_id from the task itself when the call does not supply one", () => {
      const emitter = fakeEmitter();
      startTracking({ taskId: "t1", kind: "agent", outputPath: "/x", description: "d", toolUseId: "call-1", emitter });
      emitTaskNotification(getTask("t1")!, { status: "completed", outputFile: "", summary: "d" });
      expect((emitter.frames[0] as { tool_use_id?: string }).tool_use_id).toBe("call-1");
    });
  });

  describe("review r1 finding 6: a terminal row is settled", () => {
    test("a late endTime/error/isBackgrounded change on a terminal row emits NO task_updated (the foreground-agent-after-TaskStop stray frame)", () => {
      const emitter = fakeEmitter();
      startTracking({ taskId: "t1", kind: "agent", outputPath: "/x", description: "d", isBackgrounded: false, emitter });
      updateTask("t1", { status: "stopped", endTime: 10, notification: { summary: "stopped by request" } });
      expect(emitter.frames).toHaveLength(2);
      updateTask("t1", { status: "failed", endTime: 20, error: "late", isBackgrounded: true, notification: { summary: "late" } });
      expect(emitter.frames).toHaveLength(2);
      expect(getTask("t1")).toMatchObject({ status: "stopped", endTime: 10, isBackgrounded: false });
      expect(getTask("t1")?.error).toBeUndefined();
    });
  });

  describe("review r1 finding 4: a row's own usage accessor is the notification's default usage", () => {
    test("notifyTerminal reads usage() when the caller supplies none (the TaskStop door)", () => {
      const emitter = fakeEmitter();
      startTracking({ taskId: "t1", kind: "agent", outputPath: "/x", description: "d", emitter, usage: () => ({ total_tokens: 7, tool_uses: 2, duration_ms: 5 }) });
      updateTask("t1", { status: "stopped", endTime: 1, notification: { summary: "stopped by request" } });
      expect((emitter.frames[1] as { usage?: unknown }).usage).toEqual({ total_tokens: 7, tool_uses: 2, duration_ms: 5 });
    });

    test("an explicit usage wins over the accessor; a throwing accessor costs only the usage field", () => {
      const emitter = fakeEmitter();
      startTracking({ taskId: "a", kind: "agent", outputPath: "/x", description: "d", emitter, usage: () => ({ total_tokens: 1, tool_uses: 1, duration_ms: 1 }) });
      updateTask("a", { status: "completed", endTime: 1, notification: { summary: "ok", usage: { total_tokens: 9, tool_uses: 9, duration_ms: 9 } } });
      expect((emitter.frames[1] as { usage?: { total_tokens: number } }).usage?.total_tokens).toBe(9);
      startTracking({
        taskId: "b",
        kind: "agent",
        outputPath: "/x",
        description: "d",
        emitter,
        usage: () => {
          throw new Error("boom");
        },
      });
      updateTask("b", { status: "completed", endTime: 1, notification: { summary: "ok" } });
      const notification = emitter.frames[3] as { subtype: string; usage?: unknown };
      expect(notification.subtype).toBe("task_notification");
      expect(notification.usage).toBeUndefined();
    });
  });

  describe("killedTaskSummary: the one kill wording, per kind", () => {
    test("bash and monitor use the pinned strings; agent uses the SAME text its own settle() reports", () => {
      expect(killedTaskSummary("bash", "sleep")).toBe('Background command "sleep" was stopped');
      expect(killedTaskSummary("monitor", "watch")).toBe('Monitor "watch" stopped');
      expect(killedTaskSummary("agent", "child")).toBe("stopped by request");
    });
  });

  describe("stopSessionShellTasks: the teardown door (review r1 finding 2)", () => {
    test("stops only the owner's running BACKGROUND shell rows, through the update door, kill-worded", () => {
      const s1 = fakeEmitter();
      const s2 = { ...fakeEmitter(), sessionId: "s2" };
      let stoppedWs = 0;
      startTracking({ taskId: "bg", kind: "bash", outputPath: "/x", description: "sleep", isBackgrounded: true, emitter: s1 });
      startTracking({ taskId: "ws", kind: "monitor_ws", outputPath: "/x", description: "ws", emitter: s1, stop: () => void stoppedWs++ });
      startTracking({ taskId: "child-bg", kind: "bash", outputPath: "/x", description: "child", isBackgrounded: true, emitter: s1, ownerAgentId: "agent-1" });
      startTracking({ taskId: "fg", kind: "bash", outputPath: "", description: "fg", isBackgrounded: false, emitter: s1 });
      startTracking({ taskId: "agent", kind: "agent", outputPath: "/x", description: "a", isBackgrounded: true, emitter: s1 });
      startTracking({ taskId: "other", kind: "bash", outputPath: "/x", description: "o", isBackgrounded: true, emitter: s2 });

      // A subagent's teardown stops only ITS OWN shells.
      expect(stopSessionShellTasks({ sessionId: "s1", agentId: "agent-1" })).toEqual(["child-bg"]);
      expect(getTask("bg")?.status).toBe("running");

      // The top-level teardown stops every remaining background shell of its session.
      expect(stopSessionShellTasks({ sessionId: "s1" }).sort()).toEqual(["bg", "ws"]);
      expect(stoppedWs).toBe(1);
      expect(getTask("fg")?.status).toBe("running");
      expect(getTask("agent")?.status).toBe("running");
      expect(getTask("other")?.status).toBe("running");

      const bgFrames = s1.frames.filter((f) => (f as { task_id?: string }).task_id === "bg");
      expect(bgFrames.map((f) => (f as { subtype: string }).subtype)).toEqual(["task_updated", "task_notification"]);
      expect((bgFrames[0] as { patch: { status?: string } }).patch.status).toBe("killed");
      expect(bgFrames[1]).toMatchObject({ status: "stopped", summary: 'Background command "sleep" was stopped' });
    });
  });

  describe("removeTask: deletes the row, emits nothing itself (§3/§4's foreground finish)", () => {
    test("review r1 finding 12: removing a notified row drops its claim too -- the claim set is bounded by the registry", () => {
      const emitter = fakeEmitter();
      startTracking({ taskId: "t1", kind: "bash", outputPath: "", description: "d", isBackgrounded: false, emitter });
      emitTaskNotification(getTask("t1")!, { status: "completed", outputFile: "", summary: "d" });
      // Within the row's life the claim holds.
      emitTaskNotification(getTask("t1")!, { status: "completed", outputFile: "", summary: "again" });
      expect(emitter.frames).toHaveLength(1);
      removeTask("t1");
      // A later, unrelated registration under the same id is a fresh task with its own claim.
      startTracking({ taskId: "t1", kind: "bash", outputPath: "", description: "d2", isBackgrounded: false, emitter });
      emitTaskNotification(getTask("t1")!, { status: "completed", outputFile: "", summary: "d2" });
      expect(emitter.frames).toHaveLength(2);
    });

    test("returns the removed handle and the id is no longer tracked", () => {
      startTracking({ taskId: "t1", kind: "bash", outputPath: "/x", description: "d" });
      const removed = removeTask("t1");
      expect(removed?.taskId).toBe("t1");
      expect(getTask("t1")).toBeUndefined();
    });

    test("returns undefined for an unknown id, never throws", () => {
      expect(removeTask("nope")).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Task-frames parity (2026-09-17 contract §1/§7): background_tasks_changed excludes foreground rows.
  // ---------------------------------------------------------------------------------------------
  describe("listRunningTasks excludes a foreground (isBackgrounded:false) row", () => {
    test("a running foreground row is not listed; the identical row with isBackgrounded:true (or unset) is", () => {
      startTracking({ taskId: "fg", kind: "agent", outputPath: "/x", description: "fg", isBackgrounded: false });
      startTracking({ taskId: "bg", kind: "agent", outputPath: "/x", description: "bg", isBackgrounded: true });
      startTracking({ taskId: "unset", kind: "bash", outputPath: "/x", description: "unset" });
      expect(listRunningTasks().map((t) => t.taskId).sort()).toEqual(["bg", "unset"]);
    });

    test("a foreground row that finishes never appears even once another task triggers the frame", () => {
      startTracking({ taskId: "fg", kind: "agent", outputPath: "/x", description: "fg", isBackgrounded: false });
      startTracking({ taskId: "bg", kind: "bash", outputPath: "/x", description: "bg", isBackgrounded: true });
      const entries = listRunningTasks().map(toBackgroundTasksChangedEntry);
      expect(entries.map((e) => e.task_id)).toEqual(["bg"]);
    });
  });
});
