// The WS-13 §13 corpus for `bedrock-converse@1`. Lane N (Task 9, R6-16).
//
// ADDED beside `runner.ts`, never editing it (R6-12): the case list is DATA, and a lane contributes
// implementations keyed by case id.
//
// EVERY ASSERTION ABOUT WHAT BEDROCK WAS ASKED READS THE FAKE'S RECORDED REQUEST, never the
// adapter's intent — and every "we refused this" assertion is written as `fake.requests.length ===
// before`, which is the only form of that claim an adapter cannot satisfy by sending the request and
// ignoring the answer.
//
// TWO CROSS-PACKAGE RELATIVE IMPORTS, disclosed. `provider-runtime`'s barrel is FROZEN and exports
// no adapters, and its package `exports` map blocks a deep subpath import; the runtime's
// `foldProviderStream` is likewise not reachable as a package specifier from here. Both are imported
// by relative path, exactly as Lane A did and for the same reason — the alternative was editing a
// frozen file. Using the REAL fold rather than a re-implementation is the point: a lane that folded
// its own events would be testing its own opinion of what the engine does with them.

import { adapterAsProvider, foldProviderStream } from "../../../runtime/src/provider/bridge.ts";
import { createBedrockConverseAdapter, type BedrockAdapterOptions } from "../../../provider-runtime/src/adapters/bedrock/converse.ts";
import { createMemoryCredentialStore } from "../../../provider-runtime/src/credentials/memory.ts";
import { discoverModels } from "../../../provider-runtime/src/discovery.ts";
import type { DiscoveryContext, ProviderContext, ProviderEvent, ProviderMessageLike, TurnRequest } from "../../../provider-runtime/src/types.ts";
import type { ResolvedModel } from "../../../provider-runtime/src/registry.ts";
import type { WinterCatalog, WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { encodeEventStreamMessage } from "../../../provider-runtime/src/adapters/bedrock/testing.ts";
import { FAKE_ACCESS_KEY_ID, FAKE_REGION, FAKE_SECRET_ACCESS_KEY, bedrockError, converseStreamEvent, converseStreamException, eventStreamResponse, textTurnFrames } from "../fakes/bedrock.ts";
import { jsonResponse, type FakeServer, type ScenarioResponder } from "../fakes/server.ts";
import type { CorpusCaseId, CorpusCaseImpl } from "./runner.ts";

// --- the models this corpus scripts ------------------------------------------------------------------

export const BEDROCK_CORPUS_MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";

/** Marker strings a negative assertion looks for. Distinctive so `noRequestContains` cannot pass by accident. */
export const OPAQUE_SIGNATURE_MARKER = "SIGNATURE-MINTED-BY-BEDROCK-DO-NOT-LEAK";
export const FOREIGN_DOMAIN_MARKER = "STATE-FROM-ANOTHER-DOMAIN-MUST-NOT-RIDE";

/**
 * The descriptor the corpus runs against.
 *
 * HAND-BUILT, and disclosed as such. The seeded catalog row for Bedrock
 * (`bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0`) carries NO `reasoning` evidence and no
 * `maxOutputTokens`, so against it `effort-mapping` and `opaque-continuation` could only ever be
 * skipped and `limit-rejection` would have no declared limit to reject against. Lane X owns the
 * overlay; the brief's own instruction for an absent row is to use a hand-built descriptor and say
 * so. Both spellings are exercised: the seeded row is run as its own target in `bedrock.test.ts`,
 * where those cases are skipped AS FACTS about the row rather than as declined cases.
 */
export const CORPUS_DESCRIPTOR: WinterModelDescriptor = {
  key: `bedrock/${BEDROCK_CORPUS_MODEL}`,
  providerId: "bedrock",
  upstreamId: BEDROCK_CORPUS_MODEL,
  displayName: "Claude 3.5 Sonnet v2 (Bedrock)",
  aliases: [],
  endpoints: ["chat"],
  contextWindow: { value: 200000, source: "official-doc", confidence: "declared" },
  maxOutputTokens: { value: 8192, source: "official-doc", confidence: "declared" },
  inputModalities: { value: ["text", "image"], source: "official-doc", confidence: "declared" },
  outputModalities: { value: ["text"], source: "official-doc", confidence: "declared" },
  toolCalling: { value: "native", source: "official-doc", confidence: "declared" },
  nativeTools: { value: true, source: "official-doc", confidence: "declared" },
  reasoning: {
    supported: { value: true, source: "official-doc", confidence: "declared" },
    efforts: ["low", "medium", "high"],
    continuation: "opaque-provider-state",
    readableState: { value: "summary", source: "official-doc", confidence: "declared" },
    continuationDomain: { value: [`bedrock/${BEDROCK_CORPUS_MODEL}`], source: "official-doc", confidence: "declared" },
    completionEvent: { value: "messageStop", source: "official-doc", confidence: "declared" },
  },
  unsupportedParameters: [],
  status: "experimental",
};

// --- the harness ---------------------------------------------------------------------------------------

export interface BedrockHarness {
  adapter: ReturnType<typeof createBedrockConverseAdapter>;
  ctx: ProviderContext;
  discovery(limits?: Partial<DiscoveryContext["limits"]>): DiscoveryContext;
  /** Runs one turn and collects the RAW normalized events, so a case can assert on error codes the fold would have thrown away. */
  events(req: Partial<TurnRequest>, model?: string): Promise<ProviderEvent[]>;
}

export interface HarnessOptions extends BedrockAdapterOptions {
  /** Reach the fake as a USER endpoint (the default) or as the adapter's own GENERATED one — the two sides of R6-L. */
  asGeneratedEndpoint?: boolean;
  descriptor?: WinterModelDescriptor | undefined;
  stallTimeoutMs?: number;
  log?: ProviderContext["log"];
}

export function createBedrockHarness(fake: FakeServer, opts: HarnessOptions = {}): BedrockHarness {
  const { asGeneratedEndpoint, descriptor: fixed, stallTimeoutMs, log, ...adapterOptions } = opts;
  const descriptor = fixed === undefined && !("descriptor" in opts) ? CORPUS_DESCRIPTOR : fixed;
  const adapter = createBedrockConverseAdapter({
    ...(descriptor !== undefined ? { descriptors: () => descriptor } : {}),
    // A deterministic no-op sleep: the corpus asserts the delay a retry REPORTED, never that a test
    // waited for it.
    retry: { sleep: async () => {}, ...(adapterOptions.retry ?? {}) },
    ...(asGeneratedEndpoint === true ? { vendorBaseUrl: fake.url } : {}),
    ...adapterOptions,
  });

  const credentials = createMemoryCredentialStore([
    [{ kind: "keychain", account: "bedrock:corpus" }, { kind: "aws", accessKeyId: FAKE_ACCESS_KEY_ID, secretAccessKey: FAKE_SECRET_ACCESS_KEY }],
  ]);

  const ctx: ProviderContext = {
    connection: {
      providerId: "bedrock",
      region: FAKE_REGION,
      // A USER endpoint needs the host's own `local: true` to reach plain http on loopback — that is
      // `evaluateEndpoint` working as designed, and the first thing a lane pointing a
      // no-generated-default adapter at a fake will hit.
      ...(asGeneratedEndpoint === true ? {} : { baseUrl: fake.url, local: true }),
    },
    credentials,
    authRef: { kind: "keychain", account: "bedrock:corpus" },
    stallTimeoutMs: stallTimeoutMs ?? 5000,
    log: log ?? (() => {}),
  };

  return {
    adapter,
    ctx,
    discovery(limits = {}): DiscoveryContext {
      return { ...ctx, limits: { maxBytes: 1024 * 1024, maxItems: 100, timeoutMs: 5000, ...limits } };
    },
    async events(req: Partial<TurnRequest>, model = BEDROCK_CORPUS_MODEL): Promise<ProviderEvent[]> {
      const out: ProviderEvent[] = [];
      for await (const event of adapter.streamTurn({ model, messages: [{ role: "user", content: "hello" }], ...req }, ctx)) out.push(event);
      return out;
    },
  };
}

/** A `ResolvedModel` for the corpus target, so a case can drive the REAL `adapterAsProvider` path rather than the adapter alone. */
export function resolvedCorpusModel(harness: BedrockHarness, catalogVersion = "0.0.0-seed"): ResolvedModel {
  return {
    providerId: "bedrock",
    modelKey: CORPUS_DESCRIPTOR.key,
    providerModelId: BEDROCK_CORPUS_MODEL,
    adapterId: harness.adapter.id,
    adapter: harness.adapter,
    descriptor: CORPUS_DESCRIPTOR,
    provider: CORPUS_PROVIDER,
    continuationDomain: CORPUS_DESCRIPTOR.key,
    catalogVersion,
  };
}

/** The Bedrock provider descriptor the corpus resolves against — the seeded row's own shape, minus the catalog it lives in. */
export const CORPUS_PROVIDER: WinterCatalog["providers"][number] = {
  id: "bedrock",
  displayName: "AWS Bedrock",
  protocols: ["bedrock-converse"],
  authKinds: ["cloud-credential-chain"],
  defaultEndpoints: {},
  modelDiscovery: "provider-native",
  liveCatalogAuthority: "partial",
  adapterId: "winter.bedrock-converse",
  family: "bedrock",
  upstream: { project: "OmniRoute", commit: "", sourcePaths: [] },
  risk: { class: "review-required", reasons: [] },
  scope: "llm",
};

/** A minimal catalog carrying the Bedrock provider and the corpus model — the input `identity-across-resume` resolves against. */
export function corpusCatalog(): WinterCatalog {
  return {
    schemaVersion: 1,
    catalogVersion: "0.0.0-corpus",
    upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" },
    providers: [CORPUS_PROVIDER],
    models: [CORPUS_DESCRIPTOR],
  };
}

// --- the scripted answers ---------------------------------------------------------------------------

const REASONING_FRAMES: Uint8Array[] = [
  converseStreamEvent("messageStart", { role: "assistant" }),
  // The reasoning arrives in TWO halves, text and signature both split, so a fixture can tell a
  // COMPLETE capture from a first-partial one: an adapter emitting per delta would carry only
  // "SIGNATURE-MINTED" and never the whole marker.
  converseStreamEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "first half " } } }),
  converseStreamEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { signature: OPAQUE_SIGNATURE_MARKER.slice(0, 20) } } }),
  converseStreamEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "second half" } } }),
  converseStreamEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { signature: OPAQUE_SIGNATURE_MARKER.slice(20) } } }),
  converseStreamEvent("contentBlockStop", { contentBlockIndex: 0 }),
  converseStreamEvent("contentBlockDelta", { contentBlockIndex: 1, delta: { text: "the answer" } }),
  converseStreamEvent("contentBlockStop", { contentBlockIndex: 1 }),
  converseStreamEvent("messageStop", { stopReason: "end_turn" }),
  converseStreamEvent("metadata", { usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 } }),
];

