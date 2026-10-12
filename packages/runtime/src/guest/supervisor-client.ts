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
  const exchange = (kind: "file" | "process", request: unknown, signal?: AbortSignal): Promise<GuestFileReply | GuestProcessReply> => new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ kind, request }), "utf8");
    if (body.length > FRAME_LIMIT || signal?.aborted) { reject(new Error("supervisor request refused")); return; }
    const frame = Buffer.allocUnsafe(4 + body.length); frame.writeUInt32BE(body.length, 0); body.copy(frame, 4);
    const socket = createConnection({ path }); let buffer = Buffer.alloc(0), expected: number | undefined, settled = false;
    // Independent channel deadline includes command runtime; no automatic write/command replay.
    const timeout = kind === "process" ? (request as { timeoutMs: number }).timeoutMs + 7_000 : 7_000;
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
          if (!value || value.error) throw new Error("supervisor operation uncertain");
          finish(undefined, value);
        } catch { finish(new Error("supervisor receipt unavailable")); }
      }
    });
  });
  const port: GuestFileHelperPort = { execute: (request, signal) => exchange("file", request, signal) as Promise<GuestFileReply> };
  const processPort: GuestProcessPort = { execute: (request, signal) => exchange("process", request, signal) as Promise<GuestProcessReply> };
  return createGuestFileSession({ authority: binding.authority, roots: binding.roots, expectedUid: binding.toolUid, port, processPort,
    ...(binding.maxBytes === undefined ? {} : { maxBytes: binding.maxBytes }), ...(binding.maxOutputBytes === undefined ? {} : { maxOutputBytes: binding.maxOutputBytes }),
    probeReadAccess: () => "silent",
  });
}
