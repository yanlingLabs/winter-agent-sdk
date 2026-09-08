import { describe, expect, test } from "bun:test";
import { CATALOG_VOCABULARIES, CLAUDE_RESERVED_SLOT_NAMES, loadCatalog, rowsForCanonicalId, scanForSecrets, SLOT_NAME_RE, stampFamilyFields, validateCatalog } from "./index.ts";
import catalogSchema from "../schema/catalog.schema.json" with { type: "json" };
import type { CatalogValidationError, FamilySlot, ModelFamilyDescriptor, WinterCatalog, WinterModelDescriptor, WinterProviderDescriptor } from "./types.ts";

// A minimal, VALID catalog every negative case mutates one field of. Building the negatives by
// mutation (rather than by hand-writing each broken document) is what keeps a test from passing
// because of a second, unnoticed defect in its own fixture.
function baseProvider(over: Partial<WinterProviderDescriptor> = {}): WinterProviderDescriptor {
  return {
    id: "acme",
    displayName: "Acme",
    protocols: ["openai-chat-completions"],
    authKinds: ["api-key"],
    defaultEndpoints: { api: "https://api.acme.example/v1" },
    modelDiscovery: "openai-models",
    liveCatalogAuthority: "authoritative",
    adapterId: "winter.openai-chat-completions",
    family: "openai",
    upstream: { project: "winter", commit: "", sourcePaths: [] },
    risk: { class: "approved", reasons: [] },
    scope: "llm",
    // WS-13b §1 (P6.5 spine): both fields are REQUIRED on every row, so the shared valid fixture
    // carries them — a negative case deletes or corrupts one, exactly like every other field here.
    pricingBasis: "token",
    admission: { basis: "api-key", citation: "https://vendor.example/pricing", tier: "fetched-document" },
    ...over,
  };
}

// WS-13c: the two derived family fields are stamped by the SAME `stampFamilyFields` the pipeline
// uses, never hand-typed — a fixture that spelled them itself would be a second implementation of
// the normaliser, and the first thing to drift away from the real one.
function baseModel(over: Partial<WinterModelDescriptor> = {}, families: readonly ModelFamilyDescriptor[] = []): WinterModelDescriptor {
  const row: Omit<WinterModelDescriptor, "modelFamily" | "canonicalModelId"> & { modelFamily?: string; canonicalModelId?: string } = {
    key: "acme/m1",
    providerId: "acme",
    upstreamId: "m1",
    displayName: "M1",
    aliases: [],
    endpoints: ["chat"],
    inputModalities: { value: ["text"], source: "upstream-static", confidence: "inferred" },
    outputModalities: { value: ["text"], source: "upstream-static", confidence: "inferred" },
    toolCalling: { value: "native", source: "upstream-static", confidence: "inferred" },
    nativeTools: { value: true, source: "upstream-static", confidence: "inferred" },
    unsupportedParameters: [],
    status: "candidate",
    ...over,
  };
  return stampFamilyFields([row], families)[0]!;
}

function baseCatalog(over: Partial<WinterCatalog> = {}): WinterCatalog {
  return {
    schemaVersion: 2,
    catalogVersion: "0.0.0-test",
    upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" },
    providers: [baseProvider()],
    models: [baseModel()],
    // EMPTY by default, and every pre-WS-13c case keeps it that way. `families` is required but a
    // family is not: the validator only pins the `claude` reservation when a `claude` family is
    // actually present, because the upstream layer's own standalone check and every fixture below
    // legitimately carry none.
    families: [],
    ...over,
  };
}

/**
 * A catalog WITH families — the WS-13c cases' fixture, and the only one whose model rows exist to
 * satisfy slots.
 *
 * Separate from `baseCatalog()` rather than folded into it: `slot-model-missing` makes every slot a
 * claim about the `models` array, and dozens of existing negative cases replace `models` wholesale.
 * Putting families on the shared base would have made those cases fail for a second, unrelated
 * reason — the exact defect `expectRejected`'s needle argument exists to catch.
 */
function validCatalog(): WinterCatalog {
  const slot = (name: string, canonicalModelId: string): FamilySlot => ({
    name, canonicalModelId, description: `the ${name} option`, reason: `it holds the ${name} position`, basis: "winter-curated", citation: "spec:WS-13c §9", status: "candidate",
  });
  const families: ModelFamilyDescriptor[] = [
    {
      id: "claude", displayName: "Claude", vendor: "Anthropic", vendorProviders: ["acme"],
      matchers: [{ pattern: "^claude-", note: "" }], status: "candidate", citation: "spec:WS-13c §9",
      slots: CLAUDE_RESERVED_SLOT_NAMES.map((n) => slot(n, `claude-${n}-5`)),
    },
    {
      id: "gpt", displayName: "GPT", vendor: "OpenAI", vendorProviders: ["acme"],
      matchers: [{ pattern: "^gpt-(?!oss)", note: "" }], status: "candidate", citation: "spec:WS-13c §9",
      slots: [slot("astra", "gpt-6-astra"), slot("luna", "gpt-5.6-luna")],
    },
  ];
  const models = [
    ...CLAUDE_RESERVED_SLOT_NAMES.map((n) => baseModel({ key: `acme/claude-${n}-5`, upstreamId: `claude-${n}-5`, displayName: `Claude ${n} 5` }, families)),
    baseModel({ key: "acme/gpt-6-astra", upstreamId: "gpt-6-astra", displayName: "GPT-6 Astra" }, families),
    baseModel({ key: "acme/gpt-5.6-luna", upstreamId: "gpt-5.6-luna", displayName: "GPT-5.6 Luna" }, families),
  ];
  return baseCatalog({ models, families });
}