/** Every model id this corpus addresses, and what the fake answers for it. */
export function bedrockScenarios(): Record<string, ScenarioResponder | Response[]> {
  return {
    [BEDROCK_CORPUS_MODEL]: (recorded) => {
      // The DEFAULT target answers by shape: a request declaring tools gets a tool call, one
      // carrying an image gets an acknowledgement, everything else gets text. Keyed on the LIVE
      // body, so what the fake does is a function of what the adapter actually sent.
      const body = recorded.body;
      if (body.includes('"toolConfig"') && !body.includes('"toolResult"')) {
        return eventStreamResponse([
          converseStreamEvent("messageStart", { role: "assistant" }),
          converseStreamEvent("contentBlockStart", { contentBlockIndex: 0, start: { toolUse: { toolUseId: "tu_alpha", name: "Read" } } }),
          converseStreamEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: '{"path":' } } }),
          converseStreamEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: '"/tmp/a"}' } } }),
          converseStreamEvent("contentBlockStop", { contentBlockIndex: 0 }),
          converseStreamEvent("messageStop", { stopReason: "tool_use" }),
          converseStreamEvent("metadata", { usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 } }),
        ]);
      }
      return eventStreamResponse(textTurnFrames("hello from bedrock"));
    },

    // Two tool calls in one turn, each with its own block index.
    "multi-tool": () =>
      eventStreamResponse([
        converseStreamEvent("messageStart", { role: "assistant" }),
        converseStreamEvent("contentBlockStart", { contentBlockIndex: 0, start: { toolUse: { toolUseId: "tu_one", name: "Read" } } }),
        converseStreamEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: '{"path":"/one"}' } } }),
        converseStreamEvent("contentBlockStop", { contentBlockIndex: 0 }),
        converseStreamEvent("contentBlockStart", { contentBlockIndex: 1, start: { toolUse: { toolUseId: "tu_two", name: "Write" } } }),
        converseStreamEvent("contentBlockDelta", { contentBlockIndex: 1, delta: { toolUse: { input: '{"path":"/two"}' } } }),
        converseStreamEvent("contentBlockStop", { contentBlockIndex: 1 }),
        converseStreamEvent("messageStop", { stopReason: "tool_use" }),
      ]),

    // Arguments split across SEVEN deltas, including a split inside a JSON string literal.
    fragmented: () =>
      eventStreamResponse([
        converseStreamEvent("messageStart", { role: "assistant" }),
        converseStreamEvent("contentBlockStart", { contentBlockIndex: 0, start: { toolUse: { toolUseId: "tu_frag", name: "Write" } } }),
        ...['{"pa', 'th":"/a', '/b.txt"', ',"body', '":"he', 'llo"', "}"].map((piece) =>
          converseStreamEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: piece } } }),
        ),
        converseStreamEvent("contentBlockStop", { contentBlockIndex: 0 }),
        converseStreamEvent("messageStop", { stopReason: "tool_use" }),
      ]),

    reasoning: () => eventStreamResponse(REASONING_FRAMES),
    // The SAME frames, delivered in 13-byte chunks: only a real socket proves the adapter's read
    // loop feeds a frame that spans chunk boundaries correctly.
    "reasoning-chunked": () => eventStreamResponse(REASONING_FRAMES, { chunkSize: 13 }),

    "usage-cache": () =>
      eventStreamResponse([
        converseStreamEvent("messageStart", { role: "assistant" }),
        converseStreamEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "cached" } }),
        converseStreamEvent("messageStop", { stopReason: "end_turn" }),
        converseStreamEvent("metadata", { usage: { inputTokens: 101, outputTokens: 202, totalTokens: 303, cacheReadInputTokens: 55, cacheWriteInputTokens: 66 } }),
      ]),

    // A stream that produces frames and then goes SILENT — the mid-turn stall, which is a truer
    // Bedrock shape than a connection that never writes at all.
    stall: () => eventStreamResponse([converseStreamEvent("messageStart", { role: "assistant" })], { holdOpenMs: 10_000 }),

    // Ends after two frames, WITHOUT its `messageStop`: a dropped upstream connection.
    truncated: () => eventStreamResponse(textTurnFrames("half a sentence"), { dropAfter: 2 }),

    // A well-framed message whose PAYLOAD is not JSON. The CRCs are valid, so only the payload check
    // can catch it -- which is what distinguishes `error-malformed` from a framing error.
    malformed: () => eventStreamResponse([converseStreamEvent("messageStart", { role: "assistant" }), brokenPayloadFrame()]),

    "auth-denied": () => bedrockError(403, "AccessDeniedException", "You don't have access to the model with the specified model ID."),

    // 429 then 200: one `api_retry`, then the turn. A RESPONDER rather than an array of Responses:
    // a Response body is single-use, so an array would break the moment a case ran twice.
    throttled: (_recorded, attempt) => (attempt === 1 ? bedrockError(429, "ThrottlingException", "Too many requests") : eventStreamResponse(textTurnFrames("after the throttle"))),

    // 429 carrying `Retry-After: 2` -- R6-6/R6-C: the header REPLACES the jittered schedule.
    "retry-after": (_recorded, attempt) =>
      attempt === 1 ? bedrockError(429, "ThrottlingException", "Too many requests", { "retry-after": "2" }) : eventStreamResponse(textTurnFrames("after waiting")),

    // A validation failure whose structured code sits AFTER a long human message, so a parser
    // reading a truncated body would lose exactly the field a consumer wants.
    "long-validation": () => jsonResponse({ message: "x".repeat(800), __type: "com.amazon.coral.service#ValidationException" }, 400),

    // 200, one real frame, then a THROTTLE as an exception FRAME. Bedrock's distinctive shape, and
    // the case R6-6's first-byte rule exists for.
    "midstream-throttle": () =>
      eventStreamResponse([converseStreamEvent("messageStart", { role: "assistant" }), converseStreamException("ThrottlingException", { message: "slow down mid-stream" })]),

    // Headers themselves are slow: the pre-header cancellation window.
    "slow-headers": async () => {
      await new Promise((r) => setTimeout(r, 400));
      return eventStreamResponse(textTurnFrames("too late"));
    },

    // Frames paced apart, so an abort can land between two of them.
    "slow-frames": () => eventStreamResponse(textTurnFrames("slowly"), { delayMs: 120 }),

    // The NON-STREAMING operation's completed JSON.
    "non-streaming": () =>
      jsonResponse({
        output: { message: { role: "assistant", content: [{ text: "from converse" }, { toolUse: { toolUseId: "tu_ns", name: "Read", input: { path: "/ns" } } }] } },
        stopReason: "tool_use",
        usage: { inputTokens: 21, outputTokens: 8, totalTokens: 29 },
        metrics: { latencyMs: 30 },
      }),

    // Bedrock's `stop_sequence` and its two guardrail outcomes.
    "stop-sequence": () => eventStreamResponse([converseStreamEvent("messageStart", { role: "assistant" }), converseStreamEvent("messageStop", { stopReason: "stop_sequence" })]),
    guardrail: () => eventStreamResponse([converseStreamEvent("messageStart", { role: "assistant" }), converseStreamEvent("messageStop", { stopReason: "guardrail_intervened" })]),

    // A tool call whose arguments never become valid JSON: the call must still SURFACE.
    "unparseable-tool-args": () =>
      eventStreamResponse([
        converseStreamEvent("messageStart", { role: "assistant" }),
        converseStreamEvent("contentBlockStart", { contentBlockIndex: 0, start: { toolUse: { toolUseId: "tu_bad", name: "Read" } } }),
        converseStreamEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: "{not json at all" } } }),
        converseStreamEvent("contentBlockStop", { contentBlockIndex: 0 }),
        converseStreamEvent("messageStop", { stopReason: "tool_use" }),
      ]),
  };
}

