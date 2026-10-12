import { HOST_CODE_PROCESS_SUBTYPES, type HostCodeProcessHandle, type HostCodeProcessScope, type HostCodeProcessStart, type HostCodeProcessStartReply, type HostCodeProcessPollReply, type HostCodeProcessWrite } from "@yanlinglabs/winter-agent-sdk";
import type { RpcBridge } from "../rpc/bridge.ts";

export interface HostCodeProcessClient {
  start(request: HostCodeProcessStart, signal?: AbortSignal): Promise<HostCodeProcessStartReply>;
  poll(handle: HostCodeProcessHandle, afterSequence: number, signal?: AbortSignal): Promise<HostCodeProcessPollReply>;
  write(request: HostCodeProcessWrite, signal?: AbortSignal): Promise<void>;
  signal(handle: HostCodeProcessHandle, signal: "SIGTERM" | "SIGKILL"): Promise<void>;
  release(handle: HostCodeProcessHandle, afterSequence: number, options?: { abandon: true }): Promise<void>;
}
export function createHostCodeProcessClient(bridge: RpcBridge): HostCodeProcessClient {
  return {
    start: (request, signal) => bridge.request(HOST_CODE_PROCESS_SUBTYPES.start, request, { ...(signal ? { signal } : {}), cancelGraceMs: 5000 }),
    poll: (handle, afterSequence, signal) => bridge.request(HOST_CODE_PROCESS_SUBTYPES.poll, { handle, afterSequence, maxBytes: 65536, maxWaitMs: 30_000 }, { ...(signal ? { signal } : {}), timeoutMs: 35_000 }),
    write: (request, signal) => bridge.request(HOST_CODE_PROCESS_SUBTYPES.write, request, { ...(signal ? { signal } : {}), timeoutMs: 5000 }),
    signal: (handle, signal) => bridge.request(HOST_CODE_PROCESS_SUBTYPES.signal, { handle, signal }, { timeoutMs: 5000 }),
    release: (handle, afterSequence, options) => bridge.request(HOST_CODE_PROCESS_SUBTYPES.release, { handle, afterSequence, ...(options?.abandon ? { abandon: true } : {}) }, { timeoutMs: 5000 }),
  };
}
/** One runtime process / embedded Worker realm. Never installed from settings or model inputs. */
let broker: { client: HostCodeProcessClient; generationId: string } | undefined;
let requiredOwners = 0;
/** Trusted lifecycle enrollment, independent of the client's availability. Never sourced from
 * RuntimeConfig, environment or tool arguments. Removing a client cannot permit local fallback. */
export function requireHostCodeProcessBroker(): () => void {
  requiredOwners++;
  let released = false;
  return () => { if (!released) { released = true; requiredOwners--; } };
}
export function hostCodeProcessBrokerRequired(): boolean { return requiredOwners > 0; }
export function installHostCodeProcessClient(value: { client: HostCodeProcessClient; generationId: string } | undefined): () => void {
  const previous = broker; broker = value;
  return () => { broker = previous; };
}
export function currentHostCodeProcessClient() { return broker; }
export function requireBoundHandle(handle: HostCodeProcessHandle, scope: HostCodeProcessScope): void {
  if (!handle || typeof handle.id !== "string" || handle.generationId !== scope.generationId || handle.sessionId !== scope.sessionId || handle.toolUseId !== scope.toolUseId || !Number.isSafeInteger(handle.pid) || handle.pid < 1) throw new Error("host Code broker returned a foreign process handle");
}
