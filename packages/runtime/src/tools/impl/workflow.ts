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
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import "../descriptors/workflow.ts"; // self-sufficiency: the "Workflow" stub must be registered before replaceExecutor runs
import { startTracking, setTaskStatus, getTask, listRunningTasks, toBackgroundTasksChangedEntry } from "./background-task-runtime.ts";
import { createBackgroundTask, wireTaskType } from "../background-tasks.ts";
import { getWorkflowSession, type WorkflowSessionRuntime } from "../../workflows/host-registry.ts";
import { WorkflowRuntime, WorkflowRuntimeError, type WorkflowRuntimeDeps, type WorkflowLaunchResult } from "../../workflows/runtime.ts";
import { parseWorkflowMeta, type WorkflowMeta } from "../../workflows/meta.ts";
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
      // `createBackgroundTask` OWNS the `<session-temp>/tasks/<taskId>.output` path shape and calls
      // `ensureTasksDir` on the way (tools/background-tasks.ts) -- hand-rolling `randomUUID()` +
      // `join(...)` here, as this file used to, produced a path in a directory that may not exist and
      // that nothing ever wrote to. Every other background-task producer calls it (bash.ts:421,
      // agent.ts); so does this one now.
      const { taskId, outputPath } = createBackgroundTask("workflow");
      // A VALIDATION FAILURE has no `meta.name` -- the meta block is exactly what did not parse. The
      // failure path passes an empty name, and `workflow_name` is then OMITTED rather than filled
      // with a plausible-looking literal: the field is optional on the frame, and inventing a value
      // for a pinned field is the same class of error the WorkflowOutput enumeration test guards
      // against (the frame has no such guard).
      const named = meta.name !== "";
      const description = named ? meta.name : "Workflow (the script failed validation)";
      // Registered in the SHARED background-task registry, so `TaskStop` reaches a workflow run
      // exactly as it reaches a backgrounded Bash command -- which is not a nicety: WS-11 §1.5's
      // resume precondition IS "the prior run stopped first via TaskStop", so a workflow TaskStop
      // cannot reach is a workflow that can never be resumed. A run has an OS process but its pid
      // lives inside the runtime, so it registers with a `stop` callback instead (the same shape
      // Monitor's socket half and a background agent both use).
      startTracking({
        taskId,
        kind: "workflow",
        outputPath,
        description,
        stop: () => {
          runtime.stop(meta.runId);
        },
      });
      // The TOOLS emit `task_started`, not the engine -- verified against tools/impl/bash.ts:461 and
      // tools/impl/agent.ts:145 rather than assumed. Capture (3) pins BOTH of this frame's
      // workflow-specific fields for a launch: `task_type: "local_workflow"` and `workflow_name`
      // equal to `meta.name`. `wireTaskType` is the one mapping (T3's Lane W item 1) -- the internal
      // kind is never written to the wire by hand.
      ctx.emitFrame({
        type: "system",
        subtype: "task_started",
        task_id: taskId,
        description,
        task_type: wireTaskType("workflow"),
        ...(named ? { workflow_name: meta.name } : {}),
        is_backgrounded: true,
        ...(ctx.toolUseId !== undefined ? { tool_use_id: ctx.toolUseId } : {}),
        uuid: randomUUID(),
        session_id: ctx.sessionId,
      });
      emitBackgroundTasksChanged(ctx);

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
            description,
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
          // WS-11 §1.4: "Only the script's `return` value re-enters the conversation." The
          // notification's `summary` is a 500-char PREVIEW and `WorkflowOutput` carries no result
          // field (correctly -- the pin has none), so THIS FILE is the only durable channel the
          // value has. Capture (3) records the pinned runtime emitting an `output_file` on
          // `task_notification` for exactly this reason; without the write, `TaskOutput` errors and a
          // `Read` on the advertised path is ENOENT.
          writeTaskOutput(outputPath, renderResultText(result));
          if (getTask(taskId) !== undefined) setTaskStatus(taskId, "completed");
          emitNotification(ctx, taskId, outputPath, "completed", renderSummary(result));
          emitBackgroundTasksChanged(ctx);
        },
        fail(error: string) {
          if (settled) return;
          settled = true;
          // WS-11 §1.8's THIRD terminal state. The frozen WorkflowTaskHandle has only
          // complete/fail, so a stop would otherwise reach the wire as `failed` -- telling a user who
          // pressed stop that their workflow crashed. The pinned `task_notification.status` union
          // carries "stopped" natively; the runtime is asked which of the two this was.
          const status = runtime.wasStopped(meta.runId) ? "stopped" : "failed";
          // The failure detail gets the same durable channel as a result: it is the run's diagnostic,
          // and truncating it into a 500-char preview is how a debuggable error becomes an opaque one.
          writeTaskOutput(outputPath, error);
          if (getTask(taskId) !== undefined) setTaskStatus(taskId, status);
          emitNotification(ctx, taskId, outputPath, status, error);
          emitBackgroundTasksChanged(ctx);
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

function emitBackgroundTasksChanged(ctx: ToolExecutionContext): void {
  ctx.emitFrame({
    type: "system",
    subtype: "background_tasks_changed",
    // `toBackgroundTasksChangedEntry` applies `wireTaskType` itself, so a workflow row carries
    // `local_workflow` here with no second literal anywhere in this file.
    tasks: listRunningTasks().map(toBackgroundTasksChangedEntry),
    uuid: randomUUID(),
    session_id: ctx.sessionId,
  });
}

/** Best-effort by construction: a run whose result cannot be written must still report its terminal state. */
function writeTaskOutput(outputPath: string, text: string): void {
  try {
    writeFileSync(outputPath, text, { mode: 0o600 });
  } catch {
    /* the directory was ensured by createBackgroundTask; a failure here must never swallow the notification below */
  }
}

function emitNotification(ctx: ToolExecutionContext, taskId: string, outputPath: string, status: "completed" | "failed" | "stopped", summary: string): void {
  ctx.emitFrame({
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    status,
    output_file: outputPath,
    summary,
    uuid: randomUUID(),
    session_id: ctx.sessionId,
  });
}

/** The result as text -- the SAME rendering the runtime uses for `WorkflowRunView.result`. */
function renderResultText(result: unknown): string {
  return typeof result === "string" ? result : JSON.stringify(result ?? null);
}

/** A model-facing PREVIEW for `task_notification.summary`. The full value lives in the output file. */
function renderSummary(result: unknown): string {
  const text = renderResultText(result);
  return text.length > 500 ? `${text.slice(0, 500)}... [truncated -- the full result is in the task's output file]` : text;
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
 * The SYNTAX-CHECK failure shape. Item (g) is explicit that a script failing it still RETURNS a
 * `WorkflowOutput` carrying `error` (`4086`) rather than throwing -- and `taskId` is a REQUIRED field
 * of that shape, so a task is created for the failure and immediately failed. A `WorkflowOutput` with
 * an empty taskId would not be the pinned shape; one with no task behind it would be a lie.
 *
 * Shared by the launch path and (RULING I6) the edited-script resume path, which owes the identical
 * answer for the identical failure.
 *
 * THE TASK IS REAL, and so is its output (whole-branch n4): `task.fail(error)` runs the host's own
 * `fail` implementation above, which `writeTaskOutput`s the message to the task's output file before
 * notifying. So `TaskOutput(taskId)` on this id returns the parse error, and the `output_file` the
 * notification names exists -- the failure is as inspectable as a successful run's result.
 */
function metaFailureResult(host: WorkflowRunHost, error: string): ToolResultPayload {
  const task = host.createTask("workflow", { runId: "", name: "" });
  task.fail(error);
  return toolResult({ status: "async_launched", taskId: task.taskId, taskType: "local_workflow", error });
}

/**
 * Resolves the script source. `scriptPath` > `script` > `name` -- the pinned precedence
 * (`sdk-tools.d.ts:2782`), applied by ORDER OF CHECKS here so it cannot drift into a merge.
 */
/** Whether this call names a script of its own -- the three source fields, in any combination. */
function hasExplicitSource(input: WorkflowInput): boolean {
  return (
    (typeof input.scriptPath === "string" && input.scriptPath !== "") ||
    (typeof input.script === "string" && input.script !== "") ||
    (typeof input.name === "string" && input.name !== "")
  );
}

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
    // Fix wave (whole-branch I5): resolved BY SESSION. `runtimeFor` already caches one
    // `WorkflowRuntime` per session id, but it cached it against whatever runtime happened to be
    // registered process-wide at the first call -- so in a two-session host the key was right and
    // the VALUE behind it was another session's.
    const session = getWorkflowSession(ctx.sessionId);
    if (session === undefined) {
      // The inert default (host-registry.ts): registered, not wired. A typed answer, never a crash.
      return toolError("no workflow runtime is configured for this session, so Workflow cannot run");
    }
    const runtime = runtimeFor(ctx.sessionId, session);
    const host = buildRunHost(ctx, session, runtime);

    // RESUME first: `resumeFromRunId` supplies its own source from the prior run, so it satisfies the
    // at-least-one rule on its own and must not be refused by the input check below.
    if (typeof input.resumeFromRunId === "string" && input.resumeFromRunId !== "") {
      if (ctx.toolUseId === undefined) {
        return toolError("Workflow cannot run without the model's own tool_use id -- every agent this run spawns correlates on it (WS-10 §4)");
      }
      // RULING I6 (fix wave): a source given ON THE RESUMING CALL is the one that runs. WS-11 §1.3's
      // documented loop is "read the persisted script, edit it, run it again", and this branch used
      // to return before `resolveSource` was ever reached -- so the edited script was silently
      // discarded and the prior source re-ran. The journal still seeds the run: the positional key
      // matches through the unchanged prefix and diverges at the first changed call, which is
      // §1.5's contract reached through §1.3's door.
      let replacement: { source: string; meta: WorkflowMeta } | undefined;
      if (hasExplicitSource(input)) {
        const edited = resolveSource(input, ctx);
        if (!edited.ok) return toolError(edited.error);
        const editedMeta = parseWorkflowMeta(edited.source);
        if (!editedMeta.ok) return metaFailureResult(host, editedMeta.error);
        replacement = { source: edited.source, meta: editedMeta.meta };
      }
      try {
        return toolResult(
          launchToOutput(
            runtime.resume(input.resumeFromRunId, ctx.sessionId, host, {
              parentToolUseId: ctx.toolUseId,
              ...(replacement !== undefined ? { replacement } : {}),
              ...(input.args !== undefined ? { args: input.args } : {}),
            }),
          ),
        );
      } catch (err) {
        if (err instanceof WorkflowRuntimeError) return toolError(err.message);
        throw err;
      }
    }

    // F11: `SpawnChildRequest.parentToolUseId` is REQUIRED and WS-10 §4 correlates a child's
    // forwarded frames on it. The runtime used to fall back to the run's task id -- a different id
    // space, and the same fabricated-value-on-a-pinned-field class this lane already removed from
    // `task_started.workflow_name`. The real engine always supplies `ctx.toolUseId`; a context that
    // cannot is refused here rather than silently correlating every child to something a host cannot
    // match.
    if (ctx.toolUseId === undefined) {
      return toolError("Workflow cannot run without the model's own tool_use id -- every agent this run spawns correlates on it (WS-10 §4)");
    }

    const resolved = resolveSource(input, ctx);
    if (!resolved.ok) return toolError(resolved.error);

    // The SYNTAX CHECK -- `metaFailureResult`'s own header for the shape and why it is a task.
    const meta = parseWorkflowMeta(resolved.source);
    if (!meta.ok) return metaFailureResult(host, meta.error);

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
              parentToolUseId: ctx.toolUseId,
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
    workflowName: launched.name,
    runId: launched.runId,
    summary: launched.summary,
    transcriptDir: launched.transcriptDir,
    scriptPath: launched.scriptPath,
  };
}

// `extractPaths` (RULING P3-F): RAW, unresolved candidates straight out of the input. `scriptPath` is
// a READ (the script is loaded to run it). The persisted copy is a write, but it is the RUNTIME's
// write to a path the caller never named -- and P5-B is what makes that subtree writable at all.
replaceExecutor(WORKFLOW_TOOL_NAME, executor, (raw: unknown) => {
  const input = asInput(raw);
  return { reads: typeof input.scriptPath === "string" ? [input.scriptPath] : [], writes: [] };
});

