/** Fixed inherited-FD Bun adapter. No pathname/listener/reconnect route.
 * Only native admission supplies production claim/shutdown. Injected effects
 * test ownership bookkeeping, never actual Bun/FD/native admission. */
import { closeSync, fstatSync } from "node:fs";
import type { LinuxGuidedReaderWire } from "./linux-guided-reader-channel.ts";
interface ReaderSocket { write(bytes: Uint8Array): number; terminate(): void; }
interface ReaderConnectOptions {
  fd: number;
  socket: {
    open(socket: ReaderSocket): void; connectError(socket: ReaderSocket, error: Error): void;
    error(socket: ReaderSocket, error: Error): void; close(socket: ReaderSocket): void; end(socket: ReaderSocket): void;
    data(socket: ReaderSocket, chunk: Uint8Array): void; drain(socket: ReaderSocket): void;
  };
}
interface Write { bytes: Uint8Array; offset: number; resolve(): void; reject(error: Error): void; }
const unavailable = () => new Error("required_context_unavailable");
export function createLinuxGuidedReaderSocketWire(options: {
  claimDup(): number; shutdownOriginal(): void;
  /** Trusted source-test effects only; production admission passes none. */
  connect?: (options: ReaderConnectOptions) => Promise<ReaderSocket>;
  validateDup?: (fd: number) => void; closeUnadopted?: (fd: number) => void;
}): LinuxGuidedReaderWire {
  const fd = options.claimDup();
  if (!Number.isInteger(fd) || fd < 3) throw unavailable();
  // The pinned runtime implements Listener.connectInner's fd branch, while its
  // ambient declarations expose only TCP/unix options. Keep this cast private
  // and bounded to the reviewed FD/handler envelope; never supply a host/path.
  const connect = options.connect ?? (Bun.connect as unknown as (config: ReaderConnectOptions) => Promise<ReaderSocket>);
  const closeRaw = options.closeUnadopted ?? closeSync;
  let closed = false, attempted = false, adopted = false, rawClosed = false, nativeStopped = false, subscribed = false, flushing = false, waitingDrain = false;
  let socket: ReaderSocket | undefined, receiver: ((chunk: Uint8Array) => void) | undefined, lost: (() => void) | undefined;
  const writes: Write[] = [];
  const closeOwnedRaw = () => {
    if (adopted || rawClosed) return;
    rawClosed = true; // Before close: callbacks/reentrancy cannot claim another close.
    try { closeRaw(fd); } catch { /* Root/runtime teardown still owns uncertainty. */ }
  };
  const close = () => {
    if (closed) return; closed = true;
    if (!nativeStopped) { nativeStopped = true; try { options.shutdownOriginal(); } catch { /* Still close JS ownership. */ } }
    if (!attempted) closeOwnedRaw();
    const owned = socket; socket = undefined;
    try { owned?.terminate(); } catch { /* No cleanup receipt is fabricated. */ }
    for (const write of writes.splice(0)) write.reject(unavailable());
    const notify = lost; lost = undefined; notify?.();
    // Post-transfer failure never grants numeric-close authority while actual
    // pinned-Bun descriptor disposal proof remains unverified.
  };
  const flush = () => {
    if (closed || !adopted || !socket || flushing || waitingDrain) return;
    flushing = true;
    try {
      while (!closed && writes.length > 0) {
        const write = writes[0]!, remaining = write.bytes.length - write.offset;
        const count = socket.write(write.bytes.subarray(write.offset));
        // write may reentrantly close us; all queued promises are already rejected.
        if (closed) return;
        if (!Number.isSafeInteger(count) || count < 0 || count > remaining) { close(); return; }
        write.offset += count;
        if (write.offset !== write.bytes.length) { waitingDrain = true; return; } // Keep only suffix, wait for drain.
        writes.shift(); write.resolve();
      }
    } catch { close(); } finally { flushing = false; }
  };
  const handlers: ReaderConnectOptions["socket"] = {
    open(value) {
      // FIRST record ownership, before anything that can invoke a callback or
      // throw. Pinned non-TLS Bun fromFd emits this synchronously on attachment.
      adopted = true; socket = value;
      if (closed) { socket = undefined; try { value.terminate(); } catch {} }
    },
    connectError(_value, _error) {
      // Source analysis alone cannot establish the actual runtime's FD reuse /
      // disposal order. Retain uncertainty; Root must terminate the runtime.
      // No callback, correlation DTO or injected test can enable numeric close.
      close();
    },
    error(_value, _error) { close(); }, close(_value) { close(); }, end(_value) { close(); },
    data(value, chunk) {
      if (closed) return;
      if (!adopted || value !== socket || !receiver) { close(); return; }
      try { receiver(chunk); } catch { close(); }
    },
    drain(value) { if (closed) return; if (!adopted || value !== socket) { close(); return; } waitingDrain = false; flush(); },
  };
  try {
    if (options.validateDup) options.validateDup(fd);
    else if (!fstatSync(fd).isSocket()) throw unavailable();
  } catch { close(); throw unavailable(); }
  return Object.freeze({
    close,
    subscribe(data: (chunk: Uint8Array) => void, onLost: () => void) {
      if (closed || subscribed) throw unavailable();
      subscribed = true; receiver = data; lost = onLost;
      attempted = true;
      try {
        const connected = connect({ fd, socket: handlers });
        void connected.then(value => { if (!closed && (!adopted || value !== socket)) close(); }, close);
        if (!adopted || closed) { close(); throw unavailable(); }
      } catch { close(); throw unavailable(); }
      return () => { receiver = undefined; lost = undefined; };
    },
    send(frame: Uint8Array) {
      if (closed || !adopted || !socket || !(frame instanceof Uint8Array) || frame.length < 1 || frame.length > 4100 || writes.length >= 16) return Promise.reject(unavailable());
      const bytes = frame.slice();
      return new Promise<void>((resolve, reject) => { writes.push({ bytes, offset: 0, resolve, reject }); flush(); });
    },
  });
}
