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
import { QuotaManager } from "../../../provider-runtime/src/adapters/openai/quota.ts";
import { createLocalOpenAIAdapter } from "../../../provider-runtime/src/adapters/openai/local.ts";
import { FAST_RETRY, descriptor, testContext, testDiscoveryContext, type DescriptorOverrides } from "../../../provider-runtime/src/adapters/openai/testing.ts";
import { discoverModels } from "@yanlinglabs/winter-provider-runtime";
import type { CredentialRef, ProviderAdapter, ProviderEvent, TurnRequest } from "@yanlinglabs/winter-provider-runtime";
import { createMemoryCredentialStore } from "../../../provider-runtime/src/credentials/memory.ts";
import { formatCorpusReport, runAdapterCorpus } from "./runner.ts";
import { FOREIGN_MARKER, OPAQUE_MARKER, SCENARIO, openAiCorpusCases, type CorpusHarness, type HarnessOverrides } from "./openai.ts";
import { chatCorpusScenarios, responsesCorpusScenarios } from "./openai-scenarios.ts";
import { startOpenAiResponsesFake } from "../fakes/openai-responses.ts";
import { startOpenAiChatFake } from "../fakes/openai-chat.ts";
import { startCodexFake, FAKE_ACCESS_TOKEN, FAKE_ACCOUNT_ID, FAKE_REFRESH_TOKEN } from "../fakes/codex-oauth.ts";
import { errorResponse } from "../fakes/server.ts";
import { responsesStream } from "../fakes/openai-responses.ts";
import { openAiModelsRoutes } from "../fakes/openai-models.ts";
import { noRequestContains } from "../fakes/server.ts";
import type { FakeServer } from "../fakes/server.ts";
import { adapterAsProvider } from "../../../runtime/src/provider/bridge.ts";
import { winterUserAgent } from "../../../provider-runtime/src/identity.ts";

/** A short stall budget: the stall case must fail fast, and every other scenario's frames are well inside it. */
const STALL_MS = 200;

/** Descriptor evidence shared by every corpus target, varied per harness. */
function descriptorsFor(base: DescriptorOverrides, overrides?: DescriptorOverrides): (model: string) => ReturnType<typeof descriptor> {
  return (model: string) => descriptor({ ...base, ...overrides, key: `corpus/${model}`, upstreamId: model, continuationDomain: ["corpus-domain"] });
}

const CODEX_REF: Extract<CredentialRef, { kind: "keychain" }> = { kind: "keychain", account: `codex-oauth:${FAKE_ACCOUNT_ID}` };

/**
 * A quota manager whose WINDOW WAIT is mocked, exactly as `FAST_RETRY` mocks the retry backoff.
 *
 * Not redundant with it: in production the retry backoff and the quota window are the same wait
 * (the backoff consumes the window), but a fixture that mocks only the retry sleep still spends the
 * real `Retry-After` here — twice per 429 scenario. The STATE is real; only the clock is not.
 */
function fastQuota(): QuotaManager {
  return new QuotaManager({ sleep: () => new Promise<void>((r) => setTimeout(r, 1)) });
}

/** A codex context holding a valid, unexpired oauth credential. Fresh per call so a refresh in one test cannot leak into another. */
function codexContext(): ReturnType<typeof testContext> {
  const credentials = createMemoryCredentialStore([[CODEX_REF, { kind: "oauth", accessToken: FAKE_ACCESS_TOKEN, refreshToken: FAKE_REFRESH_TOKEN, accountId: FAKE_ACCOUNT_ID, expiresAt: Date.now() + 3_600_000 }]]);
  return { ...testContext({ providerId: "codex-oauth", stallTimeoutMs: STALL_MS }), credentials, authRef: CODEX_REF };
}

/** The codex adapter pointed at a fake, with an explicit (possibly real-clock) quota manager. */
function codexAdapterFor(url: string, quota: QuotaManager): ProviderAdapter {
  return createCodexOauthAdapter({ generatedBaseUrl: url, tokenUrl: `${url}/oauth/token`, retry: FAST_RETRY, quota, descriptors: () => undefined });
}

// --- harnesses ----------------------------------------------------------------------------------------

