// WS-06 §3.4 "ScheduleWakeup" -- the real executor (Phase 3, Lane D / Task 6). Registers over the
// stub descriptor descriptors/schedule-wakeup.ts already in the registry. "The self-paced loop
// primitive, not a general timer" -- this module STORES a session's own pending wakeups and VALIDATES
// input; actually waking the session back up at the scheduled wall-clock moment is host/daemon
// behavior a later phase owns (identical framing to cron.ts's own "STORE and validate" scope note).
//
// Session-scoped (Map<sessionId, PendingWakeup[]>): a "self-paced loop" is inherently a PER-SESSION
// concept -- a session paces its OWN loop, and `stop` cancels THIS session's own pending wakeups, not
// some other session's. No AvailabilityPredicate/registry state is touched here; this is pure
// bookkeeping the executor owns end-to-end.
//
// *** T8 SCHEMA-SWEEP NOTES (report in task-6-report.md) ***
//   1. Result shape is DISJOINT by branch, not five-fields-always-present. WS-06's own text:
//      "Result: scheduledFor, clampedDelaySeconds, wasClamped, stopped?/cancelledWakeups?." Read as
//      TWO mutually exclusive shapes rather than one five-field object with two optional members:
//      the descriptor's own outputSchema (descriptors/schedule-wakeup.ts) sets NO `required` array
//      at the JSON-Schema level (structurally consistent with either reading), and a `stop` call
//      fabricating a fake scheduledFor/clampedDelaySeconds/wasClamped for a schedule that was never
//      created would be actively misleading. Advisor-endorsed.
//   2. "Unless stop, delaySeconds/reason/prompt/noop are logically required" is implemented
//      LITERALLY: all four, including `noop`, must be present (any boolean value satisfies `noop` --
//      only `undefined`/absent fails it) whenever `stop` is not `true`. WS-06 gives no runtime
//      MEANING for `noop` beyond "logically required" -- this executor never inspects its value
//      beyond presence-checking it; interpreting what a noop-true wakeup should actually DO at fire
//      time is host/daemon behavior for the same later phase that owns actual firing. Flagged: the
//      combination "prompt AND noop both required together" reads oddly (a genuinely no-op wakeup
//      requiring a prompt string it may never use) -- implemented as pinned rather than silently
//      inventing a prompt-xor-noop relaxation WS-06's text does not state.
//   3. Validation reports the FIRST missing/malformed required field, not an aggregate list -- WS-06's
//      own phrasing is singular ("naming the missing field"), and every sibling executor in this
//      lane (task-graph.ts, cron.ts, todo-write.ts) already reports one violation at a time.
//
// *** T8 SCHEMA-SWEEP FIX (envelope reconciliation via ephemeral capture against the pinned 0.3.250
//     artifact -- derived-shapes-p3-task8.md) ***
//   `scheduledFor` was implemented as an ISO-8601 string (`Date.prototype.toISOString()`); the
//   pinned `ScheduleWakeupOutput.scheduledFor` is a NUMBER (doc-asserted in the pinned artifact as
//   an epoch-ms timestamp for the next wakeup, restated here in this file's own words -- see
//   derived-shapes-p3-task8.md's own naming discipline). Fixed to `Date.now() + clampedDelaySeconds
//   * 1000` directly (no ISO conversion). Separately: the pinned `ScheduleWakeupInput.delaySeconds`
//   carries NO JSON-Schema `minimum`/`maximum` -- only a doc comment describing runtime clamping to
//   [60, 3600] (again doc-asserted, not schema-enforced), matching this executor's own clamp constants
//   exactly. descriptors/schedule-wakeup.ts previously declared `minimum: 60, maximum: 3600` at the
//   schema level, which is both unpinned AND in tension with this executor's own clamp-not-reject
//   behavior (a strict schema-validating caller could reject an out-of-range value before this
//   executor's own "clamps a delay below the 60s floor" behavior is ever reached -- the "one is
//   unreachable" the brief names). Fixed by removing the schema-level bounds there; the runtime clamp
//   below is now the ONLY enforcement, matching the pinned contract.
import { randomUUID } from "node:crypto";
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
// Self-sufficiency (Lane A precedent, read.ts): see task-graph.ts's identical comment.
import "../descriptors/index.ts";

const MIN_DELAY_SECONDS = 60;
const MAX_DELAY_SECONDS = 3600;

interface PendingWakeup {
  id: string;
  scheduledFor: number;
}

// --- Session-scoped pending-wakeup store -----------------------------------------------------------

const sessions = new Map<string, PendingWakeup[]>();

function sessionList(sessionId: string): PendingWakeup[] {
  let list = sessions.get(sessionId);
  if (!list) {
    list = [];
    sessions.set(sessionId, list);
  }
  return list;
}

// Test-only escape hatch (task-graph-store.ts / background-tasks.ts precedent).
export function resetScheduleWakeupStoreForTest(sessionId?: string): void {
  if (sessionId === undefined) sessions.clear();
  else sessions.delete(sessionId);
}

// --- Input parsing -----------------------------------------------------------------------------

type ParsedInput = { kind: "stop" } | { kind: "schedule"; delaySeconds: number; reason: string; prompt: string; noop: boolean };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseInput(raw: unknown): ParsedInput {
  if (!isPlainObject(raw)) throw new Error("input must be an object");

  const stop = raw["stop"];
  if (stop !== undefined && typeof stop !== "boolean") throw new Error("stop must be a boolean");
  if (stop === true) return { kind: "stop" };

  const delaySeconds = raw["delaySeconds"];
  if (delaySeconds === undefined) throw new Error("delaySeconds is required unless stop is true");
  if (typeof delaySeconds !== "number" || !Number.isFinite(delaySeconds)) throw new Error("delaySeconds must be a finite number");

  const reason = raw["reason"];
  if (reason === undefined) throw new Error("reason is required unless stop is true");
  if (typeof reason !== "string" || reason.length === 0) throw new Error("reason must be a non-empty string");

  const prompt = raw["prompt"];
  if (prompt === undefined) throw new Error("prompt is required unless stop is true");
  if (typeof prompt !== "string" || prompt.length === 0) throw new Error("prompt must be a non-empty string");

  const noop = raw["noop"];
  if (noop === undefined) throw new Error("noop is required unless stop is true");
  if (typeof noop !== "boolean") throw new Error("noop must be a boolean");

  return { kind: "schedule", delaySeconds, reason, prompt, noop };
}

// --- Dispatch --------------------------------------------------------------------------------------

async function execute(rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  let input: ParsedInput;
  try {
    input = parseInput(rawInput);
  } catch (e) {
    return { output: `Error: ${(e as Error).message}`, isError: true };
  }

  if (input.kind === "stop") {
    const list = sessionList(ctx.sessionId);
    const cancelledWakeups = list.length;
    list.length = 0;
    return { output: JSON.stringify({ stopped: true, cancelledWakeups }) };
  }

  const clampedDelaySeconds = Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, input.delaySeconds));
  const wasClamped = clampedDelaySeconds !== input.delaySeconds;
  // Pinned shape: epoch-ms number, not an ISO string (T8 schema-sweep fix above).
  const scheduledFor = Date.now() + clampedDelaySeconds * 1000;

  sessionList(ctx.sessionId).push({ id: randomUUID(), scheduledFor });

  return { output: JSON.stringify({ scheduledFor, clampedDelaySeconds, wasClamped }) };
}

replaceExecutor("ScheduleWakeup", { execute } satisfies ToolExecutor);
