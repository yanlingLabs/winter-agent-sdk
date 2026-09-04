import { describe, test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createElicitationAsker,
  installElicitationHandler,
  buildElicitationPayload,
  MCP_ELICITATION_SUBTYPE,
  type ElicitationSender,
  type ElicitationResultPayload,
} from "./elicitation.ts";

// A properly GENERIC fake -- `ElicitationSender.request` mirrors `RpcBridge.request`'s own
// `<T = unknown>(...) => Promise<T>` shape (elicitation.ts's own header explains why); an arrow
// function assigned directly to that property can't honestly satisfy an unconstrained generic
// return type, so every fake resolves with a fixed value cast to the caller's own `T` -- the exact,
// unavoidable pattern the real `RpcBridge` implementation itself uses at its own promise boundary
// (rpc/bridge.ts: `resolve as (payload: unknown) => void`).
function fakeSender(resolve: () => unknown, calls?: Array<{ subtype: string; payload: unknown }>): ElicitationSender {
  return {
    async request<T = unknown>(subtype: string, payload: unknown): Promise<T> {
      calls?.push({ subtype, payload });
      return resolve() as T;
    },
  };
}
function rejectingSender(err: unknown): ElicitationSender {
  return {
    async request<T = unknown>(): Promise<T> {
      throw err;
    },
  };
}

describe("createElicitationAsker: deterministic decline without a callback (WS-09 §5)", () => {
  test("no sender at all -> declines with no round trip attempted", async () => {
    const ask = createElicitationAsker(undefined);
    const result = await ask({ serverName: "gh", message: "need input" });
    expect(result).toEqual({ action: "decline" });
  });

  test("sender rejects (unhandled_subtype / handler_threw / any failure) -> declines, never throws", async () => {
    const ask = createElicitationAsker(rejectingSender(new Error("unhandled_subtype")));
    await expect(ask({ serverName: "gh", message: "x" })).resolves.toEqual({ action: "decline" });
  });

  test("sender resolves with a well-formed accept -> forwarded, including content", async () => {
    const ask = createElicitationAsker(fakeSender(() => ({ action: "accept", content: { answer: "42" } })));
    const result = await ask({ serverName: "gh", message: "x" });
    expect(result).toEqual({ action: "accept", content: { answer: "42" } });
  });

  test("sender resolves with accept but no content -> content omitted, never fabricated as {}", async () => {
    const ask = createElicitationAsker(fakeSender(() => ({ action: "accept" })));
    const result = await ask({ serverName: "gh", message: "x" });
    expect(result).toEqual({ action: "accept" });
    expect("content" in result).toBe(false);
  });

  test("sender resolves with decline/cancel -> forwarded verbatim", async () => {
    await expect(createElicitationAsker(fakeSender(() => ({ action: "decline" })))({ serverName: "gh", message: "x" })).resolves.toEqual({
      action: "decline",
    });
    await expect(createElicitationAsker(fakeSender(() => ({ action: "cancel" })))({ serverName: "gh", message: "x" })).resolves.toEqual({
      action: "cancel",
    });
  });

  test("sender resolves with a malformed action -> declines rather than fabricating or forwarding garbage", async () => {
    const ask = createElicitationAsker(fakeSender(() => ({ action: "yes-please" })));
    await expect(ask({ serverName: "gh", message: "x" })).resolves.toEqual({ action: "decline" });
  });

  test("sender resolves with null/non-object -> declines", async () => {
    await expect(createElicitationAsker(fakeSender(() => null))({ serverName: "gh", message: "x" })).resolves.toEqual({ action: "decline" });
    await expect(createElicitationAsker(fakeSender(() => "not an object"))({ serverName: "gh", message: "x" })).resolves.toEqual({ action: "decline" });
  });

  test("calls sender.request with the MCP_ELICITATION_SUBTYPE constant and the exact payload", async () => {
    const calls: Array<{ subtype: string; payload: unknown }> = [];
    const sender = fakeSender((): ElicitationResultPayload => ({ action: "decline" }), calls);
    const payload = { serverName: "gh", message: "need input", elicitationId: "e1" };
    await createElicitationAsker(sender)(payload);
    expect(calls).toEqual([{ subtype: MCP_ELICITATION_SUBTYPE, payload }]);
    expect(MCP_ELICITATION_SUBTYPE).toBe("mcp_elicitation");
  });
});

