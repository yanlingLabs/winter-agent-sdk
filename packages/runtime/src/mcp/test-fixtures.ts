// TEST-ONLY fixture helpers shared across this lane's mcp/**.test.ts files. Never imported by
// production code (nothing under mcp/{client,lifecycle,control,elicitation,output-cap,transports}.ts
// imports this file). Zod-free by design, matching elicitation.test.ts's own established
// convention: every fixture server is built on the low-level `Server` class with hand-written JSON
// schemas -- `zod` is a peer dependency of @modelcontextprotocol/sdk itself, never a declared
// dependency of packages/runtime (verified against package.json before this lane's own tests were
// written), so relying on it resolving via incidental hoisting would be an undeclared dependency.
import { createServer as createNodeHttpServer, type Server as NodeHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// `content` is typed as an array of loosely-shaped text blocks (never bare `unknown[]`) -- the real
// SDK's own `CallToolRequestSchema` handler return type is checked against its own big `ServerResult`
// union, and a too-wide `unknown[]` content array made `tsc` report an unrelated, misleading
// "missing 'task' field" error against a completely different (experimental tasks) union member
// rather than the real CallToolResult shape (found while writing this file's own tests).
export interface FixtureContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}
export interface FixtureToolResult {
  content: FixtureContentBlock[];
  isError?: boolean;
}
export interface FixtureTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  handler: (args: Record<string, unknown>, server: Server) => Promise<FixtureToolResult> | FixtureToolResult;
}
export interface FixtureResourceBody {
  text?: string;
  blobBase64?: string;
  mimeType?: string;
}
export interface FixtureResource {
  uri: string;
  name?: string;
  mimeType?: string;
  description?: string;
  read: () => FixtureResourceBody;
}
export interface FixtureServerSpec {
  name?: string;
  tools?: FixtureTool[];
  resources?: FixtureResource[];
}

// A fixed, small "echo" + "boom" + one text + one blob resource default -- most tests only need
// SOMETHING real to connect to and call; scenario-specific fixtures override tools/resources.
export function defaultFixtureSpec(): FixtureServerSpec {
  return {
    tools: [
      { name: "echo", description: "echoes text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, handler: (args) => ({ content: [{ type: "text", text: `echo:${String(args.text)}` }] }) },
      { name: "boom", description: "always fails", inputSchema: { type: "object", properties: {} }, handler: () => ({ content: [{ type: "text", text: "boom" }], isError: true }) },
    ],
    resources: [
      { uri: "fixture://text.txt", name: "text.txt", mimeType: "text/plain", read: () => ({ text: "hello fixture world" }) },
      { uri: "fixture://blob.bin", name: "blob.bin", mimeType: "application/octet-stream", read: () => ({ blobBase64: Buffer.from([1, 2, 3, 4]).toString("base64") }) },
    ],
  };
}

export function createFixtureMcpServer(spec: FixtureServerSpec): Server {
  const server = new Server({ name: spec.name ?? "fixture", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });
  const tools = spec.tools ?? [];
  const resources = spec.resources ?? [];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
      ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
      ...(t._meta !== undefined ? { _meta: t._meta } : {}),
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) throw new Error(`fixture: unknown tool "${req.params.name}"`);
    const result = await tool.handler((req.params.arguments ?? {}) as Record<string, unknown>, server);
    // Explicit `CallToolResult` return annotation (not just `FixtureToolResult`): `tsc` otherwise
    // widens the handler's inferred return type against `Server`'s own big `ServerResult` union
    // (this class also supports the experimental "tasks" call-now/fetch-later pattern) and reports a
    // misleading "missing 'task' field" error against an unrelated union member instead of the real
    // `CallToolResult` shape -- found while writing this file's own tests.
    return result as CallToolResult;
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: resources.map((r) => ({
      uri: r.uri,
      name: r.name ?? r.uri,
      ...(r.mimeType !== undefined ? { mimeType: r.mimeType } : {}),
      ...(r.description !== undefined ? { description: r.description } : {}),
    })),
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const resource = resources.find((r) => r.uri === req.params.uri);
    if (!resource) throw new Error(`fixture: unknown resource "${req.params.uri}"`);
    const body = resource.read();
    const mimeType = body.mimeType ?? resource.mimeType;
    if (body.blobBase64 !== undefined) {
      return { contents: [{ uri: req.params.uri, ...(mimeType !== undefined ? { mimeType } : {}), blob: body.blobBase64 }] };
    }
    return { contents: [{ uri: req.params.uri, ...(mimeType !== undefined ? { mimeType } : {}), text: body.text ?? "" }] };
  });
  return server;
}

