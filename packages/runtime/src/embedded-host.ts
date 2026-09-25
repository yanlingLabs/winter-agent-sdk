// WS-23 (embedded chat/dispatch): the HOST half -- a `SpawnedRuntimeProcess` over one Bun `Worker`
// running `embedded-worker.ts`. A host hands it to `query()` through `Options.spawnClaudeCodeProcess`
// (WS-04 §8's "a supervising daemon" row), and the wrapper, the projector, the approval bridge and
// `sdk_mcp_call` then run unchanged: the bytes on `stdout` are the same NDJSON frames a spawned
// `winter` writes.
//
// LIGHT ON PURPOSE: this module imports no part of the runtime graph (only `Queue` and types), so a
// daemon can import it on its main thread without evaluating a dead copy of the engine there.
//
// LIFECYCLE, and the three facts it is built on (measured on Bun 1.3.14):
//   - `process.exit(code)` inside a Worker closes only that Worker; every message it posted first is
//     delivered, then `close` fires with the code;
//   - an uncaught throw OR an unhandled rejection inside a Worker reaches the host as an `error`
//     event and closes the Worker -- the host process survives (a rejection closes with code 0, so the
//     code alone cannot be trusted to say "crashed": a Worker that closes WITHOUT its `exit` message
//     is reported as a failure regardless of the close code);
//   - `terminate()` stops even a Worker spinning in synchronous code (51 ms in the investigation's probe).
//
// `exited` SETTLES WHEN THE WORKER HAS CLOSED, never earlier -- the difference from `testing.ts`'s
// `inMemoryProcess`, whose `kill()` resolves `exited` while its engine is still running. A host that
// resumes the session next (Winter's `WinterSession.open()` awaits the previous iteration, which ends
// with this stream) must not overlap two engines on one transcript: the lease is stamped with the pid,
// and every Worker shares the host's pid, so the lock itself cannot tell them apart.
import type { SpawnedRuntimeProcess, SpawnRuntimeOptions } from "@yanlinglabs/winter-agent-sdk";
import { Queue } from "./protocol/channel.ts";
import type { EmbeddedHostMessage, EmbeddedWorkerMessage, EmbeddedWorkflowWorkerCommand } from "./embedded-protocol.ts";

export type { EmbeddedHostMessage, EmbeddedWorkerMessage, EmbeddedWorkflowWorkerCommand } from "./embedded-protocol.ts";

/**
 * How long `kill()` lets an aborted session unwind before `terminate()`.
 *
 * The abort itself is fast -- process groups die synchronously, the turn is interrupted, the engine's
 * teardown is milliseconds -- so this is a BACKSTOP for a Worker that cannot answer (stuck in
 * synchronous code, or a turn the interrupt could not reach). Long enough that an ordinary abort always
 * finishes inside it: a graceful end closes the transcript lease and MCP clients, which `terminate()`
 * cannot. A host with its own shutdown budget calls `terminate()` itself when that budget runs out.
 */
export const EMBEDDED_KILL_GRACE_MS = 1500;

/** After the `exit` message, how long `close` may take before the host stops waiting for it (a Bun bug guard, never observed). */
const CLOSE_AFTER_EXIT_MS = 2000;

export interface SpawnEmbeddedWorkerOptions {
  /**
   * The Worker entry as THIS host must spell it. In a `bun build --compile` binary that is the plain
   * relative path of the host's own worker file as it was passed to `--compile` (`"./embedded-worker.ts"`
   * beside the main entry) -- a `new URL(…, import.meta.url).href` hangs there. In dev, an absolute path.
   */
  workerEntry: string;
  /** What `query()` handed the spawn hook: `args` (the argv), `env` (the session's whole environment). */
  spawn: SpawnRuntimeOptions;
  /** The workflow worker's spawn command, forwarded to the session (see `workflows/sandbox.ts`). */
  workflowWorkerCommand?: EmbeddedWorkflowWorkerCommand;
  /** Default `EMBEDDED_KILL_GRACE_MS`. */
  killGraceMs?: number;
  /** Test seam over the Worker constructor. The default is `new Worker(entry, { env })`. */
  createWorker?: (entry: string, env: Record<string, string>) => Worker;
}

export interface EmbeddedWorkerProcess extends SpawnedRuntimeProcess {
  /** Hard stop NOW -- the backstop `kill()` arms, exposed for a host whose own budget ran out. Idempotent. */
  terminate(): void;
  /** `running` → (`kill()`) `stopping` → `closed`. `closed` means `exited` has settled. */
  readonly state: "running" | "stopping" | "closed";
}

/**
 * One line naming what went wrong. Bun's Worker `error` message is a multi-line report -- a source
 * excerpt, then `error: <message>`, then stack frames -- so the `error:` line is what is kept; an
 * error without one is reduced to its first non-blank line.
 */
function describeError(event: unknown): string {
  const e = event as { message?: unknown; error?: unknown };
  if (e?.error instanceof Error && e.error.message !== "") return e.error.message;
  if (typeof e?.message === "string" && e.message !== "") {
    const lines = e.message.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    const errorLine = lines.find((l) => /^(\w*Error|error):/.test(l));
    return (errorLine ?? lines[0] ?? e.message).slice(0, 500);
  }
  return "unknown worker error";
}

/**
 * Construct the Worker, send `start`, and return the process handle. Never throws for a Worker that
 * fails to LOAD (an unresolvable entry is an `error` event + `close`, measured) -- that surfaces as an
 * exit with code 1 and the reason on `stderr`, which the wrapper maps to "exited before init".
 */
