// WS-23 (anthropic-cache lane): the Anthropic adapter's cache-preserving request shapes, asserted on
// the REQUEST BODY and HEADERS `prepare()` builds -- per-message effort markers, and (later items)
// deferred tools, cache breakpoints, TTL and diagnostics. Kept in its own file so the parallel
// anthropic-hardening lane's edits to `messages.test.ts` never collide with these.
import { describe, expect, test } from "bun:test";
import { ANTHROPIC_DEFAULT_BASE_URL, createAnthropicMessagesAdapter } from "./index.ts";
import { buildHeaders, buildRequestBody, LOOKBACK_MARGIN_POSITIONS, perMessageEffortBetaFor, toWireMessages, withMessageCacheMarker, withMessageCacheMarkers } from "./messages.ts";
import { ProviderRequestError } from "../../http.ts";
import { createEndpointPolicy } from "../../endpoint-policy.ts";
import type { CredentialMaterial, CredentialRef, ProviderContext, ProviderEvent, ProviderMessageLike, TurnRequest } from "../../types.ts";
import type { WinterCatalog, WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { stampFamilyFields } from "@yanlinglabs/winter-provider-catalog";

const evidence = <T>(value: T) => ({ value, source: "official-doc" as const, confidence: "declared" as const });

const stampRow = (row: Omit<WinterModelDescriptor, "modelFamily" | "canonicalModelId">): WinterModelDescriptor => stampFamilyFields([row], [])[0]!;

/** Opus 5.5's real shape, plus the WS-23 evidence under test. */
const opus55 = (over: Partial<WinterModelDescriptor> = {}): WinterModelDescriptor =>
  stampRow({
    key: "anthropic/claude-opus-5-5",
    providerId: "anthropic",
    upstreamId: "claude-opus-5-5",
    displayName: "Claude Opus 5.5",
    aliases: [],
    endpoints: ["chat"],
    inputModalities: evidence(["text", "image"]),
    outputModalities: evidence(["text"]),
    toolCalling: evidence("native" as const),
    nativeTools: evidence(true),
    promptCaching: evidence(true),
    unsupportedParameters: ["thinking.type.enabled", "thinking.type.disabled", "tool_choice.any", "tool_choice.tool"],
    reasoning: {
      supported: evidence(true),
      efforts: ["low", "medium", "high", "xhigh", "max"],
      continuation: "opaque-provider-state",
      effortRequest: evidence({ field: "output_config.effort" as const }),
      perMessageEffort: evidence({ beta: "mid-conversation-output-config-2026-07-01" as const }),
    },
    status: "candidate",
    ...over,
  });

/** Fable 5's real shape: effort via `output_config.effort`, but no per-message effort (a documented 400). */
const fable5 = (): WinterModelDescriptor =>
  opus55({
    key: "anthropic/claude-fable-5",
    upstreamId: "claude-fable-5",
    reasoning: { supported: evidence(true), efforts: ["low", "medium", "high", "xhigh", "max"], continuation: "opaque-provider-state", effortRequest: evidence({ field: "output_config.effort" as const }) },
  });

const noCredentials = {
  async get(_ref: CredentialRef): Promise<CredentialMaterial | null> {
    return null;
  },
  async set(): Promise<void> {},
  async delete(): Promise<void> {},
};

const ctx = (): ProviderContext => ({ connection: { providerId: "anthropic" }, credentials: noCredentials, authRef: { kind: "none" }, stallTimeoutMs: 1_000, log: () => {} });

const marker = (effort: string): ProviderMessageLike => ({ role: "system", content: [], outputConfig: { effort } });

/** Turn 1 at `high`, then an effort switch to `low` before turn 2's user message -- the documented placement. */
const switched: ProviderMessageLike[] = [
  { role: "user", content: "plan it" },
  { role: "assistant", content: "1. export 2. import" },
  marker("low"),
  { role: "user", content: "summarize" },
];

describe("per-message effort (WS-23 item 1)", () => {
  test("a system marker is its OWN wire entry between the assistant reply and the next user turn, with `output_config` and empty content", () => {
    expect(toWireMessages(switched)).toEqual([
      { role: "user", content: [{ type: "text", text: "plan it" }] },
      { role: "assistant", content: [{ type: "text", text: "1. export 2. import" }] },
      { role: "system", content: [], output_config: { effort: "low" } },
      { role: "user", content: [{ type: "text", text: "summarize" }] },
    ]);
  });

  test("a system message never merges into a neighbour, and two in a row stay two entries", () => {
    const wire = toWireMessages([
      { role: "user", content: "a" },
      { role: "system", content: "note one" },
      { role: "system", content: "note two" },
      { role: "user", content: "b" },
    ]);
    expect(wire.map((m) => m.role)).toEqual(["user", "system", "system", "user"]);
    expect(wire[1]).toEqual({ role: "system", content: [{ type: "text", text: "note one" }] });
  });

  test("the top-level effort stays what the engine sent; the switch rides ONLY the marker, and the beta header is the DOCUMENTED value", async () => {
    const body = buildRequestBody({ model: "claude-opus-5-5", messages: switched, effort: "high" }, opus55(), {});
    expect(body["output_config"]).toEqual({ effort: "high" });
    expect((body["messages"] as Array<Record<string, unknown>>)[2]).toEqual({ role: "system", content: [], output_config: { effort: "low" } });
    const beta = perMessageEffortBetaFor(body, opus55());
    expect(beta).toBe("mid-conversation-output-config-2026-07-01");
    const policy = createEndpointPolicy(ANTHROPIC_DEFAULT_BASE_URL, { generated: true });
    if (!policy.ok) throw new Error(policy.reason);
    const headers = await buildHeaders(ctx(), undefined, policy.policy, { betas: ["mid-conversation-output-config-2026-07-01"] }, true, {}, [beta!]);
    // Deduped against the host's own list: one header value, never the alias claude 2.1.282 sends.
    expect(headers["anthropic-beta"]).toBe("mid-conversation-output-config-2026-07-01");
  });

  test("no marker in the body -> no per-message beta", () => {
    const body = buildRequestBody({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }], effort: "high" }, opus55(), {});
    expect(perMessageEffortBetaFor(body, opus55())).toBeUndefined();
  });

  test("a marker for a row WITHOUT `perMessageEffort` evidence (Fable 5) is a typed capability refusal, never a request", () => {
    let thrown: unknown;
    try {
      buildRequestBody({ model: "claude-fable-5", messages: switched, effort: "high" }, fable5(), {});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProviderRequestError);
    expect((thrown as ProviderRequestError).code).toBe("capability");
    expect((thrown as Error).message).toContain("per-message effort");
  });

  test("a marker level outside the row's own vocabulary is refused before the request", () => {
    expect(() => buildRequestBody({ model: "claude-opus-5-5", messages: [...switched.slice(0, 2), marker("minimal"), switched[3]!], effort: "high" }, opus55(), {})).toThrow(/verified vocabulary/);
  });

  test("the rolling cache marker skips an effort-only message and lands on the block before it", () => {
    const wire = withMessageCacheMarker(toWireMessages([{ role: "user", content: "a" }, { role: "assistant", content: "b" }, marker("low")]));
    expect(wire[1]!.content[0]).toEqual({ type: "text", text: "b", cache_control: { type: "ephemeral" } });
    expect(wire[2]).toEqual({ role: "system", content: [], output_config: { effort: "low" } });
  });

  test("a token COUNT drops effort-only markers (they render nothing, and a count body carries no output_config)", () => {
    const body = buildRequestBody({ model: "claude-opus-5-5", messages: switched, effort: "high" } as TurnRequest, opus55(), {}, "count");
    expect((body["messages"] as Array<{ role: string }>).map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});

// --- WS-23 item 3: a stable tool list ---------------------------------------------------------------

const tool = (name: string, deferLoading?: true) => ({ name, description: `${name} tool`, inputSchema: { type: "object" }, ...(deferLoading === true ? { deferLoading } : {}) });

describe("deferred tools and tool_reference (WS-23 item 3)", () => {
  const deferredRow = (): WinterModelDescriptor => opus55({ deferredToolLoading: evidence(true) });
  const searchResult = (loadedTools: string[]): ProviderMessageLike[] => [
    { role: "user", content: "find the notebook tool" },
    { role: "assistant", content: [{ type: "tool_use", id: "ts1", name: "ToolSearch", input: { query: "notebook" } }] },
    { role: "tool", content: [{ type: "tool_result", tool_use_id: "ts1", content: '{"matches":["NotebookEdit"]}', loadedTools }] },
  ];

  test("a deferred tool is declared with `defer_loading: true`; an eager one is not", () => {
    const body = buildRequestBody({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }], tools: [tool("Bash"), tool("NotebookEdit", true)] }, deferredRow(), {});
    expect(body["tools"]).toEqual([
      { name: "Bash", description: "Bash tool", input_schema: { type: "object" } },
      { name: "NotebookEdit", description: "NotebookEdit tool", input_schema: { type: "object" }, defer_loading: true },
    ]);
  });

  test("a ToolSearch result's `loadedTools` becomes Anthropic's tool_reference blocks inside that result -- only for names declared deferred", () => {
    const body = buildRequestBody({ model: "claude-opus-5-5", messages: searchResult(["NotebookEdit", "Bash", "Nope"]), tools: [tool("Bash"), tool("NotebookEdit", true)] }, deferredRow(), {});
    const result = (body["messages"] as Array<{ content: Array<Record<string, unknown>> }>)[2]!.content[0]!;
    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "ts1",
      content: [{ type: "text", text: '{"matches":["NotebookEdit"]}' }, { type: "tool_reference", tool_name: "NotebookEdit" }],
    });
  });

  test("with no deferred tool in the request, the same history serialises byte-identically to before (the bookkeeping field never reaches the wire)", () => {
    const body = buildRequestBody({ model: "claude-opus-5-5", messages: searchResult(["NotebookEdit"]), tools: [tool("Bash"), tool("NotebookEdit")] }, opus55(), {});
    expect((body["messages"] as Array<{ content: unknown[] }>)[2]!.content[0]).toEqual({ type: "tool_result", tool_use_id: "ts1", content: '{"matches":["NotebookEdit"]}' });
  });

  test("a claude-written `tool_reference` inside a resumed tool_result stays a reference when the tool is deferred, and becomes a legible note when it is not", () => {
    const history: ProviderMessageLike[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "ToolSearch", input: {} }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "tool_reference", tool_name: "NotebookEdit" } as never] }] },
    ];
    const deferred = buildRequestBody({ model: "claude-opus-5-5", messages: history, tools: [tool("Bash"), tool("NotebookEdit", true)] }, deferredRow(), {});
    expect((deferred["messages"] as Array<{ content: Array<{ content: unknown }> }>)[2]!.content[0]!.content).toEqual([{ type: "tool_reference", tool_name: "NotebookEdit" }]);
    const plain = buildRequestBody({ model: "claude-opus-5-5", messages: history, tools: [tool("Bash"), tool("NotebookEdit")] }, opus55(), {});
    expect((plain["messages"] as Array<{ content: Array<{ content: unknown }> }>)[2]!.content[0]!.content).toEqual([{ type: "text", text: "[tools now callable: NotebookEdit]" }]);
  });

  test("a `defer_loading` tool on a row without the evidence, or a request with NO eager tool, is refused before the request", () => {
    expect(() => buildRequestBody({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }], tools: [tool("Bash"), tool("X", true)] }, opus55(), {})).toThrow(/deferred tool loading/);
    expect(() => buildRequestBody({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }], tools: [tool("X", true)] }, deferredRow(), {})).toThrow(/at least one tool without `defer_loading`/);
  });
});

