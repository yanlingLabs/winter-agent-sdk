/** Fresh-store Linux supervisor admission. Kernel-validated owner capability, not config/env authority. */
import { linuxEndedBootEvidence, linuxRecordContinuationValid, linuxResumeSelectorMatches } from "./linux-cold-resume.ts";
import { assertLinuxHostQueryConfig, assertLinuxHostQueryRoots, checkLinuxHostQueryFrame, LINUX_HOST_QUERY_PROFILE, type OwnsHostRequest } from "./linux-host-query-profile.ts";
import { assertLinuxGuidedHostQueryConfig, assertLinuxGuidedHostQueryRoots, LINUX_GUIDED_HOST_QUERY_PROFILE } from "./linux-guided-host-query-profile.ts";
import { parseLinuxGuidedReaderRegistration, type LinuxGuidedReaderRegistration } from "./linux-guided-reader-protocol.ts";
import type { LinuxGuidedReaderChannel } from "./linux-guided-reader-channel.ts";
import { constructLinuxGuidedReaderChannel, assertLinuxGuidedReaderSymbols } from "./linux-guided-reader-construction.ts";
import { createLinuxGuidedReaderSocketWire } from "./linux-guided-reader-socket.ts";
import { createGuidedParentBridge, type GuidedParentBridge } from "./guided-parent-bridge.ts";
import type { FrameSink } from "../protocol/channel.ts";
import { dlopen, FFIType } from "bun:ffi";
import { fstatSync } from "node:fs";
import { createConnection } from "node:net";
import type { HeldInputEpoch, RuntimeConfig, UserFrame } from "@yanlinglabs/winter-agent-sdk";
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
  profile?: typeof LINUX_HOST_QUERY_PROFILE | typeof LINUX_GUIDED_HOST_QUERY_PROFILE; protocolVersion: 1; freshOnly?: true; continuation?: "fresh" | "resume"; endedGuestBoots?: string[]; runtimeUid: number; toolUid: number; logicalSessionId: string;
  scope: ProtectedStoreScope; ownerToken: string; runtimeConfig: RuntimeConfig;
  authority: GuestFileAuthority; roots: GuestFileRoot[]; toolSocketPath: string;
  provider: { scope: GuestProviderScope; selection: GuestProviderSelection };
  readerRegistration?: LinuxGuidedReaderRegistration;
}
interface State {
  record: BootstrapRecord; check(): void; dispose(): void; phase: "ready" | "running" | "closed";
  signal: AbortSignal; files: GuestFileSession; provider: GuestProviderClient; store: ProtectedStoreBootstrap;
  guided?: { registration: Readonly<LinuxGuidedReaderRegistration>; createReader(): LinuxGuidedReaderChannel; reader?: LinuxGuidedReaderChannel; channel?: GuidedParentBridge; output?: FrameSink };
}
const admissions = new WeakMap<LinuxSessionAdmission, State>();
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
const unavailable = (): never => { throw new Error("fresh Linux session admission unavailable"); };
type LinuxProfile = "fresh" | typeof LINUX_HOST_QUERY_PROFILE | typeof LINUX_GUIDED_HOST_QUERY_PROFILE;
function validateRecord(record: BootstrapRecord, profile: LinuxProfile): void {
  if ((profile === "fresh" && record.profile !== undefined) || (profile !== "fresh" && record.profile !== profile)) unavailable();
  if (record.protocolVersion !== 1 || !linuxRecordContinuationValid(record) || !id(record.logicalSessionId) || record.runtimeUid !== process.getuid?.() || !Number.isSafeInteger(record.toolUid) || record.toolUid < 1000 || record.toolUid === record.runtimeUid || !record.ownerToken || record.scope.sessionId !== record.authority.sessionId || record.scope.workspaceId !== record.authority.workspaceId || record.scope.incarnationId !== record.authority.incarnationId || record.scope.leaseEpoch !== record.authority.leaseEpoch) unavailable();
  const home = `/run/winter/conversations/${record.logicalSessionId}`, store = `/workspace/.winter/conversations/${record.logicalSessionId}`;
  if (record.scope.storeHome !== store || record.toolSocketPath !== `${home}/.control/tools.sock` || record.runtimeConfig.winterHome !== home || record.runtimeConfig.storeHome !== store || record.runtimeConfig.sessionId !== record.scope.sessionId || record.provider.scope.backendSessionId !== record.scope.sessionId || record.provider.scope.sessionId !== record.logicalSessionId || record.provider.scope.bootId !== record.scope.currentBootId || record.runtimeConfig.model !== record.provider.selection.modelKey) unavailable();
  validateConfig(record.runtimeConfig, record);
  if (record.profile === LINUX_HOST_QUERY_PROFILE) assertLinuxHostQueryRoots(record.runtimeConfig, record.roots);
  if (record.profile === LINUX_GUIDED_HOST_QUERY_PROFILE) {
    const registration = parseLinuxGuidedReaderRegistration(record.readerRegistration), owner = registration.owner;
    if (owner.workspaceId !== record.scope.workspaceId || owner.logicalSessionId !== record.logicalSessionId || owner.backendSessionId !== record.scope.sessionId
      || owner.incarnationId !== record.scope.incarnationId || owner.leaseEpoch !== record.scope.leaseEpoch || owner.bootId !== record.scope.currentBootId) unavailable();
    assertLinuxGuidedHostQueryRoots(record.runtimeConfig, record.roots, registration);
    record.readerRegistration = registration;
  } else if (record.readerRegistration !== undefined) unavailable();
}
function validateConfig(config: RuntimeConfig, record: BootstrapRecord): void {
  const fixed = record.runtimeConfig;
  // The cold-resume selector is part of the admitted identity: a fresh record admits no `resume`, a resume record admits exactly its own session.
  if (record.profile !== undefined && !linuxResumeSelectorMatches(fixed, config)) unavailable();
  if (record.profile === LINUX_GUIDED_HOST_QUERY_PROFILE) {
    assertLinuxGuidedHostQueryConfig(config, record.readerRegistration);
    for (const key of Object.keys(fixed) as (keyof RuntimeConfig)[]) if (!same(config[key], fixed[key])) unavailable();
    return;
  }
  if (record.profile === LINUX_HOST_QUERY_PROFILE) {
    assertLinuxHostQueryConfig(config);
    // Every admitted value remains fixed. Only provider-derived context sizing may be added.
    for (const key of Object.keys(fixed) as (keyof RuntimeConfig)[]) if (!same(config[key], fixed[key])) unavailable();
    return;
  }
  // Root preauthorizes the four fixture tools. SDK default avoids its separate
  // model classifier; this is not the production host Auto approval bridge.
  // Only provider-derived context sizing may supplement the root-created initial config.
  const admittedKeys = new Set([...Object.keys(fixed), "contextWindowTokens"]);
  if (Object.keys(config).some(key => !admittedKeys.has(key))) unavailable();
  if (config.executionPosture !== "confined-guest" || config.sessionId !== record.scope.sessionId || config.winterHome !== fixed.winterHome || config.storeHome !== record.scope.storeHome || config.cwd !== fixed.cwd || config.model !== fixed.model || config.persistSession !== true || !same(config.tools, FRESH_LINUX_TOOLS) || !same(config.allowedTools, FRESH_LINUX_TOOLS) || !same(config.settingSources, []) || !same(config.skills, []) || !same(config.plugins, []) || config.strictMcpConfig !== true || !same(config.mcpServers, {}) || config.permissionMode !== "default") unavailable();
  for (const key of ["resume", "continue", "forkSession", "resumeSessionAt", "resumeDropsTurn", "agentId", "agents", "hooks", "hostCodeProcessBroker", "fallbackModel", "additionalDirectories", "managedSettings", "serverManagedSettings", "outputStyle", "pluginCacheDir", "forkSubagent", "backgroundByDefault"] as const) if (config[key as keyof RuntimeConfig] !== undefined) unavailable();
}
function stateOf(value: LinuxSessionAdmission | undefined): State {
  if (!value) return unavailable(); const state = admissions.get(value); if (!state || state.phase === "closed") return unavailable(); state.check(); return state;
}
/** Loads only a root-owned readonly inherited library FD. open() performs real peer/UID/pidfd/executable/store/kernel-boot checks. */
export function admitFreshLinuxSession(bootstrapFd: number, ownerLibraryFd: number): LinuxSessionAdmission {
  return admitLinuxSession(bootstrapFd, ownerLibraryFd, "fresh");
}
/** Requires the distinct host-query policy in the root-sent, native-validated bootstrap record.
 * This factory takes only inherited descriptors, never caller configuration or JSON authority. */
