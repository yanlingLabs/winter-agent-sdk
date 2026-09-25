// WS-23: the Anthropic adapter's code-mode hardening, on the WIRE -- a loopback server this file owns
// answers with real Messages SSE shapes, and each case asserts on the events the adapter yielded and
// the requests the server received. Scoped to what the other two test homes cannot see: the pure half
// (`messages.test.ts`) has no stream, and the conformance corpus is the frozen WS-13 case list.
//
// Hermetic: 127.0.0.1:0 only, an inline `fixture` key, and the compiled catalog's own Claude rows.
import { afterEach, describe, expect, test } from "bun:test";
import { serve } from "bun";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { ANTHROPIC_ROW_DEFAULT_MAX_TOKENS, INTERLEAVED_THINKING_BETA, buildRequestBody, createAnthropicMessagesAdapter, findDescriptor } from "./messages.ts";
import { createMemoryCredentialStore } from "../../credentials/memory.ts";
import type { ProviderContext, ProviderEvent, TurnRequest } from "../../types.ts";

type Answer = { status: number; body: string; contentType?: string };

interface Server {
  url: string;
  requests: Array<{ headers: Record<string, string>; body: Record<string, unknown> }>;
  stop(): Promise<void>;
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

function start(answer: (index: number) => Answer): Server {
  const requests: Server["requests"] = [];
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k.toLowerCase()] = k.toLowerCase() === "x-api-key" || k.toLowerCase() === "authorization" ? "<redacted>" : v));
      const text = await req.text();
      requests.push({ headers, body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {} });
      const a = answer(requests.length - 1);
      return new Response(a.body, { status: a.status, headers: { "content-type": a.contentType ?? "text/event-stream" } });
    },
  });
  const s = { url: `http://127.0.0.1:${server.port}`, requests, stop: async () => void (await server.stop(true)) };
  servers.push(s);
  return s;
}

const frame = (event: string, payload: unknown): string => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
const messageStart = frame("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], usage: { input_tokens: 5, output_tokens: 1 } } });
const textBlock = (index: number, text: string): string =>
  frame("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }) +
  frame("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } }) +
  frame("content_block_stop", { type: "content_block_stop", index });
const ending = (stopReason: string, extra: Record<string, unknown> = {}): string =>
  frame("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null, ...extra }, usage: { output_tokens: 3 } }) + frame("message_stop", { type: "message_stop" });

const sse = (body: string): Answer => ({ status: 200, body });

function ctx(url: string): ProviderContext {
  return {
    connection: { providerId: "anthropic", baseUrl: url, local: true },
    credentials: createMemoryCredentialStore(),
    authRef: { kind: "inline", value: "fixture" },
    stallTimeoutMs: 2_000,
    log: () => {},
  };
}

const adapter = () => createAnthropicMessagesAdapter({ catalog: loadCatalog(), retry: { maxRetries: 3, random: () => 0, sleep: async () => {} } });

async function collect(url: string, req: Partial<TurnRequest> = {}): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const e of adapter().streamTurn({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }], ...req }, ctx(url))) events.push(e);
  return events;
}

const done = (events: ProviderEvent[]) => events.find((e) => e.type === "done") as Extract<ProviderEvent, { type: "done" }> | undefined;
const error = (events: ProviderEvent[]) => events.find((e) => e.type === "error") as Extract<ProviderEvent, { type: "error" }> | undefined;

