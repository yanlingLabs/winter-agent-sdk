import { randomUUID } from "node:crypto";

export const GUEST_FILE_HELPER_PROTOCOL_VERSION = 1;
export const GUEST_FILE_HELPER_CAPABILITY = "linux-openat2-files-v1";
export interface GuestFileAuthority {
  workspaceId: string; sessionId: string; incarnationId: string;
  leaseEpoch: number; configRevision: number; grantRevision: number; policyRevision: number;
}
export interface GuestFileRoot { id: string; guestPath: string; readOnly: boolean }
export interface GuestFileRequest {
  protocolVersion: 1; requestId: string; authority: GuestFileAuthority;
  operation: "read" | "write" | "write-check"; root: GuestFileRoot; relativePath: string;
  expectedUid: number; maxBytes: number; dataBase64?: string; expectedFileVersion?: string;
}
export interface GuestFileReply {
  protocolVersion: number; requestId: string; authority: GuestFileAuthority;
  exitCode: number; stdout: string;
}
export interface GuestFileHelperPort {
  /** Protected supervisor validates current authority, mounts and immutable worker before launch.
   * The worker runs in this caller's SAME tool UID/mount/PID view as Bash. No runtime-UID fallback.
   * Invoke file-worker OP ROOT REL UID LIMIT [EXPECTED_VERSION] with bounded base64 stdin.
   * write-check requires the exact expected version or "absent"; the adapter must not drop it.
   * Only stdio crosses the compartment. Lost writes are never replayed automatically. */
  execute(request: GuestFileRequest, signal?: AbortSignal): Promise<GuestFileReply>;
}
export class GuestFileHelperError extends Error {
  constructor(readonly code: string, message: string, readonly effectsUncertain = false, readonly errno?: number) { super(message); this.name = "GuestFileHelperError"; }
}
export interface GuestFileSnapshot { bytes: Uint8Array; fileVersion: string; mtimeMs: number }
const VERSION = /^[0-9]+:[0-9]+:[0-9]+:-?[0-9]+:[0-9]{9}:-?[0-9]+:[0-9]{9}$/;
const authorityKeys = ["workspaceId", "sessionId", "incarnationId", "leaseEpoch", "configRevision", "grantRevision", "policyRevision"] as const;
function validRelative(path: string): boolean { return path.length > 0 && path.length <= 4096 && !path.startsWith("/") && !path.includes("\0") && path.split("/").every((part) => part !== "" && part !== "." && part !== ".."); }

