// Phase 6 Task 3 (R6-4): the bridge's fold, over scripted `ProviderEvent` streams.
//
// Scripted rather than networked on purpose: every family lane will drive its own adapter through
// this same fold against a real loopback fake, and what THIS file has to pin is the fold's own
// obligations -- what it accumulates, what it forwards, what it refuses to do, and what it must
// never let reach a frame.
import { test, expect, describe } from "bun:test";
import type { ProviderAdapter, ProviderContext, ProviderEvent, ResolvedModel, TurnRequest } from "@yanlinglabs/winter-provider-runtime";
import type { WireStreamEvent } from "@yanlinglabs/winter-agent-sdk";
import { adapterAsProvider, createIdentityHistoryRenderer, foldProviderStream, ProviderTurnError } from "./bridge.ts";
import type { ProviderMessage, ProviderStreamSink } from "../engine.ts";

async function* scripted(events: ProviderEvent[]): AsyncIterable<ProviderEvent> {
  for (const event of events) yield event;
}

function recordingSink(): { sink: ProviderStreamSink; events: WireStreamEvent[]; retries: unknown[]; rateLimits: unknown[]; authStatuses: unknown[]; summaries: string[] } {
  const events: WireStreamEvent[] = [];
  const retries: unknown[] = [];
  const rateLimits: unknown[] = [];
  const authStatuses: unknown[] = [];
  const summaries: string[] = [];
  return {
    events,
    retries,
    rateLimits,
    authStatuses,
    summaries,
    sink: {
      onStreamEvent: (e) => events.push(e),
      onRetry: (i) => retries.push(i),
      onRateLimit: (i) => rateLimits.push(i),
      onAuthStatus: (i) => authStatuses.push(i),
      onReasoningSummary: (t) => summaries.push(t),
    },
  };
}

