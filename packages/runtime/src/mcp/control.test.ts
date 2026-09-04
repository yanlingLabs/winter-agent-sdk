import { describe, test, expect } from "bun:test";
import { getRegisteredTool } from "../tools/registry.ts";
import { handleMcpReconnect, handleMcpToggle, handleMcpSetServers, handleMcpStatus } from "../rpc/mcp-control.ts";
import { createElicitationAsker } from "./elicitation.ts";
import { createMcpLifecycle, type ResolvedMcpServerEntry } from "./lifecycle.ts";
import type { McpEnvConfig } from "./env.ts";
import type { InProcessMcpServer } from "./transports/sdk.ts";
import { createFixtureMcpServer, defaultFixtureSpec, stdioFixtureCommand } from "./test-fixtures.ts";

const NO_ELICIT = createElicitationAsker(undefined);

function fastEnv(overrides: Partial<McpEnvConfig> = {}): McpEnvConfig {
  return {
    enableToolSearch: "unset",
    connectionNonblocking: true,
    connectTimeoutMs: 500,
    timeoutMs: 500,
    discoveryCache: false,
    maxOutputTokens: 25000,
    ...overrides,
  };
}

// Wraps an in-process server so this file can prove "toggling off then on again never re-dials the
// connection" by COUNTING real `connect()` calls -- a reconnect (or the never-connected-yet edge
// case) is the only thing that increments it; an instant toggle-on restore never should.
function countingInProcessServer(inner: InProcessMcpServer): { server: InProcessMcpServer; connectCount(): number } {
  let count = 0;
  return {
    server: {
      async connect(transport) {
        count++;
        await inner.connect(transport);
      },
    },
    connectCount: () => count,
  };
}

