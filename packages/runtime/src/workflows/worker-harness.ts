// Phase 5 Lane W (task 4): the IN-PROCESS worker harness -- `workflows/seam.ts`'s own R5-15 note
// names this file by name ("It also keeps the worker harness (Lane W's own `worker-harness.ts`) able
// to run the entry in-process").
//
// It runs the REAL `workflowWorkerMain` over a pair of `PassThrough`s, with the parent side of the
// bridge implemented here, so a test can assert on exactly what the worker wrote without spawning a
// process or needing `sandbox-exec`. That is why R5-15 injects `io` instead of reading `process`.
//
// WHAT IT IS NOT: a second implementation of the parent. `runtime.ts` is the production parent and
// this harness answers with canned values -- it exercises the WORKER, and `runtime.test.ts`
// exercises the two together over a real pipe. Keeping the two separate is what makes a worker bug
// diagnosable: a failure here is the worker's, a failure there is the wiring's.
import { PassThrough } from "node:stream";
import { workflowWorkerMain } from "./subprocess-entry.ts";
import { encodeNdjson, splitNdjson, type BridgeRequest, type BridgeResponse, type WorkerInit, type WorkflowRef } from "./bridge.ts";
import { WORKFLOW_WORKER_ARGV_FLAG, WORKFLOW_WORKER_BRIDGE_FLAG } from "./sandbox.ts";
import type { JournalEntry } from "./journal.ts";
import type { BudgetSnapshot } from "./budget.ts";
import type { WorkerSpawner } from "./runtime.ts";

export interface InProcessWorkerOptions {
  source?: string;
  args?: unknown;
  argv?: string[];
  concurrency?: number;
  totalAgentCap?: number;
  maxItemsPerCall?: number;
  budget?: BudgetSnapshot;
  resumeJournal?: JournalEntry[];
  /** Skip writing an init line at all -- for the undriven-argv cases. */
  skipInit?: boolean;
  /** Write this instead of a well-formed init line (the malformed-init case). */
  rawInit?: string;
  answerAgent?: (req: { prompt: string; opts?: unknown; callId: number }) => Promise<{ value?: unknown; error?: string; budget?: BudgetSnapshot; delayMs?: number }>;
  answerWorkflow?: (ref: WorkflowRef, args: unknown) => Promise<{ ok: true; source: string } | { ok: false; error: string }>;
}

export interface InProcessWorkerResult {
  exitCode: number;
  requests: BridgeRequest[];
  /** The `done` or `error` frame, when one was produced. */
  terminal: BridgeRequest | undefined;
  stdoutLines: string[];
  stderr: string;
}

export async function runWorkerInProcess(opts: InProcessWorkerOptions): Promise<InProcessWorkerResult> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  const requests: BridgeRequest[] = [];
  const stdoutLines: string[] = [];
  let stderrText = "";
  stderr.on("data", (chunk: Buffer) => {
    stderrText += chunk.toString("utf8");
  });

  let carry = "";
  stdout.on("data", (chunk: Buffer) => {
    carry += chunk.toString("utf8");
    const { lines, rest } = splitNdjson(carry);
    carry = rest;
    for (const line of lines) {
      stdoutLines.push(line);
      let request: BridgeRequest;
      try {
        request = JSON.parse(line) as BridgeRequest;
      } catch {
        continue;
      }
      requests.push(request);
      void answer(request);
    }
  });

  async function answer(request: BridgeRequest): Promise<void> {
    if (request.op === "agent") {
      const handler: NonNullable<InProcessWorkerOptions["answerAgent"]> = opts.answerAgent ?? (async (req) => ({ value: `echo:${req.prompt}` }));
      const outcome = await handler({ prompt: request.prompt, callId: request.callId, ...(request.opts !== undefined ? { opts: request.opts } : {}) });
      if (outcome.delayMs !== undefined && outcome.delayMs > 0) await new Promise((r) => setTimeout(r, outcome.delayMs));
      const response: BridgeResponse =
        outcome.error !== undefined
          ? { callId: request.callId, ok: false, error: outcome.error, ...(outcome.budget !== undefined ? { budget: outcome.budget } : {}) }
          : { callId: request.callId, ok: true, value: outcome.value ?? null, ...(outcome.budget !== undefined ? { budget: outcome.budget } : {}) };
      stdin.write(encodeNdjson(response));
      return;
    }
    if (request.op === "workflow") {
      const resolved = await (opts.answerWorkflow ?? (async () => ({ ok: false as const, error: "no nested workflows configured in this harness" })))(request.ref, request.args);
      const response: BridgeResponse = resolved.ok
        ? { callId: request.callId, ok: true, value: { source: resolved.source } }
        : { callId: request.callId, ok: false, error: resolved.error };
      stdin.write(encodeNdjson(response));
    }
  }

  const argv = opts.argv ?? ["winter", WORKFLOW_WORKER_ARGV_FLAG, WORKFLOW_WORKER_BRIDGE_FLAG];
  const running = workflowWorkerMain(argv, { stdin, stdout, stderr });

  if (opts.rawInit !== undefined) {
    stdin.write(opts.rawInit);
  } else if (opts.skipInit !== true) {
    const init: WorkerInit = {
      runId: "wf_harness",
      source: opts.source ?? "return null;",
      args: opts.args,
      concurrency: opts.concurrency ?? 4,
      totalAgentCap: opts.totalAgentCap ?? 1000,
      maxItemsPerCall: opts.maxItemsPerCall ?? 4096,
      budget: opts.budget ?? { total: null, spent: 0 },
      ...(opts.resumeJournal !== undefined ? { resumeJournal: opts.resumeJournal } : {}),
    };
    stdin.write(encodeNdjson(init));
  }

  const exitCode = await running;
  stdin.end();
  return {
    exitCode,
    requests,
    terminal: requests.find((r) => r.op === "done" || r.op === "error"),
    stdoutLines,
    stderr: stderrText,
  };
}

