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
//
// Task-frames parity (contract §2): "monitor" now names ONLY Monitor's command half (wire
// `task_type: "local_bash"` -- it is registered as a plain background shell task, same as Bash).
// "monitor_ws" is a FIFTH, separate kind for Monitor's WebSocket half (wire `task_type:
// "monitor_ws"`, and it never carries `is_backgrounded` at all -- see StartTrackingInput's own
// comment). The pin genuinely treats the two halves as different task shapes; splitting the kind
// (rather than threading a second "half" parameter through every call site) keeps `wireTaskType`
// the one place that decides a wire spelling, with no second axis for a caller to get wrong.
export type BackgroundTaskKind = "bash" | "monitor" | "monitor_ws" | "workflow" | "agent";
// Phase 5 Task 3: the internal-kind -> wire-`task_type` mapping lives in the SPINE module
// (tools/background-tasks.ts), imported rather than re-declared -- two copies of "workflow means
// local_workflow on the wire" is exactly the drift the single mapping exists to prevent.
import { randomUUID } from "node:crypto";
import type {
  BackgroundTaskMessage,
  SDKTaskNotificationMessage,
  SDKTaskUpdatedMessage,
} from "@yanlinglabs/winter-agent-sdk";
import { wireTaskType } from "../background-tasks.ts";
import { enqueueTaskNotification, renderShellNotification } from "../../subagents/notification-queue.ts";
import type { RunCommandResult } from "../../sandbox/spawn.ts";

export type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped";

// Task-frames parity (contract §1): where task_updated/task_notification for a row are sent. Stored
// on the handle at `startTracking` time (rather than threaded as a parameter to every update/remove
// call) so this registry stays the ONE door -- a caller never needs to carry ctx.emitFrame/sessionId
// alongside a taskId just to report a status change. Absent means "nobody wired an emitter" (every
// pre-existing hand-built `startTracking` call in this package's own tests): update/remove still
// mutate the row correctly, they just have nowhere to send a frame, which is a silent no-op here --
// the SAME "never throw over a torn-down/absent sink" posture every existing emitFrame call site in
// this codebase already has.
export interface TaskFrameEmitter {
  emitFrame: (frame: BackgroundTaskMessage) => void;
  sessionId: string;
}

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
  /**
   * Task-frames parity (contract §1/§2): only meaningful for a `local_agent`/`local_bash` row (the
   * two wire kinds the pin's own `register()` puts the flag on at all) -- `undefined` for every other
   * kind (workflow, monitor_ws), which never carry it on `task_started` either. `false` marks a
   * FOREGROUND row: excluded from `listRunningTasks()`'s own `background_tasks_changed` listing
   * (§1's `"isBackgrounded" in task && task.isBackgrounded === false` rule). A foreground BASH row
   * terminates through a caller-built notification + `removeTask` (§3, no task_updated); a
   * foreground AGENT row terminates through `updateTask` exactly like a background one (§4, corrected
   * from a live run of the pin).
   */
  isBackgrounded?: boolean;
  /** The model's own `tool_use` id for the call that created this task, when known -- carried onto this row's own `task_notification`/`task_updated` unless a call overrides it. */
  toolUseId?: string;
  endTime?: number;
  totalPausedMs?: number;
  error?: string;
  emitter?: TaskFrameEmitter;
  /**
   * Review r1 finding 4: the row's LIVE usage counters, when the task kind has any (an agent row --
   * `tools/impl/agent.ts` wires it to the child's own progress snapshot). `notifyTerminal` reads it
   * as the default `task_notification.usage`, so EVERY terminal door for an agent row -- the agent's
   * own result path AND a TaskStop that finalizes the row first -- reports the same usage, instead
   * of the TaskStop door silently dropping it.
   */
  usage?: () => TaskUsage | undefined;
  /**
   * The spawning engine's own agent key (`ToolExecutionContext.agentId`) -- absent for a task the
   * TOP-LEVEL session started. Read only by `stopSessionShellTasks` below (engine teardown), which is
   * what makes a subagent's teardown stop the shells THAT subagent started and nothing else (the
   * pin's own `killShellTasksForAgent` on agent exit).
   */
  ownerAgentId?: string;
  /**
   * Contract §1's `ambient` (a row that runs for the session rather than for a request). NOTHING sets
   * it today -- it exists because the print-mode background WAIT excludes an ambient `monitor_ws` row
   * (claude's own `Mtn`), and a filter written against a field nobody can set would be a filter that
   * silently means nothing the day someone does set it.
   */
  ambient?: boolean;
}

