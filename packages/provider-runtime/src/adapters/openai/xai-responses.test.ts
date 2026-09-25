// WS-23: the api-key `xai` provider on the Responses adapter, driven through the SHIPPED wiring.
//
// Every test here builds its adapter with `createShippedAdapters(loadCatalog())` — the production
// construction site — and resolves `xai/*` rows off the REAL catalog, so what is under test is the
// catalog's facts and the adapter's behaviour together, not either against a fixture of itself.
//
// NO NETWORK, AND NO LOOPBACK EITHER. The base-URL rule is only provable against the real host
// (`api.x.ai`), which a loopback fake cannot stand in for, so `globalThis.fetch` is replaced for the
// duration of each test: every request `boundedFetch` makes is RECORDED (url, method, headers, parsed
// body) and answered from a script. Nothing leaves the process, and the recorded requests — never the
// config that produced them — are what every assertion reads.
//
// NO REAL CREDENTIALS: the key is `testing.ts`'s `test-key-openai-0000`.

import { afterEach, describe, expect, test } from "bun:test";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { ProviderAdapter, ProviderEvent, ProviderMessageLike, TurnRequest } from "../../types.ts";
import { classifySwitch } from "../../continuity/warnings.ts";
import { createShippedAdapters } from "../index.ts";
import { createResponsesAdapter } from "./responses.ts";
import { TEST_API_KEY, collect, soleError, testContext } from "./testing.ts";

const catalog = loadCatalog();
const responsesAdapter = (): ProviderAdapter => createShippedAdapters(catalog).find((a) => a.id === "winter.openai-responses")!;

interface Recorded {
  url: string;
  method: string;
  authorization: string | null;
  /** The two OpenAI account headers — recorded so a test can prove they never reach xAI. */
  organization: string | null;
  project: string | null;
  body: Record<string, unknown> | undefined;
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

/** Replaces `fetch` for one test. `respond` answers the n-th request (0-based). */
function stubFetch(respond: (request: Recorded, n: number) => Response): Recorded[] {
  const original = globalThis.fetch;
  const requests: Recorded[] = [];
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const recorded: Recorded = {
      url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      organization: headers.get("openai-organization"),
      project: headers.get("openai-project"),
      body: raw !== undefined ? (JSON.parse(raw) as Record<string, unknown>) : undefined,
    };
    requests.push(recorded);
    return respond(recorded, requests.length - 1);
  };
  globalThis.fetch = fake as unknown as typeof fetch;
  restore = () => {
    globalThis.fetch = original;
  };
  return requests;
}

function sse(events: Array<Record<string, unknown>>): Response {
  // xAI documents its stream as terminated by `data: [DONE]` (Responses reference, `stream`); the
  // mapper must finish on `response.completed` and treat the sentinel as the non-event it is.
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** One whole Responses turn: an optional reasoning item, some text, `response.completed` with usage. */
function turnStream(opts: { encrypted?: string; text?: string; usage?: Record<string, unknown>; reasoningText?: string } = {}): Response {
  const events: Array<Record<string, unknown>> = [{ type: "response.created", response: { id: "resp_1", model: "grok-4.7" } }];
  if (opts.reasoningText !== undefined) events.push({ type: "response.reasoning_text.delta", delta: opts.reasoningText });
  if (opts.encrypted !== undefined) {
    // xAI's own example reasoning item has an EMPTY `id` and a `summary` array (Responses reference).
    events.push({
      type: "response.output_item.done",
      output_index: 0,
      item: { id: "", type: "reasoning", summary: [{ type: "summary_text", text: "thinking about it" }], encrypted_content: opts.encrypted, status: "completed" },
    });
  }
  events.push({ type: "response.output_text.delta", delta: opts.text ?? "303" });
  events.push({ type: "response.output_item.done", output_index: 1, item: { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: opts.text ?? "303" }] } });
  events.push({ type: "response.completed", response: { id: "resp_1", status: "completed", usage: opts.usage ?? { input_tokens: 40, input_tokens_details: { cached_tokens: 8 }, output_tokens: 120, output_tokens_details: { reasoning_tokens: 110 }, total_tokens: 160 } } });
  return sse(events);
}