describe("buildElicitationPayload: translates the real MCP request shape, omitting absent fields", () => {
  test("form mode: message + requestedSchema, no url/elicitationId", () => {
    const payload = buildElicitationPayload("gh", { message: "hi", requestedSchema: { type: "object", properties: {} } });
    expect(payload).toEqual({ serverName: "gh", message: "hi", requestedSchema: { type: "object", properties: {} } });
    expect("url" in payload).toBe(false);
    expect("elicitationId" in payload).toBe(false);
  });

  test("url mode: message + url + elicitationId + mode, no requestedSchema", () => {
    const payload = buildElicitationPayload("gh", { message: "hi", mode: "url", url: "https://example.com", elicitationId: "e1" });
    expect(payload).toEqual({ serverName: "gh", message: "hi", mode: "url", url: "https://example.com", elicitationId: "e1" });
    expect("requestedSchema" in payload).toBe(false);
  });

  test("never populates title/displayName/description -- no upstream source for them exists here", () => {
    const payload = buildElicitationPayload("gh", { message: "hi" });
    expect("title" in payload).toBe(false);
    expect("displayName" in payload).toBe(false);
    expect("description" in payload).toBe(false);
  });
});

// End-to-end against a REAL @modelcontextprotocol/sdk Client/Server pair over InMemoryTransport --
// proves installElicitationHandler's own wiring (capability declaration requirement, handler
// registration, request/response shape) against the actual protocol, not just the pure functions
// above in isolation.
describe("installElicitationHandler: end-to-end over a real MCP Client/Server pair", () => {
  // Low-level `Server` (never the zod-shaped `McpServer.registerTool` convenience wrapper, and
  // never a `zod` import) -- `zod` is a peer dependency of @modelcontextprotocol/sdk itself, not a
  // declared dependency of packages/runtime (verified against package.json before writing this
  // file); relying on it resolving via incidental hoisting would be an undeclared dependency this
  // lane's own protocol treats as NEEDS_CONTEXT. The low-level Server also better represents a real,
  // arbitrary external MCP server, which this client-side code must handle regardless of what
  // authored it.
  async function connectedPair(ask: (payload: import("./elicitation.ts").ElicitationRequestPayload) => Promise<ElicitationResultPayload>) {
    const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "ask_and_report", description: "elicits then reports", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const args = req.params.arguments as { q: string };
      const result = await server.elicitInput({
        message: `please answer: ${args.q}`,
        requestedSchema: { type: "object", properties: { answer: { type: "string" } } },
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    // capabilities.elicitation MUST be declared or setRequestHandler(ElicitRequestSchema) throws
    // synchronously (verified empirically -- see elicitation.ts's own header comment).
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: { elicitation: {} } });
    installElicitationHandler(client, "fixture", ask);
    await Promise.all([client.connect(clientTransport, { timeout: 5000 }), server.connect(serverTransport)]);
    return {
      client,
      server,
      async close() {
        await client.close();
        await server.close();
      },
    };
  }

  test("a real elicitation/create request round-trips through installElicitationHandler and an accepting asker", async () => {
    let seenPayload: unknown;
    const ask = async (payload: import("./elicitation.ts").ElicitationRequestPayload): Promise<ElicitationResultPayload> => {
      seenPayload = payload;
      return { action: "accept", content: { answer: "42" } };
    };
    const { client, close } = await connectedPair(ask);
    try {
      const result = await client.callTool({ name: "ask_and_report", arguments: { q: "the ultimate question" } }, undefined, { timeout: 5000 });
      const content = (result as { content: Array<{ type: string; text: string }> }).content;
      expect(JSON.parse(content[0]!.text)).toEqual({ action: "accept", content: { answer: "42" } });
      expect(seenPayload).toMatchObject({
        serverName: "fixture",
        message: "please answer: the ultimate question",
        requestedSchema: { type: "object", properties: { answer: { type: "string" } } },
      });
    } finally {
      await close();
    }
  });

  test("declining asker (e.g. no callback configured) is a well-formed MCP decline, never a hang or a protocol error", async () => {
    const ask = createElicitationAsker(undefined);
    const { client, close } = await connectedPair(ask);
    try {
      const result = await client.callTool({ name: "ask_and_report", arguments: { q: "anything" } }, undefined, { timeout: 5000 });
      const content = (result as { content: Array<{ type: string; text: string }> }).content;
      expect(JSON.parse(content[0]!.text)).toEqual({ action: "decline" });
    } finally {
      await close();
    }
  });
});
