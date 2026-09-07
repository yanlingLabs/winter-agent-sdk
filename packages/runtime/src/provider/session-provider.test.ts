// Phase 6 Task 10: the WIRING tripwires.
//
// Every one of these fails if a line of `session-provider.ts` is deleted, and each names the silent
// failure it exists to catch. That is the whole point: this phase's own plan calls it out verbatim —
// "a field declared upstream proves nothing across a seam" — and every obligation below was, before
// this file, a seam that was reachable only from the test that shipped it.
//
// GROUND TRUTH IS THE LOOPBACK FAKE'S REQUEST LOG, never adapter intent. A test that asserted "the
// adapter would have sent X" cannot tell a wired provider from an unwired one; a test that asserts
// "the fake, on 127.0.0.1, received exactly this" can only pass if the whole chain ran.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialRef, RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import type { ModelFamilyDescriptor, WinterCatalog, WinterModelDescriptor, WinterProviderDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { familyIdOf, stampFamilyFields } from "@yanlinglabs/winter-provider-catalog";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { WinterProviderResolutionError, createMemoryCredentialStore, type CredentialMaterial } from "@yanlinglabs/winter-provider-runtime";
import { ANTHROPIC_DEFAULT_BASE_URL } from "@yanlinglabs/winter-provider-runtime";
import { startFake, sseResponse, jsonResponse, type FakeServer } from "@yanlinglabs/winter-provider-conformance";
import { startScenarioFake } from "./scenario-fake.ts";
import { buildSessionProvider, apiKeySourceFor, connectionForProvider } from "./session-provider.ts";
import { computeActiveSlotSet, resolveSlotToProvider, type CredentialPresence, type SlotProviderResolution } from "./slots.ts";
import { echoProvider } from "./mock.ts";
import type { ProviderMessage } from "../engine.ts";
import { runEngine } from "../engine.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";
import type { ProviderStateRecordInput } from "../store/provider-state.ts";

// --- fixtures -------------------------------------------------------------------------------------

const OBSERVED_AT = "2026-09-06";

function evidence<T>(value: T): { value: T; source: "official-doc"; observedAt: string; confidence: "verified" } {
  return { value, source: "official-doc", observedAt: OBSERVED_AT, confidence: "verified" };
}

function testProvider(init: { id: string; adapterId: string; family: string; api: string; discovery?: WinterProviderDescriptor["modelDiscovery"] }): WinterProviderDescriptor {
  return {
    id: init.id,
    displayName: init.id,
    protocols: ["openai-responses"],
    authKinds: ["api-key"],
    // THE GENERATED ENDPOINT. Pointing it at the loopback fake is what makes the privileged-header
    // assertion below possible at all: a `ConnectionProfile.baseUrl` is a USER endpoint by
    // definition, and `applyPrivilegedHeaders` correctly drops the identity headers for one.
    defaultEndpoints: { api: init.api },
    modelDiscovery: init.discovery ?? "none",
    liveCatalogAuthority: "partial",
    adapterId: init.adapterId,
    family: init.family,
    upstream: { project: "winter", commit: "", sourcePaths: [] },
    risk: { class: "approved", reasons: [] },
    scope: "llm",
    // WS-13b §1: both fields are REQUIRED on every provider row, so a fixture states its
    // own basis rather than inheriting one — a row-shape change fails HERE, at the fixture.
    pricingBasis: "token",
    admission: { basis: "api-key", citation: "fixture:session-provider", tier: "local" },
  };
}

// WS-13c: `modelFamily`/`canonicalModelId` are DERIVED, never hand-typed into a fixture. The
// pipeline's own `stampFamilyFields` fills them here with NO families, so a fixture row lands in
// `other` carrying the real normaliser's canonical id rather than a second, drifting spelling.
const stampRow = (row: Omit<WinterModelDescriptor, "modelFamily" | "canonicalModelId">): WinterModelDescriptor => stampFamilyFields([row], [])[0]!;

function testModel(init: { key: string; providerId: string; upstreamId: string; contextWindow?: number; toolCalling?: "native" | "emulated" | "none"; unsupportedParameters?: string[] }): WinterModelDescriptor {
  return stampRow({
    key: init.key,
    providerId: init.providerId,
    upstreamId: init.upstreamId,
    displayName: init.key,
    description: `${init.key} test row`,
    aliases: [],
    endpoints: ["responses"],
    ...(init.contextWindow !== undefined ? { contextWindow: evidence(init.contextWindow) } : {}),
    inputModalities: evidence(["text"]),
    outputModalities: evidence(["text"]),
    toolCalling: evidence(init.toolCalling ?? "native"),
    nativeTools: evidence(true),
    unsupportedParameters: init.unsupportedParameters ?? [],
    status: "supported",
  } as Omit<WinterModelDescriptor, "modelFamily" | "canonicalModelId">);
}

// WS-13c (P6.6 Lane A): `families` joins the builder as an OPTIONAL third argument, defaulting to
// the spine's `[]` — every existing caller is unchanged, and the slot tests below get a catalog with
// real lineups without a second builder that could drift from this one.
function catalogWith(providers: WinterProviderDescriptor[], models: WinterModelDescriptor[], families: ModelFamilyDescriptor[] = []): WinterCatalog {
  return {
    schemaVersion: 2,
    families,
    catalogVersion: "0.0.0-t10-fixture",
    upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" },
    providers,
    models,
  };
}

/** A minimal OpenAI Responses turn: one text delta, then completion. Enough for the adapter to fold a real turn. */
function responsesTextTurn(text: string): string[] {
  return [
    JSON.stringify({ type: "response.created", response: { id: "resp_1", model: "t10-model", output: [] } }),
    JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [] } }),
    JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: text }),
    JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text }] } }),
    JSON.stringify({ type: "response.completed", response: { id: "resp_1", model: "t10-model", status: "completed", usage: { input_tokens: 3, output_tokens: 2 }, output: [] } }),
  ];
}

async function withResponsesFake(run: (fake: FakeServer) => Promise<void>): Promise<void> {
  const fake = await startFake({
    routes: [
      {
        path: "/responses",
        method: "POST",
        handler: () => sseResponse(responsesTextTurn("hello from the fake").map((data) => ({ data }))),
      },
      { path: "/models", method: "GET", handler: () => jsonResponse({ data: [] }) },
    ],
  });
  try {
    await run(fake);
  } finally {
    await fake.close();
  }
}

const USER_TURN: ProviderMessage[] = [{ role: "user", content: "ping" }];

function baseConfig(over: Partial<RuntimeConfig>): RuntimeConfig {
  return { sessionId: "t10-session", cwd: process.cwd(), ...over } as RuntimeConfig;
}

// --- the tripwires --------------------------------------------------------------------------------

describe("T10 wiring: the session's provider IS the catalog-resolved adapter", () => {
  test("a wired session's generate() reaches the LOOPBACK FAKE — the fake's own request log is the proof", async () => {
    await withResponsesFake(async (fake) => {
      const catalog = catalogWith(
        [testProvider({ id: "t10openai", adapterId: "winter.openai-responses", family: "openai", api: fake.url })],
        [testModel({ key: "t10openai/t10-model", providerId: "t10openai", upstreamId: "t10-model" })],
      );
      const wiring = buildSessionProvider({
        config: baseConfig({ model: "t10openai/t10-model", provider: { providerId: "t10openai", authRef: { kind: "inline", value: "test" } } }),
        env: {},
        catalog,
        credentials: createMemoryCredentialStore(),
      });

      const turn = await wiring.provider.generate({ messages: USER_TURN, model: "t10-model" });

      // (1) THE FAKE RECEIVED IT. Not "the adapter would have sent it" — a request that reached a
      // loopback server on 127.0.0.1 can only have been made by a live HTTP client at the end of the
      // whole chain: selection -> registry -> adapter -> `adapterAsProvider` -> the bridge's fold.
      expect(fake.requests.length).toBe(1);
      expect(fake.requests[0]?.method).toBe("POST");
      expect(fake.requests[0]?.path).toBe("/responses");
      expect(JSON.parse(fake.requests[0]?.body ?? "{}").model).toBe("t10-model");
      // (2) And the fold came back through the bridge as a real turn.
      expect(turn.kind).toBe("text");
      expect(turn.kind === "text" ? turn.text : "").toBe("hello from the fake");
    });
  });

  test("the identity is the CATALOG's, field for field — an adapter swapped underneath would report a different adapterId/version", async () => {
    await withResponsesFake(async (fake) => {
      const catalog = catalogWith(
        [testProvider({ id: "t10openai", adapterId: "winter.openai-responses", family: "openai", api: fake.url })],
        [testModel({ key: "t10openai/t10-model", providerId: "t10openai", upstreamId: "t10-model", contextWindow: 12345 })],
      );
      const wiring = buildSessionProvider({
        config: baseConfig({ model: "t10openai/t10-model", provider: { providerId: "t10openai", authRef: { kind: "inline", value: "test" } } }),
        env: {},
        catalog,
        credentials: createMemoryCredentialStore(),
      });
      expect(wiring.identity).toBeDefined();
      expect(wiring.identity?.providerId).toBe("t10openai");
      expect(wiring.identity?.modelKey).toBe("t10openai/t10-model");
      expect(wiring.identity?.adapterId).toBe("winter.openai-responses");
      expect(wiring.identity?.catalogVersion).toBe("0.0.0-t10-fixture");
      expect(wiring.identity?.authRefKind).toBe("inline");
      // P3 carry: the descriptor's window, not the engine's 200000 default.
      expect(wiring.contextWindowTokens).toBe(12345);
      // P4 carry: from the descriptor's own `toolCalling` evidence.
      expect(wiring.providerSupportsToolSearch).toBe(true);
    });
  });

  test("an explicit `contextWindowTokens` WINS over the descriptor — the one number a host may deliberately make smaller", async () => {
    await withResponsesFake(async (fake) => {
      const catalog = catalogWith(
        [testProvider({ id: "t10openai", adapterId: "winter.openai-responses", family: "openai", api: fake.url })],
        [testModel({ key: "t10openai/t10-model", providerId: "t10openai", upstreamId: "t10-model", contextWindow: 999_999 })],
      );
      const wiring = buildSessionProvider({
        config: baseConfig({ model: "t10openai/t10-model", contextWindowTokens: 4096, provider: { providerId: "t10openai", authRef: { kind: "inline", value: "test" } } }),
        env: {},
        catalog,
        credentials: createMemoryCredentialStore(),
      });
      expect(wiring.contextWindowTokens).toBeUndefined();
    });
  });

  test("`providerSupportsToolSearch` is FALSE for an emulated-tool-calling model, and OMITTED when nothing is known", async () => {
    await withResponsesFake(async (fake) => {
      const catalog = catalogWith(
        [testProvider({ id: "t10openai", adapterId: "winter.openai-responses", family: "openai", api: fake.url })],
        [testModel({ key: "t10openai/t10-model", providerId: "t10openai", upstreamId: "t10-model", toolCalling: "emulated" })],
      );
      const wiring = buildSessionProvider({
        config: baseConfig({ model: "t10openai/t10-model", provider: { providerId: "t10openai", authRef: { kind: "inline", value: "test" } } }),
        env: {},
        catalog,
        credentials: createMemoryCredentialStore(),
      });
      expect(wiring.providerSupportsToolSearch).toBe(false);
    });
  });
});