const xaiCtx = () => testContext({ providerId: "xai" });
const ask = (overrides: Partial<TurnRequest>): TurnRequest => ({ model: "grok-4.7", messages: [{ role: "user", content: "What is 101*3?" }], ...overrides });

describe("the base URL is the PROVIDER's own, never the adapter's vendor's (WS-23 item 2)", () => {
  test("an `xai` turn with NO connection baseUrl goes to api.x.ai — the catalog row's endpoint, via the shipped wiring", async () => {
    const requests = stubFetch(() => turnStream());
    const events = await collect(responsesAdapter().streamTurn(ask({}), xaiCtx()));
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(requests.map((r) => [r.method, r.url])).toEqual([["POST", "https://api.x.ai/v1/responses"]]);
    expect(requests[0]!.authorization).toBe(`Bearer ${TEST_API_KEY}`);
  });

  test("`openai` on the same adapter instance still reaches api.openai.com — the second provider changed nobody else's host", async () => {
    const requests = stubFetch(() => turnStream());
    await collect(responsesAdapter().streamTurn(ask({ model: "gpt-4.1" }), testContext({ providerId: "openai" })));
    expect(requests.map((r) => r.url)).toEqual(["https://api.openai.com/v1/responses"]);
  });

  test("credential validation and discovery follow the same rule: `GET api.x.ai/v1/models`", async () => {
    const requests = stubFetch(() => new Response(JSON.stringify({ data: [{ id: "grok-4.7" }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const status = await responsesAdapter().validateCredential({ kind: "keychain", account: "openai:test" }, xaiCtx());
    expect(status).toEqual({ ok: true });
    expect(requests.map((r) => [r.method, r.url])).toEqual([["GET", "https://api.x.ai/v1/models"]]);
  });

  test("a provider the catalog does not put on this adapter has NO endpoint: refused typed, and nothing is sent", async () => {
    const requests = stubFetch(() => turnStream());
    const events = await collect(responsesAdapter().streamTurn(ask({ model: "some-model" }), testContext({ providerId: "not-on-this-adapter" })));
    const error = soleError(events).error;
    expect([error.code, error.retryable]).toEqual(["capability", false]);
    expect(error.message).toContain('provider "not-on-this-adapter" has no endpoint');
    expect(requests).toEqual([]);
  });

  test("a HAND-WIRED Responses adapter (no catalog lookup) keeps OpenAI's host for `openai` only — an `xai` connection with no baseUrl is refused, not sent to OpenAI", async () => {
    const handWired = createResponsesAdapter({ descriptors: () => undefined });
    const requests = stubFetch(() => turnStream());
    const refused = await collect(handWired.streamTurn(ask({}), xaiCtx()));
    expect(soleError(refused).error.code).toBe("capability");
    expect(requests).toEqual([]);
    await collect(handWired.streamTurn(ask({ model: "gpt-4.1" }), testContext({ providerId: "openai" })));
    expect(requests.map((r) => r.url)).toEqual(["https://api.openai.com/v1/responses"]);
  });

  test("OpenAI's account headers ride ONLY an `openai` turn — never an `xai` one on the same adapter (fix round 1, M5)", async () => {
    // A host that configures `organization`/`project` does so for its OpenAI account. xAI's endpoint is
    // a REVIEWED one, so the endpoint gate would have let them through; the provider gate does not.
    const endpoints: Record<string, string> = { openai: "https://api.openai.com/v1", xai: "https://api.x.ai/v1" };
    const adapter = createResponsesAdapter({ descriptors: () => undefined, organization: "org-test-ws23", project: "proj-test-ws23", generatedBaseUrls: (id) => endpoints[id] });
    const requests = stubFetch((request) => (request.method === "GET" ? new Response(JSON.stringify({ data: [] }), { status: 200 }) : turnStream()));
    await collect(adapter.streamTurn(ask({}), xaiCtx()));
    await adapter.validateCredential({ kind: "keychain", account: "openai:test" }, xaiCtx());
    await collect(adapter.streamTurn(ask({ model: "gpt-4.1" }), testContext({ providerId: "openai" })));
    expect(requests.map((r) => [new URL(r.url).host, r.organization, r.project])).toEqual([
      ["api.x.ai", null, null],
      ["api.x.ai", null, null],
      ["api.openai.com", "org-test-ws23", "proj-test-ws23"],
    ]);
  });

  test("an operator's own baseUrl still wins verbatim", async () => {
    const requests = stubFetch(() => turnStream());
    await collect(responsesAdapter().streamTurn(ask({}), testContext({ providerId: "xai", baseUrl: "https://us.api.x.ai/v1" })));
    expect(requests.map((r) => r.url)).toEqual(["https://us.api.x.ai/v1/responses"]);
  });
});

describe("an xai REASONING turn's request body (WS-23 item 5)", () => {
  test("grok-4.7 at an explicit effort: `reasoning.effort` on the wire, `include` asks for the encrypted item, stateless `store: false`", async () => {
    const requests = stubFetch(() => turnStream());
    await collect(responsesAdapter().streamTurn(ask({ effort: "medium", system: "Be brief." }), xaiCtx()));
    const body = requests[0]!.body!;
    expect(body).toMatchObject({
      model: "grok-4.7",
      instructions: "Be brief.",
      reasoning: { effort: "medium" },
      include: ["reasoning.encrypted_content"],
      store: false,
      stream: true,
    });
    expect("max_output_tokens" in body).toBe(false);
    expect("previous_response_id" in body).toBe(false);
  });

  test("effort maps onto the row's OWN vocabulary: a numeric effort snaps to a tier grok-4.7 verifies, `thinking` falls back to its documented default", async () => {
    const requests = stubFetch(() => turnStream());
    await collect(responsesAdapter().streamTurn(ask({ effort: 4 }), xaiCtx()));
    await collect(responsesAdapter().streamTurn(ask({ thinking: { type: "adaptive" } }), xaiCtx()));
    expect(requests.map((r) => (r.body!.reasoning as { effort?: string }).effort)).toEqual(["xhigh", "high"]);
  });

  test("an effort outside the row's vocabulary is refused BEFORE the request (grok-4.5 lists no `xhigh`; no grok row lists `max`)", async () => {
    const requests = stubFetch(() => turnStream());
    const onFourFive = soleError(await collect(responsesAdapter().streamTurn(ask({ model: "grok-4.5", effort: "xhigh" }), xaiCtx()))).error;
    const onFourSeven = soleError(await collect(responsesAdapter().streamTurn(ask({ effort: "max" }), xaiCtx()))).error;
    for (const error of [onFourFive, onFourSeven]) expect([error.code, error.message.includes("verified vocabulary")]).toEqual(["capability", true]);
    expect(requests).toEqual([]);
  });

  test("a summary request sends `reasoning.summary` from grok-4.7's own evidence (`detailed`, the value xAI returns regardless)", async () => {
    const requests = stubFetch(() => turnStream());
    await collect(responsesAdapter().streamTurn(ask({ effort: "low", requestSummary: true }), xaiCtx()));
    expect(requests[0]!.body!.reasoning).toEqual({ effort: "low", summary: "detailed" });
  });

  test("usage: the TOTAL-prompt report is normalized to the seam's convention (non-cached input, cached as cacheRead)", async () => {
    stubFetch(() => turnStream());
    const events = await collect(responsesAdapter().streamTurn(ask({ effort: "low" }), xaiCtx()));
    expect(events.find((e) => e.type === "usage")).toEqual({ type: "usage", inputTokens: 32, cacheReadTokens: 8, outputTokens: 120 });
  });
});

describe("encrypted reasoning REPLAYS across turns (WS-23 item 5)", () => {
  test("turn 1's encrypted reasoning item comes back as `native_state`; turn 2 sends it verbatim, ahead of the answer it produced", async () => {
    const requests = stubFetch((_, n) => turnStream(n === 0 ? { encrypted: "ENC-OPAQUE-1", text: "303" } : { text: "606" }));
    const adapter = responsesAdapter();
    const first = await collect(adapter.streamTurn(ask({ effort: "high" }), xaiCtx()));
    const state = first.find((e): e is Extract<ProviderEvent, { type: "native_state" }> => e.type === "native_state");
    // `id` and `status` are response-only fields and are stripped; the rest is carried untouched.
    expect(state?.items).toEqual([{ type: "reasoning", summary: [{ type: "summary_text", text: "thinking about it" }], encrypted_content: "ENC-OPAQUE-1" }]);

    const descriptor = catalog.models.find((m) => m.key === "xai/grok-4.7")!;
    const capabilities = adapter.capabilities(descriptor);
    expect([capabilities.continuationDomain, capabilities.readableState]).toEqual(["xai/grok-4.7", "summary"]);

    const history: ProviderMessageLike[] = [
      { role: "user", content: "What is 101*3?" },
      { role: "assistant", content: "303", nativeState: { family: "openai", continuationDomain: capabilities.continuationDomain!, items: state!.items } },
      { role: "user", content: "And doubled?" },
    ];
    await collect(adapter.streamTurn(ask({ effort: "high", messages: history }), xaiCtx()));
    expect(requests[1]!.body!.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "What is 101*3?" }] },
      { type: "reasoning", summary: [{ type: "summary_text", text: "thinking about it" }], encrypted_content: "ENC-OPAQUE-1" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "303" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "And doubled?" }] },
    ]);
  });

  test("an EFFORTLESS turn still asks for the encrypted item on every opaque xai row — the knob-less two included (fix round 1, I3)", async () => {
    // `grok-build-0.1` and `grok-4.20-0309-reasoning` take no effort, so no turn could ASK them to
    // reason; before I3 they declared a continuation domain the adapter never filled.
    for (const model of ["grok-4.7", "grok-4.20-0309-reasoning", "grok-build-0.1"]) {
      const requests = stubFetch(() => turnStream({ encrypted: `ENC-${model}` }));
      const events = await collect(responsesAdapter().streamTurn(ask({ model }), xaiCtx()));
      restore?.();
      expect([model, requests[0]!.body!.include, "reasoning" in requests[0]!.body!]).toEqual([model, ["reasoning.encrypted_content"], false]);
      expect([model, events.find((e) => e.type === "native_state")]).toEqual([model, { type: "native_state", items: [expect.objectContaining({ encrypted_content: `ENC-${model}` })] }]);
    }
  });

  test("the switch warning a knob-less row raises now describes state the adapter CAPTURED, not state it never asked for (fix round 1, I3)", () => {
    // The classifier is capability-driven (`continuation !== "none"` means "may hold state"), so the
    // warning on leaving these rows stands — what I3 changes is that it is TRUE: the turn above asked
    // for the item and the row's domain holds it. Pinned so the two facts cannot drift apart again.
    const adapter = responsesAdapter();
    for (const key of ["xai/grok-4.20-0309-reasoning", "xai/grok-build-0.1"]) {
      const from = catalog.models.find((m) => m.key === key)!;
      const to = catalog.models.find((m) => m.key === "openai/gpt-4.1")!;
      const fromCaps = adapter.capabilities(from);
      expect(fromCaps.continuationDomain).toBe(key);
      const verdict = classifySwitch(
        { providerId: "xai", modelKey: key, family: "openai", continuationDomain: fromCaps.continuationDomain, readableState: fromCaps.readableState, continuation: from.reasoning!.continuation },
        { providerId: "openai", modelKey: to.key, family: "openai", readableState: "none", continuation: "none" },
      );
      expect([key, verdict.lossClass]).toEqual([key, "warned-lossy"]);
    }
  });

  test("a reasoning-TEXT delta from grok-4.7 surfaces as its readable summary (fix round 1, M1)", async () => {
    stubFetch(() => turnStream({ reasoningText: "weighing it" }));
    const events = await collect(responsesAdapter().streamTurn(ask({}), xaiCtx()));
    expect(events.filter((e) => e.type === "thinking_summary_delta")).toEqual([{ type: "thinking_summary_delta", text: "weighing it" }]);
  });
});

