// WS-06 §3.4 "TaskCreate/TaskGet/TaskList/TaskUpdate" -- the real executors (Phase 3, Lane D / Task
// 6). Registers over the four stub descriptors descriptors/task-{create,get,list,update}.ts already
// put in the registry (registry.ts's own header: "every later lane's REAL executor lives in a
// SIBLING tools/impl/*.ts file that imports replaceExecutor"). All graph state/semantics (session
// scoping, bidirectional dependency reflection, soft delete) live in ../task-graph-store.ts, which
// this file's own header documents in full -- this file is the thin unknown-input-parsing +
// wire-formatting layer over that store, mirroring Lane A's read.ts / Lane B's edit.ts shape.
//
// *** T8 SCHEMA-SWEEP NOTES (report these in task-6-report.md) ***
//   1. TaskUpdate has NO pinned RESULT shape anywhere in WS-06 §3.4 (only its INPUT schema and the
//      "dependency/ownership semantics MUST be implemented" prose are pinned). Advisor-endorsed
//      choice: mirror TaskGet's own exact pinned 6-field shape (id/subject/description/status/
//      blocks/blockedBy) on success -- the closest already-pinned sibling shape, reused rather than
//      inventing a new one from nothing.
//   2. TaskGet's not-found branch is a pinned, non-error success case ("...or null") -- this
//      executor's `output` is the bare text "null" with `isError` UNSET, deliberately distinct from
//      TaskUpdate's not-found (a real error: updating a nonexistent id is caller error, not a valid
//      query outcome). Comment kept at each call site below, not just here, so the asymmetry reads
//      as a decision, not an inconsistency.
//   3. TaskList's result envelope is UNPINNED (no outputSchema on the TaskList stub, unlike
//      CronList's spine-pinned `{jobs: [...]}` -- verified by reading descriptors/task-list.ts and
//      descriptors/cron-list.ts directly before writing this). Chosen shape: a BARE JSON array of
//      compact rows, matching WS-06's own phrasing ("-> compact rows (...)") literally rather than
//      inventing a wrapper key CronList's text doesn't have either (CronList's own wrapper key
//      choice was the SPINE's call, made before this lane started, not evidence of a house style to
//      match). Flagged for whoever eventually reconciles wire shapes across the whole tool surface.
//   4. Every field in every result object below is either UNCONDITIONAL (TaskGet's blocks/
//      blockedBy, TaskList's blockedBy) or OPTIONAL-VIA-CONDITIONAL-SPREAD keyed to the spec's own
//      `?` marks (TaskList's owner). Unconditional fields are never omitted, including as empty
//      arrays -- see task-graph-store.ts's own row shape.
//
// R3-4 note (per this lane's brief -- record in task-6-report.md, not just here): model-family
// availability (hiddenWhenFamilyTaskNative) is a REGISTRY-side gate already encoded on each stub's
// `availability` (descriptors/task-*.ts, set by Task 1). This executor layer has no gating logic of
// its own and does not need any -- a call that reaches this file at all has already cleared
// advertisement-time availability; execution-time behavior is identical regardless of family.
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
// Self-sufficiency (Lane A precedent, read.ts): this file is not yet wired into engine.ts's own
// import graph (T8/controller's job -- nothing production-side imports tools/impl/*.ts today,
// verified before writing this), so it forces the stub barrel itself rather than assuming some
// OTHER already-imported module got there first.
import "../descriptors/index.ts";
import {
  createTask,
  getTask,
  listTasks,
  updateTask,
  type TaskCreateInput,
  type TaskStatus,
  type TaskUpdateError,
  type TaskUpdateInput,
} from "../task-graph-store.ts";

// --- Shared micro-validators (deliberately duplicated per impl/*.ts file across this lane's six
// files rather than factored into a new shared module -- the task-6 brief's file list is exactly
// six impl files + the store + sibling tests; a seventh shared file is out of brief scope and this
// lane never touches another lane's files, so the safest, most self-contained choice is a few
// duplicated lines per file, exactly mirroring how Lane A's read.ts is fully self-contained). ------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((e) => typeof e === "string" && e.length > 0);
}

const TASK_STATUSES: readonly TaskStatus[] = ["pending", "in_progress", "completed", "deleted"];

function errorResult(message: string): ToolResultPayload {
  return { output: `Error: ${message}`, isError: true };
}

// --- TaskCreate --------------------------------------------------------------------------------

