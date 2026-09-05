// Phase 5 Lane W (task 4): the NDJSON stdio bridge between the sandboxed worker subprocess and the
// daemon. Ported from Norma's `workflows/bridge.ts` (D8/D11) and widened for the CC contract.
//
// DIRECTIONS. Worker -> parent is `BridgeRequest`: `agent` and `workflow` are request/reply (each
// awaits a `BridgeResponse` keyed by `callId`); `log`/`phase` are one-way; `done`/`error` are
// terminal one-way. Parent -> worker is one `WorkerInit` line, then `BridgeResponse` lines forever.
//
// `parallel` and `pipeline` need NO op of their own -- they are pure in-worker JS wrappers over
// `agent()` (script-api.ts). That is not an optimisation: giving them ops would move a script's own
// control flow into the daemon, which is the process that is NOT allowed to run script logic.
//
// WIDENINGS over Norma's original, each traceable to WS-11 §1.6:
//   - `workflow` (the one-level nesting op): the WORKER cannot resolve `.winter/workflows/<name>.js`
//     -- it has no filesystem reads worth trusting and no notion of the session's project root -- so
//     resolution is a parent round trip that answers with the child's SOURCE.
//   - `budget` rides on every response, so a script's `budget.remaining()` is truthful without a
//     round trip of its own, and the worker can refuse a doomed call locally.
//   - `WorkerInit` carries the caps (`concurrency`/`totalAgentCap`/`maxItemsPerCall`) as DATA rather
//     than the worker re-deriving `min(16, CPUs - 2)` from ITS OWN `os.cpus()`. The worker runs under
//     a seatbelt on the same machine, so it would usually agree -- but "usually agrees" is how two
//     copies of a cap drift, and the runtime-side semaphore is the authoritative one either way.
import type { AgentOpts } from "./types.ts";
import type { BudgetSnapshot } from "./budget.ts";

/** Worker -> parent. */
export type BridgeRequest =
  | { op: "agent"; callId: number; prompt: string; opts?: AgentOpts }
  | { op: "workflow"; callId: number; ref: WorkflowRef; args?: unknown }
  | { op: "log"; message: string }
  // F8. One-way, emitted EXACTLY ONCE, the first time a resumed run diverges from its journal (or at
  // the end of a fully-cached run). `cachedPrefix` is how many leading `agent()` calls replayed from
  // cache -- a number only the WORKER knows, because `diverged` latches privately inside the script
  // API and a cached call never reaches the bridge at all.
  //
  // Why the parent needs it: a resume allocates a fresh runId, so run B's journal starts empty and
  // only its LIVE calls get appended. Without this op a resume-of-a-resume replays nothing (a 0%
  // hit, flatly contradicting §1.5's "same script + same args -> 100% cache hit"). The parent cannot
  // simply pre-seed run B's journal with run A's entries either: on a MID-journal divergence at k
  // that would leave stale entries sitting in the positions run B's live results must occupy. Knowing
  // k is what makes the copy exact.
  | { op: "resumed"; cachedPrefix: number }
  | { op: "phase"; title: string }
  | { op: "done"; result: unknown }
  | { op: "error"; message: string };

/** WS-11 §1.6's `workflow(nameOrRef, args?)`: "a saved name or `{scriptPath}`". */
export type WorkflowRef = { name: string } | { scriptPath: string };

/**
 * Parent -> worker: the reply to an `agent`/`workflow` request.
 *
 * `ok: true, value: null` is a MEANINGFUL, non-error outcome for `agent` -- WS-11 §1.6: "Resolves
 * `null` when the user skips the agent or it dies on a terminal error -- callers filter with
 * `.filter(Boolean)`." `ok: false` is reserved for the conditions that must THROW inside the script
 * (the total-agent cap, the budget ceiling, an unresolvable nested workflow), because those are
 * conditions a `.filter(Boolean)` must not be able to swallow.
 */
export type BridgeResponse =
  | { callId: number; ok: true; value: unknown; budget?: BudgetSnapshot }
  | { callId: number; ok: false; error: string; budget?: BudgetSnapshot };

/** The single init line the parent writes on spawn, before anything else. */
export interface WorkerInit {
  runId: string;
  source: string;
  args: unknown;
  /** `min(16, CPUs - 2)`, resolved parent-side (semaphore.ts). */
  concurrency: number;
  /** WS-11 §1.6: 1000 total agents per run. Mirrored so the worker can fail fast; enforced parent-side regardless. */
  totalAgentCap: number;
  /** WS-11 §1.6: 4096 items max per `parallel`/`pipeline` call -- an EXPLICIT error, entirely in-worker (the parent never sees the array). */
  maxItemsPerCall: number;
  budget: BudgetSnapshot;
  /** WS-11 §1.5: the prior run's ordered agent() results. Absent/empty for a fresh run. */
  resumeJournal?: Array<{ promptKey: string; value: unknown }>;
}

/**
 * The framing both ends share. Deliberately a FUNCTION over a string buffer rather than a class:
 * the worker and the runtime both need it, the worker's copy is bundled into the compiled binary,
 * and a shared pure function has no lifecycle to get wrong on either side.
 *
 * Returns the complete lines found and the unconsumed remainder, which the caller carries forward --
 * a `data` chunk may split a line in half or coalesce ten of them.
 */
export function splitNdjson(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let rest = buffer;
  for (;;) {
    const idx = rest.indexOf("\n");
    if (idx < 0) break;
    const line = rest.slice(0, idx);
    rest = rest.slice(idx + 1);
    if (line.trim() !== "") lines.push(line);
  }
  return { lines, rest };
}

/** One NDJSON frame, terminator included. One place, so the two ends cannot disagree about the newline. */
export function encodeNdjson(value: unknown): string {
  return JSON.stringify(value) + "\n";
}
