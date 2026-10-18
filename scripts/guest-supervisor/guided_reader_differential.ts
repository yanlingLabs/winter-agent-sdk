/** Differential driver for test_guided_reader_service.py. Reads one JSON document on stdin and answers every case with what the
 * TypeScript source of truth (linux-guided-reader-protocol.ts) decides. It opens no socket, spawns nothing and admits no owner. */
import { decodeLinuxGuidedReaderFrame, linuxGuidedReaderCancel, linuxGuidedReaderStart, parseLinuxGuidedReaderRegistration,
  type LinuxGuidedReaderRegistration } from "../../packages/runtime/src/guest/linux-guided-reader-protocol.ts";

interface Case { op: "decode" | "build_start" | "build_cancel" | "request" | "roundtrip" | "registration"; hex?: string; readId?: string;
  contextRequestId?: string; bindingId?: string; text?: string; value?: unknown; registration?: number }
// Index 0 is the registration as Root's record carries it (key-sorted, since the supervisor serialises with sort_keys). Index 1 is the same
// registration with the owner keys in the SDK's own declaration order, to prove ordering is the guest's, not Root's.
const input = JSON.parse(await Bun.stdin.text()) as { registrations: string[]; cases: Case[] };
const registrations: LinuxGuidedReaderRegistration[] = input.registrations.map(text => parseLinuxGuidedReaderRegistration(JSON.parse(text)));
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const frameOf = (value: unknown) => { const body = Buffer.from(JSON.stringify(value)); const out = Buffer.alloc(body.length + 4); out.writeUInt32BE(body.length); body.copy(out, 4); return out.toString("hex"); };
function request(hex: string, registration: LinuxGuidedReaderRegistration): boolean {
  // A request frame is valid exactly when it is byte-identical to what the guest's own builders and encoder emit for the fields it carries.
  const body = Buffer.from(hex, "hex"); const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body); const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const ordered = Object.keys(parsed.owner ?? {});
  const owner = Object.fromEntries(ordered.map(key => [key, (registration.owner as Record<string, unknown>)[key]]));
  const same = { ...registration, owner } as unknown as LinuxGuidedReaderRegistration;
  const built = parsed.kind === "reader_start"
    ? linuxGuidedReaderStart(same, { version: 1, bindingId: parsed.bindingId, contextRequestId: parsed.contextRequestId, readId: parsed.readId })
    : parsed.kind === "reader_cancel" ? linuxGuidedReaderCancel(same, parsed.readId) : undefined;
  return built !== undefined && JSON.stringify(built) === text;
}
const results = input.cases.map(item => {
  const registration = registrations[item.registration ?? 0]!;
  try {
    switch (item.op) {
      case "decode": decodeLinuxGuidedReaderFrame(bytes(item.hex!), registration, item.readId!); return { ok: true };
      case "build_start": return { ok: true, hex: frameOf(linuxGuidedReaderStart(registration, { version: 1, bindingId: item.bindingId!, contextRequestId: item.contextRequestId!, readId: item.readId! })) };
      case "build_cancel": return { ok: true, hex: frameOf(linuxGuidedReaderCancel(registration, item.readId!)) };
      case "request": return { ok: request(item.hex!, registration) };
      case "roundtrip": return { ok: JSON.stringify(JSON.parse(item.text!)) === item.text };
      default: return { ok: false };
    }
  } catch { return { ok: false }; }
});
console.log(JSON.stringify(results));
