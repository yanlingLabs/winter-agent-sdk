import { describe, expect, test } from "bun:test";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { WinterCatalog, WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import type { ProviderAdapter } from "./types.ts";
import { WinterProviderResolutionError, createRegistry, estimateCostUsd } from "./registry.ts";

/** A do-nothing adapter: the registry only ever reads its identity fields. */
function stubAdapter(id: string, over: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    id,
    version: "0.0.1-test",
    family: "openai",
    protocol: "openai-chat-completions",
    async validateCredential() {
      return { ok: true };
    },
    async listModels() {
      return { models: [], partial: false, cached: false, warnings: [] };
    },
    // eslint-disable-next-line require-yield
    async *streamTurn() {
      throw new Error("not used");
    },
    mapEffort() {
      return { ok: true, value: undefined };
    },
    capabilities() {
      return { toolCalling: "native", readableState: "none" };
    },
    ...over,
  } as ProviderAdapter;
}

const catalog = loadCatalog();

/** Every adapter the seed catalog names, so resolution is never blocked on a missing registration. */
function fullRegistry() {
  const registry = createRegistry(catalog);
  for (const adapterId of new Set(catalog.providers.map((p) => p.adapterId))) registry.register(stubAdapter(adapterId));
  return registry;
}

function ok(result: ReturnType<ReturnType<typeof createRegistry>["resolve"]>) {
  if (result instanceof WinterProviderResolutionError) throw new Error(`expected a resolution, got ${result.code}: ${result.message}`);
  return result;
}

function failure(result: ReturnType<ReturnType<typeof createRegistry>["resolve"]>): WinterProviderResolutionError {
  if (!(result instanceof WinterProviderResolutionError)) throw new Error("expected a refusal, got a resolution");
  return result;
}

describe("createRegistry — resolution", () => {
  test("resolves a QUALIFIED key", () => {
    const resolved = ok(fullRegistry().resolve({ model: "anthropic/claude-sonnet-5" }));
    expect(resolved.providerId).toBe("anthropic");
    expect(resolved.modelKey).toBe("anthropic/claude-sonnet-5");
    expect(resolved.providerModelId).toBe("claude-sonnet-5");
    expect(resolved.descriptor?.key).toBe("anthropic/claude-sonnet-5");
    expect(resolved.catalogVersion).toBe(catalog.catalogVersion);
  });

  test("splits a qualified key on the FIRST slash — an OpenRouter model id contains slashes of its own", () => {
    const resolved = ok(fullRegistry().resolve({ model: "openrouter/openai/gpt-4.1" }));
    expect(resolved.providerId).toBe("openrouter");
    expect(resolved.providerModelId).toBe("openai/gpt-4.1");
  });

  test("resolves a BARE id against the session provider", () => {
    const resolved = ok(fullRegistry().resolve({ model: "claude-sonnet-5", provider: { providerId: "anthropic" } }));
    expect(resolved.modelKey).toBe("anthropic/claude-sonnet-5");
  });

  test("resolves an ALIAS, qualified and bare", () => {
    expect(ok(fullRegistry().resolve({ model: "anthropic/sonnet" })).modelKey).toBe("anthropic/claude-sonnet-5");
    expect(ok(fullRegistry().resolve({ model: "haiku", provider: { providerId: "anthropic" } })).modelKey).toBe("anthropic/claude-haiku-4-5-20251001");
  });

  test("a bare id with NO provider is a typed refusal, never a silent default (WS-13 §9)", () => {
    expect(failure(fullRegistry().resolve({ model: "claude-sonnet-5" })).code).toBe("no-provider-for-bare-model");
  });

  test("an unknown provider and an unknown model are distinct, typed refusals", () => {
    expect(failure(fullRegistry().resolve({ model: "nosuch/model" })).code).toBe("unknown-provider");
    expect(failure(fullRegistry().resolve({ model: "anthropic/no-such-model" })).code).toBe("unknown-model");
  });

  test("an unregistered adapter is `no-adapter`, distinct from an unknown model", () => {
    const registry = createRegistry(catalog); // nothing registered
    expect(failure(registry.resolve({ model: "anthropic/claude-sonnet-5" })).code).toBe("no-adapter");
  });

  test("`candidate` AND `experimental` rows RESOLVE — `blocked` is the only status the registry refuses", () => {
    // R6-16 puts the native-cloud families in at `experimental`, so the pin is "every non-blocked
    // row resolves" rather than "every row is candidate". `supported` stays unreachable: it requires
    // the behavioural corpus (WS-13 §13).
    for (const model of catalog.models) {
      expect([model.key, model.status]).toEqual([model.key, model.status === "experimental" ? "experimental" : "candidate"]);
      expect(ok(fullRegistry().resolve({ model: model.key })).modelKey).toBe(model.key);
    }
  });

  test("`blocked` is the ONLY status the registry refuses, and a blocked PROVIDER refuses too", () => {
    const blockedModel: WinterCatalog = {
      ...catalog,
      models: catalog.models.map((m) => (m.key === "anthropic/claude-sonnet-5" ? { ...m, status: "blocked" as const } : m)),
    };
    const r1 = createRegistry(blockedModel);
    r1.register(stubAdapter("winter.anthropic-messages"));
    expect(failure(r1.resolve({ model: "anthropic/claude-sonnet-5" })).code).toBe("blocked");

    const blockedProvider: WinterCatalog = {
      ...catalog,
      providers: catalog.providers.map((p) => (p.id === "anthropic" ? { ...p, risk: { class: "blocked" as const, reasons: ["test"] } } : p)),
    };
    const r2 = createRegistry(blockedProvider);
    r2.register(stubAdapter("winter.anthropic-messages"));
    expect(failure(r2.resolve({ model: "anthropic/claude-sonnet-5" })).code).toBe("blocked");
  });
});

