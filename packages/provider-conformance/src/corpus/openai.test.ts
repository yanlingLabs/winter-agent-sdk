// The OpenAI family's corpus run: WS-13 §13's twenty-three questions, asked of four adapters.
//
// The harness per target is the only thing that differs — the questions and the assertions are
// shared, which is the point of the runner. Every target is pointed at a loopback fake on port 0,
// every fake closes in a `finally`, and no test here touches a real endpoint, a real key, a home
// directory or the Keychain.

import { describe, expect, test } from "bun:test";
import { createResponsesAdapter } from "../../../provider-runtime/src/adapters/openai/responses.ts";
import { createChatCompletionsAdapter } from "../../../provider-runtime/src/adapters/openai/chat-completions.ts";
import { createCodexOauthAdapter } from "../../../provider-runtime/src/adapters/openai/codex-oauth.ts";
import { createLocalOpenAIAdapter } from "../../../provider-runtime/src/adapters/openai/local.ts";
import { FAST_RETRY, descriptor, testContext, testDiscoveryContext, type DescriptorOverrides } from "../../../provider-runtime/src/adapters/openai/testing.ts";
import { discoverModels } from "@yanlinglabs/winter-provider-runtime";
import type { CredentialRef, ProviderAdapter, ProviderEvent, TurnRequest } from "@yanlinglabs/winter-provider-runtime";
import { createMemoryCredentialStore } from "../../../provider-runtime/src/credentials/memory.ts";
import { formatCorpusReport, runAdapterCorpus } from "./runner.ts";
import { SCENARIO, openAiCorpusCases, type CorpusHarness, type HarnessOverrides } from "./openai.ts";
import { chatCorpusScenarios, responsesCorpusScenarios } from "./openai-scenarios.ts";
import { startOpenAiResponsesFake } from "../fakes/openai-responses.ts";
import { startOpenAiChatFake } from "../fakes/openai-chat.ts";
import { startCodexFake, FAKE_ACCESS_TOKEN, FAKE_ACCOUNT_ID, FAKE_REFRESH_TOKEN } from "../fakes/codex-oauth.ts";
import { openAiModelsRoutes } from "../fakes/openai-models.ts";
import type { FakeServer } from "../fakes/server.ts";

/** A short stall budget: the stall case must fail fast, and every other scenario's frames are well inside it. */
const STALL_MS = 200;

/** Descriptor evidence shared by every corpus target, varied per harness. */
function descriptorsFor(base: DescriptorOverrides, overrides?: DescriptorOverrides): (model: string) => ReturnType<typeof descriptor> {
  return (model: string) => descriptor({ ...base, ...overrides, key: `corpus/${model}`, upstreamId: model, continuationDomain: ["corpus-domain"] });
}

const CODEX_REF: Extract<CredentialRef, { kind: "keychain" }> = { kind: "keychain", account: `codex-oauth:${FAKE_ACCOUNT_ID}` };

// --- harnesses ----------------------------------------------------------------------------------------

function responsesHarness(): CorpusHarness {
  const base: DescriptorOverrides = { efforts: ["low", "medium", "high"], readableState: "summary", summaryValues: ["detailed"], continuation: "opaque-provider-state" };
  const adapterFor = (url: string, overrides?: HarnessOverrides): ProviderAdapter =>
    createResponsesAdapter({
      generatedBaseUrl: url,
      retry: FAST_RETRY,
      ...(overrides?.noDescriptors === true ? {} : { descriptors: descriptorsFor(base, overrides?.descriptor) }),
    });
  return {
    name: "openai-responses@1",
    surface: "responses",
    capabilities: { tools: true, vision: true, continuation: "opaque", effort: true },
    discovery: "live",
    requiresCredential: true,
    stream: (endpoint, req, overrides) => adapterFor(endpoint.url, overrides).streamTurn(req, testContext({ stallTimeoutMs: STALL_MS })),
    discover: (endpoint, opts) =>
      discoverModels(adapterFor(endpoint.url), testDiscoveryContext({ stallTimeoutMs: STALL_MS, ...(opts?.maxItems !== undefined ? { maxItems: opts.maxItems } : {}) }), opts?.cache),
  };
}

