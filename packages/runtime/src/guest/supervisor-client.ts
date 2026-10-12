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
  let active = 0;
  const queue: Array<() => void> = [];
  const acquire = (deadline: number, signal?: AbortSignal): Promise<boolean> => new Promise(resolve => {
    if (signal?.aborted || performance.now() >= deadline || queue.length >= 128) { resolve(false); return; }
    if (active < 2 && queue.length === 0) { active++; resolve(true); return; }
    const finish = (admitted: boolean) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      const index = queue.indexOf(grant); if (index >= 0) queue.splice(index, 1);
      if (admitted) active++; resolve(admitted);
    };
    const grant = () => finish(!signal?.aborted && performance.now() < deadline);
    const abort = () => finish(false);
    const timer = setTimeout(abort, Math.max(1, deadline - performance.now()));
    queue.push(grant); signal?.addEventListener("abort", abort, { once: true });
  });
  const release = () => { active--; while (active < 2 && queue.length) queue.shift()!(); };
  const pause = (milliseconds: number, signal?: AbortSignal): Promise<void> => new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener("abort", done, { once: true }); if (signal?.aborted) done();
  });
  const exchange = async (kind: "file" | "process", request: unknown, signal?: AbortSignal): Promise<GuestFileReply | GuestProcessReply> => {
    const encoded = JSON.stringify(request);
    if (Buffer.byteLength(encoded) > FRAME_LIMIT - 256) throw new Error("supervisor request refused");
    const owned = JSON.parse(encoded);
    const deadline = performance.now() + (kind === "process" ? owned.timeoutMs + 7_000 : 7_000);
    const denial = (): GuestFileReply => ({ protocolVersion: 1, requestId: owned.requestId, authority: owned.authority, exitCode: 1, stdout: JSON.stringify({ version: 1, ok: false, code: "capacity_busy", errno: 11 }) });
    const matching = (reply: GuestFileReply | GuestProcessReply) => reply.protocolVersion === 1 && reply.requestId === owned.requestId
      && !!reply.authority && Object.keys(reply.authority).sort().join() === Object.keys(owned.authority).sort().join()
      && Object.keys(owned.authority).every(key => (reply.authority as unknown as Record<string, unknown>)[key] === owned.authority[key]);
    const isBusy = (reply: GuestFileReply | GuestProcessReply): boolean => {
      if ((reply as unknown as { error?: unknown }).error === "capacity_busy") return true;
      if (!matching(reply) || reply.exitCode !== 1) return false;
      try { const result = JSON.parse(reply.stdout); return result.version === 1 && result.ok === false && result.code === "capacity_busy"; } catch { return false; }
    };
    if (!await acquire(deadline, signal)) return denial();
    try {
      // Only an explicit, authenticated no-effect busy reply permits resubmission.
      // The effect envelope keeps its one-use ticket; unknown/lost replies throw.
      const available = async (envelope: unknown, admissionDeadline: number) => {
        while (!signal?.aborted && performance.now() < admissionDeadline) {
          const reply = await send(envelope, Math.max(1, deadline - performance.now()), signal);
          if (!isBusy(reply)) return reply;
          await pause(Math.min(25, Math.max(1, admissionDeadline - performance.now())), signal);
        }
        return denial();
      };
      const reserved = await available({ kind: "reserve", toolKind: kind, request: owned }, deadline);
      if (typeof reserved.exitCode === "number") return reserved;
      const ticket = (reserved as unknown as { ticket?: unknown }).ticket;
      if (!matching(reserved) || typeof ticket !== "string" || !/^[a-f0-9-]{36}$/.test(ticket)) throw new Error("supervisor reservation unavailable");
      // Stop busy waiting before the server's 15s ticket expiry; never replace it.
      return await available({ kind, request: owned, ticket }, Math.min(deadline, performance.now() + 14_000));
    } finally { release(); }
  };
  const port: GuestFileHelperPort = { execute: (request, signal) => exchange("file", request, signal) as Promise<GuestFileReply> };
  const processPort: GuestProcessPort = { execute: (request, signal) => exchange("process", request, signal) as Promise<GuestProcessReply> };
  return createGuestFileSession({ authority: binding.authority, roots: binding.roots, expectedUid: binding.toolUid, port, processPort,
    ...(binding.maxBytes === undefined ? {} : { maxBytes: binding.maxBytes }), ...(binding.maxOutputBytes === undefined ? {} : { maxOutputBytes: binding.maxOutputBytes }),
    probeReadAccess: () => "silent",
  });
}