// --- WS-23 item 5: breakpoints ------------------------------------------------------------------------

const countMarkers = (value: unknown): number => JSON.stringify(value).split('"cache_control"').length - 1;
const markedAt = (wire: Array<{ content: Array<Record<string, unknown>> }>): Array<[number, number]> =>
  wire.flatMap((m, i) => m.content.flatMap((b, j) => ("cache_control" in b ? [[i, j] as [number, number]] : [])));

describe("cache breakpoints (WS-23 item 5)", () => {
  test("the rolling breakpoint lands on the TRUE last block -- text appended after the tool results (a hook's additionalContext) included", () => {
    const wire = withMessageCacheMarkers(
      toWireMessages([
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "tool", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }, { type: "text", text: "<hook additionalContext>" }] },
      ]),
      2,
    );
    expect(markedAt(wire)).toEqual([[2, 1]]);
  });

  const bigRound = (blocks: number): ProviderMessageLike[] => [
    { role: "user", content: "go" },
    { role: "assistant", content: "first" },
    { role: "user", content: "next" },
    // One assistant turn with many separately-counted positions (text blocks), then its tool results.
    { role: "assistant", content: [...Array.from({ length: blocks }, (_, i) => ({ type: "text" as const, text: `step ${i}` })), { type: "tool_use", id: "t", name: "Bash", input: {} }] },
    { role: "tool", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
  ];

  test("a request that appends MORE than the lookback margin since the previous write gets a breakpoint exactly ON that write", () => {
    const wire = withMessageCacheMarkers(toWireMessages(bigRound(LOOKBACK_MARGIN_POSITIONS + 2)), 2);
    // [2,0] is the previous request's own tail ("next"); [4,0] the rolling tail.
    expect(markedAt(wire)).toEqual([
      [2, 0],
      [4, 0],
    ]);
  });

  test("within the margin, and when the budget is spent, only the rolling breakpoint is placed", () => {
    expect(markedAt(withMessageCacheMarkers(toWireMessages(bigRound(3)), 2))).toEqual([[4, 0]]);
    expect(markedAt(withMessageCacheMarkers(toWireMessages(bigRound(LOOKBACK_MARGIN_POSITIONS + 2)), 1))).toEqual([[4, 0]]);
  });

  test("a run of parallel tool calls and its run of results each count as ONE position, as the API counts them", () => {
    const calls = Array.from({ length: 30 }, (_, i) => ({ type: "tool_use" as const, id: `t${i}`, name: "Read", input: {} }));
    const results = calls.map((c) => ({ type: "tool_result" as const, tool_use_id: c.id, content: "ok" }));
    const wire = withMessageCacheMarkers(toWireMessages([{ role: "user", content: "go" }, { role: "assistant", content: calls }, { role: "tool", content: results }]), 2);
    expect(markedAt(wire)).toEqual([[2, 29]]);
  });

  test("the whole request never exceeds Anthropic's four breakpoints: two system blocks + rolling + lookback", () => {
    const body = buildRequestBody(
      { model: "claude-opus-5-5", messages: bigRound(LOOKBACK_MARGIN_POSITIONS + 2), systemBlocks: [{ text: "static", cacheScope: "global" }, { text: "dynamic", cacheScope: "org" }], system: "static\n\ndynamic" },
      opus55(),
      {},
    );
    expect(countMarkers(body["system"])).toBe(2);
    expect(countMarkers(body["messages"])).toBe(2);
  });
});

