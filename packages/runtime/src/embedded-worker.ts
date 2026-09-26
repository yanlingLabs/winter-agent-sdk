// WS-23 (embedded chat/dispatch): the Worker ENTRY -- the module a host constructs one Bun `Worker`
// from per session, bridging `postMessage` to `runEmbeddedSession`.
//
// Protocol (`embedded-protocol.ts`): `start` once, then `stdin` chunks / `stdin-end` / `abort` in any
// order; out go `stdout`/`stderr` chunks and, last, `exit`. After `exit` this Worker ends itself with
// `process.exit(code)`, which inside a Worker closes only the Worker (measured on Bun 1.3.14: every
// message posted before it is delivered first, then the host sees `close` with that code).
//
// THE ENVIRONMENT IS THE WORKER'S OWN `process.env`, never a copy from the start message. The host
// sets it with the Worker's `env` option, and that one object is what matters twice over: it is the
// session's `env` (homes, run-home variables, the test-provider alias) AND what Bash, Monitor and a
// stdio MCP server inherit through their `{...process.env}` spawns. Passing a second copy in the
// message would let the two disagree.
//
// A HOST MUST NOT IMPORT THIS ON ITS MAIN THREAD FOR ANY OTHER REASON. Importing it evaluates the whole
// runtime graph in that realm. The `isMainThread` guard makes such an import inert (a package smoke
// test imports every published entry), but the graph is still evaluated; the host-side bridge lives
// in `embedded-host.ts`, which imports none of it.
//
// COMPILED-BINARY NOTE for hosts: in a `bun build --compile` binary the Worker must be constructed
// from its PLAIN entry path string, with the host's own worker file passed as an extra compile
// entrypoint -- `new Worker(new URL(..., import.meta.url).href)` hangs silently there (WS-23 spike #1).
import { isMainThread } from "node:worker_threads";
import { Queue } from "./protocol/channel.ts";
import { runEmbeddedSession } from "./embedded.ts";
import type { EmbeddedHostMessage, EmbeddedWorkerMessage } from "./embedded-protocol.ts";

declare const self: { onmessage: ((event: MessageEvent) => void) | null };

function post(message: EmbeddedWorkerMessage): void {
  postMessage(message);
}

/**
 * M-1 (WS-23 review): `process.chdir` and the SETTER form of `process.umask` are PROCESS-wide even
 * inside a Worker (measured: a Worker's `chdir` moved the host daemon's cwd). Nothing in the runtime,
 * provider-runtime or sdk sources calls either (`embedded-guards.test.ts` greps for it); inside an
 * embedded session they throw, so a future call -- or a plugin's -- fails loudly in its own session
 * instead of silently moving every other session and the host. The umask GETTER still works.
 */
function fenceProcessWideState(): void {
  const readUmask = process.umask.bind(process) as () => number;
  process.chdir = ((directory: string): void => {
    throw new Error(`process.chdir(${JSON.stringify(directory)}) is refused inside an embedded Winter session: the working directory is process-wide and the host daemon's; pass the session cwd explicitly instead`);
  }) as typeof process.chdir;
  process.umask = ((mask?: string | number): number => {
    if (mask !== undefined) throw new Error("process.umask(mask) is refused inside an embedded Winter session: the file-mode mask is process-wide and the host daemon's");
    return readUmask();
  }) as typeof process.umask;
}

function installEmbeddedWorker(): void {
  fenceProcessWideState();
  const input = new Queue<string>();
  const abort = new AbortController();
  let started = false;

  const run = async (start: Extract<EmbeddedHostMessage, { kind: "start" }>): Promise<void> => {
    let code = 1;
    try {
      code = await runEmbeddedSession({
        argv: start.argv,
        env: process.env,
        input,
        write: (chunk) => post({ kind: "stdout", chunk }),
        writeErr: (chunk) => post({ kind: "stderr", chunk }),
        signal: abort.signal,
        ...(start.workflowWorkerCommand !== undefined ? { workflowWorkerCommand: start.workflowWorkerCommand } : {}),
      });
    } catch (err) {
      // `runEmbeddedSession` never throws by contract; this is the belt for a host that would
      // otherwise see a Worker vanish with no exit message at all.
      post({ kind: "stderr", chunk: `winter: fatal (embedded worker): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n` });
      code = 1;
    }
    post({ kind: "exit", code });
    process.exit(code);
  };

  self.onmessage = (event: MessageEvent) => {
    const message = event.data as EmbeddedHostMessage;
    switch (message.kind) {
      case "start":
        if (started) return; // exactly once; a second start is a host bug, never a second session in this realm
        started = true;
        void run(message);
        return;
      case "stdin":
        input.write(message.chunk);
        return;
      case "stdin-end":
        input.end();
        return;
      case "abort":
        abort.abort();
        return;
    }
  };
}

if (!isMainThread) installEmbeddedWorker();
