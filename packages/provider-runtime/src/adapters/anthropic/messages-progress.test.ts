// 0.0.47: Claude's `display: "updates"` and the adapter's live `reasoning_progress` events, on the WIRE.
//
// A loopback server this file owns answers with the Messages SSE shapes the thinking page documents
// (https://platform.claude.com/docs/en/build-with-claude/thinking#progress-updates, read 2026-10-05),
// against the compiled catalog's own Claude rows -- so the rows' evidence is what decides the request.
// The cross-family fold proofs (every block ended, no opaque material) live in provider-conformance's
// `reasoning-progress.test.ts`; this file owns what only the Anthropic adapter decides.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { serve } from "bun";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { THINKING_DISPLAY_UPDATES_BETA, buildRequestBody, createAnthropicMessagesAdapter, findDescriptor, thinkingDisplayUpdatesBetaFor, thinkingProgressMode } from "./messages.ts";
import { createMemoryCredentialStore } from "../../credentials/memory.ts";
import type { ProviderContext, ProviderEvent, TurnRequest } from "../../types.ts";

interface Server {
  url: string;
  requests: Array<{ path: string; headers: Record<string, string>; body: Record<string, unknown> }>;
  stop(): Promise<void>;
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

// HERMETIC: nothing in this file may leave loopback.
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (target.hostname !== "127.0.0.1" && target.hostname !== "localhost") throw new Error(`hermetic test file: refused a request to ${target.origin}`);
    return await realFetch(input, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

function start(body: string): Server {
  const requests: Server["requests"] = [];
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k.toLowerCase()] = k.toLowerCase() === "x-api-key" ? "<redacted>" : v));
      const text = await req.text();
      const path = new URL(req.url).pathname;
      requests.push({ path, headers, body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {} });
      if (path.endsWith("/count_tokens")) return Response.json({ input_tokens: 42 });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  const s = { url: `http://127.0.0.1:${server.port}`, requests, stop: async () => void (await server.stop(true)) };
  servers.push(s);
  return s;
}