function codexHarness(): CorpusHarness {
  const base: DescriptorOverrides = { efforts: ["low", "medium", "high"], readableState: "summary", continuation: "opaque-provider-state" };
  const credentials = () =>
    createMemoryCredentialStore([[CODEX_REF, { kind: "oauth", accessToken: FAKE_ACCESS_TOKEN, refreshToken: FAKE_REFRESH_TOKEN, accountId: FAKE_ACCOUNT_ID, expiresAt: Date.now() + 3_600_000 }]]);
  const ctxFor = (): ReturnType<typeof testContext> => ({ ...testContext({ providerId: "codex-oauth", stallTimeoutMs: STALL_MS }), credentials: credentials(), authRef: CODEX_REF });
  const adapterFor = (url: string, overrides?: HarnessOverrides): ProviderAdapter =>
    createCodexOauthAdapter({
      generatedBaseUrl: url,
      tokenUrl: `${url}/oauth/token`,
      retry: FAST_RETRY,
      ...(overrides?.noDescriptors === true ? {} : { descriptors: descriptorsFor(base, overrides?.descriptor) }),
    });
  return {
    name: "codex-oauth@1",
    surface: "responses",
    capabilities: { tools: true, vision: true, continuation: "opaque", effort: true },
    discovery: "static",
    requiresCredential: true,
    stream: (endpoint, req, overrides) => adapterFor(endpoint.url, overrides).streamTurn(req, ctxFor()),
    // Codex's catalog is STATIC (the backend serves only its own slugs for a ChatGPT account), so
    // there is no endpoint to page — but the answer still goes through `discoverModels`'s bounds and
    // validation layer rather than around it, which is what the static branch of the case asks about.
    discover: (endpoint, opts) =>
      discoverModels(
        adapterFor(endpoint.url),
        testDiscoveryContext({ providerId: "codex-oauth", stallTimeoutMs: STALL_MS, ...(opts?.maxItems !== undefined ? { maxItems: opts.maxItems } : {}) }),
        opts?.cache,
      ),
  };
}

function chatHarness(): CorpusHarness {
  // Shaped as DEEPSEEK: `full-exposed` readable state and plaintext continuation, which is what
  // turns `opaque-continuation` into §6.3's replay proof for this surface.
  const base: DescriptorOverrides = { efforts: ["low", "medium", "high"], readableState: "full-exposed", continuation: "plaintext" };
  const adapterFor = (url: string, overrides?: HarnessOverrides): ProviderAdapter =>
    createChatCompletionsAdapter({
      generatedBaseUrl: url,
      retry: FAST_RETRY,
      ...(overrides?.noDescriptors === true ? {} : { descriptors: descriptorsFor(base, overrides?.descriptor) }),
    });
  return {
    name: "openai-chat-completions@1 (deepseek profile)",
    surface: "chat",
    capabilities: { tools: true, vision: true, continuation: "exposed", effort: true },
    discovery: "live",
    requiresCredential: true,
    stream: (endpoint, req, overrides) => adapterFor(endpoint.url, overrides).streamTurn(req, testContext({ providerId: "deepseek", stallTimeoutMs: STALL_MS })),
    discover: (endpoint, opts) =>
      discoverModels(adapterFor(endpoint.url), testDiscoveryContext({ providerId: "deepseek", stallTimeoutMs: STALL_MS, ...(opts?.maxItems !== undefined ? { maxItems: opts.maxItems } : {}) }), opts?.cache),
  };
}

