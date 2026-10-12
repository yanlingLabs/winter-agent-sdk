import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { GuestFileAuthority, GuestFileRoot } from "./file-helper.ts";
import { BASH_CEILING_TIMEOUT_MS } from "../sandbox/execution-limits.ts";

export interface GuestProcessRequest {
  protocolVersion: 1; requestId: string; authority: Readonly<GuestFileAuthority>;
  root: Readonly<GuestFileRoot>; relativeCwd: string; expectedUid: number;
  command: string; timeoutMs: number; maxOutputBytes: number;
}
export interface GuestProcessReply {
  protocolVersion: number; requestId: string; authority: GuestFileAuthority;
  /** Worker receipt exit status, independent of the shell's exit status. */
  exitCode: number; stdout: string;
}
export interface GuestProcessPort {
  /** Protected supervisor MUST revalidate every authority revision before launch, admit the
   * exact file-session roots/UID/mount policy, and authenticate the immutable worker and shell.
   * Each invocation gets a private PID namespace with process-worker as PID 1. Cancellation
   * destroys that namespace and waits for all owned descendants, including setsid escapees.
   * Authority revocation destroys affected running invocations as well as denying new ones.
   * Bound stdin delivery and outer kill/drain waits independently of the worker timer;
   * uninterruptible guest I/O can delay reaping. Report uncertain cleanup, never success.
   * No inherited env, stores, control FDs or runtime filesystem view. No automatic retries.
   * Invoke process-worker ROOT REL_CWD UID TIMEOUT_MS OUTPUT_LIMIT; bounded command on stdin.
   * The shell is /bin/bash with a fixed, compartment-owned environment. */
  execute(request: GuestProcessRequest, signal?: AbortSignal): Promise<GuestProcessReply>;
}
export class GuestProcessError extends Error {
  constructor(readonly code: string, message: string, readonly effectsUncertain = false) { super(message); this.name = "GuestProcessError"; }
}
export interface GuestProcessResult { stdout: string; stderr: string; exitCode: number; termination: "exit" | "timeout" | "output_limit" }
const authorityKeys = ["workspaceId", "sessionId", "incarnationId", "leaseEpoch", "configRevision", "grantRevision", "policyRevision"] as const;
const COMMAND_LIMIT = 64 * 1024;
export function createGuestProcessHelper(options: {
  authority: GuestFileAuthority; roots: readonly GuestFileRoot[]; expectedUid: number;
  port: GuestProcessPort; maxOutputBytes?: number;
}) {
  // Called only after createGuestFileHelper has validated the same authority/roots/UID.
  const authority = Object.freeze({ ...options.authority });
  const expectedUid = options.expectedUid;
  const roots = options.roots.map(root => Object.freeze({ ...root })).sort((a,b) => b.guestPath.length - a.guestPath.length);
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 16 * 1024 * 1024) throw new GuestProcessError("invalid_limit", "invalid guest process output limit");
  return async (command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<GuestProcessResult> => {
    if (!command || command.includes("\0") || Buffer.byteLength(command) > COMMAND_LIMIT) throw new GuestProcessError("invalid_command", "guest command exceeds admitted shape");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > BASH_CEILING_TIMEOUT_MS) throw new GuestProcessError("invalid_timeout", "guest timeout exceeds admitted limit");
    if (!posix.isAbsolute(cwd) || cwd.includes("\0") || cwd.length > 4096) throw new GuestProcessError("cwd_denied", "guest cwd must be admitted");
    const path = posix.normalize(cwd), root = roots.find(root => path === root.guestPath || path.startsWith(`${root.guestPath === "/" ? "" : root.guestPath}/`));
    if (!root) throw new GuestProcessError("cwd_denied", "guest cwd is outside admitted roots");
    if (signal?.aborted) throw new GuestProcessError("aborted", "guest command cancelled before admission");
    const requestId = randomUUID();
    const request: GuestProcessRequest = Object.freeze({ protocolVersion: 1, requestId, authority, root, relativeCwd: posix.relative(root.guestPath, path) || ".", expectedUid, command, timeoutMs, maxOutputBytes });
    let reply: GuestProcessReply;
    try { reply = await options.port.execute(request, signal); }
    catch { throw new GuestProcessError("transport_lost", "guest process response lost", true); }
    if (!reply || reply.protocolVersion !== 1 || reply.requestId !== requestId || !reply.authority || authorityKeys.some(key => reply.authority[key] !== authority[key])) throw new GuestProcessError("binding_mismatch", "stale or foreign process response", true);
    if (typeof reply.stdout !== "string" || Buffer.byteLength(reply.stdout) > Math.ceil(maxOutputBytes / 3) * 4 + 2048) throw new GuestProcessError("invalid_response", "unbounded process response", true);
    let receipt: Record<string, unknown>;
    try { receipt = JSON.parse(reply.stdout); } catch { throw new GuestProcessError("invalid_response", "malformed process receipt", true); }
    if (!receipt || typeof receipt !== "object" || receipt.version !== 1 || typeof receipt.ok !== "boolean") throw new GuestProcessError("invalid_response", "invalid process receipt", true);
    if (!receipt.ok) {
      // Only these worker failures occur before any shell effects. Port authority denials use
      // the same typed pre-launch receipt. Every unrecognized denial stays uncertain.
      const beforeLaunch = ["authority_denied", "compartment_required", "invalid_request", "payload_limit", "invalid_payload", "fd_cleanup_unavailable", "root_unavailable", "cwd_denied", "resource_unavailable", "pipe_failed", "fork_failed"];
      if (!Number.isInteger(reply.exitCode) || reply.exitCode < 1 || reply.exitCode > 255 || typeof receipt.code !== "string" || !Number.isInteger(receipt.errno) || (receipt.errno as number) < 1 || (receipt.errno as number) > 4095) throw new GuestProcessError("invalid_response", "invalid process denial", true);
      const code = beforeLaunch.includes(receipt.code) ? receipt.code : "worker_failed";
      throw new GuestProcessError(code, "guest process denied", !beforeLaunch.includes(receipt.code));
    }
    if (reply.exitCode !== 0 || !Number.isInteger(receipt.exitCode) || (receipt.exitCode as number) < 0 || (receipt.exitCode as number) > 255 || !["exit", "timeout", "output_limit"].includes(receipt.termination as string)) throw new GuestProcessError("invalid_response", "invalid process outcome", true);
    const decode = (value: unknown): Buffer => {
      if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new GuestProcessError("invalid_response", "invalid process stream", true);
      const bytes = Buffer.from(value, "base64");
      if (bytes.toString("base64") !== value) throw new GuestProcessError("invalid_response", "noncanonical process stream", true);
      return bytes;
    };
    const stdout = decode(receipt.stdoutBase64), stderr = decode(receipt.stderrBase64);
    if (stdout.length + stderr.length > maxOutputBytes) throw new GuestProcessError("invalid_response", "process streams exceeded bound", true);
    return { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), exitCode: receipt.exitCode as number, termination: receipt.termination as GuestProcessResult["termination"] };
  };
}