describe("WS-23 item 2: stop reasons that are not an end of turn", () => {
  test("`pause_turn` and `model_context_window_exceeded` reach the seam as themselves, never as `end_turn`", async () => {
    for (const reason of ["pause_turn", "model_context_window_exceeded"] as const) {
      const s = start(() => sse(messageStart + textBlock(0, "partial") + ending(reason)));
      expect(done(await collect(s.url))?.stopReason).toBe(reason);
    }
  });

  test("`stop_sequence` and an unknown reason still read as an ordinary end of turn", async () => {
    const s = start((i) => sse(messageStart + textBlock(0, "x") + ending(i === 0 ? "stop_sequence" : "some_future_reason")));
    expect(done(await collect(s.url))?.stopReason).toBe("end_turn");
    expect(done(await collect(s.url))?.stopReason).toBe("end_turn");
  });

  test("a refusal carries its `stop_details` (category + explanation) on `done`; a null category stays null", async () => {
    const s = start((i) =>
      sse(messageStart + ending("refusal", { stop_details: i === 0 ? { type: "refusal", category: "cyber", explanation: "declined: cyber" } : { type: "refusal", category: null, explanation: null } })),
    );
    expect(done(await collect(s.url))).toEqual({ type: "done", stopReason: "refusal", stopDetails: { category: "cyber", explanation: "declined: cyber" } });
    expect(done(await collect(s.url))).toEqual({ type: "done", stopReason: "refusal", stopDetails: { category: null, explanation: null } });
  });

  test("`stop_details` on a NON-refusal is not forwarded (the vendor documents it null there)", async () => {
    const s = start(() => sse(messageStart + textBlock(0, "ok") + ending("end_turn", { stop_details: { type: "refusal", category: "bio", explanation: "x" } })));
    expect(done(await collect(s.url))).toEqual({ type: "done", stopReason: "end_turn" });
  });
});

