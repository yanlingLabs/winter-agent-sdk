import { describe, test, expect } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  connectMcpServer,
  McpConnectError,
  type ConnectedMcpClient,
} from "./client.ts";
import { createElicitationAsker, type ElicitationSender, type ElicitationResultPayload } from "./elicitation.ts";
import { createFixtureMcpServer, defaultFixtureSpec, withHttpFixture, stdioFixtureCommand, type FixtureServerSpec } from "./test-fixtures.ts";

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
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: toolName, inputSchema: { type: "object", properties: {} } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));
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
    // Verified against the real SDK's own source before writing this test:
    // StreamableHTTPClientTransport throws UnauthorizedError('No auth provider') the moment a
    // request comes back 401 and no authProvider was configured -- this connector never configures
    // one (WS-09 doesn't ask Lane A to implement an OAuth flow), so any 401-gated server lands here.
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
      expect(tools.map((t) => t.name).sort()).toEqual(["boom", "echo"]);
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
