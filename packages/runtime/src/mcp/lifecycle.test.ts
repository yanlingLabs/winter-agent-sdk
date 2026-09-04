import { describe, test, expect } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getRegisteredTool } from "../tools/registry.ts";
import { createElicitationAsker } from "./elicitation.ts";
import { createInMemoryDiscoveryCache, createMcpLifecycle, resolveMcpServerSources, type McpServerSource, type ResolvedMcpServerEntry } from "./lifecycle.ts";
import type { McpEnvConfig } from "./env.ts";
import { createFixtureMcpServer, defaultFixtureSpec, stdioFixtureCommand, type FixtureServerSpec } from "./test-fixtures.ts";

const NO_ELICIT = createElicitationAsker(undefined);

// Fast defaults for every lifecycle test in this file -- never the real 5000/30000/120000ms
// production defaults, so this whole suite runs in milliseconds, not minutes.
function fastEnv(overrides: Partial<McpEnvConfig> = {}): McpEnvConfig {
  return {
    enableToolSearch: "unset",
    connectionNonblocking: true,
    connectTimeoutMs: 200,
    timeoutMs: 500,
    discoveryCache: false,
    maxOutputTokens: 25000,
    ...overrides,
  };
}

describe("resolveMcpServerSources: precedence, strictMcpConfig, trust gating, validation", () => {
  test("explicit beats settings beats project beats plugin for the same name; losers reported as shadowed, never merged", () => {
    const sources: McpServerSource[] = [
      { origin: "plugin", servers: { gh: { command: "plugin-cmd" } } },
      { origin: "project", servers: { gh: { command: "project-cmd" } } },
      { origin: "settings", servers: { gh: { command: "settings-cmd" } } },
      { origin: "explicit", servers: { gh: { command: "explicit-cmd" } } },
    ];
    const result = resolveMcpServerSources(sources, { trustedWorkspace: true });
    expect(result.resolved).toEqual([{ name: "gh", origin: "explicit", config: { command: "explicit-cmd" } }]);
    expect(result.shadowed).toEqual([
      { name: "gh", origin: "settings", shadowedBy: "explicit" },
      { name: "gh", origin: "project", shadowedBy: "explicit" },
      { name: "gh", origin: "plugin", shadowedBy: "explicit" },
    ]);
    expect(result.rejected).toEqual([]);
  });

  test("distinct names across sources all resolve independently", () => {
    const sources: McpServerSource[] = [
      { origin: "explicit", servers: { a: { command: "a" } } },
      { origin: "settings", servers: { b: { command: "b" } } },
      { origin: "project", servers: { c: { command: "c" } } },
      { origin: "plugin", servers: { d: { command: "d" } } },
    ];
    const result = resolveMcpServerSources(sources, { trustedWorkspace: true });
    expect(result.resolved.map((r) => r.name).sort()).toEqual(["a", "b", "c", "d"]);
    expect(result.shadowed).toEqual([]);
  });

  test("strictMcpConfig: only 'explicit' sources are even considered -- settings/project/plugin are skipped entirely, not merely deprioritized", () => {
    const sources: McpServerSource[] = [
      { origin: "explicit", servers: { a: { command: "a" } } },
      { origin: "settings", servers: { b: { command: "b" } } },
      { origin: "project", servers: { c: { command: "c" } } },
      { origin: "plugin", servers: { d: { command: "d" } } },
    ];
    const result = resolveMcpServerSources(sources, { strictMcpConfig: true, trustedWorkspace: true });
    expect(result.resolved.map((r) => r.name)).toEqual(["a"]);
    expect(result.shadowed).toEqual([]); // never even reached the shadow check -- filtered out before precedence processing
    expect(result.rejected).toEqual([]);
  });

  test("claudeai-proxy is rejected at runtime with a typed error, from any source", () => {
    const sources: McpServerSource[] = [{ origin: "explicit", servers: { proxy: { type: "claudeai-proxy", url: "https://x", id: "1" } } }];
    const result = resolveMcpServerSources(sources, { trustedWorkspace: true });
    expect(result.resolved).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.name).toBe("proxy");
    expect(result.rejected[0]!.reason).toContain("claudeai-proxy");
  });

  test("an unrecognized 'type' is rejected with a typed error", () => {
    const result = resolveMcpServerSources([{ origin: "explicit", servers: { weird: { type: "carrier-pigeon" } } }], { trustedWorkspace: true });
    expect(result.rejected[0]!.reason).toContain("carrier-pigeon");
  });

  test("a malformed config (missing the required field for its own type) is rejected", () => {
    const result = resolveMcpServerSources(
      [{ origin: "explicit", servers: { bad1: { command: 42 }, bad2: { type: "http" }, bad3: { type: "sdk" } } }],
      { trustedWorkspace: true },
    );
    expect(result.resolved).toEqual([]);
    expect(result.rejected.map((r) => r.name).sort()).toEqual(["bad1", "bad2", "bad3"]);
  });

  test('the literal name "winter" is refused from every source (RULING P4-B) -- registry-reserved, never a live-connectable identity', () => {
    const result = resolveMcpServerSources([{ origin: "explicit", servers: { winter: { command: "x" } } }], { trustedWorkspace: true });
    expect(result.resolved).toEqual([]);
    expect(result.rejected[0]!.reason).toContain("reserved");
  });

  test("project-sourced stdio config is rejected in an untrusted workspace (WS-09 §1.2 trust gate)", () => {
    const result = resolveMcpServerSources([{ origin: "project", servers: { local: { command: "x" } } }], { trustedWorkspace: false });
    expect(result.resolved).toEqual([]);
    expect(result.rejected[0]!.reason).toContain("trusted workspace");
  });

  test("project-sourced stdio config is ACCEPTED in a trusted workspace", () => {
    const result = resolveMcpServerSources([{ origin: "project", servers: { local: { command: "x" } } }], { trustedWorkspace: true });
    expect(result.resolved).toEqual([{ name: "local", origin: "project", config: { command: "x" } }]);
  });

  test("project-sourced http/sse configs are NOT trust-gated (disclosed scope: WS-09 §1.2 names stdio specifically)", () => {
    const result = resolveMcpServerSources([{ origin: "project", servers: { remote: { type: "http", url: "https://example.com/mcp" } } }], { trustedWorkspace: false });
    expect(result.resolved).toEqual([{ name: "remote", origin: "project", config: { type: "http", url: "https://example.com/mcp" } }]);
  });

  test("a rejected higher-precedence declaration still claims the name -- a lower-precedence source never silently backfills it", () => {
    const sources: McpServerSource[] = [
      { origin: "project", servers: { gh: { command: "project-cmd" } } }, // untrusted -> rejected
      { origin: "plugin", servers: { gh: { command: "plugin-cmd" } } }, // valid, but lower precedence than project
    ];
    const result = resolveMcpServerSources(sources, { trustedWorkspace: false });
    expect(result.resolved).toEqual([]); // NOT plugin's config -- project already claimed "gh"
    expect(result.rejected).toHaveLength(1);
    expect(result.shadowed).toEqual([{ name: "gh", origin: "plugin", shadowedBy: "project" }]);
  });

  test("an absent 'type' is treated as stdio for validation purposes", () => {
    const result = resolveMcpServerSources([{ origin: "explicit", servers: { s: { command: "x", args: ["--flag"] } } }], { trustedWorkspace: true });
    expect(result.resolved).toEqual([{ name: "s", origin: "explicit", config: { command: "x", args: ["--flag"] } }]);
  });
});