describe("createRegistry — session-provider-first resolution (RULING R6-K)", () => {
  test("a slash-bearing id that IS the session provider's own model resolves to THAT provider", () => {
    // The live regression: OpenRouter's upstreamId is literally `openai/gpt-4.1`, so reading any
    // slash as a provider prefix resolved this to the OPENAI provider — a different vendor, a
    // different credential, a different bill, silently. WS-13 §9 forbids substitution outright.
    const resolved = ok(fullRegistry().resolve({ model: "openai/gpt-4.1", provider: { providerId: "openrouter" } }));
    expect(resolved.providerId).toBe("openrouter");
    expect(resolved.modelKey).toBe("openrouter/openai/gpt-4.1");
    expect(resolved.providerModelId).toBe("openai/gpt-4.1");
  });

  test("a qualified id naming ANOTHER provider is a typed provider-mismatch, never a substitution", () => {
    const err = failure(fullRegistry().resolve({ model: "openai/gpt-4.1", provider: { providerId: "anthropic" } }));
    expect(err.code).toBe("provider-mismatch");
    expect(err.message).toContain("openai");
    expect(err.message).toContain("anthropic");
  });

  test("a qualified id for the session's OWN provider still resolves", () => {
    expect(ok(fullRegistry().resolve({ model: "anthropic/claude-sonnet-5", provider: { providerId: "anthropic" } })).modelKey).toBe("anthropic/claude-sonnet-5");
    expect(ok(fullRegistry().resolve({ model: "openrouter/openai/gpt-4.1", provider: { providerId: "openrouter" } })).modelKey).toBe("openrouter/openai/gpt-4.1");
  });

  test("a SELF-QUALIFIED catalog key resolves to its CATALOGUED row, allowUnlisted or not", () => {
    // `<providerId>/<upstreamId>` is exactly what `listModelInfo` puts in a row's `value`, so it is
    // what a model picker and `set_model` hand back. When the pass-through saw it first, a
    // CATALOGUED model resolved as unlisted: `descriptor: undefined` silently discarded its
    // capability, pricing and continuation-domain evidence, the key doubled, and the doubled id
    // went on the wire. Worst for the twelve local providers, where allowUnlisted is the NORMAL
    // configuration.
    for (const allowUnlisted of [false, true]) {
      const provider = allowUnlisted ? { providerId: "openrouter", allowUnlisted: true } : { providerId: "openrouter" };
      const resolved = ok(fullRegistry().resolve({ model: "openrouter/openai/gpt-4.1", provider }));
      expect(resolved.providerId).toBe("openrouter");
      expect(resolved.modelKey).toBe("openrouter/openai/gpt-4.1");
      expect(resolved.providerModelId).toBe("openai/gpt-4.1");
      expect(resolved.descriptor).toBeDefined();
      expect(resolved.descriptor!.key).toBe("openrouter/openai/gpt-4.1");
    }
  });

  test("the same holds for a LOCAL provider, where allowUnlisted is the normal configuration", () => {
    const resolved = ok(fullRegistry().resolve({ model: "ollama-local/llama3.1:8b", provider: { providerId: "ollama-local", allowUnlisted: true } }));
    expect(resolved.modelKey).toBe("ollama-local/llama3.1:8b");
    expect(resolved.providerModelId).toBe("llama3.1:8b");
    expect(resolved.descriptor).toBeDefined();
  });

  test("an UNSEEDED id in the self-qualified spelling passes through with the prefix STRIPPED", () => {
    // The pass-through is still the right answer here — the model simply is not catalogued — but the
    // redundant self-qualification must not reach the wire or the composed key.
    const resolved = ok(fullRegistry().resolve({ model: "ollama-local/qwen3:14b", provider: { providerId: "ollama-local", allowUnlisted: true } }));
    expect(resolved.providerModelId).toBe("qwen3:14b");
    expect(resolved.modelKey).toBe("ollama-local/qwen3:14b");
    expect(resolved.descriptor).toBeUndefined();
  });

  test("GATEWAY: allowUnlisted passes an UNSEEDED vendor-qualified id through to the session provider", () => {
    // The case the ordering exists for. OpenRouter's real model ids ARE other vendors' qualified
    // ids, and the overwhelming majority will never be seeded into the compiled catalog. A session
    // that configured `{ providerId: "openrouter", allowUnlisted: true }` has ALREADY said which
    // provider it means, so passing the id through honours that statement rather than reinterpreting
    // it — reading the vendor prefix as a provider qualifier here would make the gateway unusable
    // for everything except its handful of seeded rows.
    const resolved = ok(fullRegistry().resolve({ model: "anthropic/claude-opus-5", provider: { providerId: "openrouter", allowUnlisted: true } }));
    expect(resolved.providerId).toBe("openrouter");
    expect(resolved.providerModelId).toBe("anthropic/claude-opus-5");
    expect(resolved.descriptor).toBeUndefined();
    // Same shape for a second vendor prefix, so nothing here is special-casing "anthropic".
    expect(ok(fullRegistry().resolve({ model: "mistralai/mixtral-8x22b", provider: { providerId: "openrouter", allowUnlisted: true } })).providerModelId).toBe("mistralai/mixtral-8x22b");
  });

  test("the SAME id WITHOUT allowUnlisted is a provider-mismatch — the pass-through door is what opens it", () => {
    // Namespace miss, no pass-through door, and the qualified split then names another provider.
    const err = failure(fullRegistry().resolve({ model: "anthropic/claude-opus-5", provider: { providerId: "openrouter" } }));
    expect(err.code).toBe("provider-mismatch");
    expect(err.message).toContain("openrouter");
  });

  test("an AUTHORITATIVE session provider gets no pass-through, with or without allowUnlisted", () => {
    // For OpenAI an absent id is a FACT rather than a gap (`liveCatalogAuthority: "authoritative"`),
    // so the id falls straight through to the mismatch instead of being adopted.
    expect(failure(fullRegistry().resolve({ model: "anthropic/claude-opus-5", provider: { providerId: "openai" } })).code).toBe("provider-mismatch");
    expect(failure(fullRegistry().resolve({ model: "anthropic/claude-opus-5", provider: { providerId: "openai", allowUnlisted: true } })).code).toBe("provider-mismatch");
  });

  test("an unlisted slash-bearing id whose prefix names NO provider still passes through under allowUnlisted", () => {
    const resolved = ok(fullRegistry().resolve({ model: "library/qwen3:14b", provider: { providerId: "ollama-local", allowUnlisted: true } }));
    expect(resolved.providerId).toBe("ollama-local");
    expect(resolved.providerModelId).toBe("library/qwen3:14b");
  });

  test("with NO configured provider the qualified split is unchanged, and a bare id still refuses", () => {
    expect(ok(fullRegistry().resolve({ model: "openai/gpt-4.1" })).providerId).toBe("openai");
    expect(ok(fullRegistry().resolve({ model: "openrouter/openai/gpt-4.1" })).providerId).toBe("openrouter");
    expect(failure(fullRegistry().resolve({ model: "nosuch/model" })).code).toBe("unknown-provider");
    expect(failure(fullRegistry().resolve({ model: "claude-sonnet-5" })).code).toBe("no-provider-for-bare-model");
  });

  test("an unknown SESSION provider is still unknown-provider", () => {
    expect(failure(fullRegistry().resolve({ model: "anything", provider: { providerId: "nosuch" } })).code).toBe("unknown-provider");
  });
});

