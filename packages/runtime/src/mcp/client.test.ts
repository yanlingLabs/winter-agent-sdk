import { describe, test, expect } from "bun:test";
import { Server } from "@modelcontextprotocol/server";
import { inputRequired, inputResponse } from "@modelcontextprotocol/server";
import {
  connectMcpServer,
  McpConnectError,
  resolveVersionNegotiation,
  type ConnectedMcpClient,
} from "./client.ts";
import { createElicitationAsker, type ElicitationSender, type ElicitationResultPayload, type ElicitationRequestPayload } from "./elicitation.ts";
import { createFixtureMcpServer, defaultFixtureSpec, withHttpFixture, withModernHttpFixture, withSseFixture, stdioFixtureCommand, pingFixtureCommand, type FixtureServerSpec } from "./test-fixtures.ts";

const NO_ELICIT = createElicitationAsker(undefined);

function fakeElicitationSender(resolve: () => ElicitationResultPayload): ElicitationSender {
  return {
    async request<T = unknown>(): Promise<T> {
      return resolve() as T;
    },
  };
}

describe("connectMcpServer: the sdk (in-process) transport", () => {
  test("connects, lists tools (annotations/_meta preserved), calls a tool, closes idempotently", async () => {
    const server = createFixtureMcpServer({
      tools: [
        {
          name: "greet",
          description: "greets",
          inputSchema: { type: "object", properties: { who: { type: "string" } }, required: ["who"] },
          annotations: { readOnlyHint: true, title: "Greet" },
          _meta: { "x-custom": 1 },
          handler: (args) => ({ content: [{ type: "text", text: `hi ${String(args.who)}` }] }),
        },
      ],
    });
    let client: ConnectedMcpClient | undefined;
    try {
      client = await connectMcpServer({ name: "greeter", config: { type: "sdk", name: "greeter" }, connectTimeoutMs: 5000, elicitationAsk: NO_ELICIT, inProcessServer: server });
      expect(client.serverName).toBe("greeter");
      const tools = await client.listTools();
      expect(tools).toEqual([
        {
          name: "greet",
          description: "greets",
          inputSchema: { type: "object", properties: { who: { type: "string" } }, required: ["who"] },
          annotations: { readOnlyHint: true, title: "Greet" },
          _meta: { "x-custom": 1 },
        },
      ]);
      const result = await client.callTool("greet", { who: "world" });
      expect(result).toEqual({ content: [{ type: "text", text: "hi world" }] });
      await client.close();
      await client.close(); // idempotent -- a second close() must not throw
    } finally {
      await server.close().catch(() => {});
    }
  });

  test("an isError tool result is returned, not thrown", async () => {
    const server = createFixtureMcpServer(defaultFixtureSpec());
    const client = await connectMcpServer({ name: "s", config: { type: "sdk", name: "s" }, connectTimeoutMs: 5000, elicitationAsk: NO_ELICIT, inProcessServer: server });
    try {
      const result = await client.callTool("boom", {});
      expect(result).toEqual({ content: [{ type: "text", text: "boom" }], isError: true });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("listResources + readResource: text inline, blob as base64 (no path-marker logic here -- that's the bridge tool's job)", async () => {
    const server = createFixtureMcpServer(defaultFixtureSpec());
    const client = await connectMcpServer({ name: "s", config: { type: "sdk", name: "s" }, connectTimeoutMs: 5000, elicitationAsk: NO_ELICIT, inProcessServer: server });
    try {
      const resources = await client.listResources();
      expect(resources.map((r) => r.uri).sort()).toEqual(["fixture://blob.bin", "fixture://text.txt"]);
      const text = await client.readResource("fixture://text.txt");
      expect(text).toEqual([{ uri: "fixture://text.txt", mimeType: "text/plain", text: "hello fixture world" }]);
      const blob = await client.readResource("fixture://blob.bin");
      expect(blob).toEqual([{ uri: "fixture://blob.bin", mimeType: "application/octet-stream", blobBase64: Buffer.from([1, 2, 3, 4]).toString("base64") }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("duplicate tool names in one tools/list are deduped, keeping the first occurrence", async () => {
    const spec: FixtureServerSpec = {
      tools: [
        { name: "dup", description: "first", inputSchema: { type: "object", properties: {} }, handler: () => ({ content: [{ type: "text", text: "first" }] }) },
        { name: "dup", description: "second", inputSchema: { type: "object", properties: {} }, handler: () => ({ content: [{ type: "text", text: "second" }] }) },
      ],
    };
    const server = createFixtureMcpServer(spec);
    const client = await connectMcpServer({ name: "s", config: { type: "sdk", name: "s" }, connectTimeoutMs: 5000, elicitationAsk: NO_ELICIT, inProcessServer: server });
    try {
      const tools = await client.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]!.description).toBe("first");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("elicitation: a tool that elicits routes through the configured asker with the correct serverName, and the server sees its answer", async () => {
    const seen: unknown[] = [];
    const server = createFixtureMcpServer({
      tools: [
        {
          name: "ask",
          description: "elicits",
          inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
          handler: async (args, srv) => {
            const result = await srv.elicitInput({ message: String(args.q), requestedSchema: { type: "object", properties: { answer: { type: "string" } } } });
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
          },
        },
      ],
    });
    const sender = fakeElicitationSender(() => ({ action: "accept", content: { answer: "42" } }));
    const ask = createElicitationAsker(sender);
    const wrappedAsk = async (payload: Parameters<typeof ask>[0]) => {
      seen.push(payload);
      return ask(payload);
    };
    const client = await connectMcpServer({ name: "elicit-srv", config: { type: "sdk", name: "elicit-srv" }, connectTimeoutMs: 5000, elicitationAsk: wrappedAsk, inProcessServer: server });
    try {
      const result = await client.callTool("ask", { q: "what is it" });
      const text = (result.content[0] as { text: string }).text;
      expect(JSON.parse(text)).toEqual({ action: "accept", content: { answer: "42" } });
      // The real MCP protocol layer defaults an omitted `mode` to the literal "form" on the wire
      // (verified empirically) -- buildElicitationPayload forwards whatever it is actually given.
      expect(seen).toEqual([
        { serverName: "elicit-srv", message: "what is it", mode: "form", requestedSchema: { type: "object", properties: { answer: { type: "string" } } } },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("no elicitation callback configured (NO_ELICIT) -> the server sees a deterministic decline, never a hang", async () => {
    const server = createFixtureMcpServer({
      tools: [
        {
          name: "ask",
          inputSchema: { type: "object", properties: {} },
          handler: async (_args, srv) => {
            const result = await srv.elicitInput({ message: "anything", requestedSchema: { type: "object", properties: {} } });
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
          },
        },
      ],
    });
    const client = await connectMcpServer({ name: "s", config: { type: "sdk", name: "s" }, connectTimeoutMs: 5000, elicitationAsk: NO_ELICIT, inProcessServer: server });
    try {
      const result = await client.callTool("ask", {});
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ action: "decline" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("callTool honors its own opts.timeoutMs, independent of connectTimeoutMs", async () => {
    const server = createFixtureMcpServer({
      tools: [{ name: "slow", inputSchema: { type: "object", properties: {} }, handler: () => new Promise(() => {}) }], // never resolves
    });
    const client = await connectMcpServer({ name: "s", config: { type: "sdk", name: "s" }, connectTimeoutMs: 5000, elicitationAsk: NO_ELICIT, inProcessServer: server });
    try {
      const started = Date.now();
      await expect(client.callTool("slow", {}, { timeoutMs: 100 })).rejects.toBeTruthy();
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("connecting with type 'sdk' but no inProcessServer supplied fails fast with a typed spawn_failed error", async () => {
    await expect(connectMcpServer({ name: "s", config: { type: "sdk", name: "s" }, connectTimeoutMs: 1000, elicitationAsk: NO_ELICIT })).rejects.toMatchObject({
      code: "spawn_failed",
    });
  });

  test("listTools() is a LIVE re-query every call, never a snapshot frozen at connect time (regression pin -- mcp/lifecycle.ts's RefreshMcpTools depends on this)", async () => {
    let toolName = "v1";
    const server = new Server({ name: "mutable", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", async () => ({ tools: [{ name: toolName, inputSchema: { type: "object", properties: {} } }] }));
    server.setRequestHandler("tools/call", async () => ({ content: [] }));
    const client = await connectMcpServer({ name: "s", config: { type: "sdk", name: "s" }, connectTimeoutMs: 5000, elicitationAsk: NO_ELICIT, inProcessServer: server });
    try {
      expect((await client.listTools()).map((t) => t.name)).toEqual(["v1"]);
      toolName = "v2";
      expect((await client.listTools()).map((t) => t.name)).toEqual(["v2"]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("connectMcpServer: error classification", () => {
  test("a nonexistent stdio command classifies as spawn_failed", async () => {
    let error: unknown;
    try {
      await connectMcpServer({ name: "s", config: { command: "/no/such/binary-winter-lane-a-test" }, connectTimeoutMs: 2000, elicitationAsk: NO_ELICIT });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(McpConnectError);
    expect((error as McpConnectError).code).toBe("spawn_failed");
  });

  test("an HTTP 401 (auth required, no authProvider configured) classifies as needs_auth (WS-09 §2.1's 'needsAuth' state)", async () => {
    // This connector never configures an authProvider (WS-09 doesn't ask Lane A to implement an
    // OAuth flow), so a 401 surfaces as a plain HTTP error carrying the status -- on the MCP TS SDK
    // v2 an `SdkHttpError` with `status: 401`, whether it answered the default `'auto'` probe or
    // `initialize` itself (the WS-23 block below pins both modes) -- and classifies as needs_auth.
    const authServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("unauthorized", { status: 401 }) });
    try {
      let error: unknown;
      try {
        await connectMcpServer({ name: "s", config: { type: "http", url: `http://127.0.0.1:${authServer.port}/mcp` }, connectTimeoutMs: 2000, elicitationAsk: NO_ELICIT });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(McpConnectError);
      expect((error as McpConnectError).code).toBe("needs_auth");
    } finally {
      authServer.stop(true);
    }
  });

  test("a fully unresponsive http server classifies as timeout, bounded by connectTimeoutMs (not left hanging)", async () => {
    const hungServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) });
    try {
      const started = Date.now();
      let error: unknown;
      try {
        await connectMcpServer({ name: "s", config: { type: "http", url: `http://127.0.0.1:${hungServer.port}/mcp` }, connectTimeoutMs: 150, elicitationAsk: NO_ELICIT });
      } catch (err) {
        error = err;
      }
      expect(Date.now() - started).toBeLessThan(2000);
      expect(error).toBeInstanceOf(McpConnectError);
      expect((error as McpConnectError).code).toBe("timeout");
    } finally {
      hungServer.stop(true);
    }
  });

  test("real stdio connection succeeds end-to-end through connectMcpServer (cross-transport spot check)", async () => {
    const { command, args } = stdioFixtureCommand();
    const client = await connectMcpServer({ name: "stdio-srv", config: { command, args, env: {} }, connectTimeoutMs: 5000, elicitationAsk: NO_ELICIT });
    try {
      const tools = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["boom", "echo", "env_dump"]);
      const result = await client.callTool("echo", { text: "hi" });
      expect(result).toEqual({ content: [{ type: "text", text: "echo:hi" }] });
    } finally {
      await client.close();
    }
  });

  test("real http connection succeeds end-to-end through connectMcpServer (cross-transport spot check)", async () => {
    await withHttpFixture(defaultFixtureSpec(), async (url) => {
      const client = await connectMcpServer({ name: "http-srv", config: { type: "http", url: url.toString() }, connectTimeoutMs: 5000, elicitationAsk: NO_ELICIT });
      try {
        const result = await client.callTool("echo", { text: "hi" });
        expect(result).toEqual({ content: [{ type: "text", text: "echo:hi" }] });
      } finally {
        await client.close();
      }
    });
  });
});

// --- WS-23: the MCP TS SDK v2 port ------------------------------------------------------------------
//
// Every transport end to end through `connectMcpServer` (stdio and Streamable HTTP are spot-checked
// above; SSE and in-memory here), the per-server `versionNegotiation` rulings against a LEGACY
// fixture of each kind and a 2026-07-28-capable one, the 2026-07-28 `input_required` flow reaching
// the SAME asker a legacy `elicitation/create` does, URL-mode elicitation, the tool-list-changed
// signal, and the HTTP 401 -> needs_auth mapping on both HTTP transports under the v2 error classes.

const MODERN = "2026-07-28";
const LEGACY_LATEST = "2025-11-25";

function recordingAsker(answer: ElicitationResultPayload): { ask: (p: ElicitationRequestPayload) => Promise<ElicitationResultPayload>; seen: ElicitationRequestPayload[] } {
  const seen: ElicitationRequestPayload[] = [];
  return {
    seen,
    ask: async (payload) => {
      seen.push(payload);
      return answer;
    },
  };
}

// A tool written ONCE for both eras (the v2 server's own idiom): it asks through `inputRequired`, and
// the SDK serves that as an embedded request on 2026-07-28 or as a real server->client
// `elicitation/create` (its legacy shim) on 2025.
function askingSpec(): FixtureServerSpec {
  return {
    tools: [
      {
        name: "confirm",
        inputSchema: { type: "object", properties: {} },
        handler: (_args, _server, ctx) => {
          const answer = inputResponse(ctx.mcpReq.inputResponses, "go");
          if (answer.kind === "missing") {
            return inputRequired({ inputRequests: { go: inputRequired.elicit({ message: "deploy?", requestedSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } }) } });
          }
          return { content: [{ type: "text", text: `answered:${JSON.stringify(answer)}` }] };
        },
      },
    ],
  };
}

describe("WS-23 (MCP TS SDK v2): transports, version negotiation, input_required, listChanged", () => {
  test("per-transport negotiation defaults: http probes ('auto'); stdio, sse and sdk stay 'legacy'; an explicit setting wins", () => {
    expect(resolveVersionNegotiation({ type: "http", url: "http://x" })).toBe("auto");
    expect(resolveVersionNegotiation({ command: "x" })).toBe("legacy");
    expect(resolveVersionNegotiation({ type: "stdio", command: "x" })).toBe("legacy");
    expect(resolveVersionNegotiation({ type: "sse", url: "http://x" })).toBe("legacy");
    expect(resolveVersionNegotiation({ type: "sdk", name: "x" })).toBe("legacy");
    expect(resolveVersionNegotiation({ type: "http", url: "http://x", versionNegotiation: "legacy" })).toBe("legacy");
    expect(resolveVersionNegotiation({ command: "x", versionNegotiation: "auto" })).toBe("auto");
    expect(resolveVersionNegotiation({ type: "sse", url: "http://x", versionNegotiation: { pin: MODERN } })).toEqual({ pin: MODERN });
  });

  test("SSE end to end through connectMcpServer, against the hand-written legacy SSE fixture", async () => {
    await withSseFixture(defaultFixtureSpec(), async (url) => {
      const client = await connectMcpServer({ name: "sse-srv", config: { type: "sse", url: url.toString() }, connectTimeoutMs: 5000, elicitationAsk: NO_ELICIT });
      try {
        expect(client.protocolVersion).toBe(LEGACY_LATEST);
        expect((await client.listTools()).map((t) => t.name).sort()).toEqual(["boom", "echo"]);
        expect(await client.callTool("echo", { text: "hi" })).toEqual({ content: [{ type: "text", text: "echo:hi" }] });
        expect(await client.readResource("fixture://text.txt")).toEqual([{ uri: "fixture://text.txt", mimeType: "text/plain", text: "hello fixture world" }]);
      } finally {
        await client.close();
      }
    });
  });

  test("'auto' against a LEGACY server settles on 2025-11-25 -- Streamable HTTP (the default) and stdio (opted in), both fixtures", async () => {
    await withHttpFixture(defaultFixtureSpec(), async (url) => {
      const client = await connectMcpServer({ name: "h", config: { type: "http", url: url.toString() }, connectTimeoutMs: 5000, elicitationAsk: NO_ELICIT });
      try {
        expect(client.protocolVersion).toBe(LEGACY_LATEST);
        expect(await client.callTool("echo", { text: "a" })).toEqual({ content: [{ type: "text", text: "echo:a" }] });
      } finally {
        await client.close();
      }
    });
    // Both stdio fixtures: the v2-server one, and the dependency-free one that answers the probe
    // `-32601` the way a pre-2026 SDK server does.
    for (const { command, args } of [stdioFixtureCommand(), pingFixtureCommand({ label: "negotiation" })]) {
      const client = await connectMcpServer({ name: "s", config: { command, args, versionNegotiation: "auto" }, connectTimeoutMs: 5000, elicitationAsk: NO_ELICIT });
      try {
        expect(client.protocolVersion).toBe(LEGACY_LATEST);
        expect((await client.listTools()).length).toBeGreaterThan(0);
      } finally {
        await client.close();
      }
    }
  }, 20_000);

  test("'auto' against a 2026-07-28-capable endpoint selects the modern era; 'legacy' against the SAME endpoint stays on 2025-11-25", async () => {
    await withModernHttpFixture(defaultFixtureSpec(), async (url) => {
      const modern = await connectMcpServer({ name: "m", config: { type: "http", url: url.toString() }, connectTimeoutMs: 5000, elicitationAsk: NO_ELICIT });
      try {
        expect(modern.protocolVersion).toBe(MODERN);
        expect(await modern.callTool("echo", { text: "m" })).toEqual({ content: [{ type: "text", text: "echo:m" }] });
      } finally {
        await modern.close();
      }
      const legacy = await connectMcpServer({ name: "l", config: { type: "http", url: url.toString(), versionNegotiation: "legacy" }, connectTimeoutMs: 5000, elicitationAsk: NO_ELICIT });
      try {
        expect(legacy.protocolVersion).toBe(LEGACY_LATEST);
        expect(await legacy.callTool("echo", { text: "l" })).toEqual({ content: [{ type: "text", text: "echo:l" }] });
      } finally {
        await legacy.close();
      }
    });
  });

  test("a { pin } the server does not offer fails the connect as handshake_failed -- never a silent fallback to the legacy handshake", async () => {
    let error: unknown;
    try {
      await connectMcpServer({ name: "p", config: { ...pingFixtureCommand({ label: "pin" }), versionNegotiation: { pin: MODERN } }, connectTimeoutMs: 5000, elicitationAsk: NO_ELICIT });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(McpConnectError);
    expect((error as McpConnectError).code).toBe("handshake_failed");
  });

  test("input_required (2026-07-28): an embedded elicitation reaches the SAME asker, and the server sees its answer on the retried call", async () => {
    await withModernHttpFixture(askingSpec(), async (url) => {
      const { ask, seen } = recordingAsker({ action: "accept", content: { ok: true } });
      const client = await connectMcpServer({ name: "mrtr", config: { type: "http", url: url.toString() }, connectTimeoutMs: 5000, elicitationAsk: ask });
      try {
        expect(client.protocolVersion).toBe(MODERN);
        const result = await client.callTool("confirm", {});
        expect(result).toEqual({ content: [{ type: "text", text: `answered:${JSON.stringify({ kind: "elicit", action: "accept", content: { ok: true } })}` }] });
        expect(seen).toEqual([{ serverName: "mrtr", message: "deploy?", mode: "form", requestedSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } }]);
      } finally {
        await client.close();
      }
    });
  });

  test("input_required with NO host callback: the deterministic decline reaches a modern server too -- never a hang", async () => {
    await withModernHttpFixture(askingSpec(), async (url) => {
      const client = await connectMcpServer({ name: "mrtr", config: { type: "http", url: url.toString() }, connectTimeoutMs: 5000, elicitationAsk: NO_ELICIT });
      try {
        const result = await client.callTool("confirm", {}, { timeoutMs: 5000 });
        expect(result).toEqual({ content: [{ type: "text", text: `answered:${JSON.stringify({ kind: "elicit", action: "decline" })}` }] });
      } finally {
        await client.close();
      }
    });
  });

  test("URL-mode elicitation reaches the asker with mode, url and elicitationId (the client declares URL support)", async () => {
    const server = createFixtureMcpServer({
      tools: [
        {
          name: "login",
          inputSchema: { type: "object", properties: {} },
          handler: async (_args, srv) => {
            const result = await srv.elicitInput({ mode: "url", message: "sign in", url: "https://auth.example/start", elicitationId: "el-1" });
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
          },
        },
      ],
    });
    const { ask, seen } = recordingAsker({ action: "accept" });
    const client = await connectMcpServer({ name: "urlsrv", config: { type: "sdk", name: "urlsrv" }, connectTimeoutMs: 5000, elicitationAsk: ask, inProcessServer: server });
    try {
      const result = await client.callTool("login", {});
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ action: "accept" });
      expect(seen).toEqual([{ serverName: "urlsrv", message: "sign in", mode: "url", url: "https://auth.example/start", elicitationId: "el-1" }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("accepted content the protocol cannot carry (a nested object) declines deterministically instead of reaching the server", async () => {
    const server = createFixtureMcpServer({
      tools: [
        {
          name: "ask",
          inputSchema: { type: "object", properties: {} },
          handler: async (_args, srv) => ({ content: [{ type: "text", text: JSON.stringify(await srv.elicitInput({ message: "q", requestedSchema: { type: "object", properties: {} } })) }] }),
        },
      ],
    });
    const { ask } = recordingAsker({ action: "accept", content: { nested: { not: "flat" } } });
    const client = await connectMcpServer({ name: "s", config: { type: "sdk", name: "s" }, connectTimeoutMs: 5000, elicitationAsk: ask, inProcessServer: server });
    try {
      const result = await client.callTool("ask", {});
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ action: "decline" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("a server that advertises tools.listChanged: its tool-list-changed notification reaches onToolListChanged -- a signal, never a fetched list", async () => {
    const spec: FixtureServerSpec = { ...defaultFixtureSpec(), toolsListChanged: true };
    const server = createFixtureMcpServer(spec);
    let signals = 0;
    const client = await connectMcpServer({ name: "lc", config: { type: "sdk", name: "lc" }, connectTimeoutMs: 5000, elicitationAsk: NO_ELICIT, inProcessServer: server, onToolListChanged: () => void signals++ });
    try {
      await server.sendToolListChanged();
      for (let i = 0; i < 100 && signals === 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(signals).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("the same signal on a 2026-07-28 connection, delivered over the auto-opened subscriptions/listen stream", async () => {
    const spec: FixtureServerSpec = { ...defaultFixtureSpec(), toolsListChanged: true };
    await withModernHttpFixture(spec, async (url, notify) => {
      let signals = 0;
      const client = await connectMcpServer({ name: "lc", config: { type: "http", url: url.toString() }, connectTimeoutMs: 5000, elicitationAsk: NO_ELICIT, onToolListChanged: () => void signals++ });
      try {
        expect(client.protocolVersion).toBe(MODERN);
        // The listen stream is opened just after connect; announce until it is up (bounded). Each
        // wait outlasts the client's 300 ms debounce, or a steady stream of announcements would keep
        // resetting it and the signal would never fire at all.
        for (let i = 0; i < 8 && signals === 0; i++) {
          notify.toolsChanged();
          await new Promise((r) => setTimeout(r, 450));
        }
        expect(signals).toBe(1);
      } finally {
        await client.close();
      }
    });
  });

  test("HTTP 401 -> needs_auth under the v2 error classes: Streamable HTTP on BOTH negotiation modes (probe and initialize), and legacy SSE", async () => {
    const authServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("unauthorized", { status: 401 }) });
    try {
      for (const versionNegotiation of ["auto", "legacy"] as const) {
        let error: unknown;
        try {
          await connectMcpServer({ name: "s", config: { type: "http", url: `http://127.0.0.1:${authServer.port}/mcp`, versionNegotiation }, connectTimeoutMs: 2000, elicitationAsk: NO_ELICIT });
        } catch (err) {
          error = err;
        }
        expect([versionNegotiation, error instanceof McpConnectError ? error.code : String(error)]).toEqual([versionNegotiation, "needs_auth"]);
        expect((error as McpConnectError).httpStatus).toBe(401);
      }
      let sseError: unknown;
      try {
        await connectMcpServer({ name: "s", config: { type: "sse", url: `http://127.0.0.1:${authServer.port}/sse` }, connectTimeoutMs: 2000, elicitationAsk: NO_ELICIT });
      } catch (err) {
        sseError = err;
      }
      expect(sseError).toBeInstanceOf(McpConnectError);
      expect((sseError as McpConnectError).code).toBe("needs_auth");
    } finally {
      authServer.stop(true);
    }
  });

  test("a non-401 HTTP failure keeps its status on httpStatus (handshake_failed) -- what a direct caller like the search backend reads", async () => {
    const limited = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("", { status: 429 }) });
    try {
      let error: unknown;
      try {
        await connectMcpServer({ name: "s", config: { type: "http", url: `http://127.0.0.1:${limited.port}/mcp`, versionNegotiation: "legacy" }, connectTimeoutMs: 2000, elicitationAsk: NO_ELICIT });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(McpConnectError);
      expect((error as McpConnectError).code).toBe("handshake_failed");
      expect((error as McpConnectError).httpStatus).toBe(429);
    } finally {
      limited.stop(true);
    }
  });
});
