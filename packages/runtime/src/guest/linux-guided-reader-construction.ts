/** Cleanup boundary used by native admission and injected failure tests. This
 * constructs only protocol bookkeeping, never an admission/owner capability. */
import { createLinuxGuidedReaderChannel, type LinuxGuidedReaderChannel, type LinuxGuidedReaderWire } from "./linux-guided-reader-channel.ts";
import type { LinuxGuidedReaderRegistration } from "./linux-guided-reader-protocol.ts";
export function constructLinuxGuidedReaderChannel(options: {
  registration: LinuxGuidedReaderRegistration; createWire(): LinuxGuidedReaderWire;
  assertOwnerHeld(): void; closeOwner(): void;
}): LinuxGuidedReaderChannel {
  let wire: LinuxGuidedReaderWire | undefined;
  try {
    wire = options.createWire();
    return createLinuxGuidedReaderChannel({ registration: options.registration, wire, assertOwnerHeld: options.assertOwnerHeld });
  } catch {
    try { wire?.close(); } catch { /* Preserve uncertainty; still close the owner. */ }
    try { options.closeOwner(); } catch { /* Never expose protected native diagnostics. */ }
    throw new Error("required_context_unavailable");
  }
}
/** Symbol availability is only an ABI requirement, never owner admission. */
export function assertLinuxGuidedReaderSymbols(symbols: unknown): void {
  if (!symbols || typeof symbols !== "object") throw new Error("required_context_unavailable");
  for (const name of ["winter_owner_claim_reader", "winter_owner_reader_shutdown"]) {
    const field = Object.getOwnPropertyDescriptor(symbols, name);
    if (!field || !("value" in field) || typeof field.value !== "function") throw new Error("required_context_unavailable");
  }
}