describe("createRegistry — allowUnlisted (R6-F)", () => {
  test("passes an unlisted id through for a NON-authoritative provider, with NO descriptor", () => {
    const resolved = ok(fullRegistry().resolve({ model: "ollama-local/qwen3:14b", provider: { allowUnlisted: true } }));
    expect(resolved.providerModelId).toBe("qwen3:14b");
    // `descriptor: undefined` is the honest signal that nothing is known about this model — a
    // consumer must not read capabilities off a row that does not exist.
    expect(resolved.descriptor).toBeUndefined();
  });

  test("REFUSES an unlisted id for an AUTHORITATIVE provider even with allowUnlisted", () => {
    // `liveCatalogAuthority: "authoritative"` means absence is a fact, not a gap. Waving the id
    // through would defeat WS-13 §8.3's model-id validation exactly where it is most reliable.
    expect(failure(fullRegistry().resolve({ model: "openai/not-a-real-model", provider: { allowUnlisted: true } })).code).toBe("unknown-model");
  });

  test("M-5 / ruling F-4: the `anthropic` row is AUTHORITATIVE, so `allowUnlisted` buys it nothing", () => {
    // The whole-branch review's M-5: the shipped row said `liveCatalogAuthority: "unknown"`, which
    // is the PERMISSIVE direction — it opened the R6-F pass-through for a provider whose live Models
    // endpoint enumerates every model the credential can use, and the resolution-failure message
    // advertised that door in the `p6-resolution-failure` golden. The fix is DATA, not code: the
    // overlay row now carries the same evidence class the openai and google rows do.
    //
    // Asserted on the SHIPPED catalog rather than on a hand-built descriptor, because the claim is
    // about the row that actually ships — a fixture provider would have re-stated the rule against
    // itself and stayed green through the re-stamp either way.
    const registry = fullRegistry();
    expect(loadCatalog().providers.find((p) => p.id === "anthropic")?.liveCatalogAuthority).toBe("authoritative");
    for (const provider of [{ providerId: "anthropic", allowUnlisted: true }, { providerId: "anthropic" }, { allowUnlisted: true }]) {
      const err = failure(registry.resolve({ model: "anthropic/definitely-not-a-model", provider }));
      expect([JSON.stringify(provider), err.code]).toEqual([JSON.stringify(provider), "unknown-model"]);
      // And the message names the door ONLY when it is open — which for this provider it now is not.
      expect(err.message).toContain("its live catalog is authoritative, so absence is definitive");
      expect(err.message).not.toContain("allowUnlisted");
    }
    // The door is untouched where it belongs: the gateway and the local providers still have it, and
    // `azure-openai`/`codex-oauth` stay `unknown` on purpose (a user-chosen Azure deployment name is
    // never catalogued, so `allowUnlisted` is their normal configuration).
    expect(ok(registry.resolve({ model: "anthropic/claude-opus-5", provider: { providerId: "openrouter", allowUnlisted: true } })).providerId).toBe("openrouter");
    for (const id of ["azure-openai", "codex-oauth"]) {
      expect([id, loadCatalog().providers.find((p) => p.id === id)?.liveCatalogAuthority]).toEqual([id, "unknown"]);
    }
  });

  test("without allowUnlisted, an unlisted local id is still refused", () => {
    expect(failure(fullRegistry().resolve({ model: "ollama-local/qwen3:14b" })).code).toBe("unknown-model");
  });
});

