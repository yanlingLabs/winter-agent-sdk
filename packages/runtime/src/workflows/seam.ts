// Phase 5 Task 3 (spine): the WORKFLOW RUN HOST -- R5-5. Lane W (task 4) implements the sandboxed
// subprocess runtime and the script API; this is the narrow surface it reaches the engine through.
//
// Lane W may not touch `engine.ts`, `tools/registry.ts`, `subagents/child-engine.ts`, `sandbox/**` or
// `main.ts` (R5-12), so everything a running workflow needs from the session -- a background task to
// live in, the ability to spawn child agents, schema validation, and the context accounting its
// budget ceiling reads -- arrives through this ONE object.
//
// THE `WorkflowOutput` SHAPE IS PINNED (derived-shapes-p5 item (g), `sdk-tools.d.ts:4053-4089`) and
// the Workflow tool's result must be exactly it. This host does not construct it -- Lane W does --
// but every field it needs is reachable from here: `taskId` from `createTask`, `runId`/`workflowName`
// from the meta the lane passes in, `scriptPath`/`transcriptDir` from the lane's own persistence.
import type { ContextAccountant } from "../engine.ts";
import type { ChildHandle, SpawnChildRequest } from "../subagents/child-handle.ts";
import type { StructuredOutputSeam } from "../structured/seam.ts";

/**
 * A running workflow's progress. WINTER-DEFINED (the pinned surface has no workflow-progress type),
 * but shaped to land on the pinned `task_progress` message without a second mapping: that message's
 * `usage` triple is REQUIRED and is `{total_tokens, tool_uses, duration_ms}`, so a progress report
 * that could not fill all three would produce a frame the pin cannot accept.
 *
 * `running`/`completed`/`total` are WS-11 §1.8's own step counters.
 */
export interface WorkflowProgress {
  running: number;
  completed: number;
  total: number;
  /** Free-form, model-facing; lands on `task_progress.summary`. */
  summary?: string;
  /** Lands on `task_progress.last_tool_name`. */
  lastToolName?: string;
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
}

/**
 * The handle one workflow RUN holds. `complete`/`fail` are terminal and idempotent -- a worker that
 * crashes after reporting completion must not be able to re-fail its own task (WS-11 §1.8's
 * `running -> completed | failed | stopped` is a one-way lifecycle).
 */
export interface WorkflowTaskHandle {
  taskId: string;
  emit(progress: WorkflowProgress): void;
  complete(result: unknown): void;
  fail(error: string): void;
}

export interface WorkflowRunHost {
  /**
   * Registers this run as a background task. `kind` is the single literal `"workflow"` -- Winter's
   * INTERNAL `BackgroundTaskKind` spelling. It is NOT what goes on the wire: capture (3) and item (g)
   * both pin `task_started.task_type` / `WorkflowOutput.taskType` as `"local_workflow"`, and
   * `tools/background-tasks.ts`'s own `wireTaskType(kind)` is the one mapping between them. A lane
   * that hand-writes either spelling at an emission site is the drift this split exists to prevent.
   */
  createTask(kind: "workflow", meta: { runId: string; name: string }): WorkflowTaskHandle;
  /** Spawns a child agent -- the SAME path the Agent tool uses, so `agent({schema})` rides `outputFormat` through `SpawnChildRequest` rather than a parallel mechanism. */
  spawnAgent(req: SpawnChildRequest): Promise<ChildHandle>;
  /** Schema validation, borrowed from Lane K (R5-12's named W->K coupling) -- never a second validator. */
  structured: StructuredOutputSeam;
  /** The session's context accounting -- what a workflow's `budget` ceiling reads. */
  accountant: ContextAccountant;
}

/**
 * The spine's test double: an in-memory host recording tasks, progress and terminal calls. It spawns
 * no processes and creates no files, so a lane can exercise its orchestration logic long before its
 * real subprocess runtime works.
 */
export function fakeWorkflowRunHost(deps: {
  structured: StructuredOutputSeam;
  accountant: ContextAccountant;
  spawnAgent?: (req: SpawnChildRequest) => Promise<ChildHandle>;
  log?: Array<{ kind: string; taskId: string; event: "created" | "progress" | "complete" | "fail"; detail?: unknown }>;
}): WorkflowRunHost {
  let counter = 0;
  return {
    createTask(kind, meta) {
      const taskId = `fake-task-${++counter}`;
      deps.log?.push({ kind, taskId, event: "created", detail: meta });
      let settled = false;
      return {
        taskId,
        emit(progress) {
          if (settled) return;
          deps.log?.push({ kind, taskId, event: "progress", detail: progress });
        },
        complete(result) {
          if (settled) return;
          settled = true;
          deps.log?.push({ kind, taskId, event: "complete", detail: result });
        },
        fail(error) {
          if (settled) return;
          settled = true;
          deps.log?.push({ kind, taskId, event: "fail", detail: error });
        },
      };
    },
    async spawnAgent(req: SpawnChildRequest): Promise<ChildHandle> {
      if (deps.spawnAgent === undefined) throw new Error("fakeWorkflowRunHost: no spawnAgent supplied");
      return deps.spawnAgent(req);
    },
    structured: deps.structured,
    accountant: deps.accountant,
  };
}