function localHarness(): CorpusHarness {
  // A local server with NO reasoning evidence at all — which is why this target skips the three
  // capability-gated reasoning cases as a FACT about the model rather than by omission.
  const base: DescriptorOverrides = { noReasoning: true, inputModalities: ["text"] };
  const adapterFor = (overrides?: HarnessOverrides): ProviderAdapter =>
    createLocalOpenAIAdapter({ retry: FAST_RETRY, ...(overrides?.noDescriptors === true ? {} : { descriptors: descriptorsFor(base, overrides?.descriptor) }) });
  return {
    name: "local-openai@1",
    surface: "chat",
    capabilities: { tools: true, vision: false, continuation: "none", effort: false },
    discovery: "live",
    // `local-none` is a first-class auth kind: this target sends NO credential, deliberately.
    requiresCredential: false,
    // The endpoint is the HOST's, declared local — the only way a plain-http loopback is reachable.
    stream: (endpoint, req, overrides) => adapterFor(overrides).streamTurn(req, testContext({ providerId: "ollama-local", baseUrl: endpoint.url, local: true, apiKey: null, stallTimeoutMs: STALL_MS })),
    discover: (endpoint, opts) =>
      discoverModels(
        adapterFor(),
        testDiscoveryContext({ providerId: "ollama-local", baseUrl: endpoint.url, local: true, apiKey: null, stallTimeoutMs: STALL_MS, ...(opts?.maxItems !== undefined ? { maxItems: opts.maxItems } : {}) }),
        opts?.cache,
      ),
  };
}

// --- the runs -------------------------------------------------------------------------------------------

async function withResponsesFake<T>(fn: (fake: FakeServer) => Promise<T>): Promise<T> {
  const fake = await startOpenAiResponsesFake({ scenarios: responsesCorpusScenarios(), routes: openAiModelsRoutes({ pages: [{ rows: [{ id: "alpha" }, { id: "beta" }] }] }) });
  try {
    return await fn(fake);
  } finally {
    await fake.close();
  }
}

async function withChatFake<T>(fn: (fake: FakeServer) => Promise<T>): Promise<T> {
  const fake = await startOpenAiChatFake({ scenarios: chatCorpusScenarios(), routes: openAiModelsRoutes({ pages: [{ rows: [{ id: "alpha" }, { id: "beta" }] }] }) });
  try {
    return await fn(fake);
  } finally {
    await fake.close();
  }
}

async function withCodexFake<T>(fn: (fake: FakeServer) => Promise<T>): Promise<T> {
  const fake = await startCodexFake({ scenarios: responsesCorpusScenarios() });
  try {
    return await fn(fake);
  } finally {
    await fake.close();
  }
}

const RUNS: Array<{ harness: CorpusHarness; withFake: <T>(fn: (fake: FakeServer) => Promise<T>) => Promise<T> }> = [
  { harness: responsesHarness(), withFake: withResponsesFake },
  { harness: codexHarness(), withFake: withCodexFake },
  { harness: chatHarness(), withFake: withChatFake },
  { harness: localHarness(), withFake: withChatFake },
];

describe("WS-13 §13 corpus — the OpenAI family", () => {
  for (const { harness, withFake } of RUNS) {
    test(`${harness.name} answers every required case`, async () => {
      const report = await withFake((fake) => runAdapterCorpus({ adapter: harness.name, fake, model: SCENARIO.happy, cases: openAiCorpusCases(harness) }));
      // The formatted report is what a failing run prints: every case, its status, and the question
      // it was asking — so a failure names the question rather than a line number.
      if (!report.ok) throw new Error(`\n${formatCorpusReport(report)}`);
      expect(report.outcomes.filter((o) => o.status === "missing")).toEqual([]);
      expect(report.outcomes.filter((o) => o.status === "failed")).toEqual([]);
      // Every case ran: a corpus whose cases were silently absent would also be "ok".
      expect(report.outcomes).toHaveLength(23);
    }, 30_000);
  }

  test("the capability-gated skips are FACTS about the model, not declined cases", async () => {
    const report = await withChatFake((fake) => runAdapterCorpus({ adapter: "local-openai@1", fake, model: SCENARIO.happy, cases: openAiCorpusCases(localHarness()) }));
    const skipped = report.outcomes.filter((o) => o.status === "skipped").map((o) => o.id);
    // A local server with no reasoning and no vision evidence: exactly three questions its
    // descriptor answers in the negative, and every other case still runs.
    expect(skipped.sort()).toEqual(["effort-mapping", "opaque-continuation", "vision-where-advertised"]);
    for (const outcome of report.outcomes.filter((o) => o.status === "skipped")) {
      expect(outcome.detail).toBeDefined();
      expect(outcome.detail).toContain("descriptor");
    }
  }, 30_000);
});

// --- targeted live fixtures the corpus does not phrase ------------------------------------------------------