describe("listModelInfo — pinned ModelInfo rows (R6-I, capture (J))", () => {
  test("emits a qualified-key row per model, plus an alias row per alias", () => {
    const rows = fullRegistry().listModelInfo("anthropic");
    const byValue = new Map(rows.map((r) => [r.value, r]));
    expect(byValue.get("anthropic/claude-sonnet-5")?.resolvedModel).toBe("claude-sonnet-5");
    // Capture (J): every pinned row is an ALIAS row — `value` the alias, `resolvedModel` the
    // canonical wire id — which is how a host matches a persisted explicit id against its alias.
    expect(byValue.get("sonnet")?.resolvedModel).toBe("claude-sonnet-5");
    expect(byValue.get("haiku")?.resolvedModel).toBe("claude-haiku-4-5-20251001");
  });

  test("`value` is the QUALIFIED key and `resolvedModel` the PROVIDER-LOCAL id", () => {
    const rows = fullRegistry().listModelInfo("openrouter");
    const row = rows.find((r) => r.value === "openrouter/openai/gpt-4.1");
    expect(row).toBeDefined();
    expect(row!.resolvedModel).toBe("openai/gpt-4.1");
  });

  test("every row carries the two REQUIRED string fields", () => {
    for (const row of fullRegistry().listModelInfo("anthropic")) {
      expect(typeof row.displayName).toBe("string");
      expect(row.displayName.length).toBeGreaterThan(0);
      expect(typeof row.description).toBe("string");
      expect(row.description.length).toBeGreaterThan(0);
    }
  });

  test("optional capability booleans are OMITTED when unknown, never `false`", () => {
    // Capture (J)'s decisive structural finding: the `haiku` row carried only value/resolvedModel/
    // displayName/description, and `supportsFastMode` was absent on the sonnet rows while present on
    // the opus ones — the omission is per-capability, and absent means UNKNOWN, not "unsupported".
    const rows = fullRegistry().listModelInfo("anthropic");
    const haiku = rows.find((r) => r.value === "anthropic/claude-haiku-4-5-20251001")!;
    // The seed's haiku row deliberately carries no `reasoning` block (capture (J) showed its
    // capability booleans ABSENT), so nothing here may claim an effort capability for it.
    expect("supportsEffort" in haiku).toBe(false);
    expect("supportedEffortLevels" in haiku).toBe(false);
    for (const row of rows) {
      for (const key of ["supportsEffort", "supportsAdaptiveThinking", "supportsFastMode", "supportsAutoMode"] as const) {
        if (key in row) expect(row[key]).not.toBe(false);
      }
    }
  });

  test("a model WITH a verified effort vocabulary reports it, narrowed to the pinned five", () => {
    const sonnet = fullRegistry().listModelInfo("anthropic").find((r) => r.value === "anthropic/claude-sonnet-5")!;
    expect(sonnet.supportsEffort).toBe(true);
    expect(sonnet.supportedEffortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("a model whose reasoning has NO named effort vocabulary claims no effort support", () => {
    // Gemini's reasoning is budget-controlled, so its `efforts` is empty. Reporting
    // `supportsEffort: true` with an empty level list would be a capability claim with no vocabulary.
    const gemini = fullRegistry().listModelInfo("google").find((r) => r.value === "google/gemini-2.5-pro")!;
    expect("supportsEffort" in gemini).toBe(false);
  });

  test("an unknown provider yields an empty list rather than throwing", () => {
    expect(fullRegistry().listModelInfo("nosuch")).toEqual([]);
  });
});

describe("estimateCostUsd (R6-H)", () => {
  const priced = (over: Partial<WinterModelDescriptor> = {}): WinterModelDescriptor => ({
    key: "acme/m1",
    providerId: "acme",
    upstreamId: "m1",
    displayName: "M1",
    aliases: [],
    endpoints: ["chat"],
    inputModalities: { value: ["text"], source: "official-doc", confidence: "verified" },
    outputModalities: { value: ["text"], source: "official-doc", confidence: "verified" },
    toolCalling: { value: "native", source: "official-doc", confidence: "verified" },
    nativeTools: { value: true, source: "official-doc", confidence: "verified" },
    pricing: { value: { inputPerMTokUsd: 3, outputPerMTokUsd: 15 }, source: "official-doc", confidence: "verified" },
    unsupportedParameters: [],
    status: "supported",
    ...over,
  });

  test("prices a turn from the descriptor's own list prices", () => {
    const result = estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 100_000 }, priced());
    expect(result.costBasis).toBe("list");
    expect(result.costUsd).toBeCloseTo(3 + 1.5, 10);
  });

  test("an UNPRICED model is 0 / \"unknown\" — never an invented number", () => {
    // The deliberate, disclosed divergence from the pin: capture (K) shows the pinned runtime
    // reporting a NON-ZERO cost for a model no price table contains, guessing at the default
    // model's rate. Winter reports the zero and says the basis is unknown.
    const unpriced = priced();
    delete (unpriced as Partial<WinterModelDescriptor>).pricing;
    expect(estimateCostUsd({ inputTokens: 5_000_000, outputTokens: 1_000_000 }, unpriced)).toEqual({ costUsd: 0, costBasis: "unknown" });
  });

  test("an ABSENT descriptor (an allowUnlisted resolution) is likewise 0 / \"unknown\"", () => {
    expect(estimateCostUsd({ inputTokens: 1000, outputTokens: 1000 }, undefined)).toEqual({ costUsd: 0, costBasis: "unknown" });
  });

  test("uses the cache rates when the descriptor has them", () => {
    const withCache = priced({
      pricing: { value: { inputPerMTokUsd: 3, outputPerMTokUsd: 15, cacheReadPerMTokUsd: 0.3, cacheWritePerMTokUsd: 3.75 }, source: "official-doc", confidence: "verified" },
    });
    const result = estimateCostUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }, withCache);
    expect(result.costUsd).toBeCloseTo(0.3 + 3.75, 10);
  });

  test("with NO cache rates, cache tokens are priced at the INPUT rate rather than free", () => {
    // Pricing them at zero would silently under-report; the input rate is the conservative reading,
    // and the basis stays "list" because a real list price was the source.
    const result = estimateCostUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }, priced());
    expect(result.costUsd).toBeCloseTo(3, 10);
    expect(result.costBasis).toBe("list");
  });

  test("an INFERRED price is 0 / \"unknown\" — `costBasis: \"list\"` is a claim about published prices", () => {
    // R6-9: "`official-doc` evidence -> costBasis: \"list\"". Returning "list" for a price extracted
    // from upstream or inferred would launder a guess into the one assurance this function exists to
    // withhold — the same reasoning that keeps invented prices out of the seed catalog.
    const inferred = priced({
      pricing: { value: { inputPerMTokUsd: 3, outputPerMTokUsd: 15 }, source: "upstream-static", confidence: "inferred" },
    });
    expect(estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, inferred)).toEqual({ costUsd: 0, costBasis: "unknown" });
  });

  // RULING R6-M: this pinned the SEED's disclosed gap ("every model unpriced"), which Lane X closed
  // for the cohort with `official-doc` prices read from the vendors' own pages. The replacement is
  // the invariant that survives it, proven END TO END through the real committed catalog rather
  // than a hand-built descriptor: a row the overlay priced reports `list`, and every other row —
  // extracted, gateway, native-cloud, subscription or local — still reports 0/`unknown`.
  test("an overlay-PRICED row reports `list`; every other row still reports 0 / `unknown`", () => {
    let pricedRows = 0;
    for (const model of catalog.models) {
      const result = estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, model);
      if (model.pricing?.source === "official-doc") {
        pricedRows++;
        expect([model.key, result.costBasis]).toEqual([model.key, "list"]);
        expect(result.costUsd).toBeGreaterThan(0);
        continue;
      }
      expect([model.key, result]).toEqual([model.key, { costUsd: 0, costBasis: "unknown" }]);
    }
    // A guard against the test passing vacuously if the overlay ever loses its prices: `maxBudgetUsd`
    // is inert for every unpriced model, so "nothing is priced" must never be silently acceptable.
    expect(pricedRows).toBeGreaterThan(0);
  });
});

describe("list()", () => {
  test("reports registered adapters and the catalog's providers", () => {
    const registry = fullRegistry();
    const listing = registry.list();
    expect(listing.catalogVersion).toBe(catalog.catalogVersion);
    expect(listing.providers.length).toBe(catalog.providers.length);
    expect(listing.adapters.length).toBeGreaterThan(0);
    // A provider with no registered adapter is reported as such rather than omitted: "you have no
    // adapter for bedrock" is actionable, "bedrock is missing" is not.
    const bare = createRegistry(catalog).list();
    expect(bare.adapters).toEqual([]);
    expect(bare.providers.every((p) => p.adapterRegistered === false)).toBe(true);
  });
});