// --- In-process ("sdk" transport) fixture -----------------------------------------------------

export async function withInMemoryFixture<T>(spec: FixtureServerSpec, fn: (clientTransport: Transport, server: Server) => Promise<T>): Promise<T> {
  const server = createFixtureMcpServer(spec);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  try {
    return await fn(clientTransport, server);
  } finally {
    await server.close();
  }
}

// --- HTTP (Streamable HTTP over Bun.serve) fixture ----------------------------------------------

export async function withHttpFixture<T>(spec: FixtureServerSpec, fn: (url: URL) => Promise<T>): Promise<T> {
  const server = createFixtureMcpServer(spec);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await server.connect(transport);
  // Stateful mode (a real sessionIdGenerator) is required: a stateless transport
  // (sessionIdGenerator: undefined) throws "Stateless transport cannot be reused across requests"
  // on a SECOND request over the same transport instance -- verified empirically before writing
  // this file; every one of this lane's own tests issues more than one request per connection
  // (at minimum: initialize, then a real call).
  const bunServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => transport.handleRequest(req) });
  try {
    return await fn(new URL(`http://127.0.0.1:${bunServer.port}/mcp`));
  } finally {
    bunServer.stop(true);
    await server.close();
  }
}

// --- SSE fixture -----------------------------------------------------------------------------
//
// The real SDK's server-side `SSEServerTransport` requires Node's `IncomingMessage`/`ServerResponse`
// (verified against the pinned 1.30.0 declaration) -- there is no web-standard variant, unlike the
// Streamable HTTP transport above. `node:http.createServer(...).listen(0)` (fully supported under
// Bun, and itself backed by Bun's own HTTP engine) is the pragmatic reading of this lane's own
// brief text ("loopback HTTP/SSE fixtures via Bun.serve"): SSE's real server transport cannot be
// mounted on `Bun.serve`'s Web-standard fetch handler at all, so this is the closest faithful
// equivalent -- still an in-process, loopback, Bun-runtime fixture server, disclosed here as a
// deliberate, reasoned deviation from the literal function name.
export async function withSseFixture<T>(spec: FixtureServerSpec, fn: (url: URL) => Promise<T>): Promise<T> {
  const server = createFixtureMcpServer(spec);
  let sseTransport: SSEServerTransport | undefined;
  const httpServer: NodeHttpServer = createNodeHttpServer((req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/sse") {
        sseTransport = new SSEServerTransport("/messages", res);
        await server.connect(sseTransport);
        return;
      }
      if (req.method === "POST" && req.url?.startsWith("/messages")) {
        if (!sseTransport) {
          res.writeHead(400).end("no session");
          return;
        }
        await sseTransport.handlePostMessage(req, res);
        return;
      }
      res.writeHead(404).end();
    })();
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    return await fn(new URL(`http://127.0.0.1:${port}/sse`));
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await server.close();
  }
}