describe("the fold: what a turn accumulates", () => {
  test("a text-only stream folds to a `text` turn with usage and stop reason", async () => {
    const turn = await foldProviderStream(
      scripted([
        { type: "message_start", id: "m1", model: "p/m" },
        { type: "text_delta", text: "he" },
        { type: "text_delta", text: "llo" },
        { type: "usage", inputTokens: 10, outputTokens: 3 },
        { type: "done", stopReason: "end_turn" },
      ]),
    );
    expect(turn).toEqual({ kind: "text", text: "hello", usage: { inputTokens: 10, outputTokens: 3 }, stopReason: "end_turn" });
  });

  test("a stream with TEXT AND CALLS folds to a tool_use turn that KEEPS the text", async () => {
    // The whole reason R6-3 added `text?` to the tool_use arm: a real model returns both, and before
    // the field existed the text was silently discarded.
    const turn = await foldProviderStream(
      scripted([
        { type: "text_delta", text: "I'll read it." },
        { type: "tool_call_start", id: "t1", name: "Read" },
        { type: "tool_call_delta", id: "t1", argumentsJsonDelta: '{"file_path":' },
        { type: "tool_call_delta", id: "t1", argumentsJsonDelta: '"/tmp/x"}' },
        { type: "tool_call_end", id: "t1" },
        { type: "done", stopReason: "tool_use" },
      ]),
    );
    expect(turn.kind).toBe("tool_use");
    expect(turn.kind === "tool_use" ? turn.text : undefined).toBe("I'll read it.");
    expect(turn.kind === "tool_use" ? turn.calls : []).toEqual([{ id: "t1", name: "Read", input: { file_path: "/tmp/x" } }]);
  });

  test("FRAGMENTED arguments across many deltas parse once, at the end", async () => {
    const chunks = '{"a":1,"b":{"c":[1,2,3]}}'.split("");
    const turn = await foldProviderStream(
      scripted([
        { type: "tool_call_start", id: "t1", name: "T" },
        ...chunks.map((c): ProviderEvent => ({ type: "tool_call_delta", id: "t1", argumentsJsonDelta: c })),
        { type: "tool_call_end", id: "t1" },
        { type: "done", stopReason: "tool_use" },
      ]),
    );
    expect(turn.kind === "tool_use" ? turn.calls[0]!.input : undefined).toEqual({ a: 1, b: { c: [1, 2, 3] } });
  });

  test("MULTIPLE calls keep their start order, and each keeps its own arguments", async () => {
    const turn = await foldProviderStream(
      scripted([
        { type: "tool_call_start", id: "t1", name: "A" },
        { type: "tool_call_start", id: "t2", name: "B" },
        { type: "tool_call_delta", id: "t2", argumentsJsonDelta: '{"two":2}' },
        { type: "tool_call_delta", id: "t1", argumentsJsonDelta: '{"one":1}' },
        { type: "tool_call_end", id: "t1" },
        { type: "tool_call_end", id: "t2" },
        { type: "done", stopReason: "tool_use" },
      ]),
    );
    expect(turn.kind === "tool_use" ? turn.calls : []).toEqual([
      { id: "t1", name: "A", input: { one: 1 } },
      { id: "t2", name: "B", input: { two: 2 } },
    ]);
  });

  test("an UNPARSEABLE argument string does not lose the whole turn", async () => {
    const turn = await foldProviderStream(
      scripted([
        { type: "tool_call_start", id: "t1", name: "A" },
        { type: "tool_call_delta", id: "t1", argumentsJsonDelta: "{not json" },
        { type: "tool_call_end", id: "t1" },
        { type: "tool_call_start", id: "t2", name: "B" },
        { type: "tool_call_delta", id: "t2", argumentsJsonDelta: '{"ok":true}' },
        { type: "tool_call_end", id: "t2" },
        { type: "done", stopReason: "tool_use" },
      ]),
    );
    const calls = turn.kind === "tool_use" ? turn.calls : [];
    expect(calls).toHaveLength(2);
    expect(calls[0]!.input).toEqual({ __winter_unparsed_arguments: "{not json" });
    expect(calls[1]!.input).toEqual({ ok: true });
  });

  test("native state is taken from the COMPLETION event: a later one supersedes an earlier partial", async () => {
    const turn = await foldProviderStream(
      scripted([
        { type: "native_state", items: ["partial"] },
        { type: "text_delta", text: "x" },
        { type: "native_state", items: ["complete-a", "complete-b"] },
        { type: "done", stopReason: "end_turn" },
      ]),
    );
    expect(turn.nativeState?.items).toEqual(["complete-a", "complete-b"]);
  });

  test("an in-dialect thinking block keeps its REAL signature, and a signatureless one normalises to ''", async () => {
    // Capture (F): the pinned runtime never emits or replays a thinking block without a `signature`
    // key -- when the stream carries none it materialises the empty string, and replays it verbatim.
    const turn = await foldProviderStream(
      scripted([
        { type: "native_thinking_block", block: { type: "thinking", thinking: "reasoned", signature: "real-sig" } },
        { type: "native_thinking_block", block: { type: "thinking", thinking: "unsigned" } },
        { type: "native_thinking_block", block: { type: "redacted_thinking", data: "opaque" } },
        { type: "text_delta", text: "answer" },
        { type: "done", stopReason: "end_turn" },
      ]),
    );
    expect(turn.thinking?.blocks).toEqual([
      { type: "thinking", thinking: "reasoned", signature: "real-sig" },
      { type: "thinking", thinking: "unsigned", signature: "" },
      { type: "redacted_thinking", data: "opaque" },
    ]);
  });

  test("a malformed native_thinking_block is DROPPED rather than folded in as junk", async () => {
    const turn = await foldProviderStream(
      scripted([
        { type: "native_thinking_block", block: { type: "thinking" } },
        { type: "native_thinking_block", block: "not an object" },
        { type: "text_delta", text: "answer" },
        { type: "done", stopReason: "end_turn" },
      ]),
    );
    expect(turn.thinking).toBeUndefined();
  });
});

