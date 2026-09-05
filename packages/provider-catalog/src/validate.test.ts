import { describe, expect, test } from "bun:test";
import { loadCatalog, scanForSecrets, validateCatalog } from "./index.ts";
import type { WinterCatalog, WinterModelDescriptor, WinterProviderDescriptor } from "./types.ts";

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
function expectRejected(catalog: unknown, needle: string): string[] {
  const result = validateCatalog(catalog);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  const hit = result.errors.some((e) => e.includes(needle));
  if (!hit) throw new Error(`expected an error mentioning ${JSON.stringify(needle)}; got:\n  ${result.errors.join("\n  ")}`);
  return result.errors;
}

describe("validateCatalog — the happy path", () => {
  test("accepts a minimal valid catalog and hands back the narrowed value", () => {
    const result = validateCatalog(baseCatalog());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errors.join("\n"));
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
      expect(errors.some((e) => e.includes(key))).toBe(true);
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

  test("is clearly marked as a SEED in two independent, schema-required places", () => {
    const catalog = loadCatalog();
    expect(catalog.catalogVersion).toBe("0.0.0-seed");
    expect(catalog.upstream.commit).toBe("");
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

  test("every seed model row is `candidate`, unpriced, and not classifier-eligible", () => {
    for (const m of loadCatalog().models) {
      expect(m.status).toBe("candidate");
      expect(m.pricing).toBeUndefined();
      expect(m.classifierEligible).toBeUndefined();
    }
  });
});
