// Phase 6 Task 6 (Lane B): the Google GenerateContent family's WS-13 §13 corpus.
//
// ADDED beside `corpus/runner.ts`, which is FROZEN (R6-12). Same two rules as the Anthropic corpus:
// the ground truth for what the provider was ASKED is `fake.requests`, and the normalized stream is
// consumed by the REAL fold.
//
// WHERE THIS FAMILY GENUINELY DIFFERS -- and where the corpus therefore asks a different question of
// the same case:
//   - the model id is IN THE PATH, so `serialization-and-headers` asserts on the path and `?alt=sse`;
//   - there is no per-block terminator, so `opaque-continuation` is anchored on the chunk carrying
//     `finishReason`;
//   - a `functionCall` arrives COMPLETE in one part, so `tool-call-fragmented` is a recorded SKIP
//     with a reason -- a fact about the family, never a case quietly declined.
import type { ReasoningCapabilities, WinterCatalog, WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { createMemoryCredentialStore, createRegistry, discoverModels } from "@yanlinglabs/winter-provider-runtime";
import type { ProviderAdapter, ProviderContext, ProviderEvent, TurnRequest } from "@yanlinglabs/winter-provider-runtime";
import { createGoogleGenerateContentAdapter } from "../../../provider-runtime/src/adapters/google/index.ts";
import { foldProviderStream, type FoldedProviderTurn } from "../../../runtime/src/provider/bridge.ts";
import { assertGeminiRequest, geminiBody, geminiContents, geminiError, geminiFakeRoutes, geminiSseFrames, geminiStreamResponse, partKind, type GeminiPart } from "../fakes/gemini.ts";
import { jsonResponse, sseResponse, stalledResponse, type FakeRoute, type FakeServer, type RecordedRequest } from "../fakes/server.ts";
import type { CorpusCaseId, CorpusCaseImpl } from "./runner.ts";

const evidence = <T>(value: T): { value: T; source: "upstream-static"; confidence: "inferred"; observedAt: string } => ({
  value,
  source: "upstream-static",
  confidence: "inferred",
  observedAt: "2026-09-05T00:00:00Z",
});

function model(over: Partial<WinterModelDescriptor> & { key: string; upstreamId: string }): WinterModelDescriptor {
  return {
    providerId: "google",
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

/**
 * The reasoning evidence the fixture rows carry.
 *
 * DELIBERATELY RICHER THAN THE SEED ROW, and the difference is itself a finding: the compiled
 * `google/gemini-2.5-pro` row declares `efforts: []` and NO `summaryRequest`, so against the shipped
 * catalog every effort level is refused and `includeThoughts` is never requested. Both are Lane X's
 * to evidence; the fixture declares them so the mapping can be proved at all.
 */
const googleReasoning = (key: string): ReasoningCapabilities => ({
  supported: evidence(true),
  efforts: ["low", "medium", "high", "xhigh", "max"],
  continuation: "opaque-provider-state",
  readableState: evidence("summary" as const),
  summaryRequest: evidence({ field: "thinkingConfig.includeThoughts", values: ["true"] }),
  completionEvent: evidence("the chunk carrying finishReason"),
  continuationDomain: evidence([key]),
});

export const GOOGLE_MODELS = {
  main: "gemini-2.5-pro",
  full: "sc-g-full",
  multiTool: "sc-g-multi-tools",
  dropBeforeFinish: "sc-g-drop-before-finish",
  retry503: "sc-g-503-then-200",
  retryAfter: "sc-g-retry-after",
  auth: "sc-g-401",
  rateLimit: "sc-g-429",
  stall: "sc-g-stall",
  malformed: "sc-g-malformed",
  providerCode: "sc-g-provider-code",
  usage: "sc-g-usage",
  replay: "sc-g-replay",
  refusal: "sc-g-refusal",
  slow: "sc-g-slow",
  noTools: "sc-g-no-tools",
  noVision: "sc-g-no-vision",
  capped: "sc-g-capped",
  noEfforts: "sc-g-no-efforts",
  /** Reports `thoughtsTokenCount` on an EARLY chunk and only `candidatesTokenCount` on the last one. */
  splitUsage: "sc-g-split-usage",
  /** A SIGNED `thought: true` part followed by an UNSIGNED text part -- the I4 mis-attachment shape. */
  signedThought: "sc-g-signed-thought",
  /** A stream that finishes but sends NO `usageMetadata` — the A/B that makes a completion marker observable. */
  lateUsage: "sc-g-late-usage",
  /** The SAME stream on a row with no completion-event evidence, so the marker is the only variable. */
  lateUsageDefault: "sc-g-late-usage-default",
} as const;

export function testGoogleCatalog(): WinterCatalog {
  const reasoningIds = [GOOGLE_MODELS.main, GOOGLE_MODELS.full, GOOGLE_MODELS.multiTool, GOOGLE_MODELS.dropBeforeFinish, GOOGLE_MODELS.usage, GOOGLE_MODELS.replay, GOOGLE_MODELS.refusal, GOOGLE_MODELS.splitUsage, GOOGLE_MODELS.signedThought, GOOGLE_MODELS.lateUsageDefault];
  return {
    schemaVersion: 1,
    catalogVersion: "0.0.0-lane-b-fixture",
    upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" },
    providers: [
      {
        id: "google",
        displayName: "Google AI Studio",
        protocols: ["google-generate-content"],
        authKinds: ["api-key"],
        defaultEndpoints: { api: "https://generativelanguage.googleapis.com" },
        modelDiscovery: "provider-native",
        liveCatalogAuthority: "authoritative",
        adapterId: "winter.google-generate-content",
        family: "google",
        upstream: { project: "winter", commit: "", sourcePaths: [] },
        risk: { class: "approved", reasons: [] },
        scope: "llm",
        // WS-13b §1: both fields are REQUIRED on every provider row, so a fixture states its
        // own basis rather than inheriting one — a row-shape change fails HERE, at the fixture.
        pricingBasis: "token",
        admission: { basis: "api-key", citation: "fixture:google-corpus" },
      },
    ],
    models: [
      ...reasoningIds.map((id) => model({ key: `google/${id}`, upstreamId: id, reasoning: googleReasoning(`google/${id}`), contextWindow: evidence(1_048_576) })),
      model({ key: `google/${GOOGLE_MODELS.noTools}`, upstreamId: GOOGLE_MODELS.noTools, toolCalling: evidence("none" as const), nativeTools: evidence(false) }),
      model({ key: `google/${GOOGLE_MODELS.noVision}`, upstreamId: GOOGLE_MODELS.noVision, inputModalities: evidence(["text"]) }),
      model({ key: `google/${GOOGLE_MODELS.capped}`, upstreamId: GOOGLE_MODELS.capped, maxOutputTokens: evidence(2048), reasoning: googleReasoning(`google/${GOOGLE_MODELS.capped}`) }),
      model({ key: `google/${GOOGLE_MODELS.noEfforts}`, upstreamId: GOOGLE_MODELS.noEfforts, reasoning: { supported: evidence(true), efforts: [], continuation: "none" } }),
      // Minor 7: this row's own evidence names a DIFFERENT completion event, and the adapter honours it.
      model({
        key: `google/${GOOGLE_MODELS.lateUsage}`,
        upstreamId: GOOGLE_MODELS.lateUsage,
        reasoning: { ...googleReasoning(`google/${GOOGLE_MODELS.lateUsage}`), completionEvent: evidence("the chunk carrying usageMetadata") },
      }),
    ],
  };
}

export const GOOGLE_TEST_KEY = "test-key-google";
/** The opaque marker every `thoughtSignature` negative searches for. Distinctive on purpose: a vague value makes the negative vacuous. */
export const GOOGLE_SIGNATURE = "OPAQUE-THOUGHT-SIG-1";
/**
 * The shape of a minted tool-call id.
 *
 * This family's `functionCall` carries no id, so the adapter mints one -- NONCE-PREFIXED, so two
 * turns in one session can never share an id (the engine correlates a subagent's frames to its
 * parent by tool_use id). A fixture therefore asserts the SHAPE and reads the value, rather than
 * pinning a counter that would make the collision it prevents invisible again.
 */
export const CALL_ID = /^google-call-[0-9a-f]{8}-(\d+)$/;

export function googleContext(baseUrl: string, over: Partial<ProviderContext> = {}): ProviderContext {
  return {
    connection: { providerId: "google", baseUrl, local: true },
    credentials: createMemoryCredentialStore(),
    authRef: { kind: "inline", value: GOOGLE_TEST_KEY },
    stallTimeoutMs: 2_000,
    log: () => {},
    ...over,
  };
}

export function testGoogleAdapter(over: Parameters<typeof createGoogleGenerateContentAdapter>[0] = {}): ProviderAdapter {
  return createGoogleGenerateContentAdapter({
    catalog: testGoogleCatalog(),
    retry: { maxRetries: 3, random: () => 0.5, sleep: async () => {} },
    requestTimeoutMs: 5_000,
    ...over,
  });
}

export async function collectEvents(adapter: ProviderAdapter, req: TurnRequest, ctx: ProviderContext): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of adapter.streamTurn(req, ctx)) events.push(event);
  return events;
}

export async function foldTurn(adapter: ProviderAdapter, req: TurnRequest, ctx: ProviderContext): Promise<FoldedProviderTurn> {
  return await foldProviderStream(adapter.streamTurn(req, ctx));
}

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

// --- the fake's scenario table ---------------------------------------------------------------------------

/**
 * The signature-bearing turn, deliberately split so the SIGNATURE and the FINISH REASON arrive in
 * DIFFERENT chunks. That split is what makes "captured only from the completing chunk" a testable
 * rule: a normalizer that emitted native state as soon as it saw a signature would emit it one chunk
 * early, and this script is the only shape that notices.
 */
const REPLAY_CHUNKS = [
  { parts: [{ text: "thinking out loud", thought: true } as GeminiPart] },
  { parts: [{ text: "here goes" } as GeminiPart, { functionCall: { name: "Read", args: { path: "/r" } }, thoughtSignature: GOOGLE_SIGNATURE } as GeminiPart] },
  { finishReason: "STOP" as const, usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, thoughtsTokenCount: 2 } },
];

