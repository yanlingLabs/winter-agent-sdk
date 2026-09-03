// WS-06 §3.4 "TaskCreate/TaskGet/TaskList/TaskUpdate" -- the real executors (Phase 3, Lane D / Task
// 6). Registers over the four stub descriptors descriptors/task-{create,get,list,update}.ts already
// put in the registry (registry.ts's own header: "every later lane's REAL executor lives in a
// SIBLING tools/impl/*.ts file that imports replaceExecutor"). All graph state/semantics (session
// scoping, bidirectional dependency reflection, soft delete) live in ../task-graph-store.ts, which
// this file's own header documents in full -- this file is the thin unknown-input-parsing +
// wire-formatting layer over that store, mirroring Lane A's read.ts / Lane B's edit.ts shape.
//
// *** T8 SCHEMA-SWEEP NOTES (originally written during task-6; corrected+superseded by Task 8's own
//     envelope-reconciliation sweep -- see derived-shapes-p3-task8.md for the ephemeral-capture
//     evidence against the pinned @anthropic-ai/claude-agent-sdk@0.3.250 artifact) ***
//   1. TaskUpdate's RESULT envelope WAS unpinned in WS-06 §3.4 prose (only its INPUT schema is
//      spelled out there); Task 8's capture found it after all in the pinned artifact's own
//      `sdk-tools.d.ts`: `{ success: boolean; taskId: string; updatedFields: string[]; error?:
//      string; statusChange?: { from: string; to: string } }`. This SUPERSEDES the task-6 choice of
//      mirroring TaskGet's 6-field shape (an advisor-endorsed guess made absent better information --
//      now superseded by direct evidence, not a case of silently narrowing a ruling).
//   2. TaskGet's not-found branch is a pinned, non-error success case ("...or null") -- Task 8's
//      capture confirms the wrapper applies to BOTH branches (`{ task: {...} | null }`), so the
//      not-found branch now emits genuine JSON `{"task":null}` rather than the old bare 4-character
//      text "null" (a strict improvement: still non-error, now actually parseable-as-the-pinned-shape
//      by a caller that JSON.parses every result uniformly). Still deliberately distinct from
//      TaskUpdate's own not-found (a real error there: see note 1's `success:false` path, which is
//      itself never the tool-call-level `isError` -- only input-SHAPE failures are).
//   3. TaskList's result envelope: WS-06's own prose ("-> compact rows (...)") does not mention a
//      wrapper key, and CronList's own prose ("-> jobs with ...") does -- task-6 read this contrast
//      as "TaskList is genuinely unpinned, unlike CronList". Task 8's capture shows BOTH are pinned
//      wrapper objects (`{ tasks: [...] }` / `{ jobs: [...] }`); WS-06's prose paraphrase simply
//      dropped the wrapper word for TaskList (and, per note 1, for TaskCreate/TaskGet too) while
//      keeping it for CronList -- a paraphrase gap, not a real absence of a pinned shape. Fixed to
//      `{ tasks: [...] }`.
//   4. TaskCreate: WS-06 prose says "-> id/subject" with no wrapper; Task 8's capture shows
//      `{ task: { id, subject } }`. Same paraphrase-gap pattern as note 3. Fixed to wrap.
//   5. Every field in every result object below is either UNCONDITIONAL (TaskGet's blocks/
//      blockedBy, TaskList's blockedBy) or OPTIONAL-VIA-CONDITIONAL-SPREAD keyed to the spec's own
//      `?` marks (TaskList's owner, TaskUpdate's error/statusChange). Unconditional fields are never
//      omitted, including as empty arrays -- see task-graph-store.ts's own row shape.
//   6. `updatedFields`/`statusChange` are NOT resolvable from WS-06 prose OR from the pinned
//      artifact's own doc comments (the interface carries no field-level documentation, unlike
//      ScheduleWakeupOutput's richly-commented fields) -- two further judgment calls, flagged here
//      rather than silently invented: (a) `updatedFields` reports the RESULT ROW's own field names
//      (`blocks`/`blockedBy`), not the input's verb-prefixed parameter names (`addBlocks`/
//      `addBlockedBy`), since the field is describing what changed on the row, not which input keys
//      were passed; (b) `statusChange` is emitted only when `status` was part of the input AND the
//      value actually differs from the row's prior status (a same-value "update" to the status
//      already in place is not reported as a change) -- the more conservative of the two readings the
//      bare field name supports.
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
  // Pinned shape (T8 note 4 above): { task: { id, subject } } -- exactly these two inner fields,
  // nothing else, even though the store row carries more (Winter MUST NOT invent/rename/re-type
  // pinned fields), wrapped under `task` per the ephemeral-capture correction.
  return { output: JSON.stringify({ task: { id: row.id, subject: row.subject } }) };
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
  // failure mode -- querying an id that does not exist is a normal, expected outcome. Wrapped per the
  // pinned `{ task: {...} | null }` shape -- genuine JSON `{"task":null}`, not a bare "null" string.
  //
  // A soft-deleted row is treated identically to "no such row" (advisor-caught gap, T8 review):
  // `getTask` is a bare store lookup that does NOT exclude `status: "deleted"` rows the way
  // `listTasks` does -- so without this check, TaskGet on a deleted id would return
  // `{task: {..., status: "deleted"}}`, a value OUTSIDE the pinned 3-member status union
  // ("pending"|"in_progress"|"completed", no "deleted" -- see derived-shapes-p3-task8.md item (b)).
  // The pin's own status union is only explicable if a read never observes "deleted" at all, so
  // TaskGet extends the same soft-delete-and-exclude treatment WS-06 already pins for TaskList.
  if (!row || row.status === "deleted") return { output: JSON.stringify({ task: null }) };
  // WS-06 §3.4 pins exactly these 6 fields for TaskGet's inner `task` object -- NOT owner/metadata,
  // even though both are real fields on the stored row (TaskList separately pins `owner?`, TaskGet
  // does not; honored literally rather than "helpfully" adding fields the spec's own per-tool shape
  // omits).
  return {
    output: JSON.stringify({
      task: {
        id: row.id,
        subject: row.subject,
        description: row.description,
        status: row.status,
        blocks: row.blocks,
        blockedBy: row.blockedBy,
      },
    }),
  };
}