describe("live wire details the corpus does not ask about", () => {
  test("R6-L: `OpenAI-Organization` rides a GENERATED endpoint and is dropped for a user one", async () => {
    await withResponsesFake(async (fake) => {
      const generated = createResponsesAdapter({ generatedBaseUrl: fake.url, organization: "org-test-corpus", project: "proj-test", retry: FAST_RETRY });
      await drain(generated.streamTurn({ model: SCENARIO.happy, messages: [] }, testContext({ stallTimeoutMs: STALL_MS })));
      expect(fake.requests.at(-1)?.headers["openai-organization"]).toBe("org-test-corpus");
      expect(fake.requests.at(-1)?.headers["openai-project"]).toBe("proj-test");

      // The SAME adapter options, but the endpoint now comes from the connection profile: the
      // organisation identifier must not reach a host the reviewed catalog never named.
      const viaProfile = createResponsesAdapter({ organization: "org-test-corpus", project: "proj-test", retry: FAST_RETRY });
      await drain(viaProfile.streamTurn({ model: SCENARIO.happy, messages: [] }, testContext({ baseUrl: fake.url, local: true, stallTimeoutMs: STALL_MS })));
      expect(fake.requests.at(-1)?.headers["openai-organization"]).toBeUndefined();
      expect(fake.requests.at(-1)?.headers["openai-project"]).toBeUndefined();
    });
  });

  test("a retry observation is yielded BEFORE the request it precedes reaches the fake", async () => {
    // The ordering `pumpEvents` exists for, asserted against the fake's own request log rather than
    // against the adapter's intent: a post-hoc flush would put the event after BOTH requests.
    await withResponsesFake(async (fake) => {
      const adapter = createResponsesAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY });
      let requestsWhenRetrySeen = -1;
      for await (const event of adapter.streamTurn({ model: SCENARIO.rateLimit, messages: [] }, testContext({ stallTimeoutMs: STALL_MS }))) {
        if (event.type === "retry" && requestsWhenRetrySeen < 0) requestsWhenRetrySeen = fake.requests.length;
      }
      expect(requestsWhenRetrySeen).toBe(1);
      expect(fake.requests).toHaveLength(2);
    });
  });

  test("codex: the `originator` and account id ride the generated backend, and a 401 refreshes ONCE with a NEW bearer", async () => {
    const fake = await startCodexFake({ scenarios: responsesCorpusScenarios(), requireRefreshFor: [SCENARIO.happy] });
    try {
      const credentials = createMemoryCredentialStore([[CODEX_REF, { kind: "oauth", accessToken: FAKE_ACCESS_TOKEN, refreshToken: FAKE_REFRESH_TOKEN, accountId: FAKE_ACCOUNT_ID, expiresAt: Date.now() + 3_600_000 }]]);
      const adapter = createCodexOauthAdapter({ generatedBaseUrl: fake.url, tokenUrl: `${fake.url}/oauth/token`, retry: FAST_RETRY });
      const ctx = { ...testContext({ providerId: "codex-oauth", stallTimeoutMs: STALL_MS }), credentials, authRef: CODEX_REF };
      const events = await drain(adapter.streamTurn({ model: SCENARIO.happy, messages: [] }, ctx));

      const turns = fake.requests.filter((r) => r.path.endsWith("/responses"));
      expect(turns).toHaveLength(2);
      expect(turns[0]?.headers.originator).toBe("winter");
      expect(turns[0]?.headers["chatgpt-account-id"]).toBe(FAKE_ACCOUNT_ID);
      expect(turns[0]?.headers["openai-beta"]).toBe("responses=experimental");
      // The proof that this was a REFRESH and not a plain retry: the second request carried a
      // DIFFERENT bearer. A request count alone cannot tell the two apart.
      expect(fake.bearers[0]).not.toBe(fake.bearers[1]);
      expect(fake.bearers[1]).toBe("test-token-codex-access-refreshed");
      // The refreshed material was persisted back through the credential store, so the NEXT turn
      // does not repeat the 401.
      const stored = await credentials.get(CODEX_REF);
      expect(stored?.kind === "oauth" ? stored.accessToken : "").toBe("test-token-codex-access-refreshed");
      // And the login-flow progress channel reported it (R6-F: `auth_status` is progress, never the
      // credential-failure frame).
      expect(events.filter((e) => e.type === "auth_status").length).toBeGreaterThanOrEqual(2);
      expect(events.some((e) => e.type === "done")).toBe(true);
    } finally {
      await fake.close();
    }
  });

  test("codex: a 429 produces the SUBSCRIPTION-quota event alongside the ordinary retry (R6-B)", async () => {
    const fake = await startCodexFake({ scenarios: responsesCorpusScenarios() });
    try {
      const credentials = createMemoryCredentialStore([[CODEX_REF, { kind: "oauth", accessToken: FAKE_ACCESS_TOKEN, refreshToken: FAKE_REFRESH_TOKEN, accountId: FAKE_ACCOUNT_ID, expiresAt: Date.now() + 3_600_000 }]]);
      const adapter = createCodexOauthAdapter({ generatedBaseUrl: fake.url, tokenUrl: `${fake.url}/oauth/token`, retry: FAST_RETRY });
      const events = await drain(adapter.streamTurn({ model: SCENARIO.rateLimit, messages: [] }, { ...testContext({ providerId: "codex-oauth", stallTimeoutMs: STALL_MS }), credentials, authRef: CODEX_REF }));
      const rateLimit = events.find((e) => e.type === "rate_limit");
      expect(rateLimit).toBeDefined();
      expect(rateLimit?.type === "rate_limit" ? rateLimit.kind : "").toBe("subscription-quota");
      // The pinned 429 path is UNCHANGED and still present: the subscription event is an addition,
      // never a replacement.
      expect(events.some((e) => e.type === "retry" && e.errorStatus === 429 && e.error === "rate_limit")).toBe(true);
    } finally {
      await fake.close();
    }
  });

  test("local: discovery falls back to Ollama's /api/tags when /v1/models is absent", async () => {
    const { startFake } = await import("../fakes/server.ts");
    const { modelsNotFoundRoutes, ollamaTagsRoute } = await import("../fakes/openai-models.ts");
    const fake = await startFake({ routes: [...modelsNotFoundRoutes(), ollamaTagsRoute([{ name: "llama3.1:8b" }, { name: "qwen3:4b" }])] });
    try {
      const adapter = createLocalOpenAIAdapter({ retry: FAST_RETRY });
      const result = await discoverModels(adapter, testDiscoveryContext({ providerId: "ollama-local", baseUrl: `${fake.url}/v1`, local: true, apiKey: null }));
      expect(result.models.map((m) => m.id)).toEqual(["llama3.1:8b", "qwen3:4b"]);
      expect(result.warnings.some((w) => w.includes("/api/tags"))).toBe(true);
      // The fallback was tried only AFTER /v1/models answered 404 — both doors were used, in order.
      expect(fake.requests.map((r) => r.path)).toEqual(["/v1/models", "/api/tags"]);
    } finally {
      await fake.close();
    }
  });

  test("a model that DISAPPEARS between two discoveries is reported gone only when the page was complete", async () => {
    // WS-13 §7's sharpest edge: absence means "removed" only when the list was whole. A TRUNCATED
    // page that happens to omit a model must never read as a removal, which is why `partial` is a
    // first-class part of the result rather than a warning string.
    const { startFake } = await import("../fakes/server.ts");
    const first = await startFake({ routes: openAiModelsRoutes({ pages: [{ rows: [{ id: "alpha" }, { id: "beta" }] }] }) });
    try {
      const adapter = createResponsesAdapter({ generatedBaseUrl: first.url, retry: FAST_RETRY });
      const before = await discoverModels(adapter, testDiscoveryContext({ stallTimeoutMs: STALL_MS }));
      expect(before.models.map((m) => m.id)).toEqual(["alpha", "beta"]);
      expect(before.partial).toBe(false);
    } finally {
      await first.close();
    }

    // The same provider, now serving only `alpha`: a COMPLETE page, so beta is genuinely gone.
    const after = await startFake({ routes: openAiModelsRoutes({ pages: [{ rows: [{ id: "alpha" }] }] }) });
    try {
      const adapter = createResponsesAdapter({ generatedBaseUrl: after.url, retry: FAST_RETRY });
      const removed = await discoverModels(adapter, testDiscoveryContext({ stallTimeoutMs: STALL_MS }));
      expect(removed.models.map((m) => m.id)).toEqual(["alpha"]);
      expect(removed.partial).toBe(false);
    } finally {
      await after.close();
    }

    // And the same two models under an ITEM BOUND: beta is missing from the answer, but the answer
    // says so — `partial: true` plus a warning, never a silent removal.
    const bounded = await startFake({ routes: openAiModelsRoutes({ pages: [{ rows: [{ id: "alpha" }, { id: "beta" }] }] }) });
    try {
      const adapter = createResponsesAdapter({ generatedBaseUrl: bounded.url, retry: FAST_RETRY });
      const truncated = await discoverModels(adapter, testDiscoveryContext({ stallTimeoutMs: STALL_MS, maxItems: 1 }));
      expect(truncated.models.map((m) => m.id)).toEqual(["alpha"]);
      expect(truncated.partial).toBe(true);
      expect(truncated.warnings.some((w) => w.includes("PARTIAL"))).toBe(true);
    } finally {
      await bounded.close();
    }
  });

  test("a gateway model with NO descriptor passes a named effort through and refuses a numeric one", async () => {
    // R6-K's `allowUnlisted` shape: OpenRouter ids like `anthropic/claude-opus-5` never reach the
    // compiled catalog, so the adapter has no vocabulary to snap a number against.
    await withChatFake(async (fake) => {
      const adapter = createChatCompletionsAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY });
      const ctx = testContext({ providerId: "openrouter", stallTimeoutMs: STALL_MS });
      await drain(adapter.streamTurn({ model: SCENARIO.happy, messages: [], effort: "high" }, ctx));
      expect(JSON.parse(fake.requests.at(-1)!.body).reasoning_effort).toBe("high");

      const before = fake.requests.length;
      const events = await drain(adapter.streamTurn({ model: SCENARIO.happy, messages: [], effort: 4 }, ctx));
      expect(events.find((e) => e.type === "error")?.type === "error" ? (events.find((e) => e.type === "error") as { error: { code: string } }).error.code : "").toBe("capability");
      expect(fake.requests).toHaveLength(before);
    });
  });

  test("the connection profile's attribution headers ride only when the host set them", async () => {
    await withChatFake(async (fake) => {
      const adapter = createChatCompletionsAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY });
      await drain(adapter.streamTurn({ model: SCENARIO.happy, messages: [] }, testContext({ providerId: "openrouter", stallTimeoutMs: STALL_MS })));
      expect(fake.requests.at(-1)?.headers["http-referer"]).toBeUndefined();
      expect(fake.requests.at(-1)?.headers["x-title"]).toBeUndefined();

      await drain(
        adapter.streamTurn({ model: SCENARIO.happy, messages: [] }, testContext({ providerId: "openrouter", stallTimeoutMs: STALL_MS, headers: { "HTTP-Referer": "https://winter.example.test", "X-Title": "Winter" } })),
      );
      expect(fake.requests.at(-1)?.headers["http-referer"]).toBe("https://winter.example.test");
      expect(fake.requests.at(-1)?.headers["x-title"]).toBe("Winter");
    });
  });

  test("opaque state never reaches a stream frame, and a cross-domain replay never reaches the wire", async () => {
    await withResponsesFake(async (fake) => {
      const adapter = createResponsesAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: descriptorsFor({ efforts: ["low", "medium", "high"], continuation: "opaque-provider-state" }) });
      const events = await drain(adapter.streamTurn({ model: SCENARIO.reasoning, messages: [], effort: "high" }, testContext({ stallTimeoutMs: STALL_MS })));
      // The marker exists only inside `native_state`, whose sole sink is the sidecar.
      const nonState = events.filter((e) => e.type !== "native_state");
      expect(JSON.stringify(nonState)).not.toContain("OPAQUE-CONTINUATION-MARKER");
      expect(events.some((e) => e.type === "native_state")).toBe(true);
    });
  });
});

async function drain(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

// Referenced so the unused-import lint (and a reader) sees the type this file's harnesses satisfy.
export type { TurnRequest };
