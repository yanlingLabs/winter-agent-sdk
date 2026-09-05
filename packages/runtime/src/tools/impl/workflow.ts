// Phase 5 Lane W (task 4): the Workflow TOOL executor -- WS-11 §1.1/§1.3/§1.4, and the pinned
// `WorkflowInput`/`WorkflowOutput` of derived-shapes-p5 item (g).
//
// This file is thin ON PURPOSE. It resolves the script, validates the meta block, hands the run to
// `WorkflowRuntime`, and renders the pinned result -- nothing about processes, seatbelts, bridges or
// caps appears here. The tool's job is the CONTRACT; the runtime's job is the machinery.
//
// ONE STRUCTURAL NOTE WORTH THE READER'S TIME. The tool needs a `WorkflowRunHost` (the frozen seam),
// and `ToolExecutionContext` carries only two of its four ingredients. `createTask` is composed here
// from `ctx.emitFrame` + the shared background-task registry, and `spawnAgent` from
// `ctx.session.spawnChild`; `structured` and `accountant` -- plus the session's `winterHome` and
// `projectKey` -- come from `workflows/host-registry.ts`, the registration seam this lane had to add
// because `tools/registry.ts` and `engine.ts` are both frozen (R5-12). See that module's header.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import "../descriptors/workflow.ts"; // self-sufficiency: the "Workflow" stub must be registered before replaceExecutor runs
import { startTracking, setTaskStatus, getTask } from "./background-task-runtime.ts";
import { getWorkflowSession, type WorkflowSessionRuntime } from "../../workflows/host-registry.ts";
import { WorkflowRuntime, WorkflowRuntimeError, type WorkflowRuntimeDeps, type WorkflowLaunchResult } from "../../workflows/runtime.ts";
import { parseWorkflowMeta } from "../../workflows/meta.ts";
import { resolveWorkflowByName } from "../../workflows/store.ts";
import type { WorkflowInput, WorkflowOutput } from "../../workflows/types.ts";
import type { WorkflowProgress, WorkflowRunHost, WorkflowTaskHandle } from "../../workflows/seam.ts";
import type { ChildHandle, SpawnChildRequest } from "../../subagents/child-handle.ts";

export const WORKFLOW_TOOL_NAME = "Workflow";

// ONE runtime per session. The registry is a process-wide catalog and this executor is a module
// singleton, so the map is keyed by session id exactly as the ToolSearch/messaging runtimes are --
// two concurrent sessions must not share a run registry, a journal root, or a persisted-script area.
const runtimes = new Map<string, WorkflowRuntime>();
let testOverrides: Partial<WorkflowRuntimeDeps> = {};

/** Test-only, mirroring every sibling singleton's own escape hatch (bun shares one module instance across a `bun test` run). */
export function resetWorkflowToolForTest(overrides: Partial<WorkflowRuntimeDeps> = {}): void {
  runtimes.clear();
  testOverrides = overrides;
}

function runtimeFor(sessionId: string, session: WorkflowSessionRuntime): WorkflowRuntime {
  const existing = runtimes.get(sessionId);
  if (existing !== undefined) return existing;
  const created = new WorkflowRuntime({ session, ...testOverrides });
  runtimes.set(sessionId, created);
  return created;
}

// --- The host, composed from what the frozen context DOES carry -----------------------------------

