// WS-06 §3.4 "TodoWrite" -- the real executor (Phase 3, Lane D / Task 6). Registers over the stub
// descriptor descriptors/todo-write.ts already put in the registry.
//
// Session-scoped whole-list replacement, in-memory, keyed by ToolExecutionContext.sessionId --
// mirrors task-graph-store.ts's own session-keying choice (a `Map<sessionId, Todo[]>` here, since
// TodoWrite's own state shape is a flat list with no graph semantics, it does not warrant a separate
// store module the way the task graph does; the task-6 brief's own file list gives TodoWrite no
// sibling store file, only this one impl file).
//
// *** T8 SCHEMA-SWEEP NOTE (report in task-6-report.md) ***
// WS-06 §3.4 pins TodoWrite's result as "-> oldTodos/newTodos; whole-list replacement" -- read
// literally: `oldTodos` is whatever this SAME session's list held immediately before this call
// (empty array on a session's first-ever call, never `undefined`/`null`), `newTodos` is the list
// just stored (the input's own `todos` array, echoed back verbatim post-validation -- not a
// re-derived or reordered copy).
//
// R3-4/availability note (per this lane's brief): TodoWrite's registry stub already stacks TWO
// gates (hiddenWhenFamilyTaskNative AND requiresFeatures:["todoWrite"], descriptors/todo-write.ts) --
// both are registry-side advertisement gates. This executor has no gating logic of its own; a call
// that reaches this file has already cleared both at advertisement time (see task-graph.ts's own
// identical note for the sibling task-graph tools).
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
// Self-sufficiency (Lane A precedent, read.ts): see task-graph.ts's identical comment.
import "../descriptors/index.ts";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  content: string;
  status: TodoStatus;
  activeForm: string;
}

// --- The store: Map<sessionId, Todo[]> -------------------------------------------------------------

const sessions = new Map<string, Todo[]>();

// Test-only escape hatch (task-graph-store.ts / background-tasks.ts precedent).
export function resetTodoStoreForTest(sessionId?: string): void {
  if (sessionId === undefined) sessions.clear();
  else sessions.delete(sessionId);
}

// --- Input validation --------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const TODO_STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];

function parseTodo(raw: unknown, index: number): Todo {
  if (!isPlainObject(raw)) throw new Error(`todos[${index}] must be an object`);
  const content = raw["content"];
  if (typeof content !== "string" || content.length === 0) throw new Error(`todos[${index}].content must be a non-empty string`);
  const status = raw["status"];
  if (typeof status !== "string" || !TODO_STATUSES.includes(status as TodoStatus)) {
    throw new Error(`todos[${index}].status must be one of ${TODO_STATUSES.join(", ")} (got ${JSON.stringify(status)})`);
  }
  const activeForm = raw["activeForm"];
  if (typeof activeForm !== "string" || activeForm.length === 0) throw new Error(`todos[${index}].activeForm must be a non-empty string`);
  return { content, status: status as TodoStatus, activeForm };
}

function parseInput(raw: unknown): Todo[] {
  if (!isPlainObject(raw)) throw new Error("input must be an object");
  const todos = raw["todos"];
  if (!Array.isArray(todos)) throw new Error("todos must be an array");
  return todos.map((t, i) => parseTodo(t, i));
}

// --- Dispatch --------------------------------------------------------------------------------------

async function execute(rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  let newTodos: Todo[];
  try {
    newTodos = parseInput(rawInput);
  } catch (e) {
    return { output: `Error: ${(e as Error).message}`, isError: true };
  }
  const oldTodos = sessions.get(ctx.sessionId) ?? [];
  sessions.set(ctx.sessionId, newTodos);
  return { output: JSON.stringify({ oldTodos, newTodos }) };
}

replaceExecutor("TodoWrite", { execute } satisfies ToolExecutor);
