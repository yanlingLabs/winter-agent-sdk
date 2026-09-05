import { describe, expect, test } from "bun:test";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { DiscoveryContext, ModelCatalogResult, ProviderAdapter } from "./types.ts";
import { createMemoryCredentialStore } from "./credentials/memory.ts";
import { createDiscoveryCache, discoverModels } from "./discovery.ts";

function ctx(over: Partial<DiscoveryContext> = {}): DiscoveryContext {
  return {
    connection: { providerId: "acme" },
    credentials: createMemoryCredentialStore(),
    authRef: { kind: "none" },
    stallTimeoutMs: 1000,
    log: () => {},
    limits: { maxBytes: 65_536, maxItems: 50, timeoutMs: 500 },
    ...over,
  };
}

function adapterReturning(result: ModelCatalogResult | ((ctx?: DiscoveryContext) => Promise<ModelCatalogResult>)): ProviderAdapter {
  return {
    id: "winter.test",
    version: "0.0.1",
    family: "openai",
    protocol: "openai-chat-completions",
    async validateCredential() {
      return { ok: true };
    },
    listModels: typeof result === "function" ? ((c: DiscoveryContext) => result(c)) : async () => result,
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
  } as ProviderAdapter;
}

const clean = (models: ModelCatalogResult["models"]): ModelCatalogResult => ({ models, partial: false, cached: false, warnings: [] });

describe("discoverModels — bounds", () => {
  test("passes a small, well-formed catalog straight through", async () => {
    const result = await discoverModels(adapterReturning(clean([{ id: "a" }, { id: "b", displayName: "B" }])), ctx());
    expect(result.models.map((m) => m.id)).toEqual(["a", "b"]);
    expect(result.partial).toBe(false);
    expect(result.cached).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  test("truncates at maxItems and says so, both in `partial` and in a warning", async () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ id: `m${i}` }));
    const result = await discoverModels(adapterReturning(clean(many)), ctx({ limits: { maxBytes: 65_536, maxItems: 10, timeoutMs: 500 } }));
    expect(result.models).toHaveLength(10);
    expect(result.partial).toBe(true);
    expect(result.warnings.join(" ")).toContain("10");
  });

  test("times out rather than waiting on a provider that never answers", async () => {
    const slow = adapterReturning(async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return clean([{ id: "never" }]);
    });
    const err = await discoverModels(slow, ctx({ limits: { maxBytes: 1024, maxItems: 10, timeoutMs: 60 } })).then(() => undefined, (e: unknown) => e);
    expect((err as { code?: string }).code).toBe("timeout");
  });

  test("an already-aborted signal refuses before calling the adapter at all", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const adapter = adapterReturning(async () => {
      called = true;
      return clean([]);
    });
    await expect(discoverModels(adapter, ctx({ signal: controller.signal }))).rejects.toBeDefined();
    expect(called).toBe(false);
  });

  test("the timeout CANCELS the adapter rather than leaving it running in the background", async () => {
    // Racing a timer against a bare promise stops the waiting, not the work: the request keeps a
    // socket and a body alive after this function has already reported a timeout.
    let observed: AbortSignal | undefined;
    const slow = adapterReturning(async (c?: DiscoveryContext) => {
      observed = c?.signal;
      await new Promise((r) => setTimeout(r, 5000));
      return clean([{ id: "never" }]);
    });
    await expect(discoverModels(slow, ctx({ limits: { maxBytes: 1024, maxItems: 10, timeoutMs: 60 } }))).rejects.toBeDefined();
    expect(observed).toBeDefined();
    expect(observed!.aborted).toBe(true);
  });

  test("a caller's abort mid-flight also reaches the adapter", async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const slow = adapterReturning(async (c?: DiscoveryContext) => {
      observed = c?.signal;
      await new Promise((r) => setTimeout(r, 5000));
      return clean([]);
    });
    setTimeout(() => controller.abort(), 30);
    await expect(
      discoverModels(slow, ctx({ signal: controller.signal, limits: { maxBytes: 1024, maxItems: 10, timeoutMs: 400 } })),
    ).rejects.toBeDefined();
    expect(observed!.aborted).toBe(true);
  });
});