describe("createMcpLifecycle: the seven-state model driven by real connections", () => {
  test("a successfully connected server: registry gains its tools, state is 'connected', tool call round-trips and is output-capped", async () => {
    const server = createFixtureMcpServer(defaultFixtureSpec());
    const resolved: ResolvedMcpServerEntry[] = [{ name: "fix", origin: "explicit", config: { type: "sdk", name: "fix" } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv(), elicitationAsk: NO_ELICIT, inProcessServers: { fix: server } });
    try {
      await lifecycle.start();
      const snap = lifecycle.stateSource.snapshot();
      expect(snap).toEqual([{ name: "fix", state: "connected", toolNames: expect.arrayContaining(["echo", "boom"]) as unknown as string[] }]);

      const registered = getRegisteredTool("mcp__fix__echo");
      expect(registered).toBeDefined();
      const result = await registered!.executor!.execute({ text: "hi" }, {} as never);
      expect(result).toEqual({ output: "echo:hi" });
    } finally {
      await lifecycle.dispose();
      await server.close();
    }
  });

  test("output cap: a tool result exceeding MAX_MCP_OUTPUT_TOKENS is truncated with an explicit marker", async () => {
    const bigText = "x".repeat(10_000);
    const server = createFixtureMcpServer({
      tools: [{ name: "big", inputSchema: { type: "object", properties: {} }, handler: () => ({ content: [{ type: "text", text: bigText }] }) }],
    });
    const resolved: ResolvedMcpServerEntry[] = [{ name: "fix", origin: "explicit", config: { type: "sdk", name: "fix" } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv({ maxOutputTokens: 10 }), elicitationAsk: NO_ELICIT, inProcessServers: { fix: server } });
    try {
      await lifecycle.start();
      const result = await getRegisteredTool("mcp__fix__big")!.executor!.execute({}, {} as never);
      expect(result.output.length).toBeLessThan(bigText.length);
      expect(result.output).toContain("truncated at 10 tokens");
    } finally {
      await lifecycle.dispose();
      await server.close();
    }
  });

  test("an isError tool result flows through as ToolResultPayload.isError", async () => {
    const server = createFixtureMcpServer(defaultFixtureSpec());
    const resolved: ResolvedMcpServerEntry[] = [{ name: "fix", origin: "explicit", config: { type: "sdk", name: "fix" } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv(), elicitationAsk: NO_ELICIT, inProcessServers: { fix: server } });
    try {
      await lifecycle.start();
      const result = await getRegisteredTool("mcp__fix__boom")!.executor!.execute({}, {} as never);
      expect(result).toEqual({ output: "boom", isError: true });
    } finally {
      await lifecycle.dispose();
      await server.close();
    }
  });

  test("a failed connection (nonexistent stdio command): state is 'failed' with an errorCode, no tools registered", async () => {
    const resolved: ResolvedMcpServerEntry[] = [{ name: "broken", origin: "explicit", config: { command: "/no/such/binary-lifecycle-test" } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv(), elicitationAsk: NO_ELICIT });
    try {
      await lifecycle.start();
      await lifecycle.stateSource.waitForPending(undefined, 500);
      const snap = lifecycle.stateSource.snapshot();
      expect(snap).toEqual([{ name: "broken", state: "failed", toolNames: [], errorCode: "spawn_failed", error: expect.any(String) as unknown as string }]);
      expect(getRegisteredTool("mcp__broken__anything")).toBeUndefined();
    } finally {
      await lifecycle.dispose();
    }
  });

  test("an sdk-with-instance connection is always awaited by start(), regardless of alwaysLoad (which does not exist on McpSdkServerConfig at all)", async () => {
    const server = createFixtureMcpServer(defaultFixtureSpec());
    const resolved: ResolvedMcpServerEntry[] = [{ name: "eager", origin: "explicit", config: { type: "sdk", name: "eager" } }];
    // WS-09 §2: "an in-process SDK server has no external process/network connection to await" --
    // this file's own start() treats a real inProcessServer connection as always-awaited (see this
    // file's own comment at that call site), never left racing the caller in the background the way
    // a real stdio/http/sse connection legitimately can be. The NEXT test proves the actual
    // alwaysLoad WAIT mechanism using a real (non-sdk) transport, where the flag genuinely exists.
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv(), elicitationAsk: NO_ELICIT, inProcessServers: { eager: server } });
    try {
      const started = Date.now();
      await lifecycle.start();
      expect(Date.now() - started).toBeLessThan(200);
      expect(lifecycle.stateSource.snapshot()[0]!.state).toBe("connected");
    } finally {
      await lifecycle.dispose();
      await server.close();
    }
  });

  test("alwaysLoad on a REAL (stdio) transport: start() actually waits for it to finish connecting", async () => {
    const { command, args } = stdioFixtureCommand();
    const resolved: ResolvedMcpServerEntry[] = [{ name: "stdio-eager", origin: "explicit", config: { command, args, env: {}, alwaysLoad: true } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv({ connectTimeoutMs: 3000, timeoutMs: 3000 }), elicitationAsk: NO_ELICIT });
    try {
      await lifecycle.start();
      // start() resolved -- by alwaysLoad's own contract, the server must already be connected, not
      // merely pending.
      expect(lifecycle.stateSource.snapshot()[0]!.state).toBe("connected");
      expect(getRegisteredTool("mcp__stdio-eager__echo")).toBeDefined();
    } finally {
      await lifecycle.dispose();
    }
  });

  test("without alwaysLoad, start() returns immediately (nonblocking default) even though the server is still pending", async () => {
    const { command, args } = stdioFixtureCommand();
    const resolved: ResolvedMcpServerEntry[] = [{ name: "lazy", origin: "explicit", config: { command, args, env: {} } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv({ connectTimeoutMs: 3000, timeoutMs: 3000 }), elicitationAsk: NO_ELICIT });
    try {
      const started = Date.now();
      await lifecycle.start();
      expect(Date.now() - started).toBeLessThan(200); // did not wait for the real connection
      // ...but the connection completes shortly after, in the background.
      await lifecycle.stateSource.waitForPending(undefined, 3000);
      expect(lifecycle.stateSource.snapshot()[0]!.state).toBe("connected");
    } finally {
      await lifecycle.dispose();
    }
  });

  test("MCP_CONNECTION_NONBLOCKING=0 (connectionNonblocking: false): start() waits for the WHOLE batch, bounded by connectTimeoutMs", async () => {
    const { command, args } = stdioFixtureCommand();
    const resolved: ResolvedMcpServerEntry[] = [{ name: "batched", origin: "explicit", config: { command, args, env: {} } }];
    const lifecycle = createMcpLifecycle({
      servers: resolved,
      envConfig: fastEnv({ connectionNonblocking: false, connectTimeoutMs: 3000, timeoutMs: 3000 }),
      elicitationAsk: NO_ELICIT,
    });
    try {
      await lifecycle.start();
      expect(lifecycle.stateSource.snapshot()[0]!.state).toBe("connected"); // start() itself already waited
    } finally {
      await lifecycle.dispose();
    }
  });

  test("RULING P4-C: an 'sdk'-typed config.mcpServers entry is fed as 'connected' immediately, using its wire-provided tool list -- never registered/executed by this file", async () => {
    const resolved: ResolvedMcpServerEntry[] = [
      { name: "hostsdk", origin: "explicit", config: { type: "sdk", name: "hostsdk", tools: [{ name: "hosted_tool", inputSchema: {} }] } },
    ];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv(), elicitationAsk: NO_ELICIT }); // no inProcessServers entry at all
    try {
      await lifecycle.start();
      expect(lifecycle.stateSource.snapshot()).toEqual([{ name: "hostsdk", state: "connected", toolNames: ["hosted_tool"] }]);
      // Never registered into the tool registry by THIS file -- that is T3's own engine.ts wiring
      // from the identical wire-provided `tools[]` field, a completely separate code path.
      expect(getRegisteredTool("mcp__hostsdk__hosted_tool")).toBeUndefined();
    } finally {
      await lifecycle.dispose();
    }
  });

  test("discovery cache: a cache hit serves 'cached' state + tools without connecting; the live connection is deferred to the first tool call", async () => {
    const cache = createInMemoryDiscoveryCache();
    cache.set("cached-srv", [{ name: "cachedTool", inputSchema: { type: "object", properties: {} } }]);
    const resolved: ResolvedMcpServerEntry[] = [{ name: "cached-srv", origin: "explicit", config: { type: "http", url: "http://127.0.0.1:1/never-actually-dialed" } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv({ discoveryCache: true }), elicitationAsk: NO_ELICIT, discoveryCache: cache });
    try {
      const started = Date.now();
      await lifecycle.start();
      expect(Date.now() - started).toBeLessThan(100); // never dialed the (bogus) URL at all
      expect(lifecycle.stateSource.snapshot()).toEqual([{ name: "cached-srv", state: "cached", toolNames: ["cachedTool"] }]);
      expect(getRegisteredTool("mcp__cached-srv__cachedTool")).toBeDefined();
    } finally {
      await lifecycle.dispose();
    }
  });

  test("discovery cache: never served for a stdio server, even when discoveryCache=1 and a cache entry exists under that name", async () => {
    const cache = createInMemoryDiscoveryCache();
    cache.set("stdio-not-cached", [{ name: "shouldNeverAppear", inputSchema: {} }]);
    const { command, args } = stdioFixtureCommand();
    const resolved: ResolvedMcpServerEntry[] = [{ name: "stdio-not-cached", origin: "explicit", config: { command, args, env: {} } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv({ discoveryCache: true, connectTimeoutMs: 3000, timeoutMs: 3000 }), elicitationAsk: NO_ELICIT, discoveryCache: cache });
    try {
      await lifecycle.start();
      await lifecycle.stateSource.waitForPending(undefined, 3000);
      const snap = lifecycle.stateSource.snapshot()[0]!;
      expect(snap.state).toBe("connected"); // a REAL connection, never "cached"
      expect(snap.toolNames.sort()).toEqual(["boom", "echo"]);
    } finally {
      await lifecycle.dispose();
    }
  });

  test("a cached server's first live call failing re-classifies to failed and withdraws its tools (WS-09 §2.1)", async () => {
    const cache = createInMemoryDiscoveryCache();
    cache.set("cached-fail", [{ name: "willFail", inputSchema: { type: "object", properties: {} } }]);
    // Points at a real, closed loopback port -- the deferred live connect (triggered by the first
    // tool call below) will genuinely fail.
    const resolved: ResolvedMcpServerEntry[] = [{ name: "cached-fail", origin: "explicit", config: { type: "http", url: "http://127.0.0.1:1/closed" } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv({ discoveryCache: true, timeoutMs: 300 }), elicitationAsk: NO_ELICIT, discoveryCache: cache });
    try {
      await lifecycle.start();
      expect(lifecycle.stateSource.snapshot()[0]!.state).toBe("cached");
      const registered = getRegisteredTool("mcp__cached-fail__willFail");
      const result = await registered!.executor!.execute({}, {} as never);
      expect(result.isError).toBe(true);
      const snap = lifecycle.stateSource.snapshot()[0]!;
      expect(snap.state).toBe("failed");
      expect(getRegisteredTool("mcp__cached-fail__willFail")).toBeUndefined(); // withdrawn, not left dangling
    } finally {
      await lifecycle.dispose();
    }
  });

  test("dispose() closes every live connection and unregisters every tool", async () => {
    const server = createFixtureMcpServer(defaultFixtureSpec());
    const resolved: ResolvedMcpServerEntry[] = [{ name: "disposable", origin: "explicit", config: { type: "sdk", name: "disposable" } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv(), elicitationAsk: NO_ELICIT, inProcessServers: { disposable: server } });
    await lifecycle.start();
    expect(getRegisteredTool("mcp__disposable__echo")).toBeDefined();
    await lifecycle.dispose();
    expect(getRegisteredTool("mcp__disposable__echo")).toBeUndefined();
    await server.close();
  });

  test("a spec fixture with duplicate tool names is deduped before registration (client.ts's own dedup, exercised through the whole lifecycle)", async () => {
    const spec: FixtureServerSpec = {
      tools: [
        { name: "dup", inputSchema: { type: "object", properties: {} }, handler: () => ({ content: [{ type: "text", text: "first" }] }) },
        { name: "dup", inputSchema: { type: "object", properties: {} }, handler: () => ({ content: [{ type: "text", text: "second" }] }) },
      ],
    };
    const server = createFixtureMcpServer(spec);
    const resolved: ResolvedMcpServerEntry[] = [{ name: "dupsrv", origin: "explicit", config: { type: "sdk", name: "dupsrv" } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv(), elicitationAsk: NO_ELICIT, inProcessServers: { dupsrv: server } });
    try {
      await lifecycle.start();
      expect(lifecycle.stateSource.snapshot()[0]!.toolNames).toEqual(["dup"]);
      const result = await getRegisteredTool("mcp__dupsrv__dup")!.executor!.execute({}, {} as never);
      expect(result.output).toBe("first");
    } finally {
      await lifecycle.dispose();
      await server.close();
    }
  });
});

