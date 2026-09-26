// WS-24: ASYNC HOOKS -- a command hook that runs in the BACKGROUND, never blocking the call or the event
// that fired it, whose later output reaches the model at the next safe point.
//
// TWO DOORS, ONE MECHANISM (both are claude's, and a plugin written against claude uses either):
//   1. DECLARED: a settings/plugin command handler with `async: true` (from-config.ts). The command
//      invoker starts it and answers the runner at once, `{async: true}`.
//   2. ANNOUNCED: a command hook whose FIRST stdout line is `{"async": true, "asyncTimeout"?: <ms>}`. The
//      invoker answers the runner with that line the moment it arrives and lets the process run on; the
//      rest of its stdout is its eventual output.
// Either way the runner reads `{async: true}` as "ran, no opinion" (runner.ts), and the job is ADOPTED
// by this queue, which owns it from then on: its timeout, its kill, and what it finally says.
//
// WHAT AN ASYNC HOOK CAN SAY, and what it cannot. By the time it finishes, the call it was fired for has
// already run (or been refused) and the event has moved on, so it can NEVER allow, deny, ask, defer,
// rewrite an input or a result, block a prompt or stop a turn: every decision-shaped field of its output
// -- `permissionDecision`, `decision`, `updatedInput`, `continue`, an exit code 2 -- is IGNORED, by
// construction (`finishedOutput` reads two fields and nothing else). What it can do is TALK:
// `systemMessage` and `hookSpecificOutput.additionalContext` (or, for the three events whose plain-text
// stdout is context, that text) are queued here and delivered by the engine at the next safe point --
// the next time it appends hook context before a request (`flushPendingHookAttachments`: after a tool
// round's results, with the next prompt, after a compaction) -- as ONE harness reminder per finished hook
// (`async_hook_response`, hooks/additional-context.ts). Never mid-request: the queue is only ever read
// between requests.
//
// FAIL-CLOSED FLOORS STAY SYNCHRONOUS. A fail-closed `PreToolUse`/`PermissionRequest` hook exists to gate
// the call, which an answer that arrives afterwards cannot do: `async` on one is refused at registration
// (from-config.ts -- the hook is kept, synchronous, and the refusal reported), and an `{"async": true}`
// line from one is malformed output (runner.ts's strict mode denies; the invoker never backgrounds it).
//
// BOUNDED, like every other hook contribution (hooks/bounds.ts):
//   - a TIMEOUT per job: the handler's own `timeout` (seconds, from the settings block), else the
//     announced `asyncTimeout` (milliseconds, claude's unit), else `DEFAULT_ASYNC_HOOK_TIMEOUT_MS`.
//     A job past it is SIGKILLed (its whole process group) and says nothing;
//   - a CAP on concurrent jobs (`MAX_RUNNING_ASYNC_HOOKS`): past it a new job is refused -- killed at
//     once, never queued behind the others -- with one diagnostic line;
//   - a CAP on finished outputs waiting for delivery (`MAX_PENDING_ASYNC_HOOK_OUTPUTS`): past it the
//     OLDEST is dropped and the next delivery says how many were;
//   - every text capped at `MAX_HOOK_TEXT_CHARS`;
//   - SESSION END: `dispose()` kills every running job and forgets every undelivered output (the engine's
//     teardown, beside the background shells' sweep). A job's group is also in the process-group ledger
//     (process-groups.ts) from spawn to exit, so an embedded host reaps it if the Worker dies first.
import type { HookEvent } from "@yanlinglabs/winter-agent-sdk";
import { capHookText } from "./bounds.ts";

/** Ten minutes: background work (a test run after an edit, a lint of the tree) is minutes, not seconds -- the gating hooks' 60 s would cut it off. */
export const DEFAULT_ASYNC_HOOK_TIMEOUT_MS = 600_000;
/** Concurrent background hooks per session. A PostToolUse hook on every call of a 50-call burst must not become 50 processes. */
export const MAX_RUNNING_ASYNC_HOOKS = 16;
/** Finished outputs waiting for the next safe point. At `MAX_HOOK_TEXT_CHARS` each, one delivery stays far below the per-message cap. */
export const MAX_PENDING_ASYNC_HOOK_OUTPUTS = 16;

/** One finished async hook's model-facing output. */
export interface AsyncHookOutput {
  /** `<Event>` or `<Event>:<tool name>` -- the same naming the synchronous context attachments use. */
  hookName: string;
  systemMessage?: string;
  additionalContext?: string;
  toolUseID?: string;
}

/** What `drain()` returns: finished outputs, oldest first, plus how many were dropped for the pending cap. */
export interface AsyncHookDrain {
  outputs: AsyncHookOutput[];
  dropped: number;
}

