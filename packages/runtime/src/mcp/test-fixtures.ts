// TEST-ONLY fixture helpers shared across this lane's mcp/**.test.ts files. Never imported by
// production code (nothing under mcp/{client,lifecycle,control,elicitation,output-cap,transports}.ts
// imports this file). Zod-free by design, matching elicitation.test.ts's own established
// convention: every fixture server is built on the low-level `Server` class with hand-written JSON
// schemas -- the high-level `McpServer.registerTool` wants a real zod schema, and zod is not a
// declared dependency of packages/runtime (it arrives only as the MCP SDK's own dependency).
//
// WS-23 (MCP TS SDK v2): the servers come from `@modelcontextprotocol/server` 2.1.0, a DEV
// dependency of this package (the runtime itself ships only the client). v2's low-level `Server` is
// marked `@deprecated` in favour of `McpServer`, but it is still exported and still the zod-free way
// to hand-write a server; handlers are keyed by METHOD STRING (v1 keyed them by request schema).
// Two more v2 facts shape this file:
//   - A server hand-connected with `server.connect(transport)` serves the 2025 (legacy) era ONLY,
//     whatever `supportedProtocolVersions` says -- the 2026-07-28 era is reachable only through the
//     SDK's per-connection serving entries (`serveStdio`, `createMcpHandler`), because the era is
//     decided per connection before a server instance exists. `withModernInMemoryFixture` below is
//     that entry, over an in-memory pipe.
//   - v2 ships NO SSE server transport at all (the client side survives, deprecated), so
//     `withSseFixture` is a small hand-written wire-level SSE server instead of the SDK's.
import { createServer as createNodeHttpServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { InMemoryTransport, type CallToolResult, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/client";
import { Server, WebStandardStreamableHTTPServerTransport, createMcpHandler, type InputRequiredResult, type ServerContext } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

// `content` is typed as an array of loosely-shaped text blocks (never bare `unknown[]`) -- the real
// SDK's own `tools/call` handler return type is checked against its own big result union, and a
// too-wide `unknown[]` content array made `tsc` report a misleading error against an unrelated
// union member rather than the real CallToolResult shape (found while writing this file's own tests).
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
  /**
   * `ctx` is the v2 request context: a 2026-07-28 multi-round-trip handler reads the client's
   * answers off `ctx.mcpReq.inputResponses` and returns `inputRequired(...)` to ask for more (on a
   * 2025-era connection the SDK's legacy shim turns that same return into a real server->client
   * `elicitation/create`, so one handler serves both eras).
   */
  handler: (args: Record<string, unknown>, server: Server, ctx: ServerContext) => Promise<FixtureToolResult | InputRequiredResult> | FixtureToolResult | InputRequiredResult;
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
  /** Read at REQUEST time, not captured at construction: a test may replace it and then announce the change. */
  tools?: FixtureTool[];
  resources?: FixtureResource[];
  /** WS-23: advertise `tools.listChanged`, so a client wires its list-changed handler. */
  toolsListChanged?: boolean;
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
  const server = new Server({ name: spec.name ?? "fixture", version: "1.0.0" }, { capabilities: { tools: spec.toolsListChanged === true ? { listChanged: true } : {}, resources: {} } });
  const toolsNow = (): FixtureTool[] => spec.tools ?? [];
  const resourcesNow = (): FixtureResource[] => spec.resources ?? [];

  server.setRequestHandler("tools/list", async () => ({
    tools: toolsNow().map((t) => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as { type: "object"; [key: string]: unknown },
      ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
      ...(t._meta !== undefined ? { _meta: t._meta } : {}),
    })),
  }));
  server.setRequestHandler("tools/call", async (req, ctx) => {
    const tool = toolsNow().find((t) => t.name === req.params.name);
    if (!tool) throw new Error(`fixture: unknown tool "${req.params.name}"`);
    const result = await tool.handler((req.params.arguments ?? {}) as Record<string, unknown>, server, ctx);
    // Cast at the one boundary: `FixtureToolResult`'s loose content blocks are a structural subset
    // of the SDK's `CallToolResult`, and an `InputRequiredResult` is the v2 multi-round-trip return.
    return result as CallToolResult | InputRequiredResult;
  });
  server.setRequestHandler("resources/list", async () => ({
    resources: resourcesNow().map((r) => ({
      uri: r.uri,
      name: r.name ?? r.uri,
      ...(r.mimeType !== undefined ? { mimeType: r.mimeType } : {}),
      ...(r.description !== undefined ? { description: r.description } : {}),
    })),
  }));
  server.setRequestHandler("resources/read", async (req) => {
    const resource = resourcesNow().find((r) => r.uri === req.params.uri);
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

// --- A 2026-07-28-capable server over an in-memory pipe (WS-23) --------------------------------
//
// `serveStdio` with a caller-supplied transport is the SDK's own per-connection serving entry: the
// opening exchange (a `server/discover` probe, or a plain `initialize`) decides the era, and ONE
// server instance from the factory is pinned for the connection. So this ONE fixture answers both
// an `'auto'`/pinned client (modern) and a `'legacy'` client (2025), from the same tool spec --
// which is exactly the pair a negotiation test needs. `servers` lists every instance the factory
// built (a probe may build one of its own), so a test can announce a change on whichever is live.
export async function withModernInMemoryFixture<T>(spec: FixtureServerSpec, fn: (clientTransport: Transport, servers: Server[]) => Promise<T>): Promise<T> {
  const servers: Server[] = [];
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(
    () => {
      const server = createFixtureMcpServer(spec);
      servers.push(server);
      return server;
    },
    { transport: serverTransport },
  );
  try {
    return await fn(clientTransport, servers);
  } finally {
    await handle.close().catch(() => {});
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

// --- A 2026-07-28-capable Streamable HTTP endpoint (WS-23) --------------------------------------
//
// `createMcpHandler` is the SDK's HTTP serving entry: a request carrying the 2026-07-28 `_meta`
// envelope (every `'auto'`/pinned client's probe and every request after it) is served modern, from
// a fresh per-request instance; anything else falls back to STATELESS 2025 serving from the same
// factory. So this ONE endpoint answers an `'auto'` client on 2026-07-28 and a `'legacy'` client on
// 2025-11-25. `notify` is the handler's own change-event facade (`toolsChanged()` et al.), which a
// modern client's auto-opened `subscriptions/listen` stream receives.
export async function withModernHttpFixture<T>(spec: FixtureServerSpec, fn: (url: URL, notify: { toolsChanged(): void }) => Promise<T>): Promise<T> {
  const handler = createMcpHandler(() => createFixtureMcpServer(spec));
  const bunServer = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: (req) => handler.fetch(req) });
  try {
    return await fn(new URL(`http://127.0.0.1:${bunServer.port}/mcp`), { toolsChanged: () => void handler.notify.toolsChanged() });
  } finally {
    await handler.close().catch(() => {});
    bunServer.stop(true);
  }
}

// --- SSE fixture (hand-written: v2 has no SSE server transport) --------------------------------
//
// The legacy (2024-11-05) HTTP+SSE binding, at the wire level, which is all a client ever sees:
//   GET  /sse       -> a `text/event-stream` whose FIRST event is `event: endpoint` naming the POST
//                      URL (same origin, carrying the session id); every server->client JSON-RPC
//                      message after that is a default (`message`) event whose data is the JSON.
//   POST /messages  -> one client->server JSON-RPC message; answered `202 Accepted` with no body.
// That is the whole contract v1's `SSEServerTransport` implemented (it was a thin wrapper over a
// Node `ServerResponse`), so replacing it with this ~50-line `Transport` keeps the SSE CLIENT under
// test against the same bytes. `node:http` rather than `Bun.serve`, as before: an SSE response is a
// long-lived write stream, which a Node `ServerResponse` models directly.
class FixtureSseServerTransport implements Transport {
  readonly sessionId = randomUUID();
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: (<M extends JSONRPCMessage>(message: M) => void) | undefined;
  private closed = false;

  constructor(
    private readonly endpointPath: string,
    private readonly res: ServerResponse,
  ) {}

  async start(): Promise<void> {
    this.res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    this.res.write(`event: endpoint\ndata: ${this.endpointPath}?sessionId=${this.sessionId}\n\n`);
    this.res.on("close", () => void this.close());
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error("fixture sse transport: closed");
    this.res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.res.end();
    this.onclose?.();
  }

  deliver(message: JSONRPCMessage): void {
    this.onmessage?.(message);
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function withSseFixture<T>(spec: FixtureServerSpec, fn: (url: URL) => Promise<T>): Promise<T> {
  const server = createFixtureMcpServer(spec);
  let sseTransport: FixtureSseServerTransport | undefined;
  const httpServer: NodeHttpServer = createNodeHttpServer((req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/sse") {
        sseTransport = new FixtureSseServerTransport("/messages", res);
        await server.connect(sseTransport);
        return;
      }
      if (req.method === "POST" && req.url?.startsWith("/messages")) {
        const sessionId = new URL(req.url, "http://fixture").searchParams.get("sessionId");
        if (!sseTransport || sessionId !== sseTransport.sessionId) {
          res.writeHead(400).end("no such session");
          return;
        }
        let message: JSONRPCMessage;
        try {
          message = JSON.parse(await readBody(req)) as JSONRPCMessage;
        } catch {
          res.writeHead(400).end("invalid JSON");
          return;
        }
        res.writeHead(202).end("Accepted");
        sseTransport.deliver(message);
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
    await server.close();
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
}

// --- stdio fixture -----------------------------------------------------------------------------
//
// A spawned process can't receive a JS closure, so the stdio fixture server (a SEPARATE file,
// __fixtures__/stdio-server.ts) is a small, FIXED script -- not a spec builder like the three
// helpers above. It registers the same "echo"/"boom" tools and text/blob resources
// `defaultFixtureSpec()` describes (plus, as of fix round 1, its own "env_dump" tool with no
// in-memory/http/sse equivalent -- see that file's own header), so a test exercising the stdio path
// can assert the identical echo/boom/resource expectations as the in-memory/http/sse paths.
export function stdioFixtureCommand(): { command: string; args: string[] } {
  // process.execPath: the currently-running bun binary's own absolute path. Fix round 1 correction
  // (MAJOR M1's own report Deviations entry): this is NOT here to work around an empty-env PATH
  // failure -- `WinterStdioTransport`'s own env allowlist (transports/stdio.ts's
  // `STDIO_BASE_ENV_NAMES`) always carries PATH through from this process's own env when present,
  // so a bare "bun" command string would in fact resolve correctly via that inherited PATH under
  // the CURRENT transport too. `process.execPath` is used regardless, for a reason that has nothing
  // to do with env content: it is an absolute path requiring no PATH lookup or shell resolution at
  // all, and it is correct by construction whatever runtime this test suite itself happens to be
  // running under (bun today; nothing here assumes a literal "bun" name is on any PATH, allowlisted
  // or otherwise).
  //
  // fileURLToPath, NOT `new URL(...).pathname`: a working-copy checked out under a directory name
  // that contains a literal space (e.g. "My Projects") -- `URL.pathname` percent-encodes it to a
  // literal "%20" substring, which is not a valid filesystem path and made the spawned child fail
  // to find its own
  // script (found empirically: this exact bug, once, while writing this file's own test).
  return { command: process.execPath, args: [fileURLToPath(new URL("./transports/__fixtures__/stdio-server.ts", import.meta.url))] };
}

// Fix round 19: the one-tool `gate_ping` stdio server (transports/__fixtures__/ping-server.mjs), for
// the live advertised-set and first-turn-wait tests. `delayMs` postpones its handshake (a slow starter).
// Launched under `node` when one is on PATH (an absolute path, so no lookup happens in the spawned env)
// -- the router's same-view row does the same after measuring bun-launched fixture servers at 2.5-4.5 s
// to start, too slow for the first-turn-wait case -- and under the running bun otherwise. Fix round 20:
// the fixture is plain `.mjs`, so any node runs it (the release runner's Node 18 cannot strip types).
export function pingFixtureCommand(opts: { label?: string; delayMs?: number } = {}): { command: string; args: string[] } {
  const args = [fileURLToPath(new URL("./transports/__fixtures__/ping-server.mjs", import.meta.url))];
  if (opts.label !== undefined) args.push("--label", opts.label);
  if (opts.delayMs !== undefined) args.push("--delay-ms", String(opts.delayMs));
  return { command: Bun.which("node") ?? process.execPath, args };
}

// Fix round 1 (MAJOR M1): a command that never speaks MCP at all -- `/bin/sh -c "sleep 3600 & wait"`
// forks a genuine GRANDCHILD (the backgrounded `sleep`) under a `sh` parent that then blocks on
// `wait`, rather than exec-optimizing into a single process the way a bare `sh -c "sleep 3600"`
// would (verified empirically: without the `&`+`wait`, there is only ever one process to find,
// which would make a "does the GRANDCHILD also die" test vacuous). Used only by
// transports/stdio.test.ts's own process-group-kill tests, which talk to the spawned
// `WinterStdioTransport` directly (no `Client`/handshake involved) and confirm group death via
// `pgrep -P`/`process.kill(pid, 0)`, not via any MCP-level exchange.
export function grandchildSpawningCommand(): { command: string; args: string[] } {
  return { command: "/bin/sh", args: ["-c", "sleep 3600 & wait"] };
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
