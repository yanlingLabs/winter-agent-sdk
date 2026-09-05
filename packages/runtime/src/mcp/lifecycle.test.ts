import { describe, test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getRegisteredTool } from "../tools/registry.ts";
import { createElicitationAsker } from "./elicitation.ts";
import { createInMemoryDiscoveryCache, createMcpLifecycle, resolveMcpServerSources, type McpServerSource, type ResolvedMcpServerEntry } from "./lifecycle.ts";
import type { McpEnvConfig } from "./env.ts";
import type { InProcessMcpServer } from "./transports/sdk.ts";
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

  test("RULING P5-K: an untrusted project-sourced stdio config loads DISABLED with a visible reason, never connected", () => {
    const result = resolveMcpServerSources([{ origin: "project", servers: { local: { command: "x" } } }], { trustedWorkspace: false });
    expect(result.rejected).toEqual([]);
    expect(result.resolved).toEqual([{ name: "local", origin: "project", config: { command: "x" }, disabledReason: expect.stringContaining("trusted workspace") as unknown as string }]);
  });

  test("project-sourced stdio config is ACCEPTED in a trusted workspace", () => {
    const result = resolveMcpServerSources([{ origin: "project", servers: { local: { command: "x" } } }], { trustedWorkspace: true });
    expect(result.resolved).toEqual([{ name: "local", origin: "project", config: { command: "x" } }]);
  });

  test("RULING P5-K: an untrusted project-sourced HTTP config is gated too -- the transport is not what makes it a capability grant", () => {
    // P4's gate was stdio-only because only process spawning looked dangerous. An http/sse server
    // from a cloned repository receives the session's tool calls (exfiltration by argument) and
    // answers with tool results and descriptions the model reads -- in a workspace the host never
    // declared trusted.
    const result = resolveMcpServerSources([{ origin: "project", servers: { remote: { type: "http", url: "https://example.com/mcp" } } }], { trustedWorkspace: false });
    expect(result.resolved).toEqual([
      { name: "remote", origin: "project", config: { type: "http", url: "https://example.com/mcp" }, disabledReason: expect.stringContaining("trusted workspace") as unknown as string },
    ]);
  });

  test("RULING P5-K: user/settings and plugin tiers are UNCHANGED -- only `project` is gated", () => {
    const result = resolveMcpServerSources(
      [
        { origin: "settings", servers: { fromUser: { type: "http", url: "https://example.com/u" } } },
        { origin: "plugin", servers: { fromPlugin: { command: "p" } } },
      ],
      { trustedWorkspace: false },
    );
    expect(result.resolved.map((r) => ({ name: r.name, disabled: r.disabledReason !== undefined }))).toEqual([
      { name: "fromUser", disabled: false },
      { name: "fromPlugin", disabled: false },
    ]);
  });

  test("an untrusted project config that is also MALFORMED is still a rejection -- the trust gate does not launder a bad config into a toggleable one", () => {
    const result = resolveMcpServerSources([{ origin: "project", servers: { bad: { type: "http" } } }], { trustedWorkspace: false });
    expect(result.resolved).toEqual([]);
    expect(result.rejected[0]!.reason).toContain("url");
  });

  test("a disabled-by-trust higher-precedence declaration still claims the name -- a lower-precedence source never silently backfills it", () => {
    const sources: McpServerSource[] = [
      { origin: "project", servers: { gh: { command: "project-cmd" } } }, // untrusted -> disabled, not replaced
      { origin: "plugin", servers: { gh: { command: "plugin-cmd" } } }, // valid, but lower precedence than project
    ];
    const result = resolveMcpServerSources(sources, { trustedWorkspace: false });
    expect(result.resolved.map((r) => r.config)).toEqual([{ command: "project-cmd" }]); // NOT plugin's config
    expect(result.resolved[0]!.disabledReason).toBeDefined();
    expect(result.shadowed).toEqual([{ name: "gh", origin: "plugin", shadowedBy: "project" }]);
  });

  test("an absent 'type' is treated as stdio for validation purposes", () => {
    const result = resolveMcpServerSources([{ origin: "explicit", servers: { s: { command: "x", args: ["--flag"] } } }], { trustedWorkspace: true });
    expect(result.resolved).toEqual([{ name: "s", origin: "explicit", config: { command: "x", args: ["--flag"] } }]);
  });
});