describe("discoverModels — untrusted input (WS-13 §7: model ids are untrusted display data)", () => {
  test("drops malformed rows and reports each as a warning rather than failing the whole call", async () => {
    const dirty = {
      models: [
        { id: "good" },
        { id: "" },
        { id: "   " },
        { id: 42 as unknown as string },
        { notAnId: true } as unknown as { id: string },
        null as unknown as { id: string },
        { id: "also-good" },
      ],
      partial: false,
      cached: false,
      warnings: [],
    };
    const result = await discoverModels(adapterReturning(dirty), ctx());
    expect(result.models.map((m) => m.id)).toEqual(["good", "also-good"]);
    // ONE warning carrying the count — five rows were dropped. A per-drop warning list is unbounded
    // and is retained in the cached result, so a provider returning ten thousand bad rows would
    // carry ten thousand identical strings forward on every cache fallback.
    const drops = result.warnings.filter((w) => w.includes("with no usable id"));
    expect(drops).toHaveLength(1);
    expect(drops[0]).toContain("5");
  });

  test("drops an id carrying control characters or a newline", async () => {
    // A model id reaches log lines, error messages and (via a qualified key) a storage path. A
    // newline in one is a log-injection primitive; a NUL is a path primitive.
    //
    // The control characters are spelled as `\u` ESCAPES, never embedded as raw bytes: a raw NUL
    // anywhere in a source file makes git classify that file as BINARY, which erases it from every
    // diff and review package. The values under test are byte-identical either way.
    const result = await discoverModels(adapterReturning(clean([{ id: "ok" }, { id: "bad\nid" }, { id: "bad\u0000id" }, { id: "bad\u001bid" }])), ctx());
    expect(result.models.map((m) => m.id)).toEqual(["ok"]);
  });

  test("drops an absurdly long id rather than carrying it", async () => {
    const result = await discoverModels(adapterReturning(clean([{ id: "x".repeat(5000) }, { id: "fine" }])), ctx());
    expect(result.models.map((m) => m.id)).toEqual(["fine"]);
  });

  test("dedupes by id, first occurrence wins", async () => {
    const result = await discoverModels(adapterReturning(clean([{ id: "a", displayName: "first" }, { id: "a", displayName: "second" }, { id: "b" }])), ctx());
    expect(result.models).toHaveLength(2);
    expect(result.models[0]!.displayName).toBe("first");
    expect(result.warnings.join(" ")).toContain("duplicate");
  });

  test("drops an implausible contextWindow instead of trusting it", async () => {
    const result = await discoverModels(adapterReturning(clean([{ id: "a", contextWindow: -1 }, { id: "b", contextWindow: 1.5 }, { id: "c", contextWindow: 200000 }])), ctx());
    expect(result.models.find((m) => m.id === "a")!.contextWindow).toBeUndefined();
    expect(result.models.find((m) => m.id === "b")!.contextWindow).toBeUndefined();
    expect(result.models.find((m) => m.id === "c")!.contextWindow).toBe(200000);
  });
});

describe("discoverModels — caching", () => {
  test("stores a successful result and serves it back when a later call fails", async () => {
    const cache = createDiscoveryCache();
    let fail = false;
    const adapter = adapterReturning(async () => {
      if (fail) throw new Error("provider is down");
      return clean([{ id: "a" }]);
    });
    const first = await discoverModels(adapter, ctx(), cache);
    expect(first.cached).toBe(false);

    fail = true;
    const second = await discoverModels(adapter, ctx(), cache);
    expect(second.cached).toBe(true);
    expect(second.models.map((m) => m.id)).toEqual(["a"]);
    // A cached answer is STALE by definition, and saying so is the difference between a graceful
    // degradation and a silent lie about what the provider currently offers.
    expect(second.warnings.join(" ")).toContain("cached");
  });

  test("with NO cache entry, a failure propagates rather than returning an empty catalog", async () => {
    // Returning `{models: []}` would read as "this provider has no models", which is a much worse
    // answer than an error: a picker would render an empty list as fact.
    const adapter = adapterReturning(async () => {
      throw new Error("provider is down");
    });
    await expect(discoverModels(adapter, ctx(), createDiscoveryCache())).rejects.toBeDefined();
  });

  test("caches per provider AND per endpoint — two connections never share an answer", async () => {
    const cache = createDiscoveryCache();
    await discoverModels(adapterReturning(clean([{ id: "from-a" }])), ctx({ connection: { providerId: "acme", baseUrl: "https://a.example.test" } }), cache);
    const failing = adapterReturning(async () => {
      throw new Error("down");
    });
    await expect(
      discoverModels(failing, ctx({ connection: { providerId: "acme", baseUrl: "https://b.example.test" } }), cache),
    ).rejects.toBeDefined();
  });
});

describe("discoverModels — never overwrites the overlay (WS-13 §7)", () => {
  test("returns data only; the catalog object it was never handed is untouched", async () => {
    // The structural guarantee: discovery has no reference to the catalog at all, so "live discovery
    // never silently overwrites official-doc/live-probe overlay entries" is true by construction
    // rather than by discipline. This test pins the construction.
    const before = JSON.stringify(loadCatalog());
    await discoverModels(adapterReturning(clean([{ id: "anthropic/claude-sonnet-5", displayName: "hijacked" }])), ctx());
    expect(JSON.stringify(loadCatalog())).toBe(before);
  });
});
