import { describe, expect, test } from "bun:test";
import { CATALOG_VOCABULARIES, loadCatalog, scanForSecrets, validateCatalog } from "./index.ts";
import catalogSchema from "../schema/catalog.schema.json" with { type: "json" };
import type { CatalogValidationError, WinterCatalog, WinterModelDescriptor, WinterProviderDescriptor } from "./types.ts";

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

function baseModel(over: Partial<WinterModelDescriptor> = {}): WinterModelDescriptor {
  return {
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
}

function baseCatalog(over: Partial<WinterCatalog> = {}): WinterCatalog {
  return {
    schemaVersion: 1,
    catalogVersion: "0.0.0-test",
    upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" },
    providers: [baseProvider()],
    models: [baseModel()],
    ...over,
  };
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
    expect(catalog.schemaVersion).toBe(1);
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

  test("...and the honest form is accepted, `<version>` placeholder and all", () => {
    // The positive leg. Without it the two refusals above would pass just as happily against a
    // validator that rejected every `identityHeaders` value, which is a different bug.
    const catalog = baseCatalog({ providers: [baseProvider({ identityHeaders: { "Client-Agent": "winter-agent-sdk:<version>:https://github.com/yanlingLabs/winter-agent-sdk" } })] });
    expect(validateCatalog(catalog).ok).toBe(true);
  });
});
