// Phase 4 Task 3 (WS-04 §3.1, WS-09 §3): the seam Lane A (Task 4) implements for the four
// host→runtime MCP control subtypes' MUTATING half (mcp_reconnect/mcp_toggle/mcp_set_servers).
// `mcp_status` is deliberately NOT a method here -- it is a pure read of the ALREADY-produced
// McpServerStateSource (mcp/state.ts), so routing it through this seam too would just be a second,
// redundant way to ask the identical question (see rpc/mcp-control.ts's own handleMcpStatus, which
// reads `McpServerStateSource.snapshot()` directly). This file owns only the seam TYPE + a fake for
// tests; the REAL implementation (driving `reconnect`/`toggle`/`setServers` against actual MCP
// transport connections) is Lane A's own job — nothing here should be mistaken for that, mirroring
// mcp/state.ts's own "this file owns the shape + a FAKE... the REAL implementation is Lane A's own
// job" precedent exactly.
import type { McpServerConfigForProcessTransport } from "@yanlinglabs/winter-agent-sdk";

// Mirrors the pinned official `McpSetServersResult` shape (derived-shapes-p4.md item (b):
// `{ added: string[]; removed: string[]; errors: Record<string,string> }`) -- WS-09 §3's own
// `setMcpServers` family names this exact return shape, so Winter's own control-response payload
// for `mcp_set_servers` mirrors it rather than inventing a different one.
export interface McpSetServersResult {
  added: string[];
  removed: string[];
  errors: Record<string, string>;
}

export interface McpControlSeam {
  // Matches the pinned `Query.reconnectMcpServer(serverName): Promise<void>` -- "throws on failure"
  // (derived-shapes-p4.md item (b)); rpc/mcp-control.ts's own handler is what turns a throw into a
  // structured `{ok:false, error}` control_response.
  reconnect(serverName: string): Promise<void>;
  toggle(serverName: string, enabled: boolean): Promise<void>;
  setServers(servers: Record<string, McpServerConfigForProcessTransport>): Promise<McpSetServersResult>;
}

export interface FakeMcpControlSeamCall {
  reconnect: string[];
  toggle: Array<{ serverName: string; enabled: boolean }>;
  setServers: Array<Record<string, McpServerConfigForProcessTransport>>;
}

// Test-only double (mirrors createFakeMcpServerStateSource's own precedent): records every call for
// assertion, and lets a test script either a canned setServers() result or a rejection for any of
// the three methods by name -- exactly the two things a contract test over rpc/mcp-control.ts's own
// handlers needs to prove both the success and the structured-error paths.
export interface FakeMcpControlSeam extends McpControlSeam {
  readonly calls: FakeMcpControlSeamCall;
  setServersResult: McpSetServersResult;
  failNextWith: Partial<Record<keyof McpControlSeam, Error>>;
}

export function createFakeMcpControlSeam(): FakeMcpControlSeam {
  const calls: FakeMcpControlSeamCall = { reconnect: [], toggle: [], setServers: [] };
  const failNextWith: Partial<Record<keyof McpControlSeam, Error>> = {};
  let setServersResult: McpSetServersResult = { added: [], removed: [], errors: {} };

  function maybeThrow(method: keyof McpControlSeam): void {
    const err = failNextWith[method];
    if (err !== undefined) {
      delete failNextWith[method];
      throw err;
    }
  }

  return {
    calls,
    get setServersResult() {
      return setServersResult;
    },
    set setServersResult(value: McpSetServersResult) {
      setServersResult = value;
    },
    failNextWith,
    async reconnect(serverName: string): Promise<void> {
      calls.reconnect.push(serverName);
      maybeThrow("reconnect");
    },
    async toggle(serverName: string, enabled: boolean): Promise<void> {
      calls.toggle.push({ serverName, enabled });
      maybeThrow("toggle");
    },
    async setServers(servers: Record<string, McpServerConfigForProcessTransport>): Promise<McpSetServersResult> {
      calls.setServers.push(servers);
      maybeThrow("setServers");
      return setServersResult;
    },
  };
}
