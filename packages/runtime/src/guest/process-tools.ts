import type { ToolExecutionContext, ToolResultPayload } from "../tools/registry.ts";
import { guestFileSessionOf, guestFileError } from "./file-session.ts";
import { GuestProcessError } from "./process-helper.ts";
import { resolveBashTimeout } from "../sandbox/execution-limits.ts";

export async function guestBash(input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload | undefined> {
  try {
    const session = guestFileSessionOf(ctx);
    if (!session) return undefined;
    if (!session.executeProcess) return { output: "Error [guest_tool_unsupported]: Bash has no protected guest process port", isError: true };
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new GuestProcessError("invalid_request", "Bash requires input");
    const value = input as Record<string, unknown>;
    if (typeof value.command !== "string" || !value.command || (value.timeout !== undefined && (typeof value.timeout !== "number" || !Number.isFinite(value.timeout) || value.timeout <= 0)) || (value.description !== undefined && typeof value.description !== "string") || (value.run_in_background !== undefined && typeof value.run_in_background !== "boolean") || (value.dangerouslyDisableSandbox !== undefined && typeof value.dangerouslyDisableSandbox !== "boolean")) throw new GuestProcessError("invalid_request", "invalid Bash input");
    if (value.run_in_background === true) throw new GuestProcessError("background_unsupported", "guest background lifecycle is not implemented");
    if (value.dangerouslyDisableSandbox === true) throw new GuestProcessError("escape_denied", "guest process cannot bypass its compartment");
    const result = await session.executeProcess(value.command, ctx.cwd, Math.ceil(resolveBashTimeout(value.timeout as number | undefined)), ctx.signal);
    const text = `${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`;
    const cap = 30_000, output = text.length > cap ? `${text.slice(0, cap)}\n[Guest inline output truncated; no runtime overflow file was created]` : text;
    return { output: `${output}\n[Exit code: ${result.exitCode}; cwd changes apply to this command only]${result.termination === "exit" ? "" : `\n[Guest process stopped: ${result.termination}]`}`, ...(result.exitCode !== 0 || result.termination !== "exit" ? { isError: true } : {}) };
  } catch (error) {
    if (!(error instanceof GuestProcessError)) return guestFileError(error);
    return { output: `Error [${error.code}]: guest process ${error.effectsUncertain ? "may have changed files; do not replay automatically" : "refused"}`, isError: true };
  }
}