export function admitHostQueryLinuxSession(bootstrapFd: number, ownerLibraryFd: number): LinuxSessionAdmission {
  return admitLinuxSession(bootstrapFd, ownerLibraryFd, LINUX_HOST_QUERY_PROFILE);
}
/** Prospective guided entry only; requires the reviewed five-FD native owner ABI.
 * No current entry, producer or public SDK export calls this factory. */
export function admitGuidedHostQueryLinuxSession(bootstrapFd: number, ownerLibraryFd: number): LinuxSessionAdmission {
  return admitLinuxSession(bootstrapFd, ownerLibraryFd, LINUX_GUIDED_HOST_QUERY_PROFILE);
}
function admitLinuxSession(bootstrapFd: number, ownerLibraryFd: number, profile: LinuxProfile): LinuxSessionAdmission {
  if (process.platform !== "linux" || !Number.isInteger(bootstrapFd) || bootstrapFd < 3 || !Number.isInteger(ownerLibraryFd) || ownerLibraryFd < 3 || bootstrapFd === ownerLibraryFd) return unavailable();
  const artifact = fstatSync(ownerLibraryFd); if (!artifact.isFile() || artifact.uid !== 0 || artifact.nlink !== 1 || (artifact.mode & 0o222) !== 0 || artifact.size > 4 * 1024 * 1024) return unavailable();
  const library = dlopen(`/proc/self/fd/${ownerLibraryFd}`, {
    winter_owner_open: { args: [FFIType.i32], returns: FFIType.u64 }, winter_owner_record: { args: [FFIType.u64], returns: FFIType.cstring },
    winter_owner_check: { args: [FFIType.u64], returns: FFIType.i32 }, winter_owner_process_identity: { args: [FFIType.u64, FFIType.i32], returns: FFIType.cstring }, winter_owner_close: { args: [FFIType.u64], returns: FFIType.void },
    ...(profile === LINUX_GUIDED_HOST_QUERY_PROFILE ? {
      winter_owner_claim_reader: { args: [FFIType.u64] as const, returns: FFIType.i32 as const },
      winter_owner_reader_shutdown: { args: [FFIType.u64] as const, returns: FFIType.void as const },
    } : {}),
  });
  const handle = library.symbols.winter_owner_open(bootstrapFd); if (handle === 0n) { library.close(); return unavailable(); }
  let poll: ReturnType<typeof setInterval> | undefined;
  const controller = new AbortController(); let closed = false;
  const check = (): void => { if (closed || library.symbols.winter_owner_check(handle) !== 0) { controller.abort(); return unavailable(); } };
  const closeOwner = (): void => { if (closed) return; closed = true; if (poll) clearInterval(poll); library.symbols.winter_owner_close(handle); library.close(); };
  try {
    const raw = library.symbols.winter_owner_record(handle); if (!raw || Buffer.byteLength(raw.toString()) > 65536) return unavailable();
    const record = JSON.parse(raw.toString()) as BootstrapRecord; validateRecord(record, profile);
    if (record.profile === LINUX_GUIDED_HOST_QUERY_PROFILE) assertLinuxGuidedReaderSymbols(library.symbols);
    // Evidence only for a boot the host attested as ended (see linux-cold-resume.ts); an unlisted boot reads as alive.
    const owner: ProtectedStoreOwner = {
      scope: Object.freeze({ ...record.scope }), ownerToken: record.ownerToken, signal: controller.signal, assertHeld: check,
      processIdentity(pid) { check(); if (pid !== process.pid) return null; const value = library.symbols.winter_owner_process_identity(handle, pid); if (!value) return null; const identity = JSON.parse(value.toString()); return typeof identity.bootId === "string" && typeof identity.startTicks === "string" && /^\d+$/.test(identity.startTicks) ? identity : null; },
      previousBootTermination: bootId => linuxEndedBootEvidence(record, bootId), runtimeTeardownEvidence: () => null,
      release: async () => { throw new Error("live runtime cannot prove native teardown; service retains store ownership"); },
    };
    const store = createProtectedStoreBootstrap(record.scope, { acquire: async scope => { check(); if (!same(scope, record.scope)) return unavailable(); return owner; } });
    const files = createLinuxSupervisorSession({ socketPath: record.toolSocketPath, authority: record.authority, roots: record.roots, toolUid: record.toolUid });
    const provider = createGuestProviderClient({ scope: record.provider.scope, selection: record.provider.selection, port: createLinuxProviderPort(`${record.runtimeConfig.winterHome}/.control/provider.sock`, check) });
    poll = setInterval(() => { try { check(); } catch { provider.close(); } }, 100); poll.unref?.();
    const admission = Object.freeze({}) as LinuxSessionAdmission;
    // Conditional symbol dictionaries lose their FFI tuple inference in Bun's
    // declarations. These functions still come solely from the selected immutable
    // native library; no caller-supplied implementation enters the registry.
    const readerSymbols = library.symbols as unknown as {
      winter_owner_claim_reader(owner: typeof handle): number;
      winter_owner_reader_shutdown(owner: typeof handle): void;
    };
    const guided = record.profile === LINUX_GUIDED_HOST_QUERY_PROFILE ? { registration: record.readerRegistration!, createReader() {
      check();
      return constructLinuxGuidedReaderChannel({ registration: record.readerRegistration!, assertOwnerHeld: check, closeOwner,
        createWire() { return createLinuxGuidedReaderSocketWire({ claimDup() { check(); return readerSymbols.winter_owner_claim_reader(handle); },
          shutdownOriginal() { readerSymbols.winter_owner_reader_shutdown(handle); } }); } });
    } } : undefined;
    const state: State = { record, signal: controller.signal, check, files, provider, store, phase: "ready", ...(guided ? { guided } : {}),
      dispose() { state.guided?.channel?.close(); state.guided?.reader?.close(); provider.close(); closeOwner(); } };
    // Only native owner open + its immutable Root record can enter this registry.
    // There is deliberately no injected/test admission factory.
    admissions.set(admission, state); return admission;
  } catch (error) { closeOwner(); throw error; }
}
/** Rechecks native liveness before selecting the closed input surface. */
export function checkLinuxSessionFrame(value: LinuxSessionAdmission, config: RuntimeConfig, frame: unknown, ownsPermission: (id: string) => boolean, ownsHostRequest?: OwnsHostRequest): "accept" | "drop" {
  const state = stateOf(value); validateConfig(config, state.record);
  if (state.record.profile === LINUX_HOST_QUERY_PROFILE) return checkLinuxHostQueryFrame(frame, ownsPermission, ownsHostRequest);
  if (state.record.profile === LINUX_GUIDED_HOST_QUERY_PROFILE) return checkLinuxHostQueryFrame(frame, ownsPermission, ownsHostRequest);
  assertFreshLinuxUserFrame(frame); return "accept";
}
/** One output/channel binding for this actual admitted parent incarnation. */
export function bindLinuxGuidedSessionChannel(value: LinuxSessionAdmission, config: RuntimeConfig, output: FrameSink): GuidedParentBridge {
  const state = stateOf(value); validateConfig(config, state.record);
  if (state.phase !== "running" || !state.guided || state.guided.reader !== undefined || state.guided.channel !== undefined) return unavailable();
  const guided = state.guided;
  const reader = guided.createReader(); guided.reader = reader;
  const channel = createGuidedParentBridge({ binding: guided.registration.requiredRuntimeContext, backendSessionId: state.record.scope.sessionId,
    cwd: guided.registration.views.sourceCwd, assertOwnerHeld: state.check, readerPort: reader, output });
  guided.output = output; guided.channel = channel;
  state.signal.addEventListener("abort", () => { channel.close(); reader.close(); }, { once: true });
  if (state.signal.aborted) { channel.close(); reader.close(); unavailable(); }
  return channel;
}
export function linuxGuidedSessionChannel(value: LinuxSessionAdmission | undefined, config: RuntimeConfig, output?: FrameSink): GuidedParentBridge {
  try {
    const state = stateOf(value); validateConfig(config, state.record);
    if (state.phase !== "running" || state.record.profile !== LINUX_GUIDED_HOST_QUERY_PROFILE || !state.guided?.channel || (output !== undefined && state.guided.output !== output)) return unavailable();
    return state.guided.channel;
  } catch { throw new Error("required_context_unavailable"); }
}
export function linuxSessionProfile(value: LinuxSessionAdmission): LinuxProfile { return stateOf(value).record.profile ?? "fresh"; }
export function linuxSessionConfig(value: LinuxSessionAdmission): RuntimeConfig { return structuredClone(stateOf(value).record.runtimeConfig); }
export function claimLinuxSession(value: LinuxSessionAdmission, config: RuntimeConfig): void { const state = stateOf(value); if (state.phase !== "ready") unavailable(); validateConfig(config, state.record); state.phase = "running"; }
export function assertLinuxSession(value: LinuxSessionAdmission | undefined, config: RuntimeConfig): void { const state = stateOf(value); validateConfig(config, state.record); }
export function assertRunningLinuxSession(value: LinuxSessionAdmission | undefined, config: RuntimeConfig, provider?: object): void { const state = stateOf(value); if (state.phase !== "running") unavailable(); validateConfig(config, state.record); if (provider !== undefined) assertGuestProviderRoute(state.provider, provider); }
export function linuxSessionBindings(value: LinuxSessionAdmission) { const state = stateOf(value); return { store: state.store, files: state.files, provider: state.provider, signal: state.signal }; }
/** The admitted incarnation and lease epoch a held-input hold must name; only a host-query profile has a held-input journal. */
export function linuxSessionHeldInputEpoch(value: LinuxSessionAdmission): HeldInputEpoch | undefined {
  const state = stateOf(value), profile = state.record.profile;
  if (profile !== LINUX_HOST_QUERY_PROFILE && profile !== LINUX_GUIDED_HOST_QUERY_PROFILE) return undefined;
  return { incarnationId: state.record.scope.incarnationId, leaseEpoch: state.record.scope.leaseEpoch };
}
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
