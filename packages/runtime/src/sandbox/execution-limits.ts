/** Trusted host contract shared with the actual SDK tool/process producers. */
export const HOST_CODE_EXECUTION_LIMITS_VERSION = 1;
export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const BASH_CEILING_TIMEOUT_MS = 600_000;
export const MONITOR_PERSISTENT_TIMEOUT_MS = 2_147_483_647;
export const DEFAULT_MAX_STREAMED_BYTES = 5 * 1024 ** 3;
export function resolveBashTimeout(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return BASH_DEFAULT_TIMEOUT_MS;
  return Math.min(requested, BASH_CEILING_TIMEOUT_MS);
}
export function hostCodeExecutionLimitsFor(name: string, input: Record<string, unknown>): { timeoutMs: number; maxStreamedBytes: number } {
  let timeoutMs: number;
  if (name === "Workflow") timeoutMs = 0;
  else if (name === "Bash") timeoutMs = resolveBashTimeout(typeof input.timeout === "number" ? input.timeout : undefined);
  else if (name === "Monitor") {
    if (input.persistent === true) timeoutMs = MONITOR_PERSISTENT_TIMEOUT_MS;
    else if (typeof input.timeout_ms === "number" && Number.isFinite(input.timeout_ms) && input.timeout_ms > 0) timeoutMs = input.timeout_ms;
    else throw new Error("host Code Monitor timeout is not admitted");
  } else throw new Error("unsupported host Code execution tool");
  return { timeoutMs, maxStreamedBytes: DEFAULT_MAX_STREAMED_BYTES };
}