describe("RULING P5-K: an untrusted project server reaches the lifecycle DISABLED, and stays host-toggleable", () => {
  /** Wraps a fixture server so every CONNECTION ATTEMPT is counted -- `disabled` must mean zero. */
  function counting(server: InProcessMcpServer): { server: InProcessMcpServer; connects: () => number } {
    let connects = 0;
    return {
      server: {
        connect: async (transport) => {
          connects++;
          return server.connect(transport);
        },
      },
      connects: () => connects,
    };
  }

  test("start() makes NO connection attempt for it, and its state carries the trust reason", async () => {
    const fixture = createFixtureMcpServer(defaultFixtureSpec());
    const probe = counting(fixture);
    const resolved: ResolvedMcpServerEntry[] = [{ name: "repo", origin: "project", config: { type: "sdk", name: "repo" }, disabledReason: "project-sourced MCP servers require a trusted workspace" }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv(), elicitationAsk: NO_ELICIT, inProcessServers: { repo: probe.server } });
    try {
      await lifecycle.start();
      expect(probe.connects()).toBe(0);
      const state = lifecycle.stateSource.snapshot()[0]!;
      expect(state.state).toBe("disabled");
      expect(state.error).toContain("trusted workspace");
      expect(getRegisteredTool("mcp__repo__echo")).toBeUndefined(); // no tools -- the model cannot call it
    } finally {
      await lifecycle.dispose();
      await fixture.close();
    }
  });

  test("the host can TOGGLE it on -- a toggle is a host trust decision, and the reason clears when it connects", async () => {
    const fixture = createFixtureMcpServer(defaultFixtureSpec());
    const probe = counting(fixture);
    const resolved: ResolvedMcpServerEntry[] = [{ name: "repo2", origin: "project", config: { type: "sdk", name: "repo2" }, disabledReason: "project-sourced MCP servers require a trusted workspace" }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv(), elicitationAsk: NO_ELICIT, inProcessServers: { repo2: probe.server } });
    try {
      await lifecycle.start();
      expect(probe.connects()).toBe(0);

      // Through the HOST's own door: `McpControlSeam.toggle` is what a `mcp_toggle` control request
      // reaches, and a toggle is a host trust decision by construction -- the model cannot issue one.
      await lifecycle.controlSeam.toggle("repo2", true);
      expect(probe.connects()).toBe(1);
      const state = lifecycle.stateSource.snapshot()[0]!;
      expect(state.state).toBe("connected");
      expect(state.error).toBeUndefined(); // the trust reason belonged to the disabled state
      expect(getRegisteredTool("mcp__repo2__echo")).toBeDefined();
    } finally {
      await lifecycle.dispose();
      await fixture.close();
    }
  });

  test("MCP_CONNECTION_NONBLOCKING=0 does not WAIT on a disabled slot -- it is never `pending`", async () => {
    // The trap this pins: a slot constructed `pending` and skipped in `start()` would sit pending
    // forever, and the blocking-batch path (`waitForPending`) would burn the whole connect deadline.
    const resolved: ResolvedMcpServerEntry[] = [{ name: "repo3", origin: "project", config: { command: "never-run" }, disabledReason: "untrusted" }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv({ connectionNonblocking: false, connectTimeoutMs: 5000 }), elicitationAsk: NO_ELICIT });
    try {
      const started = Date.now();
      await lifecycle.start();
      expect(Date.now() - started).toBeLessThan(1000);
      expect(lifecycle.stateSource.snapshot()[0]!.state).toBe("disabled");
    } finally {
      await lifecycle.dispose();
    }
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

  test("fix round 1 (Minor 4): a server tool's annotations and _meta survive createMcpLifecycle's own registration, all the way into getRegisteredTool(...).descriptor", async () => {
    const server = createFixtureMcpServer({
      tools: [
        {
          name: "annotated",
          description: "carries annotations and _meta",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true, title: "Annotated Tool", idempotentHint: true },
          _meta: { "anthropic/requiresUserInteraction": true, "some-vendor/extra": "value" },
          handler: () => ({ content: [{ type: "text", text: "ok" }] }),
        },
      ],
    });
    const resolved: ResolvedMcpServerEntry[] = [{ name: "annot-srv", origin: "explicit", config: { type: "sdk", name: "annot-srv" } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv(), elicitationAsk: NO_ELICIT, inProcessServers: { "annot-srv": server } });
    try {
      await lifecycle.start();
      const registered = getRegisteredTool("mcp__annot-srv__annotated");
      expect(registered).toBeDefined();
      expect(registered!.descriptor.annotations).toEqual({ readOnlyHint: true, title: "Annotated Tool", idempotentHint: true });
      expect(registered!.descriptor._meta).toEqual({ "anthropic/requiresUserInteraction": true, "some-vendor/extra": "value" });
    } finally {
      await lifecycle.dispose();
      await server.close();
    }
  });

  // RULING P4-K, end to end through a REAL fixture server: the model gets the `<persisted-output>`
  // envelope and the full payload is on disk, under the CALLING SESSION's own temp root (which is
  // what `ctx.tempDir` is -- never the process-global background-task root a nested child re-points
  // mid-session, whole-branch review M3(a)). The retired inline truncation marker is asserted gone.
  test("output cap (RULING P4-K): an oversized tool result is PERSISTED under the session's own dir and the model gets the envelope", async () => {
    const bigText = "x".repeat(10_000);
    const sessionDir = mkdtempSync(join(tmpdir(), "winter-lifecycle-outcap-"));
    const server = createFixtureMcpServer({
      tools: [{ name: "big", inputSchema: { type: "object", properties: {} }, handler: () => ({ content: [{ type: "text", text: bigText }] }) }],
    });
    const resolved: ResolvedMcpServerEntry[] = [{ name: "fix", origin: "explicit", config: { type: "sdk", name: "fix" } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv({ maxOutputTokens: 10 }), elicitationAsk: NO_ELICIT, inProcessServers: { fix: server } });
    try {
      await lifecycle.start();
      const result = await getRegisteredTool("mcp__fix__big")!.executor!.execute({}, { tempDir: sessionDir } as never);
      expect(result.output.length).toBeLessThan(bigText.length);
      expect(result.output).toContain("<persisted-output>");
      expect(result.output).toContain("Output too large (9.8KB). Full output saved to: ");
      expect(result.output).not.toContain("truncated at 10 tokens"); // the retired inline marker
      const path = /Full output saved to: (.+)/.exec(result.output)![1]!.trim();
      expect(path.startsWith(join(sessionDir, "mcp-output"))).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(bigText); // byte-exact, envelope-free
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
      await lifecycle.dispose();
      await server.close();
    }
  });

  // The below-threshold half of the same seam: an ordinary result is untouched AND the session temp
  // root is never even asked for (D18 lazy creation -- `ctx.tempDir` is a getter that materializes
  // real directories on first read).
  test("output cap (RULING P4-K): an ordinary result is returned verbatim and never touches the session dir", async () => {
    let tempDirReads = 0;
    const server = createFixtureMcpServer({
      tools: [{ name: "small", inputSchema: { type: "object", properties: {} }, handler: () => ({ content: [{ type: "text", text: "tiny" }] }) }],
    });
    const resolved: ResolvedMcpServerEntry[] = [{ name: "fix", origin: "explicit", config: { type: "sdk", name: "fix" } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv(), elicitationAsk: NO_ELICIT, inProcessServers: { fix: server } });
    try {
      await lifecycle.start();
      const ctx = {
        get tempDir() {
          tempDirReads += 1;
          return "/nonexistent/never-used";
        },
      };
      const result = await getRegisteredTool("mcp__fix__small")!.executor!.execute({}, ctx as never);
      expect(result).toEqual({ output: "tiny" });
      expect(tempDirReads).toBe(0);
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

  test("a server requiring auth (401, no authProvider configured) lands in the 'needsAuth' state, not 'failed'", async () => {
    const authServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("unauthorized", { status: 401 }) });
    const resolved: ResolvedMcpServerEntry[] = [{ name: "gated", origin: "explicit", config: { type: "http", url: `http://127.0.0.1:${authServer.port}/mcp` } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv(), elicitationAsk: NO_ELICIT });
    try {
      await lifecycle.start();
      await lifecycle.stateSource.waitForPending(undefined, 500);
      expect(lifecycle.stateSource.snapshot()).toEqual([{ name: "gated", state: "needsAuth", toolNames: [], errorCode: "needs_auth", error: expect.any(String) as unknown as string }]);
      expect(getRegisteredTool("mcp__gated__anything")).toBeUndefined();
    } finally {
      await lifecycle.dispose();
      authServer.stop(true);
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
      expect(snap.toolNames.sort()).toEqual(["boom", "echo", "env_dump"]);
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

// --- Fix round 1 (MAJOR M2): the unguarded connect-completion race -------------------------------
//
// `connectSlotForReal`/`connectOneServer` used to commit `slot.client`, tool registration, executor
// installation, and `setSlotState` UNCONDITIONALLY on a captured slot reference, with no staleness
// check -- a disable/remove/reconnect/replace issued while a connect was still in flight could be
// silently undone (or leaked) the moment that stale attempt finally resolved. This lane's own
// original suite never caught it because every fixture in it was always fully awaited before the
// next assertion ran; the tests below deliberately hold a connect open (a `gate` deferred) so a
// control operation can race it on purpose.
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// A FRESH real fixture Server per connect() call, not one shared instance: the SDK's own
// `Protocol.connect()` throws ("Already connected to a transport...") on a second connect against
// the same instance, so reusing one Server across two concurrently-gated attempts is not just
// unrealistic (a real stdio/http dial always gets its own server-side session) -- it is impossible.
// `gate` holds EVERY attempt open until released; `connectCount`/`closeCount` tally across all of
// them, so a test can assert "N attempts dialed, M were torn down, N-M genuinely survive."
// `Server.onclose` (Protocol's own public hook) fires when `InMemoryTransport`'s linked-pair close
// propagates to this side -- which it does the moment a discarded attempt's own
// `ConnectedMcpClient.close()` runs.
function gatedInProcessServer(gate: Promise<void>): { server: InProcessMcpServer; connectCount(): number; closeCount(): number } {
  let connects = 0;
  let closes = 0;
  return {
    server: {
      async connect(transport) {
        await gate;
        connects++;
        const inner = createFixtureMcpServer(defaultFixtureSpec());
        inner.onclose = () => {
          closes++;
        };
        await inner.connect(transport);
      },
    },
    connectCount: () => connects,
    closeCount: () => closes,
  };
}

describe("fix round 1 (MAJOR M2): connect-completion race protection (per-slot generation guard)", () => {
  test("toggling OFF while the initial connect is still pending discards it: no tools registered, state stays disabled, the connection is closed not leaked", async () => {
    const gate = createDeferred();
    const { server, connectCount, closeCount } = gatedInProcessServer(gate.promise);
    const resolved: ResolvedMcpServerEntry[] = [{ name: "race-toggle", origin: "explicit", config: { type: "sdk", name: "race-toggle" } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv({ connectTimeoutMs: 50 }), elicitationAsk: NO_ELICIT, inProcessServers: { "race-toggle": server } });
    try {
      await lifecycle.start(); // start()'s own race gives up after 50ms; the gated attempt keeps running in the background
      expect(lifecycle.stateSource.snapshot()[0]!.state).toBe("pending");

      await lifecycle.controlSeam.toggle("race-toggle", false); // disable WHILE the attempt is still in flight
      expect(lifecycle.stateSource.snapshot()[0]!.state).toBe("disabled");

      gate.resolve(); // let the now-stale attempt actually proceed
      await new Promise((r) => setTimeout(r, 100)); // give it time to finish connecting, discover it's superseded, and discard

      expect(lifecycle.stateSource.snapshot()[0]!.state).toBe("disabled"); // never resurrected
      expect(getRegisteredTool("mcp__race-toggle__echo")).toBeUndefined(); // never registered
      expect(connectCount()).toBe(1); // the attempt DID dial
      expect(closeCount()).toBe(1); // ...and its own connection was torn down once superseded -- 0 live
    } finally {
      await lifecycle.dispose();
    }
  });

  test("removing a server while its initial connect is still pending discards it: no leaked registration, no leaked connection", async () => {
    const gate = createDeferred();
    const { server, connectCount, closeCount } = gatedInProcessServer(gate.promise);
    const resolved: ResolvedMcpServerEntry[] = [{ name: "race-remove", origin: "explicit", config: { type: "sdk", name: "race-remove" } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv({ connectTimeoutMs: 50 }), elicitationAsk: NO_ELICIT, inProcessServers: { "race-remove": server } });
    try {
      await lifecycle.start();
      expect(lifecycle.stateSource.snapshot()[0]!.state).toBe("pending");

      const result = await lifecycle.controlSeam.setServers({}); // "explicit" origin is replace-eligible -- an omission removes it
      expect(result.removed).toEqual(["race-remove"]);
      expect(lifecycle.stateSource.snapshot()).toEqual([]); // slot gone immediately, synchronously

      gate.resolve();
      await new Promise((r) => setTimeout(r, 100));

      expect(lifecycle.stateSource.snapshot()).toEqual([]); // still gone -- never resurrected
      expect(getRegisteredTool("mcp__race-remove__echo")).toBeUndefined();
      expect(connectCount()).toBe(1);
      expect(closeCount()).toBe(1); // the orphaned connection was closed, not leaked -- 0 live
    } finally {
      await lifecycle.dispose();
    }
  });

  test("reconnecting while the initial connect is still pending supersedes it: exactly one live connection survives", async () => {
    const gate = createDeferred();
    const { server, connectCount, closeCount } = gatedInProcessServer(gate.promise);
    const resolved: ResolvedMcpServerEntry[] = [{ name: "race-reconnect", origin: "explicit", config: { type: "sdk", name: "race-reconnect" } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv({ connectTimeoutMs: 50 }), elicitationAsk: NO_ELICIT, inProcessServers: { "race-reconnect": server } });
    try {
      await lifecycle.start();
      expect(lifecycle.stateSource.snapshot()[0]!.state).toBe("pending");

      // Starts a SECOND attempt (bumping the slot's generation synchronously, right here) while the
      // first is still gated -- reconnectExisting's own early "close slot.client if present" step is
      // a no-op (nothing has committed yet).
      const reconnectPromise = lifecycle.controlSeam.reconnect("race-reconnect");

      gate.resolve(); // release BOTH the now-stale first attempt and the fresh second attempt
      await reconnectPromise;

      expect(lifecycle.stateSource.snapshot()[0]!.state).toBe("connected");
      expect(getRegisteredTool("mcp__race-reconnect__echo")).toBeDefined();
      expect(connectCount()).toBe(2); // both attempts dialed
      expect(closeCount()).toBe(1); // only the superseded (first) attempt's connection was closed -- 1 live
    } finally {
      await lifecycle.dispose();
    }
  });

  test("a setServers replacement issued while the initial connect is still pending supersedes it: only the replacement survives", async () => {
    const gate = createDeferred();
    const { server, connectCount, closeCount } = gatedInProcessServer(gate.promise);
    const resolved: ResolvedMcpServerEntry[] = [{ name: "race-replace", origin: "explicit", config: { type: "sdk", name: "race-replace" } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv({ connectTimeoutMs: 50 }), elicitationAsk: NO_ELICIT, inProcessServers: { "race-replace": server } });
    try {
      await lifecycle.start();
      expect(lifecycle.stateSource.snapshot()[0]!.state).toBe("pending");

      // addAndConnect (naming the SAME server again) replaces the slot OBJECT outright and fires a
      // fresh connectOneServer -- fire-and-forget, so this resolves quickly without waiting for
      // either the stale original or the fresh replacement to actually finish connecting.
      const result = await lifecycle.controlSeam.setServers({ "race-replace": { type: "sdk", name: "race-replace" } });
      expect(result.added).toEqual(["race-replace"]);

      gate.resolve(); // release both the now-stale original attempt and the fresh replacement attempt
      await new Promise((r) => setTimeout(r, 100));

      expect(lifecycle.stateSource.snapshot()[0]!.state).toBe("connected");
      expect(getRegisteredTool("mcp__race-replace__echo")).toBeDefined();
      expect(connectCount()).toBe(2); // original + replacement both dialed
      expect(closeCount()).toBe(1); // only the superseded original's connection was closed -- 1 live
    } finally {
      await lifecycle.dispose();
    }
  });

  // Holds EVERY request until `gate` resolves once (matching the advisor-suggested one-liner
  // `fetch: async (req) => { await gate; return transport.handleRequest(req); }`) -- a request that
  // arrives AFTER the one-time resolve passes straight through, since awaiting an already-resolved
  // promise never blocks. `initializeCount` sniffs a CLONE of each POST body for the literal
  // `"method":"initialize"` JSON-RPC method name -- the one thing this suite actually needs to prove
  // "exactly one real handshake reached the server," which a single shared `Client`/session could
  // never produce twice on its own.
  async function createGatedHttpServer(spec: FixtureServerSpec, gate: Promise<void>) {
    const server = createFixtureMcpServer(spec);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    await server.connect(transport);
    let initializeCount = 0;
    const bunServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        if (req.method === "POST") {
          const text = await req
            .clone()
            .text()
            .catch(() => "");
          if (text.includes('"method":"initialize"')) initializeCount++;
        }
        await gate;
        return transport.handleRequest(req);
      },
    });
    return {
      url: new URL(`http://127.0.0.1:${bunServer.port}/mcp`),
      initializeCount: () => initializeCount,
      stop: () => bunServer.stop(true),
      server,
    };
  }

  // Fix round 1, post-fix-round advisory finding: `beginAttempt`/`isCurrentAttempt`'s SUPERSEDE
  // semantics (correct for disable/remove/reconnect/replace, which genuinely want a prior attempt
  // dead) are WRONG for two concurrent on-demand connects racing each other on the SAME "cached"
  // server -- neither one is trying to supersede the other, they are both just trying to satisfy the
  // SAME "connect on first use" need at once. Applying supersede there made the SECOND beginAttempt
  // call silently invalidate the FIRST, so whichever of two concurrent first-tool-calls happened to
  // finish first discarded its own perfectly good connection and reported "not connected" -- a
  // regression this fix round's own review introduced and caught before it shipped.
  test("two concurrent first-tool-calls on the same 'cached' server both succeed (dedupe, not supersede)", async () => {
    const gate = createDeferred();
    const fixture = await createGatedHttpServer(defaultFixtureSpec(), gate.promise);
    try {
      const cache = createInMemoryDiscoveryCache();
      cache.set("race-cached", [{ name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }]);
      const resolved: ResolvedMcpServerEntry[] = [{ name: "race-cached", origin: "explicit", config: { type: "http", url: fixture.url.toString() } }];
      const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv({ discoveryCache: true }), elicitationAsk: NO_ELICIT, discoveryCache: cache });
      try {
        await lifecycle.start();
        expect(lifecycle.stateSource.snapshot()[0]!.state).toBe("cached"); // served from the cache -- no real dial yet

        const registered = getRegisteredTool("mcp__race-cached__echo")!;
        const p1 = registered.executor!.execute({ text: "a" }, {} as never);
        const p2 = registered.executor!.execute({ text: "b" }, {} as never);

        gate.resolve(); // release both concurrent on-demand connects at once
        const [r1, r2] = await Promise.all([p1, p2]);

        expect(r1.isError).not.toBe(true);
        expect(r2.isError).not.toBe(true);
        expect(fixture.initializeCount()).toBe(1); // exactly one real handshake serves BOTH callers
        // Pre-existing, unrelated-to-this-fix behavior: a successful on-demand connect never itself
        // transitions the wire state past "cached" (WS-09 §2.1 -- tools stay advertised under
        // "cached" either way; only `slot.client` internally distinguishes "not yet dialed" from
        // "live"). This assertion exists to document that fact for this test's own reader, not to
        // re-litigate it.
        expect(lifecycle.stateSource.snapshot()[0]!.state).toBe("cached");
      } finally {
        await lifecycle.dispose();
      }
    } finally {
      fixture.stop();
      await fixture.server.close();
    }
  });

  test("dispose() while a connect is still pending invalidates it: nothing leaks after it resolves", async () => {
    const gate = createDeferred();
    const { server, connectCount, closeCount } = gatedInProcessServer(gate.promise);
    const resolved: ResolvedMcpServerEntry[] = [{ name: "race-dispose", origin: "explicit", config: { type: "sdk", name: "race-dispose" } }];
    const lifecycle = createMcpLifecycle({ servers: resolved, envConfig: fastEnv({ connectTimeoutMs: 50 }), elicitationAsk: NO_ELICIT, inProcessServers: { "race-dispose": server } });
    await lifecycle.start();
    expect(lifecycle.stateSource.snapshot()[0]!.state).toBe("pending");

    await lifecycle.dispose(); // tears down while the connect is still gated/in flight (bumps gen; no live client to close yet)

    gate.resolve();
    await new Promise((r) => setTimeout(r, 100));

    expect(getRegisteredTool("mcp__race-dispose__echo")).toBeUndefined(); // never registered post-dispose
    expect(connectCount()).toBe(1);
    expect(closeCount()).toBe(1); // the late-resolving connection was closed, not leaked
  });
});
