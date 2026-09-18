// TEST-ONLY: a loopback stand-in for the hosted search MCP server. Never imported by production code.
//
// WHY `withHttpFixture` IS NOT ENOUGH ON ITS OWN. It mounts ONE stateful transport and hands every
// request straight to it, so it can serve exactly one MCP session and cannot answer differently by
// HEADER. The behaviour under test is the opposite on both counts: the anonymous tier and the keyed
// tier are two separate MCP sessions to one endpoint, and what tells them apart is `x-api-key`. This
// fixture keeps `createFixtureMcpServer` (the shared, zod-free server builder) and adds the two
// things that one lacks: a transport PER SESSION, and an HTTP gate in front of them.
import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createFixtureMcpServer, type FixtureToolResult } from "../../mcp/test-fixtures.ts";

export interface ExaFixtureCall {
  tool: string;
  args: Record<string, unknown>;
  /** Which tier made the call, read off the HTTP request that carried it. */
  apiKey: string | null;
}

export interface ExaFixtureHttpRequest {
  method: string;
  search: string;
  apiKey: string | null;
  sessionId: string | null;
}

export interface ExaFixtureOptions {
  /** Answer for a tool call. Default: a two-result advanced-shaped JSON payload / basic-shaped text payload. */
  respond?: (call: ExaFixtureCall) => FixtureToolResult | Promise<FixtureToolResult>;
  /** Return a Response to short-circuit the HTTP request BEFORE it reaches MCP (a 429, a 401, a hang). */
  gate?: (request: ExaFixtureHttpRequest) => Response | undefined | Promise<Response | undefined>;
}

export interface ExaFixture {
  endpoint: string;
  calls: ExaFixtureCall[];
  requests: ExaFixtureHttpRequest[];
  /** Forgets every live MCP session, so the next request on one gets the transport's own 404 -- a dropped session. */
  dropSessions(): void;
}

/** The measured advanced-tool payload shape: one text block holding a JSON string. */
export function advancedPayload(results: Array<{ title?: string; url: string; highlights?: string[]; text?: string }>): FixtureToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ requestId: "fixture", resolvedSearchType: "", results: results.map((r) => ({ id: r.url, publishedDate: "2026-09-05T05:39:32.000Z", image: "https://img.example/x.png", ...r })), searchTime: 12 }) }] };
}

/** The measured basic-tool payload shape: `Title:`/`URL:`/... records separated by a `---` line. */
export function basicPayload(results: Array<{ title: string; url: string; highlights: string }>): FixtureToolResult {
  return { content: [{ type: "text", text: results.map((r) => `Title: ${r.title}\nURL: ${r.url}\nPublished: N/A\nAuthor: N/A\nHighlights:\n${r.highlights}`).join("\n\n---\n\n") }] };
}

const DEFAULT_RESULTS = [
  { title: "Bun v1.4.2 | Bun Blog", url: "https://bun.com/blog/bun-v1.4.2", highlights: ["This release fixes two regressions."] },
  { title: "Releases · oven-sh/bun", url: "https://github.com/oven-sh/bun/releases", highlights: ["Release list"] },
];

export async function withExaFixture<T>(options: ExaFixtureOptions, fn: (fixture: ExaFixture) => Promise<T>): Promise<T> {
  const calls: ExaFixtureCall[] = [];
  const requests: ExaFixtureHttpRequest[] = [];
  const sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; close(): Promise<void> }>();
  // The HTTP request a tool call arrived on is not visible from inside an MCP handler, so the key is
  // pinned per SESSION at `initialize` -- which is also how the real server scopes it.
  const open = async (apiKey: string | null): Promise<WebStandardStreamableHTTPServerTransport> => {
    const tool = (name: string) => ({
      name,
      inputSchema: { type: "object", properties: {} },
      handler: async (args: Record<string, unknown>): Promise<FixtureToolResult> => {
        const call: ExaFixtureCall = { tool: name, args, apiKey };
        calls.push(call);
        if (options.respond !== undefined) return options.respond(call);
        return name === "web_search_exa" ? basicPayload(DEFAULT_RESULTS.map((r) => ({ title: r.title, url: r.url, highlights: r.highlights.join("\n...\n") }))) : advancedPayload(DEFAULT_RESULTS);
      },
    });
    const server = createFixtureMcpServer({ name: "exa-fixture", tools: [tool("web_search_exa"), tool("web_search_advanced_exa")] });
    const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => void sessions.set(id, { transport, close: () => server.close() }),
    });
    await server.connect(transport);
    return transport;
  };

  const bunServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    // A tool call may be held open by a test (the timeout and abort cases); never let Bun's own idle
    // timer be the thing that ends it.
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const record: ExaFixtureHttpRequest = { method: req.method, search: url.search, apiKey: req.headers.get("x-api-key"), sessionId: req.headers.get("mcp-session-id") };
      requests.push(record);
      const gated = await options.gate?.(record);
      if (gated !== undefined) return gated;
      if (record.sessionId !== null) {
        const session = sessions.get(record.sessionId);
        if (session === undefined) return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }), { status: 404, headers: { "content-type": "application/json" } });
        return session.transport.handleRequest(req);
      }
      return (await open(record.apiKey)).handleRequest(req);
    },
  });
  try {
    return await fn({
      endpoint: `http://127.0.0.1:${bunServer.port}/mcp`,
      calls,
      requests,
      dropSessions: () => sessions.clear(),
    });
  } finally {
    bunServer.stop(true);
    await Promise.all([...sessions.values()].map((s) => s.close().catch(() => {})));
  }
}

/** The anonymous tier's rate-limit answer, as an HTTP-level 429. */
export function tooManyRequests(): Response {
  return new Response(JSON.stringify({ error: "Rate limit exceeded for the free tier. Add an API key for higher limits." }), { status: 429, headers: { "content-type": "application/json" } });
}
