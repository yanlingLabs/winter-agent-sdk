// WS-23 test fixture (embedded.test.ts): a Worker entry that misbehaves the two ways a host must
// survive -- it THROWS on `start` (an uncaught error inside the Worker), or, given `--spin` in the
// argv, it spins synchronously forever (only `terminate()` can stop it). Never shipped: `*.fixture.ts`
// is excluded from the build's declarations and is not an export entry.
import { isMainThread } from "node:worker_threads";

declare const self: { onmessage: ((event: MessageEvent) => void) | null };

if (!isMainThread) {
  self.onmessage = (event: MessageEvent) => {
    const message = event.data as { kind: string; argv?: string[] };
    if (message.kind !== "start") return;
    if (message.argv?.includes("--spin")) {
      for (;;) {
        /* a Worker stuck in synchronous code */
      }
    }
    throw new Error("fixture: the embedded worker threw");
  };
}
