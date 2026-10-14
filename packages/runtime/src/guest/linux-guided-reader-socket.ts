/** Prospective inherited-FD adapter. No pathname/listener/reconnect route.
 * Native admission owns claim/shutdown. Injected sockets test ownership only;
 * they do not prove pinned Bun adoption or native channel admission. */
import { Socket } from "node:net";
import { closeSync, fstatSync } from "node:fs";
import type { LinuxGuidedReaderWire } from "./linux-guided-reader-channel.ts";
interface ReaderSocket {
  on(event: string, callback: (...values: any[]) => void): unknown;
  connect(options: { fd: number }): unknown;
  write(frame: Uint8Array, callback: (error?: Error | null) => void): unknown;
  destroy(): unknown;
}
interface SocketIdentity { dev: number; ino: number; }
export function createLinuxGuidedReaderSocketWire(options: {
  claimDup(): number; shutdownOriginal(): void;
  /** Trusted source-test effects only; production admission passes none. */
  socket?: () => ReaderSocket; identity?: (fd: number) => SocketIdentity; closeUnadopted?: (fd: number) => void;
}): LinuxGuidedReaderWire {
  const fd = options.claimDup();
  if (!Number.isInteger(fd) || fd < 3) throw new Error("required_context_unavailable");
  const identify = options.identity ?? (value => { const stat = fstatSync(value); if (!stat.isSocket()) throw new Error("required_context_unavailable"); return { dev: stat.dev, ino: stat.ino }; });
  const closeRaw = options.closeUnadopted ?? closeSync;
  let identity: SocketIdentity | undefined, socket: ReaderSocket | undefined, rawOwned = true, closed = false, adopted = false;
  let receiver: ((chunk: Uint8Array) => void) | undefined, lost: (() => void) | undefined;
  const close = () => {
    if (closed) return; closed = true;
    // shutdown() on the native original makes every surviving dup unusable.
    // Native never closes the transferred JS dup by numeric descriptor.
    try { options.shutdownOriginal(); } catch { /* Still destroy JS ownership; debt remains uncertain. */ }
    try { socket?.destroy(); } catch { /* No cleanup receipt is fabricated. */ }
    if (rawOwned) {
      rawOwned = false;
      try { const current = identify(fd); if (identity && current.dev === identity.dev && current.ino === identity.ino) closeRaw(fd); }
      catch { /* Missing/reused descriptor cannot be closed by its stale number. */ }
    }
    lost?.();
  };
  try {
    identity = identify(fd);
    const socketOptions = { allowHalfOpen: false, readableHighWaterMark: 64 * 1024, writableHighWaterMark: 64 * 1024 };
    socket = options.socket?.() ?? new Socket(socketOptions) as unknown as ReaderSocket;
    socket.on("connect", () => { if (closed) { socket!.destroy(); return; } adopted = true; rawOwned = false; });
    socket.on("data", (chunk: Uint8Array) => { if (closed) return; if (!receiver) { close(); return; } receiver(chunk); });
    for (const event of ["error", "end", "close"]) socket.on(event, close);
  } catch { close(); throw new Error("required_context_unavailable"); }
  let subscribed = false;
  return Object.freeze({
    close,
    subscribe(data: (chunk: Uint8Array) => void, onLost: () => void) {
      if (closed || subscribed) throw new Error("required_context_unavailable");
      subscribed = true; receiver = data; lost = onLost;
      // Pinned Bun 1.3.14 constructor does not adopt fd. Its explicit FD connect
      // branch synchronously calls fromFd/onOpen; no host/path connect is allowed.
      try { socket!.connect({ fd }); if (!adopted) throw new Error("required_context_unavailable"); }
      catch { close(); throw new Error("required_context_unavailable"); }
      return () => { receiver = undefined; lost = undefined; };
    },
    send(frame: Uint8Array) {
      if (closed || !adopted) return Promise.reject(new Error("required_context_unavailable"));
      return new Promise<void>((resolve, reject) => {
        try { socket!.write(frame, error => { if (error || closed) { close(); reject(new Error("required_context_unavailable")); } else resolve(); }); }
        catch { close(); reject(new Error("required_context_unavailable")); }
      });
    },
  });
}