describe("WS-23 item 2: the context-overflow 400 is typed at the adapter", () => {
  test("`prompt is too long` -> an error event flagged `contextOverflow`, never retried (a 400 is not transient)", async () => {
    const s = start(() => ({ status: 400, contentType: "application/json", body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 1000123 tokens > 1000000 maximum" } }) }));
    const events = await collect(s.url);
    expect(error(events)?.error).toMatchObject({ code: "bad_request", status: 400, providerCode: "invalid_request_error", retryable: false, contextOverflow: true });
    expect(s.requests).toHaveLength(1);
  });

  test("any OTHER 400 carries no overflow flag", async () => {
    const s = start(() => ({ status: 400, contentType: "application/json", body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages.0.content: text content blocks must be non-empty" } }) }));
    const failure = error(await collect(s.url))?.error;
    expect(failure?.code).toBe("bad_request");
    expect("contextOverflow" in (failure ?? {})).toBe(false);
  });
});

describe("WS-23 item 3: `max_tokens` defaults to 64K capped at the row, never the row's full 128K", () => {
  const catalog = loadCatalog();
  const row = (model: string) => findDescriptor(catalog, "anthropic", model)!;
  const body = (model: string, over: Partial<TurnRequest> = {}, opts: Parameters<typeof buildRequestBody>[2] = {}) =>
    buildRequestBody({ model, messages: [{ role: "user", content: "hi" }], ...over }, row(model), opts);

  test("a 128K row (Opus 5.5, Sonnet 5) is sent 64000 when the request names nothing", () => {
    expect(row("claude-opus-5-5").maxOutputTokens?.value).toBe(128_000);
    expect(body("claude-opus-5-5")["max_tokens"]).toBe(ANTHROPIC_ROW_DEFAULT_MAX_TOKENS);
    expect(body("claude-sonnet-5", { effort: "max" })["max_tokens"]).toBe(64_000);
  });

  test("a row whose maximum is BELOW the default is capped at its own maximum (Haiku 4.5: 64000)", () => {
    expect(body("claude-haiku-4.5")["max_tokens"]).toBe(64_000);
  });

  test("an explicit request wins outright, up to the row's maximum; above it is still a typed refusal", () => {
    expect(body("claude-opus-5-5", { maxOutputTokens: 128_000 })["max_tokens"]).toBe(128_000);
    expect(body("claude-opus-5-5", { maxOutputTokens: 1_000 })["max_tokens"]).toBe(1_000);
    expect(() => body("claude-opus-5-5", { maxOutputTokens: 200_000 })).toThrow(/exceeds model "anthropic\/claude-opus-5-5"'s declared maximum of 128000/);
  });

  test("a host default replaces 64K and is still capped at the row", () => {
    expect(body("claude-opus-5-5", {}, { defaultMaxOutputTokens: 32_000 })["max_tokens"]).toBe(32_000);
    expect(body("claude-haiku-4.5", {}, { defaultMaxOutputTokens: 100_000 })["max_tokens"]).toBe(64_000);
  });

  test("an `enabled` budget that would not fit the default GROWS it (capped at the row); only a row that cannot hold the budget refuses", () => {
    // Sonnet 4.6 still takes a manual budget; 70000 does not fit 64K, and the row's 128K can hold it.
    expect(body("claude-sonnet-4.6", { thinking: { type: "enabled", budgetTokens: 70_000 } })["max_tokens"]).toBe(70_000 + 4_096);
    // Opus 4.5's row maximum is 64000: a 64000 budget has no room left for an answer -> typed refusal.
    expect(() => body("claude-opus-4.5", { thinking: { type: "enabled", budgetTokens: 64_000 } })).toThrow(/does not fit inside max_tokens 64000/);
  });

  test("a row that declares NO maximum keeps the conservative 4096 fallback (it may be a sibling with a smaller window)", () => {
    expect(buildRequestBody({ model: "claude-unlisted", messages: [{ role: "user", content: "hi" }] }, undefined, {})["max_tokens"]).toBe(4_096);
  });
});

describe("WS-23 item 4: a mid-stream `overloaded_error` BEFORE any content retries under the adapter's own policy", () => {
  const overloadedFrame = frame("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });

  test("after `message_start` (+ ping), before any block: replayed -- one retry event, then the real stream; nothing from the failed attempt leaks", async () => {
    const s = start((i) => sse(i === 0 ? messageStart + frame("ping", { type: "ping" }) + overloadedFrame : messageStart + textBlock(0, "second try") + ending("end_turn")));
    const events = await collect(s.url);
    expect(s.requests).toHaveLength(2);
    const retries = events.filter((e) => e.type === "retry");
    expect(retries).toEqual([{ type: "retry", attempt: 1, maxRetries: 3, retryDelayMs: 0, error: "overloaded" }]);
    // Exactly ONE message_start reached the consumer -- the committed attempt's.
    expect(events.filter((e) => e.type === "message_start")).toHaveLength(1);
    expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text)).toEqual(["second try"]);
    expect(done(events)?.stopReason).toBe("end_turn");
    // Retry events precede every stream event.
    expect(events[0]!.type).toBe("retry");
  });

  test("bounded: an endpoint that stays overloaded exhausts the budget and fails TYPED -- retryable, so the engine's fallback may engage", async () => {
    const s = start(() => sse(messageStart + overloadedFrame));
    const events = await collect(s.url);
    expect(s.requests).toHaveLength(4); // 1 + maxRetries (3)
    expect(events.filter((e) => e.type === "retry")).toHaveLength(3);
    expect(error(events)?.error).toMatchObject({ code: "server", providerCode: "overloaded_error", retryable: true });
    expect(events.some((e) => e.type === "message_start" || e.type === "text_delta")).toBe(false);
  });

  test("AFTER content was streamed the same frame is final: one request, a typed non-retryable error, no replay", async () => {
    const s = start(() => sse(messageStart + textBlock(0, "half an answer") + overloadedFrame));
    const events = await collect(s.url);
    expect(s.requests).toHaveLength(1);
    expect(events.some((e) => e.type === "retry")).toBe(false);
    expect(error(events)?.error).toMatchObject({ code: "server", providerCode: "overloaded_error", retryable: false });
  });

  test("any OTHER pre-content error frame is not replayed (only the documented transient state is)", async () => {
    const s = start(() => sse(messageStart + frame("error", { type: "error", error: { type: "api_error", message: "internal" } })));
    const events = await collect(s.url);
    expect(s.requests).toHaveLength(1);
    expect(error(events)?.error).toMatchObject({ code: "server", providerCode: "api_error", retryable: false });
  });
});

describe("WS-23 item 5: the interleaved-thinking beta on the budget-only 4.5 rows, with tools", () => {
  const TOOLS: TurnRequest["tools"] = [{ name: "Glob", description: "find files", inputSchema: { type: "object", properties: {} } }];
  const betasOf = async (req: Partial<TurnRequest>, over: Partial<ProviderContext> = {}): Promise<string[]> => {
    const s = start(() => sse(messageStart + textBlock(0, "ok") + ending("end_turn")));
    const events: ProviderEvent[] = [];
    for await (const e of adapter().streamTurn({ model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }], ...req }, { ...ctx(s.url), ...over })) events.push(e);
    expect(done(events)).toBeDefined();
    return (s.requests[0]!.headers["anthropic-beta"] ?? "").split(",").filter((b) => b.length > 0);
  };

  for (const model of ["claude-opus-4.5", "claude-sonnet-4.5"]) {
    test(`${model}: a budget + tools -> the beta rides the request`, async () => {
      expect(await betasOf({ model, thinking: { type: "enabled", budgetTokens: 4_096 }, tools: TOOLS })).toContain(INTERLEAVED_THINKING_BETA);
    });
  }

  test("Haiku 4.5: the catalog declares NO reasoning for its rows, so a thinking request is refused before the wire and the beta never arises (a catalog-evidence gap, not an adapter rule)", async () => {
    const s = start(() => sse(messageStart + ending("end_turn")));
    const events: ProviderEvent[] = [];
    for await (const e of adapter().streamTurn({ model: "claude-haiku-4.5", messages: [{ role: "user", content: "hi" }], thinking: { type: "enabled", budgetTokens: 4_096 }, tools: TOOLS }, ctx(s.url))) events.push(e);
    expect(error(events)?.error.message).toMatch(/does not declare reasoning support/);
    expect(s.requests).toHaveLength(0);
  });

  test("effort on Opus 4.5 maps to a budget, so it gets the beta too", async () => {
    expect(await betasOf({ model: "claude-opus-4.5", effort: "high", tools: TOOLS })).toContain(INTERLEAVED_THINKING_BETA);
  });

  test("no tools -> no beta (there is nothing to interleave between)", async () => {
    expect(await betasOf({ thinking: { type: "enabled", budgetTokens: 4_096 } })).not.toContain(INTERLEAVED_THINKING_BETA);
  });

  test("no thinking -> no beta", async () => {
    expect(await betasOf({ tools: TOOLS })).not.toContain(INTERLEAVED_THINKING_BETA);
  });

  test("an adaptive-thinking row never gets it (adaptive interleaves on its own)", async () => {
    expect(await betasOf({ model: "claude-sonnet-5", thinking: { type: "adaptive" }, tools: TOOLS })).not.toContain(INTERLEAVED_THINKING_BETA);
    // Sonnet 5 rejects `enabled`; the adapter rewrites it to adaptive, and the header follows the body.
    expect(await betasOf({ model: "claude-sonnet-5", thinking: { type: "enabled", budgetTokens: 4_096 }, tools: TOOLS })).not.toContain(INTERLEAVED_THINKING_BETA);
  });

  test("a host that already sends it gets it ONCE", async () => {
    const s = start(() => sse(messageStart + textBlock(0, "ok") + ending("end_turn")));
    const withHostBeta = createAnthropicMessagesAdapter({ catalog: loadCatalog(), betas: [INTERLEAVED_THINKING_BETA] });
    for await (const _ of withHostBeta.streamTurn({ model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }], thinking: { type: "enabled", budgetTokens: 4_096 }, tools: TOOLS }, ctx(s.url))) void _;
    expect(s.requests[0]!.headers["anthropic-beta"]).toBe(INTERLEAVED_THINKING_BETA);
  });
});