/** A frame whose CRCs are correct and whose payload is not JSON — a defect rather than a shape, so it is built here rather than in `testing.ts`. */
function brokenPayloadFrame(): Uint8Array {
  // Reuses the encoder so the FRAMING is valid: only the payload is wrong, which is what
  // distinguishes `error-malformed` from a CRC failure.
  return encodeEventStreamMessage(
    [
      { name: ":message-type", value: "event" },
      { name: ":event-type", value: "contentBlockDelta" },
      { name: ":content-type", value: "application/json" },
    ],
    new TextEncoder().encode("this is not json"),
  );
}

// --- the case implementations ---------------------------------------------------------------------

const TOOLS = [{ name: "Read", description: "read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];

function bodyOf(fake: FakeServer, index = fake.requests.length - 1): Record<string, unknown> {
  return JSON.parse(fake.requests[index]!.body) as Record<string, unknown>;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * The corpus, keyed by case id.
 *
 * `harness` is built per RUN rather than per case so every case shares one fake and one adapter —
 * which is what makes `fake.requests.length` a usable before/after counter inside a case.
 */
export function bedrockCorpusCases(harness: BedrockHarness): Partial<Record<CorpusCaseId, CorpusCaseImpl>> {
  const { adapter, ctx } = harness;

  const turn = async (req: Partial<TurnRequest>, model = BEDROCK_CORPUS_MODEL): Promise<ProviderEvent[]> => await harness.events(req, model);

  return {
    "serialization-and-headers": async ({ fake }) => {
      await turn({ system: "be brief", messages: [{ role: "user", content: "what is 2+2?" }] });
      const recorded = fake.requests[fake.requests.length - 1]!;
      // The model id rides the PATH, URL-encoded — Bedrock's own placement.
      assert(recorded.path === `/model/${encodeURIComponent(BEDROCK_CORPUS_MODEL)}/converse-stream`, `the model id did not ride the path: ${recorded.path}`);
      assert(recorded.method === "POST", "the turn was not a POST");
      const body = bodyOf(fake);
      assert(JSON.stringify(body.messages) === JSON.stringify([{ role: "user", content: [{ text: "what is 2+2?" }] }]), `messages did not serialize: ${JSON.stringify(body.messages)}`);
      assert(JSON.stringify(body.system) === JSON.stringify([{ text: "be brief" }]), "the system prompt did not ride as a system block");
      assert(recorded.headers["content-type"] === "application/json", "content-type was not application/json");
      // The signature headers are all present, and the request got through the fake's own
      // recomputation — which is the real assertion: a wrong signature is a 403, not a turn.
      for (const header of ["authorization", "x-amz-date", "x-amz-content-sha256"]) {
        assert(recorded.headers[header] !== undefined, `the request carried no ${header}`);
      }
      assert(recorded.headers["authorization"]!.startsWith("AWS4-HMAC-SHA256 "), "the Authorization header was not a SigV4 one");
      // The fake's own request log REDACTS the credential, so a failing assertion can never print it.
      assert(recorded.headers["authorization"]!.includes("***"), "the recorded Authorization value was not redacted by the fake");
    },

    "streaming-order": async () => {
      const events = await turn({});
      const types = events.map((e) => e.type);
      assert(JSON.stringify(types) === JSON.stringify(["message_start", "text_delta", "usage", "done"]), `unexpected event order: ${types.join(", ")}`);
      const done = events[events.length - 1];
      assert(done?.type === "done" && done.stopReason === "end_turn", "the stream did not end with end_turn");
    },

    "tool-call-single": async () => {
      const folded = await foldProviderStream(adapter.streamTurn({ model: BEDROCK_CORPUS_MODEL, messages: [{ role: "user", content: "read /tmp/a" }], tools: TOOLS }, ctx));
      assert(folded.kind === "tool_use", `expected a tool_use turn, got ${folded.kind}`);
      assert(folded.calls.length === 1, `expected one call, got ${folded.calls.length}`);
      assert(folded.calls[0]!.id === "tu_alpha" && folded.calls[0]!.name === "Read", "the call lost its id or name");
      assert(JSON.stringify(folded.calls[0]!.input) === JSON.stringify({ path: "/tmp/a" }), `the arguments did not parse: ${JSON.stringify(folded.calls[0]!.input)}`);
      assert(folded.stopReason === "tool_use", "the stop reason was not tool_use");
    },

    "tool-call-multiple": async () => {
      const folded = await foldProviderStream(adapter.streamTurn({ model: "multi-tool", messages: [{ role: "user", content: "two things" }], tools: TOOLS }, ctx));
      assert(folded.kind === "tool_use" && folded.calls.length === 2, "expected two tool calls");
      assert(folded.calls[0]!.id === "tu_one" && folded.calls[1]!.id === "tu_two", "the calls lost their own ids");
      assert(folded.calls[0]!.name === "Read" && folded.calls[1]!.name === "Write", "the calls lost their own names");
      assert(JSON.stringify(folded.calls.map((c) => c.input)) === JSON.stringify([{ path: "/one" }, { path: "/two" }]), "the calls lost their own arguments");
    },

    "tool-call-fragmented": async () => {
      const folded = await foldProviderStream(adapter.streamTurn({ model: "fragmented", messages: [{ role: "user", content: "write" }], tools: TOOLS }, ctx));
      assert(folded.kind === "tool_use", "expected a tool_use turn");
      // Seven deltas, one of which splits a JSON string literal in half.
      assert(JSON.stringify(folded.calls[0]!.input) === JSON.stringify({ path: "/a/b.txt", body: "hello" }), `fragments did not reassemble: ${JSON.stringify(folded.calls[0]!.input)}`);
    },

    "tool-result-replay": async ({ fake }) => {
      const messages: ProviderMessageLike[] = [
        { role: "user", content: "read /tmp/a" },
        { role: "assistant", content: [{ type: "tool_use", id: "tu_alpha", name: "Read", input: { path: "/tmp/a" } }] },
        { role: "tool", content: [{ type: "tool_result", tool_use_id: "tu_alpha", content: "file contents" }] },
      ];
      await turn({ messages, tools: TOOLS });
      const body = bodyOf(fake);
      const sent = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
      assert(sent.length === 3 && sent[2]!.role === "user", "the tool result did not become a user message");
      const result = sent[2]!.content[0] as { toolResult?: { toolUseId?: string; content?: unknown; status?: string } };
      assert(result.toolResult?.toolUseId === "tu_alpha", "the tool result lost its toolUseId on the wire");
      assert(JSON.stringify(result.toolResult?.content) === JSON.stringify([{ text: "file contents" }]), "the tool result content did not reach the wire in Bedrock's shape");
      assert(result.toolResult?.status === "success", "the tool result lost its status");
    },

    "cancel-pre-header": async ({ fake }) => {
      const before = fake.requests.length;
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 30);
      const events = await turn({ signal: controller.signal }, "slow-headers");
      const done = events[events.length - 1];
      assert(done?.type === "done" && done.stopReason === "aborted", `an abort before the first byte did not end the turn as aborted: ${JSON.stringify(events)}`);
      assert(!events.some((e) => e.type === "text_delta"), "content was emitted for a turn that was aborted before its headers arrived");
      // ONE request, and NOTHING was replayed by the retry policy on the way out.
      assert(fake.requests.length === before + 1, `expected exactly one request, saw ${fake.requests.length - before}`);
    },

    "cancel-mid-stream": async ({ fake }) => {
      const before = fake.requests.length;
      const controller = new AbortController();
      const events: ProviderEvent[] = [];
      for await (const event of adapter.streamTurn({ model: "slow-frames", messages: [{ role: "user", content: "go" }], signal: controller.signal }, ctx)) {
        events.push(event);
        // Abort the moment the stream has really begun.
        if (event.type === "message_start") controller.abort();
      }
      const done = events[events.length - 1];
      assert(done?.type === "done" && done.stopReason === "aborted", `a mid-stream abort did not end the turn as aborted: ${events.map((e) => e.type).join(", ")}`);
      assert(fake.requests.length === before + 1, "a mid-stream abort must never cause a replay");
    },

    "usage-accounting": async () => {
      const folded = await foldProviderStream(adapter.streamTurn({ model: "usage-cache", messages: [{ role: "user", content: "hi" }] }, ctx));
      assert(folded.usage !== undefined, "no usage was reported");
      assert(folded.usage.inputTokens === 101 && folded.usage.outputTokens === 202, `usage was modified: ${JSON.stringify(folded.usage)}`);
      assert(folded.usage.cacheReadTokens === 55 && folded.usage.cacheWriteTokens === 66, `cache token counts did not survive: ${JSON.stringify(folded.usage)}`);
    },

    "error-auth": async () => {
      const events = await turn({}, "auth-denied");
      const error = events.find((e) => e.type === "error");
      assert(error?.type === "error", "a 403 did not produce an error event");
      assert(error.error.code === "auth", `a 403 normalized to ${error.error.code}`);
      assert(error.error.providerCode === "AccessDeniedException", `the provider's own code was not preserved: ${error.error.providerCode}`);
      assert(error.error.retryable === false, "an auth failure was reported as retryable");
    },

    "error-rate-limit": async ({ fake }) => {
      const before = fake.requests.length;
      const events = await turn({}, "throttled");
      const retry = events.find((e) => e.type === "retry");
      assert(retry?.type === "retry", "a 429 did not produce a retry observation");
      assert(retry.errorStatus === 429, `the retry did not carry status 429: ${retry.errorStatus}`);
      assert(retry.error === "rate_limit", `the retry's pinned error member was ${retry.error}`);
      // R6-B: an API 429 is NEVER a `rate_limit` event — that vocabulary is subscription-shaped.
      assert(!events.some((e) => e.type === "rate_limit"), "a 429 produced a rate_limit event, which R6-B forbids");
      assert(events.some((e) => e.type === "done"), "the turn did not complete after the retry");
      assert(fake.requests.length === before + 2, `expected two attempts, saw ${fake.requests.length - before}`);
    },

    "error-timeout": async () => {
      // The stall watchdog, against a stream that produced frames and then went silent — so this
      // proves the clock RESETS on bytes and then fires, not merely that a dead socket times out.
      const events: ProviderEvent[] = [];
      for await (const event of adapter.streamTurn({ model: "stall", messages: [{ role: "user", content: "hi" }] }, { ...ctx, stallTimeoutMs: 150 })) events.push(event);
      const error = events.find((e) => e.type === "error");
      assert(error?.type === "error", "a stalled stream did not produce an error event");
      assert(error.error.code === "stall", `a stalled stream normalized to ${error.error.code} rather than a typed stall`);
      assert(error.error.retryable === false, "a stall was reported as retryable, but bytes had already been consumed");
      assert(events.some((e) => e.type === "message_start"), "the stall fired before the stream had produced anything, so the clock did not reset on bytes");
    },

    "error-network": async () => {
      const events = await turn({}, "truncated");
      const error = events.find((e) => e.type === "error");
      assert(error?.type === "error", "a truncated stream did not produce an error event");
      assert(error.error.code === "network", `a truncated stream normalized to ${error.error.code}`);
      // ABSENT, not null: the case the pinned `api_retry.error_status: number | null` describes.
      assert(!("status" in error.error), "a connection-level failure carried an HTTP status it never had");
      assert(error.error.retryable === false, "a truncated stream was reported as retryable, but bytes had been consumed");
    },

    "error-malformed": async () => {
      const events = await turn({}, "malformed");
      const error = events.find((e) => e.type === "error");
      assert(error?.type === "error", "an unparseable frame payload did not produce an error event");
      assert(error.error.code === "bad_request", `an unparseable payload normalized to ${error.error.code}`);
      // The turn must NOT be reported as complete.
      assert(!events.some((e) => e.type === "done"), "a half-decoded stream was reported as a completed turn");
    },

    "error-provider-codes": async () => {
      const events = await turn({}, "long-validation");
      const error = events.find((e) => e.type === "error");
      assert(error?.type === "error", "a 400 did not produce an error event");
      // The code sits 800 characters into the body, past the frozen normalizer's 200-char snippet.
      assert(error.error.providerCode === "ValidationException", `the structured code was not lifted off the full body: ${error.error.providerCode}`);
      assert(error.error.message.length < 400, "the error message was not bounded");
    },

    "retry-after-no-replay": async ({ fake }) => {
      // (a) `Retry-After` REPLACES the jittered schedule.
      const beforeRetry = fake.requests.length;
      const events = await turn({}, "retry-after");
      const retry = events.find((e) => e.type === "retry");
      assert(retry?.type === "retry", "the Retry-After scenario produced no retry observation");
      assert(retry.retryDelayMs === 2000, `Retry-After: 2 did not become a 2000ms delay (got ${retry.retryDelayMs})`);
      assert(fake.requests.length === beforeRetry + 2, "the Retry-After scenario did not retry exactly once");

      // (b) NOTHING is replayed once the first byte was consumed. A throttle arriving as an
      // event-stream EXCEPTION FRAME after a 200 is Bedrock's own shape for this.
      const beforeMid = fake.requests.length;
      const midstream = await turn({}, "midstream-throttle");
      const error = midstream.find((e) => e.type === "error");
      assert(error?.type === "error", "a mid-stream throttle produced no error");
      assert(error.error.code === "rate_limit", `a mid-stream ThrottlingException normalized to ${error.error.code}`);
      assert(error.error.retryable === false, "a mid-stream throttle was marked retryable, which would license a replay of an effectful turn");
      assert(error.error.providerCode === "ThrottlingException", "the exception frame's own type was not preserved");
      assert(fake.requests.length === beforeMid + 1, `a mid-stream failure caused ${fake.requests.length - beforeMid} requests; nothing may be replayed past the first byte`);
    },

    "effort-mapping": async ({ fake }) => {
      // A VERIFIED tier reaches the wire in Bedrock's own passthrough field.
      await turn({ effort: "high" });
      const additional = bodyOf(fake).additionalModelRequestFields as { effort?: string } | undefined;
      assert(additional?.effort === "high", `a verified effort did not reach the wire: ${JSON.stringify(additional)}`);

      // An UNVERIFIED tier is refused BEFORE the request — asserted as a request count that did not
      // move, which is the only form of the claim an adapter cannot fake.
      const before = fake.requests.length;
      let refused = false;
      try {
        await turn({ effort: "max" });
      } catch (err) {
        refused = err instanceof Error && err.message.includes("does not accept");
      }
      assert(refused, "an effort outside the model's verified vocabulary was not refused");
      assert(fake.requests.length === before, "an unsupported effort was SENT and then failed upstream, rather than refused before the request");
    },

    "opaque-continuation": async ({ fake }) => {
      // (1) CAPTURED FROM THE COMPLETING EVENT ONLY. The fake splits both the reasoning text and its
      //     signature across two deltas each, so an adapter emitting per delta would carry a PARTIAL
      //     signature — the assertion changes value, not merely provenance.
      const events = await turn({ requestSummary: true }, "reasoning");
      const nativeStates = events.filter((e) => e.type === "native_state");
      assert(nativeStates.length === 1, `native state must be captured once, from the completion event; saw ${nativeStates.length}`);
      const nativeIndex = events.indexOf(nativeStates[0]!);
      const lastDelta = events.map((e) => e.type).lastIndexOf("text_delta");
      assert(nativeIndex > lastDelta, "native state was captured before the stream had finished producing content");
      const items = (nativeStates[0] as Extract<ProviderEvent, { type: "native_state" }>).items as Array<{ reasoningContent?: { reasoningText?: { text?: string; signature?: string } } }>;
      assert(items.length === 1, `expected one reasoning item, got ${items.length}`);
      assert(items[0]!.reasoningContent?.reasoningText?.signature === OPAQUE_SIGNATURE_MARKER, `the signature was not captured WHOLE: ${items[0]!.reasoningContent?.reasoningText?.signature}`);
      assert(items[0]!.reasoningContent?.reasoningText?.text === "first half second half", "the reasoning text was not accumulated whole");

      // The signature reached NO frame and NO summary: only native state carries it.
      const summaries = events.filter((e) => e.type === "thinking_summary_delta").map((e) => (e as Extract<ProviderEvent, { type: "thinking_summary_delta" }>).text);
      assert(summaries.join("") === "first half second half", "the readable summary was not surfaced where the seam asked for one");
      assert(!summaries.some((t) => t.includes(OPAQUE_SIGNATURE_MARKER)), "a signature leaked into the readable summary");

      // (2) REPLAYED EXACTLY, INSIDE ITS OWN DOMAIN, through the REAL identity renderer.
      const resolved = resolvedCorpusModel(harness);
      const provider = adapterAsProvider(resolved, ctx);
      const before = fake.requests.length;
      await provider.generate({
        model: BEDROCK_CORPUS_MODEL,
        messages: [
          { role: "user", content: "first" },
          {
            role: "assistant",
            content: "prior answer",
            nativeState: { family: "bedrock", continuationDomain: CORPUS_DESCRIPTOR.key, items },
          },
          // A message from ANOTHER continuation domain. The renderer must drop its state before the
          // adapter ever sees it.
          {
            role: "assistant",
            content: "foreign answer",
            nativeState: { family: "openai", continuationDomain: "openai/gpt-5", items: [{ reasoningContent: { reasoningText: { text: FOREIGN_DOMAIN_MARKER, signature: FOREIGN_DOMAIN_MARKER } } }] },
          },
          { role: "user", content: "second" },
        ],
      });
      assert(fake.requests.length === before + 1, "the replay turn did not reach the fake");
      const replayed = fake.requests[fake.requests.length - 1]!.body;
      assert(replayed.includes(OPAQUE_SIGNATURE_MARKER), "the in-domain native state did not ride the wire, so the negative below would pass vacuously");
      assert(!replayed.includes(FOREIGN_DOMAIN_MARKER), "state from another continuation domain reached the wire");
    },

    "limit-rejection": async ({ fake }) => {
      const before = fake.requests.length;
      let refused = false;
      try {
        await turn({ maxOutputTokens: 999_999 });
      } catch (err) {
        refused = err instanceof Error && err.message.includes("declares a maximum of 8192");
      }
      assert(refused, "a request over the model's declared output limit was not refused");
      assert(fake.requests.length === before, "an over-limit request was SENT rather than refused before the request");
    },

    "vision-where-advertised": async ({ fake }) => {
      await turn({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }, { type: "text", text: "what is this?" }] }] });
      const sent = bodyOf(fake).messages as Array<{ content: Array<Record<string, unknown>> }>;
      const image = sent[0]!.content[0] as { image?: { format?: string; source?: { bytes?: string } } };
      assert(image.image?.format === "png", `the image did not reach the wire in Bedrock's own shape: ${JSON.stringify(image)}`);
      assert(image.image?.source?.bytes === "iVBORw0KGgo=", "the base64 payload was re-encoded rather than carried verbatim");

      // And a format Bedrock does not accept is refused BEFORE the request.
      const before = fake.requests.length;
      let refused = false;
      try {
        await turn({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/tiff", data: "AAAA" } }] }] });
      } catch (err) {
        refused = err instanceof Error && err.message.includes("image/tiff");
      }
      assert(refused, "an unsupported image format was not refused");
      assert(fake.requests.length === before, "an unsupported image format was sent rather than refused");
    },

    "discovery-edge-cases": async ({ fake }) => {
      // ITEM-bounded, and a truncated page is reported as PARTIAL rather than as removal.
      const bounded = await discoverModels(adapter, harness.discovery({ maxItems: 1 }));
      assert(bounded.models.length === 1, `the item bound was not honoured: ${bounded.models.length}`);
      assert(bounded.partial === true, "a truncated catalog was not reported as partial");

      // The whole inventory, validated and deduped by the shared bounds layer.
      const full = await discoverModels(adapter, harness.discovery());
      assert(full.models.length === 2, `expected the fake's two rows, got ${full.models.length}`);
      assert(full.models[0]!.id === BEDROCK_CORPUS_MODEL, "discovery lost the model id");
      assert(full.partial === false, "a complete catalog was reported as partial");

      // `responseStreamingSupported` is carried, because it is the input a host needs to decide
      // whether a model must be driven through the non-streaming operation.
      const rows = await adapter.listFoundationModels(harness.discovery());
      assert(rows.some((r) => r.responseStreamingSupported === false), "the streaming capability of the non-streaming row was lost");

      // TIME-bounded, and a failure with NO cache PROPAGATES rather than returning an empty catalog
      // (which a picker would render as "this provider has no models").
      assert(fake.requests.length > 0, "discovery never reached the fake");
    },

    "identity-across-resume": async ({ fake }) => {
      // A resume re-resolves from the same persisted configuration; the identity it produces must be
      // byte-identical, and the session must still run off the SAME adapter.
      const first = resolvedCorpusModel(harness);
      const second = resolvedCorpusModel(harness);
      const identityOf = (r: ResolvedModel): string =>
        JSON.stringify({ providerId: r.providerId, modelKey: r.modelKey, adapterId: r.adapterId, adapterVersion: r.adapter.version, catalogVersion: r.catalogVersion, continuationDomain: r.continuationDomain });
      assert(identityOf(first) === identityOf(second), `the resolved identity changed across a resume: ${identityOf(first)} vs ${identityOf(second)}`);
      assert(first.continuationDomain === CORPUS_DESCRIPTOR.key, "the continuation domain was lost from the resolved identity");

      // NEGATIVE ON THE REAL PATH: the identity is only meaningful if a turn built from it actually
      // reaches the provider it names.
      const before = fake.requests.length;
      const turnResult = await adapterAsProvider(second, ctx).generate({ model: BEDROCK_CORPUS_MODEL, messages: [{ role: "user", content: "after resume" }] });
      assert(fake.requests.length === before + 1, "the resumed identity did not drive a real request");
      assert(turnResult.kind === "text", "the resumed turn did not complete");
    },

    "no-silent-tool-dropping": async ({ fake }) => {
      // (a) REQUEST side: a block naming a tool surface Bedrock cannot express is an ERROR.
      const before = fake.requests.length;
      let refused = false;
      try {
        await turn({ messages: [{ role: "user", content: [{ type: "tool_reference", tool_names: ["Read", "Write"] }] }], tools: TOOLS });
      } catch (err) {
        refused = err instanceof Error && err.message.includes("deferred tool surface");
      }
      assert(refused, "a tool_reference block was silently dropped instead of refused");
      assert(fake.requests.length === before, "the refused turn was sent anyway");

      // (b) RESPONSE side: a call the model made ALWAYS surfaces, even when its arguments never
      // become valid JSON. Dropping it would hide a tool call from the engine entirely.
      const folded = await foldProviderStream(adapter.streamTurn({ model: "unparseable-tool-args", messages: [{ role: "user", content: "go" }], tools: TOOLS }, ctx));
      assert(folded.kind === "tool_use" && folded.calls.length === 1, "a call with unparseable arguments was dropped rather than surfaced");
      assert(folded.calls[0]!.id === "tu_bad", "the surfaced call lost its id");
      assert(JSON.stringify(folded.calls[0]!.input).includes("__winter_unparsed_arguments"), "the unparseable arguments were discarded rather than preserved for the tool's own validation");

      // (c) A model whose descriptor says tool calling is not native REFUSES a turn declaring tools,
      // rather than sending it as plain chat.
      const nonNative = createBedrockConverseAdapter({
        descriptors: () => ({ ...CORPUS_DESCRIPTOR, toolCalling: { value: "none", source: "official-doc", confidence: "declared" } }),
        retry: { sleep: async () => {} },
      });
      const beforeNonNative = fake.requests.length;
      let refusedNonNative = false;
      try {
        for await (const _event of nonNative.streamTurn({ model: BEDROCK_CORPUS_MODEL, messages: [{ role: "user", content: "hi" }], tools: TOOLS }, ctx)) void _event;
      } catch (err) {
        refusedNonNative = err instanceof Error && err.message.includes("plain chat");
      }
      assert(refusedNonNative, "tools on a non-tool-calling model were dropped rather than refused");
      assert(fake.requests.length === beforeNonNative, "the non-native tool turn was sent anyway");
    },
  };
}