/** A backgrounded invocation as the command invoker hands it over. */
export interface AsyncHookJob {
  event: HookEvent;
  hookName: string;
  toolUseID?: string;
  /** Settles when the process has exited, with what `finishedOutput` needs. Never rejects. */
  finished: Promise<FinishedHookProcess>;
  /** SIGKILL the job's whole process group. Idempotent. */
  kill: () => void;
  timeoutMs: number;
}

/** A background process's end state. */
export interface FinishedHookProcess {
  exitCode: number | null;
  stdout: string;
}

export interface AsyncHookQueue {
  /** Take ownership of a backgrounded job. `false` (and the job killed) when the concurrency cap is reached or the queue is disposed. */
  adopt(job: AsyncHookJob): boolean;
  /** Finished outputs since the last drain, oldest first. Empties the queue. */
  drain(): AsyncHookDrain;
  /** Jobs still running. */
  running(): number;
  /** Session end: kill every running job, forget every undelivered output. Idempotent. */
  dispose(): void;
}

/** The events whose plain-text stdout is model context (command-invoker.ts's PLAIN_STDOUT_CONTEXT_EVENTS). */
const PLAIN_STDOUT_CONTEXT_EVENTS: ReadonlySet<HookEvent> = new Set(["UserPromptSubmit", "SessionStart", "SubagentStart"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What a finished background hook SAYS -- `systemMessage` and `additionalContext`, nothing else (see this
 * file's header). Only a clean exit counts: a non-zero exit (2 included -- a block it can no longer
 * perform) or a kill says nothing. `stdout` is everything AFTER an announced `{"async": true}` line.
 */
export function finishedOutput(event: HookEvent, finished: FinishedHookProcess): Pick<AsyncHookOutput, "systemMessage" | "additionalContext"> {
  if (finished.exitCode !== 0) return {};
  const trimmed = finished.stdout.trim();
  if (trimmed.length === 0) return {};
  if (!trimmed.startsWith("{")) return PLAIN_STDOUT_CONTEXT_EVENTS.has(event) ? { additionalContext: capHookText(trimmed) } : {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {}; // malformed: a synchronous hook's error, a background hook's silence
  }
  if (!isRecord(parsed)) return {};
  const out: Pick<AsyncHookOutput, "systemMessage" | "additionalContext"> = {};
  if (typeof parsed["systemMessage"] === "string" && parsed["systemMessage"].length > 0) out.systemMessage = capHookText(parsed["systemMessage"]);
  const hso = parsed["hookSpecificOutput"];
  if (isRecord(hso) && typeof hso["additionalContext"] === "string" && hso["additionalContext"].length > 0) out.additionalContext = capHookText(hso["additionalContext"]);
  return out;
}

export interface AsyncHookQueueOptions {
  maxRunning?: number;
  maxPending?: number;
  /** Where a refused, failed or timed-out job is reported (one line each). Defaults to stderr. */
  warn?: (line: string) => void;
}

export function createAsyncHookQueue(opts: AsyncHookQueueOptions = {}): AsyncHookQueue {
  const maxRunning = opts.maxRunning ?? MAX_RUNNING_ASYNC_HOOKS;
  const maxPending = opts.maxPending ?? MAX_PENDING_ASYNC_HOOK_OUTPUTS;
  const warn = opts.warn ?? ((line: string) => console.error(line));
  const running = new Set<AsyncHookJob>();
  const pending: AsyncHookOutput[] = [];
  let dropped = 0;
  let disposed = false;

  return {
    adopt(job: AsyncHookJob): boolean {
      if (disposed || running.size >= maxRunning) {
        job.kill();
        if (!disposed) warn(`winter: async hook ${job.hookName} was not started: ${maxRunning} async hooks are already running in this session`);
        return false;
      }
      running.add(job);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        job.kill();
      }, job.timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      void job.finished.then((finished) => {
        clearTimeout(timer);
        if (!running.delete(job) || disposed) return; // disposed: the session is over, nobody is left to tell
        if (timedOut) {
          warn(`winter: async hook ${job.hookName} was killed after ${job.timeoutMs} ms`);
          return;
        }
        const said = finishedOutput(job.event, finished);
        if (said.systemMessage === undefined && said.additionalContext === undefined) return;
        pending.push({ hookName: job.hookName, ...said, ...(job.toolUseID !== undefined ? { toolUseID: job.toolUseID } : {}) });
        while (pending.length > maxPending) {
          pending.shift();
          dropped++;
        }
      });
      return true;
    },
    drain(): AsyncHookDrain {
      const out = { outputs: pending.splice(0), dropped };
      dropped = 0;
      return out;
    },
    running: () => running.size,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const job of running) job.kill();
      running.clear();
      pending.length = 0;
      dropped = 0;
    },
  };
}
