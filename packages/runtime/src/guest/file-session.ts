import { posix } from "node:path";
import { createGuestFileHelper, GuestFileHelperError, type GuestFileAuthority, type GuestFileHelperPort, type GuestFileRoot, type GuestFileSnapshot } from "./file-helper.ts";
import type { ToolExecutionContext, ToolResultPayload } from "../tools/registry.ts";
import type { ReadRecord, SessionReadState } from "../tools/read-state.ts";
import type { ReadAccessProbe } from "../permissions/evaluator.ts";
import { createGuestProcessHelper, type GuestProcessPort, type GuestProcessResult } from "./process-helper.ts";

const sessions = new WeakSet<object>();
const bindings = new WeakMap<object, GuestFileSession>();
/** Protected supervisor/runtime object capability; never accepted from runtime config JSON. */
export interface GuestFileSession {
  readonly sessionId: string;
  readonly readState: SessionReadState;
  read(path: string, signal?: AbortSignal): Promise<GuestFileSnapshot>;
  write(path: string, data: Uint8Array, version: string, signal?: AbortSignal): Promise<GuestFileSnapshot>;
  probeReadAccess(path: string): ReadAccessProbe;
  readonly executeProcess?: (command: string, cwd: string, timeoutMs: number, signal?: AbortSignal) => Promise<GuestProcessResult>;
}
export function createGuestFileSession(options: {
  authority: GuestFileAuthority; roots: readonly GuestFileRoot[]; expectedUid: number;
  port: GuestFileHelperPort; maxBytes?: number;
  /** Same protected supervisor and tool compartment as file operations. No local fallback. */
  processPort?: GuestProcessPort; maxOutputBytes?: number;
  /** Policy-only protected probe; must not perform filesystem access in the runtime compartment. */
  probeReadAccess?: (path: string) => ReadAccessProbe;
}): GuestFileSession {
  const helper = createGuestFileHelper(options), sessionId = options.authority.sessionId;
  const roots = options.roots.map(root => ({ ...root, guestPath: posix.normalize(root.guestPath) })).sort((a,b) => b.guestPath.length - a.guestPath.length);
  const records = new Map<string, ReadRecord>(), identities = new Map<string, string>(), identityReads = new Map<string, ReadRecord>();
  const identityOf = (version: string) => version.split(":").slice(0, 2).join(":");
  const pathKey = (path: string) => posix.normalize(path);
  const locate = (path: string) => {
    if (!posix.isAbsolute(path) || path.includes("\0")) throw new GuestFileHelperError("path_denied", "guest file path must be absolute");
    const key = pathKey(path), root = roots.find(root => key.startsWith(`${root.guestPath === "/" ? "" : root.guestPath}/`));
    if (!root || key === root.guestPath) throw new GuestFileHelperError("path_denied", "guest file path is outside admitted source roots");
    return { rootId: root.id, relativePath: posix.relative(root.guestPath, key) };
  };
  const session: GuestFileSession = Object.freeze({
    sessionId,
    ...(options.processPort ? { executeProcess: createGuestProcessHelper({ authority: options.authority, roots: options.roots, expectedUid: options.expectedUid, port: options.processPort, ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}) }) } : {}),
    // Descriptor identity joins in-root aliases after their admitted read, without runtime realpath.
    // An existing lexical record remains visible after replacement so the ladder still detects drift.
    readState: {
      recordRead(path: string, record: ReadRecord) {
        records.set(pathKey(path), { ...record });
        if (record.fileVersion) identityReads.set(identityOf(record.fileVersion), { ...record });
      },
      lookup(path: string) {
        const key = pathKey(path), identity = identities.get(key), lexical = records.get(key);
        const sameIdentity = identity !== undefined && (lexical === undefined || (lexical.fileVersion !== undefined && identityOf(lexical.fileVersion) === identity));
        const record = sameIdentity ? identityReads.get(identity!) ?? lexical : lexical;
        return record ? { ...record } : undefined;
      },
    },
    async read(path: string, signal?: AbortSignal) {
      const target = locate(path), snapshot = await helper.readSnapshot(target.rootId, target.relativePath, signal);
      identities.set(pathKey(path), identityOf(snapshot.fileVersion)); return snapshot;
    },
    async write(path: string, data: Uint8Array, version: string, signal?: AbortSignal) {
      const target = locate(path), snapshot = await helper.writeChecked(target.rootId, target.relativePath, data, version, signal);
      identities.set(pathKey(path), identityOf(snapshot.fileVersion)); return snapshot;
    },
    probeReadAccess(path: string) { locate(path); return options.probeReadAccess?.(path) ?? "deny"; },
  });
  sessions.add(session); return session;
}
export function bindGuestFileSession(ctx: ToolExecutionContext, session: GuestFileSession): void {
  if (!sessions.has(session) || session.sessionId !== ctx.sessionId || ctx.executionPosture !== "confined-guest") throw new GuestFileHelperError("guest_file_binding_invalid", "guest filesystem requires a protected session binding");
  bindings.set(ctx, session);
}
export function guestFileSessionOf(ctx: ToolExecutionContext): GuestFileSession | undefined {
  if (ctx.executionPosture === undefined || ctx.executionPosture === "local") {
    if (bindings.has(ctx)) throw new GuestFileHelperError("guest_file_posture_mismatch", "guest filesystem binding cannot run under local posture");
    return undefined;
  }
  if (ctx.executionPosture !== "confined-guest") throw new GuestFileHelperError("guest_file_posture_invalid", "unknown filesystem execution posture");
  const binding = bindings.get(ctx);
  if (!binding || binding.sessionId !== ctx.sessionId) throw new GuestFileHelperError("guest_file_binding_missing", "confined guest filesystem has no protected helper binding");
  return binding;
}
export function guestFileError(error: unknown): ToolResultPayload {
  const code = error instanceof GuestFileHelperError ? error.code : "guest_file_failed";
  const uncertain = error instanceof GuestFileHelperError && error.effectsUncertain;
  return { output: `Error [${code}]: guest file operation ${uncertain ? "may have changed files; do not replay automatically" : "refused"}`, isError: true };
}
export function guestToolUnsupported(ctx: ToolExecutionContext, name: string): ToolResultPayload | undefined {
  try { if (!guestFileSessionOf(ctx)) return undefined; return { output: `Error [guest_tool_unsupported]: ${name} has no confined guest implementation`, isError: true }; }
  catch (error) { return guestFileError(error); }
}