export interface TaskUsage {
  total_tokens: number;
  tool_uses: number;
  duration_ms: number;
}

const tasks = new Map<string, BackgroundTaskHandle>();
// Task-frames parity (contract §1, "Ik"): the once-per-id notification claim. A SEPARATE set from
// `tasks` itself (rather than a field on the handle) so `emitTaskNotification` can guard a bare
// `{taskId, emitter}` pick as well as a live row.
//
// Review r1 finding 12: BOUNDED BY THE REGISTRY. A claim lives exactly as long as its row: every
// caller now notifies BEFORE removing (bash.ts's foreground finish, finding 10), and `removeTask`
// drops the claim together with the row -- once a row is gone nothing in this package can reach its
// id again (TaskStop, TaskOutput and every completion handler look the row up first), so the claim
// has nothing left to guard. Within a row's life the once-per-id guarantee is unchanged.
const notifiedTaskIds = new Set<string>();

export interface StartTrackingInput {
  taskId: string;
  kind: BackgroundTaskKind;
  outputPath: string;
  description: string;
  command?: string;
  pid?: number;
  stop?: () => void;
  isBackgrounded?: boolean;
  toolUseId?: string;
  emitter?: TaskFrameEmitter;
  usage?: () => TaskUsage | undefined;
  ownerAgentId?: string;
  ambient?: boolean;
}

// §1's register(): "emits task_started unless the id is already registered and non-terminal (a
// resume/replacement)". This registry does not itself emit `task_started` (every producer builds
// and emits that frame itself, right after this call -- see bash.ts/agent.ts/monitor.ts/
// workflow.ts), but the MERGE half of that rule is real and load-bearing here: bash.ts and
// monitor.ts both call this TWICE for the same taskId (once before spawning, once from `onSpawned`
// with the real pid) -- a plain overwrite would reset `startedAt`, and silently drop whatever the
// first call already set (`emitter`/`isBackgrounded`/`toolUseId`) if the second call's own input
// happened to omit them. Merging into the existing row when it is still "running" keeps both calls
// idempotent and keeps every field the first call set.
export function startTracking(input: StartTrackingInput): BackgroundTaskHandle {
  const existing = tasks.get(input.taskId);
  if (existing !== undefined && existing.status === "running") {
    Object.assign(existing, input);
    notifiedTaskIds.delete(input.taskId); // "registering also clears the terminal-notification claim"
    return existing;
  }
  // Review r2 finding 10 (whole-branch): a row that has ALREADY reached a terminal status must
  // never be RE-ARMED. bash.ts/monitor.ts's own "register before spawning, merge again from
  // onSpawned with the real pid" pattern (this function's own header) has a real window for a
  // TaskStop to land BETWEEN those two calls -- the pre-spawn call registers a running row with no
  // pid yet; a TaskStop in that window finalizes it (terminal status, the once-per-id notification
  // claimed); the onSpawned call then arrives here with the real pid. The OLD `else` branch below
  // built a FRESH `{...input, status:"running", startedAt: Date.now()}` over that terminal row
  // unconditionally -- a plain `tasks.set()` -- which un-stopped it (a `running` status a caller can
  // observe again) AND cleared its once-per-id notification claim, so the SAME task id could
  // notify a SECOND time once this resurrected copy later reached its own (real) terminal status --
  // exactly the "at most once per task id" guarantee contract §1 pins, broken by this registry
  // rather than by any caller. `existing` is returned COMPLETELY UNTOUCHED here -- no field merge,
  // no `startedAt` reset, no claim cleared -- because a terminal row has already said everything it
  // is ever going to say; a caller that ignores the return value (bash.ts/monitor.ts's own
  // fire-and-forget onSpawned calls, both pre-existing) sees no behavior change beyond the fix
  // itself, and a caller that DOES read it (none today) gets the true, already-terminal state
  // rather than a fabricated "running" one.
  if (existing !== undefined) return existing;
  const handle: BackgroundTaskHandle = { ...input, status: "running", startedAt: Date.now() };
  tasks.set(input.taskId, handle);
  notifiedTaskIds.delete(input.taskId);
  return handle;
}

