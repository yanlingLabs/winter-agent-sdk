// Task 3 (Lane C): TaskStop (WS-06 §3.5). `{task_id?, shell_id?}` -- at least one logically
// required. WS-06 §3.5's own "one task-id namespace spans background commands... and MUST
// distinguish 'stop an agent/task' from 'delete a TaskCreate row'": `shell_id` is CC's legacy alias
// for the SAME id space (Winter never grew a separate per-shell id scheme), so this simply prefers
// `task_id`, falling back to `shell_id` as a lookup key against the identical registry -- never a
// second namespace.
import { randomUUID } from "node:crypto";
import "../descriptors/task-stop.ts";
import { replaceExecutor, type ToolExecutor } from "../registry.ts";
import { getTask, updateTask, stopTask, listRunningTasks, toBackgroundTasksChangedEntry, killedTaskSummary, type BackgroundTaskKind } from "./background-task-runtime.ts";
import { renderAgentNotification, renderTaskStopNotification } from "../../subagents/notification-queue.ts";
// Fix round 1 (M4): the internal-kind -> wire-`task_type` mapping. TaskStop is the THIRD producer of
// that pinned field (after task_started and background_tasks_changed) and was missing from the
// inventory the mapping's own header lists.
import { wireTaskType } from "../background-tasks.ts";

interface TaskStopInput {
  task_id?: string;
  shell_id?: string;
}

function parseTaskStopInput(input: unknown): TaskStopInput | { error: string } {
  if (typeof input !== "object" || input === null) return { error: "TaskStop: input must be an object" };
  const obj = input as Record<string, unknown>;
  if (obj.task_id !== undefined && typeof obj.task_id !== "string") {
    return { error: 'TaskStop: "task_id" must be a string' };
  }
  if (obj.shell_id !== undefined && typeof obj.shell_id !== "string") {
    return { error: 'TaskStop: "shell_id" must be a string' };
  }
  if (obj.task_id === undefined && obj.shell_id === undefined) {
    return { error: 'TaskStop: at least one of "task_id"/"shell_id" is required' };
  }
  return {
    ...(obj.task_id !== undefined ? { task_id: obj.task_id as string } : {}),
    ...(obj.shell_id !== undefined ? { shell_id: obj.shell_id as string } : {}),
  };
}

// WS-06 §3.5's own pinned result shape: `{message, task_id, task_type, command?}`, only `message`
// required. ToolResultPayload.output is plain text (T1's own "spine, not the wire format" -- see
// registry.ts's header), so this renders the structured shape as JSON text -- the most faithful
// text encoding of a pinned object result short of a real structured-output wire field.
//
// Fix round 1 (M4): `taskType` is a BackgroundTaskKind and is mapped through `wireTaskType` HERE, at
// the one place this result is built -- both call sites passed `task.kind` verbatim, which put the
// internal `"workflow"` on the PINNED `task_type` field where the pin says `"local_workflow"`
// (derived-shapes item (g) + capture (3)). Taking the kind rather than a pre-mapped string is
// deliberate: a caller cannot forget the mapping if it has no opportunity to.
function formatResult(message: string, taskId: string, taskKind: BackgroundTaskKind, command: string | undefined): string {
  return JSON.stringify({ message, task_id: taskId, task_type: wireTaskType(taskKind), ...(command !== undefined ? { command } : {}) });
}

// Task-frames parity (2026-09-17 contract §4 "Summary wording", pin `CMe`): the kill wording now
// lives in ONE place, `killedTaskSummary` (background-task-runtime.ts), shared with the background
// exit handlers and the engine's teardown sweep -- and, for an agent, with the child's own settle()
// text (review r1 finding 4: a TaskStop and a parent abort must not describe one event two ways).

const taskStopExecutor: ToolExecutor = {
  async execute(input, ctx) {
    const parsed = parseTaskStopInput(input);
    if ("error" in parsed) return { output: `Error: ${parsed.error}`, isError: true };

    const id = parsed.task_id ?? parsed.shell_id!;
    const task = getTask(id);
    if (!task) {
      return { output: `Error: TaskStop: unknown task_id "${id}"`, isError: true };
    }

    if (task.status !== "running") {
      // Already finished (naturally, or via a prior TaskStop) -- an informative, non-error result,
      // matching the "stopping an already-done task just says so" UX rather than erroring.
      return { output: formatResult(`task ${id} is already ${task.status}`, id, task.kind, task.command) };
    }

    // Single source of truth for the terminal status (see background-task-runtime.ts's own header
    // and bash.ts's completion-handler comment on this exact race): setting status BEFORE killing
    // means the process's own natural-completion handler, whenever it eventually runs, sees a
    // non-"running" status and skips emitting its own (redundant, differently-worded) notification.
    // §6: a registry update to {status: "killed" (the patch spelling), end_time} -> task_updated
    // then, synchronously, the once-per-id task_notification {status: "stopped"} -- ONE call through
    // the ONE update door, rather than a status write followed by a hand-built emitFrame literal.
    // Review r1 finding 4: no `usage` here on purpose -- `notifyTerminal` defaults it from the row's
    // own `usage()` accessor, which an agent row carries (agent.ts).
    // SDK 0.0.16 Lane N: the MODEL-facing document names the ACTOR, which only this door knows -- the
    // model called TaskStop, so the actor is the assistant (claude's `killedBy: "parent"`). An AGENT
    // row takes the agent shape (claude's `vP` with a killed status, carrying the child's usage);
    // every other kind takes claude's `gnt`: `Task "<description>" was stopped by <who>`. A FOREGROUND
    // row gets none (the awaiting tool call reports the stop to the model itself).
    const modelNotification =
      task.isBackgrounded === false
        ? null
        : task.kind === "agent"
          ? renderAgentNotification({ taskId: id, ...(task.toolUseId !== undefined ? { toolUseId: task.toolUseId } : {}), description: task.description, status: "stopped", stoppedBy: "parent", outputFile: task.outputPath })
          : renderTaskStopNotification({ taskId: id, ...(task.toolUseId !== undefined ? { toolUseId: task.toolUseId } : {}), description: task.description, stoppedBy: "parent" });
    updateTask(id, { status: "stopped", endTime: Date.now(), notification: { summary: killedTaskSummary(task.kind, task.description), modelNotification } });
    stopTask(id); // process-group kill (WS-12 §5.2) for bash/Monitor-command, or the task's own stop() for Monitor-ws

    // Review r1 finding 11: a FOREGROUND row was never listed (§1), so stopping it does not change the
    // listed set -- `background_tasks_changed` is a level signal and must not fire for a non-change.
    if (task.isBackgrounded !== false) try {
      ctx.emitFrame({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: listRunningTasks().map(toBackgroundTasksChangedEntry),
        uuid: randomUUID(),
        session_id: ctx.sessionId,
      });
    } catch {
      /* a torn-down session's emitFrame may throw; the registry's status is still correct */
    }

    return { output: formatResult(`stopped task ${id}`, id, task.kind, task.command) };
  },
};

replaceExecutor("TaskStop", taskStopExecutor);

export { parseTaskStopInput, taskStopExecutor };