/** Asserts the catalog is rejected AND that at least one message mentions `needle` — a rejection for the wrong reason is not a pass. */
function expectRejected(catalog: unknown, needle: string): CatalogValidationError[] {
  const result = validateCatalog(catalog);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  const hit = result.errors.some((e) => e.message.includes(needle));
  if (!hit) throw new Error(`expected an error mentioning ${JSON.stringify(needle)}; got:\n  ${result.errors.map((e) => e.message).join("\n  ")}`);
  return result.errors;
}

describe("validateCatalog — the happy path", () => {
  test("accepts a minimal valid catalog and hands back the narrowed value", () => {
    const result = validateCatalog(baseCatalog());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errors.map((e) => e.message).join("\n"));
    expect(result.catalog.providers[0]!.id).toBe("acme");
  });

  test("is TOTAL — never throws, whatever it is handed", () => {
    for (const junk of [null, undefined, 42, "catalog", [], true, Symbol.iterator]) {
      expect(() => validateCatalog(junk)).not.toThrow();
      expect(validateCatalog(junk).ok).toBe(false);
    }
    // Cyclic input: a naive recursive scan would blow the stack rather than report.
    const cyclic: Record<string, unknown> = { schemaVersion: 1 };
    cyclic["self"] = cyclic;
    expect(() => validateCatalog(cyclic)).not.toThrow();
  });
});

describe("validateCatalog — uniqueness (WS-13 §13: unique IDs/aliases/keys)", () => {
  test("rejects a duplicate provider id", () => {
    expectRejected(baseCatalog({ providers: [baseProvider(), baseProvider({ displayName: "Acme again" })] }), "duplicate provider id");
  });

  test("rejects a duplicate model key", () => {
    expectRejected(baseCatalog({ models: [baseModel(), baseModel({ displayName: "again" })] }), "duplicate model key");
  });

  test("rejects an alias that collides with another model's alias in the SAME provider", () => {
    expectRejected(
      baseCatalog({
        models: [baseModel({ aliases: ["fast"] }), baseModel({ key: "acme/m2", upstreamId: "m2", aliases: ["fast"] })],
      }),
      "already resolves inside provider",
    );
  });

  test("rejects an alias that collides with a SIBLING model's real id (one namespace per provider)", () => {
    expectRejected(
      baseCatalog({ models: [baseModel(), baseModel({ key: "acme/m2", upstreamId: "m2", aliases: ["m1"] })] }),
      "already resolves inside provider",
    );
  });

  test("ACCEPTS the same alias under two DIFFERENT providers — alias scope is per provider", () => {
    const result = validateCatalog(
      baseCatalog({
        providers: [baseProvider(), baseProvider({ id: "other" })],
        models: [baseModel({ aliases: ["fast"] }), baseModel({ key: "other/m1", providerId: "other", aliases: ["fast"] })],
      }),
    );
    expect(result.ok).toBe(true);
  });

  test("rejects a model whose providerId names no provider in the document", () => {
    expectRejected(baseCatalog({ models: [baseModel({ key: "ghost/m1", providerId: "ghost" })] }), "names no provider");
  });
});

describe("validateCatalog — closed vocabularies (WS-13 §13: unknown values FAIL)", () => {
  test("rejects an unknown protocol", () => {
    expectRejected(baseCatalog({ providers: [baseProvider({ protocols: ["openai-telepathy" as never] })] }), "unknown value");
  });

  test("rejects an unknown auth kind", () => {
    expectRejected(baseCatalog({ providers: [baseProvider({ authKinds: ["password" as never] })] }), "unknown value");
  });

  test("rejects an unknown model status", () => {
    expectRejected(baseCatalog({ models: [baseModel({ status: "shipped" as never })] }), "unknown value");
  });

  test("rejects an unknown evidence source and an unknown confidence", () => {
    expectRejected(baseCatalog({ models: [baseModel({ nativeTools: { value: true, source: "vibes" as never, confidence: "inferred" } })] }), "unknown value");
    expectRejected(baseCatalog({ models: [baseModel({ nativeTools: { value: true, source: "official-doc", confidence: "certain" as never } })] }), "unknown value");
  });

  test("rejects an unknown tool-calling state — the three-state model is closed (WS-13 §8.1)", () => {
    expectRejected(baseCatalog({ models: [baseModel({ toolCalling: { value: "maybe" as never, source: "official-doc", confidence: "declared" } })] }), "unknown tool-calling state");
  });

  test("rejects an unknown provider scope and an unknown risk class", () => {
    expectRejected(baseCatalog({ providers: [baseProvider({ scope: "telepathy" as never })] }), "unknown value");
    expectRejected(baseCatalog({ providers: [baseProvider({ risk: { class: "fine" as never, reasons: [] } })] }), "unknown value");
  });
});

describe("validateCatalog — evidence integrity", () => {
  test("rejects a missing REQUIRED capability evidence block", () => {
    const model = baseModel();
    delete (model as Partial<WinterModelDescriptor>).toolCalling;
    expectRejected(baseCatalog({ models: [model] }), "required capability evidence is missing");
  });

  test("rejects a non-ISO observedAt — evidence needs an instant, not a day", () => {
    expectRejected(baseCatalog({ models: [baseModel({ nativeTools: { value: true, source: "official-doc", confidence: "declared", observedAt: "2026-09-05" } })] }), "ISO-8601 instant");
  });

  test("rejects a defaultEffort the model's own `efforts` does not contain", () => {
    expectRejected(
      baseCatalog({
        models: [
          baseModel({
            reasoning: {
              supported: { value: true, source: "official-doc", confidence: "declared" },
              efforts: ["low", "high"],
              defaultEffort: "medium",
              continuation: "none",
            },
          }),
        ],
      }),
      "is not one of this model's own",
    );
  });

  test("rejects a non-approved risk class with no stated reason", () => {
    expectRejected(baseCatalog({ providers: [baseProvider({ risk: { class: "blocked", reasons: [] } })] }), "must record WHY");
  });
});

