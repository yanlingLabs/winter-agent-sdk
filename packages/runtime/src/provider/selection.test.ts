// Phase 6 Task 3 (R6-9 / R6-13): session provider selection.
//
// Every fixture drives the REAL registry over a small hand-built catalog rather than the shipped one:
// what is under test is the RESOLUTION ORDER and the refusals, and a fixture bound to the seed
// catalog's rows would start failing for reasons that have nothing to do with either.
import { test, expect, describe } from "bun:test";
import type { ProviderAdapter } from "@yanlinglabs/winter-provider-runtime";
import { WinterProviderResolutionError, createMemoryCredentialStore } from "@yanlinglabs/winter-provider-runtime";
import type { WinterCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import { createProviderContext, createSelectionRegistry, redactCredentialRef, resolveSessionProvider, resolveStallTimeoutMs, WINTER_TEST_NAMESPACE } from "./selection.ts";
import { DEFAULT_PROVIDER_STALL_TIMEOUT_MS } from "@yanlinglabs/winter-agent-sdk";
import type { Provider } from "../engine.ts";

const adapter = (id: string, family: "openai" | "anthropic"): ProviderAdapter => ({
  id,
  version: "1.2.3",
  family,
  protocol: family === "anthropic" ? "anthropic-messages" : "openai-responses",
  async validateCredential() {
    return { ok: true };
  },
  async listModels() {
    return { models: [], partial: false, cached: false, warnings: [] };
  },
  async *streamTurn() {},
  mapEffort: () => ({ ok: true, value: "medium" }),
  capabilities: () => ({ toolCalling: "native", readableState: "none" }),
});

function catalog(): WinterCatalog {
  const evidence = <T>(value: T) => ({ value, source: "official-doc" as const, confidence: "verified" as const, observedAt: "2026-09-05" });
  const provider = (id: string, adapterId: string) => ({
    id,
    displayName: id,
    adapterId,
    protocol: adapterId === "anthropic-messages" ? ("anthropic-messages" as const) : ("openai-responses" as const),
    auth: { kinds: ["api-key" as const] },
    endpoints: { base: `https://${id}.example` },
    modelDiscovery: "static" as const,
    liveCatalogAuthority: "advisory" as const,
    risk: { class: "standard" as const, reasons: [] },
    upstream: { project: "winter", commit: "" },
  });
  const model = (key: string, providerId: string, upstreamId: string, aliases: string[], domain: string) => ({
    key,
    providerId,
    upstreamId,
    displayName: key,
    aliases,
    status: "candidate" as const,
    contextWindow: 200000,
    toolCalling: evidence("native" as const),
    reasoning: { continuation: "opaque" as const, continuationDomain: evidence([domain]), readableState: "none" as const },
    upstream: { project: "winter", commit: "" },
  });
  return {
    schemaVersion: 1,
    catalogVersion: "test-1",
    providers: [provider("openai", "openai-responses"), provider("anthropic", "anthropic-messages")],
    models: [
      model("openai/o-test", "openai", "o-test-1", ["o-test"], "openai:responses"),
      model("openai/o-big", "openai", "o-big-1", [], "openai:responses"),
      model("openai/o-other-domain", "openai", "o-other-1", [], "openai:other"),
      model("anthropic/claude-test", "anthropic", "claude-test-1", ["sonnet", "opus", "haiku", "claude-test"], "anthropic:messages"),
    ],
  } as unknown as WinterCatalog;
}

function deps(overrides: Partial<Parameters<typeof resolveSessionProvider>[1]> = {}): Parameters<typeof resolveSessionProvider>[1] {
  const registry = createSelectionRegistry(catalog());
  registry.register(adapter("openai-responses", "openai"));
  registry.register(adapter("anthropic-messages", "anthropic"));
  return { registry, credentials: createMemoryCredentialStore(), env: {}, ...overrides };
}

const config = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig => ({ sessionId: "s", cwd: "/tmp/x", model: "openai/o-test", ...overrides });

function selected(result: ReturnType<typeof resolveSessionProvider>) {
  if ("testProvider" in result) throw new Error("expected a catalog selection, got the test double");
  return result;
}

describe("resolution order", () => {
  test("a QUALIFIED key resolves against the catalog and reports the full identity", () => {
    const out = selected(resolveSessionProvider(config({ model: "openai/o-test" }), deps()));
    expect(out.identity).toEqual({
      providerId: "openai",
      modelKey: "openai/o-test",
      adapterId: "openai-responses",
      adapterVersion: "1.2.3",
      catalogVersion: "test-1",
      continuationDomain: "openai:responses",
      authRefKind: "none",
    });
    expect(out.resolved.providerModelId).toBe("o-test-1");
    expect(out.contextWindow).toBe(200000);
    expect(out.supportsToolSearch).toBe(true);
  });

  test("a BARE id resolves against `config.provider.providerId`", () => {
    const out = selected(resolveSessionProvider(config({ model: "o-test", provider: { providerId: "openai" } }), deps()));
    expect(out.identity.modelKey).toBe("openai/o-test");
  });

  test("a bare id with NO provider is a typed refusal, never a silent default", () => {
    // WS-13 §9's own rule, and the one this whole module exists to keep: no routing, no substitution.
    const err = capture(() => resolveSessionProvider(config({ model: "o-test" }), deps()));
    expect(err).toBeInstanceOf(WinterProviderResolutionError);
    expect(err.code).toBe("no-provider-for-bare-model");
  });

  test("NO model and no provider is a typed refusal too", () => {
    const err = capture(() => resolveSessionProvider(config({ model: undefined as unknown as string }), deps()));
    expect(err).toBeInstanceOf(WinterProviderResolutionError);
    expect(err.code).toBe("no-provider-for-bare-model");
  });
});

describe("the pinned Anthropic aliases", () => {
  for (const alias of ["sonnet", "opus", "haiku", "claude-test"]) {
    test(`"${alias}" resolves to the anthropic provider WHEN a credential ref for it is configured`, () => {
      const out = selected(resolveSessionProvider(config({ model: alias, provider: { providerId: "anthropic", authRef: { kind: "env", name: "SOME_KEY" } } }), deps()));
      expect(out.identity.providerId).toBe("anthropic");
      expect(out.identity.modelKey).toBe("anthropic/claude-test");
      expect(out.identity.authRefKind).toBe("env");
    });
  }

  test("an alias with NO credential ref is a typed refusal -- never silently pointed at another provider", () => {
    const err = capture(() => resolveSessionProvider(config({ model: "sonnet" }), deps()));
    expect(err).toBeInstanceOf(WinterProviderResolutionError);
    expect(err.code).toBe("no-provider-for-bare-model");
    expect(err.message).toContain("anthropic");
  });

  test("an EXPLICIT provider is never overridden by an alias", () => {
    // The host asked for a provider; an alias table is not licence to change it. Here the alias is
    // not in `openai`'s catalog, so the refusal names the real problem instead of quietly switching.
    const err = capture(() => resolveSessionProvider(config({ model: "sonnet", provider: { providerId: "openai" } }), deps()));
    expect(err).toBeInstanceOf(WinterProviderResolutionError);
    expect(err.code).toBe("unknown-model");
  });
});

describe("R6-13: the reserved winter-test namespace", () => {
  const double: Provider = { async generate() { return { kind: "text", text: "scripted" }; } };

  test("`winter-test/<name>` reaches the in-process double and NOTHING else", () => {
    const out = resolveSessionProvider(config({ model: `${WINTER_TEST_NAMESPACE}/echo` }), deps({ testProviders: (n) => (n === "echo" ? double : undefined) }));
    expect("testProvider" in out && out.testProvider).toBe(double);
  });

  test("an unregistered name in the namespace is a typed refusal, not a silent miss", () => {
    const err = capture(() => resolveSessionProvider(config({ model: `${WINTER_TEST_NAMESPACE}/absent` }), deps({ testProviders: () => undefined })));
    expect(err).toBeInstanceOf(WinterProviderResolutionError);
    expect(err.code).toBe("unknown-model");
  });

  test("the namespace is checked BEFORE the catalog, so a test double can never be shadowed by a row", () => {
    // Order matters here for a reason a later reader would otherwise have to guess at: the check is
    // also independent of every credential question, so a double works in an environment with no
    // credentials at all.
    const out = resolveSessionProvider(config({ model: `${WINTER_TEST_NAMESPACE}/echo`, provider: { providerId: "openai" } }), deps({ testProviders: () => double }));
    expect("testProvider" in out).toBe(true);
  });

  test("WINTER_TEST_PROVIDER is honoured ONLY when config.model is absent or already in the namespace", () => {
    const env = { WINTER_TEST_PROVIDER: "echo" };
    const withDouble = deps({ env, testProviders: () => double });

    // Absent model -> the env alias applies.
    expect("testProvider" in resolveSessionProvider(config({ model: undefined as unknown as string }), withDouble)).toBe(true);
    // Already in the namespace -> applies.
    expect("testProvider" in resolveSessionProvider(config({ model: `${WINTER_TEST_NAMESPACE}/other` }), withDouble)).toBe(true);
    // A REAL configured model wins: a harness variable left in an environment can never silently
    // redirect a session away from the model its caller asked for.
    const out = resolveSessionProvider(config({ model: "openai/o-test" }), deps({ env, testProviders: () => double }));
    expect("testProvider" in out).toBe(false);
  });
});

describe("R6-9: fallbackModel", () => {
  test("a comma-separated list resolves in order", () => {
    const out = selected(resolveSessionProvider(config({ model: "openai/o-test", fallbackModel: "openai/o-big, openai/o-test" }), deps()));
    expect(out.fallbackModels.map((m) => m.modelKey)).toEqual(["openai/o-big", "openai/o-test"]);
  });

  test("a candidate on ANOTHER PROVIDER is a typed error AT INIT", () => {
    // At init rather than at the moment of the swap: a session discovers its fallback is unusable
    // when it is configured, not while it is already failing over.
    const err = capture(() =>
      resolveSessionProvider(config({ model: "openai/o-test", fallbackModel: "anthropic/claude-test", provider: { providerId: "openai" } }), deps()),
    );
    expect(err).toBeInstanceOf(WinterProviderResolutionError);
    expect(err.message).toContain("may not change providers");
  });

  test("a candidate in ANOTHER CONTINUATION DOMAIN is a typed error AT INIT", () => {
    const err = capture(() => resolveSessionProvider(config({ model: "openai/o-test", fallbackModel: "openai/o-other-domain" }), deps()));
    expect(err).toBeInstanceOf(WinterProviderResolutionError);
    expect(err.message).toContain("continuation domain");
  });

  test("no fallbackModel is an empty list, never a fabricated candidate", () => {
    expect(selected(resolveSessionProvider(config(), deps())).fallbackModels).toEqual([]);
  });
});

describe("R6-10: inline credentials are redacted everywhere", () => {
  test("an inline value never appears in a rendered ref", () => {
    const secret = "sk-inline-should-never-appear";
    expect(redactCredentialRef({ kind: "inline", value: secret })).toBe("inline(***)");
    expect(redactCredentialRef({ kind: "inline", value: secret })).not.toContain(secret);
  });

  test("a locator IS reproduced for every other kind -- a locator is what makes a credential problem diagnosable", () => {
    expect(redactCredentialRef({ kind: "keychain", account: "openai:work" })).toBe("keychain(default:openai:work)");
    expect(redactCredentialRef({ kind: "env", name: "OPENAI_KEY" })).toBe("env(OPENAI_KEY)");
    expect(redactCredentialRef({ kind: "file", path: "/tmp/creds", format: "raw" })).toContain("/tmp/creds");
    expect(redactCredentialRef({ kind: "aws-default-chain" })).toBe("aws-default-chain");
    expect(redactCredentialRef({ kind: "none" })).toBe("none");
  });

  test("an inline ref selects normally and reports only its KIND on the identity", () => {
    const secret = "sk-inline-should-never-appear";
    const out = selected(resolveSessionProvider(config({ provider: { providerId: "openai", authRef: { kind: "inline", value: secret } } }), deps()));
    expect(out.identity.authRefKind).toBe("inline");
    expect(JSON.stringify(out.identity)).not.toContain(secret);
  });
});

describe("the default provider factory refuses rather than half-working", () => {
  test("without `buildProvider`, generating reports which seam is missing", async () => {
    const out = selected(resolveSessionProvider(config(), deps()));
    const err = (await out.provider.generate({ messages: [] }).catch((e: unknown) => e)) as WinterProviderResolutionError;
    expect(err).toBeInstanceOf(WinterProviderResolutionError);
    expect(err.message).toContain("buildProvider");
  });

  test("with one, the resolved model is what it is handed", () => {
    let seen = "";
    const out = selected(
      resolveSessionProvider(config(), deps({ buildProvider: (r) => { seen = r.modelKey; return { async generate() { return { kind: "text", text: "" }; } }; } })),
    );
    expect(seen).toBe("openai/o-test");
    expect(out.provider).toBeDefined();
  });
});

function capture(fn: () => unknown): WinterProviderResolutionError {
  try {
    fn();
  } catch (err) {
    return err as WinterProviderResolutionError;
  }
  throw new Error("expected a throw");
}

describe("R6-6: the stall timeout", () => {
  test("the disclosed default applies when nothing is configured", () => {
    expect(resolveStallTimeoutMs(config())).toBe(DEFAULT_PROVIDER_STALL_TIMEOUT_MS);
    expect(DEFAULT_PROVIDER_STALL_TIMEOUT_MS).toBe(120000);
  });

  test("a configured value wins, and a non-positive one is IGNORED rather than honoured", () => {
    // `0` would mean "abort immediately", which is never what a host configuring a watchdog intends
    // -- the same reading `createContextAccountant` already applies to a non-positive window.
    expect(resolveStallTimeoutMs(config({ providerStallTimeoutMs: 5000 }))).toBe(5000);
    expect(resolveStallTimeoutMs(config({ providerStallTimeoutMs: 0 }))).toBe(DEFAULT_PROVIDER_STALL_TIMEOUT_MS);
    expect(resolveStallTimeoutMs(config({ providerStallTimeoutMs: -1 }))).toBe(DEFAULT_PROVIDER_STALL_TIMEOUT_MS);
  });
});

describe("M1: createProviderContext is the stall timeout's production caller", () => {
  test("the context an adapter runs under CARRIES the resolved stall timeout", () => {
    // `sse.ts` reads `ctx.stallTimeoutMs` on every chunk, so a context assembled without it silently
    // disables R6-6's watchdog on every stream -- a disclosed option that quietly does nothing.
    const credentials = createMemoryCredentialStore();
    expect(createProviderContext(config(), { providerId: "openai", credentials }).stallTimeoutMs).toBe(DEFAULT_PROVIDER_STALL_TIMEOUT_MS);
    expect(createProviderContext(config({ providerStallTimeoutMs: 7500 }), { providerId: "openai", credentials }).stallTimeoutMs).toBe(7500);
  });

  test("the connection profile is threaded from config, and an absent field is OMITTED", () => {
    const ctx = createProviderContext(config({ provider: { providerId: "openai", connection: { baseUrl: "http://127.0.0.1:11434", local: true } } }), {
      providerId: "openai",
      credentials: createMemoryCredentialStore(),
    });
    expect(ctx.connection).toEqual({ providerId: "openai", baseUrl: "http://127.0.0.1:11434", local: true });
    expect("region" in ctx.connection).toBe(false);
  });

  test("an unnamed credential is `none`, never an ambient key", () => {
    // R6-10: ambient env keys are NEVER scanned implicitly. A host that named no ref has not
    // authenticated this provider, and an adapter gets a typed refusal rather than a key nobody chose.
    expect(createProviderContext(config(), { providerId: "openai", credentials: createMemoryCredentialStore() }).authRef).toEqual({ kind: "none" });
    expect(createProviderContext(config({ provider: { providerId: "openai", authRef: { kind: "env", name: "K" } } }), { providerId: "openai", credentials: createMemoryCredentialStore() }).authRef).toEqual({
      kind: "env",
      name: "K",
    });
  });

  test("`log` defaults to a NO-OP -- a default that wrote anywhere is a default a careless adapter turns into a leak", () => {
    const ctx = createProviderContext(config(), { providerId: "openai", credentials: createMemoryCredentialStore() });
    expect(() => ctx.log({ kind: "request", providerId: "openai", bytes: 10 })).not.toThrow();
  });
});