const frame = (event: string, payload: unknown): string => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
const messageStart = frame("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], usage: { input_tokens: 5, output_tokens: 1 } } });
/** A thinking block as the stream carries it: an empty-thinking start, its `thinking_delta`s, ONE `signature_delta`, the stop. */
const thinkingBlock = (index: number, chunks: string[], signature: string): string =>
  frame("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } }) +
  chunks.map((thinking) => frame("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking } })).join("") +
  frame("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature } }) +
  frame("content_block_stop", { type: "content_block_stop", index });
const toolUse = (index: number): string =>
  frame("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: "toolu_1", name: "edit_file", input: {} } }) +
  frame("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: "{}" } }) +
  frame("content_block_stop", { type: "content_block_stop", index });
const ending = frame("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } }) + frame("message_stop", { type: "message_stop" });

function ctx(url: string): ProviderContext {
  return {
    connection: { providerId: "anthropic", baseUrl: url, local: true },
    credentials: createMemoryCredentialStore(),
    authRef: { kind: "inline", value: "fixture" },
    stallTimeoutMs: 2_000,
    log: () => {},
  };
}

const catalog = loadCatalog();
const adapter = () => createAnthropicMessagesAdapter({ catalog, retry: { maxRetries: 0, random: () => 0, sleep: async () => {} } });
const request = (model: string, over: Partial<TurnRequest> = {}): TurnRequest => ({ model, messages: [{ role: "user", content: "hi" }], ...over });
const thinkingOf = (model: string, over: Partial<TurnRequest> = {}, providerId = "anthropic") =>
  buildRequestBody(request(model, over), findDescriptor(catalog, providerId, model), {})["thinking"] as Record<string, unknown> | undefined;

async function collect(url: string, req: TurnRequest): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const e of adapter().streamTurn(req, ctx(url))) events.push(e);
  return events;
}

const progressOf = (events: ProviderEvent[]) => events.filter((e): e is Extract<ProviderEvent, { type: "reasoning_progress" }> => e.type === "reasoning_progress");

describe('`display: "updates"` on the rows that write progress updates', () => {
  // The docs' list: Fable 5.1, Mythos 5.1, Opus 5.5, Sonnet 5.5 and Fable 5. The catalog carries no
  // Mythos row; each of the other four exists on both the API-key and the Console provider.
  const updatesRows = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5"];

  test("an asked-for summary is requested as `updates` on those rows, on both providers -- and `summarized` on the Claude 5 rows without updates", () => {
    for (const providerId of ["anthropic", "console"]) {
      for (const model of updatesRows) expect([providerId, model, thinkingOf(model, { requestSummary: true }, providerId)?.["display"]]).toEqual([providerId, model, "updates"]);
      // These two are not always-on: thinking rides only when asked for, and then with `summarized`.
      for (const model of ["claude-opus-5", "claude-sonnet-5"]) expect([providerId, model, thinkingOf(model, { requestSummary: true, thinking: { type: "adaptive" } }, providerId)?.["display"]]).toEqual([providerId, model, "summarized"]);
    }
  });

  test("nothing is asked for when no summary is asked for -- the row keeps its own default", () => {
    for (const model of updatesRows) expect([model, thinkingOf(model)?.["display"]]).toEqual([model, undefined]);
  });

  test("the beta header and the value are ONE decision: present exactly when the body says `updates`, on the turn AND the token count", async () => {
    const s = start(messageStart + ending);
    await collect(s.url, request("claude-opus-5-5", { requestSummary: true }));
    await collect(s.url, request("claude-sonnet-5", { requestSummary: true, thinking: { type: "adaptive" } }));
    await collect(s.url, request("claude-opus-5-5"));
    await adapter().countTokens!(request("claude-opus-5-5", { requestSummary: true }), ctx(s.url));
    const betas = s.requests.map((r) => (r.headers["anthropic-beta"] ?? "").split(",").filter((b) => b.length > 0));
    const display = s.requests.map((r) => (r.body["thinking"] as { display?: unknown } | undefined)?.display);
    expect(display).toEqual(["updates", "summarized", undefined, "updates"]);
    expect(betas.map((b) => b.includes(THINKING_DISPLAY_UPDATES_BETA))).toEqual([true, false, false, true]);
    expect(s.requests[3]!.path).toBe("/v1/messages/count_tokens");
  });

  test("`thinkingDisplayUpdatesBetaFor` reads the body alone", () => {
    expect(thinkingDisplayUpdatesBetaFor({ thinking: { type: "adaptive", display: "updates" } })).toBe(THINKING_DISPLAY_UPDATES_BETA);
    expect(thinkingDisplayUpdatesBetaFor({ thinking: { type: "adaptive", display: "summarized" } })).toBeUndefined();
    expect(thinkingDisplayUpdatesBetaFor({})).toBeUndefined();
  });
});

describe("the live reasoning stream: what each thinking block is", () => {
  test("under `updates`, the empty reasoning block stays hidden and the progress-update block is an `update` -- signatures never ride", async () => {
    // The docs' own trace: after a tool result, a reasoning block (empty under updates) and then a
    // progress-update block whose text introduces the tool call.
    const s = start(
      messageStart +
        thinkingBlock(0, [""], "SIG-REASONING-DO-NOT-LEAK") +
        thinkingBlock(1, ["Confirmed the retry path never refreshes the expired token. ", "Editing auth.py to add the refresh call."], "SIG-UPDATE-DO-NOT-LEAK") +
        toolUse(2) +
        ending,
    );
    const events = await collect(s.url, request("claude-opus-5-5", { requestSummary: true }));
    expect(progressOf(events)).toEqual([
      { type: "reasoning_progress", block: "block:0", phase: "start", kind: "hidden" },
      { type: "reasoning_progress", block: "block:0", phase: "end", kind: "hidden" },
      { type: "reasoning_progress", block: "block:1", phase: "start", kind: "hidden" },
      { type: "reasoning_progress", block: "block:1", phase: "delta", kind: "update", text: "Confirmed the retry path never refreshes the expired token. " },
      { type: "reasoning_progress", block: "block:1", phase: "delta", kind: "update", text: "Editing auth.py to add the refresh call." },
      { type: "reasoning_progress", block: "block:1", phase: "end", kind: "hidden" },
    ]);
    expect(JSON.stringify(progressOf(events))).not.toContain("DO-NOT-LEAK");
    // Each block's live end comes BEFORE its complete, signed replay block, and the call after both.
    const types = events.map((e) => (e.type === "reasoning_progress" ? `${e.type}:${e.phase}` : e.type));
    expect(types.indexOf("native_thinking_block")).toBe(types.indexOf("reasoning_progress:end") + 1);
    expect(types.indexOf("tool_call_start")).toBeGreaterThan(types.lastIndexOf("native_thinking_block"));
  });

  test("under `summarized`, a block opens hidden and is a `summary` from its first text -- an EMPTY block stays hidden", async () => {
    // An empty progress-update block can come back under any display; it must not read as a summary.
    const s = start(messageStart + thinkingBlock(0, ["Weighing two fixes."], "SIG-1") + thinkingBlock(1, [""], "SIG-2") + toolUse(2) + ending);
    const events = await collect(s.url, request("claude-sonnet-5", { requestSummary: true, thinking: { type: "adaptive" } }));
    expect(s.requests[0]!.body["thinking"]).toMatchObject({ display: "summarized" });
    expect(progressOf(events).map((e) => [e.block, e.phase, e.kind])).toEqual([
      ["block:0", "start", "hidden"],
      ["block:0", "delta", "summary"],
      ["block:0", "end", "hidden"],
      ["block:1", "start", "hidden"],
      ["block:1", "end", "hidden"],
    ]);
  });

  test("the mode is read off the body's own `thinking` object -- Sonnet 5.5's `between_tools` included, whose notes come back as text", () => {
    expect(thinkingProgressMode({ thinking: { type: "adaptive", display: "summarized" } })).toBe("summary");
    expect(thinkingProgressMode({ thinking: { type: "adaptive", display: "updates" } })).toBe("updates");
    expect(thinkingProgressMode({ thinking: { type: "between_tools" } })).toBe("updates");
    expect(thinkingProgressMode({ thinking: { type: "adaptive", display: "omitted" } })).toBe("summary");
    expect(thinkingProgressMode({})).toBe("summary");
  });
});
