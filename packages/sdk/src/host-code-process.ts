/** Wire DTOs only: a trusted host constructs canonical execution policy from its own context. */
export const HOST_CODE_PROCESS_BROKER_VERSION = 1;
export const HOST_CODE_PROCESS_BROKER_CAPABILITY = "host-code-process-broker-v1";
export const HOST_CODE_PROCESS_SUBTYPES = {
  start: "host_code_process_start", poll: "host_code_process_poll", write: "host_code_process_write", signal: "host_code_process_signal", release: "host_code_process_release",
} as const;
export interface HostCodeProcessScope { generationId: string; sessionId: string; toolUseId: string; agentId?: string; parentToolUseId?: string }
export type HostCodeProcessStart = HostCodeProcessScope & {
  version: 1; kind: "command" | "workflow"; cwd: string; timeoutMs: number; maxStreamedBytes: number;
  command?: string; workflowRunId?: string;
  /** Advisory path only; host validates current scratch ownership and constructs the wrapper itself. */
  pwdCapturePath?: string;
  /** Intent only. Host re-evaluates current policy; never accept an approval from the runtime. */
  sandboxIntent?: "ordinary" | "override-requested";
};
export interface HostCodeProcessHandle { id: string; generationId: string; sessionId: string; toolUseId: string; pid: number }
export interface HostCodeProcessEvent { sequence: number; stream: "stdout" | "stderr"; dataBase64: string }
export interface HostCodeProcessPoll {
  handle: HostCodeProcessHandle; afterSequence: number; maxBytes: number; maxWaitMs: number;
}
export interface HostCodeProcessPollReply {
  handle: HostCodeProcessHandle; events: readonly HostCodeProcessEvent[];
  exit?: { code: number | null; signal: string | null; timedOut: boolean; aborted: boolean; streamKilled: boolean };
}
export interface HostCodeProcessStartReply { handle: HostCodeProcessHandle; posture: "sandboxed" | "config-disabled" | "excluded" | "override-requested" }
export interface HostCodeProcessWrite { handle: HostCodeProcessHandle; dataBase64?: string; end?: true }
export interface HostCodeProcessSignal { handle: HostCodeProcessHandle; signal: "SIGTERM" | "SIGKILL" }
/** Host-only function registration. The matching wire marker cannot create this callback. */
export interface HostCodeProcessRegistration {
  generationId: string;
  /** One registration per query channel; close admission and stop owned processes at teardown. */
  dispose?(): void;
  handle(subtype: (typeof HOST_CODE_PROCESS_SUBTYPES)[keyof typeof HOST_CODE_PROCESS_SUBTYPES], payload: unknown, context: { signal: AbortSignal; callerSessionId: string; generationId: string }): Promise<unknown>;
}