/**
 * The scripted answers, keyed by model id.
 *
 * EXPORTED so the Vertex corpus serves the SAME scripts through its own routes: the two transports
 * share a dialect and a normalizer, so scripting them differently would test the scripts rather than
 * the adapters.
 */
export function googleScenarioStream(): NonNullable<Parameters<typeof geminiFakeRoutes>[0]["stream"]> {
  return {
    [GOOGLE_MODELS.main]: () => geminiStreamResponse([{ parts: [{ text: "hi" }], modelVersion: "gemini-2.5-pro-001" }, { finishReason: "STOP", usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } }]),
    [GOOGLE_MODELS.full]: () =>
      geminiStreamResponse([
        { parts: [{ text: "reasoning summary", thought: true }] },
        { parts: [{ text: "hello " }] },
        { parts: [{ text: "world" }] },
        { parts: [{ functionCall: { name: "Read", args: { path: "/tmp/x" } }, thoughtSignature: GOOGLE_SIGNATURE }] },
        { finishReason: "STOP", usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 } },
      ]),
    [GOOGLE_MODELS.multiTool]: () =>
      geminiStreamResponse([
        { parts: [{ functionCall: { name: "Read", args: { path: "/a" } } }, { functionCall: { name: "Write", args: { path: "/b" } } }] },
        { finishReason: "STOP" },
      ]),
    // Ends WITHOUT a finishReason: the signature was seen but the turn never completed.
    [GOOGLE_MODELS.dropBeforeFinish]: () => geminiStreamResponse([{ parts: [{ text: "partial", thoughtSignature: GOOGLE_SIGNATURE }] }, { finishReason: "STOP" }], { dropAfter: 1 }),
    [GOOGLE_MODELS.retry503]: [geminiError(503, "UNAVAILABLE"), geminiStreamResponse([{ parts: [{ text: "recovered" }] }, { finishReason: "STOP" }])],
    [GOOGLE_MODELS.retryAfter]: [geminiError(429, "RESOURCE_EXHAUSTED", "slow down", { "retry-after": "2" }), geminiStreamResponse([{ parts: [{ text: "after" }] }, { finishReason: "STOP" }])],
    [GOOGLE_MODELS.auth]: () => geminiError(401, "UNAUTHENTICATED", "API key not valid"),
    [GOOGLE_MODELS.rateLimit]: () => geminiError(429, "RESOURCE_EXHAUSTED", "quota exceeded", { "retry-after": "1", "x-ratelimit-remaining": "0" }),
    [GOOGLE_MODELS.stall]: () => stalledResponse(1_000),
    [GOOGLE_MODELS.malformed]: () => sseResponse([{ data: "{not json" }]),
    [GOOGLE_MODELS.providerCode]: () => geminiError(400, "INVALID_ARGUMENT", "y".repeat(600)),
    [GOOGLE_MODELS.usage]: () =>
      geminiStreamResponse([
        { parts: [{ text: "counted" }] },
        { finishReason: "STOP", usageMetadata: { promptTokenCount: 101, candidatesTokenCount: 30, thoughtsTokenCount: 7, cachedContentTokenCount: 12 } },
      ]),
    [GOOGLE_MODELS.replay]: (_rec, attempt) => (attempt === 1 ? geminiStreamResponse(REPLAY_CHUNKS) : geminiStreamResponse([{ parts: [{ text: "done" }] }, { finishReason: "STOP" }])),
    [GOOGLE_MODELS.refusal]: () => geminiStreamResponse([{ parts: [{ text: "" }], finishReason: "SAFETY" }]),
    [GOOGLE_MODELS.signedThought]: () =>
      geminiStreamResponse([
        { parts: [{ text: "private reasoning", thought: true, thoughtSignature: GOOGLE_SIGNATURE }] },
        { parts: [{ text: "the answer" }] },
        { finishReason: "STOP" },
      ]),
    // The SAME stream serves both rows: it finishes, and it never sends `usageMetadata`. A row whose
    // evidence names the usage chunk as its completion event therefore never sees one — so the
    // MARKER is the only variable between the two outcomes.
    [GOOGLE_MODELS.lateUsage]: () => geminiStreamResponse([{ parts: [{ text: "a", thoughtSignature: GOOGLE_SIGNATURE }] }, { finishReason: "STOP" }]),
    [GOOGLE_MODELS.lateUsageDefault]: () => geminiStreamResponse([{ parts: [{ text: "a", thoughtSignature: GOOGLE_SIGNATURE }] }, { finishReason: "STOP" }]),
    [GOOGLE_MODELS.splitUsage]: () =>
      geminiStreamResponse([
        { parts: [{ text: "thought about it", thought: true }], usageMetadata: { promptTokenCount: 10, thoughtsTokenCount: 9 } },
        { parts: [{ text: "answer" }], finishReason: "STOP", usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 } },
      ]),
    [GOOGLE_MODELS.slow]: () => {
      const frames = geminiSseFrames([{ parts: [{ text: "first" }] }, { parts: [{ text: "second" }] }, { finishReason: "STOP" }]);
      return sseResponse(frames.map((frame, index) => (index >= 1 ? { ...frame, delayMs: 1_000 } : frame)));
    },
    [GOOGLE_MODELS.noTools]: () => geminiStreamResponse([{ parts: [{ text: "never reached" }], finishReason: "STOP" }]),
    [GOOGLE_MODELS.noVision]: () => geminiStreamResponse([{ parts: [{ text: "never reached" }], finishReason: "STOP" }]),
    [GOOGLE_MODELS.capped]: () => geminiStreamResponse([{ parts: [{ text: "capped ok" }], finishReason: "STOP" }]),
    [GOOGLE_MODELS.noEfforts]: () => geminiStreamResponse([{ parts: [{ text: "never reached" }], finishReason: "STOP" }]),
  };
}