export function getTask(taskId: string): BackgroundTaskHandle | undefined {
  return tasks.get(taskId);
}

// Review r1 finding 12: `setTaskStatus` (a bare status write that bypassed the §1 diff and the
// terminal notification) is GONE. `updateTask` below is the one status door.

export function listTasks(): readonly BackgroundTaskHandle[] {
  return [...tasks.values()];
}

// Task-frames parity (contract §1/§7): a task is listed iff it is running AND it is not a
// foreground row (`isBackgrounded === false`) -- `undefined`/`true` both still count as listed. This
// is the fix for "a running foreground agent is listed whenever anything else triggers the frame":
// before this, the foreground Agent-tool path tracked its row in this SAME registry (rider 24) with
// no `isBackgrounded` at all, so it was indistinguishable from a genuine background task the moment
// any OTHER call triggered `background_tasks_changed`.
export function listRunningTasks(): readonly BackgroundTaskHandle[] {
  return listTasks().filter((t) => t.status === "running" && t.isBackgrounded !== false);
}

// WS-12 §5.2's process-group kill rule: negative-pid SIGKILL targets the whole group (the child was
// always spawned `detached: true`, making it its own group leader), reaping sandbox-exec/bash/any
// forked grandchildren. Never throws; returns false only when the OS call itself failed (the pid is
// already gone, or was never a real group leader).
function killProcessGroup(pid: number): boolean {
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

// Reused for TaskStop. Returns false (never throws) when the task is unknown or already has no
// live pid -- TaskStop treats that as "nothing to kill," not an error.
export function killTaskProcessGroup(taskId: string): boolean {
  const t = tasks.get(taskId);
  if (!t || t.pid === undefined) return false;
  return killProcessGroup(t.pid);
}

/**
 * Review r2 finding 10 (whole-branch, "the option that keeps callers correct"): the counterpart to
 * `startTracking` never re-arming a terminal row. bash.ts/monitor.ts's own `onSpawned` callback
 * calls `startTracking` a SECOND time once the real OS process exists, to attach its pid to the
 * registry row -- but if a TaskStop landed in the window between the pre-spawn registration and
 * this call (the row is now terminal, and correctly stays that way per finding 10), the row NEVER
 * learns this pid, because `startTracking` returns the terminal row untouched rather than merging
 * it in. Without this function the OS process itself -- which really did just get spawned, is
 * really still running, and really was supposed to die with its already-stopped task -- would leak
 * for the rest of the daemon's process lifetime: nothing else ever learns its pid. `onSpawned`
 * calls this directly (bypassing the registry entirely, since the registry has no pid to act on)
 * exactly when the row it gets back from `startTracking` is not `"running"`.
 */
export function killOrphanedSpawn(pid: number): boolean {
  return killProcessGroup(pid);
}

/**
 * Review r2 finding 9 (whole-branch): main.ts's own SIGTERM/SIGINT handler calls this directly --
 * unlike `stopSessionShellTasks` (the ORDINARY "session going away" door, engine.ts's teardown),
 * this is a raw, synchronous, FRAME-FREE sweep over EVERY row in the process with a live pid,
 * regardless of session or kind (`bash`, `monitor`'s command half, and any future pid-bearing kind
 * alike -- `monitor_ws`'s own socket half has no pid, `agent`/`workflow` rows have no pid either and
 * are the child engine's own responsibility, unaffected by this sweep either way).
 *
 * NO `updateTask`/`emitFrame` call here, deliberately: a signal handler must return fast and must
 * never depend on the event loop still turning normally or on a frame sink that may itself be
 * mid-teardown -- `stopSessionShellTasks`' own `task_updated`/`task_notification` bookkeeping is a
 * normal-exit courtesy, not a safety property. The property this function alone guarantees is
 * process cleanup: no `detached: true` process group this `winter` child process ever spawned
 * survives the process being asked to exit. Never throws; each row is attempted independently so
 * one failure (already exited, ESRCH) never strands the rest of the sweep.
 */
export function killAllTaskProcessGroups(): string[] {
  const killed: string[] = [];
  for (const task of tasks.values()) {
    if (task.status !== "running" || task.pid === undefined) continue;
    if (killProcessGroup(task.pid)) killed.push(task.taskId);
  }
  return killed;
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
  // Phase 5 Task 3: the WIRE spelling, never `t.kind` -- a workflow's internal kind is `"workflow"`
  // and its pinned wire `task_type` is `"local_workflow"` (item (g) + capture (3)). See
  // background-tasks.ts's own wireTaskType for why the mapping is one function rather than a literal
  // at each of the three emission sites.
  return { task_id: t.taskId, task_type: wireTaskType(t.kind), description: t.description };
}

// --- Task-frames parity §1: the update/notify/remove doors ---------------------------------------
//
// "One registry, three doors": register (startTracking, above) / update (updateTask) / remove
// (removeTask). `updateTask` is where the §1 diff table + the once-per-id terminal notification
// live -- every producer (bash.ts, monitor.ts, workflow.ts, task-stop.ts, and agent.ts's background
// path) calls THIS rather than hand-rolling its own `task_updated`/`task_notification` emitFrame
// literals, so the diff rule and the notification claim exist in exactly one place.

const TERMINAL_STATUSES: ReadonlySet<BackgroundTaskStatus> = new Set(["completed", "failed", "stopped"]);

function isTerminal(status: BackgroundTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

// §1's patch status vocabulary is `pending|running|completed|failed|killed|paused` -- Winter's own
// internal terminal-by-stop status is spelled `"stopped"` (bash.ts/monitor.ts/task-stop.ts's own
// established word), and the PATCH spells that same transition `"killed"`; the NOTIFICATION spells
// it `"stopped"` again. Both wire spellings come from this ONE internal value; nothing upstream of
// this function ever needs to know the two wire words differ.
function wirePatchStatus(status: BackgroundTaskStatus): "running" | "completed" | "failed" | "killed" {
  return status === "stopped" ? "killed" : status;
}

export interface TaskNotificationInput {
  summary: string;
  /** Defaults to `task.outputPath`; a foreground task's own caller passes `""` explicitly (§3/§4: "no output file"). */
  outputFile?: string;
  /** Defaults to the row's own `usage()` accessor, when it has one (finding 4). */
  usage?: TaskUsage;
  /** Defaults to `task.toolUseId`. */
  toolUseId?: string;
  skipTranscript?: boolean;
  ambient?: boolean;
  /** Lane N: see `TaskNotificationEmission.modelNotification`. */
  modelNotification?: string | null;
}

export interface TaskUpdateChanges {
  status?: BackgroundTaskStatus;
  description?: string;
  endTime?: number;
  totalPausedMs?: number;
  error?: string;
  isBackgrounded?: boolean;
  /**
   * Consulted ONLY when this call's own status change crosses non-terminal -> terminal; ignored
   * otherwise. §1: "same synchronous call, AFTER the task_updated" -- supplying both the state
   * change and its eventual notification content to ONE call is what makes that true structurally,
   * rather than relying on the caller to remember to follow up with a second call in the right order.
   */
  notification?: TaskNotificationInput;
}

export interface TaskNotificationEmission {
  status: "completed" | "failed" | "stopped";
  outputFile: string;
  summary: string;
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
  toolUseId?: string;
  skipTranscript?: boolean;
  ambient?: boolean;
  /**
   * SDK 0.0.16 Lane N: the MODEL-facing `<task-notification>` document for this same terminal event
   * (`subagents/notification-queue.ts`). Three cases, and the default is the interesting one:
   *
   *  - ABSENT -- derived from the row: a BACKGROUND row gets the shell/monitor document, carrying the
   *    same pinned `summary` the frame carries (claude's `AMe` uses one text on both surfaces), and a
   *    FOREGROUND row (`isBackgrounded === false`) gets NONE, because the model is already being
   *    handed that task's result as its own `tool_result`.
   *  - a STRING -- this exact document (the agent/workflow/TaskStop shapes, whose XML says more than
   *    the frame's summary does: `<result>`, `<usage>`, the actor that stopped it).
   *  - `null` -- explicitly no model notification.
   */
  modelNotification?: string | null;
}

/**
 * §1's `Ik`: `task_notification` is sent at most once per task id, ever -- a second attempt (the
 * process's own natural-exit handler racing a TaskStop that already finalized the row, or a
 * foreground caller notifying after `removeTask`) is a silent no-op. The ONE place every
 * `task_notification` this package emits goes through, whether reached via `updateTask`'s own
 * terminal detection below or a foreground remove-then-notify caller (bash.ts/agent.ts) that has
 * nothing left in the registry to update.
 */
export function emitTaskNotification(task: Pick<BackgroundTaskHandle, "taskId" | "emitter" | "toolUseId"> & Partial<Pick<BackgroundTaskHandle, "kind" | "description" | "isBackgrounded" | "ownerAgentId" | "outputPath">>, notification: TaskNotificationEmission): void {
  if (notifiedTaskIds.has(task.taskId)) return;
  notifiedTaskIds.add(task.taskId);
  if (!task.emitter) return;
  // Defaults from the row itself so every caller (updateTask's own terminal path below, AND a
  // foreground remove-then-notify caller in bash.ts/agent.ts) gets the correlating tool_use id for
  // free when it registered one at startTracking time, without re-threading it through every call.
  const toolUseId = notification.toolUseId ?? task.toolUseId;
  const frame: SDKTaskNotificationMessage = {
    type: "system",
    subtype: "task_notification",
    task_id: task.taskId,
    ...(toolUseId !== undefined ? { tool_use_id: toolUseId } : {}),
    status: notification.status,
    output_file: notification.outputFile,
    summary: notification.summary,
    ...(notification.usage !== undefined ? { usage: notification.usage } : {}),
    ...(notification.skipTranscript !== undefined ? { skip_transcript: notification.skipTranscript } : {}),
    ...(notification.ambient !== undefined ? { ambient: notification.ambient } : {}),
    uuid: randomUUID(),
    session_id: task.emitter.sessionId,
  };
  try {
    task.emitter.emitFrame(frame);
  } catch {
    /* a torn-down session's emitFrame must never fail the caller */
  }
  // Lane N: the SECOND, model-facing channel -- the same once-per-id claim above governs both, so a
  // task id can no more notify the model twice than it can emit two frames. Addressed to the row's
  // OWNING agent (a shell a subagent started notifies that subagent), and enqueued AFTER the frame
  // purely so a producer reading the wire sees the familiar order; the queue is drained later either
  // way.
  // `??` would be WRONG here: `null` is the explicit "no model notification" case, and must not fall
  // through to the derived default.
  const value =
    notification.modelNotification !== undefined
      ? notification.modelNotification
      : task.isBackgrounded === false
        ? null
        : renderShellNotification({ taskId: task.taskId, ...(toolUseId !== undefined ? { toolUseId } : {}), ...(notification.outputFile.length > 0 ? { outputFile: notification.outputFile } : {}), status: notification.status, summary: notification.summary });
  if (value !== null) {
    enqueueTaskNotification({
      sessionId: task.emitter.sessionId,
      value,
      ...(task.ownerAgentId !== undefined ? { agentId: task.ownerAgentId } : {}),
      taskId: task.taskId,
      priority: "next",
    });
  }
}

function notifyTerminal(task: BackgroundTaskHandle, notification: TaskNotificationInput): void {
  // `task.status` is already terminal by the caller's own guard (updateTask, immediately below).
  const status = task.status as "completed" | "failed" | "stopped";
  let usage = notification.usage;
  if (usage === undefined && task.usage !== undefined) {
    try {
      usage = task.usage();
    } catch {
      usage = undefined; // a misbehaving accessor must never cost the notification itself
    }
  }
  emitTaskNotification(task, {
    status,
    outputFile: notification.outputFile ?? task.outputPath,
    summary: notification.summary,
    ...(notification.modelNotification !== undefined ? { modelNotification: notification.modelNotification } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(notification.toolUseId !== undefined ? { toolUseId: notification.toolUseId } : {}),
    ...(notification.skipTranscript !== undefined ? { skipTranscript: notification.skipTranscript } : {}),
    ...(notification.ambient !== undefined ? { ambient: notification.ambient } : {}),
  });
}

/**
 * §1's update(id, fn): applies `changes`, diffs OLD vs NEW on exactly the six pinned fields, and (if
 * the patch is non-empty) emits `task_updated {task_id, patch}` -- then, if this call's own status
 * change crossed non-terminal -> terminal, emits `task_notification` (same synchronous call, AFTER
 * the task_updated), through `emitTaskNotification`'s own once-per-id claim.
 *
 * A field counts as "changed" here by the same rule for all six: `changes.<field> !== undefined`
 * (a caller never means to explicitly unset one of these) AND it differs from the row's current
 * value -- which already satisfies the table's extra "AND new value is defined" clause on
 * `error`/`isBackgrounded` for free, since neither is ever applied from an `undefined` input.
 *
 * Returns `undefined` for an unknown taskId (never throws).
 *
 * Review r1 finding 6: a TERMINAL row is settled. Its `status`, `end_time`, `error` and
 * `is_backgrounded` no longer move -- a late second terminal attempt (a foreground agent's own
 * result path arriving after a TaskStop already finalized the row, a process exit handler racing a
 * kill) used to leave a stray `task_updated {end_time}` on the wire AFTER the notification, and
 * could flip a `stopped` row to `completed`. The first terminal verdict wins, permanently.
 */
export function updateTask(taskId: string, changes: TaskUpdateChanges): BackgroundTaskHandle | undefined {
  const task = tasks.get(taskId);
  if (task === undefined) return undefined;
  const wasTerminal = isTerminal(task.status);

  const patch: SDKTaskUpdatedMessage["patch"] = {};
  if (!wasTerminal && changes.status !== undefined && changes.status !== task.status) {
    task.status = changes.status;
    patch.status = wirePatchStatus(task.status);
  }
  if (changes.description !== undefined && changes.description !== task.description) {
    task.description = changes.description;
    patch.description = task.description;
  }
  if (!wasTerminal && changes.endTime !== undefined && changes.endTime !== task.endTime) {
    task.endTime = changes.endTime;
    patch.end_time = task.endTime;
  }
  if (changes.totalPausedMs !== undefined && changes.totalPausedMs !== task.totalPausedMs) {
    task.totalPausedMs = changes.totalPausedMs;
    patch.total_paused_ms = task.totalPausedMs;
  }
  if (!wasTerminal && changes.error !== undefined && changes.error !== task.error) {
    task.error = changes.error;
    patch.error = task.error;
  }
  if (!wasTerminal && changes.isBackgrounded !== undefined && changes.isBackgrounded !== task.isBackgrounded) {
    task.isBackgrounded = changes.isBackgrounded;
    patch.is_backgrounded = task.isBackgrounded;
  }

  if (Object.keys(patch).length > 0 && task.emitter) {
    const frame: SDKTaskUpdatedMessage = {
      type: "system",
      subtype: "task_updated",
      task_id: taskId,
      patch,
      uuid: randomUUID(),
      session_id: task.emitter.sessionId,
    };
    try {
      task.emitter.emitFrame(frame);
    } catch {
      /* a torn-down session's emitFrame must never fail a status update */
    }
  }

  if (!wasTerminal && isTerminal(task.status) && changes.notification !== undefined) {
    notifyTerminal(task, changes.notification);
  }

  return task;
}

/**
 * §1's remove(id): deletes the row, emitting NO `task_updated`. Used for a foreground BASH command
 * that finishes in the foreground (§3) -- the caller builds and sends the `task_notification` itself,
 * through `emitTaskNotification`, BEFORE calling this (review r1 finding 10: the engine's
 * Notification-hook guard reads the row to tell a foreground notification from a background one, so
 * the row must still exist when the frame is emitted). Removing also drops the id's notification
 * claim (finding 12 -- see `notifiedTaskIds`). Returns `undefined` for an unknown taskId, never throws.
 */
export function removeTask(taskId: string): BackgroundTaskHandle | undefined {
  const task = tasks.get(taskId);
  if (task !== undefined) {
    tasks.delete(taskId);
    notifiedTaskIds.delete(taskId);
  }
  return task;
}

// --- The pinned kill wording (contract §4 "Summary wording", pin `CMe`) -------------------------
//
// ONE place for the "this task was killed" summary, shared by every door that kills a task: TaskStop
// (task-stop.ts), a background command's own exit handler when its process was killed rather than
// exiting (bash.ts/monitor.ts), and the engine's teardown sweep below. Bash and Monitor's command half
// have pinned strings; the other kinds have none on the pin, so they keep one Winter wording each --
// an agent's is the SAME text its own settle() reports (`"stopped by request"`, child-engine.ts), so
// a TaskStop and a parent abort never describe one event two ways (review r1 finding 4).
export const AGENT_STOPPED_SUMMARY = "stopped by request";

export function killedTaskSummary(kind: BackgroundTaskKind, description: string): string {
  if (kind === "bash") return `Background command "${description}" was stopped`;
  if (kind === "monitor") return `Monitor "${description}" stopped`;
  if (kind === "agent") return AGENT_STOPPED_SUMMARY;
  return `${description} (stopped)`;
}

/**
 * Review r1 finding 2: the ONE status derivation for a background shell's natural end (Bash and
 * Monitor's command half share it -- it lives here, not in bash.ts, because an impl module must not
 * import another executor module: impl-isolation.test.ts). `aborted` is a kill THIS runtime issued
 * through the run's own signal -> `stopped` (the kill wording). Exit 0 with no timeout/cap ->
 * `completed`. Everything else -> `failed`, carrying the real exit code only when one exists -- a
 * timeout, an output cap or an outside kill has none, and none is invented.
 */
export function resolveBackgroundOutcome(result: Pick<RunCommandResult, "exitCode" | "timedOut" | "aborted" | "streamKilled">): { status: "completed" | "failed" | "stopped"; exitCode: number | null } {
  if (result.aborted) return { status: "stopped", exitCode: null };
  if (result.timedOut || result.streamKilled) return { status: "failed", exitCode: null };
  if (result.exitCode === 0) return { status: "completed", exitCode: 0 };
  return { status: "failed", exitCode: result.exitCode };
}

/**
 * Review r1 finding 2 (controller ruling): a BACKGROUND shell no longer dies with the turn that
 * started it -- the pin's `ShellCommand.background()` drops its abort listeners, so only its own
 * exit, a TaskStop, or the session going away ends it. This is the "session going away" door: the
 * engine's teardown calls it for its own `sessionId`, and for a subagent engine its own `agentId`
 * (the pin's `killShellTasksForAgent` on agent exit). Each still-running background shell row
 * (`bash`, Monitor's `monitor`/`monitor_ws` halves) the caller owns is finalized through the ONE
 * update door -- `task_updated {killed}` then the kill-worded notification -- and THEN killed, the
 * same order TaskStop uses so the process's own exit handler finds a terminal row and stays silent.
 * Returns the ids it stopped. Never throws.
 */
export function stopSessionShellTasks(owner: { sessionId: string; agentId?: string }): string[] {
  const stopped: string[] = [];
  for (const task of [...tasks.values()]) {
    if (task.status !== "running") continue;
    if (task.kind !== "bash" && task.kind !== "monitor" && task.kind !== "monitor_ws") continue;
    if (task.isBackgrounded === false) continue; // a foreground row belongs to the call awaiting it
    if (task.emitter?.sessionId !== owner.sessionId) continue;
    if (owner.agentId !== undefined && task.ownerAgentId !== owner.agentId) continue;
    try {
      updateTask(task.taskId, { status: "stopped", endTime: Date.now(), notification: { summary: killedTaskSummary(task.kind, task.description) } });
      stopTask(task.taskId);
      stopped.push(task.taskId);
    } catch {
      /* one misbehaving row must never strand the rest of the sweep */
    }
  }
  return stopped;
}

/**
 * SDK 0.0.16 Lane N: every still-running BACKGROUND row of one session (foreground rows excluded, as
 * everywhere else). This is what a closed-input session waits on before it tears down -- the pin's own
 * `sge(appState).filter(kf && …)`. An AMBIENT `monitor_ws` row is excluded: it runs for the session,
 * not for a request, so waiting on it would mean never exiting (claude's `Mtn`).
 */
export function listSessionRunningTasks(owner: { sessionId: string; agentId?: string }): readonly BackgroundTaskHandle[] {
  return listRunningTasks().filter((task) => {
    if (task.emitter?.sessionId !== owner.sessionId) return false;
    if (owner.agentId !== undefined && task.ownerAgentId !== owner.agentId) return false;
    if (task.kind === "monitor_ws" && task.ambient === true) return false;
    return true;
  });
}

/**
 * Lane N: the print-mode WIND-DOWN sweep (claude's `$u`), reached only after the wait ceiling and its
 * grace have both passed. Unlike `stopSessionShellTasks` (the teardown door, shells only) this covers
 * EVERY kind: a shell is killed, and an agent/workflow row is finalized as stopped -- which, through
 * the one update door, both emits its `task_updated`/`task_notification` pair and enqueues the
 * model-facing "was stopped" document the pin sends in exactly this situation. Returns the ids swept.
 */
export function sweepSessionBackgroundTasks(owner: { sessionId: string; agentId?: string }): string[] {
  const swept: string[] = [];
  for (const task of listSessionRunningTasks(owner)) {
    try {
      updateTask(task.taskId, { status: "stopped", endTime: Date.now(), notification: { summary: killedTaskSummary(task.kind, task.description) } });
      stopTask(task.taskId);
      swept.push(task.taskId);
    } catch {
      /* one misbehaving row must never strand the rest of the sweep */
    }
  }
  return swept;
}

// Test-only escape hatch, same rationale as background-tasks.ts's own resetBackgroundTaskRootForTest:
// this module is a process-wide singleton bun's test runner shares across every file in one `bun
// test` invocation, so every test that mutates it resets in both beforeEach AND afterEach.
export function resetBackgroundTaskRuntimeForTest(): void {
  tasks.clear();
  notifiedTaskIds.clear();
}