function responsesHarness(): CorpusHarness {
  const base: DescriptorOverrides = { efforts: ["low", "medium", "high"], readableState: "summary", summaryValues: ["detailed"], continuation: "opaque-provider-state" };
  const adapterFor = (url: string, overrides?: HarnessOverrides): ProviderAdapter =>
    createResponsesAdapter({
      generatedBaseUrl: url,
      retry: FAST_RETRY,
      descriptors: overrides?.unlisted === true ? () => undefined : descriptorsFor(base, overrides?.descriptor),
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
      quota: fastQuota(),
      descriptors: overrides?.unlisted === true ? () => undefined : descriptorsFor(base, overrides?.descriptor),
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
      descriptors: overrides?.unlisted === true ? () => undefined : descriptorsFor(base, overrides?.descriptor),
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
    createLocalOpenAIAdapter({ retry: FAST_RETRY, descriptors: overrides?.unlisted === true ? () => undefined : descriptorsFor(base, overrides?.descriptor) });
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
      const generated = createResponsesAdapter({ generatedBaseUrl: fake.url, organization: "org-test-corpus", project: "proj-test", retry: FAST_RETRY, descriptors: () => undefined });
      await drain(generated.streamTurn({ model: SCENARIO.happy, messages: [] }, testContext({ stallTimeoutMs: STALL_MS })));
      expect(fake.requests.at(-1)?.headers["openai-organization"]).toBe("org-test-corpus");
      expect(fake.requests.at(-1)?.headers["openai-project"]).toBe("proj-test");

      // The SAME adapter options, but the endpoint now comes from the connection profile: the
      // organisation identifier must not reach a host the reviewed catalog never named.
      const viaProfile = createResponsesAdapter({ organization: "org-test-corpus", project: "proj-test", retry: FAST_RETRY, descriptors: () => undefined });
      await drain(viaProfile.streamTurn({ model: SCENARIO.happy, messages: [] }, testContext({ baseUrl: fake.url, local: true, stallTimeoutMs: STALL_MS })));
      expect(fake.requests.at(-1)?.headers["openai-organization"]).toBeUndefined();
      expect(fake.requests.at(-1)?.headers["openai-project"]).toBeUndefined();
    });
  });

  test("F-2 / M-9: `enabled` with no effort rides at the row's defaultEffort, or is REFUSED with NOTHING on the wire", async () => {
    // The family's own answer to "`enabled` without a budget", asserted on the live wire on both
    // surfaces. There is no budget field here, so `enabled` means reasoning ON at the row's own
    // `defaultEffort` — and when the row has none, the caller is TOLD.
    //
    // The refused half is the one that shipped wrong: the request went out carrying
    // `include: ["reasoning.encrypted_content"]` and no `reasoning` object at all, so the model did
    // not think, the caller was told nothing, and the turn succeeded. That is the silent downgrade
    // WS-13 §8.2 prohibits, and the pin is REQUEST COUNT 0 — a message assertion alone cannot see it.
    await withResponsesFake(async (fake) => {
      const withDefault = createResponsesAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: descriptorsFor({ efforts: ["low", "medium", "high"], defaultEffort: "medium" }) });
      await drain(withDefault.streamTurn({ model: SCENARIO.happy, messages: [], thinking: { type: "enabled" } }, testContext({ stallTimeoutMs: STALL_MS })));
      const body = JSON.parse(fake.requests.at(-1)!.body) as Record<string, unknown>;
      expect(body["reasoning"]).toEqual({ effort: "medium" });
      expect(body["include"]).toEqual(["reasoning.encrypted_content"]);

      const before = fake.requests.length;
      const noDefault = createResponsesAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: descriptorsFor({ efforts: ["low", "medium", "high"] }) });
      for (const thinking of [{ type: "enabled" as const }, { type: "adaptive" as const }]) {
        const events = await drain(noDefault.streamTurn({ model: SCENARIO.happy, messages: [], thinking }, testContext({ stallTimeoutMs: STALL_MS })));
        const error = events.find((e) => e.type === "error");
        expect(error?.type === "error" ? error.error.code : "").toBe("capability");
        expect(error?.type === "error" ? error.error.message : "").toContain("declares no defaultEffort");
      }
      expect(fake.requests).toHaveLength(before);
    });

    await withChatFake(async (fake) => {
      const withDefault = createChatCompletionsAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: descriptorsFor({ efforts: ["low", "medium", "high"], defaultEffort: "high" }) });
      await drain(withDefault.streamTurn({ model: SCENARIO.happy, messages: [], thinking: { type: "enabled" } }, testContext({ stallTimeoutMs: STALL_MS })));
      expect((JSON.parse(fake.requests.at(-1)!.body) as Record<string, unknown>)["reasoning_effort"]).toBe("high");

      const before = fake.requests.length;
      const noDefault = createChatCompletionsAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: descriptorsFor({ efforts: ["low", "medium", "high"] }) });
      const events = await drain(noDefault.streamTurn({ model: SCENARIO.happy, messages: [], thinking: { type: "enabled" } }, testContext({ stallTimeoutMs: STALL_MS })));
      expect(events.find((e) => e.type === "error")?.type).toBe("error");
      expect(fake.requests).toHaveLength(before);
    });
  });

  test("F-3: a CREDENTIAL-shaped host header never rides — `cookie` + `x-trace` puts only `x-trace` on the wire", async () => {
    // This family always stripped `CREDENTIAL_HEADER_NAMES` from the profile before calling
    // `hostHeaders`; the strip now lives INSIDE `hostHeaders`, so every family gets it and this file
    // no longer keeps a second copy of the rule. The fixture is what proves the move was lossless.
    await withResponsesFake(async (fake) => {
      const adapter = createResponsesAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: () => undefined });
      const headers = { cookie: "session=SMUGGLED-COOKIE", "proxy-authorization": "Basic SMUGGLED-PROXY", "x-goog-api-key": "SMUGGLED-GOOG", "x-trace": "keep" };
      // On the GENERATED endpoint, where `hostHeaders` passes identity headers through by design.
      await drain(adapter.streamTurn({ model: SCENARIO.happy, messages: [] }, testContext({ headers, stallTimeoutMs: STALL_MS })));
      let recorded = fake.requests.at(-1)!;
      expect(recorded.headers["x-trace"]).toBe("keep");
      expect(recorded.headers["cookie"]).toBeUndefined();
      expect(recorded.headers["proxy-authorization"]).toBeUndefined();
      expect(recorded.headers["x-goog-api-key"]).toBeUndefined();
      // And on a USER endpoint, where the identity rule also applies.
      const viaProfile = createResponsesAdapter({ retry: FAST_RETRY, descriptors: () => undefined });
      await drain(viaProfile.streamTurn({ model: SCENARIO.happy, messages: [] }, testContext({ baseUrl: fake.url, local: true, headers, stallTimeoutMs: STALL_MS })));
      recorded = fake.requests.at(-1)!;
      expect(recorded.headers["x-trace"]).toBe("keep");
      expect(recorded.headers["cookie"]).toBeUndefined();
      for (const marker of ["SMUGGLED-COOKIE", "SMUGGLED-PROXY", "SMUGGLED-GOOG"]) expect([marker, noRequestContains(fake, marker)]).toEqual([marker, true]);
    });
  });

  test("WS-13b: every request carries Winter's OWN user-agent, on both surfaces", async () => {
    // Winter's identity, on the wire, read off the fake's recorded request -- not off the adapter's
    // intent. The negative half is the load-bearing one: Bun's fetch sends `Bun/<version>` when
    // nothing sets the header, so an adapter that simply forgot would still have SOME user-agent
    // and a presence-only assertion would pass.
    await withResponsesFake(async (fake) => {
      const adapter = createResponsesAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: () => undefined });
      await drain(adapter.streamTurn({ model: SCENARIO.happy, messages: [] }, testContext({ stallTimeoutMs: STALL_MS })));
      expect(fake.requests.length).toBeGreaterThan(0);
      for (const recorded of fake.requests) expect(recorded.headers["user-agent"]).toBe(winterUserAgent());
    });
    await withChatFake(async (fake) => {
      const adapter = createChatCompletionsAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: () => undefined });
      await drain(adapter.streamTurn({ model: SCENARIO.happy, messages: [] }, testContext({ stallTimeoutMs: STALL_MS })));
      expect(fake.requests.length).toBeGreaterThan(0);
      for (const recorded of fake.requests) expect(recorded.headers["user-agent"]).toBe(winterUserAgent());
    });
  });

  test("M-1: a profile `user-agent` does NOT replace Winter's on a GENERATED endpoint, and DOES on a user one", async () => {
    // `identity.ts` says the User-Agent is "deliberately NOT configurable" and names exactly one
    // sanctioned override -- "the operator speaking about their own proxy", i.e. a USER endpoint.
    // Nothing enforced the second half, so the same `ConnectionProfile.headers['user-agent']`
    // replaced Winter's identity at the VENDOR'S own reviewed endpoint, which is the one place the
    // admission rule is about. Both directions, because a rule that dropped it everywhere would pass
    // the first assertion while removing a capability the header exists for.
    const PROFILE_UA = "some-editor/9.9.9";
    await withResponsesFake(async (fake) => {
      const adapter = createResponsesAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: () => undefined });
      await drain(adapter.streamTurn({ model: SCENARIO.happy, messages: [] }, testContext({ stallTimeoutMs: STALL_MS, headers: { "user-agent": PROFILE_UA } })));
      expect(fake.requests[0]?.headers["user-agent"]).toBe(winterUserAgent());
    });
    await withChatFake(async (fake) => {
      const adapter = createChatCompletionsAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: () => undefined });
      await drain(adapter.streamTurn({ model: SCENARIO.happy, messages: [] }, testContext({ stallTimeoutMs: STALL_MS, headers: { "user-agent": PROFILE_UA } })));
      expect(fake.requests[0]?.headers["user-agent"]).toBe(winterUserAgent());
      // The USER endpoint: the SAME fake at the SAME url, only its reviewed status differs -- which
      // is exactly what the rule gates on.
      const user = createChatCompletionsAdapter({ retry: FAST_RETRY, descriptors: () => undefined });
      await drain(user.streamTurn({ model: SCENARIO.happy, messages: [] }, testContext({ stallTimeoutMs: STALL_MS, baseUrl: fake.url, local: true, headers: { "user-agent": PROFILE_UA } })));
      expect(fake.requests[1]?.headers["user-agent"]).toBe(PROFILE_UA);
    });
  });

  test("a retry observation is yielded BEFORE the request it precedes reaches the fake", async () => {
    // The ordering `pumpEvents` exists for, asserted against the fake's own request log rather than
    // against the adapter's intent: a post-hoc flush would put the event after BOTH requests.
    await withResponsesFake(async (fake) => {
      const adapter = createResponsesAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: () => undefined });
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
      const adapter = codexAdapterFor(fake.url, fastQuota());
      const ctx = { ...testContext({ providerId: "codex-oauth", stallTimeoutMs: STALL_MS }), credentials, authRef: CODEX_REF };
      const events = await drain(adapter.streamTurn({ model: SCENARIO.happy, messages: [] }, ctx));

      const turns = fake.requests.filter((r) => r.path.endsWith("/responses"));
      expect(turns).toHaveLength(2);
      expect(turns[0]?.headers.originator).toBe("winter");
      expect(turns[0]?.headers["chatgpt-account-id"]).toBe(FAKE_ACCOUNT_ID);
      expect(turns[0]?.headers["openai-beta"]).toBe("responses=experimental");
      // WS-13b: `originator: winter` is the codex backend's OWN identity field; the user-agent is
      // the transport-level one, and BOTH have to name Winter. Pinned on the codex fake specifically
      // because this is the adapter with a second identity channel to get wrong.
      expect(turns[0]?.headers["user-agent"]).toBe(winterUserAgent());
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
      const adapter = codexAdapterFor(fake.url, fastQuota());
      const events = await drain(adapter.streamTurn({ model: SCENARIO.rateLimit, messages: [] }, { ...testContext({ providerId: "codex-oauth", stallTimeoutMs: STALL_MS }), credentials, authRef: CODEX_REF }));
      const limits = events.filter((e): e is Extract<ProviderEvent, { type: "rate_limit" }> => e.type === "rate_limit");
      expect(limits.length).toBeGreaterThanOrEqual(1);
      expect(limits[0]!.kind).toBe("subscription-quota");
      // THE STATUS, not merely the kind. Asserting `kind` alone passed while the event said
      // `status: "allowed"` ON A RATE LIMIT — the adapter recorded a zero-length window, so the
      // manager read `ok` on the very next line and the recovery event never fired either.
      expect(limits[0]!.info.status).toBe("rejected");
      expect(typeof limits[0]!.info.resetsAt).toBe("number");
      // And the account is reported SERVING again once the retried turn completes.
      expect(limits.at(-1)!.info).toEqual({ status: "allowed" });
      expect(events.indexOf(limits.at(-1)!)).toBeGreaterThan(events.findIndex((e) => e.type === "done") - 1);
      // The pinned 429 path is UNCHANGED and still present: the subscription event is an addition,
      // never a replacement.
      expect(events.some((e) => e.type === "retry" && e.errorStatus === 429 && e.error === "rate_limit")).toBe(true);
    } finally {
      await fake.close();
    }
  });

  test("codex: a HEADERLESS 429 is `rejected` with NO resetsAt — the window is unknown, not invented (I1)", async () => {
    const fake = await startCodexFake({ scenarios: responsesCorpusScenarios() });
    try {
      const events = await drain(codexAdapterFor(fake.url, fastQuota()).streamTurn({ model: SCENARIO.rateLimitNoHeader, messages: [] }, codexContext()));
      const limits = events.filter((e): e is Extract<ProviderEvent, { type: "rate_limit" }> => e.type === "rate_limit");
      expect(limits[0]!.info.status).toBe("rejected");
      // The previous code put `retry.retryDelayMs` here, which for a headerless 429 is Winter's OWN
      // full-jitter backoff — a locally invented number riding the pinned `resetsAt` as a claim
      // about when the subscription resumes. And `random()` rounding to 0 reproduced `allowed`.
      expect("resetsAt" in limits[0]!.info).toBe(false);
      expect(events.some((e) => e.type === "done")).toBe(true);
    } finally {
      await fake.close();
    }
  });

  test("codex: a 429 WITH `Retry-After` takes its resetsAt from the header the backend sent (I1)", async () => {
    const fake = await startCodexFake({ scenarios: responsesCorpusScenarios() });
    try {
      const before = Math.round(Date.now() / 1000);
      const events = await drain(codexAdapterFor(fake.url, fastQuota()).streamTurn({ model: SCENARIO.rateLimitShortWindow, messages: [] }, codexContext()));
      const limits = events.filter((e): e is Extract<ProviderEvent, { type: "rate_limit" }> => e.type === "rate_limit");
      expect(limits[0]!.info.status).toBe("rejected");
      // `Retry-After: 1` -> a window one second out, in epoch SECONDS.
      const resetsAt = limits[0]!.info.resetsAt as number;
      expect(resetsAt).toBeGreaterThanOrEqual(before);
      expect(resetsAt).toBeLessThanOrEqual(before + 3);
    } finally {
      await fake.close();
    }
  });

  test("codex: a WINDOWED 429 then a HEADERLESS one both read `rejected` — the second never inherits the spent clock", async () => {
    // Round 2's Important, on the wire. No shared scenario mixes the two forms, so this one is
    // scripted here: `Retry-After: 1` (a window the retry then waits out), then a 429 with no
    // header at all, then success. Before the fix the SECOND event was `{ status: "allowed" }`.
    const fake = await startCodexFake({
      scenarios: {
        [SCENARIO.happy]: (_recorded, attempt) =>
          attempt === 1
            ? errorResponse(429, { error: { message: "slow down", code: "rate_limit_exceeded" } }, { "retry-after": "1" })
            : attempt === 2
              ? errorResponse(429, { error: { message: "slow down", code: "rate_limit_exceeded" } })
              : responsesStream({ text: ["recovered"], usage: { input: 1, output: 1 } }),
      },
    });
    try {
      // A REAL quota clock, deliberately: the finding's precondition is that the first window has
      // ELAPSED by the time the second refusal lands, and in production `beforeAttempt`'s
      // `waitIfLimited` guarantees exactly that. With the quota sleep mocked to 1 ms the window is
      // still live, the second refusal correctly KEEPS it, and the bug is unreachable — a fixture
      // that mocked it would have passed against the broken code.
      const events = await drain(codexAdapterFor(fake.url, new QuotaManager()).streamTurn({ model: SCENARIO.happy, messages: [] }, codexContext()));
      const limits = events.filter((e): e is Extract<ProviderEvent, { type: "rate_limit" }> => e.type === "rate_limit");
      expect(limits.length).toBeGreaterThanOrEqual(2);
      expect(limits[0]!.info.status).toBe("rejected");
      expect(typeof limits[0]!.info.resetsAt).toBe("number");
      expect(limits[1]!.info.status).toBe("rejected");
      expect("resetsAt" in limits[1]!.info).toBe(false);
      // The turn still completes, and the account is reported serving again at the end.
      expect(events.some((e) => e.type === "done")).toBe(true);
      expect(limits.at(-1)!.info).toEqual({ status: "allowed" });
    } finally {
      await fake.close();
    }
  }, 20_000);

  test("a tool-role DECORATION rides INSIDE the tool result, and the turn stays valid (round 3)", async () => {
    // Round 2 had it rendered as a leading `user` message, which breaks tool-message adjacency on
    // OpenAI and Azure alike — worse than the drop it replaced, because the whole turn fails rather
    // than the note being lost. It now PREFIXES the result's own text, so nothing is inserted
    // between a call and its reply. Both fakes now REFUSE the broken shape, so this can fail.
    const marker = "TOOL-ROLE-DECORATION";
    const history = [
      { role: "user" as const, content: "read it" },
      { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "call_1", name: "Read", input: {} }] },
      { role: "tool" as const, content: [{ type: "tool_result" as const, tool_use_id: "call_1", content: "the file body" }], decoration: { text: marker, door: "tag" as const } },
    ];

    await withResponsesFake(async (fake) => {
      const adapter = createResponsesAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: () => undefined });
      const events = await drain(adapter.streamTurn({ model: SCENARIO.happy, messages: history }, testContext({ stallTimeoutMs: STALL_MS })));
      // The fake enforces `function_call_output` pairing, so a completed turn IS the validity proof.
      expect(events.some((e) => e.type === "done")).toBe(true);
      const input = (JSON.parse(fake.requests.at(-1)!.body) as { input: Array<Record<string, unknown>> }).input;
      const output = input.find((item) => item.type === "function_call_output");
      expect(output?.output).toBe(`${marker}\nthe file body`);
      // Nothing was inserted: the output follows its call directly.
      expect(input[input.indexOf(output!) - 1]!.type).toBe("function_call");
    });

    await withChatFake(async (fake) => {
      const adapter = createChatCompletionsAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: () => undefined });
      const events = await drain(adapter.streamTurn({ model: SCENARIO.happy, messages: history }, testContext({ stallTimeoutMs: STALL_MS })));
      expect(events.some((e) => e.type === "done")).toBe(true);
      const messages = (JSON.parse(fake.requests.at(-1)!.body) as { messages: Array<Record<string, unknown>> }).messages;
      const toolIndex = messages.findIndex((m) => m.role === "tool");
      expect(messages[toolIndex]!.content).toBe(`${marker}\nthe file body`);
      // ADJACENCY: the tool message answers the assistant `tool_calls` message immediately before it.
      expect(messages[toolIndex - 1]!.role).toBe("assistant");
      expect(Array.isArray(messages[toolIndex - 1]!.tool_calls)).toBe(true);
      // And no message carries the marker on its own.
      expect(messages.filter((m) => typeof m.content === "string" && m.content.includes(marker))).toHaveLength(1);
    });
  });

  test("the fakes REFUSE a message inserted between a tool call and its result — so the pin above can fail", async () => {
    // A guard on the guards. Round 2's shape passed every fixture precisely because neither fake
    // modelled the invariant; if these ever return 200, the pin above becomes decorative.
    await withChatFake(async (fake) => {
      const response = await fetch(`${fake.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: SCENARIO.happy,
          messages: [
            { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "Read", arguments: "{}" } }] },
            { role: "user", content: "a note" },
            { role: "tool", tool_call_id: "call_1", content: "ok" },
          ],
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("must be a response to a preceeding message with 'tool_calls'");
    });

    await withResponsesFake(async (fake) => {
      const response = await fetch(`${fake.url}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: SCENARIO.happy,
          input: [
            { type: "function_call", call_id: "call_1", name: "Read", arguments: "{}" },
            { type: "message", role: "user", content: [{ type: "input_text", text: "a note" }] },
            { type: "function_call_output", call_id: "call_1", output: "ok" },
          ],
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("must follow the 'function_call' it answers");
    });
  });

  test("the CODEX fake refuses the same broken pairing — it speaks Responses too (Lane A r3 carry)", async () => {
    // Same guard-on-the-guards as the two above. codex is Responses over a different backend, so
    // the invariant is identical; a fake that accepted an item between a call and its output would
    // be the one surface where the round-3 regression could return unseen.
    await withCodexFake(async (fake) => {
      const response = await fetch(`${fake.url}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: SCENARIO.happy,
          input: [
            { type: "function_call", call_id: "call_1", name: "Read", arguments: "{}" },
            { type: "message", role: "user", content: [{ type: "input_text", text: "a note" }] },
            { type: "function_call_output", call_id: "call_1", output: "ok" },
          ],
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("must follow the 'function_call' it answers");
    });
  });

  test("codex: the recovery `allowed` event fires after an UNMOCKED window wait (I2)", async () => {
    // The quota clock is REAL here — only the retry backoff is mocked. That is the configuration
    // the previous fixture never had, and under it `state()` reads `ok` by the time the turn
    // completes (the wait consumed the window), so reading `state()` made this event unreachable
    // in production while a 1 ms-mocked fixture passed.
    const fake = await startCodexFake({ scenarios: responsesCorpusScenarios() });
    try {
      const started = Date.now();
      const events = await drain(codexAdapterFor(fake.url, new QuotaManager()).streamTurn({ model: SCENARIO.rateLimitShortWindow, messages: [] }, codexContext()));
      const limits = events.filter((e): e is Extract<ProviderEvent, { type: "rate_limit" }> => e.type === "rate_limit");
      // A real second actually elapsed, so the window was waited rather than skipped.
      expect(Date.now() - started).toBeGreaterThanOrEqual(500);
      expect(limits).toHaveLength(2);
      expect(limits[0]!.info.status).toBe("rejected");
      expect(limits.at(-1)!.info).toEqual({ status: "allowed" });
      expect(events.indexOf(limits.at(-1)!)).toBeGreaterThan(events.findIndex((e) => e.type === "done"));
    } finally {
      await fake.close();
    }
  }, 20_000);

  test("codex: a refreshed bearer SURVIVES into the retried attempt (minor 8)", async () => {
    // `openStream` re-read `plan.headers` per attempt, so a set recovered by `recover` was thrown
    // away on the next one: the stale credential went out again, drew a second 401, and forced a
    // redundant refresh on every retry.
    // 401 -> refresh -> 429 -> retry -> 200, scripted on ONE model so the sequence is explicit
    // rather than an artifact of two counters interleaving.
    const fake = await startCodexFake({
      scenarios: {
        [SCENARIO.happy]: (_recorded, attempt) =>
          attempt === 1
            ? errorResponse(401, { error: { message: "expired", code: "invalid_api_key" } })
            : attempt === 2
              ? errorResponse(429, { error: { message: "slow down", code: "rate_limit_exceeded" } })
              : responsesStream({ text: ["recovered"], usage: { input: 1, output: 1 } }),
      },
    });
    try {
      await drain(codexAdapterFor(fake.url, fastQuota()).streamTurn({ model: SCENARIO.happy, messages: [] }, codexContext()));
      // 401 -> refresh -> 429 -> retry -> 200. Every bearer after the refresh is the REFRESHED one;
      // before the fix the retried attempt reverted to the original.
      expect(fake.bearers.length).toBeGreaterThanOrEqual(3);
      expect(fake.bearers[0]).toBe(FAKE_ACCESS_TOKEN);
      expect(fake.bearers.slice(1).every((b) => b === "test-token-codex-access-refreshed")).toBe(true);
      // And exactly ONE token exchange happened, not one per attempt.
      expect(fake.requests.filter((r) => r.path === "/oauth/token")).toHaveLength(1);
    } finally {
      await fake.close();
    }
  }, 20_000);

  test("a DECORATION reaches the LIVE wire on both surfaces, VERBATIM — the recorded segment EQUALS Lane C's text (I-3)", async () => {
    // The unit tests pin the mapping; this pins that nothing between the mapper and the socket drops
    // it. Lane C's decorations were inert before this — built, persisted, then silently discarded,
    // with the switch's `continuity_warning` already reporting the context as carried.
    //
    // EQUALS, not "contains once". The round-1 tripwire counted occurrences of the marker, which is
    // blind to a WRAPPER: this family shipped every decoration behind a `[winter:context] ` prefix
    // of its own and the count-based pin stayed green for three rounds (whole-branch review I-3).
    // The recorded text block/segment must be the decoration text and nothing else, which is what
    // the other three families' pins already assert.
    //
    // Lane C's REAL output is used, not a bare marker: the text arrives already delimited and its
    // §9.6 budget is counted on exactly these bytes, so a layer that re-delimits it is visible here.
    const marker = '<recovered_reasoning_summary provider="anthropic" model="claude-opus-5">DECORATION-REACHED-THE-WIRE</recovered_reasoning_summary>';
    await withResponsesFake(async (fake) => {
      const adapter = createResponsesAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: () => undefined });
      await drain(adapter.streamTurn({ model: SCENARIO.happy, messages: [{ role: "user", content: "q", decoration: { text: marker, door: "tag" } }] }, testContext({ stallTimeoutMs: STALL_MS })));
      const input = (JSON.parse(fake.requests.at(-1)!.body) as { input: Array<Record<string, unknown>> }).input;
      // The decoration LEADS its message as its own part, byte-for-byte, with the content after it.
      expect(input).toEqual([
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: marker },
            { type: "input_text", text: "q" },
          ],
        },
      ]);
    });
    await withChatFake(async (fake) => {
      const adapter = createChatCompletionsAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: () => undefined });
      await drain(adapter.streamTurn({ model: SCENARIO.happy, messages: [{ role: "user", content: "q", decoration: { text: marker, door: "thinking-channel" } }] }, testContext({ stallTimeoutMs: STALL_MS })));
      // Carried PLAINLY, never dressed as the model's own reasoning channel (R6-8). Asserted over
      // every MESSAGE: `reasoning_content` lives on `messages[i]`, never at the top level, so the
      // previous top-level check could not have failed and proved nothing.
      const messages = (JSON.parse(fake.requests.at(-1)!.body) as { messages: Array<Record<string, unknown>> }).messages;
      expect(messages.every((m) => !("reasoning_content" in m))).toBe(true);
      // The chat surface joins a text-only message into ONE string, so the whole content is pinned:
      // the decoration's own segment is everything before the newline, and a prefix or wrapper of
      // this layer's own changes it.
      const user = messages.find((m) => m.role === "user");
      expect(user?.content).toBe(`${marker}\nq`);
    });
  });

  test("I3: a DeepSeek profile WITH a descriptor captures and replays `reasoning_content`; with `() => undefined` it does not", async () => {
    // The ruling's own fixture. Without a lookup, `captureExposed` is false, so nothing is captured,
    // nothing is replayed, and the second leg of every tool loop 400s at DeepSeek — silently, and
    // only in production. The `continuationReplay` scenario answers 400 exactly as §6.3 documents,
    // so the two branches are told apart by the PROVIDER's own verdict.
    const deepSeekDescriptors = descriptorsFor({ efforts: ["low", "medium", "high"], readableState: "full-exposed", continuation: "plaintext" });

    await withChatFake(async (fake) => {
      const withEvidence = createChatCompletionsAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: deepSeekDescriptors });
      const ctx = testContext({ providerId: "deepseek", stallTimeoutMs: STALL_MS });
      const first = await drain(withEvidence.streamTurn({ model: SCENARIO.reasoning, messages: [], tools: [{ name: "Read", description: "d", inputSchema: { type: "object" } }] }, ctx));
      const state = first.find((e) => e.type === "native_state");
      expect(state).toBeDefined();

      const items = state?.type === "native_state" ? state.items : [];
      const second = await drain(
        withEvidence.streamTurn(
          {
            model: SCENARIO.continuationReplay,
            tools: [{ name: "Read", description: "d", inputSchema: { type: "object" } }],
            messages: [
              { role: "user", content: "go" },
              { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "Read", input: {} }], nativeState: { family: "openai", continuationDomain: "corpus-domain", items } },
              { role: "tool", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }] },
            ],
          },
          ctx,
        ),
      );
      expect(second.some((e) => e.type === "done")).toBe(true);
      expect(fake.requests.at(-1)!.body).toContain("reasoning_content");
    });

    await withChatFake(async (fake) => {
      // The SAME turn against an adapter that says, explicitly, that this model has no evidence.
      const unlisted = createChatCompletionsAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: () => undefined });
      const events = await drain(
        unlisted.streamTurn({ model: SCENARIO.reasoning, messages: [], tools: [{ name: "Read", description: "d", inputSchema: { type: "object" } }] }, testContext({ providerId: "deepseek", stallTimeoutMs: STALL_MS })),
      );
      // The reasoning is still OBSERVABLE — what is absent is the replayable state.
      expect(events.some((e) => e.type === "thinking_exposed_delta")).toBe(true);
      expect(events.some((e) => e.type === "native_state")).toBe(false);
    });
  });

  test("local: discovery falls back to Ollama's /api/tags when /v1/models is absent", async () => {
    const { startFake } = await import("../fakes/server.ts");
    const { modelsNotFoundRoutes, ollamaTagsRoute } = await import("../fakes/openai-models.ts");
    const fake = await startFake({ routes: [...modelsNotFoundRoutes(), ollamaTagsRoute([{ name: "llama3.1:8b" }, { name: "qwen3:4b" }])] });
    try {
      const adapter = createLocalOpenAIAdapter({ retry: FAST_RETRY, descriptors: () => undefined });
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
      const adapter = createResponsesAdapter({ generatedBaseUrl: first.url, retry: FAST_RETRY, descriptors: () => undefined });
      const before = await discoverModels(adapter, testDiscoveryContext({ stallTimeoutMs: STALL_MS }));
      expect(before.models.map((m) => m.id)).toEqual(["alpha", "beta"]);
      expect(before.partial).toBe(false);
    } finally {
      await first.close();
    }

    // The same provider, now serving only `alpha`: a COMPLETE page, so beta is genuinely gone.
    const after = await startFake({ routes: openAiModelsRoutes({ pages: [{ rows: [{ id: "alpha" }] }] }) });
    try {
      const adapter = createResponsesAdapter({ generatedBaseUrl: after.url, retry: FAST_RETRY, descriptors: () => undefined });
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
      const adapter = createResponsesAdapter({ generatedBaseUrl: bounded.url, retry: FAST_RETRY, descriptors: () => undefined });
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
      const adapter = createChatCompletionsAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: () => undefined });
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
      const adapter = createChatCompletionsAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: () => undefined });
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

  test("opaque state never reaches a stream frame", async () => {
    await withResponsesFake(async (fake) => {
      const adapter = createResponsesAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: descriptorsFor({ efforts: ["low", "medium", "high"], continuation: "opaque-provider-state" }) });
      const events = await drain(adapter.streamTurn({ model: SCENARIO.reasoning, messages: [], effort: "high" }, testContext({ stallTimeoutMs: STALL_MS })));
      // The marker exists only inside `native_state`, whose sole sink is the sidecar.
      const nonState = events.filter((e) => e.type !== "native_state");
      expect(JSON.stringify(nonState)).not.toContain(OPAQUE_MARKER);
      expect(events.some((e) => e.type === "native_state")).toBe(true);
    });
  });

  test("a CROSS-DOMAIN replay never reaches the wire — through the real renderer, end to end", async () => {
    // The Global Constraint's own negative, proved on the LIVE REQUEST rather than on a renderer
    // unit test: opaque items are meaningful only to the provider that minted them, so state from
    // another continuation domain must be dropped before the body is built. `adapterAsProvider`
    // is the real production path (identity renderer included), and `noRequestContains` is the
    // same shape capture (H) used to prove the sidecar was never sent to a model.
    await withResponsesFake(async (fake) => {
      const adapter = createResponsesAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: descriptorsFor({ efforts: ["low", "medium", "high"], continuation: "opaque-provider-state" }) });
      const resolved = {
        providerId: "openai",
        modelKey: `corpus/${SCENARIO.happy}`,
        providerModelId: SCENARIO.happy,
        adapterId: adapter.id,
        adapter,
        descriptor: descriptorsFor({ efforts: ["low", "medium", "high"], continuation: "opaque-provider-state" })(SCENARIO.happy),
        provider: { id: "openai", displayName: "OpenAI", adapterId: adapter.id } as never,
        continuationDomain: "corpus-domain",
        catalogVersion: "0.0.0-seed",
      };
      const provider = adapterAsProvider(resolved, testContext({ stallTimeoutMs: STALL_MS }));
      await provider.generate({
        messages: [
          { role: "user", content: "go" },
          // SAME domain: replayed.
          { role: "assistant", content: "mine", nativeState: { family: "openai", continuationDomain: "corpus-domain", items: [{ type: "reasoning", encrypted_content: OPAQUE_MARKER }] } },
          // ANOTHER domain: must be dropped, items and all.
          { role: "assistant", content: "theirs", nativeState: { family: "google", continuationDomain: "some-other-domain", items: [{ type: "reasoning", encrypted_content: FOREIGN_MARKER }] } },
        ],
      });
      expect(noRequestContains(fake, FOREIGN_MARKER)).toBe(true);
      // The in-domain half DID ride, so the negative is not passing because nothing replayed at all.
      expect(fake.requests.at(-1)?.body.includes(OPAQUE_MARKER)).toBe(true);
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
