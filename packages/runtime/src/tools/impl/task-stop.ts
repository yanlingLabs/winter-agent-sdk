// Task 3 (Lane C): TaskStop (WS-06 §3.5). `{task_id?, shell_id?}` -- at least one logically
// required. WS-06 §3.5's own "one task-id namespace spans background commands... and MUST
// distinguish 'stop an agent/task' from 'delete a TaskCreate row'": `shell_id` is CC's legacy alias
// for the SAME id space (Winter never grew a separate per-shell id scheme), so this simply prefers
// `task_id`, falling back to `shell_id` as a lookup key against the identical registry -- never a
// second namespace.
import { randomUUID } from "node:crypto";
import "../descriptors/task-stop.ts";
import { replaceExecutor, type ToolExecutor } from "../registry.ts";
import { getTask, setTaskStatus, stopTask, listRunningTasks, toBackgroundTasksChangedEntry } from "./background-task-runtime.ts";

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
function formatResult(message: string, taskId: string, taskType: string, command: string | undefined): string {
  return JSON.stringify({ message, task_id: taskId, task_type: taskType, ...(command !== undefined ? { command } : {}) });
}

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
    setTaskStatus(id, "stopped");
    stopTask(id); // process-group kill (WS-12 §5.2) for bash/Monitor-command, or the task's own stop() for Monitor-ws

    try {
      ctx.emitFrame({
        type: "system",
        subtype: "task_notification",
        task_id: id,
        status: "stopped",
        output_file: task.outputPath,
        summary: `${task.description} (stopped)`,
        uuid: randomUUID(),
        session_id: ctx.sessionId,
      });
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