// --- stdio fixture -----------------------------------------------------------------------------
//
// A spawned process can't receive a JS closure, so the stdio fixture server (a SEPARATE file,
// __fixtures__/stdio-server.ts) is a small, FIXED script -- not a spec builder like the three
// helpers above. It registers the exact same "echo"/"boom" tools and text/blob resources
// `defaultFixtureSpec()` describes, so a test exercising the stdio path can assert the identical
// expectations as the in-memory/http/sse paths.
export function stdioFixtureCommand(): { command: string; args: string[] } {
  // process.execPath: the currently-running bun binary's own absolute path -- resolves with NO
  // PATH lookup, which matters because WS-09 §1.2's own env-allowlist discipline means the spawned
  // child's env is `{}` (or whatever explicit allowlist a test passes), never inheriting this
  // process's own PATH. Verified empirically before writing this file (a bare "bun" command string
  // fails to resolve under an empty env; process.execPath does not).
  //
  // fileURLToPath, NOT `new URL(...).pathname`: this repository's own working-copy path contains a
  // literal space ("Xcode progects") -- `URL.pathname` percent-encodes it to a literal "%20"
  // substring, which is not a valid filesystem path and made the spawned child fail to find its own
  // script (found empirically: this exact bug, once, while writing this file's own test).
  return { command: process.execPath, args: [fileURLToPath(new URL("./transports/__fixtures__/stdio-server.ts", import.meta.url))] };
}

// --- Fake McpLifecycle / ConnectedMcpClient (for the bridge tools' own tests) -------------------
//
// The four WS-09 §1.4 bridge tools (tools/impl/{list-mcp-resources-tool,read-mcp-resource-tool,
// read-mcp-resource-dir-tool,refresh-mcp-tools}.ts) each depend on an INJECTED
// `(ctx) => McpLifecycle | undefined` resolver (see list-mcp-resources-tool.ts's own header). Their
// own tests care about input validation, per-server error shaping, and wiring -- NOT about real
// connection lifecycle mechanics (already covered end to end by lifecycle.test.ts/control.test.ts)
// -- so a lightweight fake satisfying the full `McpLifecycle` interface is the right fixture here,
// not another real fixture-server dance.
import type { McpLifecycle, RefreshServerToolsResult } from "./lifecycle.ts";
import type { ConnectedMcpClient, McpResourceContent, McpResourceInfo, McpToolCallResult, McpToolInfo } from "./client.ts";

export interface FakeConnectedMcpClientOverrides {
  listTools?: () => Promise<McpToolInfo[]>;
  listResources?: () => Promise<McpResourceInfo[]>;
  readResource?: (uri: string, opts?: { timeoutMs?: number }) => Promise<McpResourceContent[]>;
  callTool?: (name: string, args: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<McpToolCallResult>;
  close?: () => Promise<void>;
}

export function createFakeConnectedMcpClient(serverName: string, overrides: FakeConnectedMcpClientOverrides = {}): ConnectedMcpClient {
  return {
    serverName,
    listTools: overrides.listTools ?? (async () => []),
    listResources: overrides.listResources ?? (async () => []),
    readResource: overrides.readResource ?? (async () => []),
    callTool: overrides.callTool ?? (async () => ({ content: [] })),
    close: overrides.close ?? (async () => {}),
  };
}

export interface FakeMcpLifecycleOverrides {
  connectedServers?: Readonly<Record<string, ConnectedMcpClient>>;
  refreshServerTools?: (server: string) => Promise<RefreshServerToolsResult>;
}

export function createFakeMcpLifecycle(overrides: FakeMcpLifecycleOverrides = {}): McpLifecycle {
  const connected = overrides.connectedServers ?? {};
  return {
    // Never exercised by any bridge-tool test (they only ever reach listConnectedServerNames/
    // getConnectedClient/refreshServerTools) -- present only to satisfy the full interface honestly.
    stateSource: { snapshot: () => [], subscribe: () => () => {}, waitForPending: async () => [] },
    controlSeam: {
      reconnect: async () => {},
      toggle: async () => {},
      setServers: async () => ({ added: [], removed: [], errors: {} }),
    },
    start: async () => {},
    dispose: async () => {},
    listConnectedServerNames: () => Object.keys(connected),
    getConnectedClient: (name: string) => connected[name],
    refreshServerTools: overrides.refreshServerTools ?? (async (name: string) => ({ ok: false, reason: `unknown MCP server "${name}"` })),
  };
}