describe("McpLifecycle bridge-tool surface: listConnectedServerNames / getConnectedClient / refreshServerTools", () => {
  test("listConnectedServerNames/getConnectedClient report only truly-'connected' servers -- never pending/cached/failed/disabled", async () => {
    const good = createFixtureMcpServer(defaultFixtureSpec());
    const cache = createInMemoryDiscoveryCache();
    cache.set("cachedsrv", [{ name: "t", inputSchema: {} }]);
    const resolved: ResolvedMcpServerEntry[] = [
      { name: "connectedsrv", origin: "explicit", config: { type: "sdk", name: "connectedsrv" } },
      { name: "cachedsrv", origin: "explicit", config: { type: "http", url: "http://127.0.0.1:1/never-dialed" } },
      { name: "failedsrv", origin: "explicit", config: { command: "/no/such/binary-bridge-surface-test" } },
    ];
    const lifecycle = createMcpLifecycle({
      servers: resolved,
      envConfig: fastEnv({ discoveryCache: true }),
      elicitationAsk: NO_ELICIT,
      inProcessServers: { connectedsrv: good },
      discoveryCache: cache,
    });
    try {
      await lifecycle.start();
      await lifecycle.stateSource.waitForPending(undefined, 500);
      expect(lifecycle.listConnectedServerNames()).toEqual(["connectedsrv"]);
      expect(lifecycle.getConnectedClient("connectedsrv")).toBeDefined();
      expect(lifecycle.getConnectedClient("cachedsrv")).toBeUndefined();
      expect(lifecycle.getConnectedClient("failedsrv")).toBeUndefined();
      expect(lifecycle.getConnectedClient("does-not-exist-at-all")).toBeUndefined();
    } finally {
      await lifecycle.dispose();
      await good.close();
    }
  });

  test("refreshServerTools: re-queries an already-connected server's tools/list and re-registers a genuinely changed list, without reconnecting", async () => {
    // A hand-built low-level server (not test-fixtures.ts's own createFixtureMcpServer, which
    // captures its tool list ONCE at construction from a plain spec object) -- this test needs the
    // SERVER's own tools/list answer to genuinely change BETWEEN two calls over the SAME connection,
    // which requires a live, mutable closure the server's own request handler reads fresh each time.
    let toolName = "v1";
    const server = new Server({ name: "mutable-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: toolName, inputSchema: { type: "object", properties: {} } }] }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => ({ content: [{ type: "text", text: `called:${req.params.name}` }] }));

    const resolved: ResolvedMcpServerEntry[] = [{ name: "refreshable", origin: "explicit", config: { type: "sdk", name: "refreshable" } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv(), elicitationAsk: NO_ELICIT, inProcessServers: { refreshable: server } });
    try {
      await lifecycle.start();
      expect(lifecycle.stateSource.snapshot()[0]!.toolNames).toEqual(["v1"]);
      expect(getRegisteredTool("mcp__refreshable__v1")).toBeDefined();

      toolName = "v2"; // the "server" changes its own tool list -- ordinary tool-call machinery would never see this on its own
      const result = await lifecycle.refreshServerTools("refreshable");
      expect(result).toEqual({ ok: true, toolNames: ["v2"] });
      expect(lifecycle.stateSource.snapshot()[0]!.toolNames).toEqual(["v2"]);
      // set-replace semantics (registry.ts's own contract, T2): the old name is gone, the new one
      // is registered and executable -- proving this went through a REAL registerMcpServerTools
      // call, not just a state-board bookkeeping update.
      expect(getRegisteredTool("mcp__refreshable__v1")).toBeUndefined();
      const callResult = await getRegisteredTool("mcp__refreshable__v2")!.executor!.execute({}, {} as never);
      expect(callResult).toEqual({ output: "called:v2" });
    } finally {
      await lifecycle.dispose();
      await server.close();
    }
  });

  test("refreshServerTools never connects a disconnected server (WS-09 §1.4 MUST) -- pending/cached/failed/disabled/unknown all refuse", async () => {
    const cache = createInMemoryDiscoveryCache();
    cache.set("cachedsrv", [{ name: "t", inputSchema: {} }]);
    const resolved: ResolvedMcpServerEntry[] = [
      { name: "cachedsrv", origin: "explicit", config: { type: "http", url: "http://127.0.0.1:1/never-dialed" } },
      { name: "failedsrv", origin: "explicit", config: { command: "/no/such/binary-refresh-test" } },
    ];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv({ discoveryCache: true }), elicitationAsk: NO_ELICIT, discoveryCache: cache });
    try {
      await lifecycle.start();
      await lifecycle.stateSource.waitForPending(undefined, 500);
      expect(lifecycle.stateSource.snapshot().find((s) => s.name === "cachedsrv")!.state).toBe("cached");

      const cachedResult = await lifecycle.refreshServerTools("cachedsrv");
      expect(cachedResult.ok).toBe(false);
      // Still "cached" afterward -- refreshServerTools never upgraded it into a real connection.
      expect(lifecycle.stateSource.snapshot().find((s) => s.name === "cachedsrv")!.state).toBe("cached");

      const failedResult = await lifecycle.refreshServerTools("failedsrv");
      expect(failedResult.ok).toBe(false);

      const unknownResult = await lifecycle.refreshServerTools("totally-unknown");
      expect(unknownResult).toEqual({ ok: false, reason: expect.stringContaining("unknown") as unknown as string });
    } finally {
      await lifecycle.dispose();
    }
  });
});