export function spawnEmbeddedWorker(opts: SpawnEmbeddedWorkerOptions): EmbeddedWorkerProcess {
  const stdout = new Queue<string>();
  const stderr = new Queue<string>();
  const graceMs = opts.killGraceMs ?? EMBEDDED_KILL_GRACE_MS;

  let state: "running" | "stopping" | "closed" = "running";
  let exitCode: number | undefined;
  let crashed = false;
  let terminatedByHost = false;
  let stdinEnded = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  let settleExited!: (v: { code: number | null; signal: string | null }) => void;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    settleExited = resolve;
  });

  const worker = (opts.createWorker ?? ((entry, env) => new Worker(entry, { env } as WorkerOptions)))(opts.workerEntry, opts.spawn.env);

  const send = (message: EmbeddedHostMessage): void => {
    if (state === "closed") return;
    try {
      worker.postMessage(message);
    } catch {
      /* a Worker that is already gone has nothing left to tell */
    }
  };

  const onClosed = (): void => {
    if (state === "closed") return;
    state = "closed";
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    if (closeTimer !== undefined) clearTimeout(closeTimer);
    // Ordering, as `inMemoryProcess` documents it: end the streams first (buffered chunks still drain
    // from an ended Queue), then settle `exited`, so a consumer racing the two never loses output.
    stdout.end();
    stderr.end();
    // A crash wins over the host's own terminate() (which the error path calls as a belt); a clean
    // `exit` message wins over a close-timer terminate; a Worker the host stopped before it could
    // exit reports the signal a killed child would; a close with no `exit` message and no host stop
    // is a failure whatever its close code says (an unhandled rejection closes with 0).
    if (crashed) settleExited({ code: 1, signal: null });
    else if (exitCode !== undefined) settleExited({ code: exitCode, signal: null });
    else if (terminatedByHost) settleExited({ code: null, signal: "SIGKILL" });
    else settleExited({ code: 1, signal: null });
  };

  const terminate = (): void => {
    if (state === "closed") return;
    if (exitCode === undefined) terminatedByHost = true;
    try {
      worker.terminate();
    } catch {
      /* already gone */
    }
    // `terminate()` fires `close` asynchronously; nothing further is delivered from a terminated Worker.
  };

  worker.onmessage = (event: MessageEvent) => {
    const message = event.data as EmbeddedWorkerMessage;
    switch (message.kind) {
      case "stdout":
        stdout.write(message.chunk);
        return;
      case "stderr":
        stderr.write(message.chunk);
        return;
      case "exit":
        exitCode = message.code;
        closeTimer = setTimeout(terminate, CLOSE_AFTER_EXIT_MS);
        (closeTimer as { unref?: () => void }).unref?.();
        return;
    }
  };
  // ALWAYS attached, before anything can fail (WS-23 spike #1): an unhandled Worker error is how an
  // unresolvable entry, an uncaught throw and an unhandled rejection all arrive.
  worker.onerror = (event: ErrorEvent) => {
    crashed = exitCode === undefined;
    try {
      (event as { preventDefault?: () => void }).preventDefault?.();
    } catch {
      /* not cancelable: nothing to prevent */
    }
    stderr.write(`winter: embedded runtime worker failed: ${describeError(event)}\n`);
    // Bun closes the Worker after an unhandled error (measured); terminate() is the belt.
    terminate();
  };
  worker.addEventListener("messageerror", () => {
    crashed = exitCode === undefined;
    stderr.write("winter: embedded runtime worker sent a message the host could not decode\n");
    terminate();
  });
  worker.addEventListener("close", onClosed);

  send({ kind: "start", argv: [...opts.spawn.args], ...(opts.workflowWorkerCommand !== undefined ? { workflowWorkerCommand: opts.workflowWorkerCommand } : {}) });

  const kill = (_signal?: string): void => {
    if (state !== "running") {
      // A second kill -- the wrapper's own SIGKILL escalation, 50 ms after its first kill() -- does NOT
      // cut the grace short. That escalation is calibrated for an OS child whose SIGTERM handler dies
      // synchronously; this session's graceful end is asynchronous (the engine unwinds, closes its MCP
      // clients and its transcript lease), and terminating it at 50 ms would throw exactly that away.
      // The grace timer armed by the first kill() is the backstop either way.
      return;
    }
    state = "stopping";
    send({ kind: "abort" });
    if (!stdinEnded) {
      stdinEnded = true;
      send({ kind: "stdin-end" });
    }
    graceTimer = setTimeout(terminate, graceMs);
    (graceTimer as { unref?: () => void }).unref?.();
  };

  if (opts.spawn.signal !== undefined) {
    if (opts.spawn.signal.aborted) kill();
    else opts.spawn.signal.addEventListener("abort", () => kill(), { once: true });
  }

  return {
    stdin: {
      write(chunk: string) {
        if (stdinEnded) return;
        send({ kind: "stdin", chunk });
      },
      end() {
        if (stdinEnded) return;
        stdinEnded = true;
        send({ kind: "stdin-end" });
      },
    },
    stdout,
    stderr,
    kill,
    terminate,
    exited,
    // A virtual handle: the session shares the host's pid, and hosts MUST NOT require one (WS-04 §1.1).
    pid: null,
    get state() {
      return state;
    },
  };
}
