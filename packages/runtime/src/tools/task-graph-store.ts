// WS-06 §3.4 -- the task-graph store (Phase 3, Lane D / Task 6). Backs TaskCreate/TaskGet/TaskList/
// TaskUpdate (tools/impl/task-graph.ts). Session-scoped, in-memory, and -- by construction, per the
// task-1 brief's own seam note (registry.ts) and this lane's Seams section -- a namespace COMPLETELY
// DISTINCT from background-tasks.ts's id space: that module mints ids for backgrounded
// Bash/Monitor/Workflow/agent processes; this module mints ids for rows in a session's task graph.
// "Stop an agent/task" (TaskStop/background-tasks.ts) and "delete a TaskCreate row" (TaskUpdate
// status:"deleted", below) are two different verbs over two different id spaces that must never
// collide or be mistaken for one another (WS-06 §3.5) -- this file imports nothing from
// background-tasks.ts and mints its own ids via a fresh randomUUID() per row, exactly like that
// module's own createBackgroundTask does for its (separate) namespace.
//
// Session-scoped (not a single process-wide singleton like background-tasks.ts's one active
// resolver): keyed by sessionId, a `Map<sessionId, Map<taskId, TaskGraphRow>>`. Unlike
// background-tasks.ts's documented "one live engine" limitation, there is no cost to keying this
// correctly from day one -- every call already carries ToolExecutionContext.sessionId, so a second
// concurrent session in the same process (a future WS-15 multi-session daemon host) never collides
// here, closing a limitation before it exists rather than inheriting one.
//
// Advisor-ratified design (see task-6-report.md for the full adjudication):
//   - addBlocks/addBlockedBy are REAL, VALIDATED, BIDIRECTIONAL graph edges: `addBlocks:[X]` on task
//     A means "A blocks X" -- applied as A.blocks |= {X} AND (mirrored) X.blockedBy |= {A}, in one
//     atomic update. The union-merge is a Set union (dedupe, first-seen order via existing-then-new
//     insertion) -- re-adding an id already present is a no-op, never a duplicate.
//   - Referenced ids MUST already exist in the SAME session's graph; an unknown id is a rejected,
//     legible error, not a tolerated forward reference. (The retired Norma `task_update`'s "referenced
//     ids need not exist yet" comment predates WS-06's "reflected on both sides" requirement -- a
//     forward reference cannot be mirrored onto a row that does not exist yet, which would leave the
//     graph silently half-consistent. WS-06 text ("Dependency and ownership semantics MUST be
//     implemented, not reduced to a todo rename") outranks that retired precedent here.)
//   - Self-reference (a task naming itself in its own addBlocks/addBlockedBy) is rejected the same
//     way -- one degenerate edge case, cheap to close off.
//   - Validation runs to completion BEFORE any field is mutated -- an update that fails validation
//     leaves the row (and every row it would have touched) byte-identical to before the call. No
//     partial application.
//   - `status: "deleted"` is a SOFT delete: `deleted` sits in the exact same enum as
//     pending/in_progress/completed (TaskUpdate's own pinned schema lists all four side by side), and
//     WS-06's own phrase is "removes from listings" -- listings, not the store. The row survives with
//     `status: "deleted"`, remains reachable via getTask (TaskGet), keeps its blocks/blockedBy edges
//     intact (so a live task's blockedBy list pointing at a since-deleted blocker stays accurate
//     rather than silently losing an edge), and is simply excluded from listTasks (TaskList). This
//     also means validation/reflection never has to special-case "the other end of this edge was
//     deleted out from under me" -- the row is still right there. A transition OUT of "deleted" back
//     to pending/in_progress/completed is permitted -- WS-06 pins no state machine forbidding it.
//   - Metadata on TaskUpdate SHALLOW-merges into existing metadata (new keys win; no delete
//     mechanism) -- WS-06 §3.4 is silent on merge-vs-replace for this field; the retired Norma
//     `task_update`'s explicit shallow-merge choice is adopted as the only concrete precedent that
//     exists for this exact field, per the advisor's precedence rule (spec silent -> retired
//     precedent governs, before pure invention).
//   - No wire events: TaskGraphRow changes are not pinned to any SessionEvent/BackgroundTaskMessage
//     shape this phase, and `ToolExecutionContext.emitFrame` only accepts the closed
//     BackgroundTaskMessage union (registry.ts) -- this store emits nothing onto the wire. A future
//     phase that wants live task-graph updates on a harness needs its own pinned event variant
//     (protocol change checklist), not a repurposing of emitFrame.
import { randomUUID } from "node:crypto";

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface TaskGraphRow {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: TaskStatus;
  blocks: string[];
  blockedBy: string[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskCreateInput {
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskUpdateInput {
  taskId: string;
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: TaskStatus;
  addBlocks?: string[];
  addBlockedBy?: string[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

// WS-06 §3.4's own pinned TaskList row shape -- deliberately NARROWER than TaskGraphRow (no
// description, no activeForm, no metadata). `blockedBy` is unconditional (no `?` in the spec's own
// "id, subject, status, owner?, blockedBy" list) -- only `owner` is optional there.
export interface TaskListRow {
  id: string;
  subject: string;
  status: TaskStatus;
  owner?: string;
  blockedBy: string[];
}

export type TaskUpdateError =
  | { kind: "not_found"; taskId: string }
  | { kind: "self_reference"; taskId: string; field: "addBlocks" | "addBlockedBy" }
  | { kind: "unknown_reference"; taskId: string; field: "addBlocks" | "addBlockedBy"; missing: string };

export type TaskUpdateResult = { ok: true; row: TaskGraphRow } | { ok: false; error: TaskUpdateError };

// --- The index: Map<sessionId, Map<taskId, TaskGraphRow>> -----------------------------------------

const sessions = new Map<string, Map<string, TaskGraphRow>>();

function sessionMap(sessionId: string): Map<string, TaskGraphRow> {
  let m = sessions.get(sessionId);
  if (!m) {
    m = new Map();
    sessions.set(sessionId, m);
  }
  return m;
}

// Test-only escape hatch (background-tasks.ts / registry.ts precedent): bun's test runner shares one
// module registry across every file in a `bun test` invocation, so tests reset this between runs.
// Omitting sessionId clears EVERY session -- used for the "start from nothing" baseline; passing one
// clears only that session's rows, for tests that need other sessions' state left alone.
export function resetTaskGraphStoreForTest(sessionId?: string): void {
  if (sessionId === undefined) sessions.clear();
  else sessions.delete(sessionId);
}

export function createTask(sessionId: string, input: TaskCreateInput): TaskGraphRow {
  const row: TaskGraphRow = {
    id: randomUUID(),
    subject: input.subject,
    description: input.description,
    status: "pending",
    blocks: [],
    blockedBy: [],
    ...(input.activeForm !== undefined ? { activeForm: input.activeForm } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };
  sessionMap(sessionId).set(row.id, row);
  return row;
}

export function getTask(sessionId: string, taskId: string): TaskGraphRow | undefined {
  return sessionMap(sessionId).get(taskId);
}

// Excludes `deleted` rows -- WS-06 §3.4: "`deleted` removes from listings" (soft delete; see this
// file's header). Rows are returned in insertion order (Map iteration order), oldest first.
export function listTasks(sessionId: string): TaskListRow[] {
  const rows: TaskListRow[] = [];
  for (const r of sessionMap(sessionId).values()) {
    if (r.status === "deleted") continue;
    rows.push({
      id: r.id,
      subject: r.subject,
      status: r.status,
      blockedBy: r.blockedBy,
      ...(r.owner !== undefined ? { owner: r.owner } : {}),
    });
  }
  return rows;
}

function unionMerge(existing: readonly string[], toAdd: readonly string[]): string[] {
  return [...new Set([...existing, ...toAdd])];
}

// Atomic: every addBlocks/addBlockedBy reference is validated (exists in this session's graph, not
// a self-reference) BEFORE any row -- the target row, or any other field on the row being updated --
// is mutated. A validation failure leaves the whole graph byte-identical to before the call.
export function updateTask(sessionId: string, input: TaskUpdateInput): TaskUpdateResult {
  const map = sessionMap(sessionId);
  const row = map.get(input.taskId);
  if (!row) return { ok: false, error: { kind: "not_found", taskId: input.taskId } };

  const addBlocks = input.addBlocks ?? [];
  const addBlockedBy = input.addBlockedBy ?? [];

  for (const target of addBlocks) {
    if (target === input.taskId) return { ok: false, error: { kind: "self_reference", taskId: input.taskId, field: "addBlocks" } };
    if (!map.has(target)) return { ok: false, error: { kind: "unknown_reference", taskId: input.taskId, field: "addBlocks", missing: target } };
  }
  for (const target of addBlockedBy) {
    if (target === input.taskId) return { ok: false, error: { kind: "self_reference", taskId: input.taskId, field: "addBlockedBy" } };
    if (!map.has(target)) return { ok: false, error: { kind: "unknown_reference", taskId: input.taskId, field: "addBlockedBy", missing: target } };
  }

  if (input.subject !== undefined) row.subject = input.subject;
  if (input.description !== undefined) row.description = input.description;
  if (input.activeForm !== undefined) row.activeForm = input.activeForm;
  if (input.status !== undefined) row.status = input.status;
  if (input.owner !== undefined) row.owner = input.owner;
  if (input.metadata !== undefined) row.metadata = { ...(row.metadata ?? {}), ...input.metadata };

  // Reflection: mirrored onto the OTHER side's opposite list -- "A blocks X" (A.addBlocks=[X]) is
  // simultaneously "X is blocked by A" (X.blockedBy gains A), and symmetrically for addBlockedBy.
  // Existence was already proven above, so `map.get(target)!` is safe.
  if (addBlocks.length > 0) {
    row.blocks = unionMerge(row.blocks, addBlocks);
    for (const target of addBlocks) {
      const targetRow = map.get(target)!;
      targetRow.blockedBy = unionMerge(targetRow.blockedBy, [row.id]);
    }
  }
  if (addBlockedBy.length > 0) {
    row.blockedBy = unionMerge(row.blockedBy, addBlockedBy);
    for (const target of addBlockedBy) {
      const targetRow = map.get(target)!;
      targetRow.blocks = unionMerge(targetRow.blocks, [row.id]);
    }
  }

  return { ok: true, row };
}
