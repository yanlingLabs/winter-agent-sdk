// Lane A's corpus: WS-13 §13's questions, asked of every OpenAI-family adapter.
//
// The runner (`runner.ts`) is frozen and owns the case LIST; this file owns the ANSWERS, once, over
// a `CorpusHarness` that each target supplies. That indirection is what makes the corpus meaningful:
// `openai-responses@1`, `codex-oauth@1`, `openai-chat-completions@1`, `local-openai@1` and
// `azure-openai@1` are asked the same questions in the same words, and a target that cannot answer
// one says so as a FACT about its model (`{ skipped }`) rather than by omitting a case.
//
// TWO RULES EVERY CASE BELOW OBEYS:
//
//   1. THE GROUND TRUTH IS THE FAKE'S RECORDED REQUEST. Not what the adapter believed it sent. Every
//      serialization assertion reads `fake.requests`, and every "we refused before sending" assertion
//      reads `fake.requests.length === 0` — which is the only form of that claim that cannot be
//      satisfied by an adapter that sent the request and ignored the answer.
//
//   2. THE CONSUMER IS THE REAL FOLD. `foldProviderStream` is imported from the runtime's own
//      `bridge.ts` rather than re-implemented, because a re-implementation would agree with this
//      lane and disagree with production. It is reached by relative path: `provider-runtime`'s
//      barrel is frozen and exports no adapters, and this package is test-only, so the import
//      crosses a package boundary deliberately and in the direction the dependency already runs.

import { foldProviderStream } from "../../../runtime/src/provider/bridge.ts";
import type { DiscoveryCache, ModelCatalogResult, ProviderEvent, TurnRequest } from "@yanlinglabs/winter-provider-runtime";
import type { DescriptorOverrides } from "../../../provider-runtime/src/adapters/openai/testing.ts";
import type { CorpusCaseId, CorpusCaseImpl } from "./runner.ts";
import type { FakeServer, RecordedRequest } from "../fakes/server.ts";
import { startFake } from "../fakes/server.ts";
import { openAiModelsRoutes } from "../fakes/openai-models.ts";

// --- the scenario vocabulary -------------------------------------------------------------------------
//
// A case picks its scripted answer by asking for a MODEL ID, which is what lets one fake serve the
// whole corpus (the runner hands every case the same server). The ids are stable strings so a
// failing run names the scenario, not an index.

export const SCENARIO = {
  /** Text + usage, the ordinary turn. */
  happy: "corpus-happy",
  /** One tool call with streamed arguments. */
  tools: "corpus-tools",
  /** Three tool calls in one turn. */
  multiTools: "corpus-multi-tools",
  /** One tool call whose arguments arrive one character at a time. */
  fragmented: "corpus-fragmented",
  /** A reasoning turn: summary deltas plus completed continuation state. */
  reasoning: "corpus-reasoning",
  /** The second leg of a tool loop — the request that must carry the replayed state. */
  replay: "corpus-replay",
  /** A vision turn. */
  vision: "corpus-vision",
  /** A slow stream, for mid-stream cancellation. */
  slow: "corpus-slow",
  /** A stream that opens and then says nothing at all. */
  stall: "corpus-stall",
  /** A stream cut off before its terminator. */
  drop: "corpus-drop",
  /** 401 with a structured provider code. */
  auth: "corpus-auth",
  /** 429 with `Retry-After` as an HTTP-date, then 200. */
  rateLimit: "corpus-rate-limit",
  /** 400 with a body that is not JSON at all. */
  malformed: "corpus-malformed",
  /** 400 whose structured code sits AFTER an unbounded human message. */
  providerCode: "corpus-provider-code",
  /** A turn in which the model invokes something this adapter cannot represent. */
  unrepresentable: "corpus-unrepresentable",
  /** The second leg of a REASONING tool loop. On the chat surface this scenario ANSWERS 400 when the replay is missing (§6.3's hard error). */
  continuationReplay: "corpus-continuation-replay",
} as const;

/** The marker a replay fixture looks for on the wire. Distinctive so `noRequestContains` means something. */
export const OPAQUE_MARKER = "OPAQUE-CONTINUATION-MARKER";
/** A marker that must NEVER reach the wire: state minted in a different continuation domain. */
export const FOREIGN_MARKER = "FOREIGN-DOMAIN-MARKER";

