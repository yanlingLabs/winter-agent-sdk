// Phase 4 Task 5 (LANE B, WS-06 §3.5 "WaitForMcpServers" implement-now; WS-09 §8.4): the real
// WaitForMcpServers executor + its pure result-shape algorithm (colocated here, unlike ToolSearch's
// own `toolsearch/search.ts` split -- nothing else in this lane needs to reuse this algorithm, so a
// separate `toolsearch/*.ts` module would just be an extra indirection with one caller).
//
// Session-runtime access reuses `toolsearch/search.ts`'s own `ToolSearchSessionRuntime` side-channel
// (keyed by `ctx.sessionId`) rather than inventing a second, parallel registry -- WaitForMcpServers is
// itself part of the same WS-09 §8 "Tool Search" subsystem (advertised precisely when Tool Search is
// INACTIVE, §8.4) and needs only the `stateSource`/`pendingWaitMs` SUBSET of what ToolSearch's own
// runtime already carries per session.
import "../descriptors/wait-for-mcp-servers.ts"; // self-sufficiency: guarantees the "WaitForMcpServers" stub is registered before replaceExecutor runs below.
import { replaceExecutor, type ToolExecutor, type ToolExecutionContext, type ToolResultPayload } from "../registry.ts";
import type { McpServerStateSource, McpServerStateKind } from "../../mcp/state.ts";
import { getToolSearchSessionRuntime } from "../../toolsearch/search.ts";

export const WAIT_FOR_MCP_SERVERS_TOOL_NAME = "WaitForMcpServers";
const DEFAULT_PENDING_WAIT_MS = 5000;

// WS-09 §8.4's own pinned union, verbatim field-for-field (including the two `?` fields and the
// deliberately-never-populated `replRouted` -- see this file's own header on why).
export interface WaitForMcpServersResult {
  ready: boolean;
  connected: string[];
  cached?: string[];
  failed: string[];
  stillPending: string[];
  needsAuth: string[];
  disabled: string[];
  unconfigured?: string[];
  replRouted?: boolean;
  unknown: string[];
}

export type WaitForMcpServersOutcome = { ok: true; result: WaitForMcpServersResult } | { ok: false; message: string };

export interface WaitForMcpServersDeps {
  stateSource?: McpServerStateSource;
  pendingWaitMs?: number;
}

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export async function executeWaitForMcpServers(input: unknown, deps: WaitForMcpServersDeps): Promise<WaitForMcpServersOutcome> {
  const rec = asRecord(input);
  if (rec.servers !== undefined && !isStringArray(rec.servers)) {
    return { ok: false, message: "WaitForMcpServers input.servers must be an array of strings when present" };
  }
  const requested = rec.servers as string[] | undefined;

  if (!deps.stateSource) {
    // No MCP servers/state tracked at all for this run -- vacuously ready, every bucket empty except
    // `unknown`, which reports back exactly the names nothing exists to resolve them against. Not an
    // error: WS-09 §8.4 does not special-case "zero servers configured," and CC's real behavior for a
    // serverless session is not this pin's to invent beyond the honest, vacuous case.
    return { ok: true, result: { ready: true, connected: [], failed: [], stillPending: [], needsAuth: [], disabled: [], unknown: requested ?? [] } };
  }

  const waitMs = deps.pendingWaitMs ?? DEFAULT_PENDING_WAIT_MS;
  const snapshot = await deps.stateSource.waitForPending(requested, waitMs);

  const known = new Set(snapshot.map((s) => s.name));
  const targets = requested ?? snapshot.map((s) => s.name);
  const unknown = targets.filter((n) => !known.has(n));

  const byState = (kind: McpServerStateKind): string[] => snapshot.filter((s) => targets.includes(s.name) && s.state === kind).map((s) => s.name);

  const connected = byState("connected");
  const cached = byState("cached");
  const stillPending = byState("pending");
  const needsAuth = byState("needsAuth");
  const disabled = byState("disabled");
  const unconfigured = byState("unconfigured");
  const failedEntries = snapshot.filter((s) => targets.includes(s.name) && s.state === "failed");
  const failed = failedEntries.map((s) => s.name);

  // Ready-calculation quirk (WS-09 §8.4, regression-pinned, "cloned deliberately"): false for a
  // NON-unconfigured failure, a still-pending server, needs-auth, or disabled; `cached` counts as
  // ready; `unconfigured` is reported in its own bucket but EXCLUDED from this computation entirely
  // (neither a term that helps nor one that hurts it) -- see wait-for-mcp-servers.test.ts's own
  // dedicated regression fixture, which is the whole point of this comment existing.
  const ready = failed.length === 0 && stillPending.length === 0 && needsAuth.length === 0 && disabled.length === 0 && unknown.length === 0;

  const result: WaitForMcpServersResult = {
    ready,
    connected,
    failed,
    stillPending,
    needsAuth,
    disabled,
    unknown,
    ...(cached.length > 0 ? { cached } : {}),
    ...(unconfigured.length > 0 ? { unconfigured } : {}),
    // `replRouted` (WS-09 §8.4: "REPL routing can expose connected tools inside REPL rather than as
    // top-level definitions") is deliberately NEVER set here -- `McpServerState` (mcp/state.ts, T2's
    // own seam) carries no such signal at all, so this executor has no honest value to report beyond
    // "unknown," which is indistinguishable from "just never set it." A real value requires whatever
    // Lane A/engine-level mechanism actually decides REPL routing to thread a new field through
    // McpServerState first -- flagged for T8 alongside this file's other unpinned-detail notes.
  };
  return { ok: true, result };
}

function notWiredResult(): ToolResultPayload {
  return {
    output:
      "Error: WaitForMcpServers has no session runtime registered for this session (WS-09 §8.4) -- engine.ts must call registerToolSearchSessionRuntime(sessionId, ...) once per run (toolsearch/search.ts); this is a host wiring gap, not a model input error.",
    isError: true,
  };
}

export const waitForMcpServersExecutor: ToolExecutor = {
  async execute(input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
    const runtime = getToolSearchSessionRuntime(ctx.sessionId);
    if (!runtime) return notWiredResult();

    const outcome = await executeWaitForMcpServers(input, {
      ...(runtime.stateSource !== undefined ? { stateSource: runtime.stateSource } : {}),
      ...(runtime.pendingWaitMs !== undefined ? { pendingWaitMs: runtime.pendingWaitMs } : {}),
    });
    if (!outcome.ok) return { output: `Error: ${outcome.message}`, isError: true };
    return { output: JSON.stringify(outcome.result) };
  },
};

replaceExecutor(WAIT_FOR_MCP_SERVERS_TOOL_NAME, waitForMcpServersExecutor);
