/** Negotiated capability of this runtime image; does not assert an OS sandbox exists. */
export const RUNTIME_EXECUTION_POSTURE_CAPABILITIES = Object.freeze({
  protocolVersion: 1,
  capabilities: ["confined-guest-posture-v1"] as readonly string[],
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
export function assertRuntimeExecutionPosture(config: { executionPosture?: unknown }): void {
  if (config.executionPosture === undefined || config.executionPosture === "local") return;
  if (config.executionPosture === "confined-guest") throw new GuestExecutionUnavailableError();
  throw new Error("unknown runtime execution posture");
}
