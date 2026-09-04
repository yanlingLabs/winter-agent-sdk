// Phase 4 Task 3 (WS-04 §3.1, WS-09 §2.1/§3): the host→runtime MCP control-request handlers, as
// PURE functions (deps in, a structured result out) -- engine.ts's own pump (the control_request
// dispatcher) stays a thin per-subtype switch that calls one of these; the actual decision logic
// lives here, independently unit-testable without a whole engine run. Mirrors query.ts's own
// makeHookHandler/makePermissionHandler posture one layer over: every failure mode is a structured
// `{ok:false, error:{code,message}}`, never a thrown exception -- WS-04 §3.1's own "a structured
// error, never a dropped request."
import type { McpServerConfigForProcessTransport } from "@yanlinglabs/winter-agent-sdk";
import type { McpServerState, McpServerStateKind, McpServerStateSource } from "../mcp/state.ts";
import type { McpControlSeam } from "../mcp/control-seam.ts";

export type McpControlResult = { ok: true; payload?: unknown } | { ok: false; error: { code: string; message: string } };

// WS-09 §2.1's own internal->wire spelling map, per T1's Open Question 5: the pinned system/init
// `mcp_servers[].status` string is `'needs-auth'` (hyphenated) while the internal state kind is
// `needsAuth` (camelCase) -- this is the ONE mapping site both the `mcp_status` control-response
// below and engine.ts's own system/init emission (frames.ts's WireMcpServerStatus) call through, so
// the two wire surfaces can never independently drift on the spelling. Every other kind
// (pending/connected/cached/failed/disabled/unconfigured) already spells identically either way.
export function toWireMcpStatus(kind: McpServerStateKind): string {
  return kind === "needsAuth" ? "needs-auth" : kind;
}

export function mcpServerStatesToWire(states: readonly McpServerState[]): Array<{ name: string; status: string }> {
  return states.map((s) => ({ name: s.name, status: toWireMcpStatus(s.state) }));
}

export interface McpControlDeps {
  // Absent whenever no MCP state source is configured for this run (every session before Lane A's
  // own real transports exist, and every session with no MCP servers configured at all) -- `mcp_status`
  // then answers with an empty server list, never an error (there is genuinely nothing to report).
  stateSource?: McpServerStateSource;
  // Absent whenever no MCP control seam is configured -- reconnect/toggle/setServers then answer a
  // structured `mcp_unavailable` error rather than silently no-opping or falling to the pump's own
  // generic `unknown_subtype` (this subtype IS recognized; it just has nothing to dispatch to yet).
  controlSeam?: McpControlSeam;
}

export async function handleMcpStatus(deps: McpControlDeps): Promise<McpControlResult> {
  const states = deps.stateSource?.snapshot() ?? [];
  return { ok: true, payload: { servers: mcpServerStatesToWire(states) } };
}

function requireServerName(payload: unknown): { ok: true; serverName: string } | { ok: false; error: McpControlResult & { ok: false } } {
  const serverName = (payload as { serverName?: unknown } | null)?.serverName;
  if (typeof serverName !== "string" || serverName.length === 0) {
    return { ok: false, error: { ok: false, error: { code: "invalid_payload", message: "expected a non-empty 'serverName' string" } } };
  }
  return { ok: true, serverName };
}

export async function handleMcpReconnect(deps: McpControlDeps, payload: unknown): Promise<McpControlResult> {
  const parsed = requireServerName(payload);
  if (!parsed.ok) return parsed.error;
  if (!deps.controlSeam) {
    return { ok: false, error: { code: "mcp_unavailable", message: "no MCP control seam is configured for this session" } };
  }
  try {
    await deps.controlSeam.reconnect(parsed.serverName);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: { code: "mcp_reconnect_failed", message: err instanceof Error ? err.message : String(err) } };
  }
}

export async function handleMcpToggle(deps: McpControlDeps, payload: unknown): Promise<McpControlResult> {
  const parsed = requireServerName(payload);
  if (!parsed.ok) return parsed.error;
  const enabled = (payload as { enabled?: unknown }).enabled;
  if (typeof enabled !== "boolean") {
    return { ok: false, error: { code: "invalid_payload", message: "expected a boolean 'enabled' field" } };
  }
  if (!deps.controlSeam) {
    return { ok: false, error: { code: "mcp_unavailable", message: "no MCP control seam is configured for this session" } };
  }
  try {
    await deps.controlSeam.toggle(parsed.serverName, enabled);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: { code: "mcp_toggle_failed", message: err instanceof Error ? err.message : String(err) } };
  }
}

export async function handleMcpSetServers(deps: McpControlDeps, payload: unknown): Promise<McpControlResult> {
  const servers = (payload as { servers?: unknown } | null)?.servers;
  if (typeof servers !== "object" || servers === null) {
    return { ok: false, error: { code: "invalid_payload", message: "expected a 'servers' object (Record<string, McpServerConfigForProcessTransport>)" } };
  }
  if (!deps.controlSeam) {
    return { ok: false, error: { code: "mcp_unavailable", message: "no MCP control seam is configured for this session" } };
  }
  try {
    const result = await deps.controlSeam.setServers(servers as Record<string, McpServerConfigForProcessTransport>);
    return { ok: true, payload: result };
  } catch (err) {
    return { ok: false, error: { code: "mcp_set_servers_failed", message: err instanceof Error ? err.message : String(err) } };
  }
}