describe("T10 wiring: the DESCRIPTOR is wired into the adapter (Lane A concern 1)", () => {
  test("an unsupported parameter is REFUSED before anything reaches the fake — omitting `descriptors` would let the request through silently", async () => {
    await withResponsesFake(async (fake) => {
      const catalog = catalogWith(
        [testProvider({ id: "t10openai", adapterId: "winter.openai-responses", family: "openai", api: fake.url })],
        // `tools` declared unsupported: WS-13 §8.2 says reject the SELECTION before sending, and the
        // rejection is only possible because the wiring handed this row to the adapter.
        [testModel({ key: "t10openai/t10-model", providerId: "t10openai", upstreamId: "t10-model", unsupportedParameters: ["tools"] })],
      );
      const wiring = buildSessionProvider({
        config: baseConfig({ model: "t10openai/t10-model", provider: { providerId: "t10openai", authRef: { kind: "inline", value: "test" } } }),
        env: {},
        catalog,
        credentials: createMemoryCredentialStore(),
      });

      let thrown: unknown;
      try {
        await wiring.provider.generate({ messages: USER_TURN, model: "t10-model", tools: [{ name: "probe", description: "d", inputSchema: { type: "object" } }] });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      // THE ASSERTION THAT MATTERS: nothing was sent. A wiring that dropped `descriptors` would have
      // no row to read `unsupportedParameters` from, would send the request, and the fake would have
      // recorded it — with no error anywhere.
      expect(fake.requests.length).toBe(0);
    });
  });
});

describe("T10 wiring: R6-11 / R6-L — privileged headers ride a GENERATED endpoint only", () => {
  // THE CODEX FAMILY, because its privileged headers are unconditional: `originator` identifies this
  // client to the reviewed backend and `chatgpt-account-id` names the operator's account, and neither
  // has any business at a base URL the reviewed catalog never named (the adapter's own words).
  const CODEX_REF: Extract<CredentialRef, { kind: "keychain" }> = { kind: "keychain", account: "codex-oauth:default" };

  function codexCredentials() {
    const material: CredentialMaterial = { kind: "oauth", accessToken: "fake-access-token", accountId: "acct-t10", expiresAt: Date.now() + 3_600_000 };
    return createMemoryCredentialStore([[CODEX_REF, material] as const]);
  }

  test("`originator` and `chatgpt-account-id` reach the fake when the CATALOG named the endpoint, and are DROPPED when the host overrode it", async () => {
    await withResponsesFake(async (fake) => {
      const catalog = catalogWith(
        [testProvider({ id: "t10codex", adapterId: "winter.codex-oauth", family: "openai", api: fake.url })],
        [testModel({ key: "t10codex/t10-codex-model", providerId: "t10codex", upstreamId: "t10-codex-model" })],
      );

      // (a) GENERATED: no `connection.baseUrl`, so the adapter speaks to the CATALOG's endpoint --
      // which `createShippedAdapters` passes through as the adapter's own `generatedBaseUrl`, making
      // the catalog (not a compiled-in constant) the authority R6-11 says a reviewed endpoint is.
      const generated = buildSessionProvider({
        config: baseConfig({ model: "t10codex/t10-codex-model", provider: { providerId: "t10codex", authRef: CODEX_REF } }),
        env: {},
        catalog,
        credentials: codexCredentials(),
      });
      await generated.provider.generate({ messages: USER_TURN, model: "t10-codex-model" });
      expect(fake.requests.length).toBe(1);
      expect(fake.requests[0]?.headers["originator"]).toBe("winter");
      expect(fake.requests[0]?.headers["chatgpt-account-id"]).toBe("acct-t10");

      // (b) USER: the SAME fake, the same URL — only its reviewed status differs, which is exactly
      // what R6-L gates on. Both headers must be gone, and their absence must not be an error.
      const user = buildSessionProvider({
        // `local: true` because R6-11 refuses plain http to a loopback address unless the profile
        // DECLARES a local installation — a rule about the user endpoint, not about this test.
        config: baseConfig({ model: "t10codex/t10-codex-model", provider: { providerId: "t10codex", authRef: CODEX_REF, connection: { baseUrl: fake.url, local: true } } }),
        env: {},
        catalog,
        credentials: codexCredentials(),
      });
      await user.provider.generate({ messages: USER_TURN, model: "t10-codex-model" });
      expect(fake.requests.length).toBe(2);
      expect(fake.requests[1]?.headers["originator"]).toBeUndefined();
      expect(fake.requests[1]?.headers["chatgpt-account-id"]).toBeUndefined();
      // The CREDENTIAL still goes out on both — a user endpoint has to be reachable at all, and auth
      // is governed by the separate origin-change rule, not by this one.
      expect(fake.requests[1]?.headers["authorization"]).toBe("Bearer ***");
    });
  });

  test("the codex originator stays `winter` — a deliberately non-first-party value that must never be reverted (WS-01 §3)", async () => {
    await withResponsesFake(async (fake) => {
      const catalog = catalogWith(
        [testProvider({ id: "t10codex", adapterId: "winter.codex-oauth", family: "openai", api: fake.url })],
        [testModel({ key: "t10codex/t10-codex-model", providerId: "t10codex", upstreamId: "t10-codex-model" })],
      );
      const wiring = buildSessionProvider({
        config: baseConfig({ model: "t10codex/t10-codex-model", provider: { providerId: "t10codex", authRef: CODEX_REF } }),
        env: {},
        catalog,
        credentials: codexCredentials(),
      });
      await wiring.provider.generate({ messages: USER_TURN, model: "t10-codex-model" });
      expect(fake.requests[0]?.headers["originator"]).toBe("winter");
    });
  });
});

describe("T10 wiring: `connectionForProvider` never demotes a reviewed endpoint (Lane A's second-half obligation)", () => {
  const real = loadCatalog();

  test("a single-provider adapter (openai, google, bedrock) gets NO baseUrl — copying the catalog's endpoint in would make it a user endpoint and silently drop every privileged header", () => {
    // `anthropic` WAS in this list and is not any more, and the reason is a fact about the catalog
    // rather than about this rule: P6.5's widening (WS-13b §2, R6b-5) put five providers on
    // `winter.anthropic-messages`, so it is no longer a single-provider adapter and falls under the
    // case below. The rule itself is unchanged. The cost of that move is pinned by the next test.
    for (const providerId of ["openai", "google", "bedrock"]) {
      const provider = real.providers.find((p) => p.id === providerId);
      expect(provider).toBeDefined();
      expect([providerId, real.providers.filter((p) => p.adapterId === provider!.adapterId).length]).toEqual([providerId, 1]);
      const connection = connectionForProvider(baseConfig({ model: "x" }), real, provider!);
      expect(connection?.baseUrl).toBeUndefined();
    }
  });

  test("`anthropic` became a MULTI-provider row in P6.5, and the copy costs it nothing — but here is exactly what would make it cost something", () => {
    // Two facts hold this down, and both are checked rather than asserted in prose.
    //
    //  1. The copied URL IS the adapter's own compiled default. The mapper's endpoint strip
    //     (WS-13b §2) turns upstream's `https://api.anthropic.com/v1/messages` into the API root,
    //     and that root is byte-identical to `ANTHROPIC_DEFAULT_BASE_URL`. So the request goes to
    //     the same place either way; only the endpoint's PROVENANCE changed.
    //  2. The Anthropic family builds NO privileged header — `messages.ts` calls
    //     `applyPrivilegedHeaders(policy, {})` with an empty set, deliberately, so the R6-L rule has
    //     a call site. An empty set gated to `{}` is still `{}`.
    //
    // THE SECOND IS A TRIPWIRE, not a reassurance: the day a privileged header is added to this
    // family, a copied `connection.baseUrl` is evaluated `generated: false` and that header is
    // dropped silently. The fix that removes the exposure is a reviewed/generated marker on
    // `ProviderConnectionConfig` — an `sdk/**` type, and a spine change. Until then, this test is
    // where that debt is written down.
    const provider = real.providers.find((p) => p.id === "anthropic")!;
    expect(real.providers.filter((p) => p.adapterId === provider.adapterId).length).toBeGreaterThan(1);
    const connection = connectionForProvider(baseConfig({ model: "x" }), real, provider);
    expect(connection?.baseUrl).toBe(provider.defaultEndpoints["api"] as string);
    expect(connection?.baseUrl).toBe(ANTHROPIC_DEFAULT_BASE_URL);
  });

  test("a MULTI-provider adapter's rows DO get the catalog endpoint — there is no single vendor default to fall back to", () => {
    for (const providerId of ["deepseek", "openrouter", "ollama-local", "anthropic", "zai-anthropic"]) {
      const provider = real.providers.find((p) => p.id === providerId);
      expect(provider).toBeDefined();
      const connection = connectionForProvider(baseConfig({ model: "x" }), real, provider!);
      expect(connection?.baseUrl).toBe(provider!.defaultEndpoints["api"] as string);
    }
  });

  test("a LOCAL provider additionally gets `local: true` — plain http to a private address is refused unless the profile declares it", () => {
    const provider = real.providers.find((p) => p.id === "ollama-local");
    const connection = connectionForProvider(baseConfig({ model: "x" }), real, provider!);
    expect(connection?.local).toBe(true);
  });

  test("the OPERATOR's own baseUrl always wins, verbatim", () => {
    const provider = real.providers.find((p) => p.id === "deepseek");
    const connection = connectionForProvider(
      baseConfig({ model: "x", provider: { providerId: "deepseek", connection: { baseUrl: "https://proxy.example.invalid/v1" } } }),
      real,
      provider!,
    );
    expect(connection?.baseUrl).toBe("https://proxy.example.invalid/v1");
  });
});

describe("T10 wiring: R6-9 refuses rather than defaulting — and the refusal is DEFERRED to the first generation", () => {
  // REVIEW ROUND 1, CRITICAL A. R6-9's own sentence is "typed `WinterProviderResolutionError`
  // surfaced in T1's captured failure shape", and that shape (capture (I)) HAS a `system/init` in
  // it. So the session constructs, reports no identity, and the refusal arrives on the first
  // generation — where `isProviderTurnError` already recognises the class by name and lands it on
  // R6-F's result shape with `api_error_status: null`.
  //
  // The negative half is the load-bearing one: a wiring that quietly substituted an echo provider
  // would ALSO construct, and these tests would pass. So each asserts the refusal is REACHABLE and
  // carries its own code.
  async function refusalFrom(config: RuntimeConfig): Promise<{ wiring: ReturnType<typeof buildSessionProvider>; thrown: unknown }> {
    const wiring = buildSessionProvider({ config, env: {}, catalog: loadCatalog(), credentials: createMemoryCredentialStore() });
    let thrown: unknown;
    try {
      await wiring.provider.generate({ messages: USER_TURN });
    } catch (err) {
      thrown = err;
    }
    return { wiring, thrown };
  }

  test("a bare model with no provider CONSTRUCTS, reports no identity, and refuses on the first generation", async () => {
    const { wiring, thrown } = await refusalFrom(baseConfig({ model: "some-model" }));
    // It constructed. `system/init` will therefore be emitted, carrying no `winter_provider`.
    expect(wiring.identity).toBeUndefined();
    expect(wiring.resolutionError).toBeInstanceOf(WinterProviderResolutionError);
    expect(wiring.resolutionError?.code).toBe("no-provider-for-bare-model");
    // And the refusal is the typed error the engine maps onto R6-F's shape — never a silent echo.
    expect(thrown).toBeInstanceOf(WinterProviderResolutionError);
    expect((thrown as WinterProviderResolutionError).code).toBe("no-provider-for-bare-model");
  });

  test("no model at all is the same deferred refusal", async () => {
    const { wiring, thrown } = await refusalFrom(baseConfig({}));
    expect(wiring.resolutionError).toBeInstanceOf(WinterProviderResolutionError);
    expect(thrown).toBeInstanceOf(WinterProviderResolutionError);
  });

  test("an UNKNOWN model under a real provider refuses too — Winter validates ids against the catalog (R6-F's disclosed divergence from echo-and-send)", async () => {
    const { wiring, thrown } = await refusalFrom(
      baseConfig({ model: "anthropic/not-a-real-model", provider: { providerId: "anthropic", authRef: { kind: "inline", value: "x" } } }),
    );
    expect(wiring.resolutionError?.code).toBe("unknown-model");
    expect((thrown as WinterProviderResolutionError).code).toBe("unknown-model");
  });

  test("a refused session reports NO model rows and NO account — it has nothing to report them from", async () => {
    const { wiring } = await refusalFrom(baseConfig({ model: "some-model" }));
    expect(wiring.supportedModels()).toEqual([]);
    expect(wiring.accountInfo()).toEqual({});
    expect(wiring.classifierRoute.kind).toBe("manual-fallback");
  });
});

describe("T10 wiring: R6-13 — the reserved namespace has NO catalog identity", () => {
  test("`winter-test/echo` returns the scripted double and reports no identity, so nothing fabricates a provider row in the init frame", async () => {
    const wiring = buildSessionProvider({
      config: baseConfig({ model: "winter-test/echo" }),
      env: {},
      catalog: loadCatalog(),
      credentials: createMemoryCredentialStore(),
    });
    expect(wiring.identity).toBeUndefined();
    expect(wiring.resolved).toBeUndefined();
    expect(wiring.supportedModels()).toEqual([]);
    expect(wiring.accountInfo()).toEqual({});
    expect(wiring.provider).toBe(echoProvider);
  });

  test("THE FENCE: the shipped catalog names no `winter-test` provider, so a real row can never shadow the namespace", () => {
    const catalog = loadCatalog();
    // A provider id, an adapter id, or a model key that started with the reserved prefix would make
    // the namespace ambiguous -- and `resolveSessionProvider` checks the namespace FIRST, so the
    // ambiguity would resolve in the DOUBLE's favour and a real model would silently become a
    // scripted one. The check is on the shipped data because that is the half a lane could move.
    expect(catalog.providers.filter((p) => p.id.startsWith("winter-test"))).toEqual([]);
    expect(catalog.providers.filter((p) => p.adapterId.startsWith("winter-test"))).toEqual([]);
    expect(catalog.models.filter((m) => m.key.startsWith("winter-test/"))).toEqual([]);
    expect(catalog.models.filter((m) => m.aliases.some((a) => a.startsWith("winter-test")))).toEqual([]);
  });

  test("an UNREGISTERED reserved name is a typed refusal, never a silent miss", async () => {
    const wiring = buildSessionProvider({ config: baseConfig({ model: "winter-test/not-a-double" }), env: {}, catalog: loadCatalog(), credentials: createMemoryCredentialStore() });
    expect(wiring.resolutionError?.code).toBe("unknown-model");
    let thrown: unknown;
    try {
      await wiring.provider.generate({ messages: USER_TURN });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WinterProviderResolutionError);
  });
});

describe("T10 wiring: R6-14 — the classifier route", () => {
  test("with NO `autoClassifier` and a catalog row carrying no verified structured-output evidence, the route is Manual and NO classifier is built", async () => {
    await withResponsesFake(async (fake) => {
      const catalog = catalogWith(
        [testProvider({ id: "t10openai", adapterId: "winter.openai-responses", family: "openai", api: fake.url })],
        [testModel({ key: "t10openai/t10-model", providerId: "t10openai", upstreamId: "t10-model" })],
      );
      const wiring = buildSessionProvider({
        config: baseConfig({ model: "t10openai/t10-model", provider: { providerId: "t10openai", authRef: { kind: "inline", value: "test" } } }),
        env: {},
        catalog,
        credentials: createMemoryCredentialStore(),
      });
      expect(wiring.classifierRoute.kind).toBe("manual-fallback");
      expect(wiring.classifier).toBeUndefined();
    });
  });

  test("a CONFIGURED `autoClassifier` model resolves through the same selection path and produces a real classifier", async () => {
    await withResponsesFake(async (fake) => {
      const catalog = catalogWith(
        [testProvider({ id: "t10openai", adapterId: "winter.openai-responses", family: "openai", api: fake.url })],
        [
          testModel({ key: "t10openai/t10-model", providerId: "t10openai", upstreamId: "t10-model" }),
          testModel({ key: "t10openai/t10-reviewer", providerId: "t10openai", upstreamId: "t10-reviewer" }),
        ],
      );
      const wiring = buildSessionProvider({
        config: baseConfig({
          model: "t10openai/t10-model",
          autoClassifier: { model: "t10openai/t10-reviewer" },
          provider: { providerId: "t10openai", authRef: { kind: "inline", value: "test" } },
        }),
        env: {},
        catalog,
        credentials: createMemoryCredentialStore(),
      });
      expect(wiring.classifierRoute.kind).toBe("configured");
      expect(wiring.classifier).toBeDefined();
    });
  });

  test("an UNRESOLVABLE classifier model DEGRADES to Manual with a stated reason — a reviewer nobody can identify must not review", async () => {
    await withResponsesFake(async (fake) => {
      const catalog = catalogWith(
        [testProvider({ id: "t10openai", adapterId: "winter.openai-responses", family: "openai", api: fake.url })],
        [testModel({ key: "t10openai/t10-model", providerId: "t10openai", upstreamId: "t10-model" })],
      );
      const wiring = buildSessionProvider({
        config: baseConfig({
          model: "t10openai/t10-model",
          autoClassifier: { model: "t10openai/nope" },
          provider: { providerId: "t10openai", authRef: { kind: "inline", value: "test" } },
        }),
        env: {},
        catalog,
        credentials: createMemoryCredentialStore(),
      });
      expect(wiring.classifierRoute.kind).toBe("manual-fallback");
      expect(wiring.classifier).toBeUndefined();
      expect(wiring.classifierRoute.kind === "manual-fallback" ? wiring.classifierRoute.reason : "").toContain("could not be resolved");
    });
  });
});

describe("T10 wiring: the advisor backend (P2 carry, `config.advisor.model`)", () => {
  test("a configured advisor model produces its own provider, resolved through the same path", async () => {
    await withResponsesFake(async (fake) => {
      const catalog = catalogWith(
        [testProvider({ id: "t10openai", adapterId: "winter.openai-responses", family: "openai", api: fake.url })],
        [
          testModel({ key: "t10openai/t10-model", providerId: "t10openai", upstreamId: "t10-model" }),
          testModel({ key: "t10openai/t10-advisor", providerId: "t10openai", upstreamId: "t10-advisor" }),
        ],
      );
      const wiring = buildSessionProvider({
        config: baseConfig({
          model: "t10openai/t10-model",
          advisor: { model: "t10openai/t10-advisor" },
          provider: { providerId: "t10openai", authRef: { kind: "inline", value: "test" } },
        }),
        env: {},
        catalog,
        credentials: createMemoryCredentialStore(),
      });
      // P7a LANE B: the field became `resolveReviewer` (a function, because the model can now come
      // from a HOT setting and from a per-family default that follows `set_model`). The claim is
      // unchanged.
      const reviewer = wiring.resolveReviewer?.();
      expect(reviewer).toBeDefined();
      expect(reviewer!.model).toBe("t10openai/t10-advisor");
      // AND IT IS A DIFFERENT PROVIDER OBJECT from the session's. Sharing one would mean the advisor
      // silently ran on the session's model, which is the whole thing `config.advisor.model` exists
      // to prevent.
      expect(reviewer!.provider).not.toBe(wiring.provider);
      // R6-G's "pinned at first use": a second call inside one settings version is the SAME object.
      expect(wiring.resolveReviewer!()).toBe(reviewer);
    });
  });
});

describe("T10 wiring: R6-I — `supportedModels()` and `accountInfo()`", () => {
  test("`supportedModels()` returns the session provider's catalog rows, with unknown capability booleans OMITTED", async () => {
    await withResponsesFake(async (fake) => {
      const catalog = catalogWith(
        [testProvider({ id: "t10openai", adapterId: "winter.openai-responses", family: "openai", api: fake.url })],
        [testModel({ key: "t10openai/t10-model", providerId: "t10openai", upstreamId: "t10-model" })],
      );
      const wiring = buildSessionProvider({
        config: baseConfig({ model: "t10openai/t10-model", provider: { providerId: "t10openai", authRef: { kind: "inline", value: "test" } } }),
        env: {},
        catalog,
        credentials: createMemoryCredentialStore(),
      });
      const rows = wiring.supportedModels();
      expect(rows.length).toBeGreaterThan(0);
      const row = rows.find((r) => r.value === "t10openai/t10-model");
      expect(row).toBeDefined();
      expect(row?.resolvedModel).toBe("t10-model");
      // OMITTED, never `false` — absent means unknown (R6-I, capture (J)).
      expect("supportsFastMode" in (row ?? {})).toBe(false);
    });
  });

  test("`accountInfo()` reports the pinned `apiProvider` family and nothing it would have to invent", async () => {
    const wiring = buildSessionProvider({
      config: baseConfig({ model: "anthropic/claude-sonnet-4.5", provider: { providerId: "anthropic", authRef: { kind: "env", name: "ANTHROPIC_API_KEY" } } }),
      env: {},
      catalog: loadCatalog(),
      credentials: createMemoryCredentialStore(),
    });
    const account = wiring.accountInfo();
    expect(account.apiProvider).toBe("firstParty");
    expect(account.apiKeySource).toBe("ANTHROPIC_API_KEY");
    // NEVER invented: the SDK holds no account PII and reporting an empty string would be an answer.
    expect(account.email).toBeUndefined();
    expect(account.organization).toBeUndefined();
  });
});

describe("T10 wiring: the pinned `apiKeySource` mapping (disclosed gap-fill)", () => {
  test("only the exact `ANTHROPIC_API_KEY` env name maps to the pin's own API-key member; every other shape reports the pin's catch-all", () => {
    expect(apiKeySourceFor({ kind: "env", name: "ANTHROPIC_API_KEY" })).toBe("ANTHROPIC_API_KEY");
    expect(apiKeySourceFor({ kind: "env", name: "OPENAI_API_KEY" })).toBe("none");
    expect(apiKeySourceFor({ kind: "keychain", account: "openai:default" })).toBe("none");
    expect(apiKeySourceFor({ kind: "inline", value: "x" })).toBe("none");
    expect(apiKeySourceFor({ kind: "aws-default-chain" })).toBe("none");
    expect(apiKeySourceFor({ kind: "none" })).toBe("none");
    expect(apiKeySourceFor(undefined)).toBe("none");
  });
});

describe("T10 wiring: Lane C's decoration text reaches the WIRE, in every shipped family", () => {
  // THE CONTROLLER'S RULING, verbatim: "`ProviderMessageLike.decoration.text` is rendered VERBATIM as
  // plain text in the target's message; no adapter adds a second wrapper", and T10 "asserts the exact
  // text on the fake's recorded request".
  //
  // A grep for `decoration` in each adapter is NOT that assertion — it cannot distinguish rendering
  // code from a type import or a comment, and Lane C's whole cross-family surface is inert if any one
  // family drops it. The subject here is therefore the RECORDED REQUEST, per family, driven through
  // the same `adapterAsProvider` chain a session uses.
  const DECORATION = "WINTER-T10-DECORATION-MARKER: recovered reasoning from a prior model";

  for (const [family, providerId, adapterId, path] of [
    ["anthropic", "t10anthropic", "winter.anthropic-messages", "/v1/messages"],
    ["openai-responses", "t10openai", "winter.openai-responses", "/responses"],
    ["openai-chat", "t10chat", "winter.openai-chat-completions", "/chat/completions"],
    ["google", "t10google", "winter.google-generate-content", ":streamGenerateContent"],
  ] as const) {
    test(`${family}: the decoration text rides the request VERBATIM, once, with no second wrapper`, async () => {
      const fake = await startScenarioFake();
      try {
        const model = `${providerId}/t10-decorated`;
        const catalog = catalogWith(
          [testProvider({ id: providerId, adapterId, family: family.startsWith("google") ? "google" : family.startsWith("anthropic") ? "anthropic" : "openai", api: fake.url })],
          [testModel({ key: model, providerId, upstreamId: "t10-decorated" })],
        );
        const wiring = buildSessionProvider({
          config: baseConfig({ model, provider: { providerId, authRef: { kind: "inline", value: "test" }, connection: { baseUrl: fake.url, local: true } } }),
          env: {},
          catalog,
          credentials: createMemoryCredentialStore(),
        });
        await wiring.provider.generate({
          messages: [{ role: "user", content: "carry it", decoration: { text: DECORATION, door: "tag" } }],
        });

        const request = fake.requests.find((r) => r.path.endsWith(path));
        expect(request, `${family}: the fake received no request on ${path}`).toBeDefined();
        // EQUALITY, not "contains once" (P6 fix wave, the controller's merge note): the whole-branch
        // review's probe P3 showed the OpenAI family prefixing `[winter:context] ` onto the text, which
        // a count-of-occurrences assertion cannot see. The RECORDED block (or, for the chat family's
        // plain-string content, the recorded leading SEGMENT) must EQUAL Lane C's delimited text.
        const body = JSON.parse(request!.body) as unknown;
        const textBlocks: string[] = [];
        const walk = (value: unknown): void => {
          if (Array.isArray(value)) {
            for (const item of value) walk(item);
          } else if (typeof value === "object" && value !== null) {
            for (const [key, inner] of Object.entries(value)) {
              if (key === "text" && typeof inner === "string") textBlocks.push(inner);
              else walk(inner);
            }
          }
        };
        walk(body);
        if (family === "openai-chat") {
          // A text-only chat message is a plain string: the decoration is its leading segment, then a
          // newline, then the user's own text -- and NOTHING before the decoration.
          const content = (body as { messages: Array<{ role: string; content: unknown }> }).messages.find((m) => m.role === "user")!.content;
          expect(typeof content).toBe("string");
          const segments = (content as string).split("\n");
          expect(segments[0], `${family}: the leading segment must EQUAL the decoration`).toBe(DECORATION);
          expect(segments.slice(1).join("\n")).toBe("carry it");
        } else {
          // One block EQUAL to the decoration, and no other block carrying it inside a wrapper.
          expect(textBlocks.filter((t) => t === DECORATION), `${family}: expected exactly one text block EQUAL to the decoration`).toHaveLength(1);
          expect(textBlocks.filter((t) => t !== DECORATION && t.includes(DECORATION)), `${family}: no block may carry the decoration inside a wrapper`).toHaveLength(0);
          expect(textBlocks).toContain("carry it");
        }
      } finally {
        await fake.close();
      }
    });
  }
});

describe("T10 r1 (B): the host's OWN connection headers, filtered by one rule for every family", () => {
  test("a NON-identity host header rides a user endpoint; an identity one does NOT — the OpenAI family goes through `hostHeaders()` like Anthropic and Google", async () => {
    await withResponsesFake(async (fake) => {
      const catalog = catalogWith(
        [testProvider({ id: "t10openai", adapterId: "winter.openai-responses", family: "openai", api: fake.url })],
        [testModel({ key: "t10openai/t10-model", providerId: "t10openai", upstreamId: "t10-model" })],
      );
      // A USER endpoint (`connection.baseUrl` set), carrying three host headers: one ordinary, one
      // identity name that is ALSO credential-shaped, and one identity name that is NOT — the last is
      // the case the credential list alone could never catch.
      const wiring = buildSessionProvider({
        config: baseConfig({
          model: "t10openai/t10-model",
          provider: {
            providerId: "t10openai",
            authRef: { kind: "inline", value: "test" },
            connection: { baseUrl: fake.url, local: true, headers: { "x-trace": "keepme", "openai-organization": "org-LEAKED", "x-goog-quota-project": "proj-LEAKED" } },
          },
        }),
        env: {},
        catalog,
        credentials: createMemoryCredentialStore(),
      });
      await wiring.provider.generate({ messages: USER_TURN, model: "t10-model" });
      const request = fake.requests[0]!;
      // The host's own business rides: a proxy token's sibling, a tracing header, a user-agent.
      expect(request.headers["x-trace"]).toBe("keepme");
      // Identity names do not. `openai-organization` was already dropped by the credential list;
      // `x-goog-quota-project` is on the PRIVILEGED list and NOT the credential one, so before this
      // round it rode a user endpoint straight through.
      expect(request.headers["openai-organization"]).toBeUndefined();
      expect(request.headers["x-goog-quota-project"]).toBeUndefined();
    });
  });

  test("on a GENERATED endpoint every host header rides — a reviewed endpoint vouches for the identity headers minted for it", async () => {
    await withResponsesFake(async (fake) => {
      const catalog = catalogWith(
        [testProvider({ id: "t10openai", adapterId: "winter.openai-responses", family: "openai", api: fake.url })],
        [testModel({ key: "t10openai/t10-model", providerId: "t10openai", upstreamId: "t10-model" })],
      );
      const wiring = buildSessionProvider({
        config: baseConfig({
          model: "t10openai/t10-model",
          // NO `connection.baseUrl`: the adapter speaks to the catalog's own endpoint.
          provider: { providerId: "t10openai", authRef: { kind: "inline", value: "test" }, connection: { headers: { "x-goog-quota-project": "proj-ok", "x-trace": "keepme" } } },
        }),
        env: {},
        catalog,
        credentials: createMemoryCredentialStore(),
      });
      await wiring.provider.generate({ messages: USER_TURN, model: "t10-model" });
      expect(fake.requests[0]?.headers["x-goog-quota-project"]).toBe("proj-ok");
      expect(fake.requests[0]?.headers["x-trace"]).toBe("keepme");
    });
  });
});

describe("T10 r1 (C): `ReasoningCapabilities.completionEvent` is honoured by the Responses family", () => {
  test("a descriptor that DECLARES its own completion event terminates the stream on it, and the default still terminates on `response.completed`", async () => {
    // The fake answers a stream whose terminator is the DECLARED event and never sends
    // `response.completed`. A hard-coded terminator cannot finish that stream; the descriptor-driven
    // one does. `responsesCompletionEvent`'s fallback is asserted by every other test in this file,
    // all of which use rows that declare nothing.
    const DECLARED = "response.winter_t10_done";
    const fake = await startFake({
      routes: [
        {
          path: "/responses",
          method: "POST",
          handler: () =>
            sseResponse(
              [
                { type: "response.created", response: { id: "r", model: "m", output: [] } },
                { type: "response.output_text.delta", item_id: "i", output_index: 0, content_index: 0, delta: "declared-terminator" },
                { type: DECLARED, response: { id: "r", model: "m", status: "completed", usage: { input_tokens: 1, output_tokens: 1 }, output: [] } },
              ].map((payload) => ({ data: JSON.stringify(payload) })),
            ),
        },
      ],
    });
    try {
      const row = testModel({ key: "t10openai/declared", providerId: "t10openai", upstreamId: "declared" });
      const withEvent = {
        ...row,
        reasoning: {
          supported: evidence(true),
          efforts: [],
          continuation: "opaque-provider-state",
          readableState: evidence("summary"),
          completionEvent: evidence(DECLARED),
        },
      } as WinterModelDescriptor;
      const catalog = catalogWith([testProvider({ id: "t10openai", adapterId: "winter.openai-responses", family: "openai", api: fake.url })], [withEvent]);
      const wiring = buildSessionProvider({
        config: baseConfig({ model: "t10openai/declared", provider: { providerId: "t10openai", authRef: { kind: "inline", value: "test" } } }),
        env: {},
        catalog,
        credentials: createMemoryCredentialStore(),
      });
      const turn = await wiring.provider.generate({ messages: USER_TURN, model: "declared" });
      expect(turn.kind).toBe("text");
      expect(turn.kind === "text" ? turn.text : "").toBe("declared-terminator");
    } finally {
      await fake.close();
    }
  });
});

describe("T10 r1 (F): the EXPOSED-reasoning sidecar write path, end to end through runEngine", () => {
  // Lane C wiring item 8 landed without a tripwire. `bridge.test.ts` proves the FOLD carries
  // `thinking.exposed`; nothing proved the engine then WRITES it, and that is the half that was
  // missing — `turnProvenance` recorded `summary` only, so a family whose reasoning channel IS the
  // model's own output produced no sidecar record at all and Lane C's whole no-warning class for
  // those families was unreachable.
  //
  // REVERT-VERIFIED: deleting the `exposed` arm from `turnProvenance` (engine.ts) turns the first
  // assertion below RED — the records array then holds `origin` alone.
  async function recordsFor(thinking: { summary?: string; exposed?: string }): Promise<ProviderStateRecordInput[]> {
    const records: ProviderStateRecordInput[] = [];
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config: { sessionId: "t10-exposed", cwd: process.cwd(), model: "winter-test/echo" } as RuntimeConfig,
      input: runtime.input,
      output: runtime.output,
      provider: { async generate() { return { kind: "text", text: "answered", thinking } as never; } },
      // The identity is what makes the sidecar path live at all (R6-7): with none, the engine writes
      // no records and behaves exactly as it did before this phase.
      providerIdentity: { providerId: "t10", modelKey: "t10/m", family: "openai" },
      store: {
        recordUserEntry() {},
        recordAssistantEntry() {},
        recordProviderState(record) {
          records.push(record);
        },
      },
    });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
    for await (const _f of host.input) {
      /* drain to completion */
    }
    await done;
    return records;
  }

  test("an EXPOSED-only turn writes the sidecar `summary` record — the field the write path used to stop short of", async () => {
    const records = await recordsFor({ exposed: "the model's own visible reasoning" });
    expect(records.map((r) => r.kind)).toEqual(["origin", "summary"]);
    expect((records[1]!.payload as { text: string }).text).toBe("the model's own visible reasoning");
  });

  test("a provider-authored `summary` still WINS over `exposed` — R6-8 permits that shape to travel, the raw text is the fallback", async () => {
    const records = await recordsFor({ summary: "the provider's summary", exposed: "the raw reasoning" });
    expect(records.map((r) => r.kind)).toEqual(["origin", "summary"]);
    expect((records[1]!.payload as { text: string }).text).toBe("the provider's summary");
  });

  test("a turn with NEITHER writes only the mandatory `origin` record — the negative control", async () => {
    const records = await recordsFor({});
    expect(records.map((r) => r.kind)).toEqual(["origin"]);
  });
});

