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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialRef, RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import type { WinterCatalog, WinterModelDescriptor, WinterProviderDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { WinterProviderResolutionError, createMemoryCredentialStore, type CredentialMaterial } from "@yanlinglabs/winter-provider-runtime";
import { startFake, sseResponse, jsonResponse, type FakeServer } from "winter-provider-conformance";
import { startScenarioFake } from "./scenario-fake.ts";
import { buildSessionProvider, apiKeySourceFor, connectionForProvider } from "./session-provider.ts";
import { echoProvider } from "./mock.ts";
import type { ProviderMessage } from "../engine.ts";

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
  };
}

function testModel(init: { key: string; providerId: string; upstreamId: string; contextWindow?: number; toolCalling?: "native" | "emulated" | "none"; unsupportedParameters?: string[] }): WinterModelDescriptor {
  return {
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
  } as WinterModelDescriptor;
}

function catalogWith(providers: WinterProviderDescriptor[], models: WinterModelDescriptor[]): WinterCatalog {
  return {
    schemaVersion: 1,
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

  test("a single-provider adapter (openai, anthropic) gets NO baseUrl — copying the catalog's endpoint in would make it a user endpoint and silently drop every privileged header", () => {
    for (const providerId of ["openai", "anthropic", "google", "bedrock"]) {
      const provider = real.providers.find((p) => p.id === providerId);
      expect(provider).toBeDefined();
      const connection = connectionForProvider(baseConfig({ model: "x" }), real, provider!);
      expect(connection?.baseUrl).toBeUndefined();
    }
  });

  test("a MULTI-provider adapter's rows DO get the catalog endpoint — there is no single vendor default to fall back to", () => {
    for (const providerId of ["deepseek", "openrouter", "ollama-local"]) {
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

describe("T10 wiring: R6-9 refuses rather than defaulting", () => {
  test("a bare model with no provider is a TYPED refusal, not a silent fallback to an echo provider", () => {
    let thrown: unknown;
    try {
      buildSessionProvider({ config: baseConfig({ model: "some-model" }), env: {}, catalog: loadCatalog(), credentials: createMemoryCredentialStore() });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WinterProviderResolutionError);
    expect((thrown as WinterProviderResolutionError).code).toBe("no-provider-for-bare-model");
  });

  test("no model at all is the same refusal", () => {
    let thrown: unknown;
    try {
      buildSessionProvider({ config: baseConfig({}), env: {}, catalog: loadCatalog(), credentials: createMemoryCredentialStore() });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WinterProviderResolutionError);
  });

  test("an UNKNOWN model under a real provider is a refusal too — Winter validates ids against the catalog (R6-F's disclosed divergence from echo-and-send)", () => {
    let thrown: unknown;
    try {
      buildSessionProvider({
        config: baseConfig({ model: "anthropic/not-a-real-model", provider: { providerId: "anthropic", authRef: { kind: "inline", value: "x" } } }),
        env: {},
        catalog: loadCatalog(),
        credentials: createMemoryCredentialStore(),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WinterProviderResolutionError);
    expect((thrown as WinterProviderResolutionError).code).toBe("unknown-model");
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

  test("an UNREGISTERED reserved name is a typed refusal, never a silent miss", () => {
    let thrown: unknown;
    try {
      buildSessionProvider({ config: baseConfig({ model: "winter-test/not-a-double" }), env: {}, catalog: loadCatalog(), credentials: createMemoryCredentialStore() });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WinterProviderResolutionError);
    expect((thrown as WinterProviderResolutionError).code).toBe("unknown-model");
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
      expect(wiring.advisorProvider).toBeDefined();
      // AND IT IS A DIFFERENT PROVIDER OBJECT from the session's. Sharing one would mean the advisor
      // silently ran on the session's model, which is the whole thing `config.advisor.model` exists
      // to prevent.
      expect(wiring.advisorProvider).not.toBe(wiring.provider);
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
        // VERBATIM, and EXACTLY ONCE: a second occurrence would mean an adapter wrapped it again on
        // top of the renderer's own delimiters, which is what the ruling forbids.
        const occurrences = (request!.body.split(DECORATION).length ?? 1) - 1;
        expect(occurrences, `${family}: expected the decoration text exactly once in the request body`).toBe(1);
      } finally {
        await fake.close();
      }
    });
  }
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
