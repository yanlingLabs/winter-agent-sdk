// Phase 5 Lane W (task 4): the workflow runtime's own data shapes. Ported from Norma's
// `workflows/types.ts` with the CC-contract widenings WS-11 §1.6 requires.
//
// `WorkflowProgress` deliberately lives in `seam.ts` (the SPINE's shape, frozen) -- not here. The
// counters below are the runtime's INTERNAL bookkeeping; `seam.ts`'s WorkflowProgress is what
// crosses to the host, and the runtime maps one onto the other at exactly one place (runtime.ts's
// emitProgress). Two shapes, one mapping, on purpose: the host-facing one has to fill the pinned
// `task_progress.usage` triple, which is not something a worker counter knows about.

/** WS-11 §1.8: `running -> completed | failed | stopped`, a ONE-WAY lifecycle. */
export type WorkflowStatus = "running" | "completed" | "failed" | "stopped";

export interface WorkflowCounts {
  running: number;
  completed: number;
  total: number;
}

/**
 * WS-11 §1.6's `agent()` options table, in full. Norma's original carried `{label, model, schema}`;
 * `phase`, `effort`, `isolation` and `agentType` are the CC-contract widening.
 *
 * SERIALIZED ACROSS THE BRIDGE and used verbatim inside `promptKey`, so every field must be plain
 * JSON data -- a function or class instance here would break both the wire and the resume cache.
 */
export interface AgentOpts {
  /** Display-label override for the progress tree. */
  label?: string;
  /** Explicit progress-group assignment -- avoids racing the global `phase()` state inside `pipeline`/`parallel` stages. */
  phase?: string;
  /** JSON Schema. Forces the child onto the StructuredOutput mechanism (WS-11 §8) via `SpawnChildRequest.outputFormat`. */
  schema?: unknown;
  /** Per-child model override; omitted -> the child inherits the resolved session model (WS-10). */
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** WS-10 §8: a fresh git worktree per agent, auto-removed when unchanged. */
  isolation?: "worktree";
  /** A custom subagent type resolved from the same registry the Agent tool uses; composes with `schema`. */
  agentType?: string;
}

/** A read-only projection of a run -- plain-cloneable, no AbortController, safe to hand to a caller. */
export interface WorkflowRunView {
  runId: string;
  sessionId: string;
  taskId: string;
  name: string;
  status: WorkflowStatus;
  counts: WorkflowCounts;
  phase?: string;
  result?: string;
  error?: string;
  startedAt: number;
}

// --- The pinned tool shapes (derived-shapes-p5 item (g)) -----------------------------------------

/**
 * `WorkflowInput`, `sdk-tools.d.ts:2758-2789`. Seven fields, ALL optional at the declaration; the
 * "at least one of `script`/`name`/`scriptPath`" rule is a runtime validation, not a type one,
 * exactly as the pin has it.
 */
export interface WorkflowInput {
  script?: string;
  name?: string;
  /** Accepted and IGNORED -- the meta block owns metadata (`sdk-tools.d.ts:2768`). */
  description?: string;
  /** Accepted and IGNORED (`sdk-tools.d.ts:2772`). */
  title?: string;
  args?: { [k: string]: unknown };
  /** Takes PRECEDENCE over `script` and `name` (`sdk-tools.d.ts:2782`). */
  scriptPath?: string;
  /** Same-session only, and only after the prior run has stopped (`sdk-tools.d.ts:2786`). */
  resumeFromRunId?: string;
}

/**
 * `WorkflowOutput`, `sdk-tools.d.ts:4053-4089` -- declared in full, so this is a MIRROR, not a
 * Winter invention. `status` and `taskId` are the only required fields.
 *
 * Winter implements the LOCAL half only: `remote_launched`/`sessionUrl` are declared here for
 * fidelity to the pinned union but are never produced (`WorkflowInput` declares no `remote` field --
 * item (g)'s own asymmetry note).
 */
export interface WorkflowOutput {
  status: "async_launched" | "remote_launched";
  taskId: string;
  taskType?: "local_workflow" | "remote_agent";
  workflowName?: string;
  runId?: string;
  summary?: string;
  transcriptDir?: string;
  scriptPath?: string;
  sessionUrl?: string;
  warning?: string;
  /** Doc-asserted (`4086`) to be set when the SYNTAX CHECK fails -- a script that fails validation still returns a WorkflowOutput. */
  error?: string;
}