describe("R6-8: a FOREIGN summary never becomes content", () => {
  test("summary deltas reach the sink ONCE, complete, and land on turn.thinking.summary -- never on turn.text", async () => {
    const { sink, summaries, events } = recordingSink();
    const turn = await foldProviderStream(
      scripted([
        { type: "thinking_summary_delta", text: "considered " },
        { type: "thinking_summary_delta", text: "two options" },
        { type: "text_delta", text: "the answer" },
        { type: "done", stopReason: "end_turn" },
      ]),
      sink,
    );
    expect(turn.kind === "text" ? turn.text : "").toBe("the answer");
    expect(turn.thinking?.summary).toBe("considered two options");
    // ONCE, not per delta: a frame per delta would be a second, ungated streaming channel for
    // reasoning text, which R6-8 and the "streaming foreign thinking is a carry" ruling exclude.
    expect(summaries).toEqual(["considered two options"]);
    // And it is nowhere in the model-facing block stream.
    expect(JSON.stringify(events)).not.toContain("considered");
  });

  test("exposed reasoning lands on `exposed`, never on the text", async () => {
    const turn = await foldProviderStream(scripted([{ type: "thinking_exposed_delta", text: "raw chain" }, { type: "text_delta", text: "answer" }, { type: "done", stopReason: "end_turn" }]));
    expect(turn.kind === "text" ? turn.text : "").toBe("answer");
    expect(turn.thinking?.exposed).toBe("raw chain");
  });
});