// --- The in-process SPAWNER (runtime.test.ts's engine) ---------------------------------------------
//
// Hands `WorkflowRuntime` a `WorkerProcess` backed by the REAL `workflowWorkerMain` running over a
// PassThrough pair in this process. Every byte still goes through the real NDJSON framing and the
// real correlation logic -- only the `sandbox-exec` fork is elided, which is what
// `runtime.darwin.test.ts` and `scripts/verify-workflow.ts` exist to cover instead.
//
// A `bun test` run of the whole lifecycle therefore costs milliseconds rather than a 60MB compile,
// and a failure points at the runtime or the worker rather than at process plumbing.
//
// **TEST-ONLY. NEVER A PRODUCTION SPAWNER.** (F7.) This leg has NO CONTAINMENT AT ALL: the script
// body runs in the host process, and the in-worker scope shadowing is defence in depth, not a fence
// -- `(function(){}).constructor` reaches the real `Function` from inside a workflow body (measured;
// see script-api.test.ts's own per-route fixtures). A script escaping here reaches the daemon's full
// authority. Production is fail-closed today -- `WorkflowRuntime.launch` refuses when `sandbox-exec`
// is unavailable and no spawner was injected, and the default is `realWorkerSpawner()` -- so this is
// a documentation obligation rather than a live hole. Anyone wiring the three-leg equivalence
// scenario must keep it that way.
export function inProcessWorkerSpawner(): WorkerSpawner {
  return () => {
    const stdin = new PassThrough(); // parent -> worker
    const stdout = new PassThrough(); // worker -> parent
    const stderr = new PassThrough();
    stderr.resume(); // drained, never asserted on here (worker.test.ts owns the stderr contract)

    const exitHandlers: Array<(code: number | null) => void> = [];
    let exited = false;
    const finish = (code: number | null) => {
      if (exited) return;
      exited = true;
      for (const handler of exitHandlers) handler(code);
    };

    void workflowWorkerMain(["winter", WORKFLOW_WORKER_ARGV_FLAG, WORKFLOW_WORKER_BRIDGE_FLAG], { stdin, stdout, stderr })
      .then((code) => finish(code))
      .catch(() => finish(1));

    return {
      stdin,
      stdout,
      onExit: (cb) => exitHandlers.push(cb),
      onError: () => {
        /* an in-process worker has no spawn failure to report */
      },
      kill: () => {
        // The nearest honest analogue of a SIGKILL: the pipes go away and the worker is treated as
        // having died without a terminal frame -- exactly the crash-fallback shape (WS-11 §1.8).
        stdin.end();
        stdout.end();
        finish(null);
      },
    };
  };
}