/** The Gemini API's own routes: the shared scripts plus this transport's `/v1beta/models` list endpoint. */
export function googleCorpusRoutes(): FakeRoute[] {
  return geminiFakeRoutes({
    stream: googleScenarioStream(),
    models: (recorded) => {
      const token = new URL(`http://x${recorded.path}${recorded.search}`).searchParams.get("pageToken");
      if (token === null) {
        return jsonResponse({
          // A resource-name prefix, a duplicate, and a malformed row -- all three in one page.
          models: [{ name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", inputTokenLimit: 1048576 }, { name: "models/gemini-2.5-pro" }, { displayName: "no name at all" }, { name: "models/gemini-2.5-flash" }],
          nextPageToken: "page-2",
        });
      }
      return jsonResponse({ models: [{ name: "models/gemini-2.0-flash", displayName: "Gemini 2.0 Flash" }] });
    },
    countTokens: (recorded) => jsonResponse({ totalTokens: (JSON.parse(recorded.body).contents as unknown[]).length * 100 }),
  });
}

// --- the cases -------------------------------------------------------------------------------------------

/**
 * What the two Google TRANSPORTS differ in, as far as the corpus can see.
 *
 * The corpus is shared because the QUESTIONS are: Vertex speaks the same dialect through the same
 * normalizer, so asking it a different set would leave the differences untested and duplicate the
 * similarities. What genuinely differs -- the URL shape, the credential, and whether a bounded list
 * endpoint exists at all -- is exactly this config.
 */
export interface GoogleFamilyCorpusConfig {
  adapter: ProviderAdapter;
  context: (fake: FakeServer) => ProviderContext;
  contextWith: (fake: FakeServer, over: Partial<ProviderContext>) => ProviderContext;
  catalog: WinterCatalog;
  providerId: string;
  models: typeof GOOGLE_MODELS;
  /** Recognises this transport's own generation requests among everything the fake saw. */
  isGenerateRequest: (recorded: RecordedRequest) => boolean;
  /** Asserts this transport's own request shape -- headers, path and query -- for the serialization case. */
  assertSerialization: (recorded: RecordedRequest, model: string) => void;
  /** The path a generation for `model` lands on. The identity-across-resume assertion reads it. */
  generatePath: (model: string) => string;
  /** `live` where the transport has a bounded `/models` endpoint; `unsupported` where this phase scopes it out (Vertex). */
  discovery: "live" | "unsupported";
}

export function googleFamilyCorpusCases(config: GoogleFamilyCorpusConfig): Partial<Record<CorpusCaseId, CorpusCaseImpl>> {
  const adapter = config.adapter;
  const MODELS = config.models;
  const ctxFor = config.context;
  const generateRequests = (fake: FakeServer) => fake.requests.filter(config.isGenerateRequest);
  const lastRequest = (fake: FakeServer) => {
    const requests = generateRequests(fake);
    const last = requests[requests.length - 1];
    assert(last !== undefined, "the fake received no generation request at all");
    return last;
  };

  return {
    "serialization-and-headers": async ({ fake, model: id }) => {
      const before = generateRequests(fake).length;
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
      assert(generateRequests(fake).length === before + 1, "exactly one request should have been sent");
      const recorded = lastRequest(fake);
      // The model id and the METHOD are both in the PATH for this family, and `?alt=sse` is what
      // selects SSE framing -- so the transport supplies that half of the assertion.
      config.assertSerialization(recorded, id);
      const body = geminiBody(recorded);
      const system = body["systemInstruction"] as { parts?: Array<{ text?: unknown }> } | undefined;
      eq(system?.parts?.map((p) => p.text).join(""), "winter-system", "the system instruction");
      eq(geminiContents(recorded).map((c) => c.role), ["user"], "the wire roles");
      eq(geminiContents(recorded).flatMap((c) => (c.parts ?? []).map(partKind)), ["text"], "the part ordering");
      eq((body["tools"] as Array<{ functionDeclarations?: Array<{ name?: unknown }> }>)[0]?.functionDeclarations?.map((d) => d.name), ["Read"], "the declared functions");
      eq(body["toolConfig"], { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["Read"] } }, "the tool config");
    },

    "streaming-order": async ({ fake }) => {
      const events = await collectEvents(adapter, { model: MODELS.full, messages: [user("go")] }, ctxFor(fake));
      eq(
        events.map((e) => e.type),
        [
          "message_start",
          // A `thought` part is FOREIGN reasoning and rides its own channel -- never `text_delta`.
          "thinking_summary_delta",
          "text_delta",
          "text_delta",
          "tool_call_start",
          "tool_call_delta",
          "tool_call_end",
          // Native state is emitted ONCE, after the completing chunk.
          "native_state",
          "usage",
          "done",
        ],
        "the normalized event order",
      );
    },

    "tool-call-single": async ({ fake }) => {
      const turn = await foldTurn(adapter, { model: MODELS.full, messages: [user("go")] }, ctxFor(fake));
      assert(turn.kind === "tool_use", `expected a tool_use turn, saw ${turn.kind}`);
      assert(CALL_ID.test(turn.calls[0]?.id ?? ""), `the minted call id should be nonce-prefixed, saw ${JSON.stringify(turn.calls[0]?.id)}`);
      eq(turn.calls.map((c) => ({ name: c.name, input: c.input })), [{ name: "Read", input: { path: "/tmp/x" } }], "the single parsed call");
      eq(turn.text, "hello world", "the leading text a real model returns alongside its call");
      // R6-8: the foreign summary lands on `thinking.summary`, NEVER on the turn's text.
      eq(turn.thinking?.summary, "reasoning summary", "the foreign reasoning summary");
      assert(!(turn.text ?? "").includes("reasoning summary"), "a foreign summary must never become content");
    },

    "tool-call-multiple": async ({ fake }) => {
      const turn = await foldTurn(adapter, { model: MODELS.multiTool, messages: [user("go")] }, ctxFor(fake));
      assert(turn.kind === "tool_use", "expected a tool_use turn");
      eq(turn.calls.map((c) => ({ name: c.name, input: c.input })), [{ name: "Read", input: { path: "/a" } }, { name: "Write", input: { path: "/b" } }], "both calls, each with its own name and arguments");
      const ordinals = turn.calls.map((c) => CALL_ID.exec(c.id)?.[1]);
      eq(ordinals, ["0", "1"], "each call keeps its own ordinal within the turn");
      // ONE nonce per stream: the two calls belong to the same turn and must be distinguishable
      // from any other turn's, not from each other's stream.
      assert(new Set(turn.calls.map((c) => c.id.slice(0, -1))).size === 1, "both calls should share one stream nonce");
    },

    "tool-call-fragmented": async () => ({
      // A FACT about the family, recorded rather than a case quietly declined: this dialect delivers
      // a `functionCall`'s `args` as a complete JSON object inside one part. There are no argument
      // deltas to reassemble, so asserting reassembly would be asserting on the adapter's own
      // single-delta emission rather than on anything the wire does.
      skipped: "this family delivers a functionCall's arguments complete in one part; there is no argument fragmentation to reassemble",
    }),

    "tool-result-replay": async ({ fake }) => {
      await foldTurn(
        adapter,
        {
          model: MODELS.main,
          messages: [
            user("read it"),
            { role: "assistant", content: [{ type: "tool_use", id: "google-call-0", name: "Read", input: { path: "/tmp/x" } }] },
            { role: "tool", content: [{ type: "tool_result", tool_use_id: "google-call-0", content: "file body" }] },
          ],
        },
        ctxFor(fake),
      );
      const contents = geminiContents(lastRequest(fake));
      eq(contents.map((c) => c.role), ["user", "model", "user"], "assistant becomes `model` and a tool result rides a `user` entry");
      // The NAME is recovered from the tool_use that minted the id -- a functionResponse cannot carry
      // an id, and a nameless one would be silently ignored by the model.
      eq(contents[2]?.parts, [{ functionResponse: { name: "Read", response: { output: "file body" } } }], "the replayed functionResponse");
    },

    "cancel-pre-header": async ({ fake }) => {
      // GENERATION requests, not every request the fake saw: a transport may legitimately have
      // contacted a token endpoint first, and what this case asks about is the generation.
      const before = generateRequests(fake).length;
      const controller = new AbortController();
      controller.abort();
      const err = await foldFailure(adapter, { model: MODELS.main, messages: [user("go")], signal: controller.signal }, ctxFor(fake));
      assert(/aborted/.test(err.message), `expected an aborted failure, saw ${err.message}`);
      assert(generateRequests(fake).length === before, "an abort BEFORE the first byte must not reach the provider at all");
    },

    "cancel-mid-stream": async ({ fake }) => {
      const controller = new AbortController();
      const seen: ProviderEvent[] = [];
      for await (const event of adapter.streamTurn({ model: MODELS.slow, messages: [user("go")], signal: controller.signal }, ctxFor(fake))) {
        seen.push(event);
        if (event.type === "text_delta") controller.abort();
      }
      const last = seen[seen.length - 1];
      assert(last?.type === "error" && last.error.code === "aborted", `expected an aborted error, saw ${last?.type}`);
      assert(!seen.some((e) => e.type === "done"), "an aborted stream must never report a completed turn");
      assert(!seen.some((e) => e.type === "native_state"), "an aborted stream must never emit continuation state");
    },

    "usage-accounting": async ({ fake }) => {
      const turn = await foldTurn(adapter, { model: MODELS.usage, messages: [user("go")] }, ctxFor(fake));
      // Reasoning is billed separately from the visible answer, so both are summed into the seam's
      // single `outputTokens`: 30 candidate + 7 thought.
      eq(turn.usage, { inputTokens: 101, outputTokens: 37, cacheReadTokens: 12 }, "the usage counters, with reasoning tokens included in the output count");
    },

    "error-auth": async ({ fake }) => {
      const err = await foldFailure(adapter, { model: MODELS.auth, messages: [user("go")] }, ctxFor(fake));
      assert(err.status === 401, `expected status 401, saw ${String(err.status)}`);
      // This family's `error.code` is the NUMERIC http status, with the machine-readable value in
      // `error.status` -- which is why the shared parser tries three keys rather than one.
      assert(err.providerCode === "UNAUTHENTICATED", `expected the provider's own status code, saw ${String(err.providerCode)}`);
      assert(/\(auth\)/.test(err.message), `expected the auth taxonomy, saw ${err.message}`);
    },

    "error-rate-limit": async ({ fake }) => {
      const events = await collectEvents(adapter, { model: MODELS.rateLimit, messages: [user("go")] }, ctxFor(fake));
      assert(!events.some((e) => e.type === "rate_limit"), "a 429 must never produce a subscription-quota rate_limit event (R6-B)");
      const retries = events.filter((e): e is Extract<ProviderEvent, { type: "retry" }> => e.type === "retry");
      assert(retries.length > 0, "a 429 must be announced as a retry");
      eq(retries[0]?.error, "rate_limit", "the pinned api_retry error member");
      eq(retries[0]?.errorStatus, 429, "the pinned api_retry error_status");
    },

    "error-timeout": async ({ fake }) => {
      const err = await foldFailure(adapter, { model: MODELS.stall, messages: [user("go")] }, config.contextWith(fake, { stallTimeoutMs: 150 }));
      assert(/\(stall\)/.test(err.message), `expected a typed stall, saw ${err.message}`);
    },

    "error-network": async ({ fake }) => {
      const err = await foldFailure(adapter, { model: MODELS.dropBeforeFinish, messages: [user("go")] }, ctxFor(fake));
      assert(/\(network\)/.test(err.message), `expected a network failure, saw ${err.message}`);
      assert(!("status" in err), "a connection error carries NO status key at all");
    },

    "error-malformed": async ({ fake }) => {
      const err = await foldFailure(adapter, { model: MODELS.malformed, messages: [user("go")] }, ctxFor(fake));
      assert(/\(bad_request\)/.test(err.message), `expected a bad_request, saw ${err.message}`);
    },

    "error-provider-codes": async ({ fake }) => {
      const err = await foldFailure(adapter, { model: MODELS.providerCode, messages: [user("go")] }, ctxFor(fake));
      assert(err.providerCode === "INVALID_ARGUMENT", `expected the verbatim provider code, saw ${String(err.providerCode)}`);
      assert(err.message.length < 600, "the message reaching a frame must be bounded");
    },

    "retry-after-no-replay": async ({ fake }) => {
      const events = await collectEvents(adapter, { model: MODELS.retryAfter, messages: [user("go")] }, ctxFor(fake));
      const retry = events.find((e): e is Extract<ProviderEvent, { type: "retry" }> => e.type === "retry");
      assert(retry !== undefined, "the 429 should have produced one retry");
      eq(retry.retryDelayMs, 2000, "`Retry-After: 2` REPLACES the jittered schedule");
      assert(events.some((e) => e.type === "done"), "the retry should have succeeded on the second attempt");

      const before = generateRequests(fake).length;
      await foldFailure(adapter, { model: MODELS.dropBeforeFinish, messages: [user("go")] }, ctxFor(fake));
      eq(generateRequests(fake).length - before, 1, "a mid-stream failure must never be replayed");
    },

    "effort-mapping": async ({ fake }) => {
      await foldTurn(adapter, { model: MODELS.main, messages: [user("go")], effort: "high" }, ctxFor(fake));
      eq((geminiBody(lastRequest(fake))["generationConfig"] as Record<string, unknown>)["thinkingConfig"], { thinkingBudget: 8192 }, "a VERIFIED effort maps onto this family's own thinkingBudget");

      const before = generateRequests(fake).length;
      const err = await foldFailure(adapter, { model: MODELS.noEfforts, messages: [user("go")], effort: "high" }, ctxFor(fake));
      assert(/no effort vocabulary/.test(err.message), `expected a vocabulary refusal, saw ${err.message}`);
      eq(generateRequests(fake).length, before, "an unverified effort must never reach the wire");
    },

    "opaque-continuation": async ({ fake }) => {
      // (a) The signature is captured, keyed to the EXACT part it arrived on.
      const turn = await foldTurn(adapter, { model: MODELS.replay, messages: [user("go")] }, ctxFor(fake));
      assert(turn.kind === "tool_use", "expected the first turn to end in a tool call");
      const callId = turn.calls[0]!.id;
      eq(turn.nativeState?.items, [{ partIndex: 2, kind: "function-call", callId, signature: GOOGLE_SIGNATURE }], "the captured continuation item, keyed to the call it arrived on");

      // (b) A stream that never reaches its completing chunk captures NOTHING -- even though the
      //     signature was already on the wire.
      const partial = await collectEvents(adapter, { model: MODELS.dropBeforeFinish, messages: [user("go")] }, ctxFor(fake));
      assert(!partial.some((e) => e.type === "native_state"), "continuation state whose completing chunk never arrived must never be captured");

      // (c) Replayed onto the EXACT part, inside its own domain.
      await foldTurn(
        adapter,
        {
          model: MODELS.replay,
          messages: [
            user("go"),
            {
              role: "assistant",
              content: [{ type: "text", text: turn.text ?? "" }, { type: "tool_use", id: callId, name: "Read", input: { path: "/r" } }],
              nativeState: { family: "google", continuationDomain: `google/${MODELS.replay}`, items: turn.nativeState?.items ?? [] },
            },
            { role: "tool", content: [{ type: "tool_result", tool_use_id: callId, content: "ok" }] },
          ],
        },
        ctxFor(fake),
      );
      const replayed = geminiContents(lastRequest(fake));
      const modelParts = replayed[1]?.parts ?? [];
      eq(modelParts.map(partKind), ["text", "functionCall"], "the replayed part ordering");
      // The signature is back on the FUNCTION CALL part, not on the text part beside it.
      eq((modelParts[1] as { thoughtSignature?: string }).thoughtSignature, GOOGLE_SIGNATURE, "the signature rides its own part");
      assert((modelParts[0] as { thoughtSignature?: string }).thoughtSignature === undefined, "the text part must not inherit the call's signature");
    },

    "limit-rejection": async ({ fake }) => {
      const before = generateRequests(fake).length;
      const err = await foldFailure(adapter, { model: MODELS.capped, messages: [user("go")], thinking: { type: "enabled", budgetTokens: 4096 } }, ctxFor(fake));
      assert(/does not fit inside maxOutputTokens/.test(err.message), `expected a limit refusal, saw ${err.message}`);
      eq(generateRequests(fake).length, before, "an over-limit request must never reach the wire");
    },

    "vision-where-advertised": async ({ fake }) => {
      const image = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: "aGVsbG8=" } };
      await foldTurn(adapter, { model: MODELS.main, messages: [{ role: "user", content: [image] }] }, ctxFor(fake));
      eq(geminiContents(lastRequest(fake))[0]?.parts, [{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }], "the image part in the family's own shape");

      const before = generateRequests(fake).length;
      const err = await foldFailure(adapter, { model: MODELS.noVision, messages: [{ role: "user", content: [image] }] }, ctxFor(fake));
      assert(/does not advertise image input/.test(err.message), `expected a vision refusal, saw ${err.message}`);
      eq(generateRequests(fake).length, before, "an unadvertised modality must never reach the wire");
    },

    "discovery-edge-cases": async ({ fake }) => {
      if (config.discovery === "unsupported") {
        // NOT a pass by omission: this transport has no bounded model-list endpoint in this phase's
        // scope, and what the case checks is that the absence is reported as PARTIAL rather than as
        // an empty catalog a picker would render as fact.
        const result = await discoverModels(adapter, { ...ctxFor(fake), limits: { maxBytes: 64 * 1024, maxItems: 10, timeoutMs: 2_000 } });
        eq(result.models, [], "a transport with no list endpoint returns no models");
        assert(result.partial, "absence must be reported as PARTIAL, never as removal");
        assert(result.warnings.some((w) => /not authoritative|no bounded model-list/i.test(w)), "the reason must be stated, not implied");
        return;
      }
      const result = await discoverModels(adapter, { ...ctxFor(fake), limits: { maxBytes: 256 * 1024, maxItems: 50, timeoutMs: 3_000 } });
      // The `models/` RESOURCE-NAME prefix is stripped so an id matches the catalog's `upstreamId`.
      eq(result.models.map((m) => m.id), ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"], "the paginated, deduped, prefix-stripped model list");
      assert(result.warnings.some((w) => /duplicate/.test(w)), "a duplicate id is reported rather than silently kept twice");
      assert(result.warnings.some((w) => /no usable id/.test(w)), "a malformed row is dropped and counted");
      eq(result.models[0]?.contextWindow, 1048576, "`inputTokenLimit` becomes the context window");

      const bounded = await discoverModels(adapter, { ...ctxFor(fake), limits: { maxBytes: 256 * 1024, maxItems: 2, timeoutMs: 3_000 } });
      assert(bounded.models.length <= 2, "the item bound is enforced");
      assert(bounded.partial, "a truncated catalog is reported as PARTIAL, never as removal");
    },

    "identity-across-resume": async ({ fake }) => {
      const catalog = config.catalog;
      const identity = () => {
        const registry = createRegistry(catalog);
        registry.register(adapter);
        const resolved = registry.resolve({ model: MODELS.main, provider: { providerId: config.providerId } });
        assert(!(resolved instanceof Error), "the model should resolve");
        return {
          providerId: resolved.providerId,
          modelKey: resolved.modelKey,
          providerModelId: resolved.providerModelId,
          adapterId: resolved.adapterId,
          adapterVersion: adapter.version,
          continuationDomain: resolved.continuationDomain,
          catalogVersion: resolved.catalogVersion,
        };
      };
      const before = identity();
      eq(identity(), before, "the resolved identity across a resume");

      const requestsBefore = generateRequests(fake).length;
      await foldTurn(adapter, { model: before.providerModelId, messages: [user("one")] }, ctxFor(fake));
      await foldTurn(adapter, { model: before.providerModelId, messages: [user("two")] }, ctxFor(fake));
      // The model id lives in the PATH for this family, so that is where the identity is checked.
      eq(
        generateRequests(fake).slice(requestsBefore).map((r) => r.path),
        [config.generatePath(MODELS.main), config.generatePath(MODELS.main)],
        "the same wire model id on both turns",
      );
    },

    "no-silent-tool-dropping": async ({ fake }) => {
      const before = generateRequests(fake).length;
      const err = await foldFailure(
        adapter,
        { model: MODELS.noTools, messages: [user("go")], tools: [{ name: "Read", description: "read", inputSchema: { type: "object" } }] },
        ctxFor(fake),
      );
      assert(/cannot be sent natively/.test(err.message), `expected a capability-negotiation failure, saw ${err.message}`);
      eq(generateRequests(fake).length, before, "the tools are never dropped and the turn sent as plain chat");

      // The mirror image: a tool RESULT whose call this history does not contain is an error, never a
      // dropped response -- to the model those two are indistinguishable.
      const orphan = await foldFailure(
        adapter,
        { model: MODELS.main, messages: [{ role: "tool", content: [{ type: "tool_result", tool_use_id: "never-called", content: "x" }] }] },
        ctxFor(fake),
      );
      assert(/has no matching tool_use/.test(orphan.message), `expected an orphan-result refusal, saw ${orphan.message}`);
    },
  };
}

/** The Gemini API's own corpus configuration. */
export function googleCorpusCases(): Partial<Record<CorpusCaseId, CorpusCaseImpl>> {
  return googleFamilyCorpusCases({
    adapter: testGoogleAdapter(),
    context: (fake) => googleContext(fake.url),
    contextWith: (fake, over) => googleContext(fake.url, over),
    catalog: testGoogleCatalog(),
    providerId: "google",
    models: GOOGLE_MODELS,
    isGenerateRequest: (recorded) => recorded.path.includes(":streamGenerateContent"),
    assertSerialization: (recorded, model) => assertGeminiRequest(recorded, { model, search: "?alt=sse" }),
    generatePath: (model) => `/v1beta/models/${model}:streamGenerateContent`,
    discovery: "live",
  });
}