function buildRunHost(ctx: ToolExecutionContext, session: WorkflowSessionRuntime, runtime: WorkflowRuntime): WorkflowRunHost {
  return {
    createTask(kind, meta): WorkflowTaskHandle {
      const taskId = randomUUID();
      // Registered in the SHARED background-task registry, so `TaskStop` reaches a workflow run
      // exactly as it reaches a backgrounded Bash command -- which is not a nicety: WS-11 §1.5's
      // resume precondition IS "the prior run stopped first via TaskStop", so a workflow TaskStop
      // cannot reach is a workflow that can never be resumed. A run has an OS process but its pid
      // lives inside the runtime, so it registers with a `stop` callback instead (the same shape
      // Monitor's socket half and a background agent both use).
      startTracking({
        taskId,
        kind: "workflow",
        outputPath: join(ctx.tempDir, "tasks", `${taskId}.output`),
        description: meta.name,
        stop: () => {
          runtime.stop(meta.runId);
        },
      });
      let settled = false;
      return {
        taskId,
        emit(progress: WorkflowProgress) {
          if (settled) return;
          // WS-06 §3.5's own frame. `wireTaskType` is not used here because `task_progress` carries
          // no task_type field at all (frames.ts) -- the wire spelling appears on `task_started` and
          // `background_tasks_changed`, both of which are the ENGINE's emissions, not this tool's.
          ctx.emitFrame({
            type: "system",
            subtype: "task_progress",
            task_id: taskId,
            description: meta.name,
            usage: progress.usage ?? { total_tokens: 0, tool_uses: progress.total, duration_ms: 0 },
            ...(progress.summary !== undefined ? { summary: progress.summary } : {}),
            ...(progress.lastToolName !== undefined ? { last_tool_name: progress.lastToolName } : {}),
            uuid: randomUUID(),
            session_id: ctx.sessionId,
          });
        },
        complete(result: unknown) {
          if (settled) return;
          settled = true;
          if (getTask(taskId) !== undefined) setTaskStatus(taskId, "completed");
          emitNotification(ctx, taskId, "completed", renderSummary(result));
        },
        fail(error: string) {
          if (settled) return;
          settled = true;
          if (getTask(taskId) !== undefined) setTaskStatus(taskId, "failed");
          emitNotification(ctx, taskId, "failed", error);
        },
      };
    },
    async spawnAgent(req: SpawnChildRequest): Promise<ChildHandle> {
      const spawn = ctx.session.spawnChild;
      if (spawn === undefined) throw new Error("no child-spawn capability is configured for this session, so workflow agents cannot run");
      return spawn(req);
    },
    structured: session.structured,
    accountant: session.accountant,
  };
}

function emitNotification(ctx: ToolExecutionContext, taskId: string, status: "completed" | "failed", summary: string): void {
  ctx.emitFrame({
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    status,
    output_file: join(ctx.tempDir, "tasks", `${taskId}.output`),
    summary,
    uuid: randomUUID(),
    session_id: ctx.sessionId,
  });
}

function renderSummary(result: unknown): string {
  const text = typeof result === "string" ? result : JSON.stringify(result ?? null);
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

// --- Input handling --------------------------------------------------------------------------------

function asInput(raw: unknown): WorkflowInput {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as WorkflowInput) : {};
}

function toolError(message: string): ToolResultPayload {
  return { output: `Error: ${message}`, isError: true };
}

/** The pinned result, rendered as JSON so every declared field survives verbatim. */
function toolResult(out: WorkflowOutput): ToolResultPayload {
  return { output: JSON.stringify(out) };
}

/**
 * Resolves the script source. `scriptPath` > `script` > `name` -- the pinned precedence
 * (`sdk-tools.d.ts:2782`), applied by ORDER OF CHECKS here so it cannot drift into a merge.
 */
