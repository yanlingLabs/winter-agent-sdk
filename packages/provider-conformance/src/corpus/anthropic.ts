// Phase 6 Task 6 (Lane B): the Anthropic Messages family's WS-13 §13 corpus.
//
// ADDED beside `corpus/runner.ts`, which is FROZEN (R6-12). The runner's case list is DATA; this
// file supplies one implementation per case id, and the runner reports a missing REQUIRED case as
// `missing` rather than as a silence -- so "the Anthropic corpus passed" means every question was
// asked.
//
// TWO RULES EVERY CASE HERE OBEYS:
//   - The ground truth for what the provider was ASKED is `fake.requests`. A case that asserted on
//     adapter state would prove nothing about the wire.
//   - The normalized stream is consumed by the REAL consumer (`foldProviderStream`), so a case
//     proves the adapter against what will actually fold it in production.
//
// The relative imports into `provider-runtime` and `runtime` are deliberate: this package's
// dependencies expose only their frozen barrels (`exports: { ".": ... }`), and neither barrel can
// gain an entry for a lane's adapter without editing a frozen file.
import type { ReasoningCapabilities, WinterCatalog, WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { createRegistry, createMemoryCredentialStore, discoverModels } from "@yanlinglabs/winter-provider-runtime";
import type { ProviderAdapter, ProviderContext, ProviderEvent, TurnRequest } from "@yanlinglabs/winter-provider-runtime";
import { createAnthropicMessagesAdapter } from "../../../provider-runtime/src/adapters/anthropic/index.ts";
import { foldProviderStream, type FoldedProviderTurn } from "../../../runtime/src/provider/bridge.ts";
import { anthropicError, anthropicFakeRoutes, anthropicSseFrames, anthropicTurnResponse, assertAnthropicRequest, anthropicBody, messageBlocks, flattenBlockTypes } from "../fakes/anthropic-messages.ts";
import { jsonResponse, sseResponse, stalledResponse, requestsTo, type FakeRoute, type FakeServer } from "../fakes/server.ts";
import type { CorpusCaseId, CorpusCaseImpl } from "./runner.ts";

// --- the lane's test catalog ------------------------------------------------------------------------
//
// A FIXTURE-OWNED catalog rather than the compiled one. Two reasons, both load-bearing: the seed
// rows carry no `maxOutputTokens` evidence (so the limit-rejection case would have nothing to
// reject against), and a capability refusal has to be provable against a row that DECLARES the
// missing capability -- which means authoring rows that say `toolCalling: "none"` and
// `inputModalities: ["text"]` on purpose.

const evidence = <T>(value: T): { value: T; source: "upstream-static"; confidence: "inferred"; observedAt: string } => ({
  value,
  source: "upstream-static",
  confidence: "inferred",
  observedAt: "2026-09-05T00:00:00Z",
});

function model(over: Partial<WinterModelDescriptor> & { key: string; upstreamId: string }): WinterModelDescriptor {
  return {
    providerId: "anthropic",
    displayName: over.key,
    aliases: [],
    endpoints: ["chat"],
    inputModalities: evidence(["text", "image"]),
    outputModalities: evidence(["text"]),
    toolCalling: evidence("native" as const),
    nativeTools: evidence(true),
    unsupportedParameters: [],
    status: "candidate",
    ...over,
  };
}

/** The reasoning block the catalogued Anthropic rows share, mirroring the seed row's own evidence. */
const anthropicReasoning = (key: string): ReasoningCapabilities => ({
  supported: evidence(true),
  efforts: ["low", "medium", "high", "xhigh", "max"],
  continuation: "opaque-provider-state",
  readableState: evidence("summary" as const),
  summaryRequest: evidence({ field: "thinking.display", values: ["summarized", "omitted"] }),
  continuationDomain: evidence([key]),
});

/** The model ids the corpus scenarios use. Each one selects a scripted behaviour from the fake's table. */
export const ANTHROPIC_MODELS = {
  /** The happy path: catalogued, reasoning-capable, vision-capable, native tools. */
  main: "claude-sonnet-5",
  /** A capture (F)-shaped turn: thinking -> text -> tool_use, with a `ping` injected after the first block start. */
  full: "sc-full",
  multiTool: "sc-multi-tools",
  fragmented: "sc-fragmented",
  dropMidThinking: "sc-drop-mid-thinking",
  dropAfterBlocks: "sc-drop-after-blocks",
  retry529: "sc-529-then-200",
  retryAfter: "sc-retry-after",
  auth: "sc-401",
  rateLimit: "sc-429",
  stall: "sc-stall",
  malformed: "sc-malformed",
  providerCode: "sc-provider-code",
  usage: "sc-usage",
  redacted: "sc-redacted",
  replay: "sc-replay",
  /** Declares `toolCalling: "none"` -- the no-silent-tool-dropping refusal. */
  noTools: "sc-no-tools",
  /** Declares text-only input -- the vision refusal. */
  noVision: "sc-no-vision",
  /** Declares `maxOutputTokens: 2048` -- the limit-rejection target. */
  capped: "sc-capped",
  /** Declares NO effort vocabulary -- an effort request must be refused before the wire. */
  noEfforts: "sc-no-efforts",
  /** A stream whose later frames are delayed, so a mid-stream abort lands on a PENDING read rather than between two buffered frames. */
  slow: "sc-slow",
  /** Its row's evidence names `message_stop` as the completion event, not the per-block terminator. */
  lateCapture: "sc-late-capture",
  /** The SAME row and blocks, on a stream that dies before `message_stop` ever arrives. */
  lateCaptureDropped: "sc-late-capture-dropped",
} as const;

export function testAnthropicCatalog(): WinterCatalog {
  const models: WinterModelDescriptor[] = [
    model({ key: `anthropic/${ANTHROPIC_MODELS.main}`, upstreamId: ANTHROPIC_MODELS.main, aliases: ["sonnet"], reasoning: anthropicReasoning(`anthropic/${ANTHROPIC_MODELS.main}`), promptCaching: evidence(true) }),
    ...([ANTHROPIC_MODELS.full, ANTHROPIC_MODELS.multiTool, ANTHROPIC_MODELS.fragmented, ANTHROPIC_MODELS.dropMidThinking, ANTHROPIC_MODELS.dropAfterBlocks, ANTHROPIC_MODELS.usage, ANTHROPIC_MODELS.redacted, ANTHROPIC_MODELS.replay] as string[]).map((id) =>
      model({ key: `anthropic/${id}`, upstreamId: id, reasoning: anthropicReasoning(`anthropic/${id}`) }),
    ),
    model({ key: `anthropic/${ANTHROPIC_MODELS.noTools}`, upstreamId: ANTHROPIC_MODELS.noTools, toolCalling: evidence("none" as const), nativeTools: evidence(false) }),
    model({ key: `anthropic/${ANTHROPIC_MODELS.noVision}`, upstreamId: ANTHROPIC_MODELS.noVision, inputModalities: evidence(["text"]) }),
    model({ key: `anthropic/${ANTHROPIC_MODELS.capped}`, upstreamId: ANTHROPIC_MODELS.capped, maxOutputTokens: evidence(2048), reasoning: anthropicReasoning(`anthropic/${ANTHROPIC_MODELS.capped}`) }),
    model({ key: `anthropic/${ANTHROPIC_MODELS.noEfforts}`, upstreamId: ANTHROPIC_MODELS.noEfforts, reasoning: { supported: evidence(true), efforts: [], continuation: "none" } }),
    // Minor 7: this row's own evidence names a DIFFERENT completion event, and the adapter honours it.
    model({
      key: `anthropic/${ANTHROPIC_MODELS.lateCapture}`,
      upstreamId: ANTHROPIC_MODELS.lateCapture,
      reasoning: { ...anthropicReasoning(`anthropic/${ANTHROPIC_MODELS.lateCapture}`), completionEvent: evidence("message_stop") },
    }),
    model({
      key: `anthropic/${ANTHROPIC_MODELS.lateCaptureDropped}`,
      upstreamId: ANTHROPIC_MODELS.lateCaptureDropped,
      reasoning: { ...anthropicReasoning(`anthropic/${ANTHROPIC_MODELS.lateCaptureDropped}`), completionEvent: evidence("message_stop") },
    }),
  ];
  return {
    schemaVersion: 1,
    catalogVersion: "0.0.0-lane-b-fixture",
    upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" },
    providers: [
      {
        id: "anthropic",
        displayName: "Anthropic",
        protocols: ["anthropic-messages"],
        authKinds: ["api-key"],
        defaultEndpoints: { api: "https://api.anthropic.com" },
        modelDiscovery: "provider-native",
        liveCatalogAuthority: "partial",
        adapterId: "winter.anthropic-messages",
        family: "anthropic",
        upstream: { project: "winter", commit: "", sourcePaths: [] },
        risk: { class: "approved", reasons: [] },
        scope: "llm",
        // WS-13b §1: both fields are REQUIRED on every provider row, so a fixture states its
        // own basis rather than inheriting one — a row-shape change fails HERE, at the fixture.
        pricingBasis: "token",
        admission: { basis: "api-key", citation: "fixture:anthropic-corpus" },
      },
    ],
    models,
  };
}

/** The test key. `test-key-...` by the lane's own rule, and the fake redacts it before it is ever recorded. */
export const ANTHROPIC_TEST_KEY = "test-key-anthropic";

export function testContext(baseUrl: string, over: Partial<ProviderContext> = {}): ProviderContext {
  return {
    // `local: true` is what lets the endpoint policy accept a plain-http loopback URL. It is a
    // DECLARATION the fixture makes about its own fake, exactly as a host would for a local model.
    connection: { providerId: "anthropic", baseUrl, local: true },
    credentials: createMemoryCredentialStore(),
    authRef: { kind: "inline", value: ANTHROPIC_TEST_KEY },
    stallTimeoutMs: 2_000,
    log: () => {},
    ...over,
  };
}

/** A deterministic adapter: no real sleeping, no real jitter, a bounded retry budget. */
export function testAnthropicAdapter(over: Parameters<typeof createAnthropicMessagesAdapter>[0] = {}): ProviderAdapter {
  return createAnthropicMessagesAdapter({
    catalog: testAnthropicCatalog(),
    retry: { maxRetries: 3, random: () => 0.5, sleep: async () => {} },
    requestTimeoutMs: 5_000,
    ...over,
  });
}

// --- helpers ------------------------------------------------------------------------------------------

export async function collectEvents(adapter: ProviderAdapter, req: TurnRequest, ctx: ProviderContext): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of adapter.streamTurn(req, ctx)) events.push(event);
  return events;
}

