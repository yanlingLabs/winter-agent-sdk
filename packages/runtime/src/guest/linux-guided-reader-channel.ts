/** Injected bounded channel bookkeeping. Only native admission may supply the
 * production wire/owner. This factory never mints an admission or opens an FD. */
import { GUIDED_PARENT_PENDING_MAX, type GuidedReaderOperation, type GuidedReaderRequest, type GuidedReaderResponse } from "./guided-parent-bridge.ts";
import { decodeLinuxGuidedReaderFrame, linuxGuidedReaderCancel, linuxGuidedReaderStart, LINUX_GUIDED_READER_BODY_BYTES,
  parseLinuxGuidedReaderRegistration, type LinuxGuidedReaderRegistration } from "./linux-guided-reader-protocol.ts";

export interface LinuxGuidedReaderWire {
  send(frame: Uint8Array): Promise<void>;
  subscribe(data: (chunk: Uint8Array) => void, lost: () => void): () => void;
  close(): void;
}
export interface LinuxGuidedReaderChannel {
  start(request: GuidedReaderRequest, options: { signal: AbortSignal }): GuidedReaderOperation;
  close(): void;
  diagnostics(): Readonly<{ closed: boolean; outstanding: number; consumed: number }>;
}
const unavailable = () => new Error("required_context_unavailable");
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {}); return { promise, resolve, reject };
}
function encoded(value: unknown): Uint8Array {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length < 1 || body.length > 4096) throw unavailable();
  const frame = Buffer.alloc(body.length + 4); frame.writeUInt32BE(body.length); body.copy(frame, 4); return frame;
}
interface Read {
  request: GuidedReaderRequest; result: ReturnType<typeof deferred<GuidedReaderResponse>>; drained: ReturnType<typeof deferred<void>>;
  seenResult: boolean; cancelled: boolean; dispose(): void; cancel(): void;
}
export function createLinuxGuidedReaderChannel(options: {
  registration: LinuxGuidedReaderRegistration; wire: LinuxGuidedReaderWire; assertOwnerHeld(): void;
}): LinuxGuidedReaderChannel {
  const registration = parseLinuxGuidedReaderRegistration(options.registration), wire = options.wire, assertOwner = options.assertOwnerHeld;
  if (typeof assertOwner !== "function") throw unavailable();
  const pending = new Map<string, Read>(), consumed = new Set<string>();
  let closed = false, detach: (() => void) | undefined, header = Buffer.alloc(4), headerBytes = 0;
  let body: Buffer | undefined, bodyBytes = 0;
  const close = () => {
    if (closed) return; closed = true; detach?.();
    try { wire.close(); } catch { /* Loss already retains uncertain debt. */ }
    finally { for (const read of pending.values()) { read.dispose(); read.result.reject(unavailable()); read.drained.reject(unavailable()); } }
    // Outstanding operations remain debt; loss is never a terminal/reap/drain receipt.
  };
  const held = () => { if (closed) throw unavailable(); try { assertOwner(); } catch { close(); throw unavailable(); } };
  const send = (frame: unknown) => {
    const bytes = encoded(frame);
    void Promise.resolve().then(() => { held(); return wire.send(bytes); }).catch(close);
  };
  const accept = (frame: Uint8Array) => {
    held();
    // The ID is used only to find a currently registered operation. Full closed
    // framing, owner and echo validation immediately follow before any settlement.
    const lookup: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(4)));
    const readId = lookup && typeof lookup === "object" ? (lookup as { readId?: unknown }).readId : undefined;
    if (typeof readId !== "string") throw unavailable();
    const read = pending.get(readId); if (!read) throw unavailable();
    const message = decodeLinuxGuidedReaderFrame(frame, registration, readId); held();
    if (message.kind === "reader_result") {
      if (read.seenResult) throw unavailable();
      read.seenResult = true;
      if (!read.cancelled) read.result.resolve(Object.freeze({ ...read.request, frame: message.frame }));
      return;
    }
    if (message.outcome === "ok" && !read.seenResult) throw unavailable();
    if (message.outcome !== "ok") read.result.reject(unavailable());
    // Keep the operation registered through the last owner check: if that
    // throws, close() must still reject its drain promise and retain its debt.
    held(); read.dispose(); read.drained.resolve(); pending.delete(readId);
    // This is reached only on this registered wire's matching closed terminal
    // receipt. Root must back that receipt with actual native reap/EOF/drain.
  };
  const data = (chunk: Uint8Array) => {
    try {
      held(); if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) throw unavailable();
      let at = 0;
      while (at < chunk.byteLength) {
        if (!body) {
          const length = Math.min(4 - headerBytes, chunk.byteLength - at); header.set(chunk.subarray(at, at + length), headerBytes); headerBytes += length; at += length;
          if (headerBytes !== 4) continue;
          const size = header.readUInt32BE(); if (size < 1 || size > LINUX_GUIDED_READER_BODY_BYTES) throw unavailable();
          body = Buffer.alloc(size); bodyBytes = 0;
        }
        const length = Math.min(body.length - bodyBytes, chunk.byteLength - at); body.set(chunk.subarray(at, at + length), bodyBytes); bodyBytes += length; at += length;
        if (bodyBytes === body.length) {
          const frame = Buffer.concat([header, body]); body = undefined; bodyBytes = 0; header = Buffer.alloc(4); headerBytes = 0; accept(frame);
        }
      }
    } catch { close(); }
  };
  try { held(); detach = wire.subscribe(data, close); if (closed) { detach(); throw unavailable(); } }
  catch { close(); throw unavailable(); }
  return Object.freeze({
    close,
    diagnostics: () => Object.freeze({ closed, outstanding: pending.size, consumed: consumed.size }),
    start(request: GuidedReaderRequest, { signal }: { signal: AbortSignal }): GuidedReaderOperation {
      held(); const start = linuxGuidedReaderStart(registration, request);
      // The lifetime replay set deliberately fails closed at a bounded size. It
      // is not a production generation-expiry/re-key protocol.
      if (signal.aborted || pending.size >= GUIDED_PARENT_PENDING_MAX || consumed.size >= 4096 || consumed.has(start.readId)) throw unavailable();
      const result = deferred<GuidedReaderResponse>(), drained = deferred<void>();
      const read: Read = { request: Object.freeze({ ...request }), result, drained, seenResult: false, cancelled: false,
        dispose() { signal.removeEventListener("abort", read.cancel); },
        cancel() { if (read.cancelled || !pending.has(start.readId)) return; read.cancelled = true; read.result.reject(unavailable());
          if (!closed) send(linuxGuidedReaderCancel(registration, start.readId)); },
      };
      pending.set(start.readId, read); consumed.add(start.readId); signal.addEventListener("abort", read.cancel, { once: true });
      // Registration and the returned promises exist before send can have effects.
      send(start);
      return Object.freeze({ result: result.promise, drained: drained.promise, cancel: read.cancel });
    },
  });
}
