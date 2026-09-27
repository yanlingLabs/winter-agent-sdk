import { describe, test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import {
  createElicitationAsker,
  installElicitationHandler,
  buildElicitationPayload,
  MCP_ELICITATION_SUBTYPE,
  type ElicitationSender,
  type ElicitationRequestPayload,
  type ElicitationResultPayload,
} from "./elicitation.ts";
import type { ControlRequestFrame, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createRpcBridge } from "../rpc/bridge.ts";
import { connectMcpServer } from "./client.ts";
import { createFixtureMcpServer } from "./test-fixtures.ts";

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

// End-to-end against a REAL MCP Client/Server pair (the v2 `@modelcontextprotocol/client` and
// `@modelcontextprotocol/server` packages, WS-23) over InMemoryTransport --
// proves installElicitationHandler's own wiring (capability declaration requirement, handler
// registration, request/response shape) against the actual protocol, not just the pure functions
// above in isolation.
describe("installElicitationHandler: end-to-end over a real MCP Client/Server pair", () => {
  // Low-level `Server` (never the zod-shaped `McpServer.registerTool` convenience wrapper, and
  // never a `zod` import) -- `zod` is a dependency of the MCP SDK packages themselves, not a
  // declared dependency of packages/runtime (verified against package.json before writing this
  // file); relying on it resolving via incidental hoisting would be an undeclared dependency this
  // lane's own protocol treats as NEEDS_CONTEXT. The low-level Server also better represents a real,
  // arbitrary external MCP server, which this client-side code must handle regardless of what
  // authored it.
  async function connectedPair(ask: (payload: import("./elicitation.ts").ElicitationRequestPayload) => Promise<ElicitationResultPayload>) {
    const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", async () => ({
      tools: [{ name: "ask_and_report", description: "elicits then reports", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }],
    }));
    server.setRequestHandler("tools/call", async (req) => {
      const args = req.params.arguments as { q: string };
      const result = await server.elicitInput({
        message: `please answer: ${args.q}`,
        requestedSchema: { type: "object", properties: { answer: { type: "string" } } },
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    // capabilities.elicitation MUST be declared or setRequestHandler("elicitation/create") throws
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
      const result = await client.callTool({ name: "ask_and_report", arguments: { q: "the ultimate question" } }, { timeout: 5000 });
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
      const result = await client.callTool({ name: "ask_and_report", arguments: { q: "anything" } }, { timeout: 5000 });
      const content = (result as { content: Array<{ type: string; text: string }> }).content;
      expect(JSON.parse(content[0]!.text)).toEqual({ action: "decline" });
    } finally {
      await close();
    }
  });
});