// --- WS-23 item 6: TTL and the 1-hour write counter -----------------------------------------------------

/** A loopback Messages endpoint answering every request with `events`, recording each request body. */
async function withSseServer<T>(events: Array<Record<string, unknown>>, run: (url: string, bodies: Array<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      bodies.push((await request.json()) as Record<string, unknown>);
      const sse = events.map((e) => `event: ${String(e["type"])}\ndata: ${JSON.stringify(e)}\n\n`).join("");
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    return await run(`http://127.0.0.1:${server.port}`, bodies);
  } finally {
    server.stop(true);
  }
}

const turnEvents = (usage: Record<string, unknown>, extra: Record<string, unknown> = {}): Array<Record<string, unknown>> => [
  { type: "message_start", message: { id: "msg_1", model: "claude-opus-5-5", usage, ...extra } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];

async function streamOnce(url: string, req: TurnRequest, row: WinterModelDescriptor, logs: Array<Record<string, unknown>> = []): Promise<ProviderEvent[]> {
  const adapter = createAnthropicMessagesAdapter({ catalog: { models: [row], providers: [], families: [] } as unknown as WinterCatalog, retry: { maxRetries: 0 } });
  const events: ProviderEvent[] = [];
  const context: ProviderContext = { connection: { providerId: "anthropic", baseUrl: url, local: true }, credentials: noCredentials, authRef: { kind: "none" }, stallTimeoutMs: 5_000, log: (e) => void logs.push(e as Record<string, unknown>) };
  for await (const event of adapter.streamTurn(req, context)) events.push(event);
  return events;
}

describe("cache lifetime and the 1-hour write counter (WS-23 item 6)", () => {
  const blocks = [{ text: "static", cacheScope: "global" as const }, { text: "dynamic", cacheScope: "org" as const }];

  test("`cacheTtl: \"1h\"` rides the SYSTEM breakpoints only; the conversation's rolling breakpoint stays at the default", () => {
    const body = buildRequestBody({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }], systemBlocks: blocks, system: "static\n\ndynamic", cacheTtl: "1h" }, opus55(), {});
    expect(body["system"]).toEqual([
      { type: "text", text: "static", cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: "dynamic", cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
    expect((body["messages"] as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content[0]!["cache_control"]).toEqual({ type: "ephemeral" });
  });

  test("absent -> no `ttl` key anywhere (byte-identical to before)", () => {
    const body = buildRequestBody({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }], systemBlocks: blocks, system: "static\n\ndynamic" }, opus55(), {});
    expect(JSON.stringify(body)).not.toContain('"ttl"');
  });

  test("the usage event carries the 1-hour share of the writes, read off `usage.cache_creation`", async () => {
    await withSseServer(turnEvents({ input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 248, cache_creation: { ephemeral_5m_input_tokens: 148, ephemeral_1h_input_tokens: 100 } }), async (url) => {
      const events = await streamOnce(url, { model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }, opus55());
      expect(events.find((e) => e.type === "usage")).toEqual({ type: "usage", inputTokens: 5, outputTokens: 1, cacheReadTokens: 100, cacheWriteTokens: 248, cacheWrite1hTokens: 100 });
    });
  });
});

// --- WS-23 item 7: mid-conversation system reminders ---------------------------------------------------

describe("mid-conversation system reminders (WS-23 item 7)", () => {
  const reminder: ProviderMessageLike[] = [{ role: "user", content: "two" }, { role: "system", content: "<system-reminder>\nThe date has changed.\n</system-reminder>" }];

  test("a row with `midConversationSystem` evidence sends the reminder as its own `system` entry after the user turn", () => {
    const body = buildRequestBody({ model: "claude-opus-5-5", messages: reminder }, opus55({ midConversationSystem: evidence(true) }), {});
    expect((body["messages"] as Array<{ role: string }>).map((m) => m.role)).toEqual(["user", "system"]);
  });

  test("a row without it (Claude Sonnet 5: \"not available\") refuses a text-carrying system message before the request", () => {
    expect(() => buildRequestBody({ model: "claude-sonnet-5", messages: reminder }, opus55({ key: "anthropic/claude-sonnet-5", upstreamId: "claude-sonnet-5" }), {})).toThrow(/mid-conversation system messages/);
  });

  test("an effort-only marker needs no such evidence -- it carries no text (its own gate is `perMessageEffort`)", () => {
    expect(() => buildRequestBody({ model: "claude-opus-5-5", messages: switched, effort: "high" }, opus55(), {})).not.toThrow();
  });
});
