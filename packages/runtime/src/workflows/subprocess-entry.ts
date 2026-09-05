// Phase 5 Task 3 (spine) declared this file and RULING R5-15 froze its export's NAME and SIGNATURE;
// Phase 5 Lane W (task 4) replaces the BODY, which is what follows. The signature's own rationale is
// preserved verbatim below because it is still load-bearing:
//
//   - `argv: string[]` is the FULL argv, not a sliced tail. main.ts finds `__workflow-worker` by NAME
//     (never by position) for the same reason its own `--config-json` parsing does: `bun src/main.ts
//     __workflow-worker ...` and the compiled `winter __workflow-worker ...` differ by one leading
//     slot, and index-based parsing silently breaks between the dev and compiled legs.
//   - `io` is INJECTED rather than read from `process`: the NDJSON bridge is the only thing on this
//     process's stdout, and a test that drove the worker through the real `process.stdout` could not
//     assert on what it wrote. It also keeps the worker harness (`worker-harness.ts`) able to run the
//     entry in-process.
//   - the return is an EXIT CODE, not `void`: main.ts exits with it. A worker that threw instead
//     would lose the distinction between "the workflow failed" and "the worker itself broke".
//
// COMPILED-BINARY CONSTRAINTS apply here exactly as they do in main.ts (this module is reachable from
// it, so it is bundled into the single-file executable): no dynamic `import()` of a computed path, no
// `import.meta.dir`-relative resource loads, no `require.resolve` at runtime.
//
// THE ONE THING TO UNDERSTAND ABOUT THIS FILE: it is a MESSAGE PUMP, not a workflow engine. It reads
// one init line, hands the script to `script-api.ts`, and turns that script's capability requests
// into bridge frames. Every decision with consequences -- may this agent spawn, is the budget spent,
// what does `.winter/workflows/<name>.js` contain -- is made by the PARENT, because this process is
// the untrusted one.
import { runWorkflowScript, type AgentBridgeResult, type WorkflowResolveResult } from "./script-api.ts";
import { encodeNdjson, splitNdjson, type BridgeRequest, type BridgeResponse, type WorkerInit, type WorkflowRef } from "./bridge.ts";
import { WORKFLOW_WORKER_ARGV_FLAG, WORKFLOW_WORKER_BRIDGE_FLAG } from "./sandbox.ts";
import type { AgentOpts } from "./types.ts";

/**
 * Returned when the worker role was selected but no parent is driving it (no
 * `--bridge` flag on argv). Distinct from a plain `1` so `verify:workflow` can report "the dispatch
 * works, the worker is not being driven" rather than an indistinguishable generic failure.
 *
 * PRESERVED NAME AND VALUE (the spine's contract test asserts both, and asserts this exact code for
 * a bare `__workflow-worker` argv). Its MEANING widened when the body landed: before, every
 * invocation returned it; now only an undriven one does. That is precisely what makes
 * `verify:workflow` a real RED/GREEN gate -- it drives the worker WITH the bridge flag, so it saw 78
 * against the stub and sees a real run against this body.
 */
export const WORKFLOW_WORKER_NOT_IMPLEMENTED_EXIT_CODE = 78;

/**
 * The worker itself broke -- an unreadable init line, an I/O failure. NOT the code for "the workflow
 * failed": a failed workflow reports through the terminal `error` bridge op and still exits 0,
 * because the parent already knows what happened and a non-zero code there would make a script bug
 * indistinguishable from a runtime bug (R5-15's own stated reason for returning a code at all).
 */
export const WORKFLOW_WORKER_BROKEN_EXIT_CODE = 70;

