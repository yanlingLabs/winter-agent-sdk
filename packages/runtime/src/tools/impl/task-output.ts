// Task 3 (Lane C): TaskOutput (WS-06 §3.5). Reads a background task's output, optionally waiting.
// Deprecated in favor of `Read` on the task's output file (model-readable per WS-06 §3.5's own
// "Read supersedes TaskOutput") -- Winter preserves the tool for pinned compatibility and the file
// as the primary path. Shares the background-task-runtime.ts registry with bash.ts/monitor.ts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import "../descriptors/task-output.ts";
import { replaceExecutor, type ToolExecutor, type ToolExecutionContext } from "../registry.ts";
import { getTask } from "./background-task-runtime.ts";

interface TaskOutputInput {
  task_id: string;
  block: boolean;
  timeout: number;
}

function parseTaskOutputInput(input: unknown): TaskOutputInput | { error: string } {
  if (typeof input !== "object" || input === null) return { error: "TaskOutput: input must be an object" };
  const obj = input as Record<string, unknown>;
  if (typeof obj.task_id !== "string" || obj.task_id.length === 0) {
    return { error: 'TaskOutput: "task_id" is required and must be a non-empty string' };
  }
  if (typeof obj.block !== "boolean") {
    return { error: 'TaskOutput: "block" is required and must be a boolean' };
  }
  if (typeof obj.timeout !== "number" || !Number.isFinite(obj.timeout) || obj.timeout < 0) {
    return { error: 'TaskOutput: "timeout" is required and must be a non-negative number of milliseconds' };
  }
  return { task_id: obj.task_id, block: obj.block, timeout: obj.timeout };
}

// Same inline cap Bash's own foreground result uses -- TaskOutput is documented as deprecated for
// large output (Read is the primary path), so a generous but bounded inline peek is all it owes.
const INLINE_CAP = 30_000;

// Registry lookup FIRST (has live status); falls back to reconstructing the D18 path directly from
// ctx.tempDir when the in-process registry has no record (e.g. this process restarted but the
// output file itself, being plain durable storage, survived) -- see background-task-runtime.ts's
// own "ONE-LIVE-ENGINE ASSUMPTION" header for why that fallback matters at all in this phase.
function resolveOutputPath(taskId: string, ctx: ToolExecutionContext): string | undefined {
  const tracked = getTask(taskId);
  if (tracked) return tracked.outputPath;
  const fallback = join(ctx.tempDir, "tasks", `${taskId}.output`);
  return existsSync(fallback) ? fallback : undefined;
}

async function waitForTerminal(taskId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // An UNTRACKED task (registry has no record -- see resolveOutputPath's own fallback) has no
  // observable status in this phase; blocking on it would wait out the full timeout for no reason,
  // so this returns immediately rather than polling nothing (WS-06 §7.3: the task store, not this
  // tool, owns durable lifecycle -- an untracked task's live status is a real, accepted gap here).
  if (!getTask(taskId)) return;
  while (Date.now() < deadline) {
    const t = getTask(taskId);
    if (!t || t.status !== "running") return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

const taskOutputExecutor: ToolExecutor = {
  async execute(input, ctx) {
    const parsed = parseTaskOutputInput(input);
    if ("error" in parsed) return { output: `Error: ${parsed.error}`, isError: true };

    if (parsed.block) {
      await waitForTerminal(parsed.task_id, parsed.timeout);
    }

    const outputPath = resolveOutputPath(parsed.task_id, ctx);
    if (!outputPath) {
      return { output: `Error: TaskOutput: unknown task_id "${parsed.task_id}"`, isError: true };
    }

    let content: string;
    try {
      content = readFileSync(outputPath, "utf8");
    } catch {
      return { output: `Error: TaskOutput: output file for task_id "${parsed.task_id}" could not be read`, isError: true };
    }

    const capped =
      content.length > INLINE_CAP
        ? `${content.slice(0, INLINE_CAP)}\n[truncated at ${INLINE_CAP} chars -- use Read on ${outputPath} for the full output]`
        : content;
    const status = getTask(parsed.task_id)?.status;
    const lines = [capped.length > 0 ? capped : "(no output yet)"];
    if (status) lines.push(`[task status: ${status}]`);
    lines.push(`Note: TaskOutput is deprecated in favor of Read on ${outputPath} directly.`);
    return { output: lines.join("\n") };
  },
};

replaceExecutor("TaskOutput", taskOutputExecutor);

export { parseTaskOutputInput, taskOutputExecutor };