// --- the harness a target supplies ---------------------------------------------------------------------

export interface HarnessOverrides {
  /** Drop the descriptor lookup — the `allowUnlisted` gateway shape, where no capability evidence exists. */
  noDescriptors?: boolean;
  /** Vary the descriptor this turn resolves. */
  descriptor?: DescriptorOverrides;
}

export interface HarnessCapabilities {
  tools: boolean;
  vision: boolean;
  /** `opaque` = Responses' encrypted reasoning items; `exposed` = DeepSeek's replayable text; `none` = neither. */
  continuation: "opaque" | "exposed" | "none";
  effort: boolean;
}

export interface CorpusHarness {
  name: string;
  surface: "responses" | "chat";
  capabilities: HarnessCapabilities;
  /**
   * `live` = the provider serves a catalog endpoint this corpus can page through; `static` = the
   * adapter's catalog is compiled in (codex serves only its own slugs for a ChatGPT account), so the
   * paging questions do not exist for it and the case asks the ones that do.
   */
  discovery: "live" | "static";
  /**
   * False for a declared-LOCAL endpoint, where having no credential is a valid configuration
   * (`local-none` is a first-class auth kind, WS-13 §6) rather than a missing one.
   */
  requiresCredential: boolean;
  /** Where this surface's model listing lives, when it is not at the root (Azure's `/openai/models`). */
  discoveryRoutePrefix?: string;
  /** Runs a turn against `endpoint`. `endpoint` is usually the runner's fake, but a case may point it at a closed server. */
  stream(endpoint: { url: string }, req: TurnRequest, overrides?: HarnessOverrides): AsyncIterable<ProviderEvent>;
  /** Live discovery against `endpoint`. */
  discover(endpoint: { url: string }, opts?: { maxItems?: number; maxBytes?: number; cache?: DiscoveryCache; signal?: AbortSignal }): Promise<ModelCatalogResult>;
  /** Target-specific assertions every recorded request must satisfy (Azure's `api-version`). */
  assertRequest?(recorded: RecordedRequest): void;
}

// --- assertion helpers ----------------------------------------------------------------------------------

function fail(message: string): never {
  throw new Error(message);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) fail(message);
}

/** The parsed body of the request the fake actually received. THE ground truth. */
export function bodyOf(recorded: RecordedRequest): Record<string, unknown> {
  try {
    return JSON.parse(recorded.body) as Record<string, unknown>;
  } catch {
    return fail(`the fake recorded a request whose body is not JSON: ${recorded.body.slice(0, 200)}`);
  }
}

