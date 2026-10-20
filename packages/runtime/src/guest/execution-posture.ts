import { HELD_INPUT_CAPABILITY, type RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import { assertLinuxSession, type LinuxSessionAdmission } from "./linux-session-admission.ts";
/** Negotiated capability of this runtime image; does not assert an OS sandbox exists. */
export const RUNTIME_EXECUTION_POSTURE_CAPABILITIES = Object.freeze({
  protocolVersion: 1,
  capabilities: ["confined-guest-posture-v1", HELD_INPUT_CAPABILITY] as readonly string[],
  supportsConfinedGuestExecution: false,
});

export class GuestExecutionUnavailableError extends Error {
  readonly code = "guest_execution_unavailable";
  constructor() {
    super("confined guest execution requires protected tool-side file, shell, Workflow, hooks, MCP and LSP routes; no local execution fallback is permitted");
    this.name = "GuestExecutionUnavailableError";
  }
}

/** Called before settings, provider, stores or tools can start. Unknown postures fail closed too. */
export function assertRuntimeExecutionPosture(config: { executionPosture?: unknown }, admission?: LinuxSessionAdmission): void {
  if (config.executionPosture === undefined || config.executionPosture === "local") { if (admission !== undefined) throw new GuestExecutionUnavailableError(); return; }
  if (config.executionPosture === "confined-guest") {
    if (admission === undefined) throw new GuestExecutionUnavailableError();
    assertLinuxSession(admission, config as RuntimeConfig); return;
  }
  throw new Error("unknown runtime execution posture");
}
