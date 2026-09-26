// WS-23 test fixture (embedded.test.ts, review M-1/M-3): the REAL Worker entry (`embedded-worker.ts`,
// imported for its side effect -- the production bridge and the process-wide fences) plus a second
// message listener that misbehaves DURING a session, once the host has sent its first stdin chunk.
// `WINTER_EMBEDDED_CRASH_FIXTURE` (the Worker's own env) picks how:
//   throw  -- an uncaught throw from a timer, mid-turn;
//   reject -- an unhandled rejection, mid-turn;
//   fences -- tries `process.chdir` and `process.umask(mask)` and reports each outcome on stderr.
// WS-24 (process groups): each starts a real detached group through the PRODUCTION spawn site
// (`sandbox/spawn.ts`'s `runCommand`, unsandboxed) and reports `group <pid>` on stderr once it is born:
//   orphan-spin  -- a `sleep 60`, then spins synchronously at once (only `terminate()` ends the Worker,
//                   and the engine's teardown never runs);
//   orphan-throw -- a `sleep 60`, then an uncaught throw (a crash);
//   group-done   -- a `sleep 0.2`, awaited, then `group-done <pid>` (the group was born AND ended);
//   task-group   -- a `sleep 60` tracked as a background TASK, so the embedded abort's synchronous
//                   sweep (`killAllTaskProcessGroups`) kills it just before the session exits.
// Never shipped: `*.fixture.ts` is not an export entry and is excluded from the declarations.
import "./embedded-worker.ts";
import { isMainThread } from "node:worker_threads";
import { runCommand } from "./sandbox/spawn.ts";
import { startTracking } from "./tools/impl/background-task-runtime.ts";

declare const self: { addEventListener(type: "message", listener: (event: MessageEvent) => void): void };

if (!isMainThread) {
  const mode = process.env.WINTER_EMBEDDED_CRASH_FIXTURE;
  let armed = false;
  const report = (chunk: string): void => postMessage({ kind: "stderr", chunk });
  self.addEventListener("message", (event: MessageEvent) => {
    if ((event.data as { kind?: string }).kind !== "stdin" || armed) return;
    armed = true;
    if (mode === "orphan-spin" || mode === "orphan-throw" || mode === "group-done" || mode === "task-group") {
      const done = runCommand({
        command: mode === "group-done" ? "sleep 0.2" : "sleep 60",
        cwd: "/",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        timeoutMs: 120_000,
        settings: { enabled: false },
        onSpawned: ({ pid }) => {
          if (mode === "task-group") startTracking({ taskId: "fixture-task-group", kind: "bash", outputPath: "/dev/null", description: "sleep", pid });
          report(`group ${pid}\n`);
          if (mode === "orphan-throw") setTimeout(() => {
            throw new Error("fixture: crashed with a live process group");
          }, 50);
          // Synchronously, right here: the ledger's `add` and the report above are both already posted.
          if (mode === "orphan-spin") {
            for (;;) {
              /* a Worker stuck in synchronous code: no teardown will ever run */
            }
          }
        },
      });
      if (mode === "group-done") void done.then(() => report("group-done\n"));
      return;
    }
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
