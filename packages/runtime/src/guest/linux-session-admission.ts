/** Fresh-only Linux supervisor admission. Kernel-validated owner capability, not config/env authority. */
import { dlopen, FFIType } from "bun:ffi";
import { fstatSync } from "node:fs";
import { createConnection } from "node:net";
import type { RuntimeConfig, UserFrame } from "@yanlinglabs/winter-agent-sdk";
import type { ToolExecutionContext } from "../tools/registry.ts";
import { createLinuxSupervisorSession } from "./supervisor-client.ts";
import type { GuestFileSession } from "./file-session.ts";
import { bindGuestFileSession } from "./file-session.ts";
import { createGuestProviderClient, assertGuestProviderRoute, type GuestProviderClient, type GuestProviderScope, type GuestProviderSelection, type GuestProviderPort } from "./provider-client.ts";
import { createProtectedStoreBootstrap, type ProtectedStoreBootstrap, type ProtectedStoreScope, type ProtectedStoreOwner } from "./store-bootstrap.ts";
import type { GuestFileAuthority, GuestFileRoot } from "./file-helper.ts";

export const FRESH_LINUX_TOOLS = Object.freeze(["Read", "Write", "Edit", "Bash"] as const);
/** The fresh fixture accepts ordinary runtime text input, with no control or attachment surface. */
export function assertFreshLinuxUserFrame(frame: unknown): asserts frame is UserFrame {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("fresh Linux input route unavailable");
  const value = frame as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== "type" && key !== "text") || value.type !== "user" || typeof value.text !== "string" || value.text.trimStart().startsWith("/")) throw new Error("fresh Linux input route unavailable");
}
declare const brand: unique symbol;
export interface LinuxSessionAdmission { readonly [brand]: true }
interface BootstrapRecord {
  protocolVersion: 1; freshOnly: true; runtimeUid: number; toolUid: number; logicalSessionId: string;
  scope: ProtectedStoreScope; ownerToken: string; runtimeConfig: RuntimeConfig;
  authority: GuestFileAuthority; roots: GuestFileRoot[]; toolSocketPath: string;
  provider: { scope: GuestProviderScope; selection: GuestProviderSelection };
}
interface State {
  record: BootstrapRecord; check(): void; dispose(): void; phase: "ready" | "running" | "closed";
  signal: AbortSignal; files: GuestFileSession; provider: GuestProviderClient; store: ProtectedStoreBootstrap;
}
const admissions = new WeakMap<LinuxSessionAdmission, State>();
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
const unavailable = (): never => { throw new Error("fresh Linux session admission unavailable"); };
function validateRecord(record: BootstrapRecord): void {
  if (record.protocolVersion !== 1 || record.freshOnly !== true || !id(record.logicalSessionId) || record.runtimeUid !== process.getuid?.() || !Number.isSafeInteger(record.toolUid) || record.toolUid < 1000 || record.toolUid === record.runtimeUid || !record.ownerToken || record.scope.sessionId !== record.authority.sessionId || record.scope.workspaceId !== record.authority.workspaceId || record.scope.incarnationId !== record.authority.incarnationId || record.scope.leaseEpoch !== record.authority.leaseEpoch) unavailable();
  const home = `/run/winter/conversations/${record.logicalSessionId}`, store = `/workspace/.winter/conversations/${record.logicalSessionId}`;
  if (record.scope.storeHome !== store || record.toolSocketPath !== `${home}/.control/tools.sock` || record.runtimeConfig.winterHome !== home || record.runtimeConfig.storeHome !== store || record.runtimeConfig.sessionId !== record.scope.sessionId || record.provider.scope.backendSessionId !== record.scope.sessionId || record.provider.scope.sessionId !== record.logicalSessionId || record.provider.scope.bootId !== record.scope.currentBootId || record.runtimeConfig.model !== record.provider.selection.modelKey) unavailable();
  validateConfig(record.runtimeConfig, record);
}
function validateConfig(config: RuntimeConfig, record: BootstrapRecord): void {
  const fixed = record.runtimeConfig;
  // Only provider-derived context sizing may supplement the root-created initial config.
  const admittedKeys = new Set([...Object.keys(fixed), "contextWindowTokens"]);
  if (Object.keys(config).some(key => !admittedKeys.has(key))) unavailable();
  if (config.executionPosture !== "confined-guest" || config.sessionId !== record.scope.sessionId || config.winterHome !== fixed.winterHome || config.storeHome !== record.scope.storeHome || config.cwd !== fixed.cwd || config.model !== fixed.model || config.persistSession !== true || !same(config.tools, FRESH_LINUX_TOOLS) || !same(config.allowedTools, FRESH_LINUX_TOOLS) || !same(config.settingSources, []) || !same(config.skills, []) || !same(config.plugins, []) || config.strictMcpConfig !== true || !same(config.mcpServers, {}) || config.permissionMode !== "auto") unavailable();
  for (const key of ["resume", "continue", "forkSession", "resumeSessionAt", "resumeDropsTurn", "agentId", "agents", "hooks", "hostCodeProcessBroker", "fallbackModel", "additionalDirectories", "managedSettings", "serverManagedSettings", "outputStyle", "pluginCacheDir", "forkSubagent", "backgroundByDefault"] as const) if (config[key as keyof RuntimeConfig] !== undefined) unavailable();
}
function stateOf(value: LinuxSessionAdmission | undefined): State {
  if (!value) return unavailable(); const state = admissions.get(value); if (!state || state.phase === "closed") return unavailable(); state.check(); return state;
}
/** Loads only a root-owned readonly inherited library FD. open() performs real peer/UID/pidfd/executable/store/kernel-boot checks. */
export function admitFreshLinuxSession(bootstrapFd: number, ownerLibraryFd: number): LinuxSessionAdmission {
  if (process.platform !== "linux" || !Number.isInteger(bootstrapFd) || bootstrapFd < 3 || !Number.isInteger(ownerLibraryFd) || ownerLibraryFd < 3 || bootstrapFd === ownerLibraryFd) return unavailable();
  const artifact = fstatSync(ownerLibraryFd); if (!artifact.isFile() || artifact.uid !== 0 || artifact.nlink !== 1 || (artifact.mode & 0o222) !== 0 || artifact.size > 4 * 1024 * 1024) return unavailable();
  const library = dlopen(`/proc/self/fd/${ownerLibraryFd}`, {
    winter_owner_open: { args: [FFIType.i32], returns: FFIType.u64 }, winter_owner_record: { args: [FFIType.u64], returns: FFIType.cstring },
    winter_owner_check: { args: [FFIType.u64], returns: FFIType.i32 }, winter_owner_process_identity: { args: [FFIType.u64, FFIType.i32], returns: FFIType.cstring }, winter_owner_close: { args: [FFIType.u64], returns: FFIType.void },
  });
  const handle = library.symbols.winter_owner_open(bootstrapFd); if (handle === 0n) { library.close(); return unavailable(); }
  let poll: ReturnType<typeof setInterval> | undefined;
  const controller = new AbortController(); let closed = false;
  const check = (): void => { if (closed || library.symbols.winter_owner_check(handle) !== 0) { controller.abort(); return unavailable(); } };
  const closeOwner = (): void => { if (closed) return; closed = true; if (poll) clearInterval(poll); library.symbols.winter_owner_close(handle); library.close(); };
  try {
    const raw = library.symbols.winter_owner_record(handle); if (!raw || Buffer.byteLength(raw.toString()) > 65536) return unavailable();
    const record = JSON.parse(raw.toString()) as BootstrapRecord; validateRecord(record);
    const owner: ProtectedStoreOwner = {
      scope: Object.freeze({ ...record.scope }), ownerToken: record.ownerToken, signal: controller.signal, assertHeld: check,
      processIdentity(pid) { check(); if (pid !== process.pid) return null; const value = library.symbols.winter_owner_process_identity(handle, pid); if (!value) return null; const identity = JSON.parse(value.toString()); return typeof identity.bootId === "string" && typeof identity.startTicks === "string" && /^\d+$/.test(identity.startTicks) ? identity : null; },
      previousBootTermination: () => null, runtimeTeardownEvidence: () => null,
      release: async () => { throw new Error("live runtime cannot prove native teardown; service retains store ownership"); },
    };
    const store = createProtectedStoreBootstrap(record.scope, { acquire: async scope => { check(); if (!same(scope, record.scope)) return unavailable(); return owner; } });
    const files = createLinuxSupervisorSession({ socketPath: record.toolSocketPath, authority: record.authority, roots: record.roots, toolUid: record.toolUid });
    const provider = createGuestProviderClient({ scope: record.provider.scope, selection: record.provider.selection, port: createLinuxProviderPort(`${record.runtimeConfig.winterHome}/.control/provider.sock`, check) });
    poll = setInterval(() => { try { check(); } catch { provider.close(); } }, 100); poll.unref?.();
    const admission = Object.freeze({}) as LinuxSessionAdmission;
    admissions.set(admission, { record, signal: controller.signal, check, files, provider, store, phase: "ready", dispose() { provider.close(); closeOwner(); } }); return admission;
  } catch (error) { closeOwner(); throw error; }
}
export function linuxSessionConfig(value: LinuxSessionAdmission): RuntimeConfig { return structuredClone(stateOf(value).record.runtimeConfig); }
export function claimLinuxSession(value: LinuxSessionAdmission, config: RuntimeConfig): void { const state = stateOf(value); if (state.phase !== "ready") unavailable(); validateConfig(config, state.record); state.phase = "running"; }
export function assertLinuxSession(value: LinuxSessionAdmission | undefined, config: RuntimeConfig): void { const state = stateOf(value); validateConfig(config, state.record); }
export function assertRunningLinuxSession(value: LinuxSessionAdmission | undefined, config: RuntimeConfig, provider?: object): void { const state = stateOf(value); if (state.phase !== "running") unavailable(); validateConfig(config, state.record); if (provider !== undefined) assertGuestProviderRoute(state.provider, provider); }
export function linuxSessionBindings(value: LinuxSessionAdmission) { const state = stateOf(value); return { store: state.store, files: state.files, provider: state.provider, signal: state.signal }; }
export function bindLinuxSessionContext(value: LinuxSessionAdmission, ctx: ToolExecutionContext): void { const state = stateOf(value); if (state.phase !== "running") unavailable(); bindGuestFileSession(ctx, state.files); }
export function closeLinuxSession(value: LinuxSessionAdmission): void { const state = admissions.get(value); if (!state || state.phase === "closed") return; state.phase = "closed"; state.dispose(); }

