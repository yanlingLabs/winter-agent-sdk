import { createConnection } from "node:net";
import type { GuestFileAuthority, GuestFileHelperPort, GuestFileReply, GuestFileRoot } from "./file-helper.ts";
import type { GuestProcessPort, GuestProcessReply } from "./process-helper.ts";
import { createGuestFileSession } from "./file-session.ts";

const FRAME_LIMIT = 2 * 1024 * 1024;
/** Protected runtime bootstrap supplies this endpoint/scope. Never loaded from tool input,
 * settings, RuntimeConfig or environment. Linux server authenticates the actual runtime UID. */
export interface LinuxSupervisorBinding {
  socketPath: string; authority: GuestFileAuthority; roots: readonly GuestFileRoot[];
  toolUid: number; maxBytes?: number; maxOutputBytes?: number;
}
export function createLinuxSupervisorSession(binding: LinuxSupervisorBinding) {
  const path = binding.socketPath;
  if (!path.startsWith("/") || path.includes("\0") || Buffer.byteLength(path) > 100) throw new Error("invalid protected supervisor endpoint");
  const send = (envelope: unknown, timeout: number, signal?: AbortSignal): Promise<GuestFileReply | GuestProcessReply> => new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(envelope), "utf8");
    if (body.length > FRAME_LIMIT || signal?.aborted) { reject(new Error("supervisor request refused")); return; }
    const frame = Buffer.allocUnsafe(4 + body.length); frame.writeUInt32BE(body.length, 0); body.copy(frame, 4);
    const socket = createConnection({ path }); let buffer = Buffer.alloc(0), expected: number | undefined, settled = false;
    // Independent channel deadline includes command runtime; no automatic write/command replay.
    const timer = setTimeout(() => finish(new Error("supervisor response unavailable")), timeout);
    const abort = () => finish(new Error("supervisor operation cancelled"));
    const finish = (error?: Error, value?: GuestFileReply | GuestProcessReply) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); socket.destroy();
      if (error) reject(error); else resolve(value!);
    };
    signal?.addEventListener("abort", abort, { once: true });
    socket.on("connect", () => { socket.write(frame); });
    socket.on("error", () => finish(new Error("supervisor channel unavailable")));
    socket.on("end", () => { if (!settled) finish(new Error("supervisor channel closed")); });
    socket.on("data", value => {
      const chunk = typeof value === "string" ? Buffer.from(value) : value;
      if (buffer.length + chunk.length > FRAME_LIMIT + 4) { finish(new Error("supervisor frame limit")); return; }
      buffer = Buffer.concat([buffer, chunk]);
      if (expected === undefined && buffer.length >= 4) {
        expected = buffer.readUInt32BE(0);
        if (expected < 1 || expected > FRAME_LIMIT) { finish(new Error("supervisor frame limit")); return; }
      }
      if (expected !== undefined && buffer.length >= expected + 4) {
        if (buffer.length !== expected + 4) { finish(new Error("supervisor frame boundary")); return; }
        try {
          const value = JSON.parse(buffer.subarray(4).toString("utf8"));
          if (!value || (value.error && value.error !== "capacity_busy")) throw new Error("supervisor operation uncertain");
          finish(undefined, value);
        } catch { finish(new Error("supervisor receipt unavailable")); }
      }
    });
  });
  const exchange = async (kind: "file" | "process", request: unknown, signal?: AbortSignal): Promise<GuestFileReply | GuestProcessReply> => {
    const encoded = JSON.stringify(request);
    if (Buffer.byteLength(encoded) > FRAME_LIMIT - 256) throw new Error("supervisor request refused");
    const owned = JSON.parse(encoded);
    const busy = (reply: GuestFileReply | GuestProcessReply) => (reply as unknown as { error?: unknown }).error === "capacity_busy"
      ? { protocolVersion: 1 as const, requestId: owned.requestId, authority: owned.authority, exitCode: 1, stdout: JSON.stringify({ version: 1, ok: false, code: "capacity_busy", errno: 11 }) } : reply;
    const reserved = busy(await send({ kind: "reserve", toolKind: kind, request: owned }, 7_000, signal));
    // A reservation refusal has the ordinary validated no-effect error receipt.
    if (typeof reserved.exitCode === "number") return reserved;
    const ticket = (reserved as unknown as { ticket?: unknown }).ticket;
    if (reserved.protocolVersion !== 1 || reserved.requestId !== owned.requestId || typeof ticket !== "string" || !/^[a-f0-9-]{36}$/.test(ticket)
      || !reserved.authority || Object.keys(reserved.authority).sort().join() !== Object.keys(owned.authority).sort().join()
      || Object.keys(owned.authority).some(key => (reserved.authority as unknown as Record<string, unknown>)[key] !== owned.authority[key])) throw new Error("supervisor reservation unavailable");
    // Never acquire a replacement ticket or replay a command after a lost effect response.
    return busy(await send({ kind, request: owned, ticket }, kind === "process" ? owned.timeoutMs + 7_000 : 7_000, signal));
  };
  const port: GuestFileHelperPort = { execute: (request, signal) => exchange("file", request, signal) as Promise<GuestFileReply> };
  const processPort: GuestProcessPort = { execute: (request, signal) => exchange("process", request, signal) as Promise<GuestProcessReply> };
  return createGuestFileSession({ authority: binding.authority, roots: binding.roots, expectedUid: binding.toolUid, port, processPort,
    ...(binding.maxBytes === undefined ? {} : { maxBytes: binding.maxBytes }), ...(binding.maxOutputBytes === undefined ? {} : { maxOutputBytes: binding.maxOutputBytes }),
    probeReadAccess: () => "silent",
  });
}