describe("validateCatalog — identity (WS-13 §8.3)", () => {
  test("rejects a key that does not start with its own providerId", () => {
    expectRejected(baseCatalog({ models: [baseModel({ key: "other/m1" })] }), "does not start with");
  });

  test("rejects a key whose model half is an ALIAS rather than the upstreamId", () => {
    expectRejected(baseCatalog({ models: [baseModel({ key: "acme/fast", aliases: ["fast"] })] }), "the key's model half must be the upstreamId");
  });

  test("accepts a slash-bearing upstreamId (an OpenRouter row) — the key splits on the FIRST slash", () => {
    const result = validateCatalog(
      baseCatalog({ models: [baseModel({ key: "acme/openai/gpt-4.1", upstreamId: "openai/gpt-4.1" })] }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("validateCatalog — endpoint hygiene (R6-11: generated endpoints are immutable and reviewed)", () => {
  test("rejects an endpoint that is not a parseable absolute URL", () => {
    expectRejected(baseCatalog({ providers: [baseProvider({ defaultEndpoints: { api: "/v1" } })] }), "not a parseable absolute URL");
  });

  test("rejects an endpoint carrying userinfo — a credential must never ride an endpoint", () => {
    expectRejected(baseCatalog({ providers: [baseProvider({ defaultEndpoints: { api: "https://user:pw@api.acme.example/v1" } })] }), "userinfo");
  });

  test("rejects an endpoint carrying a query string (a `?key=` surface)", () => {
    expectRejected(baseCatalog({ providers: [baseProvider({ defaultEndpoints: { api: "https://api.acme.example/v1?key=abc" } })] }), "query string");
  });

  test("ACCEPTS a loopback http:// endpoint — the twelve local providers are localhost by default", () => {
    expect(validateCatalog(baseCatalog({ providers: [baseProvider({ defaultEndpoints: { api: "http://127.0.0.1:11434/v1" } })] })).ok).toBe(true);
  });

  test("ACCEPTS an empty defaultEndpoints — Azure/Bedrock/Vertex are region/deployment-templated", () => {
    expect(validateCatalog(baseCatalog({ providers: [baseProvider({ defaultEndpoints: {} })] })).ok).toBe(true);
  });
});

// --- P7a (Lane D): the PER-TENANT rows — WS-13b §2/§10 --------------------------------------------
//
// `azure-ai` and `oci` have real, documented public APIs whose base URL is the OPERATOR'S OWN
// resource or region. The row therefore ships NO endpoint and the host supplies one; these are the
// rules that keep "ships no endpoint" from quietly becoming "ships a placeholder".
describe("WS-13b §2/§10: a `requiresUserEndpoint` row ships no endpoint and documents its shape", () => {
  const perTenant = (over: Partial<WinterProviderDescriptor> = {}): WinterProviderDescriptor =>
    baseProvider({
      requiresUserEndpoint: true,
      endpointTemplate: "https://<resource>.services.ai.example/openai/v1",
      defaultEndpoints: {},
      ...over,
    });

  test("ACCEPTS the shape the two shipped rows use: `requiresUserEndpoint: true`, a template, and an empty `defaultEndpoints`", () => {
    expect(validateCatalog(baseCatalog({ providers: [perTenant()] })).ok).toBe(true);
  });

  test("a `requiresUserEndpoint` row with NO `endpointTemplate` is refused — the refusal has nothing to name", () => {
    const row = perTenant();
    delete (row as { endpointTemplate?: string }).endpointTemplate;
    const errors = expectRejected(baseCatalog({ providers: [row] }), "required on a `requiresUserEndpoint` row");
    expect(errors.some((e) => e.code === "endpoint-template-missing")).toBe(true);
  });

  test("a BRACKETED sentinel in `defaultEndpoints.api` is refused — and NOT merely because it fails to parse", () => {
    // Two independent refusals fire on this row, which is the point: the URL check would catch this
    // one on its own, so a rule that only ever ran on unparseable strings would look correct here
    // and be wrong on the next test's row.
    const errors = expectRejected(
      baseCatalog({ providers: [perTenant({ defaultEndpoints: { api: "https://<resource>.services.ai.example/openai/v1" } })] }),
      "must ship NO `api` endpoint at all",
    );
    expect(errors.some((e) => e.code === "endpoint-sentinel")).toBe(true);
  });

  test("a PLAUSIBLE placeholder is refused too — the rule is presence, not shape (the dangerous case)", () => {
    // `https://tenant.example/v1` parses, has no userinfo, no query and an https scheme: every
    // existing endpoint-hygiene rule passes it. `connectionFrom` would then copy it into a
    // connection profile for this multi-provider adapter and the runtime would CALL it. This is the
    // case a shape-based reading of "a sentinel is refused as usable" would miss entirely.
    const catalog = baseCatalog({ providers: [perTenant({ defaultEndpoints: { api: "https://tenant.example/v1" } })] });
    const errors = expectRejected(catalog, "must ship NO `api` endpoint at all");
    expect(errors.filter((e) => e.path.startsWith("providers[0].defaultEndpoints")).map((e) => e.code)).toEqual(["endpoint-sentinel"]);
  });

  test("a NON-`api` endpoint is still allowed on a per-tenant row — only the one the runtime copies is refused", () => {
    expect(validateCatalog(baseCatalog({ providers: [perTenant({ defaultEndpoints: { console: "https://portal.example/ai" } })] })).ok).toBe(true);
  });

  test("an `endpointTemplate` WITHOUT `requiresUserEndpoint` is refused — a row that ships an endpoint has nothing to fill in", () => {
    const errors = expectRejected(
      baseCatalog({ providers: [baseProvider({ endpointTemplate: "https://<resource>.example/v1" })] }),
      "is only meaningful on a `requiresUserEndpoint` row",
    );
    expect(errors.some((e) => e.code === "endpoint-template-orphan")).toBe(true);
  });

  test("`requiresUserEndpoint: false` stays refused — absence is how a row says its endpoint is usable", () => {
    expectRejected(baseCatalog({ providers: [baseProvider({ requiresUserEndpoint: false as unknown as true })] }), "expected `true` or absence");
  });

  test("the SCHEMA carries both keys — it is `additionalProperties: false`, so a shipped row would be refused by the cross-language contract without them", () => {
    const props = (catalogSchema as unknown as { $defs: { WinterProviderDescriptor: { additionalProperties: boolean; properties: Record<string, unknown> } } }).$defs.WinterProviderDescriptor;
    expect(props.additionalProperties).toBe(false);
    expect(Object.keys(props.properties)).toContain("requiresUserEndpoint");
    expect(Object.keys(props.properties)).toContain("endpointTemplate");
    // `const: true` rather than `type: "boolean"` — the schema says the same thing the validator
    // does, that the negative is not spellable.
    expect((props.properties["requiresUserEndpoint"] as { const?: unknown }).const).toBe(true);
  });
});

describe("scanForSecrets — descriptors never contain secrets (WS-13 §6, R6-10)", () => {
  test("rejects a credential-shaped FIELD NAME regardless of its value", () => {
    for (const key of ["apiKey", "api_key", "secret", "token", "password", "privateKey", "client_secret", "authorization"]) {
      const catalog = baseCatalog();
      (catalog.providers[0] as unknown as Record<string, unknown>)[key] = "anything-at-all";
      const errors = expectRejected(catalog, "credential-shaped FIELD");
      expect(errors.some((e) => e.message.includes(key))).toBe(true);
    }
  });

  test("rejects credential-shaped VALUES wherever they hide", () => {
    const cases: Array<[string, string]> = [
      ["sk-abcdefghijklmnopqrstuvwxyz012345", "`sk-` key"],
      ["sk-ant-api03-abcdefghijklmnopqrst", "`sk-` key"],
      ["AKIAIOSFODNN7EXAMPLE", "AWS access key id"],
      ["AIzaSyA1234567890abcdefghijklmnopqrstuvw", "Google API key"],
      ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "GitHub token"],
      ["xoxb-1234567890-abcdefghij", "Slack token"],
      ["-----BEGIN RSA PRIVATE KEY-----", "PEM private key"],
      ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "JWT"],
      ["Bearer abcdefghijklmnopqrstuvwxyz0123", "Bearer credential"],
    ];
    for (const [secret] of cases) {
      // Hidden in a plain display string, not in a suspiciously-named field: the VALUE scan is what
      // has to catch this one, since the field-name check would never look at `displayName`.
      expectRejected(baseCatalog({ models: [baseModel({ displayName: `M1 ${secret}` })] }), "looks like a secret");
    }
  });

  test("does NOT flag ordinary catalog content — no false positives on the real seed's vocabulary", () => {
    expect(scanForSecrets({ id: "openai", url: "https://api.openai.com/v1", model: "gpt-4.1", note: "sk-limited" })).toEqual([]);
    expect(scanForSecrets({ key: "anthropic/claude-sonnet-5", displayName: "Claude Sonnet 5" })).toEqual([]);
    expect(scanForSecrets({ upstreamId: "anthropic.claude-3-5-sonnet-20241022-v2:0" })).toEqual([]);
  });

  test("is cycle-safe and depth-bounded", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    expect(() => scanForSecrets(cyclic)).not.toThrow();
    let deep: unknown = "leaf";
    for (let i = 0; i < 200; i++) deep = { next: deep };
    const findings = scanForSecrets(deep);
    expect(findings.some((f) => f.includes("nesting deeper than"))).toBe(true);
  });
});

describe("the COMMITTED catalog", () => {
  test("loadCatalog() resolves the bundled JSON module (never a filesystem read) and it validates", () => {
    const catalog = loadCatalog();
    expect(catalog.schemaVersion).toBe(2);
    expect(catalog.providers.length).toBeGreaterThan(0);
    expect(catalog.models.length).toBeGreaterThan(0);
  });

  test("is memoised — the second call is the identical object", () => {
    expect(loadCatalog()).toBe(loadCatalog());
  });

  test("carries no secret-shaped string anywhere (the standing catalog grep, WS-13 §13)", () => {
    expect(scanForSecrets(loadCatalog())).toEqual([]);
  });

  // RULING R6-M: this test pinned the SEED markers (`catalogVersion === "0.0.0-seed"`,
  // `upstream.commit === ""`). Lane X's extraction replaced them, so the pin is inverted rather than
  // dropped — the property worth keeping is that the markers are GONE, and gone in the exact places
  // the seed put them.
  test("is pinned to a REAL upstream extraction, in the two places the seed marked itself", () => {
    const catalog = loadCatalog();
    expect(catalog.catalogVersion).not.toBe("0.0.0-seed");
    // The composed shape is the frozen builder's `${tag}+${extractorVersion}` (scripts/
    // provider-catalog.ts), so the upstream release and the Winter extraction revision are both
    // recoverable from a shipped artifact, exactly as WS-13 §2 requires. R6-M's illustrative
    // spelling was `3.8.50-winter.1`; that literal is unreachable without editing the frozen
    // builder's separator, and `tag` must stay the REAL git tag because `fetch.ts` clones by it.
    expect(catalog.catalogVersion).toMatch(/^v?\d+\.\d+\.\d+\+winter\.\d+$/);
    expect(catalog.catalogVersion).toBe("v3.8.50+winter.1");
    // The PEELED commit, and the annotated tag's own object beside it. `6f5d4e00…` is what the
    // OmniRoute report records as "resolving to" v3.8.50 — it is the TAG OBJECT, not a commit, and
    // pinning it alone would have pinned nothing a re-tag could not move.
    expect(catalog.upstream.commit).toBe("5458026c216f77a3da68ea49152dc33470cfe2cb");
    expect(catalog.upstream.tagObject).toBe("6f5d4e00e817bc01b2ac16fdd66db3840c296416");
    expect(catalog.upstream.tagObject).not.toBe(catalog.upstream.commit);
  });

  test("carries the WS-13 §12 cohort and all twelve local ids, every local one on `local` discovery", () => {
    const byId = new Map(loadCatalog().providers.map((p) => [p.id, p]));
    for (const id of ["openai", "anthropic", "google", "openrouter", "deepseek", "codex-oauth", "azure-openai", "bedrock", "vertex"]) {
      expect(byId.has(id)).toBe(true);
    }
    const locals = [
      "docker-model-runner", "lemonade", "llama-cpp", "llamafile", "lm-studio", "mlx-gemma",
      "mlx-qwen", "ollama-local", "oobabooga", "triton", "vllm", "xinference",
    ];
    for (const id of locals) {
      const p = byId.get(id);
      expect(p).toBeDefined();
      expect(p!.modelDiscovery).toBe("local");
      expect(p!.upstream.project).toBe("winter");
    }
    expect(byId.get("codex-oauth")!.upstream.project).toBe("winter");
  });

  test("the GATEWAY's live catalog is `partial`, not `authoritative` (R6-K's pass-through depends on it)", () => {
    // A gateway routes hundreds of models that change constantly, and which of them a given key can
    // actually reach depends on upstream routing and data-policy settings the list does not express.
    // Marking it authoritative made an absent id a definitive fact, which closed the `allowUnlisted`
    // door on exactly the provider whose real ids are other vendors' qualified ids.
    const openrouter = loadCatalog().providers.find((p) => p.id === "openrouter");
    expect(openrouter?.liveCatalogAuthority).toBe("partial");
  });

  // RULING R6-M: "every row unpriced" was the SEED's disclosed gap, which Lane X closed for the
  // cohort. What replaces it is the invariant that outlives the gap — a price is either a
  // CITED PUBLISHED one or absent, never an unattributed number. `costBasis: "list"` is reachable
  // only through `official-doc` evidence (packages/provider-runtime/src/registry.ts), so a row
  // priced from an extraction or an inference would launder a guess into that assurance.
  test("no model row is `supported`; none is classifier-eligible; a priced row cites a published price", () => {
    for (const m of loadCatalog().models) {
      // `candidate` OR `experimental` — R6-16 puts the native-cloud families (Azure, Vertex,
      // Bedrock) in at `experimental`. What no row may be is `supported`: that requires the
      // behavioural corpus (WS-13 §13), and upstream presence promotes nothing.
      expect([m.key, m.status]).toEqual([m.key, m.status === "experimental" ? "experimental" : "candidate"]);
      expect(["candidate", "experimental"]).toContain(m.status);
      expect(m.classifierEligible).toBeUndefined();
      if (m.pricing === undefined) continue;
      expect([m.key, m.pricing.source]).toEqual([m.key, "official-doc"]);
      expect(m.pricing.sourceRef).toMatch(/^https:\/\//);
      expect(m.pricing.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});

// --- Minor 9: the JSON Schema is never EXECUTED anywhere in this repo (no ajv inside the fence),
// so without this test its `enum` arrays are prose that can drift away from the validator silently.
// A value one gate accepts and the other rejects produces a row that passes locally and fails in
// Lane X's generator or the Swift decoder — found by whoever is furthest from the change.
describe("JSON Schema / validator enum parity (Minor 9)", () => {
  const schema = catalogSchema as unknown as Record<string, unknown>;

  /** Walks the schema to the `enum` array at a dotted path, failing loudly if the path is wrong. */
  function enumAt(path: string): string[] {
    let node: unknown = schema;
    for (const segment of path.split(".")) {
      if (node === null || typeof node !== "object") throw new Error(`schema path ${path} broke at "${segment}"`);
      node = (node as Record<string, unknown>)[segment];
    }
    if (node === null || typeof node !== "object") throw new Error(`schema path ${path} is not an object`);
    const values = (node as { enum?: unknown }).enum;
    if (!Array.isArray(values)) throw new Error(`schema path ${path} has no \`enum\` array`);
    return values as string[];
  }

  const cases: Array<[keyof typeof CATALOG_VOCABULARIES, string]> = [
    ["protocols", "$defs.WinterProviderDescriptor.properties.protocols.items"],
    ["authKinds", "$defs.WinterProviderDescriptor.properties.authKinds.items"],
    ["evidenceSources", "$defs.EvidenceSource"],
    ["evidenceConfidences", "$defs.EvidenceConfidence"],
    ["toolCalling", "$defs.evidenceToolCalling.properties.value"],
    ["modelStatuses", "$defs.WinterModelDescriptor.properties.status"],
    ["modelEndpoints", "$defs.WinterModelDescriptor.properties.endpoints.items"],
    ["modelDiscovery", "$defs.WinterProviderDescriptor.properties.modelDiscovery"],
    ["catalogAuthority", "$defs.WinterProviderDescriptor.properties.liveCatalogAuthority"],
    ["riskClasses", "$defs.WinterProviderDescriptor.properties.risk.properties.class"],
    ["providerScopes", "$defs.WinterProviderDescriptor.properties.scope"],
    ["upstreamProjects", "$defs.WinterProviderDescriptor.properties.upstream.properties.project"],
    ["continuations", "$defs.WinterModelDescriptor.properties.reasoning.properties.continuation"],
    ["readableStates", "$defs.evidenceReadableState.properties.value"],
    ["replayScopes", "$defs.evidenceReplayScope.properties.value"],
    ["toolLoopRequirements", "$defs.evidenceToolLoopRequirement.properties.value"],
    ["pricingBases", "$defs.WinterProviderDescriptor.properties.pricingBasis"],
    ["admissionBases", "$defs.WinterProviderDescriptor.properties.admission.properties.basis"],
    ["admissionTiers", "$defs.WinterProviderDescriptor.properties.admission.properties.tier"],
    // WS-13c §2's two slot vocabularies, on the same footing as every other closed set here.
    ["slotBases", "$defs.FamilySlot.properties.basis"],
    ["slotStatuses", "$defs.FamilySlot.properties.status"],
    ["familyStatuses", "$defs.ModelFamilyDescriptor.properties.status"],
    // P7a (Lane D): the identity-header NAME allowlist. Not an `enum` on a value but on
    // `propertyNames`, which is the same closed-set claim in JSON Schema's own vocabulary for keys --
    // and it was the one closed set in this file with no parity case at all. WS-13 §5 / D21 make it
    // load-bearing: the names are what stop a row putting a VENDOR's product-identity header on the
    // wire, so the schema admitting a name the validator refuses (or the reverse) is a row that
    // passes one gate and fails the other.
    ["identityHeaderNames", "$defs.WinterProviderDescriptor.properties.identityHeaders.propertyNames"],
  ];

  test("every vocabulary the validator enforces is the SAME SET the schema declares", () => {
    for (const [name, path] of cases) {
      const fromValidator = [...CATALOG_VOCABULARIES[name]].sort();
      const fromSchema = [...enumAt(path)].sort();
      expect({ [name]: fromSchema }).toEqual({ [name]: fromValidator });
    }
  });

  test("every vocabulary is covered — a new one cannot be added without a parity case", () => {
    const covered: string[] = cases.map(([name]) => name).sort();
    expect(covered).toEqual(Object.keys(CATALOG_VOCABULARIES).sort());
  });

  // Enums are not the only cross-language surface WS-13c added. `FamilySlot.name` is the one place
  // the schema restates a GRAMMAR the validator owns, and it was a hand-copied string: a widened
  // `SLOT_NAME_RE` would have left the schema refusing names the validator accepts, discovered by
  // whoever is furthest from the change (fix r1, M-2).
  test("the schema's slot-name pattern IS `SLOT_NAME_RE`, not a hand-copy of it", () => {
    const pattern = (schema as { $defs: { FamilySlot: { properties: { name: { pattern?: string } } } } }).$defs.FamilySlot.properties.name.pattern;
    expect(pattern).toBe(SLOT_NAME_RE.source);
  });
});

// --- WS-13b §1 (D21): rows are EVIDENCE ------------------------------------------------------------
//
// P6.5 spine. Two fields no P6 row carried: `pricingBasis` (what the vendor charges for the
// credential Winter uses -- a `subscription`/`free` row must never feed R6-H token cost) and
// `admission` (the documented third-party path this row ships through, WITH the citation that
// admits it). R6b-3 makes the citation load-bearing: a row without one does not ship.
describe("WS-13b §1: rows are evidence", () => {
  const shipped = loadCatalog();

  test("every shipped provider row carries pricingBasis and an admission citation", () => {
    for (const p of shipped.providers) {
      expect(["token", "subscription", "free"]).toContain(p.pricingBasis);
      expect(p.admission.citation.length).toBeGreaterThan(0);
      expect(["api-key", "oauth-documented", "keyless-documented", "local", "cloud-credential"]).toContain(p.admission.basis);
    }
  });

  test("a row without an admission citation FAILS validation with code admission-missing", () => {
    const broken = structuredClone(shipped) as unknown as { providers: Array<{ admission: { citation: string } }> };
    broken.providers[0]!.admission.citation = "";
    const result = validateCatalog(broken);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.map((e) => e.code)).toContain("admission-missing");
  });

  test("a row with NO admission object at all fails the same way", () => {
    const broken = structuredClone(shipped) as unknown as { providers: Array<Record<string, unknown>> };
    delete broken.providers[0]!["admission"];
    const result = validateCatalog(broken);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.map((e) => e.code)).toContain("admission-missing");
  });

  test("a row with no pricingBasis fails with code pricing-basis-missing", () => {
    const broken = structuredClone(shipped) as unknown as { providers: Array<Record<string, unknown>> };
    delete broken.providers[0]!["pricingBasis"];
    const result = validateCatalog(broken);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.map((e) => e.code)).toContain("pricing-basis-missing");
  });

  test("an unknown pricingBasis is a rejection, not a passthrough", () => {
    const broken = structuredClone(shipped) as unknown as { providers: Array<Record<string, unknown>> };
    broken.providers[0]!["pricingBasis"] = "free-trial";
    expectRejected(broken, "pricingBasis");
  });

  test("an unknown admission basis is a rejection", () => {
    const broken = structuredClone(shipped) as unknown as { providers: Array<{ admission: { basis: string } }> };
    broken.providers[0]!.admission.basis = "vibes";
    expectRejected(broken, "admission.basis");
  });

  // R6b-3's second half: `unknown` is the audit's own class for "the decisive document was not
  // found". A row citing it is not a row with weak evidence — it is a row the rule says does not
  // ship, so the citation string itself is refused rather than merely noted.
  test("a citation naming the audit's `unknown` evidence class is refused with code admission-unknown", () => {
    const broken = structuredClone(shipped) as unknown as { providers: Array<{ admission: { citation: string } }> };
    broken.providers[0]!.admission.citation = "audit:unknown";
    const result = validateCatalog(broken);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.map((e) => e.code)).toContain("admission-unknown");
  });

  test("a subscription-priced row is legal and keeps its own basis", () => {
    const catalog = baseCatalog({ providers: [baseProvider({ pricingBasis: "subscription", admission: { basis: "oauth-documented", citation: "audit:5.1", tier: "audit" } })] });
    expect(validateCatalog(catalog).ok).toBe(true);
  });

  // --- fix-wave R-FW-3: the evidence TIER is data and is required ----------------------------------

  test("a row with NO admission tier is refused with code admission-tier-missing", () => {
    // The whole point of making the tier data. While it lived inside the citation string, the one
    // test that claimed to enforce it matched `^https?://` -- which a pinned-upstream citation
    // satisfies just as well as a fetched document's URL, so it enforced nothing.
    const broken = structuredClone(shipped) as unknown as { providers: Array<{ admission: { tier?: string } }> };
    delete broken.providers[0]!.admission.tier;
    const result = validateCatalog(broken);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.map((e) => e.code)).toContain("admission-tier-missing");
  });

  test("an admission tier outside the five named values is refused", () => {
    const broken = structuredClone(shipped) as unknown as { providers: Array<{ admission: { tier: string } }> };
    broken.providers[0]!.admission.tier = "probably-fine";
    expectRejected(broken, "admission.tier");
  });

  // --- fix-wave R-FW-2: `identityHeaders` is Winter-authored, both halves --------------------------

  test("an identity header the Winter allowlist does not name is refused — a row may not invent one", () => {
    // WS-13 §5 / D21: client-identity headers are never imported and Winter adapters author their
    // own. A free-text NAME field on a reviewed row would be a hole straight through that rule, so
    // the name comes from an allowlist a reviewer edits deliberately.
    const catalog = baseCatalog({ providers: [baseProvider({ identityHeaders: { "X-Editor-Client": "winter-agent-sdk/1" } })] });
    const result = validateCatalog(catalog);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.map((e) => e.code)).toContain("identity-header-invalid");
  });

  test("an identity header VALUE that does not name Winter is refused — an identity field naming another product is impersonation", () => {
    const catalog = baseCatalog({ providers: [baseProvider({ identityHeaders: { "Client-Agent": "some-editor:1.0:x@example" } })] });
    const result = validateCatalog(catalog);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.map((e) => e.code)).toContain("identity-header-invalid");
  });

  test("...and the honest form is accepted, all three placeholders and all", () => {
    // The positive leg. Without it the two refusals above would pass just as happily against a
    // validator that rejected every `identityHeaders` value, which is a different bug.
    const catalog = baseCatalog({ providers: [baseProvider({ identityHeaders: { "Client-Agent": "<product>:<version>:<contact>" } })] });
    expect(validateCatalog(catalog).ok).toBe(true);
  });

  test("P7a fix wave (item 7): a HARD-CODED product token is now refused -- only `<product>` can be true under every brand", () => {
    // Until the fix wave the literal Winter package name was accepted beside the placeholder, as
    // back-compat for "rows written before the brand profile existed". No row was ever written that
    // way, and accepting it meant a validator that calls a hard-coded product token impersonation in
    // its own error message while permitting exactly that -- which is also how the last raw brand
    // literal stayed in `provider-catalog/src`.
    const catalog = baseCatalog({ providers: [baseProvider({ identityHeaders: { "Client-Agent": "winter-agent-sdk:<version>:<contact>" } })] });
    const result = validateCatalog(catalog);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.map((e) => e.code)).toContain("identity-header-invalid");
  });

  test("P7a fix wave (item 7): the SHIPPED aihorde row carries `<contact>`, not a repository URL", () => {
    // The row is the thing the fix is about, so the shipped data is the assertion -- a fixture-only
    // test would pass just as happily against a catalog that still hard-codes Winter's issue tracker
    // in a reuser's honest-identity header.
    const shipped = loadCatalog().providers.find((p) => p.id === "aihorde");
    expect(shipped?.identityHeaders).toEqual({ "Client-Agent": "<product>:<version>:<contact>" });
  });
});