describe("createMcpControlSeam via the REAL rpc/mcp-control.ts handlers (this lane's own real seam, not the fake)", () => {
  test("mcp_status reads McpServerStateSource.snapshot() directly, wire-mapping needsAuth -> 'needs-auth'", async () => {
    const server = createFixtureMcpServer(defaultFixtureSpec());
    const resolved: ResolvedMcpServerEntry[] = [{ name: "gh", origin: "explicit", config: { type: "sdk", name: "gh" } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv(), elicitationAsk: NO_ELICIT, inProcessServers: { gh: server } });
    try {
      await lifecycle.start();
      const result = await handleMcpStatus({ stateSource: lifecycle.stateSource });
      expect(result).toEqual({ ok: true, payload: { servers: [{ name: "gh", status: "connected" }] } });
    } finally {
      await lifecycle.dispose();
      await server.close();
    }
  });

  test("mcp_reconnect: unknown server name fails closed with a structured error, never a throw across the RPC boundary", async () => {
    const lifecycle = createMcpLifecycle({ servers: [], envConfig: fastEnv(), elicitationAsk: NO_ELICIT });
    try {
      const result = await handleMcpReconnect({ controlSeam: lifecycle.controlSeam }, { serverName: "nope" });
      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: { code: string } }).error.code).toBe("mcp_reconnect_failed");
    } finally {
      await lifecycle.dispose();
    }
  });

  test("mcp_reconnect: a real, previously-connected server reconnects successfully (a fresh connect, not the toggle-restore path)", async () => {
    const inner = createFixtureMcpServer(defaultFixtureSpec());
    const { server, connectCount } = countingInProcessServer(inner);
    const resolved: ResolvedMcpServerEntry[] = [{ name: "gh", origin: "explicit", config: { type: "sdk", name: "gh" } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv(), elicitationAsk: NO_ELICIT, inProcessServers: { gh: server } });
    try {
      await lifecycle.start();
      expect(connectCount()).toBe(1);
      const result = await handleMcpReconnect({ controlSeam: lifecycle.controlSeam }, { serverName: "gh" });
      expect(result).toEqual({ ok: true });
      expect(connectCount()).toBe(2); // a REAL reconnect -- a genuinely new connect() call
      expect(lifecycle.stateSource.snapshot()).toEqual([{ name: "gh", state: "connected", toolNames: expect.arrayContaining(["echo", "boom"]) as unknown as string[] }]);
    } finally {
      await lifecycle.dispose();
      await inner.close();
    }
  });

  test("mcp_reconnect: a failing reconnect surfaces a structured mcp_reconnect_failed error (the seam's reconnect() throws, matching the pinned contract)", async () => {
    const resolved: ResolvedMcpServerEntry[] = [{ name: "broken", origin: "explicit", config: { command: "/no/such/binary-control-test" } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv(), elicitationAsk: NO_ELICIT });
    try {
      await lifecycle.start();
      await lifecycle.stateSource.waitForPending(undefined, 500);
      const result = await handleMcpReconnect({ controlSeam: lifecycle.controlSeam }, { serverName: "broken" });
      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: { code: string; message: string } }).error.code).toBe("mcp_reconnect_failed");
    } finally {
      await lifecycle.dispose();
    }
  });

  test("mcp_toggle off then on: tools disappear then reappear, the underlying connection is NEVER re-dialed (WS-09 §2.1 'connected<->disabled', direct, no pending)", async () => {
    const inner = createFixtureMcpServer(defaultFixtureSpec());
    const { server, connectCount } = countingInProcessServer(inner);
    const resolved: ResolvedMcpServerEntry[] = [{ name: "gh", origin: "explicit", config: { type: "sdk", name: "gh" } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv(), elicitationAsk: NO_ELICIT, inProcessServers: { gh: server } });
    try {
      await lifecycle.start();
      expect(connectCount()).toBe(1);

      const off = await handleMcpToggle({ controlSeam: lifecycle.controlSeam }, { serverName: "gh", enabled: false });
      expect(off).toEqual({ ok: true });
      expect(lifecycle.stateSource.snapshot()).toEqual([{ name: "gh", state: "disabled", toolNames: expect.arrayContaining(["echo", "boom"]) as unknown as string[] }]);
      expect(getRegisteredTool("mcp__gh__echo")).toBeUndefined();

      const on = await handleMcpToggle({ controlSeam: lifecycle.controlSeam }, { serverName: "gh", enabled: true });
      expect(on).toEqual({ ok: true });
      expect(lifecycle.stateSource.snapshot()).toEqual([{ name: "gh", state: "connected", toolNames: expect.arrayContaining(["echo", "boom"]) as unknown as string[] }]);
      expect(getRegisteredTool("mcp__gh__echo")).toBeDefined();
      expect(connectCount()).toBe(1); // still 1 -- toggling never re-dialed the connection

      const result = await getRegisteredTool("mcp__gh__echo")!.executor!.execute({ text: "hi" }, {} as never);
      expect(result).toEqual({ output: "echo:hi" });
    } finally {
      await lifecycle.dispose();
      await inner.close();
    }
  });

  test("mcp_toggle on a never-connected server: treated as an ordinary reconnect rather than a hard error (disclosed edge case)", async () => {
    const resolved: ResolvedMcpServerEntry[] = [{ name: "brand-new", origin: "explicit", config: { type: "sdk", name: "brand-new" } }];
    const server = createFixtureMcpServer(defaultFixtureSpec());
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv(), elicitationAsk: NO_ELICIT, inProcessServers: { "brand-new": server } });
    try {
      // Toggle off BEFORE start() ever connects it -- disableSlot works on a "pending" slot too
      // (it never asserted a precondition on the current state).
      const off = await handleMcpToggle({ controlSeam: lifecycle.controlSeam }, { serverName: "brand-new", enabled: false });
      expect(off).toEqual({ ok: true });
      const on = await handleMcpToggle({ controlSeam: lifecycle.controlSeam }, { serverName: "brand-new", enabled: true });
      expect(on).toEqual({ ok: true });
      expect(lifecycle.stateSource.snapshot()[0]!.state).toBe("connected");
    } finally {
      await lifecycle.dispose();
      await server.close();
    }
  });

  test("mcp_set_servers: adds a brand-new dynamic server and reports it in 'added'", async () => {
    const lifecycle = createMcpLifecycle({ servers: [], envConfig: fastEnv({ connectTimeoutMs: 2000, timeoutMs: 2000 }), elicitationAsk: NO_ELICIT });
    try {
      const { command, args } = stdioFixtureCommand();
      const result = await handleMcpSetServers({ controlSeam: lifecycle.controlSeam }, { servers: { newone: { command, args, env: {} } } });
      expect(result).toEqual({ ok: true, payload: { added: ["newone"], removed: [], errors: {} } });
      await lifecycle.stateSource.waitForPending(undefined, 2000);
      expect(lifecycle.stateSource.snapshot()[0]!.state).toBe("connected");
    } finally {
      await lifecycle.dispose();
    }
  });

  test("mcp_set_servers: an invalid entry (claudeai-proxy) is reported per-name in errors, without blocking other valid entries in the same call", async () => {
    const lifecycle = createMcpLifecycle({ servers: [], envConfig: fastEnv(), elicitationAsk: NO_ELICIT });
    try {
      const server = createFixtureMcpServer(defaultFixtureSpec());
      const result = (await handleMcpSetServers(
        { controlSeam: lifecycle.controlSeam },
        // Note: only wire-shaped (non-live-instance) configs cross this RPC boundary in real use;
        // the sdk-with-instance path is exercised separately via createMcpControlSeam's own
        // setServers below, which THIS lane's real McpControlSeam also supports for its own fixtures.
        { servers: { proxy: { type: "claudeai-proxy", url: "https://x", id: "1" }, good: { type: "sdk", name: "good" } } },
      )) as { ok: true; payload: { added: string[]; removed: string[]; errors: Record<string, string> } };
      expect(result.ok).toBe(true);
      expect(result.payload.errors.proxy).toContain("claudeai-proxy");
      expect(result.payload.added).toEqual(["good"]);
      await server.close();
    } finally {
      await lifecycle.dispose();
    }
  });

  test("mcp_set_servers: removes a dynamic server omitted from the new payload", async () => {
    const server = createFixtureMcpServer(defaultFixtureSpec());
    const resolved: ResolvedMcpServerEntry[] = [{ name: "gh", origin: "explicit", config: { type: "sdk", name: "gh" } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv(), elicitationAsk: NO_ELICIT, inProcessServers: { gh: server } });
    try {
      await lifecycle.start();
      expect(getRegisteredTool("mcp__gh__echo")).toBeDefined();
      const result = await handleMcpSetServers({ controlSeam: lifecycle.controlSeam }, { servers: {} });
      expect(result).toEqual({ ok: true, payload: { added: [], removed: ["gh"], errors: {} } });
      expect(getRegisteredTool("mcp__gh__echo")).toBeUndefined();
      expect(lifecycle.stateSource.snapshot()).toEqual([]);
    } finally {
      await lifecycle.dispose();
      await server.close();
    }
  });

  test("mcp_set_servers: a settings/project/plugin-origin server survives an omission untouched (derived-shapes-p4.md item (b))", async () => {
    const server = createFixtureMcpServer(defaultFixtureSpec());
    const resolved: ResolvedMcpServerEntry[] = [{ name: "from-settings", origin: "settings", config: { type: "sdk", name: "from-settings" } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv(), elicitationAsk: NO_ELICIT, inProcessServers: { "from-settings": server } });
    try {
      await lifecycle.start();
      const result = await handleMcpSetServers({ controlSeam: lifecycle.controlSeam }, { servers: {} }); // an empty payload
      expect(result).toEqual({ ok: true, payload: { added: [], removed: [], errors: {} } }); // NOT removed
      expect(getRegisteredTool("mcp__from-settings__echo")).toBeDefined(); // still there
      expect(lifecycle.stateSource.snapshot()[0]!.state).toBe("connected");
    } finally {
      await lifecycle.dispose();
      await server.close();
    }
  });

  test("mcp_set_servers: explicitly naming a settings-origin server in the payload DOES override it (the one documented way to displace one)", async () => {
    const inner = createFixtureMcpServer(defaultFixtureSpec());
    const lifecycle = createMcpLifecycle({
      servers: [{ name: "from-settings", origin: "settings", config: { type: "sdk", name: "from-settings" } }],
      envConfig: fastEnv({ connectTimeoutMs: 2000, timeoutMs: 2000 }),
      elicitationAsk: NO_ELICIT,
      inProcessServers: { "from-settings": inner },
    });
    try {
      await lifecycle.start();
      const { command, args } = stdioFixtureCommand();
      const result = await handleMcpSetServers({ controlSeam: lifecycle.controlSeam }, { servers: { "from-settings": { command, args, env: {} } } });
      expect(result).toEqual({ ok: true, payload: { added: ["from-settings"], removed: [], errors: {} } });
      await lifecycle.stateSource.waitForPending(undefined, 2000);
      // Now backed by the real stdio fixture's own tools, not the in-process one -- proves the
      // override actually took effect, not merely that the call didn't error.
      expect(lifecycle.stateSource.snapshot()[0]!.toolNames.sort()).toEqual(["boom", "echo"]);
    } finally {
      await lifecycle.dispose();
      await inner.close();
    }
  });
});
