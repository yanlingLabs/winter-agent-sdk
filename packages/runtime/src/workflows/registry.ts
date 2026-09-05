// Phase 5 Lane W (task 4), WS-11 §1.8: the run-state tracker. Ported from Norma's
// `workflows/registry.ts` -- a pure Map-backed bookkeeper with no I/O, no processes and no timers,
// which is what lets the lifecycle rules be tested without a subprocess anywhere in sight.
//
// THE LIFECYCLE IS ONE-WAY: `running -> completed | failed | stopped`. Every mutator below is a
// no-op on an unknown run or an already-terminal one, so a worker that crashes AFTER reporting
// completion cannot re-fail its own run -- the same guarantee `WorkflowTaskHandle`'s terminal calls
// carry on the seam side (seam.ts), enforced independently here because the two settle through
// different paths (a bridge message vs. a process `close` event) and either can arrive second.
import type { WorkflowCounts, WorkflowRunView, WorkflowStatus } from "./types.ts";

interface WorkflowRunEntry {
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
  abort: AbortController;
}

export class WorkflowRegistry {
  private readonly runs = new Map<string, WorkflowRunEntry>();

  register(entry: { runId: string; sessionId: string; taskId: string; name: string; abort: AbortController; startedAt?: number }): void {
    if (this.runs.has(entry.runId)) return;
    this.runs.set(entry.runId, {
      runId: entry.runId,
      sessionId: entry.sessionId,
      taskId: entry.taskId,
      name: entry.name,
      status: "running",
      counts: { running: 0, completed: 0, total: 0 },
      startedAt: entry.startedAt ?? Date.now(),
      abort: entry.abort,
    });
  }

  setPhase(runId: string, phase: string): void {
    const entry = this.runs.get(runId);
    if (entry) entry.phase = phase;
  }

  setCounts(runId: string, counts: WorkflowCounts): void {
    const entry = this.runs.get(runId);
    if (entry) entry.counts = counts;
  }

  /** `running -> completed | failed`. No-op if unknown or already terminal. */
  complete(runId: string, outcome: { ok: boolean; result: string }): void {
    const entry = this.runs.get(runId);
    if (!entry || entry.status !== "running") return;
    entry.status = outcome.ok ? "completed" : "failed";
    if (outcome.ok) entry.result = outcome.result;
    else entry.error = outcome.result;
  }

  fail(runId: string, error: string): void {
    this.complete(runId, { ok: false, result: error });
  }

  /** `running -> stopped`, firing the run's abort. Returns false if unknown or already terminal. */
  stop(runId: string): boolean {
    const entry = this.runs.get(runId);
    if (!entry || entry.status !== "running") return false;
    // Status is set BEFORE the abort fires, and the ordering is load-bearing (carried verbatim from
    // Norma's own comment, which records why): `abort()` runs its listeners SYNCHRONOUSLY, and the
    // runtime's abort -> teardown -> settle cascade reads the status during that synchronous run.
    // Aborting first would let the cascade observe a stale "running" and overwrite "stopped" with
    // "failed" -- so a user-initiated stop would be reported as a crash.
    entry.status = "stopped";
    entry.abort.abort();
    return true;
  }

  get(runId: string): WorkflowRunView | undefined {
    const entry = this.runs.get(runId);
    return entry ? view(entry) : undefined;
  }

  list(sessionId: string): WorkflowRunView[] {
    return [...this.runs.values()].filter((e) => e.sessionId === sessionId).map(view);
  }
}

function view(entry: WorkflowRunEntry): WorkflowRunView {
  return {
    runId: entry.runId,
    sessionId: entry.sessionId,
    taskId: entry.taskId,
    name: entry.name,
    status: entry.status,
    counts: entry.counts,
    ...(entry.phase !== undefined ? { phase: entry.phase } : {}),
    ...(entry.result !== undefined ? { result: entry.result } : {}),
    ...(entry.error !== undefined ? { error: entry.error } : {}),
    startedAt: entry.startedAt,
  };
}