function parseCreateInput(raw: unknown): TaskCreateInput {
  if (!isPlainObject(raw)) throw new Error("input must be an object");
  const subject = raw["subject"];
  const description = raw["description"];
  if (!isNonEmptyString(subject)) throw new Error("subject must be a non-empty string");
  if (!isNonEmptyString(description)) throw new Error("description must be a non-empty string");
  const activeForm = raw["activeForm"];
  if (activeForm !== undefined && typeof activeForm !== "string") throw new Error("activeForm must be a string");
  const metadata = raw["metadata"];
  if (metadata !== undefined && !isPlainObject(metadata)) throw new Error("metadata must be an object");
  return {
    subject,
    description,
    ...(activeForm !== undefined ? { activeForm } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

async function executeCreate(rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  let input: TaskCreateInput;
  try {
    input = parseCreateInput(rawInput);
  } catch (e) {
    return errorResult((e as Error).message);
  }
  const row = createTask(ctx.sessionId, input);
  // WS-06 §3.4: "-> id/subject." -- exactly these two fields, nothing else, even though the store
  // row carries more (Winter MUST NOT invent/rename/re-type pinned fields).
  return { output: JSON.stringify({ id: row.id, subject: row.subject }) };
}

// --- TaskGet -----------------------------------------------------------------------------------

function parseTaskIdInput(raw: unknown): { taskId: string } {
  if (!isPlainObject(raw)) throw new Error("input must be an object");
  const taskId = raw["taskId"];
  if (!isNonEmptyString(taskId)) throw new Error("taskId must be a non-empty string");
  return { taskId };
}

async function executeGet(rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  let input: { taskId: string };
  try {
    input = parseTaskIdInput(rawInput);
  } catch (e) {
    return errorResult((e as Error).message);
  }
  const row = getTask(ctx.sessionId, input.taskId);
  // Pinned success branch, not an error (T8 note 2 above): "or null" is part of the CONTRACT, not a
  // failure mode -- querying an id that does not exist is a normal, expected outcome.
  if (!row) return { output: "null" };
  // WS-06 §3.4 pins exactly these 6 fields for TaskGet -- NOT owner/metadata, even though both are
  // real fields on the stored row (TaskList separately pins `owner?`, TaskGet does not; honored
  // literally rather than "helpfully" adding fields the spec's own per-tool shape omits).
  return {
    output: JSON.stringify({
      id: row.id,
      subject: row.subject,
      description: row.description,
      status: row.status,
      blocks: row.blocks,
      blockedBy: row.blockedBy,
    }),
  };
}

// --- TaskList ------------------------------------------------------------------------------------

async function executeList(_rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  // No input fields to validate (`{}`) -- WS-06 §3.4 TaskList takes no arguments.
  const rows = listTasks(ctx.sessionId);
  // T8 note 3 above: bare array, no wrapper envelope (unpinned shape).
  return { output: JSON.stringify(rows) };
}

// --- TaskUpdate ----------------------------------------------------------------------------------

function parseUpdateInput(raw: unknown): TaskUpdateInput {
  if (!isPlainObject(raw)) throw new Error("input must be an object");
  const taskId = raw["taskId"];
  if (!isNonEmptyString(taskId)) throw new Error("taskId must be a non-empty string");

  const subject = raw["subject"];
  if (subject !== undefined && typeof subject !== "string") throw new Error("subject must be a string");
  const description = raw["description"];
  if (description !== undefined && typeof description !== "string") throw new Error("description must be a string");
  const activeForm = raw["activeForm"];
  if (activeForm !== undefined && typeof activeForm !== "string") throw new Error("activeForm must be a string");
  const owner = raw["owner"];
  if (owner !== undefined && typeof owner !== "string") throw new Error("owner must be a string");

  const status = raw["status"];
  if (status !== undefined && (typeof status !== "string" || !TASK_STATUSES.includes(status as TaskStatus))) {
    throw new Error(`status must be one of ${TASK_STATUSES.join(", ")} (got ${JSON.stringify(status)})`);
  }

  const addBlocks = raw["addBlocks"];
  if (addBlocks !== undefined && !isStringArray(addBlocks)) throw new Error("addBlocks must be an array of non-empty strings");
  const addBlockedBy = raw["addBlockedBy"];
  if (addBlockedBy !== undefined && !isStringArray(addBlockedBy)) throw new Error("addBlockedBy must be an array of non-empty strings");

  const metadata = raw["metadata"];
  if (metadata !== undefined && !isPlainObject(metadata)) throw new Error("metadata must be an object");

  return {
    taskId,
    ...(subject !== undefined ? { subject } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(activeForm !== undefined ? { activeForm } : {}),
    ...(status !== undefined ? { status: status as TaskStatus } : {}),
    ...(addBlocks !== undefined ? { addBlocks } : {}),
    ...(addBlockedBy !== undefined ? { addBlockedBy } : {}),
    ...(owner !== undefined ? { owner } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function describeUpdateError(error: TaskUpdateError): string {
  switch (error.kind) {
    case "not_found":
      return `no such task: ${error.taskId}`;
    case "self_reference":
      return `${error.field} cannot reference the task's own id (${error.taskId})`;
    case "unknown_reference":
      return `${error.field} references an unknown task id: ${error.missing}`;
  }
}

async function executeUpdate(rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  let input: TaskUpdateInput;
  try {
    input = parseUpdateInput(rawInput);
  } catch (e) {
    return errorResult((e as Error).message);
  }
  const result = updateTask(ctx.sessionId, input);
  // Unlike TaskGet's not-found (a valid query outcome), TaskUpdate targeting a nonexistent id IS an
  // error -- the caller asked to mutate a specific row that isn't there (T8 note 2 above).
  if (!result.ok) return errorResult(describeUpdateError(result.error));
  const row = result.row;
  // T8 note 1 above: mirrors TaskGet's own pinned 6-field shape -- no result shape is pinned for
  // TaskUpdate itself.
  return {
    output: JSON.stringify({
      id: row.id,
      subject: row.subject,
      description: row.description,
      status: row.status,
      blocks: row.blocks,
      blockedBy: row.blockedBy,
    }),
  };
}

// --- Wiring ----------------------------------------------------------------------------------------

replaceExecutor("TaskCreate", { execute: executeCreate } satisfies ToolExecutor);
replaceExecutor("TaskGet", { execute: executeGet } satisfies ToolExecutor);
replaceExecutor("TaskList", { execute: executeList } satisfies ToolExecutor);
replaceExecutor("TaskUpdate", { execute: executeUpdate } satisfies ToolExecutor);