// WS-27: an elicitation that stops mattering is CANCELLED all the way to the host. Before, the asker passed
// no signal to the bridge and the handler ignored the MCP request's own cancellation, so a server that gave
// up on its question -- or a tool call interrupted mid-question -- left the host's prompt up until the
// host's own timeout.
describe("WS-27: elicitation cancellation reaches the host and a late answer is dropped", () => {
  function recordingBridge() {
    const frames: WinterFrame[] = [];
    const bridge = createRpcBridge({ write: (f) => void frames.push(f), end() {} });
    return { frames, bridge };
  }
  const requestFrame = (frames: WinterFrame[]) => frames.find((f) => f.type === "control_request" && (f as ControlRequestFrame).subtype === MCP_ELICITATION_SUBTYPE) as ControlRequestFrame | undefined;

  test("an abort while the host is asking: control_cancel_request for that request, the server gets `cancel`, and the host's late answer is dropped", async () => {
    const { frames, bridge } = recordingBridge();
    const ask = createElicitationAsker(bridge);
    const ac = new AbortController();
    const answer = ask({ serverName: "s", message: "q?" }, { signal: ac.signal });
    const req = requestFrame(frames)!;
    expect(req).toBeDefined();
    ac.abort();
    expect(await answer).toEqual({ action: "cancel" });
    expect(frames).toContainEqual({ type: "control_cancel_request", requestId: req.requestId });
    // The host answers anyway: an unknown request id now, dropped without effect.
    expect(bridge.handleResponse({ type: "control_response", requestId: req.requestId, ok: true, payload: { action: "accept", content: { a: "late" } } })).toBe(false);
  });

  test("an already-aborted signal asks nothing at all and answers `cancel`", async () => {
    const { frames, bridge } = recordingBridge();
    const ac = new AbortController();
    ac.abort();
    expect(await createElicitationAsker(bridge)({ serverName: "s", message: "q?" }, { signal: ac.signal })).toEqual({ action: "cancel" });
    expect(frames).toEqual([]);
  });

  test("the SERVER cancels its elicitation/create (notifications/cancelled): the asker's signal aborts while the call is still open", async () => {
    let asked!: () => void;
    const askedP = new Promise<void>((r) => (asked = r));
    // Review I-3: the call stays OPEN after the server gives up on its question (a latch the test releases),
    // so an abort seen here can only be the MCP request's own cancellation -- never the call ending.
    let releaseCall!: () => void;
    const callLatch = new Promise<void>((r) => (releaseCall = r));
    let signalAborted = false;
    const server = createFixtureMcpServer({
      tools: [
        {
          name: "ask_then_give_up",
          inputSchema: { type: "object", properties: {} },
          handler: async (_args, srv) => {
            const giveUp = new AbortController();
            void askedP.then(() => giveUp.abort());
            const outcome = await srv.elicitInput({ message: "still there?", requestedSchema: { type: "object", properties: {} } }, { signal: giveUp.signal }).then(
              () => "answered",
              () => "gave up",
            );
            await callLatch;
            return { content: [{ type: "text", text: outcome }] };
          },
        },
      ],
    });
    const ask = (_p: ElicitationRequestPayload, opts?: { signal?: AbortSignal }): Promise<ElicitationResultPayload> =>
      new Promise((resolve) => {
        asked();
        opts?.signal?.addEventListener("abort", () => {
          signalAborted = true;
          resolve({ action: "cancel" });
        });
      });
    const client = await connectMcpServer({ cwd: process.cwd(), name: "s", config: { type: "sdk", name: "s" }, connectTimeoutMs: 5000, elicitationAsk: ask, inProcessServer: server });
    try {
      let callSettled = false;
      const call = client.callTool("ask_then_give_up", {}).finally(() => (callSettled = true));
      for (let i = 0; i < 100 && !signalAborted; i++) await Bun.sleep(10);
      expect(signalAborted).toBe(true);
      expect(callSettled).toBe(false);
      releaseCall();
      expect(((await call).content[0] as { text: string }).text).toBe("gave up");
    } finally {
      releaseCall();
      await client.close();
      await server.close();
    }
  });

  test("the TOOL CALL that raised it is aborted (a turn interrupt): the asker's signal aborts and the call rejects", async () => {
    let asked!: () => void;
    const askedP = new Promise<void>((r) => (asked = r));
    let signalAborted = false;
    // A server that never cancels its own question: only the call's abort can take the prompt down.
    const server = createFixtureMcpServer({
      tools: [
        {
          name: "ask",
          inputSchema: { type: "object", properties: {} },
          handler: async (_args, srv) => ({ content: [{ type: "text", text: JSON.stringify(await srv.elicitInput({ message: "q", requestedSchema: { type: "object", properties: {} } })) }] }),
        },
      ],
    });
    const ask = (_p: ElicitationRequestPayload, opts?: { signal?: AbortSignal }): Promise<ElicitationResultPayload> =>
      new Promise((resolve) => {
        asked();
        opts?.signal?.addEventListener("abort", () => {
          signalAborted = true;
          resolve({ action: "cancel" });
        });
      });
    const client = await connectMcpServer({ cwd: process.cwd(), name: "s", config: { type: "sdk", name: "s" }, connectTimeoutMs: 5000, elicitationAsk: ask, inProcessServer: server });
    try {
      const interrupt = new AbortController();
      const call = client.callTool("ask", {}, { signal: interrupt.signal }).then(
        () => "resolved",
        () => "rejected",
      );
      await askedP;
      interrupt.abort();
      expect(await call).toBe("rejected");
      // The scope aborts once the call has settled.
      for (let i = 0; i < 50 && !signalAborted; i++) await Bun.sleep(10);
      expect(signalAborted).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("an elicitation answered normally is never cancelled by its call ending afterwards", async () => {
    let seenSignal: AbortSignal | undefined;
    const server = createFixtureMcpServer({
      tools: [
        {
          name: "ask",
          inputSchema: { type: "object", properties: {} },
          handler: async (_args, srv) => ({ content: [{ type: "text", text: JSON.stringify(await srv.elicitInput({ message: "q", requestedSchema: { type: "object", properties: { a: { type: "string" } } } })) }] }),
        },
      ],
    });
    const ask = async (_p: ElicitationRequestPayload, opts?: { signal?: AbortSignal }): Promise<ElicitationResultPayload> => {
      seenSignal = opts?.signal;
      return { action: "accept", content: { a: "yes" } };
    };
    const client = await connectMcpServer({ cwd: process.cwd(), name: "s", config: { type: "sdk", name: "s" }, connectTimeoutMs: 5000, elicitationAsk: ask, inProcessServer: server });
    try {
      const result = await client.callTool("ask", {});
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ action: "accept", content: { a: "yes" } });
      expect(seenSignal).toBeDefined();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