export async function foldTurn(adapter: ProviderAdapter, req: TurnRequest, ctx: ProviderContext): Promise<FoldedProviderTurn> {
  return await foldProviderStream(adapter.streamTurn(req, ctx));
}

/** Folds a turn and returns the error it FAILED with. A turn that succeeds is itself the failure. */
export async function foldFailure(adapter: ProviderAdapter, req: TurnRequest, ctx: ProviderContext): Promise<Error & { status?: number; providerCode?: string }> {
  try {
    await foldTurn(adapter, req, ctx);
  } catch (err) {
    return err as Error & { status?: number; providerCode?: string };
  }
  throw new Error("expected the turn to fail, but it completed");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, saw ${a}`);
}

const user = (text: string): TurnRequest["messages"][number] => ({ role: "user", content: text });

// --- the fake's scenario table -------------------------------------------------------------------------

/** A capture (F)-shaped turn: a thinking block (with a signature), then text, then a tool call. */
const FULL_TURN = {
  blocks: [
    { type: "thinking" as const, chunks: ["let me ", "think"], signature: "sig-full-1" },
    { type: "text" as const, chunks: ["hello ", "world"] },
    { type: "tool_use" as const, id: "call_1", name: "Read", jsonChunks: ['{"path":', '"/tmp/x"}'] },
  ],
  stopReason: "tool_use" as const,
  ping: true,
  usage: { input_tokens: 11, output_tokens: 7 },
};

export function anthropicCorpusRoutes(): FakeRoute[] {
  return anthropicFakeRoutes({
    messages: {
      [ANTHROPIC_MODELS.main]: () => anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["hi"] }], usage: { input_tokens: 3, output_tokens: 1 } }),
      [ANTHROPIC_MODELS.full]: () => anthropicTurnResponse(FULL_TURN),
      [ANTHROPIC_MODELS.multiTool]: () =>
        anthropicTurnResponse({
          blocks: [
            { type: "tool_use", id: "call_a", name: "Read", jsonChunks: ['{"path":"/a"}'] },
            { type: "tool_use", id: "call_b", name: "Write", jsonChunks: ['{"path":"/b"}'] },
          ],
          stopReason: "tool_use",
        }),
      [ANTHROPIC_MODELS.fragmented]: () =>
        anthropicTurnResponse({
          blocks: [{ type: "tool_use", id: "call_f", name: "Read", jsonChunks: ['{"pa', 'th":"', '/frag', 'mented"', "}"] }],
          stopReason: "tool_use",
        }),
      // dropAfter 4 = message_start, content_block_start, two thinking deltas -- the stream dies
      // INSIDE the thinking block, before its `content_block_stop` and before any `signature_delta`.
      [ANTHROPIC_MODELS.dropMidThinking]: () =>
        anthropicTurnResponse({ blocks: [{ type: "thinking", chunks: ["half a ", "thought"], signature: "sig-never-seen" }, { type: "text", chunks: ["tail"] }] }, { dropAfter: 4 }),
      [ANTHROPIC_MODELS.dropAfterBlocks]: () => anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["partial"] }] }, { dropAfter: 3 }),
      [ANTHROPIC_MODELS.retry529]: [anthropicError(529, "overloaded_error"), anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["recovered"] }] })],
      [ANTHROPIC_MODELS.retryAfter]: [anthropicError(429, "rate_limit_error", "slow down", { "retry-after": "2" }), anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["after"] }] })],
      [ANTHROPIC_MODELS.auth]: () => anthropicError(401, "authentication_error", "invalid x-api-key"),
      [ANTHROPIC_MODELS.rateLimit]: () =>
        anthropicError(429, "rate_limit_error", "too many requests", { "retry-after": "1", "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-requests-remaining": "0" }),
      [ANTHROPIC_MODELS.stall]: () => stalledResponse(1_000),
      [ANTHROPIC_MODELS.lateCapture]: () =>
        anthropicTurnResponse({
          blocks: [
            { type: "thinking", chunks: ["deferred"], signature: "sig-late-1" },
            { type: "text", chunks: ["after"] },
            { type: "tool_use", id: "call_l", name: "Read", jsonChunks: ['{"path":"/l"}'] },
          ],
          stopReason: "tool_use",
        }),
      // The SAME frames, cut one short of `message_stop`: the thinking block is COMPLETE at its own
      // `content_block_stop` and is being held, and the event its row names never arrives.
      [ANTHROPIC_MODELS.lateCaptureDropped]: () =>
        anthropicTurnResponse(
          {
            blocks: [
              { type: "thinking", chunks: ["deferred"], signature: "sig-late-1" },
              { type: "text", chunks: ["after"] },
              { type: "tool_use", id: "call_l", name: "Read", jsonChunks: ['{"path":"/l"}'] },
            ],
            stopReason: "tool_use",
          },
          { dropAfter: 12 },
        ),
      [ANTHROPIC_MODELS.slow]: () => {
        // Frames after the first text delta are DELAYED, so the abort in the mid-stream cancellation
        // case interrupts a read that is genuinely in flight -- aborting between two already-buffered
        // frames would prove nothing about cancellation reaching the transport.
        const frames = anthropicSseFrames({ blocks: [{ type: "text", chunks: ["first", "second"] }] });
        return sseResponse(frames.map((frame, index) => (index >= 3 ? { ...frame, delayMs: 1_000 } : frame)));
      },
      [ANTHROPIC_MODELS.malformed]: () => sseResponse([{ event: "message_start", data: "{not json" }]),
      // A LONG human message followed by the structured code: the exact envelope shape that makes
      // "parse the code off the FULL body, before truncation" a real requirement.
      [ANTHROPIC_MODELS.providerCode]: () => anthropicError(400, "invalid_request_error", "x".repeat(600)),
      [ANTHROPIC_MODELS.usage]: () =>
        anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["counted"] }], usage: { input_tokens: 101, output_tokens: 37, cache_read_input_tokens: 12, cache_creation_input_tokens: 5 } }),
      [ANTHROPIC_MODELS.redacted]: () =>
        anthropicTurnResponse({ blocks: [{ type: "redacted_thinking", data: "REDACTED-OPAQUE-1" }, { type: "text", chunks: ["after redaction"] }] }),
      [ANTHROPIC_MODELS.replay]: (_rec, attempt) =>
        attempt === 1
          ? anthropicTurnResponse({
              blocks: [
                { type: "thinking", chunks: ["deep"], signature: "sig-replay-1" },
                { type: "redacted_thinking", data: "REDACTED-REPLAY-1" },
                { type: "tool_use", id: "call_r", name: "Read", jsonChunks: ['{"path":"/r"}'] },
              ],
              stopReason: "tool_use",
            })
          : anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["done"] }] }),
      [ANTHROPIC_MODELS.noTools]: () => anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["never reached"] }] }),
      [ANTHROPIC_MODELS.noVision]: () => anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["never reached"] }] }),
      [ANTHROPIC_MODELS.capped]: () => anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["capped ok"] }] }),
      [ANTHROPIC_MODELS.noEfforts]: () => anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["never reached"] }] }),
    },
    models: (recorded) => {
      // Page 1 carries a malformed row, a duplicate and `has_more`; page 2 closes the list. Discovery
      // must report the duplicate, drop the malformed row and never read absence as removal.
      const after = new URL(`http://x${recorded.path}${recorded.search}`).searchParams.get("after_id");
      if (after === null) {
        return jsonResponse({
          data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }, { id: "claude-sonnet-5" }, { nope: true }, { id: "claude-haiku-4-5" }],
          has_more: true,
          last_id: "claude-haiku-4-5",
        });
      }
      return jsonResponse({ data: [{ id: "claude-opus-4-1", display_name: "Claude Opus 4.1" }], has_more: false, last_id: "claude-opus-4-1" });
    },
    countTokens: (recorded) => jsonResponse({ input_tokens: JSON.parse(recorded.body).messages.length * 100 }),
  });
}