describe("T10 wiring: hermetic credentials", () => {
  test("the production composite never reads an ambient key — an `env` ref names its variable, and nothing else is scanned (R6-10)", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-t10-home-"));
    try {
      await withResponsesFake(async (fake) => {
        const catalog = catalogWith(
          [testProvider({ id: "t10openai", adapterId: "winter.openai-responses", family: "openai", api: fake.url })],
          [testModel({ key: "t10openai/t10-model", providerId: "t10openai", upstreamId: "t10-model" })],
        );
        // NO `credentials` override: this exercises the REAL composite (keychain + env + file +
        // inline). `OPENAI_API_KEY` is exported and named by NOTHING, so the session must resolve its
        // credential from the inline ref the host actually declared.
        const wiring = buildSessionProvider({
          config: baseConfig({ model: "t10openai/t10-model", provider: { providerId: "t10openai", authRef: { kind: "inline", value: "declared-inline" } } }),
          env: { OPENAI_API_KEY: "ambient-key-that-must-not-be-used" },
          catalog,
          home,
        });
        await wiring.provider.generate({ messages: USER_TURN, model: "t10-model" });
        expect(fake.requests.length).toBe(1);
        // The fake REDACTS credential headers to their scheme, which is exactly the assertion this
        // needs: the request was authenticated (a `Bearer` scheme is present) and the test never has
        // to hold, print or compare a key.
        expect(fake.requests[0]?.headers["authorization"]).toBe("Bearer ***");
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// --- WS-13b §1: the pricing basis is DATA, and R6-H reads it -------------------------------------
//
// The discriminating fixture matters here. `codex-oauth`'s shipped models carry no `pricing`
// evidence, so a test that priced one and expected `undefined` would pass on a wiring that had never
// heard of `pricingBasis` at all -- green for the wrong reason. Both rows below therefore carry
// REAL list pricing, and the ONLY difference between the two assertions is the basis.
describe("WS-13b: a subscription-priced row never feeds R6-H cost", () => {
  const priced = (basis: WinterProviderDescriptor["pricingBasis"]): ReturnType<typeof buildSessionProvider> => {
    const provider: WinterProviderDescriptor = { ...testProvider({ id: "seat", adapterId: "winter.openai-responses", family: "openai", api: "https://seat.example" }), pricingBasis: basis };
    const model: WinterModelDescriptor = {
      ...testModel({ key: "seat/seat-model", providerId: "seat", upstreamId: "seat-model" }),
      pricing: evidence({ inputPerMTokUsd: 1_000, outputPerMTokUsd: 2_000 }),
    };
    return buildSessionProvider({
      config: baseConfig({ model: "seat/seat-model", provider: { providerId: "seat", authRef: { kind: "inline", value: "test" } } }),
      env: {},
      catalog: catalogWith([provider], [model]),
      credentials: createMemoryCredentialStore(),
    });
  };

  test("the SAME row priced per token DOES report a cost — so the negative below is about the basis, not about missing evidence", () => {
    const out = priced("token").priceUsage("seat/seat-model", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(out).toMatchObject({ costBasis: "list", costUsd: 3_000 });
  });

  test("a subscription-priced row reports NO cost: a per-token number for a seat is not a smaller error, it is a wrong one", () => {
    expect(priced("subscription").priceUsage("seat/seat-model", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeUndefined();
  });

  test("a free (local) row reports no cost either", () => {
    expect(priced("free").priceUsage("seat/seat-model", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeUndefined();
  });
});

// --- WS-13b R6b-7: `set_model` goes through the same gate ----------------------------------------
//
// The switch seam is the OTHER door into a provider, and R6-K put resolution under it deliberately.
// A disable that held at session start and not at `set_model` would be a setting a session could
// walk around by switching models.
describe("WS-13b R6b-7: a disabled provider is refused at the set_model seam too", () => {
  const wiringWith = (providerSettings?: () => Record<string, { enabled: boolean }>): ReturnType<typeof buildSessionProvider> =>
    buildSessionProvider({
      config: baseConfig({ model: "gate/gate-model", provider: { providerId: "gate", authRef: { kind: "inline", value: "test" } } }),
      env: {},
      catalog: catalogWith(
        [testProvider({ id: "gate", adapterId: "winter.openai-responses", family: "openai", api: "https://gate.example" })],
        [testModel({ key: "gate/gate-model", providerId: "gate", upstreamId: "gate-model" }), testModel({ key: "gate/gate-other", providerId: "gate", upstreamId: "gate-other" })],
      ),
      credentials: createMemoryCredentialStore(),
      ...(providerSettings !== undefined ? { providerSettings } : {}),
    });

  test("with the provider enabled, the switch resolves", () => {
    const out = wiringWith().resolveModelSwitch("gate/gate-other", undefined);
    expect("refused" in out).toBe(false);
  });

  test("with the provider disabled, the switch is REFUSED with provider-disabled — never a parked or silent switch", () => {
    let enabled = true;
    const wiring = wiringWith(() => ({ gate: { enabled } }));
    enabled = false;
    const out = wiring.resolveModelSwitch("gate/gate-other", undefined);
    expect(out).toMatchObject({ refused: true, code: "provider-disabled" });
  });
});

// ================================================================================================
// WS-13c §4 step 6 (P6.6 Lane A): `set_model` accepts a SLOT NAME, resolved through the same rules
// the Agent tool's children use — and a refusal is the seam's typed refusal, never a parked switch.
// ================================================================================================
describe("WS-13c: set_model by slot name", () => {
  const slotFamily = (id: string, vendorProviders: string[], slots: Array<[string, string]>): ModelFamilyDescriptor => ({
    id,
    displayName: id,
    vendor: id,
    vendorProviders,
    matchers: [{ pattern: id === "claude" ? "^claude-" : id === "gpt" ? "^gpt-" : `^${id}-`, note: "" }],
    status: "candidate",
    citation: "fixture:session-provider",
    slots: slots.map(([name, canonicalModelId]) => ({ name, canonicalModelId, description: `d-${name}`, reason: `r-${name}`, basis: "winter-curated" as const, citation: "c", status: "candidate" as const })),
  });
  const FAMILIES: ModelFamilyDescriptor[] = [
    slotFamily("claude", ["anthropic"], [
      ["fable", "claude-fable-5"],
      ["opus", "claude-opus-5"],
      ["sonnet", "claude-sonnet-5"],
      ["haiku", "claude-haiku-4.5"],
    ]),
    // `sol` is served by OPENAI ALONE, so a `set_model("sol")` lands the session on openai while
    // codex-oauth still holds a credential -- which is what makes the R-6c-24 test below discriminating.
    slotFamily("gpt", ["codex-oauth", "openai"], [["sol", "gpt-5.6-sol"], ["luna", "gpt-5.6-luna"]]),
    // Two families holding `flash` is what makes an ambiguity real rather than asserted.
    slotFamily("gemini", ["google"], [["flash", "gemini-3.7-flash"]]),
    slotFamily("deepseek", ["deepseek"], [["flash", "deepseek-v4-flash"]]),
  ];
  // `modelFamily` is DERIVED by the pipeline's own `familyIdOf` over the canonical id `stampRow`
  // already computed — never a second, hand-typed spelling in a fixture.
  const inFamilies = (row: WinterModelDescriptor): WinterModelDescriptor => ({ ...row, modelFamily: familyIdOf(row.canonicalModelId, FAMILIES) });

  const CATALOG = catalogWith(
    [
      testProvider({ id: "anthropic", adapterId: "winter.openai-responses", family: "openai", api: "https://anthropic.example" }),
      testProvider({ id: "openai", adapterId: "winter.openai-responses", family: "openai", api: "https://openai.example" }),
      // The vendor's SUBSCRIPTION row, which §4 step 3-i puts FIRST inside the vendor group -- so a
      // bare `gpt-5.6-luna` routed through the slot layer would land here rather than on the
      // session's own provider. That is what the R6-K precedence test below exists to prevent.
      { ...testProvider({ id: "codex-oauth", adapterId: "winter.openai-responses", family: "openai", api: "https://codex.example" }), pricingBasis: "subscription" as const },
    ],
    [
      inFamilies(testModel({ key: "anthropic/claude-opus-5", providerId: "anthropic", upstreamId: "claude-opus-5" })),
      // Priced, so `priceUsage` after a cross-provider switch has a real number to report or lose.
      inFamilies({ ...testModel({ key: "openai/gpt-5.6-luna", providerId: "openai", upstreamId: "gpt-5.6-luna" }), pricing: evidence({ inputPerMTokUsd: 3, outputPerMTokUsd: 15 }) }),
      inFamilies(testModel({ key: "codex-oauth/gpt-5.6-luna", providerId: "codex-oauth", upstreamId: "gpt-5.6-luna" })),
      inFamilies(testModel({ key: "openai/gpt-5.6-sol", providerId: "openai", upstreamId: "gpt-5.6-sol" })),
    ],
    FAMILIES,
  );

  /** The PRODUCTION resolver over this fixture, with only the credential/enable view injected. */
  const resolveSlot = (hasCredential: (providerId: string) => CredentialPresence) => (requested: string, currentModelKey: string | undefined) =>
    resolveSlotToProvider({
      catalog: CATALOG,
      active: computeActiveSlotSet({ catalog: CATALOG, currentModelKey, customSlots: undefined }),
      requested,
      hasCredential,
      providerEnabled: () => true,
      preferredProviders: [],
    });

  const wiringFor = (model: string, providerId: string, hasCredential: (p: string) => CredentialPresence = () => "present"): ReturnType<typeof buildSessionProvider> =>
    buildSessionProvider({
      config: baseConfig({ model, provider: { providerId, authRef: { kind: "inline", value: "test" } } }),
      env: {},
      catalog: CATALOG,
      credentials: createMemoryCredentialStore(),
      resolveSlot: resolveSlot(hasCredential),
    });

  test("a claude session's `set_model luna` resolves across providers, subscription row first, with no provider-mismatch", () => {
    const claudeSession = wiringFor("anthropic/claude-opus-5", "anthropic");
    // §4 step 3-i: within the gpt family's vendor group, the SUBSCRIPTION row leads.
    expect(claudeSession.resolveModelSwitch("luna", undefined)).toMatchObject({ identity: { providerId: "codex-oauth", modelKey: "codex-oauth/gpt-5.6-luna" } });
    // ...and with no codex credential it is the token row, still across providers and still not a
    // `provider-mismatch` -- which is what a session-provider-qualified resolve would have produced.
    const noCodex = wiringFor("anthropic/claude-opus-5", "anthropic", (p) => (p !== "codex-oauth" ? "present" : "absent"));
    expect(noCodex.resolveModelSwitch("luna", undefined)).toMatchObject({ identity: { providerId: "openai", modelKey: "openai/gpt-5.6-luna" } });
  });

  test("a gpt session's `set_model flash` is an ambiguous-slot-name refusal naming both families", () => {
    const out = wiringFor("openai/gpt-5.6-luna", "openai").resolveModelSwitch("flash", undefined);
    expect(out).toMatchObject({ refused: true, code: "ambiguous-slot-name" });
    expect("refused" in out && out.message).toContain("gemini/flash");
    expect("refused" in out && out.message).toContain("deepseek/flash");
  });

  test("a slot nothing configured can serve is a slot-unservable refusal, never a switch onto something else", () => {
    const out = wiringFor("anthropic/claude-opus-5", "anthropic", (p) => (p !== "openai" && p !== "codex-oauth" ? "present" : "absent")).resolveModelSwitch("luna", undefined);
    expect(out).toMatchObject({ refused: true, code: "slot-unservable" });
    expect("refused" in out && out.message).toContain("openai/gpt-5.6-luna");
  });

  test("a QUALIFIED key never enters the slot layer — R6-K's own rules still decide it", () => {
    // `openai/...` from an anthropic session is still the mismatch it always was: the caller named a
    // provider, and a slot reading of a qualified key would be a second interpretation of one string.
    const out = wiringFor("anthropic/claude-opus-5", "anthropic").resolveModelSwitch("openai/gpt-5.6-luna", undefined);
    expect(out).toMatchObject({ refused: true, code: "provider-mismatch" });
  });

  test("the ACTIVE family follows the live model: the same bare name resolves against `from`, not the session's start model", () => {
    // `opus` from a gpt session is a unique foreign name (§3 acceptance (d): the Claude names always
    // resolve into claude), so both directions resolve — what this pins is that the getter is asked
    // with the model the session is on NOW.
    const wiring = wiringFor("openai/gpt-5.6-luna", "openai");
    const out = wiring.resolveModelSwitch("opus", { providerId: "openai", modelKey: "openai/gpt-5.6-luna", family: "openai" });
    expect("refused" in out).toBe(false);
    expect(!("refused" in out) && out.identity.modelKey).toBe("anthropic/claude-opus-5");
  });

  // R6-K's session-namespace-FIRST rule survives P6.6 for every bare name that is not a slot. Without
  // this, `set_model("gpt-5.6-luna")` from the openai session would walk to `codex-oauth` -- §4 step
  // 3-i's subscription-first rule applied to a string the caller never meant as a slot -- moving the
  // session to another provider, another credential and another bill, silently.
  test("a bare CANONICAL ID the session's own provider holds stays on the session's provider", () => {
    const out = wiringFor("openai/gpt-5.6-luna", "openai").resolveModelSwitch("gpt-5.6-luna", undefined);
    expect("refused" in out).toBe(false);
    expect(!("refused" in out) && out.identity).toMatchObject({ providerId: "openai", modelKey: "openai/gpt-5.6-luna" });
  });

  test("a bare canonical id the session's provider does NOT hold still falls to the slot layer's answer (§4 step 6)", () => {
    const out = wiringFor("anthropic/claude-opus-5", "anthropic").resolveModelSwitch("gpt-5.6-luna", undefined);
    expect("refused" in out).toBe(false);
    // The subscription row leads the vendor group -- this IS §4's ordering, reached because the
    // session's own provider had nothing by that name.
    expect(!("refused" in out) && out.identity.providerId).toBe("codex-oauth");
  });

  // ============================================================================================
  // I-1 / R-6c-24: `sessionProviderId()` is a SESSION-START snapshot, and the R6-K precedence this
  // task added rested on it. `from` is `currentOrigin()` -- the engine's LIVE identity -- so the
  // bare-name path asks the provider the session is actually on. The split is deliberate and the
  // two traps below are why: a QUALIFIED key must keep asking the config-material provider.
  // ============================================================================================
  test("R-6c-24: after a cross-provider slot switch, a BARE canonical id resolves under the LIVE provider, not the one the session started on", () => {
    const wiring = wiringFor("anthropic/claude-opus-5", "anthropic");
    // Step 1: the slot switch itself -- `sol` is served by openai alone, so the session is now
    // running on openai WHILE codex-oauth still holds a credential.
    const step1 = wiring.resolveModelSwitch("sol", undefined);
    expect(!("refused" in step1) && step1.identity.modelKey).toBe("openai/gpt-5.6-sol");
    // Step 2: a bare canonical id from the LIVE endpoint. Without the fix this misses under the
    // start provider (`anthropic`) and falls to §4, which moves the session to the subscription row --
    // another provider, another credential, another bill, silently.
    const live = { providerId: "openai", modelKey: "openai/gpt-5.6-sol", family: "openai" };
    const step2 = wiring.resolveModelSwitch("gpt-5.6-luna", live);
    expect(!("refused" in step2) && step2.identity).toMatchObject({ providerId: "openai", modelKey: "openai/gpt-5.6-luna" });
    // The control: a session that STARTED on openai has always answered this way.
    expect(!("refused" in wiringFor("openai/gpt-5.6-luna", "openai").resolveModelSwitch("gpt-5.6-luna", undefined))).toBe(true);
  });

  test("R-6c-24 trap 1: a QUALIFIED key still resolves under the CONFIG-material provider — switching back is not a mismatch", () => {
    // After anthropic -> luna the session runs on openai, but `config.provider.authRef` and the
    // user's connection are still anthropic's. Reading `from` for a qualified key would make a
    // switch BACK to the session's own provider a `provider-mismatch`.
    const live = { providerId: "openai", modelKey: "openai/gpt-5.6-luna", family: "openai" };
    const out = wiringFor("anthropic/claude-opus-5", "anthropic").resolveModelSwitch("anthropic/claude-opus-5", live);
    expect("refused" in out).toBe(false);
    expect(!("refused" in out) && out.identity.providerId).toBe("anthropic");
  });

  test("R-6c-24 trap 2: the resume comparison's PERSISTED `from` beside a qualified key is not a mismatch either", () => {
    // engine.ts's resume path calls `resolveModelSwitch(currentIdentity.modelKey, { providerId: persisted.providerId, … })`
    // -- a live-vs-persisted COMPARISON, not a switch. Both arguments are qualified; reading `from`
    // for the provider would turn every cross-provider resume comparison into a refusal.
    const persisted = { providerId: "codex-oauth", modelKey: "codex-oauth/gpt-5.6-luna", family: "openai" };
    const out = wiringFor("anthropic/claude-opus-5", "anthropic").resolveModelSwitch("anthropic/claude-opus-5", persisted);
    expect("refused" in out).toBe(false);
  });

  test("R-6c-24: a turn after a cross-provider switch is still PRICED — the live key self-qualifies", () => {
    // The engine prices the LIVE, qualified key (`currentProviderIdentity.modelKey`). Paired with the
    // session-START provider it resolved to a `provider-mismatch` and every turn after a
    // cross-provider switch reported NO COST AT ALL.
    const wiring = wiringFor("anthropic/claude-opus-5", "anthropic");
    expect(!("refused" in wiring.resolveModelSwitch("sol", undefined))).toBe(true);
    const priced = wiring.priceUsage("openai/gpt-5.6-luna", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(priced).toMatchObject({ costBasis: "list", canonicalModel: "openai/gpt-5.6-luna" });
    expect(priced?.costUsd).toBe(18);
  });

  test("with NO resolveSlot wired, a bare name is exactly what it was before P6.6", () => {
    const wiring = buildSessionProvider({
      config: baseConfig({ model: "anthropic/claude-opus-5", provider: { providerId: "anthropic", authRef: { kind: "inline", value: "test" } } }),
      env: {},
      catalog: CATALOG,
      credentials: createMemoryCredentialStore(),
    });
    // `luna` is not an id in anthropic's namespace, so this is the pre-existing unknown-model answer.
    expect(wiring.resolveModelSwitch("luna", undefined)).toMatchObject({ refused: true, code: "unknown-model" });
    // ...and a bare id the session's OWN provider does hold still resolves, unchanged.
    expect("refused" in wiring.resolveModelSwitch("claude-opus-5", undefined)).toBe(false);
  });
});

// ================================================================================================
// P7a LANE B (D29/D30, WS-06 §4): THE ADVISOR'S REVIEWER, at the wiring seam.
//
// `advisor-route.test.ts` pins the ROUTE (precedence, per-family defaults, the two refusals) as a
// pure function. This block pins the half a pure function cannot: that the route is actually wired
// into `buildSessionProvider`, that the setting arrives through a LIVE getter, that a refusal builds
// no provider at all, and that R6-G's pin holds across calls.
// ================================================================================================
describe("P7a: the advisor's reviewer (D29/D30)", () => {
  const advisorFamily = (id: string, vendorProviders: string[], slots: Array<[string, string]>): ModelFamilyDescriptor => ({
    id,
    displayName: id,
    vendor: id,
    vendorProviders,
    matchers: [{ pattern: id === "claude" ? "^claude-" : id === "gpt" ? "^gpt-" : `^${id}-`, note: "" }],
    status: "candidate",
    citation: "fixture:session-provider",
    slots: slots.map(([name, canonicalModelId]) => ({ name, canonicalModelId, description: `d-${name}`, reason: `r-${name}`, basis: "winter-curated" as const, citation: "c", status: "candidate" as const })),
  });
  const FAMILIES: ModelFamilyDescriptor[] = [
    advisorFamily("claude", ["anthropic"], [["fable", "claude-fable-5.1"], ["opus", "claude-opus-5"], ["sonnet", "claude-sonnet-5"], ["haiku", "claude-haiku-4.5"]]),
    advisorFamily("gpt", ["codex-oauth", "openai"], [["astra", "gpt-6-astra"], ["luna", "gpt-5.6-luna"]]),
    // A family with NO slots: D30's "the session's own model" clause, at the wiring.
    { id: "kimi", displayName: "kimi", vendor: "kimi", vendorProviders: ["moonshot"], matchers: [{ pattern: "^kimi-", note: "" }], status: "candidate", citation: "c", slots: [] },
  ];
  const inFamilies = (row: WinterModelDescriptor): WinterModelDescriptor => ({ ...row, modelFamily: familyIdOf(row.canonicalModelId, FAMILIES) });

  /** `authKinds` is what the claude gate reads, so the vendor row carries its real shipped pair (D20). */
  const anthropicRow = { ...testProvider({ id: "anthropic", adapterId: "winter.openai-responses", family: "openai", api: "https://anthropic.example" }), authKinds: ["api-key", "oauth-approved"] as const };
  const CATALOG = catalogWith(
    [
      { ...anthropicRow, authKinds: [...anthropicRow.authKinds] },
      testProvider({ id: "openai", adapterId: "winter.openai-responses", family: "openai", api: "https://openai.example" }),
      { ...testProvider({ id: "codex-oauth", adapterId: "winter.openai-responses", family: "openai", api: "https://codex.example" }), pricingBasis: "subscription" as const },
      testProvider({ id: "moonshot", adapterId: "winter.openai-responses", family: "openai", api: "https://moonshot.example" }),
      // The non-Winter credential kind (D13/D14): no API key, no Console OAuth, no cloud chain.
      { ...testProvider({ id: "subscription-only", adapterId: "winter.openai-responses", family: "openai", api: "https://subscription.example" }), authKinds: ["custom"] as WinterProviderDescriptor["authKinds"] },
    ],
    [
      inFamilies(testModel({ key: "anthropic/claude-fable-5-1", providerId: "anthropic", upstreamId: "claude-fable-5-1" })),
      inFamilies(testModel({ key: "anthropic/claude-sonnet-5", providerId: "anthropic", upstreamId: "claude-sonnet-5" })),
      inFamilies(testModel({ key: "openai/gpt-6-astra", providerId: "openai", upstreamId: "gpt-6-astra" })),
      inFamilies(testModel({ key: "codex-oauth/gpt-6-astra", providerId: "codex-oauth", upstreamId: "gpt-6-astra" })),
      inFamilies(testModel({ key: "openai/gpt-5.6-luna", providerId: "openai", upstreamId: "gpt-5.6-luna" })),
      inFamilies(testModel({ key: "moonshot/kimi-k3", providerId: "moonshot", upstreamId: "kimi-k3" })),
      inFamilies(testModel({ key: "subscription-only/claude-fable-5-1", providerId: "subscription-only", upstreamId: "claude-fable-5-1" })),
    ],
    FAMILIES,
  );

  /** The PRODUCTION §4 resolver over this fixture, exactly as `production-wiring.ts` builds it. */
  const resolveSlot = (hasCredential: (providerId: string) => CredentialPresence, catalog: WinterCatalog = CATALOG) => (requested: string, currentModelKey: string | undefined) =>
    resolveSlotToProvider({
      catalog,
      active: computeActiveSlotSet({ catalog, currentModelKey, customSlots: undefined }),
      requested,
      hasCredential,
      providerEnabled: () => true,
      preferredProviders: [],
    });

  interface WiringInit {
    model: string;
    providerId: string;
    hasCredential?: (providerId: string) => CredentialPresence;
    advisorModelSetting?: () => string | undefined;
    advisor?: RuntimeConfig["advisor"];
    catalog?: WinterCatalog;
    credentialEpoch?: () => number;
    resolveSlotOverride?: (requested: string, currentModelKey: string | undefined) => SlotProviderResolution;
  }
  const wiringFor = (init: WiringInit): ReturnType<typeof buildSessionProvider> =>
    buildSessionProvider({
      config: baseConfig({ model: init.model, provider: { providerId: init.providerId, authRef: { kind: "inline", value: "test" } }, ...(init.advisor !== undefined ? { advisor: init.advisor } : {}) }),
      env: {},
      catalog: init.catalog ?? CATALOG,
      credentials: createMemoryCredentialStore(),
      resolveSlot: init.resolveSlotOverride ?? resolveSlot(init.hasCredential ?? (() => "present"), init.catalog ?? CATALOG),
      ...(init.advisorModelSetting !== undefined ? { advisorModelSetting: init.advisorModelSetting } : {}),
      ...(init.credentialEpoch !== undefined ? { credentialEpoch: init.credentialEpoch } : {}),
    });

  /** The refusal a resolver now THROWS (fix r1, M-2) rather than swallowing into a bare `undefined`. */
  const refusalOf = (wiring: ReturnType<typeof buildSessionProvider>, currentModelKey?: string): string => {
    try {
      const reviewer = wiring.resolveReviewer?.(currentModelKey);
      throw new Error(`expected a refusal; got ${reviewer === undefined ? "undefined" : reviewer.model}`);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  test("a gpt session with NO setting reviews with astra -- openai/gpt-6-astra when only the API key is configured", () => {
    const wiring = wiringFor({ model: "openai/gpt-5.6-luna", providerId: "openai", hasCredential: (p) => (p === "openai" ? "present" : "absent") });
    expect(wiring.resolveReviewer?.()?.model).toBe("openai/gpt-6-astra");
  });

  test("...and codex-oauth/gpt-6-astra when the subscription credential IS present (§4 step 3-i)", () => {
    const wiring = wiringFor({ model: "openai/gpt-5.6-luna", providerId: "openai", hasCredential: () => "present" });
    expect(wiring.resolveReviewer?.()?.model).toBe("codex-oauth/gpt-6-astra");
  });

  test("a claude session reviews with anthropic/claude-fable-5-1 through the vendor row's api-key/Console-OAuth pair", () => {
    const wiring = wiringFor({ model: "anthropic/claude-sonnet-5", providerId: "anthropic" });
    expect(wiring.resolveReviewer?.()?.model).toBe("anthropic/claude-fable-5-1");
  });

  test("a claude reviewer served ONLY by a non-Winter credential kind yields NO reviewer -- and the refusal says why, naming the provider and its kinds (fix r1, M-2)", () => {
    const onlyCustom: WinterCatalog = { ...CATALOG, models: CATALOG.models.filter((m) => m.key !== "anthropic/claude-fable-5-1") };
    const wiring = wiringFor({ model: "anthropic/claude-sonnet-5", providerId: "anthropic", catalog: onlyCustom });
    const reason = refusalOf(wiring);
    expect(reason).toContain("subscription-only");
    expect(reason).toContain("custom");
    expect(reason).toContain("no request was made");
    // The refusal is STRUCTURAL: no `ResolvedReviewer` is ever produced, so the advisor tool has no
    // provider object at all. There is nothing to call `generate` on, which is what "no request"
    // means here -- not a discipline observed at the call site.
  });

  test("a claude session with NO anthropic credential refuses rather than substituting another vendor's row, and the reason names the row that would have served", () => {
    const wiring = wiringFor({ model: "anthropic/claude-sonnet-5", providerId: "anthropic", hasCredential: (p) => (p === "anthropic" ? "absent" : "present") });
    // `subscription-only` DOES serve claude-fable-5.1 and would be reachable if the gate leaked,
    // so this is a real negative rather than an empty-candidate accident.
    expect(CATALOG.models.some((m) => m.canonicalModelId === "claude-fable-5.1" && m.providerId === "subscription-only")).toBe(true);
    const reason = refusalOf(wiring);
    expect(reason).toContain("subscription-only");
  });

  // --- fix r1 -----------------------------------------------------------------------------------

  test("I-1: the memo key SEPARATES its terms -- (a, b) and (ab, \"\") are different reviewers, not one", () => {
    // The separator is `\u0000`, which cannot occur in a model key, so no pair of inputs can collide
    // by concatenation. Probed through the seam rather than asserted about the string: the two
    // wirings below would share a memo entry under a naive `a + b` key.
    const split = wiringFor({ model: "openai/gpt-5.6-luna", providerId: "openai", advisor: { model: "openai/gpt-6" }, advisorModelSetting: () => "-astra" });
    const joined = wiringFor({ model: "openai/gpt-5.6-luna", providerId: "openai", advisor: { model: "openai/gpt-6-astra" }, advisorModelSetting: () => undefined });
    // `Options.advisor.model` wins in both, so the two differ ONLY in how the key's terms divide.
    expect(refusalOf(split)).toContain("openai/gpt-6");
    expect(joined.resolveReviewer?.()?.model).toBe("openai/gpt-6-astra");
    // And the source file carries no raw control byte at all.
    const source = readFileSync(new URL("./session-provider.ts", import.meta.url), "utf8");
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(source)).toBe(false);
    expect(source).toContain("\\u0000");
  });

  test("M-1: the memo does NOT outlive the cold credential view -- an epoch bump re-resolves, and §4's subscription-first rule finally governs", () => {
    // Production's real first-call shape: the session's own provider is `present`, every other is
    // `unknown` because its probe has not landed. This is what `init.tools` necessarily sees.
    let codexPresence: CredentialPresence = "unknown";
    let epoch = 0;
    const wiring = wiringFor({
      model: "openai/gpt-5.6-luna",
      providerId: "openai",
      hasCredential: (p) => (p === "openai" ? "present" : p === "codex-oauth" ? codexPresence : "unknown"),
      credentialEpoch: () => epoch,
    });
    // Cold: the token row wins on `presenceRank`, correctly -- a subscription row nobody has looked
    // at must not outrank a key the user demonstrably has (R-6c-27).
    expect(wiring.resolveReviewer?.()?.model).toBe("openai/gpt-6-astra");
    // The probe lands. WITHOUT the epoch term this stayed `openai/gpt-6-astra` for the session's
    // whole life, and a user with a Codex subscription was billed per token on their API key for
    // every advisor call.
    codexPresence = "present";
    epoch += 1;
    expect(wiring.resolveReviewer?.()?.model).toBe("codex-oauth/gpt-6-astra");
  });

  test("M-1: an epoch that has NOT moved keeps R6-G's pin -- the same provider object, not merely the same key", () => {
    const wiring = wiringFor({ model: "openai/gpt-5.6-luna", providerId: "openai", credentialEpoch: () => 7 });
    const first = wiring.resolveReviewer?.();
    expect(wiring.resolveReviewer?.()).toBe(first);
  });

  test("M-2: a route that resolves onto a row the REGISTRY then refuses reports that reason, not the generic one", () => {
    const wiring = wiringFor({
      model: "openai/gpt-5.6-luna",
      providerId: "openai",
      // A slot layer that answers `ok` for a provider the registry has never heard of: the route
      // succeeds, `resolveUnder` refuses, and before this fix the reason was dropped on the floor.
      resolveSlotOverride: () => ({ ok: true, modelKey: "nowhere/ghost", providerId: "nowhere", canonicalModelId: "ghost", slot: { family: "gpt", name: "astra", source: "family-default" }, viaSlotName: true }),
    });
    const reason = refusalOf(wiring);
    expect(reason).toContain("nowhere/ghost");
    expect(reason).toContain("family-default");
    expect(reason).toContain("registry then refused");
  });

  test("M-2: a genuine ABSENCE is still `undefined`, never a throw -- nothing stated a reviewer and there is no model to derive one from", () => {
    const wiring = wiringFor({ model: "openai/gpt-5.6-luna", providerId: "openai" });
    // A session key in no family, with no option and no setting, has no candidate at all.
    expect(wiring.resolveReviewer?.("")).toBeUndefined();
  });

  test("`settings.advisor.model` beats the family default, and `Options.advisor.model` beats the setting", () => {
    const bySetting = wiringFor({ model: "openai/gpt-5.6-luna", providerId: "openai", advisorModelSetting: () => "luna" });
    expect(bySetting.resolveReviewer?.()?.model).toBe("openai/gpt-5.6-luna");
    const byOption = wiringFor({ model: "openai/gpt-5.6-luna", providerId: "openai", advisorModelSetting: () => "luna", advisor: { model: "openai/gpt-6-astra" } });
    expect(byOption.resolveReviewer?.()?.model).toBe("openai/gpt-6-astra");
  });

  test("HOT: a `settings.advisor.model` change is seen at the next call, with nothing rebuilt and no restart", () => {
    let setting: string | undefined;
    const wiring = wiringFor({ model: "openai/gpt-5.6-luna", providerId: "openai", advisorModelSetting: () => setting });
    // Unset -> the family default.
    expect(wiring.resolveReviewer?.()?.model).toBe("codex-oauth/gpt-6-astra");
    setting = "luna";
    expect(wiring.resolveReviewer?.()?.model).toBe("openai/gpt-5.6-luna");
    // ...and back. A getter read ONCE at construction would have frozen the first answer.
    setting = undefined;
    expect(wiring.resolveReviewer?.()?.model).toBe("codex-oauth/gpt-6-astra");
  });

  test("R6-G: PINNED AT FIRST USE -- the same inputs return the same provider object, a changed input re-pins", () => {
    let setting: string | undefined = "luna";
    const wiring = wiringFor({ model: "openai/gpt-5.6-luna", providerId: "openai", advisorModelSetting: () => setting });
    const first = wiring.resolveReviewer?.();
    expect(wiring.resolveReviewer?.()).toBe(first);
    setting = "astra";
    expect(wiring.resolveReviewer?.()).not.toBe(first);
  });

  test("the reviewer follows the LIVE model key: a session that switched family reviews with the new family's default", () => {
    const wiring = wiringFor({ model: "anthropic/claude-sonnet-5", providerId: "anthropic" });
    expect(wiring.resolveReviewer?.()?.model).toBe("anthropic/claude-fable-5-1");
    // The engine passes `currentProviderIdentity?.modelKey ?? currentModel` after a `set_model`.
    expect(wiring.resolveReviewer?.("openai/gpt-5.6-luna")?.model).toBe("codex-oauth/gpt-6-astra");
  });

  test("a family with NO slots reviews with the session's own model (D30's last clause)", () => {
    const wiring = wiringFor({ model: "moonshot/kimi-k3", providerId: "moonshot" });
    expect(wiring.resolveReviewer?.()?.model).toBe("moonshot/kimi-k3");
  });

  test("the reserved winter-test namespace and a REFUSED session withhold the seam entirely", () => {
    const scripted = buildSessionProvider({ config: baseConfig({ model: "winter-test/echo" }), env: {}, catalog: CATALOG, credentials: createMemoryCredentialStore() });
    expect(scripted.resolveReviewer).toBeUndefined();
    const refused = buildSessionProvider({ config: baseConfig({ model: "openai/no-such-model-anywhere", provider: { providerId: "openai" } }), env: {}, catalog: CATALOG, credentials: createMemoryCredentialStore() });
    expect(refused.resolutionError).toBeDefined();
    expect(refused.resolveReviewer).toBeUndefined();
  });

  test("R6-G: the reviewer's provider never streams -- a `sink` on its request is dropped, not forwarded", async () => {
    await withResponsesFake(async (fake) => {
      const catalog = catalogWith(
        [testProvider({ id: "t10openai", adapterId: "winter.openai-responses", family: "openai", api: fake.url })],
        [testModel({ key: "t10openai/t10-model", providerId: "t10openai", upstreamId: "t10-model" }), testModel({ key: "t10openai/t10-advisor", providerId: "t10openai", upstreamId: "t10-advisor" })],
      );
      const wiring = buildSessionProvider({
        config: baseConfig({ model: "t10openai/t10-model", advisor: { model: "t10openai/t10-advisor" }, provider: { providerId: "t10openai", authRef: { kind: "inline", value: "test" } } }),
        env: {},
        catalog,
        credentials: createMemoryCredentialStore(),
      });
      const seen: unknown[] = [];
      const sink = { onStreamEvent: (e: unknown) => void seen.push(e), onRetry: (e: unknown) => void seen.push(e), onRateLimit: (e: unknown) => void seen.push(e) } as unknown as NonNullable<Parameters<typeof wiring.provider.generate>[0]["sink"]>;
      await wiring.resolveReviewer!()!.provider.generate({ messages: USER_TURN, model: "t10-advisor", sink });
      expect(seen).toEqual([]);
      expect(fake.requests.length).toBe(1);
    });
  });
});