describe("the Responses-only MULTI-AGENT row (WS-23 item 1)", () => {
  const MODEL = "grok-4.20-multi-agent-0309";

  test("a plain turn sends the dated model id, an agent-count effort, and NO `max_output_tokens`", async () => {
    const requests = stubFetch(() => turnStream());
    await collect(responsesAdapter().streamTurn(ask({ model: MODEL, effort: "low" }), xaiCtx()));
    const body = requests[0]!.body!;
    expect([body.model, body.reasoning, body.include]).toEqual([MODEL, { effort: "low" }, ["reasoning.encrypted_content"]]);
    // No client tools, so no tool surface at all — not even an empty one (fix round 1, M2).
    for (const field of ["tools", "tool_choice", "parallel_tool_calls", "max_output_tokens"]) expect([field, field in body]).toEqual([field, false]);
  });

  test("a `tools` array is refused BEFORE the request — xAI supports no client-side function calling on this model", async () => {
    const requests = stubFetch(() => turnStream());
    // The guide's undated spelling resolves the same row through its alias.
    for (const model of [MODEL, "grok-4.20-multi-agent"]) {
      const events = await collect(responsesAdapter().streamTurn(ask({ model, tools: [{ name: "Read", description: "read a file", inputSchema: { type: "object", properties: {} } }] }), xaiCtx()));
      const error = soleError(events).error;
      expect([model, error.code, error.retryable, error.message.includes('"tools"')]).toEqual([model, "capability", false, true]);
    }
    expect(requests).toEqual([]);
  });

  test("an output cap is refused BEFORE the request — `max_tokens` is unsupported, and on Responses that field is `max_output_tokens`", async () => {
    const requests = stubFetch(() => turnStream());
    const error = soleError(await collect(responsesAdapter().streamTurn(ask({ model: MODEL, maxOutputTokens: 4096 }), xaiCtx()))).error;
    expect([error.code, error.message.includes('"max_output_tokens"')]).toEqual(["capability", true]);
    expect(requests).toEqual([]);
  });

  test("the catalog says so to the host too: tool calling `none`", () => {
    const descriptor = catalog.models.find((m) => m.key === `xai/${MODEL}`)!;
    expect(responsesAdapter().capabilities(descriptor).toolCalling).toBe("none");
  });
});

describe("xAI's flat error body through the adapter (WS-23 item 3)", () => {
  const WRONG_KEY = JSON.stringify({ code: "Client specified an invalid argument", error: "Incorrect API key provided: xa***Jm. You can obtain an API key from https://console.x.ai." });

  test("a wrong key answered with HTTP 400 fails the turn as `auth`, once, without a retry", async () => {
    const requests = stubFetch(() => new Response(WRONG_KEY, { status: 400, headers: { "content-type": "application/json" } }));
    const error = soleError(await collect(responsesAdapter().streamTurn(ask({ effort: "low" }), xaiCtx()))).error;
    expect([error.code, error.status, error.providerCode]).toEqual(["auth", 400, "Client specified an invalid argument"]);
    expect(requests.length).toBe(1);
  });

  test("…and credential validation reports it as an INVALID credential, not an unreachable endpoint", async () => {
    stubFetch(() => new Response(WRONG_KEY, { status: 400, headers: { "content-type": "application/json" } }));
    const status = await responsesAdapter().validateCredential({ kind: "keychain", account: "openai:test" }, xaiCtx());
    expect(status).toMatchObject({ ok: false, code: "invalid" });
  });
});
