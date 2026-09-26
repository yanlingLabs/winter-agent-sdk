// WS-23 test fixture (embedded.test.ts, review M-1/M-3): the REAL Worker entry (`embedded-worker.ts`,
// imported for its side effect -- the production bridge and the process-wide fences) plus a second
// message listener that misbehaves DURING a session, once the host has sent its first stdin chunk.
// `WINTER_EMBEDDED_CRASH_FIXTURE` (the Worker's own env) picks how:
//   throw  -- an uncaught throw from a timer, mid-turn;
//   reject -- an unhandled rejection, mid-turn;
//   fences -- tries `process.chdir` and `process.umask(mask)` and reports each outcome on stderr.
// Never shipped: `*.fixture.ts` is not an export entry and is excluded from the declarations.
import "./embedded-worker.ts";
import { isMainThread } from "node:worker_threads";

declare const self: { addEventListener(type: "message", listener: (event: MessageEvent) => void): void };

if (!isMainThread) {
  const mode = process.env.WINTER_EMBEDDED_CRASH_FIXTURE;
  let armed = false;
  const report = (chunk: string): void => postMessage({ kind: "stderr", chunk });
  self.addEventListener("message", (event: MessageEvent) => {
    if ((event.data as { kind?: string }).kind !== "stdin" || armed) return;
    armed = true;
    setTimeout(() => {
      if (mode === "throw") throw new Error("fixture: thrown during an embedded session");
      if (mode === "reject") void Promise.reject(new Error("fixture: rejected during an embedded session"));
      if (mode === "fences") {
        for (const [label, act] of [
          ["chdir", () => process.chdir("/")],
          ["umask", () => process.umask(0o022)],
        ] as const) {
          try {
            act();
            report(`fence ${label}: ALLOWED\n`);
          } catch (err) {
            report(`fence ${label}: refused (${(err as Error).message})\n`);
          }
        }
        report(`fence umask-read: ${typeof process.umask()}\n`);
      }
    }, 300);
  });
}