export function createGuestFileHelper(options: {
  authority: GuestFileAuthority; roots: readonly GuestFileRoot[];
  expectedUid: number; port: GuestFileHelperPort; maxBytes?: number;
}) {
  const authority = Object.freeze({ ...options.authority });
  for (const key of ["workspaceId", "sessionId", "incarnationId"] as const) if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(authority[key])) throw new GuestFileHelperError("invalid_authority", "invalid guest file authority");
  for (const key of ["leaseEpoch", "configRevision", "grantRevision", "policyRevision"] as const) if (!Number.isSafeInteger(authority[key]) || authority[key] < 0) throw new GuestFileHelperError("invalid_authority", "invalid guest file authority revision");
  if (!Number.isSafeInteger(options.expectedUid) || options.expectedUid < 1 || options.expectedUid > 65535) throw new GuestFileHelperError("invalid_uid", "tool UID must be non-root");
  const roots = new Map<string, Readonly<GuestFileRoot>>();
  for (const root of options.roots) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(root.id) || roots.has(root.id) || !root.guestPath.startsWith("/") || root.guestPath.includes("\0") || root.guestPath.split("/").some((part) => part === "." || part === "..") || typeof root.readOnly !== "boolean") throw new GuestFileHelperError("invalid_root", "invalid or duplicate tool-view root");
    roots.set(root.id, Object.freeze({ ...root }));
  }
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new GuestFileHelperError("invalid_limit", "invalid guest file byte limit");
  const expectedUid = options.expectedUid;
  async function execute(operation: "read" | "write" | "write-check", rootId: string, relativePath: string, data?: Uint8Array, signal?: AbortSignal, expectedFileVersion?: string): Promise<{ bytes: Uint8Array; fileVersion?: string; mtimeMs?: number }> {
    const root = roots.get(rootId);
    if (!root || !validRelative(relativePath)) throw new GuestFileHelperError("path_denied", "path is outside the admitted file-helper request shape");
    if (operation !== "read" && root.readOnly) throw new GuestFileHelperError("read_only", "current tool-view root is read-only");
    if (data !== undefined && data.byteLength > maxBytes) throw new GuestFileHelperError("payload_limit", "guest file write exceeds its byte limit");
    if (signal?.aborted) throw new GuestFileHelperError("aborted", "guest file operation cancelled before admission");
    if (operation === "write-check" && expectedFileVersion !== "absent" && (typeof expectedFileVersion !== "string" || expectedFileVersion.length > 256 || !VERSION.test(expectedFileVersion))) throw new GuestFileHelperError("invalid_version", "conditional write requires a descriptor-derived version or absence");
    const requestId = randomUUID();
    const request: GuestFileRequest = Object.freeze({ protocolVersion: GUEST_FILE_HELPER_PROTOCOL_VERSION, requestId, authority, operation, root, relativePath, expectedUid, maxBytes, ...(data !== undefined ? { dataBase64: Buffer.from(data).toString("base64") } : {}), ...(expectedFileVersion !== undefined ? { expectedFileVersion } : {}) });
    let reply: GuestFileReply;
    try { reply = await options.port.execute(request, signal); }
    catch { throw new GuestFileHelperError("transport_lost", "guest file response lost; operation is not replayed", operation !== "read"); }
    if (reply.protocolVersion !== GUEST_FILE_HELPER_PROTOCOL_VERSION || reply.requestId !== requestId || !reply.authority || authorityKeys.some((key) => reply.authority[key] !== authority[key])) throw new GuestFileHelperError("binding_mismatch", "guest file reply has stale or foreign authority", operation !== "read");
    if (typeof reply.stdout !== "string" || Buffer.byteLength(reply.stdout) > Math.ceil(maxBytes / 3) * 4 + 1024) throw new GuestFileHelperError("invalid_response", "guest file worker response exceeded its bound", operation !== "read");
    let result: { version?: unknown; ok?: unknown; code?: unknown; errno?: unknown; bytes?: unknown; dataBase64?: unknown; fileVersion?: unknown; mtimeMs?: unknown };
    try { result = JSON.parse(reply.stdout) as typeof result; } catch { throw new GuestFileHelperError("invalid_response", "guest file worker returned malformed JSON", operation !== "read"); }
    if (!result || typeof result !== "object" || result.version !== 1 || typeof result.ok !== "boolean") throw new GuestFileHelperError("invalid_response", "guest file worker response schema mismatch", operation !== "read");
    if (!result.ok) {
      if (reply.exitCode === 0 || typeof result.code !== "string" || typeof result.errno !== "number") throw new GuestFileHelperError("invalid_response", "guest file denial lacks actual failure evidence", operation !== "read");
      throw new GuestFileHelperError(result.code, "guest file worker refused the operation", operation !== "read" && ["write_failed", "flush_failed"].includes(result.code), result.errno);
    }
    if (reply.exitCode !== 0 || !Number.isSafeInteger(result.bytes) || (result.bytes as number) < 0 || (result.bytes as number) > maxBytes) throw new GuestFileHelperError("invalid_response", "guest file success lacks valid exit/byte evidence", operation !== "read");
    if (typeof result.fileVersion === "string" && Number(result.fileVersion.split(":")[2]) !== result.bytes) throw new GuestFileHelperError("invalid_response", "descriptor identity size does not match its byte evidence", operation !== "read");
    if (operation !== "read") {
      if (result.bytes !== data!.byteLength) throw new GuestFileHelperError("invalid_response", "guest file write byte count mismatch", true);
      return { bytes: new Uint8Array(), ...(typeof result.fileVersion === "string" ? { fileVersion: result.fileVersion } : {}), ...(typeof result.mtimeMs === "number" ? { mtimeMs: result.mtimeMs } : {}) };
    }
    if (typeof result.dataBase64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.dataBase64)) throw new GuestFileHelperError("invalid_response", "guest file payload is not canonical base64");
    const bytes = Buffer.from(result.dataBase64, "base64");
    if (bytes.length !== result.bytes || bytes.toString("base64") !== result.dataBase64) throw new GuestFileHelperError("invalid_response", "guest file read byte count/encoding mismatch");
    return { bytes, ...(typeof result.fileVersion === "string" ? { fileVersion: result.fileVersion } : {}), ...(typeof result.mtimeMs === "number" ? { mtimeMs: result.mtimeMs } : {}) };
  }
  function snapshot(result: Awaited<ReturnType<typeof execute>>, effectsUncertain = false): GuestFileSnapshot {
    if (typeof result.fileVersion !== "string" || result.fileVersion.length > 256 || !VERSION.test(result.fileVersion) || typeof result.mtimeMs !== "number" || !Number.isFinite(result.mtimeMs)) throw new GuestFileHelperError("invalid_response", "guest file snapshot lacks descriptor identity", effectsUncertain);
    return { bytes: result.bytes, fileVersion: result.fileVersion, mtimeMs: result.mtimeMs };
  }
  return {
    readSnapshot: async (rootId: string, relativePath: string, signal?: AbortSignal) => snapshot(await execute("read", rootId, relativePath, undefined, signal)),
    writeChecked: async (rootId: string, relativePath: string, data: Uint8Array, expectedFileVersion: string, signal?: AbortSignal) => snapshot(await execute("write-check", rootId, relativePath, data, signal, expectedFileVersion), true),
    read: (rootId: string, relativePath: string, signal?: AbortSignal) => execute("read", rootId, relativePath, undefined, signal).then(result => result.bytes),
    async write(rootId: string, relativePath: string, data: Uint8Array, signal?: AbortSignal) { await execute("write", rootId, relativePath, data, signal); },
  };
}
