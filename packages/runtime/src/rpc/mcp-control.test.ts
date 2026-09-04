// Phase 4 Task 3 (MUST 4, WS-04 §3.1, WS-09 §2.1/§3): the host→runtime MCP control-request handlers,
// tested as pure functions against the fake state source / fake control seam -- no engine run needed.
import { describe, test, expect } from "bun:test";
import { handleMcpStatus, handleMcpReconnect, handleMcpToggle, handleMcpSetServers, toWireMcpStatus, mcpServerStatesToWire } from "./mcp-control.ts";
import { createFakeMcpServerStateSource } from "../mcp/state.ts";
import { createFakeMcpControlSeam } from "../mcp/control-seam.ts";

describe("toWireMcpStatus / mcpServerStatesToWire (T1's Open Question 5)", () => {
  test("needsAuth maps to the pinned hyphenated wire spelling 'needs-auth'", () => {
    expect(toWireMcpStatus("needsAuth")).toBe("needs-auth");
  });
  test("every other internal kind spells identically on the wire", () => {
    for (const kind of ["pending", "connected", "cached", "failed", "disabled", "unconfigured"] as const) {
      expect(toWireMcpStatus(kind)).toBe(kind);
    }
  });
  test("mcpServerStatesToWire maps name+status only, preserving order", () => {
    const states = [
      { name: "gh", state: "connected" as const, toolNames: ["list_issues"] },
      { name: "auth-needed", state: "needsAuth" as const, toolNames: [] },
    ];
    expect(mcpServerStatesToWire(states)).toEqual([
      { name: "gh", status: "connected" },
      { name: "auth-needed", status: "needs-auth" },
    ]);
  });
});

describe("handleMcpStatus", () => {
  test("no state source configured -- an empty server list, never an error", async () => {
    const result = await handleMcpStatus({});
    expect(result).toEqual({ ok: true, payload: { servers: [] } });
  });

  test("reflects the live state source's own snapshot, with the pinned wire spelling", async () => {
    const source = createFakeMcpServerStateSource([
      { name: "gh", state: "connected", toolNames: ["list_issues"] },
      { name: "priv", state: "needsAuth", toolNames: [] },
    ]);
    const result = await handleMcpStatus({ stateSource: source });
    expect(result).toEqual({
      ok: true,
      payload: {
        servers: [
          { name: "gh", status: "connected" },
          { name: "priv", status: "needs-auth" },
        ],
      },
    });
  });
});

describe("handleMcpReconnect", () => {
  test("no control seam configured -- a structured mcp_unavailable error, never a throw or a hang", async () => {
    const result = await handleMcpReconnect({}, { serverName: "gh" });
    expect(result).toEqual({ ok: false, error: { code: "mcp_unavailable", message: expect.any(String) } });
  });

  test("invalid payload (missing serverName) -- a structured invalid_payload error", async () => {
    const seam = createFakeMcpControlSeam();
    const result = await handleMcpReconnect({ controlSeam: seam }, {});
    expect(result.ok).toBe(false);
    expect((result as { error: { code: string } }).error.code).toBe("invalid_payload");
    expect(seam.calls.reconnect).toEqual([]); // never reached the seam at all
  });

  test("delegates to the seam and acks on success", async () => {
    const seam = createFakeMcpControlSeam();
    const result = await handleMcpReconnect({ controlSeam: seam }, { serverName: "gh" });
    expect(result).toEqual({ ok: true });
    expect(seam.calls.reconnect).toEqual(["gh"]);
  });

  test("a seam rejection (matches the pinned Query.reconnectMcpServer's own 'throws on failure') fails closed to a structured error, never a dropped request", async () => {
    const seam = createFakeMcpControlSeam();
    seam.failNextWith.reconnect = new Error("connection refused");
    const result = await handleMcpReconnect({ controlSeam: seam }, { serverName: "gh" });
    expect(result).toEqual({ ok: false, error: { code: "mcp_reconnect_failed", message: "connection refused" } });
  });
});

describe("handleMcpToggle", () => {
  test("no control seam configured -- mcp_unavailable", async () => {
    const result = await handleMcpToggle({}, { serverName: "gh", enabled: false });
    expect((result as { error: { code: string } }).error.code).toBe("mcp_unavailable");
  });

  test("invalid payload (non-boolean enabled) -- invalid_payload, never reaches the seam", async () => {
    const seam = createFakeMcpControlSeam();
    const result = await handleMcpToggle({ controlSeam: seam }, { serverName: "gh", enabled: "nope" });
    expect((result as { error: { code: string } }).error.code).toBe("invalid_payload");
    expect(seam.calls.toggle).toEqual([]);
  });

  test("delegates {serverName, enabled} to the seam and acks on success", async () => {
    const seam = createFakeMcpControlSeam();
    const result = await handleMcpToggle({ controlSeam: seam }, { serverName: "gh", enabled: true });
    expect(result).toEqual({ ok: true });
    expect(seam.calls.toggle).toEqual([{ serverName: "gh", enabled: true }]);
  });

  test("a seam rejection fails closed to a structured error", async () => {
    const seam = createFakeMcpControlSeam();
    seam.failNextWith.toggle = new Error("unknown server");
    const result = await handleMcpToggle({ controlSeam: seam }, { serverName: "ghost", enabled: false });
    expect(result).toEqual({ ok: false, error: { code: "mcp_toggle_failed", message: "unknown server" } });
  });
});

describe("handleMcpSetServers", () => {
  test("no control seam configured -- mcp_unavailable", async () => {
    const result = await handleMcpSetServers({}, { servers: {} });
    expect((result as { error: { code: string } }).error.code).toBe("mcp_unavailable");
  });

  test("invalid payload (missing servers object) -- invalid_payload", async () => {
    const seam = createFakeMcpControlSeam();
    const result = await handleMcpSetServers({ controlSeam: seam }, {});
    expect((result as { error: { code: string } }).error.code).toBe("invalid_payload");
    expect(seam.calls.setServers).toEqual([]);
  });

  test("delegates the servers record to the seam and returns its McpSetServersResult verbatim (the pinned {added,removed,errors} shape)", async () => {
    const seam = createFakeMcpControlSeam();
    seam.setServersResult = { added: ["gh"], removed: ["old"], errors: { flaky: "timed out" } };
    const servers = { gh: { command: "gh-mcp", args: [] } };
    const result = await handleMcpSetServers({ controlSeam: seam }, { servers });
    expect(result).toEqual({ ok: true, payload: { added: ["gh"], removed: ["old"], errors: { flaky: "timed out" } } });
    expect(seam.calls.setServers).toEqual([servers]);
  });

  test("a seam rejection fails closed to a structured error", async () => {
    const seam = createFakeMcpControlSeam();
    seam.failNextWith.setServers = new Error("malformed config");
    const result = await handleMcpSetServers({ controlSeam: seam }, { servers: {} });
    expect(result).toEqual({ ok: false, error: { code: "mcp_set_servers_failed", message: "malformed config" } });
  });
});