// --- TaskList ------------------------------------------------------------------------------------

async function executeList(_rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  // No input fields to validate (`{}`) -- WS-06 §3.4 TaskList takes no arguments.
  const rows = listTasks(ctx.sessionId);
  // T8 note 3 above: pinned shape is `{ tasks: [...] }`, not a bare array.
  return { output: JSON.stringify({ tasks: rows }) };
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

// Maps a TaskUpdateInput key to the ROW field it actually changes, for `updatedFields` (T8 note 6
// above: reports the result row's own field names, not the input's verb-prefixed parameter names).
const UPDATE_INPUT_TO_ROW_FIELD: ReadonlyArray<readonly [keyof TaskUpdateInput, string]> = [
  ["subject", "subject"],
  ["description", "description"],
  ["activeForm", "activeForm"],
  ["status", "status"],
  ["addBlocks", "blocks"],
  ["addBlockedBy", "blockedBy"],
  ["owner", "owner"],
  ["metadata", "metadata"],
];

function computeUpdatedFields(input: TaskUpdateInput): string[] {
  return UPDATE_INPUT_TO_ROW_FIELD.filter(([inputKey]) => input[inputKey] !== undefined).map(([, rowField]) => rowField);
}

async function executeUpdate(rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  let input: TaskUpdateInput;
  try {
    input = parseUpdateInput(rawInput);
  } catch (e) {
    return errorResult((e as Error).message);
  }
  // Snapshot the pre-update status as a PRIMITIVE (not a row reference -- updateTask mutates the same
  // stored row object in place, but a string value copies cleanly) -- needed only for `statusChange`.
  const beforeStatus = getTask(ctx.sessionId, input.taskId)?.status;

  const result = updateTask(ctx.sessionId, input);
  // T8 note 1 above: pinned TaskUpdateOutput carries success/error INSIDE a normal (non-isError)
  // result -- unlike input-SHAPE failures (missing/malformed taskId etc, caught above by
  // parseUpdateInput, which remain isError:true: a call that never resolved to a real taskId has
  // nothing to echo back in a {success,taskId,...} shape), TaskUpdate's own DOMAIN failures
  // (not-found / self-reference / unknown-reference) are reported as {success:false, taskId,
  // updatedFields:[], error} at the payload level, confirmed via ephemeral capture against the
  // pinned 0.3.250 artifact (derived-shapes-p3-task8.md) -- superseding task-6's own `errorResult()`
  // choice for this branch (never a case of silently narrowing a ruling: this is new evidence).
  if (!result.ok) {
    return {
      output: JSON.stringify({
        success: false,
        taskId: input.taskId,
        updatedFields: [],
        error: describeUpdateError(result.error),
      }),
    };
  }
  const row = result.row;
  const updatedFields = computeUpdatedFields(input);
  const statusChanged = input.status !== undefined && beforeStatus !== undefined && beforeStatus !== row.status;
  return {
    output: JSON.stringify({
      success: true,
      taskId: row.id,
      updatedFields,
      ...(statusChanged ? { statusChange: { from: beforeStatus, to: row.status } } : {}),
    }),
  };
}

// --- Wiring ----------------------------------------------------------------------------------------

replaceExecutor("TaskCreate", { execute: executeCreate } satisfies ToolExecutor);
replaceExecutor("TaskGet", { execute: executeGet } satisfies ToolExecutor);
replaceExecutor("TaskList", { execute: executeList } satisfies ToolExecutor);
replaceExecutor("TaskUpdate", { execute: executeUpdate } satisfies ToolExecutor);