/** The turn requests the fake received — everything but discovery. */
export function turnRequests(fake: FakeServer): RecordedRequest[] {
  return fake.requests.filter((r) => r.method === "POST");
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

function errorOf(events: ProviderEvent[]): Extract<ProviderEvent, { type: "error" }>["error"] {
  const error = events.find((e): e is Extract<ProviderEvent, { type: "error" }> => e.type === "error");
  return error?.error ?? fail(`expected an error event, got [${events.map((e) => e.type).join(", ")}]`);
}

function req(model: string, overrides: Partial<TurnRequest> = {}): TurnRequest {
  return { model, messages: [{ role: "user", content: "corpus question" }], ...overrides };
}

const READ_TOOL = { name: "Read", description: "reads a file", inputSchema: { type: "object", properties: { file_path: { type: "string" } } } };

/** The message list a Responses body carries, or the chat `messages`. Named per surface so an assertion reads the same either way. */
function wireItems(harness: CorpusHarness, body: Record<string, unknown>): unknown[] {
  const items = harness.surface === "responses" ? body.input : body.messages;
  return Array.isArray(items) ? items : fail(`the request body carried no ${harness.surface === "responses" ? "input" : "messages"} array`);
}

// --- the cases -------------------------------------------------------------------------------------------

export function openAiCorpusCases(harness: CorpusHarness): Partial<Record<CorpusCaseId, CorpusCaseImpl>> {
  const skipUnlessTools = (why: string): { skipped: string } => ({ skipped: why });

  return {
    "serialization-and-headers": async ({ fake }) => {
      const before = fake.requests.length;
      const events = await collect(harness.stream(fake, req(SCENARIO.happy, { system: "corpus system", tools: [READ_TOOL] })));
      assert(events.some((e) => e.type === "done"), `the turn did not complete: [${events.map((e) => e.type).join(", ")}]`);
      const recorded = fake.requests[before] ?? fail("the fake recorded no request");
      harness.assertRequest?.(recorded);

      const body = bodyOf(recorded);
      assert(body.model === SCENARIO.happy || recorded.path.includes(SCENARIO.happy), `the wire did not carry the model id: ${JSON.stringify(body.model)} / ${recorded.path}`);
      assert(body.stream === true, "the request did not ask for a stream");
      assert(JSON.stringify(wireItems(harness, body)).includes("corpus question"), "the user's own text never reached the wire");
      assert(JSON.stringify(body).includes("corpus system"), "the system prompt never reached the wire");
      assert(JSON.stringify(body).includes('"Read"'), "the tool never reached the wire");

      // Headers: the fake redacts credential VALUES, so what is assertable (and what matters) is
      // that a credential header was present at all and that the content type is right.
      assert(recorded.headers["content-type"]?.startsWith("application/json") === true, `content-type was ${JSON.stringify(recorded.headers["content-type"])}`);
      const carriedCredential = recorded.headers.authorization !== undefined || recorded.headers["api-key"] !== undefined;
      if (harness.requiresCredential) {
        assert(carriedCredential, `no credential header reached the wire: ${JSON.stringify(Object.keys(recorded.headers))}`);
      } else {
        // A declared-local endpoint with a `none` ref must send NO credential header at all —
        // inventing an empty bearer would be a header the host never configured.
        assert(!carriedCredential, `a local endpoint with no configured credential sent one anyway: ${JSON.stringify(Object.keys(recorded.headers))}`);
      }
    },

    "streaming-order": async ({ fake }) => {
      const events = await collect(harness.stream(fake, req(SCENARIO.tools, { tools: [READ_TOOL] })));
      const types = events.map((e) => e.type);
      const start = types.indexOf("tool_call_start");
      const delta = types.indexOf("tool_call_delta");
      const end = types.indexOf("tool_call_end");
      const done = types.indexOf("done");
      assert(start >= 0 && delta > start && end > delta && done > end, `the normalized events were reordered or coalesced: [${types.join(", ")}]`);
      assert(types.filter((t) => t === "done").length === 1, `the turn reported completion ${types.filter((t) => t === "done").length} times`);
    },

    "tool-call-single": async ({ fake }) => {
      if (!harness.capabilities.tools) return skipUnlessTools("this model's descriptor does not advertise native tool calling");
      const turn = await foldProviderStream(harness.stream(fake, req(SCENARIO.tools, { tools: [READ_TOOL] })));
      assert(turn.kind === "tool_use", `expected a tool_use turn, got ${turn.kind}`);
      assert(turn.kind === "tool_use" && turn.calls.length === 1, "expected exactly one call");
      const call = turn.kind === "tool_use" ? turn.calls[0]! : fail("unreachable");
      assert(call.name === "Read", `the call lost its name: ${call.name}`);
      assert(JSON.stringify(call.input) === JSON.stringify({ file_path: "/tmp/x" }), `the call's arguments did not parse: ${JSON.stringify(call.input)}`);
    },

    "tool-call-multiple": async ({ fake }) => {
      if (!harness.capabilities.tools) return skipUnlessTools("this model's descriptor does not advertise native tool calling");
      const turn = await foldProviderStream(harness.stream(fake, req(SCENARIO.multiTools, { tools: [READ_TOOL] })));
      assert(turn.kind === "tool_use", `expected a tool_use turn, got ${turn.kind}`);
      const calls = turn.kind === "tool_use" ? turn.calls : [];
      assert(calls.length === 3, `expected three calls, got ${calls.length}`);
      // Each keeps its OWN id, name and arguments — the failure this case exists for is calls whose
      // arguments got concatenated into one another.
      assert(new Set(calls.map((c) => c.id)).size === 3, "two calls shared an id");
      assert(calls.map((c) => c.name).join(",") === "Read,Read,Read", "a call lost its name");
      assert(JSON.stringify(calls.map((c) => (c.input as { n?: unknown }).n)) === "[1,2,3]", `the calls' arguments were mixed: ${JSON.stringify(calls.map((c) => c.input))}`);
    },

    "tool-call-fragmented": async ({ fake }) => {
      if (!harness.capabilities.tools) return skipUnlessTools("this model's descriptor does not advertise native tool calling");
      const turn = await foldProviderStream(harness.stream(fake, req(SCENARIO.fragmented, { tools: [READ_TOOL] })));
      const calls = turn.kind === "tool_use" ? turn.calls : [];
      assert(calls.length === 1, `expected one call, got ${calls.length}`);
      assert(JSON.stringify(calls[0]!.input) === JSON.stringify({ a: 1, b: { c: [1, 2, 3] } }), `arguments split across many deltas did not reassemble: ${JSON.stringify(calls[0]!.input)}`);
    },

    "tool-result-replay": async ({ fake }) => {
      if (!harness.capabilities.tools) return skipUnlessTools("this model's descriptor does not advertise native tool calling");
      const before = fake.requests.length;
      await collect(
        harness.stream(
          fake,
          req(SCENARIO.replay, {
            tools: [READ_TOOL],
            messages: [
              { role: "user", content: "read it" },
              { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "Read", input: { file_path: "/tmp/x" } }] },
              { role: "tool", content: [{ type: "tool_result", tool_use_id: "call_1", content: "THE-FILE-CONTENTS" }] },
            ],
          }),
        ),
      );
      const body = bodyOf(fake.requests[before] ?? fail("no request recorded"));
      const wire = JSON.stringify(wireItems(harness, body));
      assert(wire.includes("THE-FILE-CONTENTS"), "the tool result never reached the wire");
      assert(wire.includes("call_1"), "the tool result reached the wire without its original call id, so the provider cannot pair it");
      const paired = harness.surface === "responses" ? wire.includes('"function_call_output"') : wire.includes('"tool_call_id":"call_1"');
      assert(paired, `the tool result did not reach the wire in the ${harness.surface} family's own shape: ${wire.slice(0, 300)}`);
    },

    "cancel-pre-header": async ({ fake }) => {
      const controller = new AbortController();
      controller.abort();
      const before = fake.requests.length;
      const events = await collect(harness.stream(fake, req(SCENARIO.happy, { signal: controller.signal })));
      assert(errorOf(events).code === "aborted", `an abort before the request became ${errorOf(events).code}`);
      assert(!events.some((e) => e.type === "done"), "an aborted turn reported completion");
      assert(fake.requests.length === before, `an abort before the request still sent ${fake.requests.length - before} request(s)`);
    },

    "cancel-mid-stream": async ({ fake }) => {
      const controller = new AbortController();
      const seen: ProviderEvent[] = [];
      let threw: unknown;
      try {
        for await (const event of harness.stream(fake, req(SCENARIO.slow, { signal: controller.signal }))) {
          seen.push(event);
          // Abort as soon as anything real has arrived: what this case proves is that consumption
          // stops PROMPTLY, not that it stops eventually.
          if (seen.length === 1) controller.abort();
        }
      } catch (err) {
        threw = err;
      }
      const aborted = threw !== undefined || seen.some((e) => e.type === "error" && e.error.code === "aborted");
      assert(aborted, `a mid-stream abort produced neither a throw nor an aborted error: [${seen.map((e) => e.type).join(", ")}]`);
      assert(!seen.some((e) => e.type === "done"), "a cancelled turn was reported as complete");
    },

    "usage-accounting": async ({ fake }) => {
      const turn = await foldProviderStream(harness.stream(fake, req(SCENARIO.happy)));
      // Carried THROUGH UNMODIFIED — the fake scripts 12/5 with 4 cached, and any arithmetic here
      // would be Winter inventing an accounting rule the provider did not state.
      assert(turn.usage?.inputTokens === 12 && turn.usage.outputTokens === 5, `usage was altered in transit: ${JSON.stringify(turn.usage)}`);
      assert(turn.usage?.cacheReadTokens === 4, `cache tokens were dropped: ${JSON.stringify(turn.usage)}`);
    },

    "error-auth": async ({ fake }) => {
      const events = await collect(harness.stream(fake, req(SCENARIO.auth)));
      const error = errorOf(events);
      assert(error.code === "auth", `a 401 normalized to ${error.code}`);
      assert(error.status === 401, `the status was lost: ${String(error.status)}`);
      assert(error.providerCode === "invalid_api_key", `the provider's own code was lost: ${String(error.providerCode)}`);
      assert(error.retryable === false, "a 401 was marked retryable");
    },

    "error-rate-limit": async ({ fake }) => {
      const events = await collect(harness.stream(fake, req(SCENARIO.rateLimit)));
      const retry = events.find((e): e is Extract<ProviderEvent, { type: "retry" }> => e.type === "retry");
      assert(retry !== undefined, `a 429 produced no retry observation: [${events.map((e) => e.type).join(", ")}]`);
      // R6-B, the whole point: the pinned 429 path is `api_retry` with `error: "rate_limit"`, and a
      // header-derived limit NEVER becomes a `rate_limit` frame.
      assert(retry.errorStatus === 429, `the retry did not carry the status: ${String(retry.errorStatus)}`);
      assert(retry.error === "rate_limit", `the retry's error taxonomy member was ${retry.error}`);
      assert(events.some((e) => e.type === "done"), "the turn did not recover after the 429");
    },

    "error-timeout": async ({ fake }) => {
      const events = await collect(harness.stream(fake, req(SCENARIO.stall)));
      const error = errorOf(events);
      assert(error.code === "stall", `a silent stream became ${error.code} rather than a typed stall`);
      assert(error.retryable === false, "a stall was marked retryable, but bytes had already flowed");
    },

    "error-network": async () => {
      // A CLOSED server, so the failure is a real connection failure rather than a scripted status.
      const dead = await startFake({ routes: [] });
      const url = dead.url;
      await dead.close();
      const events = await collect(harness.stream({ url }, req(SCENARIO.happy)));
      const error = errorOf(events);
      assert(error.code === "network", `a refused connection normalized to ${error.code}`);
      // ABSENT, not null: the pinned `api_retry.error_status: number | null` distinguishes exactly
      // this case, and an own `status` key holding undefined would make `"status" in err` lie.
      assert(!("status" in error), "a connection error carried an HTTP status it never had");
    },

    "error-malformed": async ({ fake }) => {
      const events = await collect(harness.stream(fake, req(SCENARIO.malformed)));
      const error = errorOf(events);
      assert(error.code === "bad_request", `an unparseable error body became ${error.code}`);
      assert(!events.some((e) => e.type === "done"), "a malformed response surfaced as a half-decoded turn");
    },

    "error-provider-codes": async ({ fake }) => {
      const events = await collect(harness.stream(fake, req(SCENARIO.providerCode)));
      const error = errorOf(events);
      // Parsed off the FULL body BEFORE truncation: the envelope puts `code` after an unbounded
      // human message, so a parser that read the 200-char snippet would find nothing.
      assert(error.providerCode === "context_length_exceeded", `the structured code was lost to truncation: ${String(error.providerCode)}`);
      assert(error.message.length < 400, `the error message was not bounded: ${error.message.length} chars`);
    },

    "retry-after-no-replay": async ({ fake }) => {
      const before = fake.requests.length;
      const events = await collect(harness.stream(fake, req(SCENARIO.rateLimit)));
      const retry = events.find((e): e is Extract<ProviderEvent, { type: "retry" }> => e.type === "retry") ?? fail("no retry observation");
      // The fake's `Retry-After` is an HTTP-DATE two seconds out. R6-6 as refined: the header
      // REPLACES the schedule (capped at 60s), it is not a floor on a jittered delay.
      assert(retry.retryDelayMs >= 1000 && retry.retryDelayMs <= 3000, `Retry-After (an HTTP-date ~2s out) did not replace the backoff: ${retry.retryDelayMs}ms`);
      assert(fake.requests.length - before === 2, `expected exactly one retry, saw ${fake.requests.length - before} requests`);

      // And the other half: NOTHING is replayed once the first byte was consumed. A stream that
      // dies mid-flight is final, however retryable its shape looks.
      const dropBefore = fake.requests.length;
      const dropped = await collect(harness.stream(fake, req(SCENARIO.drop)));
      assert(errorOf(dropped).retryable === false, "a mid-stream failure was marked retryable");
      assert(fake.requests.length - dropBefore === 1, `a mid-stream failure was REPLAYED: ${fake.requests.length - dropBefore} requests`);
    },

    "effort-mapping": async ({ fake }) => {
      if (!harness.capabilities.effort) return { skipped: "this model's descriptor declares no effort vocabulary" };
      const before = fake.requests.length;
      // Mapped: a tier the model verifies reaches the wire in the surface's own field.
      await collect(harness.stream(fake, req(SCENARIO.happy, { effort: "high" })));
      const body = bodyOf(fake.requests[before] ?? fail("no request recorded"));
      const onWire = harness.surface === "responses" ? JSON.stringify(body.reasoning) : JSON.stringify(body.reasoning_effort);
      assert(onWire.includes("high"), `effort did not reach the wire: ${onWire}`);

      // Rejected: a tier the model does NOT verify is refused BEFORE the request, which is only
      // provable by the fake receiving nothing.
      const refusedBefore = fake.requests.length;
      const events = await collect(harness.stream(fake, req(SCENARIO.happy, { effort: "xhigh" }), { descriptor: { efforts: ["low", "medium", "high"] } }));
      assert(errorOf(events).code === "capability", `an unsupported effort became ${errorOf(events).code}`);
      assert(fake.requests.length === refusedBefore, `an unsupported effort was SENT anyway: ${fake.requests.length - refusedBefore} request(s)`);

      // And with NO descriptor at all — the `allowUnlisted` gateway shape, where a model has no
      // catalog evidence — the two arms deliberately differ: a NAMED tier passes through (the pin
      // defines it and Winter has nothing to contradict it), a NUMERIC one is refused, because
      // snapping a number needs a vocabulary that does not exist.
      const gatewayBefore = fake.requests.length;
      await collect(harness.stream(fake, req(SCENARIO.happy, { effort: "high" }), { noDescriptors: true }));
      assert(fake.requests.length === gatewayBefore + 1, "a named effort on an unlisted model was refused rather than passed through");
      const numeric = await collect(harness.stream(fake, req(SCENARIO.happy, { effort: 4 }), { noDescriptors: true }));
      assert(errorOf(numeric).code === "capability", `a numeric effort on an unlisted model became ${errorOf(numeric).code}`);
      assert(fake.requests.length === gatewayBefore + 1, "a numeric effort with no vocabulary to snap against was SENT anyway");
    },

    "opaque-continuation": async ({ fake }) => {
      if (harness.capabilities.continuation === "none") return { skipped: "this model's descriptor declares no native continuation state" };

      // Leg 1: the state is minted, and it comes from the COMPLETION event.
      const turn = await foldProviderStream(harness.stream(fake, req(SCENARIO.reasoning, { effort: "high", requestSummary: true, tools: [READ_TOOL] })));
      const items = turn.nativeState?.items ?? [];
      assert(items.length > 0, "the turn produced no continuation state at all");
      const serialized = JSON.stringify(items);
      assert(serialized.includes(OPAQUE_MARKER), `the captured state is not the completed one: ${serialized.slice(0, 200)}`);
      assert(!serialized.includes("PARTIAL"), "the adapter captured the PARTIAL copy from output_item.added rather than the completed one");

      // Leg 2: replayed EXACTLY, inside its own domain. The chat surface's fake additionally
      // ANSWERS 400 when the replay is missing, which is §6.3's documented hard error.
      const before = fake.requests.length;
      const events = await collect(
        harness.stream(
          fake,
          req(SCENARIO.continuationReplay, {
            tools: [READ_TOOL],
            messages: [
              { role: "user", content: "go" },
              {
                role: "assistant",
                content: [{ type: "tool_use", id: "call_1", name: "Read", input: {} }],
                nativeState: { family: "openai", continuationDomain: "corpus-domain", items },
              },
              { role: "tool", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }] },
            ],
          }),
        ),
      );
      assert(events.some((e) => e.type === "done"), `the replayed tool loop failed: ${JSON.stringify(events.find((e) => e.type === "error"))}`);
      const replayed = bodyOf(fake.requests[before] ?? fail("no request recorded"));
      assert(JSON.stringify(replayed).includes(OPAQUE_MARKER), "the continuation state was not replayed onto the wire");
    },

    "limit-rejection": async ({ fake }) => {
      const before = fake.requests.length;
      const events = await collect(harness.stream(fake, req(SCENARIO.happy, { maxOutputTokens: 999_999 }), { descriptor: { maxOutputTokens: 4096 } }));
      assert(errorOf(events).code === "capability", `an over-limit request became ${errorOf(events).code}`);
      assert(fake.requests.length === before, `an over-limit request was SENT and failed upstream instead of being rejected: ${fake.requests.length - before} request(s)`);
    },

    "vision-where-advertised": async ({ fake }) => {
      if (!harness.capabilities.vision) return { skipped: "this model's descriptor does not advertise image input" };
      const before = fake.requests.length;
      await collect(
        harness.stream(fake, req(SCENARIO.vision, { messages: [{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJDRA==" } }] }] })),
      );
      const wire = JSON.stringify(wireItems(harness, bodyOf(fake.requests[before] ?? fail("no request recorded"))));
      assert(wire.includes("QUJDRA=="), "the image data never reached the wire");
      // The two surfaces disagree on the shape, and getting it backwards is a 400 on both.
      const shaped = harness.surface === "responses" ? wire.includes('"input_image"') && wire.includes('"image_url":"data:image/png;base64,') : wire.includes('"image_url":{"url":"data:image/png;base64,');
      assert(shaped, `the image did not reach the wire in the ${harness.surface} family's own shape: ${wire.slice(0, 300)}`);
    },

    "discovery-edge-cases": async () => {
      if (harness.discovery === "static") {
        // A STATIC catalog is not a weaker answer to this question, it is a different one: there is
        // no endpoint to page, so what remains askable is whether the compiled set is bounded,
        // validated and honestly non-partial — and it is asked through the SAME `discoverModels`
        // bounds layer every live target goes through, not around it.
        const all = await harness.discover({ url: "http://127.0.0.1:1" });
        assert(all.models.length > 0, "a static catalog reported no models at all");
        assert(all.partial === false && all.cached === false, `a static catalog reported partial=${all.partial} cached=${all.cached}`);
        assert(all.models.every((m) => m.id.length > 0 && !/\s/.test(m.id)), `a static catalog carried an unusable id: ${JSON.stringify(all.models.map((m) => m.id))}`);
        assert(new Set(all.models.map((m) => m.id)).size === all.models.length, "a static catalog carried a duplicate id");
        const bounded = await harness.discover({ url: "http://127.0.0.1:1" }, { maxItems: 1 });
        assert(bounded.models.length === 1 && bounded.partial === true, `an item bound did not truncate-and-disclose: ${bounded.models.length} models, partial=${bounded.partial}`);
        return;
      }
      // Its OWN fake: this case needs a stateful `/models` that pages, then fails — contorting the
      // corpus's shared server into that would make every other case depend on discovery's state.
      const discovery = await startFake({
        routes: openAiModelsRoutes({
          pages: [
            {
              rows: [
                { id: "alpha", display_name: "Alpha", context_window: 1000 },
                { id: "beta" },
                { id: "alpha" }, // a duplicate
                { nope: true }, // malformed: no id at all
                { id: "  " }, // malformed: whitespace-only
              ],
              hasMore: true,
            },
            { rows: [{ id: "gamma" }] },
          ],
          failOnCall: { call: 3, status: 503 },
          ...(harness.discoveryRoutePrefix !== undefined ? { pathPrefix: harness.discoveryRoutePrefix } : {}),
        }),
      });
      try {
        const cache = makeCache();
        const first = await harness.discover(discovery, { cache });
        const ids = first.models.map((m) => m.id);
        assert(ids.join(",") === "alpha,beta,gamma", `pagination/dedup/validation went wrong: [${ids.join(", ")}]`);
        assert(first.warnings.some((w) => w.includes("duplicate")), "a duplicate id was accepted without a warning");
        assert(first.warnings.some((w) => w.includes("no usable id")), "malformed rows were dropped without being counted");
        assert(first.cached === false && first.partial === false, `a complete walk reported partial=${first.partial} cached=${first.cached}`);

        // A failure with a cache serves the CACHED answer and says so — a stale list reported as
        // current would read as "these models were removed".
        const second = await harness.discover(discovery, { cache });
        assert(second.cached === true, "a discovery failure did not fall back to the cached catalog");
        assert(second.warnings.some((w) => w.includes("out of date")), "a cached fallback did not disclose that it may be stale");

        // And a failure with NO cache PROPAGATES rather than reporting an empty catalog.
        let threw = false;
        try {
          await harness.discover(discovery);
        } catch {
          threw = true;
        }
        assert(threw, "a discovery failure with no cache returned a catalog instead of propagating");
      } finally {
        await discovery.close();
      }
    },

    "identity-across-resume": async ({ fake }) => {
      // A resume rebuilds the adapter and the history from the store. What must survive is that the
      // WIRE is a pure function of that history: same messages, same annotations, byte-identical
      // request. Anything that leaked from process-local state shows up here as a difference.
      const history: TurnRequest["messages"] = [
        { role: "user", content: "before the resume" },
        {
          role: "assistant",
          content: [{ type: "text", text: "answered" }],
          origin: { providerId: "corpus", modelKey: `corpus/${SCENARIO.happy}`, family: "openai", continuationDomain: "corpus-domain" },
          ...(harness.capabilities.continuation !== "none" ? { nativeState: { family: "openai", continuationDomain: "corpus-domain", items: [continuationItem(harness)] } } : {}),
        },
        { role: "user", content: "after the resume" },
      ];
      const beforeA = fake.requests.length;
      await collect(harness.stream(fake, req(SCENARIO.happy, { system: "s", messages: history })));
      const beforeB = fake.requests.length;
      await collect(harness.stream(fake, req(SCENARIO.happy, { system: "s", messages: history })));
      const a = fake.requests[beforeA] ?? fail("no first request");
      const b = fake.requests[beforeB] ?? fail("no second request");
      assert(a.body === b.body, "two turns over the identical history produced different wire requests");
      assert(a.path === b.path && a.search === b.search, "two turns over the identical history addressed different URLs");
    },

    "no-silent-tool-dropping": async ({ fake }) => {
      // Response side: the model invokes something this adapter cannot express.
      const events = await collect(harness.stream(fake, req(SCENARIO.unrepresentable, { tools: [READ_TOOL] })));
      const error = errorOf(events);
      assert(error.code === "capability", `an unrepresentable call became ${error.code} rather than a capability failure`);

      // Request side: a tool that cannot be represented is refused BEFORE the request, never
      // dropped from the tools array.
      const before = fake.requests.length;
      const refused = await collect(harness.stream(fake, req(SCENARIO.happy, { tools: [READ_TOOL, { name: "", description: "d", inputSchema: { type: "object" } }] })));
      assert(errorOf(refused).code === "bad_request", `an unrepresentable tool became ${errorOf(refused).code}`);
      assert(fake.requests.length === before, "a turn carrying an unrepresentable tool was sent with the tool quietly dropped");
    },
  };
}

/** The continuation item shape this target's surface actually mints, so the identity case builds a realistic history. */
function continuationItem(harness: CorpusHarness): unknown {
  return harness.capabilities.continuation === "exposed" ? { type: "winter.exposed_reasoning", text: OPAQUE_MARKER } : { type: "reasoning", encrypted_content: OPAQUE_MARKER };
}

/** A process-lifetime discovery cache, matching `createDiscoveryCache`'s contract without importing the frozen barrel's value export twice. */
function makeCache(): DiscoveryCache {
  const entries = new Map<string, ModelCatalogResult>();
  return {
    get: (key) => entries.get(key),
    set: (key, value) => {
      entries.set(key, value);
    },
  };
}