// --- WS-13c §1 (R13c-3): the family layer's own integrity, enforced by the validator ---------------
//
// Every rule below is one the CATALOG must satisfy and that nothing else can catch: the JSON Schema
// is never executed in this repo, and a reviewer reading `overlay/families.json` cannot see that a
// slot points at a model row nobody ships. The Claude reservation in particular is D25's "no false
// information" rule made mechanical — an OpenAI session must never be offered `fable`.
describe("WS-13c families (schemaVersion 2)", () => {
  test("a catalog without `families` fails with code families-missing", () => {
    const c = validCatalog(); delete (c as { families?: unknown }).families;
    const r = validateCatalog(c); expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.some((e) => e.code === "families-missing")).toBe(true);
  });
  test("the claude family must carry exactly fable, opus, sonnet, haiku in that order", () => {
    const c = validCatalog(); c.families.find((f) => f.id === "claude")!.slots.reverse();
    const r = validateCatalog(c); expect(!r.ok && r.errors.some((e) => e.code === "claude-slots-pinned")).toBe(true);
  });
  test("a reserved Claude name on another family is refused", () => {
    const c = validCatalog(); c.families.find((f) => f.id === "gpt")!.slots[0]!.name = "opus";
    const r = validateCatalog(c); expect(!r.ok && r.errors.some((e) => e.code === "slot-name-reserved")).toBe(true);
  });
  test("a slot whose canonical model has no row is refused", () => {
    const c = validCatalog(); c.families.find((f) => f.id === "gpt")!.slots[0]!.canonicalModelId = "gpt-9-nowhere";
    const r = validateCatalog(c); expect(!r.ok && r.errors.some((e) => e.code === "slot-model-missing")).toBe(true);
  });
  test("five slots, duplicate names, a bad token, a currency amount, a bad family id", () => {
    const c = validCatalog(); const gpt = c.families.find((f) => f.id === "gpt")!;
    gpt.slots = [...gpt.slots, ...gpt.slots, gpt.slots[0]!]; // 5 with duplicates
    let r = validateCatalog(c); expect(!r.ok && r.errors.some((e) => e.code === "slots-too-many")).toBe(true);
    expect(!r.ok && r.errors.some((e) => e.code === "slot-name-duplicate")).toBe(true);
    const d = validCatalog(); d.families.find((f) => f.id === "gpt")!.slots[0]!.name = "Astra"; r = validateCatalog(d); expect(!r.ok && r.errors.some((e) => e.code === "slot-name-invalid")).toBe(true);
    const e = validCatalog(); e.families.find((f) => f.id === "gpt")!.slots[0]!.description = "costs $10 per 1M"; r = validateCatalog(e); expect(!r.ok && r.errors.some((e2) => e2.code === "slot-description-currency")).toBe(true);
    const g = validCatalog(); g.families.find((f) => f.id === "gpt")!.id = "GPT"; r = validateCatalog(g); expect(!r.ok && r.errors.some((e2) => e2.code === "invalid" && e2.path.endsWith(".id"))).toBe(true);
    const h = validCatalog(); h.families.push({ ...h.families[1]!, slots: [] }); r = validateCatalog(h); expect(!r.ok && r.errors.some((e2) => e2.code === "family-id-duplicate")).toBe(true);
  });
  test("every model row carries modelFamily and canonicalModelId, and modelFamily names a family or other", () => {
    const c = validCatalog(); (c.models[0] as { modelFamily: string }).modelFamily = "nope";
    const r = validateCatalog(c); expect(!r.ok && r.errors.some((e) => e.code === "model-family-unknown")).toBe(true);
    const d = validCatalog(); delete (d.models[0] as { canonicalModelId?: string }).canonicalModelId;
    expect(validateCatalog(d).ok).toBe(false);
    const errs = validateCatalog(d); expect(!errs.ok && errs.errors.some((e) => e.code === "model-canonical-missing")).toBe(true);
  });
  test("a slot whose only rows serve neither chat nor responses is refused (fix r1 I-3: ONE predicate)", () => {
    // The validator's slot check and `rowsForCanonicalId` were two different predicates — the
    // validator asked only about `status`. A slot backed solely by an embeddings row therefore
    // VALIDATED and resolved to nothing, making "the catalog validated, so every slot has a
    // candidate row" false exactly where §4 step 1 relies on it.
    const c = validCatalog();
    for (const row of c.models) if (row.canonicalModelId === "gpt-6-astra") row.endpoints = ["embeddings"];
    const r = validateCatalog(c);
    expect(!r.ok && r.errors.some((e) => e.code === "slot-model-missing")).toBe(true);
    // ...and the two agree: the resolver sees no candidate either.
    expect(rowsForCanonicalId(c, "gpt-6-astra")).toEqual([]);
  });

  test("a slot `provider` that serves no row with that canonical id is refused", () => {
    const c = validCatalog(); c.families.find((f) => f.id === "gpt")!.slots[0]!.provider = "nobody";
    const r = validateCatalog(c); expect(!r.ok && r.errors.some((e) => e.code === "slot-provider-unserving")).toBe(true);
  });
  test("schemaVersion 1 is refused outright — the family fields are not optional", () => {
    const c = validCatalog() as unknown as { schemaVersion: number };
    c.schemaVersion = 1;
    const r = validateCatalog(c); expect(!r.ok && r.errors.some((e) => e.code === "schema-version")).toBe(true);
  });
  test("a family with NO claude entry validates — the reservation is conditional, not a presence rule", () => {
    // The upstream layer's own standalone check and every pre-WS-13c fixture carry `families: []`.
    // Requiring `claude` would have made the validator refuse the very documents this repo already
    // hands it, so the pin is "IF a claude family exists, its slots are exactly the four, in order".
    expect(validateCatalog(baseCatalog()).ok).toBe(true);
  });
});