// --- the cases ------------------------------------------------------------------------------------------

export function anthropicCorpusCases(): Partial<Record<CorpusCaseId, CorpusCaseImpl>> {
  const adapter = testAnthropicAdapter();
  const ctxFor = (fake: FakeServer): ProviderContext => testContext(fake.url);
  const lastRequest = (fake: FakeServer) => {
    const requests = requestsTo(fake, "/v1/messages");
    const last = requests[requests.length - 1];
    assert(last !== undefined, "the fake received no /v1/messages request at all");
    return last;
  };

  return {
    "serialization-and-headers": async ({ fake, model: id }) => {
      const before = fake.requests.length;
      await foldTurn(
        adapter,
        {
          model: id,
          system: "winter-system",
          messages: [user("hello")],
          tools: [{ name: "Read", description: "read", inputSchema: { type: "object" } }],
          toolChoice: { type: "tool", name: "Read" },
        },
        ctxFor(fake),
      );
      assert(fake.requests.length === before + 1, "exactly one request should have been sent");
      assertAnthropicRequest(lastRequest(fake), {
        model: id,
        system: "winter-system",
        stream: true,
        maxTokens: 4096,
        roles: ["user"],
        blockTypes: ["text"],
        toolNames: ["Read"],
        toolChoice: { type: "tool", name: "Read" },
      });
    },

    "streaming-order": async ({ fake }) => {
      const events = await collectEvents(adapter, { model: ANTHROPIC_MODELS.full, messages: [user("go")] }, ctxFor(fake));
      // Capture (F)'s own ordering: one completion per block, in the order the wire produced them,
      // with `ping` filtered out entirely and nothing coalesced or reordered.
      eq(
        events.map((e) => e.type),
        ["message_start", "native_thinking_block", "text_delta", "text_delta", "tool_call_start", "tool_call_delta", "tool_call_delta", "tool_call_end", "usage", "done"],
        "the normalized event order",
      );
      const turn = await foldTurn(adapter, { model: ANTHROPIC_MODELS.full, messages: [user("go")] }, ctxFor(fake));
      eq(turn.thinking?.blocks, [{ type: "thinking", thinking: "let me think", signature: "sig-full-1" }], "the folded in-dialect thinking block");
    },

    "tool-call-single": async ({ fake }) => {
      const turn = await foldTurn(adapter, { model: ANTHROPIC_MODELS.full, messages: [user("go")] }, ctxFor(fake));
      assert(turn.kind === "tool_use", `expected a tool_use turn, saw ${turn.kind}`);
      eq(turn.calls, [{ id: "call_1", name: "Read", input: { path: "/tmp/x" } }], "the single parsed call");
      eq(turn.text, "hello world", "the leading text a real model returns alongside its call");
    },

    "tool-call-multiple": async ({ fake }) => {
      const turn = await foldTurn(adapter, { model: ANTHROPIC_MODELS.multiTool, messages: [user("go")] }, ctxFor(fake));
      assert(turn.kind === "tool_use", "expected a tool_use turn");
      eq(turn.calls, [{ id: "call_a", name: "Read", input: { path: "/a" } }, { id: "call_b", name: "Write", input: { path: "/b" } }], "both calls, each with its own id/name/arguments");
    },

    "tool-call-fragmented": async ({ fake }) => {
      const turn = await foldTurn(adapter, { model: ANTHROPIC_MODELS.fragmented, messages: [user("go")] }, ctxFor(fake));
      assert(turn.kind === "tool_use", "expected a tool_use turn");
      eq(turn.calls[0]?.input, { path: "/fragmented" }, "five argument deltas reassembled into one object");
    },

    "tool-result-replay": async ({ fake }) => {
      await foldTurn(
        adapter,
        {
          model: ANTHROPIC_MODELS.main,
          messages: [
            user("read it"),
            { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "Read", input: { path: "/tmp/x" } }] },
            { role: "tool", content: [{ type: "tool_result", tool_use_id: "call_1", content: "file body" }] },
          ],
        },
        ctxFor(fake),
      );
      const recorded = lastRequest(fake);
      // The wire has NO tool role: a tool result rides a `user` message, in the family's own shape.
      assertAnthropicRequest(recorded, { roles: ["user", "assistant", "user"], blockTypes: ["text", "tool_use", "tool_result"] });
      eq(messageBlocks(recorded, 2), [{ type: "tool_result", tool_use_id: "call_1", content: "file body" }], "the replayed tool_result block");
    },

    "cancel-pre-header": async ({ fake }) => {
      const before = fake.requests.length;
      const controller = new AbortController();
      controller.abort();
      const err = await foldFailure(adapter, { model: ANTHROPIC_MODELS.main, messages: [user("go")], signal: controller.signal }, ctxFor(fake));
      assert(/aborted/.test(err.message), `expected an aborted failure, saw ${err.message}`);
      assert(fake.requests.length === before, "an abort BEFORE the first byte must not reach the provider at all");
    },

    "cancel-mid-stream": async ({ fake }) => {
      const controller = new AbortController();
      const stream = adapter.streamTurn({ model: ANTHROPIC_MODELS.slow, messages: [user("go")], signal: controller.signal }, ctxFor(fake));
      const seen: ProviderEvent[] = [];
      for await (const event of stream) {
        seen.push(event);
        if (event.type === "text_delta") controller.abort();
      }
      const last = seen[seen.length - 1];
      assert(last?.type === "error", `expected the stream to end in an error, saw ${last?.type}`);
      assert(last.error.code === "aborted", `expected an aborted error, saw ${last.error.code}`);
      assert(!seen.some((e) => e.type === "done"), "an aborted stream must never report a completed turn");
    },

    "usage-accounting": async ({ fake }) => {
      const turn = await foldTurn(adapter, { model: ANTHROPIC_MODELS.usage, messages: [user("go")] }, ctxFor(fake));
      eq(turn.usage, { inputTokens: 101, outputTokens: 37, cacheReadTokens: 12, cacheWriteTokens: 5 }, "the usage counters, including both prompt-caching fields");
    },

    "error-auth": async ({ fake }) => {
      const err = await foldFailure(adapter, { model: ANTHROPIC_MODELS.auth, messages: [user("go")] }, ctxFor(fake));
      assert(err.status === 401, `expected status 401, saw ${String(err.status)}`);
      assert(err.providerCode === "authentication_error", `expected the provider's own code, saw ${String(err.providerCode)}`);
      assert(/\(auth\)/.test(err.message), `expected the auth taxonomy, saw ${err.message}`);
    },

    "error-rate-limit": async ({ fake }) => {
      const events = await collectEvents(adapter, { model: ANTHROPIC_MODELS.rateLimit, messages: [user("go")] }, ctxFor(fake));
      // R6-B: a 429 is `api_retry` + a normalized `rate_limit` error, NEVER a `rate_limit` event
      // (whose vocabulary is subscription-shaped). Header-derived limits never become events.
      assert(!events.some((e) => e.type === "rate_limit"), "a 429 must never produce a subscription-quota rate_limit event");
      const retries = events.filter((e): e is Extract<ProviderEvent, { type: "retry" }> => e.type === "retry");
      assert(retries.length > 0, "a 429 must be announced as a retry");
      eq(retries[0]?.error, "rate_limit", "the pinned api_retry error member");
      eq(retries[0]?.errorStatus, 429, "the pinned api_retry error_status");
      const failure = events[events.length - 1];
      assert(failure?.type === "error" && failure.error.code === "rate_limit", "the exhausted retry budget surfaces as a rate_limit error");
    },

    "error-timeout": async ({ fake }) => {
      const stallCtx = testContext(fake.url, { stallTimeoutMs: 150 });
      const err = await foldFailure(adapter, { model: ANTHROPIC_MODELS.stall, messages: [user("go")] }, stallCtx);
      assert(/\(stall\)/.test(err.message), `expected a typed stall, saw ${err.message}`);
    },

    "error-network": async ({ fake }) => {
      // A dropped upstream connection: the stream ends before `message_stop`. Normalized to
      // `network` with NO HTTP status -- absent, never null -- and never reported as a finished turn.
      const err = await foldFailure(adapter, { model: ANTHROPIC_MODELS.dropAfterBlocks, messages: [user("go")] }, ctxFor(fake));
      assert(/\(network\)/.test(err.message), `expected a network failure, saw ${err.message}`);
      assert(!("status" in err), "a connection error carries NO status key at all");
    },

    "error-malformed": async ({ fake }) => {
      const err = await foldFailure(adapter, { model: ANTHROPIC_MODELS.malformed, messages: [user("go")] }, ctxFor(fake));
      assert(/\(bad_request\)/.test(err.message), `expected a bad_request, saw ${err.message}`);
      assert(/could not decode/.test(err.message), "the failure should name the undecodable frame");
    },

    "error-provider-codes": async ({ fake }) => {
      const err = await foldFailure(adapter, { model: ANTHROPIC_MODELS.providerCode, messages: [user("go")] }, ctxFor(fake));
      // The code is parsed off the FULL body, before the 200-char snippet cap -- the envelope puts
      // 600 characters of human message ahead of it.
      assert(err.providerCode === "invalid_request_error", `expected the verbatim provider code, saw ${String(err.providerCode)}`);
      assert(err.message.length < 600, "the message reaching a frame must be bounded");
    },

    "retry-after-no-replay": async ({ fake }) => {
      const events = await collectEvents(adapter, { model: ANTHROPIC_MODELS.retryAfter, messages: [user("go")] }, ctxFor(fake));
      const retry = events.find((e): e is Extract<ProviderEvent, { type: "retry" }> => e.type === "retry");
      assert(retry !== undefined, "the 429 should have produced one retry");
      eq(retry.retryDelayMs, 2000, "`Retry-After: 2` REPLACES the jittered schedule");
      assert(events.some((e) => e.type === "done"), "the retry should have succeeded on the second attempt");

      // ...and NOTHING is replayed once the first byte was consumed: a stream that dies mid-turn
      // produces exactly ONE request, never a second attempt.
      const before = requestsTo(fake, "/v1/messages").length;
      await foldFailure(adapter, { model: ANTHROPIC_MODELS.dropAfterBlocks, messages: [user("go")] }, ctxFor(fake));
      eq(requestsTo(fake, "/v1/messages").length - before, 1, "a mid-stream failure must never be replayed");
    },

    "effort-mapping": async ({ fake }) => {
      await foldTurn(adapter, { model: ANTHROPIC_MODELS.main, messages: [user("go")], effort: "high" }, ctxFor(fake));
      eq(anthropicBody(lastRequest(fake))["thinking"], { type: "enabled", budget_tokens: 16384 }, "a VERIFIED effort maps onto the model's own thinking budget");

      // An effort the model's row does not verify is refused BEFORE the request -- proved by the
      // request count, which is the only way to tell "rejected before" from "rejected after".
      const before = requestsTo(fake, "/v1/messages").length;
      const err = await foldFailure(adapter, { model: ANTHROPIC_MODELS.noEfforts, messages: [user("go")], effort: "high" }, ctxFor(fake));
      assert(/no effort vocabulary/.test(err.message), `expected a vocabulary refusal, saw ${err.message}`);
      eq(requestsTo(fake, "/v1/messages").length, before, "an unverified effort must never reach the wire");
    },

    "opaque-continuation": async ({ fake }) => {
      // (a) A COMPLETE block is captured only at its completion event.
      const turn = await foldTurn(adapter, { model: ANTHROPIC_MODELS.replay, messages: [user("go")] }, ctxFor(fake));
      eq(
        turn.thinking?.blocks,
        [{ type: "thinking", thinking: "deep", signature: "sig-replay-1" }, { type: "redacted_thinking", data: "REDACTED-REPLAY-1" }],
        "both in-dialect blocks, complete, with their real signature and opaque data",
      );

      // (b) A PARTIAL block is never captured: the stream dies inside the thinking block.
      const partial = await collectEvents(adapter, { model: ANTHROPIC_MODELS.dropMidThinking, messages: [user("go")] }, ctxFor(fake));
      assert(!partial.some((e) => e.type === "native_thinking_block"), "a thinking block whose completion event never arrived must never be captured");

      // (c) Replayed UNCHANGED, in order, on the next request.
      assert(turn.kind === "tool_use", "expected the first turn to end in a tool call");
      await foldTurn(
        adapter,
        {
          model: ANTHROPIC_MODELS.replay,
          messages: [
            user("go"),
            { role: "assistant", content: [...(turn.thinking?.blocks ?? []), { type: "tool_use", id: "call_r", name: "Read", input: { path: "/r" } }] },
            { role: "tool", content: [{ type: "tool_result", tool_use_id: "call_r", content: "ok" }] },
          ],
        },
        ctxFor(fake),
      );
      const replayed = lastRequest(fake);
      eq(flattenBlockTypes(JSON.parse(replayed.body).messages), ["text", "thinking", "redacted_thinking", "tool_use", "tool_result"], "the block ORDER is identical on replay");
      eq(
        messageBlocks(replayed, 1).slice(0, 2),
        [{ type: "thinking", thinking: "deep", signature: "sig-replay-1" }, { type: "redacted_thinking", data: "REDACTED-REPLAY-1" }],
        "the signature and the redacted payload survive the round trip byte-for-byte",
      );
    },

    "limit-rejection": async ({ fake }) => {
      const before = requestsTo(fake, "/v1/messages").length;
      const err = await foldFailure(
        adapter,
        { model: ANTHROPIC_MODELS.capped, messages: [user("go")], thinking: { type: "enabled", budgetTokens: 4096 } },
        ctxFor(fake),
      );
      assert(/does not fit inside max_tokens/.test(err.message), `expected a limit refusal, saw ${err.message}`);
      eq(requestsTo(fake, "/v1/messages").length, before, "an over-limit request must never reach the wire");
    },

    "vision-where-advertised": async ({ fake }) => {
      const image = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: "aGVsbG8=" } };
      await foldTurn(adapter, { model: ANTHROPIC_MODELS.main, messages: [{ role: "user", content: [image] }] }, ctxFor(fake));
      eq(messageBlocks(lastRequest(fake), 0), [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }], "the image block in the family's own shape");

      const before = requestsTo(fake, "/v1/messages").length;
      const err = await foldFailure(adapter, { model: ANTHROPIC_MODELS.noVision, messages: [{ role: "user", content: [image] }] }, ctxFor(fake));
      assert(/does not advertise image input/.test(err.message), `expected a vision refusal, saw ${err.message}`);
      eq(requestsTo(fake, "/v1/messages").length, before, "an unadvertised modality must never reach the wire");
    },

    "discovery-edge-cases": async ({ fake }) => {
      const result = await discoverModels(adapter, { ...testContext(fake.url), limits: { maxBytes: 256 * 1024, maxItems: 50, timeoutMs: 3_000 } });
      eq(result.models.map((m) => m.id), ["claude-sonnet-5", "claude-haiku-4-5", "claude-opus-4-1"], "the paginated, deduped, validated model list");
      assert(result.warnings.some((w) => /duplicate/.test(w)), "a duplicate id is reported rather than silently kept twice");
      assert(result.warnings.some((w) => /no usable id/.test(w)), "a malformed row is dropped and counted");

      const bounded = await discoverModels(adapter, { ...testContext(fake.url), limits: { maxBytes: 256 * 1024, maxItems: 2, timeoutMs: 3_000 } });
      assert(bounded.models.length <= 2, "the item bound is enforced");
      assert(bounded.partial, "a truncated catalog is reported as PARTIAL, never as removal");
    },

    "identity-across-resume": async ({ fake }) => {
      const catalog = testAnthropicCatalog();
      const identity = () => {
        const registry = createRegistry(catalog);
        registry.register(adapter);
        const resolved = registry.resolve({ model: ANTHROPIC_MODELS.main, provider: { providerId: "anthropic" } });
        assert(!(resolved instanceof Error), "the model should resolve");
        return { providerId: resolved.providerId, modelKey: resolved.modelKey, providerModelId: resolved.providerModelId, adapterId: resolved.adapterId, adapterVersion: adapter.version, continuationDomain: resolved.continuationDomain, catalogVersion: resolved.catalogVersion };
      };
      const before = identity();
      // A "resume" rebuilds the registry from the same catalog -- the identity must be identical.
      eq(identity(), before, "the resolved identity across a resume");

      const requestsBefore = requestsTo(fake, "/v1/messages").length;
      await foldTurn(adapter, { model: before.providerModelId, messages: [user("one")] }, ctxFor(fake));
      await foldTurn(adapter, { model: before.providerModelId, messages: [user("two")] }, ctxFor(fake));
      const sent = requestsTo(fake, "/v1/messages").slice(requestsBefore).map((r) => anthropicBody(r)["model"]);
      eq(sent, [ANTHROPIC_MODELS.main, ANTHROPIC_MODELS.main], "the same wire model id on both turns");
    },

    "no-silent-tool-dropping": async ({ fake }) => {
      const before = requestsTo(fake, "/v1/messages").length;
      const err = await foldFailure(
        adapter,
        { model: ANTHROPIC_MODELS.noTools, messages: [user("go")], tools: [{ name: "Read", description: "read", inputSchema: { type: "object" } }] },
        ctxFor(fake),
      );
      assert(/cannot be sent natively/.test(err.message), `expected a capability-negotiation failure, saw ${err.message}`);
      eq(requestsTo(fake, "/v1/messages").length, before, "the tools are never dropped and the turn sent as plain chat");
    },
  };
}