function resolveSource(input: WorkflowInput, ctx: ToolExecutionContext): { ok: true; source: string } | { ok: false; error: string } {
  if (typeof input.scriptPath === "string" && input.scriptPath !== "") {
    const path = isAbsolute(input.scriptPath) ? input.scriptPath : join(ctx.cwd, input.scriptPath);
    try {
      return { ok: true, source: readFileSync(path, "utf8") };
    } catch (err) {
      return { ok: false, error: `could not read the workflow script at ${input.scriptPath}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  if (typeof input.script === "string" && input.script !== "") return { ok: true, source: input.script };
  if (typeof input.name === "string" && input.name !== "") {
    const resolved = resolveWorkflowByName(input.name, { cwd: ctx.cwd, trustedWorkspace: ctx.trustedWorkspace === true });
    return resolved.ok ? { ok: true, source: resolved.source } : { ok: false, error: resolved.error };
  }
  return { ok: false, error: "Workflow requires at least one of `script`, `name` or `scriptPath` (`resumeFromRunId` may be used on its own to resume a stopped run)" };
}

const executor: ToolExecutor = {
  async execute(rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
    const input = asInput(rawInput);
    const session = getWorkflowSession();
    if (session === undefined) {
      // The inert default (host-registry.ts): registered, not wired. A typed answer, never a crash.
      return toolError("no workflow runtime is configured for this session, so Workflow cannot run");
    }
    const runtime = runtimeFor(ctx.sessionId, session);
    const host = buildRunHost(ctx, session, runtime);

    // RESUME first: `resumeFromRunId` supplies its own source from the prior run, so it satisfies the
    // at-least-one rule on its own and must not be refused by the input check below.
    if (typeof input.resumeFromRunId === "string" && input.resumeFromRunId !== "") {
      try {
        return toolResult(launchToOutput(runtime.resume(input.resumeFromRunId, ctx.sessionId, host)));
      } catch (err) {
        if (err instanceof WorkflowRuntimeError) return toolError(err.message);
        throw err;
      }
    }

    const resolved = resolveSource(input, ctx);
    if (!resolved.ok) return toolError(resolved.error);

    // The SYNTAX CHECK. Item (g) is explicit that a script failing it still RETURNS a WorkflowOutput
    // carrying `error` (`4086`) rather than throwing -- and `taskId` is a REQUIRED field of that
    // shape, so a task is created for the failure and immediately failed. A `WorkflowOutput` with an
    // empty taskId would not be the pinned shape; one with no task behind it would be a lie.
    const meta = parseWorkflowMeta(resolved.source);
    if (!meta.ok) {
      const task = host.createTask("workflow", { runId: "", name: "workflow" });
      task.fail(meta.error);
      return toolResult({ status: "async_launched", taskId: task.taskId, taskType: "local_workflow", error: meta.error });
    }

    try {
      return toolResult(
        launchToOutput(
          runtime.launch(
            {
              sessionId: ctx.sessionId,
              cwd: ctx.cwd,
              trustedWorkspace: ctx.trustedWorkspace === true,
              source: resolved.source,
              meta: meta.meta,
              ...(input.args !== undefined ? { args: input.args } : {}),
              ...(ctx.toolUseId !== undefined ? { parentToolUseId: ctx.toolUseId } : {}),
            },
            host,
          ),
        ),
      );
    } catch (err) {
      if (err instanceof WorkflowRuntimeError) return toolError(err.message);
      throw err;
    }
  },
};

/**
 * The one mapping from a launch to the pinned shape. Every field is either required by the pin or
 * has a real value behind it -- `sessionUrl`/`warning` are omitted rather than sent as `undefined`
 * or an empty string, because both are doc-marked as ABSENT on transcripts that predate them and an
 * empty one would read as a present-but-blank value.
 */
function launchToOutput(launched: WorkflowLaunchResult): WorkflowOutput {
  return {
    status: "async_launched",
    taskId: launched.taskId,
    taskType: "local_workflow",
    workflowName: workflowNameOf(launched),
    runId: launched.runId,
    summary: launched.summary,
    transcriptDir: launched.transcriptDir,
    scriptPath: launched.scriptPath,
  };
}

/** `WorkflowOutput.workflowName` is doc-asserted (`4061`) to be `meta.name` AND to equal `task_started.workflow_name`. The launch's persisted filename is `<meta.name>-<runId>.js`, so the name is recovered from there rather than threaded twice. */
function workflowNameOf(launched: WorkflowLaunchResult): string {
  const file = launched.scriptPath.slice(launched.scriptPath.lastIndexOf("/") + 1);
  return file.endsWith(`-${launched.runId}.js`) ? file.slice(0, -`-${launched.runId}.js`.length) : file;
}

// `extractPaths` (RULING P3-F): RAW, unresolved candidates straight out of the input. `scriptPath` is
// a READ (the script is loaded to run it). The persisted copy is a write, but it is the RUNTIME's
// write to a path the caller never named -- and P5-B is what makes that subtree writable at all.
replaceExecutor(WORKFLOW_TOOL_NAME, executor, (raw: unknown) => {
  const input = asInput(raw);
  return { reads: typeof input.scriptPath === "string" ? [input.scriptPath] : [], writes: [] };
});