describe("R6-5: the raw stream-event translation", () => {
  test("Winter's normalized events become the SIX pinned names, with a coherent block index", async () => {
    const { sink, events } = recordingSink();
    await foldProviderStream(
      scripted([
        { type: "message_start", id: "m1", model: "p/m" },
        { type: "text_delta", text: "hi" },
        { type: "tool_call_start", id: "t1", name: "Read" },
        { type: "tool_call_delta", id: "t1", argumentsJsonDelta: "{}" },
        { type: "tool_call_end", id: "t1" },
        { type: "done", stopReason: "tool_use" },
      ]),
      sink,
    );
    expect(events.map((e) => e.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop", // the text block closes when the tool block opens
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    // Every name is a member of the pinned six; `ping` is not, and is never produced.
    const pinned = new Set(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    for (const e of events) expect(pinned.has(e.type)).toBe(true);
    // The two blocks got distinct, increasing indices.
    const starts = events.filter((e) => e.type === "content_block_start") as Array<{ index: number }>;
    expect(starts.map((s) => s.index)).toEqual([0, 1]);
  });

  test("OPAQUE state never reaches the stream: native_state produces no event at all", async () => {
    const { sink, events } = recordingSink();
    await foldProviderStream(scripted([{ type: "native_state", items: ["ENCRYPTED-OPAQUE-ITEM"] }, { type: "text_delta", text: "x" }, { type: "done", stopReason: "end_turn" }]), sink);
    expect(JSON.stringify(events)).not.toContain("ENCRYPTED-OPAQUE-ITEM");
    expect(events.some((e) => e.type === "message_start")).toBe(false); // no message_start was scripted
  });

  test("the four observed delta variants are the only ones produced", async () => {
    const { sink, events } = recordingSink();
    await foldProviderStream(
      scripted([
        { type: "native_thinking_block", block: { type: "thinking", thinking: "t", signature: "s" } },
        { type: "text_delta", text: "x" },
        { type: "tool_call_start", id: "t1", name: "R" },
        { type: "tool_call_delta", id: "t1", argumentsJsonDelta: "{}" },
        { type: "tool_call_end", id: "t1" },
        { type: "done", stopReason: "tool_use" },
      ]),
      sink,
    );
    const deltas = events.filter((e) => e.type === "content_block_delta") as Array<{ delta: { type: string } }>;
    expect([...new Set(deltas.map((d) => d.delta.type))].sort()).toEqual(["input_json_delta", "signature_delta", "text_delta", "thinking_delta"]);
  });

  test("no sink means no work: the fold is identical for an AUXILIARY generation", async () => {
    const withSink = recordingSink();
    const a = await foldProviderStream(scripted([{ type: "text_delta", text: "x" }, { type: "done", stopReason: "end_turn" }]), withSink.sink);
    const b = await foldProviderStream(scripted([{ type: "text_delta", text: "x" }, { type: "done", stopReason: "end_turn" }]));
    expect(a).toEqual(b);
    expect(withSink.events.length).toBeGreaterThan(0);
  });
});

describe("the observation channels", () => {
  test("retry / rate_limit / auth_status are forwarded to the sink, never folded into the turn", async () => {
    const { sink, retries, rateLimits, authStatuses } = recordingSink();
    const turn = await foldProviderStream(
      scripted([
        { type: "retry", attempt: 1, maxRetries: 10, retryDelayMs: 2000, errorStatus: 529, error: "overloaded" },
        { type: "rate_limit", kind: "subscription-quota", info: { status: "allowed_warning" } },
        { type: "auth_status", isAuthenticating: true, output: ["refreshing"] },
        { type: "text_delta", text: "done" },
        { type: "done", stopReason: "end_turn" },
      ]),
      sink,
    );
    expect(retries).toEqual([{ attempt: 1, maxRetries: 10, retryDelayMs: 2000, errorStatus: 529, error: "overloaded" }]);
    expect(rateLimits).toEqual([{ kind: "subscription-quota", info: { status: "allowed_warning" } }]);
    expect(authStatuses).toEqual([{ isAuthenticating: true, output: ["refreshing"] }]);
    expect(turn).toEqual({ kind: "text", text: "done", stopReason: "end_turn" });
  });

  test("an ABSENT retry status stays absent on the seam -- the frame producer is what maps it to null", async () => {
    const { sink, retries } = recordingSink();
    await foldProviderStream(scripted([{ type: "retry", attempt: 1, maxRetries: 10, retryDelayMs: 100, error: "server_error" }, { type: "done", stopReason: "end_turn" }]), sink);
    expect("errorStatus" in (retries[0] as object)).toBe(false);
  });
});

describe("errors: typed, redacted, and NEVER retried past the first byte", () => {
  test("an error event mid-stream becomes a ProviderTurnError carrying the status and provider code", async () => {
    const promise = foldProviderStream(
      scripted([
        { type: "text_delta", text: "partial" },
        { type: "error", error: { code: "server", message: "upstream exploded", status: 503, providerCode: "overloaded_error", retryable: true } },
      ]),
    );
    await expect(promise).rejects.toThrow(ProviderTurnError);
    const err = (await promise.catch((e: unknown) => e)) as ProviderTurnError;
    expect(err.status).toBe(503);
    expect(err.providerCode).toBe("overloaded_error");
    expect(err.message).toContain("upstream exploded");
  });

  test("an error AFTER the first byte is NOT retried: streamTurn is invoked exactly once", async () => {
    // WS-13 §13's own rule, at the seam that could break it. A retry here would be a REPLAY: the
    // model may already have emitted a tool call the caller executed. `withRetry` lives strictly
    // before the stream begins, inside the adapter; the bridge must add nothing.
    let calls = 0;
    const adapter = scriptedAdapter(() => {
      calls++;
      return scripted([{ type: "text_delta", text: "partial" }, { type: "error", error: { code: "server", message: "boom", status: 503, retryable: true } }]);
    });
    const provider = adapterAsProvider(resolvedFor(adapter), fakeCtx(), { adapter });
    await expect(provider.generate({ messages: [] })).rejects.toThrow(ProviderTurnError);
    expect(calls).toBe(1);
  });

  test("a raw throw from the adapter is normalized, BOUNDED, and never carries the original as `cause`", async () => {
    // An arbitrary throw can carry a request object, a response body or a header map -- any of which
    // may hold credential material or opaque state, all of which would ride the error into a frame.
    const secret = "sk-should-never-appear";
    const raw = Object.assign(new Error(`x`.repeat(1000)), { status: 401, requestHeaders: { authorization: `Bearer ${secret}` } });
    const adapter = scriptedAdapter(() => {
      throw raw;
    });
    const provider = adapterAsProvider(resolvedFor(adapter), fakeCtx(), { adapter });
    const err = (await provider.generate({ messages: [] }).catch((e: unknown) => e)) as ProviderTurnError;
    expect(err).toBeInstanceOf(ProviderTurnError);
    expect(err.status).toBe(401);
    expect(err.message.length).toBeLessThan(500);
    expect(JSON.stringify({ message: err.message, cause: (err as { cause?: unknown }).cause })).not.toContain(secret);
  });

  test("a very long provider message is truncated before it can reach a frame", async () => {
    const promise = foldProviderStream(scripted([{ type: "error", error: { code: "bad_request", message: "y".repeat(5000), retryable: false } }]));
    const err = (await promise.catch((e: unknown) => e)) as ProviderTurnError;
    expect(err.message.length).toBeLessThan(500);
    expect(err.message.endsWith("...")).toBe(true);
  });
});

describe("the T3 identity history renderer", () => {
  const chain = new Map();

  test("native state is REPLAYED inside the same continuation domain", () => {
    const renderer = createIdentityHistoryRenderer();
    const messages: ProviderMessage[] = [{ role: "assistant", content: "x", nativeState: { family: "openai", continuationDomain: "openai:responses", items: [1] } }];
    const out = renderer.render(messages, chain, { family: "openai", continuationDomain: "openai:responses", readableState: "none" });
    expect(out[0]!.nativeState).toEqual({ family: "openai", continuationDomain: "openai:responses", items: [1] });
  });

  test("native state is DROPPED across a domain boundary -- opaque items are meaningful only to their minter", () => {
    const renderer = createIdentityHistoryRenderer();
    const messages: ProviderMessage[] = [{ role: "assistant", content: "x", nativeState: { family: "openai", continuationDomain: "openai:responses", items: ["OPAQUE"] } }];
    const out = renderer.render(messages, chain, { family: "anthropic", continuationDomain: "anthropic:messages", readableState: "none" });
    expect(out[0]!.nativeState).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("OPAQUE");
    // The message itself survives -- only the un-replayable annotation is dropped.
    expect(out[0]!.content).toBe("x");
  });

  test("it NEVER decorates: a message the renderer touched carries no Winter-authored text", () => {
    const renderer = createIdentityHistoryRenderer();
    const messages: ProviderMessage[] = [{ role: "assistant", content: "x", origin: { providerId: "openai", modelKey: "openai/m", family: "openai" } }];
    const out = renderer.render(messages, chain, { family: "anthropic", continuationDomain: "anthropic:messages", readableState: "summary" });
    expect(out[0]!.decoration).toBeUndefined();
    expect(out).toEqual(messages);
  });

  test("a message with NO origin or native state passes through untouched -- absence is not a mismatch", () => {
    const renderer = createIdentityHistoryRenderer();
    const messages: ProviderMessage[] = [{ role: "user", content: "hello" }];
    expect(renderer.render(messages, chain, { family: "anthropic", readableState: "none" })).toEqual(messages);
  });
});

describe("adapterAsProvider: what actually reaches the adapter", () => {
  test("the request carries the resolved model id, the system prompt, the tools and the signal", async () => {
    let seen: TurnRequest | undefined;
    const adapter = scriptedAdapter((req) => {
      seen = req;
      return scripted([{ type: "text_delta", text: "ok" }, { type: "done", stopReason: "end_turn" }]);
    });
    const controller = new AbortController();
    const provider = adapterAsProvider(resolvedFor(adapter), fakeCtx(), { adapter });
    await provider.generate({
      messages: [{ role: "user", content: "hi" }],
      system: "be brief",
      tools: [{ name: "Read", description: "d", inputSchema: { type: "object" } }],
      signal: controller.signal,
    });
    expect(seen!.model).toBe("provider-local-id");
    expect(seen!.system).toBe("be brief");
    expect(seen!.tools).toEqual([{ name: "Read", description: "d", inputSchema: { type: "object" } }]);
    expect(seen!.signal).toBe(controller.signal);
  });

  test("`requestSummary` is asked for ONLY when the model exposes readable reasoning", async () => {
    // "Never a request for raw reasoning" is the seam's own contract; asking a model that exposes
    // none is a request the descriptor's evidence says will not be honoured.
    let seen: TurnRequest | undefined;
    const adapter = scriptedAdapter((req) => {
      seen = req;
      return scripted([{ type: "done", stopReason: "end_turn" }]);
    });
    const none = adapterAsProvider(resolvedFor(adapter), fakeCtx(), { adapter });
    await none.generate({ messages: [] });
    expect(seen!.requestSummary).toBeUndefined();

    const summarising = adapterAsProvider(resolvedFor({ ...adapter, capabilities: () => ({ toolCalling: "native", readableState: "summary" }) } as ProviderAdapter), fakeCtx(), {
      adapter: { ...adapter, capabilities: () => ({ toolCalling: "native", readableState: "summary" }) } as ProviderAdapter,
    });
    await summarising.generate({ messages: [] });
    expect(seen!.requestSummary).toBe(true);
  });
});

// --- fixtures -------------------------------------------------------------------------------------

function scriptedAdapter(stream: (req: TurnRequest) => AsyncIterable<ProviderEvent>): ProviderAdapter {
  return {
    id: "scripted",
    version: "1.0.0",
    family: "openai",
    protocol: "openai-responses",
    async validateCredential() {
      return { ok: true };
    },
    async listModels() {
      return { models: [], partial: false, cached: false, warnings: [] };
    },
    streamTurn: (req) => stream(req),
    mapEffort: () => ({ ok: true, value: "medium" }),
    capabilities: () => ({ toolCalling: "native", readableState: "none" }),
  };
}

function resolvedFor(adapter: ProviderAdapter): ResolvedModel {
  return {
    providerId: "openai",
    modelKey: "openai/o-test",
    providerModelId: "provider-local-id",
    adapterId: adapter.id,
    adapter,
    descriptor: { key: "openai/o-test", providerId: "openai", upstreamId: "provider-local-id", displayName: "o-test", status: "candidate" } as never,
    provider: { id: "openai", displayName: "OpenAI", adapterId: adapter.id } as never,
    continuationDomain: "openai:responses",
    catalogVersion: "0.0.0-seed",
  };
}

function fakeCtx(): ProviderContext {
  return {
    connection: { providerId: "openai" },
    credentials: {
      async get() {
        return null;
      },
      async set() {},
      async delete() {},
    },
    authRef: { kind: "none" },
    stallTimeoutMs: 1000,
    log: () => {},
  };
}

describe("live native replay: the turn's native state must be STAMPED with the resolved identity", () => {
  test("a same-domain replay survives the identity renderer on the NEXT generation", async () => {
    // THE BUG THIS EXISTS TO CATCH, stated plainly: the fold cannot know the family or the
    // continuation domain -- it sees only an adapter's `items` -- so it emits `{family: "",
    // continuationDomain: "", items}`. If `adapterAsProvider` returns that unstamped, the engine
    // copies it onto the in-memory message verbatim and the identity renderer compares `""` against
    // the real domain on the very next generation and DROPS it. Live native replay would be dead for
    // every session while resumed ones worked (the chain rebuilds family/domain from the record) --
    // the common case broken, the rarer one fine.
    //
    // The existing "native state from the COMPLETION event" test checks `items` only, and the
    // renderer tests hand-build messages that already carry the right domain, so neither sees it.
    const seen: TurnRequest[] = [];
    let call = 0;
    const adapter = scriptedAdapter((req) => {
      seen.push(req);
      call++;
      return call === 1
        ? scripted([{ type: "native_state", items: ["OPAQUE-1"] }, { type: "text_delta", text: "one" }, { type: "done", stopReason: "end_turn" }])
        : scripted([{ type: "text_delta", text: "two" }, { type: "done", stopReason: "end_turn" }]);
    });
    const resolved = resolvedFor(adapter);
    const provider = adapterAsProvider(resolved, fakeCtx(), { adapter });

    const first = await provider.generate({ messages: [{ role: "user", content: "go" }] });
    // STAMPED with the adapter's family and the RESOLVED continuation domain, not the fold's blanks.
    expect(first.nativeState).toEqual({ family: "openai", continuationDomain: "openai:responses", items: ["OPAQUE-1"] });

    // Fed back exactly as the engine's `providerAnnotations` does, then generated against again.
    await provider.generate({
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "one", ...(first.nativeState !== undefined ? { nativeState: first.nativeState } : {}) },
        { role: "user", content: "again" },
      ],
    });
    const replayed = seen[1]!.messages.find((m) => m.role === "assistant");
    expect(replayed?.nativeState?.items).toEqual(["OPAQUE-1"]);
    expect(replayed?.nativeState?.continuationDomain).toBe("openai:responses");
  });

  test("a turn with NO native state is returned untouched -- stamping never fabricates one", async () => {
    const adapter = scriptedAdapter(() => scripted([{ type: "text_delta", text: "x" }, { type: "done", stopReason: "end_turn" }]));
    const turn = await adapterAsProvider(resolvedFor(adapter), fakeCtx(), { adapter }).generate({ messages: [] });
    expect(turn.nativeState).toBeUndefined();
  });
});
