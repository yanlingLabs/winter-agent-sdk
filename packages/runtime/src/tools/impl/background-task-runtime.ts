// Task 3 (Lane C): a lane-owned, in-process registry of RUNNING background processes (Bash
// `run_in_background`, Monitor's command/ws halves). `background-tasks.ts` (T2's spine seam) hands
// out only `{taskId, outputPath}` -- it has no notion of a live process, pid, or status, and
// deliberately so (WS-06 §3.5's own task-id namespace note: it spans Bash/Monitor/Workflow/agent
// tasks generically, none of which the spine itself spawns). TaskOutput/TaskStop are
// unimplementable without SOMETHING tracking "which OS process backs this task id, and is it still
// running" -- this is that something, scoped to the two kinds Lane C's own tools create.
//
// A module-level singleton, same shape and same accepted limitation as background-tasks.ts's own
// "ONE-LIVE-ENGINE ASSUMPTION" (see that file's header): one process, one in-memory table. A future
// multi-session daemon host (WS-15) or a restart-surviving task store (WS-06 §7.3's own
// "`~/.winter/tasks/<uuid>/` owns lifecycle") is out of scope for this phase, exactly as it is for
// background-tasks.ts itself.
// Phase 4 Task 8 (rider 24): widened from `"bash" | "monitor"` to match `background-tasks.ts`'s own
// four-member union exactly. Lane C's report named this as a prerequisite it could not perform: a
// backgrounded Agent spawn allocates a task id through the SPINE seam (createBackgroundTask("agent"))
// but could not be tracked HERE, so TaskStop/TaskOutput -- whose whole implementation is this
// registry -- could never reach a background agent task. The two unions being different widths was
// the mechanical blocker; "workflow" joins for the same reason (P5's own tasks will need it, and a
// union that is a strict subset of the spine's is a trap waiting for the next kind).
export type BackgroundTaskKind = "bash" | "monitor" | "workflow" | "agent";
export type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped";

export interface BackgroundTaskHandle {
  taskId: string;
  kind: BackgroundTaskKind;
  outputPath: string;
  /** Required -- WS-06 §3.5's own task_started frame requires `description`; callers fall back to the command text when the model didn't supply one. */
  description: string;
  command?: string;
  /** The spawned child's pid. Always the process-GROUP leader (spawn.ts's `detached: true`), so killTaskProcessGroup's negative-pid signal reaps the whole group, matching WS-12 §5.2. */
  pid?: number;
  /**
   * A generic stop callback for a task with no OS process to signal -- Monitor's `ws` half is a
   * live socket, not a child process, so it has no pid at all. `stopTask` (below) tries
   * `killTaskProcessGroup` first (bash / Monitor's `command` half) and falls back to this callback
   * (Monitor's `ws` half) so TaskStop has exactly ONE call to make regardless of which kind of
   * background task it is stopping.
   */
  stop?: () => void;
  status: BackgroundTaskStatus;
  startedAt: number;
}

const tasks = new Map<string, BackgroundTaskHandle>();

export interface StartTrackingInput {
  taskId: string;
  kind: BackgroundTaskKind;
  outputPath: string;
  description: string;
  command?: string;
  pid?: number;
  stop?: () => void;
}

export function startTracking(input: StartTrackingInput): BackgroundTaskHandle {
  const handle: BackgroundTaskHandle = { ...input, status: "running", startedAt: Date.now() };
  tasks.set(input.taskId, handle);
  return handle;
}

export function getTask(taskId: string): BackgroundTaskHandle | undefined {
  return tasks.get(taskId);
}

export function setTaskStatus(taskId: string, status: BackgroundTaskStatus): void {
  const t = tasks.get(taskId);
  if (t) t.status = status;
}

export function listTasks(): readonly BackgroundTaskHandle[] {
  return [...tasks.values()];
}

export function listRunningTasks(): readonly BackgroundTaskHandle[] {
  return listTasks().filter((t) => t.status === "running");
}

// WS-12 §5.2's identical process-group kill rule, reused for TaskStop: negative-pid SIGKILL targets
// the whole group (the child was always spawned `detached: true`, making it its own group leader),
// reaping sandbox-exec/bash/any forked grandchildren. Returns false (never throws) when the task is
// unknown or already has no live pid -- TaskStop treats that as "nothing to kill," not an error.
export function killTaskProcessGroup(taskId: string): boolean {
  const t = tasks.get(taskId);
  if (!t || t.pid === undefined) return false;
  try {
    process.kill(-t.pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

// The one call TaskStop actually makes: tries the process-group kill first (bash / Monitor's
// `command` half both have a pid), then falls back to the task's own `stop` callback (Monitor's
// `ws` half). Returns true iff at least one mechanism was attempted without throwing AND the task
// actually had something to stop -- never throws itself.
export function stopTask(taskId: string): boolean {
  const t = tasks.get(taskId);
  if (!t) return false;
  let stopped = false;
  if (t.pid !== undefined) stopped = killTaskProcessGroup(taskId) || stopped;
  if (t.stop) {
    try {
      t.stop();
      stopped = true;
    } catch {
      /* the task's own stop callback misbehaving must never fail TaskStop itself */
    }
  }
  return stopped;
}

// Shared mapper to the SDKBackgroundTasksChangedMessage.tasks[] element shape (frames.ts) --
// co-located with the type it maps rather than duplicated across bash.ts/monitor.ts/task-stop.ts.
export function toBackgroundTasksChangedEntry(t: BackgroundTaskHandle): { task_id: string; task_type: string; description: string } {
  return { task_id: t.taskId, task_type: t.kind, description: t.description };
}

// Test-only escape hatch, same rationale as background-tasks.ts's own resetBackgroundTaskRootForTest:
// this module is a process-wide singleton bun's test runner shares across every file in one `bun
// test` invocation, so every test that mutates it resets in both beforeEach AND afterEach.
export function resetBackgroundTaskRuntimeForTest(): void {
  tasks.clear();
}
