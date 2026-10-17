/** Prospective guided host-query executable entry. SOURCE ONLY: no packet, compile entry, launcher or
 * Root path references this file yet, and the SDK host guard still refuses confined required-context
 * queries. It mirrors the v1 entry's fixed inherited-FD ABI; the reader channel is the fifth descriptor
 * the native owner receives with the bootstrap record, never a numbered argument. It must never call the
 * v1 or fresh factory: only the guided one admits the five-descriptor guided record. */
import { writeSync } from "node:fs";
import { admitGuidedHostQueryLinuxSession } from "./linux-session-admission.ts";
import { runAdmittedLinuxSession } from "./linux-session-entry.ts";

if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["--native-bootstrap-fd", "3", "--native-owner-fd", "4"])) throw new Error("fixed native entry required");
/** Fixed stdio, synchronous bounded writes: downstream backpressure cannot create a JS output queue.
 * Blocking this runtime pipe never blocks the supervisor's independent receipt/cancellation loop. */
function writeHeldStdio(fd: 1 | 2, chunk: string): void {
  const bytes = Buffer.from(chunk);
  for (let offset = 0; offset < bytes.length;) {
    let count: number;
    try { count = writeSync(fd, bytes, offset, bytes.length - offset); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EINTR") continue; throw error; }
    if (count === 0) throw new Error("runtime stdio unavailable");
    offset += count;
  }
}
const admission = admitGuidedHostQueryLinuxSession(3, 4);
try {
process.exitCode = await runAdmittedLinuxSession({
  admission,
  input: (async function* () {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for await (const chunk of process.stdin) {
      const text = decoder.decode(chunk, { stream: true });
      if (text) yield text;
    }
    const tail = decoder.decode(); if (tail) yield tail;
  })(),
  write: chunk => writeHeldStdio(1, chunk), writeErr: chunk => writeHeldStdio(2, chunk),
  // Observations only. Runtime return never supplies native release authority.
  onProtectedStoreOwnershipOutcome(outcome) { writeHeldStdio(2, JSON.stringify({ hostQueryStoreOutcome: outcome }) + "\n"); },
});
} finally {
  // A pending stdin read must not keep a returned runtime alive after logical end_input.
  // Process/store death is still established by the supervisor, not by this close.
  process.stdin.destroy();
}
