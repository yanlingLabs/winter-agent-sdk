/** Fixture-only metadata. Never print tool contents, paths, exception text or authority. */
const CODES = new Set(["capacity_busy", "transport_lost", "binding_mismatch", "invalid_response", "worker_failed", "authority_denied", "compartment_required", "openat2_unavailable", "root_unavailable", "path_denied", "read_failed", "file_changed", "payload_limit", "invalid_request", "invalid_payload", "guest_file_failed", "guest_file_binding_missing", "guest_file_binding_invalid", "guest_file_posture_mismatch", "guest_file_posture_invalid", "guest_tool_unsupported", "cancelled", "aborted", "pipe_failed", "fork_failed", "resource_unavailable", "uncertain_effect"]);
type Termination = "exit" | "timeout" | "output_limit" | "other";
export type BuildObservation =
  | { phase: "pending" }
  | { phase: "fulfilled"; exitCode: number | null; termination: Termination }
  | { phase: "rejected"; errorCode: string; effectsUncertain: boolean };
function knownCode(code: unknown): string { return typeof code === "string" && CODES.has(code) ? code : "other"; }
export function observeBuildSuccess(value: { exitCode: number; termination: string }): BuildObservation {
  return { phase: "fulfilled", exitCode: Number.isInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 255 ? value.exitCode : null,
    termination: value.termination === "exit" || value.termination === "timeout" || value.termination === "output_limit" ? value.termination : "other" };
}
export function observeBuildFailure(error: unknown): BuildObservation {
  try {
    const value = error as { code?: unknown; effectsUncertain?: unknown } | null;
    return { phase: "rejected", errorCode: knownCode(value?.code), effectsUncertain: value?.effectsUncertain === true };
  } catch { return { phase: "rejected", errorCode: "other", effectsUncertain: false }; }
}
export function concurrencyDiagnostic(finished: number, builds: readonly BuildObservation[], reads: readonly { output: string; isError?: boolean }[]) {
  let errors = 0, wrongContent = 0; const errorCodes: Record<string, number> = {};
  for (const read of reads.slice(0, 10)) {
    if (read.isError) {
      errors++;
      const match = /^Error \[([a-z_]{1,64})\]:/.exec(read.output.slice(0, 80));
      const code = knownCode(match?.[1]); errorCodes[code] = (errorCodes[code] ?? 0) + 1;
    } else if (read.output !== "hello\n") wrongContent++;
  }
  return { kind: "guest-concurrency-probe", version: 1,
    finishedBuilds: Number.isSafeInteger(finished) && finished >= 0 && finished <= 2 ? finished : null,
    // Copy/revalidate the locally produced metadata; no nested caller object or
    // custom error/termination value becomes a diagnostic field.
    builds: builds.slice(0, 2).map(value => value.phase === "pending" ? { phase: "pending" as const }
      : value.phase === "fulfilled" ? observeBuildSuccess({ exitCode: value.exitCode ?? -1, termination: value.termination })
      : observeBuildFailure({ code: value.errorCode, effectsUncertain: value.effectsUncertain })), readCount: Math.min(reads.length, 10),
    inputShapeValid: builds.length === 2 && reads.length === 10,
    failedConditions: { buildsFinished: finished !== 0, readErrors: errors !== 0, readContent: wrongContent !== 0 },
    reads: { errors, wrongContent, exactHello: Math.min(reads.length, 10) - errors - wrongContent, errorCodes } };
}