export async function workflowWorkerMain(
  argv: string[],
  io: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
): Promise<number> {
  // Flags BY NAME (R5-15). `argv` is the full argv and the dev/compiled legs differ by a leading slot.
  if (!argv.includes(WORKFLOW_WORKER_BRIDGE_FLAG)) {
    // Diagnostics go to STDERR only -- stdout is reserved for the NDJSON bridge exclusively, exactly
    // as main.ts reserves it for the frame stream (WS-04 §2/§6).
    io.stderr.write(
      `winter: ${WORKFLOW_WORKER_ARGV_FLAG} was invoked without ${WORKFLOW_WORKER_BRIDGE_FLAG}; there is no parent driving the bridge, so there is nothing to run\n`,
    );
    return WORKFLOW_WORKER_NOT_IMPLEMENTED_EXIT_CODE;
  }

  // Defense in depth, under the seatbelt (carried from Norma's port). Do NOT null `process` here --
  // the entry itself needs stdio; the SCRIPT cannot see it either way, because script-api.ts shadows
  // it in the script's own scope.
  for (const name of ["fetch", "XMLHttpRequest", "WebSocket"]) {
    try {
      (globalThis as Record<string, unknown>)[name] = undefined;
    } catch {
      /* non-configurable on some hosts -- the seatbelt's `(deny network*)` is the real fence */
    }
  }

  const lines = new LineQueue(io.stdin);
  const writes: Array<Promise<void>> = [];
  const post = (message: BridgeRequest): void => {
    // The write is TRACKED, not fire-and-forget: main.ts calls `process.exit(code)` the instant this
    // function resolves, and an unflushed terminal frame would be lost -- the parent would then see
    // the child close with no terminal message and report the crash fallback for a run that actually
    // succeeded. Norma's original papered over the same race with a 50ms `setTimeout` before exiting.
    writes.push(writeAndFlush(io.stdout, encodeNdjson(message)));
  };

  let init: WorkerInit;
  try {
    const first = await lines.next();
    if (first === undefined) throw new Error("stdin closed before the init line arrived");
    init = JSON.parse(first) as WorkerInit;
    if (typeof init?.source !== "string") throw new Error("the init line carries no `source`");
  } catch (err) {
    io.stderr.write(`winter: workflow worker could not read its init line: ${errorText(err)}\n`);
    return WORKFLOW_WORKER_BROKEN_EXIT_CODE;
  }

  // Request/reply correlation. Replies are keyed by `callId` and may arrive in ANY order -- with a
  // concurrency cap above 1 they routinely do, which is why this is a map and not a queue.
  let nextCallId = 1;
  const pending = new Map<number, (response: BridgeResponse) => void>();
  const call = (build: (callId: number) => BridgeRequest): Promise<BridgeResponse> =>
    new Promise<BridgeResponse>((resolve) => {
      const callId = nextCallId++;
      pending.set(callId, resolve);
      post(build(callId));
    });

  const pump = (async () => {
    for (;;) {
      const line = await lines.next();
      if (line === undefined) return; // parent went away; any still-pending call is settled below
      let response: BridgeResponse;
      try {
        response = JSON.parse(line) as BridgeResponse;
      } catch {
        continue; // a malformed reply is not worth killing a run over; the parent's own framing is authoritative
      }
      const settle = pending.get(response.callId);
      if (settle === undefined) continue;
      pending.delete(response.callId);
      settle(response);
    }
  })();
  // The parent closing stdin mid-run must not leave the script awaiting forever: every outstanding
  // call is refused, which surfaces in-script as a throw and terminates the run through `error`.
  void pump.then(() => {
    for (const [callId, settle] of pending) {
      pending.delete(callId);
      settle({ callId, ok: false, error: "the workflow host closed the bridge" });
    }
  });

  const agent = async (prompt: string, opts?: AgentOpts): Promise<AgentBridgeResult> => {
    const response = await call((callId) => ({ op: "agent", callId, prompt, ...(opts !== undefined ? { opts } : {}) }));
    return response.ok
      ? { ok: true, value: response.value, ...(response.budget !== undefined ? { budget: response.budget } : {}) }
      : { ok: false, error: response.error, ...(response.budget !== undefined ? { budget: response.budget } : {}) };
  };

  const resolveWorkflow = async (ref: WorkflowRef, args: unknown): Promise<WorkflowResolveResult> => {
    const response = await call((callId) => ({ op: "workflow", callId, ref, ...(args !== undefined ? { args } : {}) }));
    if (!response.ok) return { ok: false, error: response.error };
    const source = (response.value as { source?: unknown } | null)?.source;
    if (typeof source !== "string") return { ok: false, error: `the workflow host returned no source for ${JSON.stringify(ref)}` };
    return { ok: true, source };
  };

  try {
    const { result } = await runWorkflowScript({
      source: init.source,
      args: init.args,
      concurrency: init.concurrency,
      totalAgentCap: init.totalAgentCap,
      maxItemsPerCall: init.maxItemsPerCall,
      budget: init.budget,
      agent,
      resolveWorkflow,
      phase: (title) => post({ op: "phase", title }),
      log: (message) => post({ op: "log", message }),
      ...(init.resumeJournal !== undefined ? { resumeJournal: init.resumeJournal } : {}),
    });
    post({ op: "done", result });
  } catch (err) {
    post({ op: "error", message: errorText(err) });
  }
  // Every frame is on the wire before the exit code goes back to main.ts.
  await Promise.all(writes);
  return 0;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolves once the chunk is handed to the OS, so a terminal frame cannot be lost to `process.exit`. */
function writeAndFlush(stream: NodeJS.WritableStream, chunk: string): Promise<void> {
  return new Promise<void>((resolve) => {
    // `write`'s callback fires when the chunk is flushed (or errored) -- either way there is nothing
    // further this process can do about it, and hanging the exit on a broken pipe would be worse.
    stream.write(chunk, () => resolve());
  });
}

/**
 * NDJSON line reader over a Node readable. Deliberately a tiny class rather than an async iterator
 * over the stream: the worker must be able to read exactly ONE line (the init) and then hand the
 * remainder to a long-running pump, which `for await` over the stream itself makes awkward.
 */
class LineQueue {
  private buffer = "";
  private readonly ready: string[] = [];
  private readonly waiters: Array<(line: string | undefined) => void> = [];
  private ended = false;

  constructor(stream: NodeJS.ReadableStream) {
    stream.on("data", (chunk: Buffer | string) => {
      this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const { lines, rest } = splitNdjson(this.buffer);
      this.buffer = rest;
      for (const line of lines) this.push(line);
    });
    const end = () => {
      this.ended = true;
      while (this.waiters.length > 0) this.waiters.shift()!(undefined);
    };
    stream.on("end", end);
    stream.on("close", end);
    stream.on("error", end);
    stream.resume();
  }

  private push(line: string): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(line);
    else this.ready.push(line);
  }

  next(): Promise<string | undefined> {
    const queued = this.ready.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.ended) return Promise.resolve(undefined);
    return new Promise<string | undefined>((resolve) => this.waiters.push(resolve));
  }
}