/** Bounded transport only; this does not grant a Linux startup/store capability. */
export function createLinuxProviderPort(socketPath: string, assertHeld: () => void): GuestProviderPort {
  const sockets = new Set<ReturnType<typeof createConnection>>(); let closed = false;
  return {
      close() { closed = true; for (const socket of sockets) socket.destroy(); sockets.clear(); },
      exchange(frame, signal) { if (closed || signal?.aborted) return Promise.reject(new Error("private provider closed")); assertHeld(); return new Promise<Uint8Array>((resolve, reject) => {
        const socket = createConnection({ path: socketPath }); sockets.add(socket); let bytes = Buffer.alloc(0), expected: number | undefined, ended = false;
        const finish = (error?: Error, result?: Uint8Array): void => { if (ended) return; ended = true; signal?.removeEventListener("abort", abort); socket.destroy(); sockets.delete(socket); if (error) reject(error); else resolve(result!); };
        const abort = () => finish(new Error("private provider invocation cancelled"));
        signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
        socket.on("connect", () => { if (!ended) socket.write(frame); }); socket.on("error", () => finish(new Error("private provider unavailable"))); socket.on("end", () => finish(new Error("private provider closed"))); socket.on("close", () => finish(new Error("private provider closed")));
        socket.on("data", chunk => { if (bytes.length + chunk.length > 256 * 1024 + 4100) { finish(new Error("private provider bound")); return; } bytes = Buffer.concat([bytes, Buffer.from(chunk)]); if (bytes.length >= 4) expected ??= bytes.readUInt32BE(); if (expected !== undefined && (expected < 1 || expected > 256 * 1024 + 4096 || bytes.length > expected + 4)) { finish(new Error("private provider framing")); return; } if (expected !== undefined && bytes.length === expected + 4) { try { assertHeld(); finish(undefined, bytes); } catch { finish(new Error("private provider owner lost")); } } });
      }); },
  };
}
