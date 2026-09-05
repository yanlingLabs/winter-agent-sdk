import { describe, expect, test } from "bun:test";
import { createRegistry } from "../registry.ts";
import { createEndpointResolver, endpointFromOrigin, readableStateOf, sameDomain, sameFamily, shouldRequestSummary, summaryRequestOf } from "./domains.ts";
import { fixtureCatalog, fixtureModel, fixtureProvider, fixtureReasoning, scriptedAdapter } from "./fixtures.ts";

describe("sameDomain: evidence only, never HTTP shape", () => {
  test("TWO `/v1/responses` ENDPOINTS WITH DIFFERENT DOMAINS DO NOT SHARE STATE", () => {
    // The named fixture of the brief. Both providers speak the same protocol at the same URL shape;
    // their descriptors declare DIFFERENT continuation-domain member lists, so the registry stamps
    // different domain ids and nothing about "OpenAI-compatible" makes them one domain.
    const openai = fixtureProvider({ id: "openai", baseUrl: "https://a.invalid/v1/responses" });
    const deepseek = fixtureProvider({ id: "deepseek", baseUrl: "https://b.invalid/v1/responses" });
    const catalog = fixtureCatalog(
      [openai, deepseek],
      [
        fixtureModel({ key: "openai/o-reason", providerId: "openai", reasoning: fixtureReasoning({ readableState: "summary", domain: ["openai/o-reason"] }) }),
        fixtureModel({ key: "deepseek/r-reason", providerId: "deepseek", reasoning: fixtureReasoning({ readableState: "full-exposed", domain: ["deepseek/r-reason"] }) }),
      ],
    );
    const registry = createRegistry(catalog);
    registry.register(scriptedAdapter({ id: "openai-adapter" }));
    registry.register(scriptedAdapter({ id: "deepseek-adapter" }));
    const resolveFacts = createEndpointResolver(registry);
    const a = resolveFacts({ providerId: "openai", modelKey: "openai/o-reason", family: "openai" });
    const b = resolveFacts({ providerId: "deepseek", modelKey: "deepseek/r-reason", family: "openai" });

    expect(a.continuationDomain).toBeDefined();
    expect(b.continuationDomain).toBeDefined();
    expect(sameDomain(a, b)).toBe(false);
    // ... and the forbidden tests would have said "yes" to both of them.
    expect(sameFamily(a, b)).toBe(true);
    expect(a.providerId === b.providerId).toBe(false);
  });

  test("two models listing the SAME member list share the domain", () => {
    const provider = fixtureProvider({ id: "openai" });
    const domain = ["openai/o-a", "openai/o-b"];
    const catalog = fixtureCatalog(
      [provider],
      [
        fixtureModel({ key: "openai/o-a", providerId: "openai", reasoning: fixtureReasoning({ readableState: "summary", domain }) }),
        fixtureModel({ key: "openai/o-b", providerId: "openai", reasoning: fixtureReasoning({ readableState: "summary", domain }) }),
      ],
    );
    const registry = createRegistry(catalog);
    registry.register(scriptedAdapter({ id: "openai-adapter" }));
    const resolveFacts = createEndpointResolver(registry);
    const a = resolveFacts({ providerId: "openai", modelKey: "openai/o-a", family: "openai" });
    const b = resolveFacts({ providerId: "openai", modelKey: "openai/o-b", family: "openai" });
    expect(sameDomain(a, b)).toBe(true);
  });

  test("SAME PROVIDER, uncertified models are TWO domains -- provider equality is never the test", () => {
    const provider = fixtureProvider({ id: "anthropic", family: "anthropic" });
    const catalog = fixtureCatalog(
      [provider],
      [
        fixtureModel({ key: "anthropic/c-a", providerId: "anthropic", reasoning: fixtureReasoning({ readableState: "summary" }) }),
        fixtureModel({ key: "anthropic/c-b", providerId: "anthropic", reasoning: fixtureReasoning({ readableState: "summary" }) }),
      ],
    );
    const registry = createRegistry(catalog);
    registry.register(scriptedAdapter({ id: "anthropic-adapter", family: "anthropic" }));
    const resolveFacts = createEndpointResolver(registry);
    const a = resolveFacts({ providerId: "anthropic", modelKey: "anthropic/c-a", family: "anthropic" });
    const b = resolveFacts({ providerId: "anthropic", modelKey: "anthropic/c-b", family: "anthropic" });
    // Each is its OWN single-member domain (the registry's key fallback), so the switch is warned.
    expect(a.continuationDomain).toBe("anthropic/c-a");
    expect(sameDomain(a, b)).toBe(false);
    expect(sameDomain(a, a)).toBe(true);
  });

  test("absence is never a wildcard: two undocumented transports are not one domain", () => {
    expect(sameDomain({}, {})).toBe(false);
    expect(sameDomain({ continuationDomain: "d" }, {})).toBe(false);
    expect(sameDomain(undefined, { continuationDomain: "d" })).toBe(false);
  });
});

describe("I2: only CERTIFIED evidence buys a shared domain", () => {
  const world = (confidence: "verified" | "declared" | "inferred" | "unknown") => {
    const domain = ["openai/o-a", "openai/o-b"];
    const catalog = fixtureCatalog(
      [fixtureProvider({ id: "openai" })],
      [
        fixtureModel({ key: "openai/o-a", providerId: "openai", reasoning: fixtureReasoning({ readableState: "summary", domain, confidence }) }),
        fixtureModel({ key: "openai/o-b", providerId: "openai", reasoning: fixtureReasoning({ readableState: "summary", domain, confidence }) }),
      ],
    );
    const registry = createRegistry(catalog);
    registry.register(scriptedAdapter({ id: "openai-adapter" }));
    return createEndpointResolver(registry);
  };

  test("`verified` and `declared` evidence keeps the shared id", () => {
    for (const confidence of ["verified", "declared"] as const) {
      const resolveFacts = world(confidence);
      const a = resolveFacts({ providerId: "openai", modelKey: "openai/o-a", family: "openai" });
      const b = resolveFacts({ providerId: "openai", modelKey: "openai/o-b", family: "openai" });
      expect(a.continuationDomain).toBe("openai/o-a");
      expect(sameDomain(a, b)).toBe(true);
    }
  });

  test("`inferred` and `unknown` evidence yields NO domain id -- a guess must not buy a suppressed warning", () => {
    for (const confidence of ["inferred", "unknown"] as const) {
      const resolveFacts = world(confidence);
      const a = resolveFacts({ providerId: "openai", modelKey: "openai/o-a", family: "openai" });
      const b = resolveFacts({ providerId: "openai", modelKey: "openai/o-b", family: "openai" });
      expect(a.continuationDomain).toBeUndefined();
      expect(sameDomain(a, b)).toBe(false);
    }
  });

  test("a row with NO domain evidence keeps its key-derived self-domain: it claims nothing about sharing", () => {
    const catalog = fixtureCatalog(
      [fixtureProvider({ id: "anthropic", family: "anthropic" })],
      [fixtureModel({ key: "anthropic/c", providerId: "anthropic", reasoning: fixtureReasoning({ readableState: "summary" }) })],
    );
    const registry = createRegistry(catalog);
    registry.register(scriptedAdapter({ id: "anthropic-adapter", family: "anthropic" }));
    const facts = createEndpointResolver(registry)({ providerId: "anthropic", modelKey: "anthropic/c", family: "anthropic" });
    expect(facts.continuationDomain).toBe("anthropic/c");
    expect(sameDomain(facts, facts)).toBe(true);
  });

  test("ROUND 2 REGRESSION: the catalog's REAL shape -- a single-member self list at `unknown` -- keeps its self id", () => {
    // THE SHAPE EVERY HAND-BUILT FIXTURE MISSED. Every `opaque-provider-state` row in the shipped
    // catalog looks like this, and the round-1 gate dropped the id for all of them: same-model native
    // replay died for five of the six reasoning models in the product while `classifySwitch(X, X)`
    // still reported `lossless-native`. A list naming only this model asserts no sharing, so there is
    // nothing for certification to be about.
    const catalog = fixtureCatalog(
      [fixtureProvider({ id: "openai" })],
      [fixtureModel({ key: "openai/o-solo", providerId: "openai", reasoning: fixtureReasoning({ readableState: "summary", domain: ["openai/o-solo"], confidence: "unknown" }) })],
    );
    const registry = createRegistry(catalog);
    registry.register(scriptedAdapter({ id: "openai-adapter" }));
    const facts = createEndpointResolver(registry)({ providerId: "openai", modelKey: "openai/o-solo", family: "openai" });
    expect(facts.continuationDomain).toBe("openai/o-solo");
    expect(sameDomain(facts, facts)).toBe(true);
    // ... and the id the BRIDGE would put on the target agrees with it, which is what makes the
    // replay actually happen rather than merely look right on one side.
    const resolved = registry.resolve({ model: "openai/o-solo" });
    expect(resolved instanceof Error).toBe(false);
    const bridgeTargetDomain = (resolved as { continuationDomain?: string }).continuationDomain;
    expect(bridgeTargetDomain).toBeDefined();
    expect(sameDomain(facts, { continuationDomain: bridgeTargetDomain! })).toBe(true);
  });

  test("ROUND 2: an uncertified MULTI-member list is refused, and cannot pair with a certified twin that derives the same id", () => {
    // Why the test is the LIST and not `domain === descriptor.key`: the registry derives the
    // alphabetically first member, so uncertified `o-a` with `["o-a","o-b"]` also derives `"o-a"` --
    // equal to its own key. An id-equality carve-out would let it survive and then match a CERTIFIED
    // `o-b` deriving the same id, buying exactly the shared domain the gate refuses.
    const shared = ["openai/o-a", "openai/o-b"];
    const catalog = fixtureCatalog(
      [fixtureProvider({ id: "openai" })],
      [
        fixtureModel({ key: "openai/o-a", providerId: "openai", reasoning: fixtureReasoning({ readableState: "summary", domain: shared, confidence: "unknown" }) }),
        fixtureModel({ key: "openai/o-b", providerId: "openai", reasoning: fixtureReasoning({ readableState: "summary", domain: shared, confidence: "verified" }) }),
      ],
    );
    const registry = createRegistry(catalog);
    registry.register(scriptedAdapter({ id: "openai-adapter" }));
    const resolveFacts = createEndpointResolver(registry);
    const weak = resolveFacts({ providerId: "openai", modelKey: "openai/o-a", family: "openai" });
    const certified = resolveFacts({ providerId: "openai", modelKey: "openai/o-b", family: "openai" });
    expect(weak.continuationDomain).toBeUndefined();
    expect(certified.continuationDomain).toBe("openai/o-a");
    expect(sameDomain(weak, certified)).toBe(false);
  });

  test("DISCLOSED RESIDUAL: an uncertified MULTI-member row also loses its own replay, and the classifier stays honest about it", () => {
    // The collateral of refusing that sharing claim: the bridge computes the TARGET's id from the
    // ungated registry, so the two sides of the SAME model disagree and the renderer strips. No row
    // in the shipped catalog has this shape (they are all single-member self lists, covered above).
    //
    // What matters is that nothing CLAIMS otherwise: the same-profile rule reports `lossless-native`
    // for a model switching to itself, and that claim is only true because the strip does not happen
    // for any real row -- which is exactly what real-catalog.test.ts proves, row by row. The honest
    // fix is upstream: evidence naming more than one model should be `declared` at least.
    const shared = ["openai/o-a", "openai/o-b"];
    const catalog = fixtureCatalog(
      [fixtureProvider({ id: "openai" })],
      [fixtureModel({ key: "openai/o-a", providerId: "openai", reasoning: fixtureReasoning({ readableState: "summary", domain: shared, confidence: "inferred" }) })],
    );
    const registry = createRegistry(catalog);
    registry.register(scriptedAdapter({ id: "openai-adapter" }));
    const source = createEndpointResolver(registry)({ providerId: "openai", modelKey: "openai/o-a", family: "openai" });
    const ungatedTarget = { continuationDomain: "openai/o-a" }; // what the bridge builds
    expect(source.continuationDomain).toBeUndefined();
    expect(sameDomain(source, ungatedTarget)).toBe(false);
  });
});

describe("reasoning evidence", () => {
  test("I1: `continuation` is carried from the descriptor, and a row with no reasoning block reads as `none`", () => {
    const catalog = fixtureCatalog(
      [fixtureProvider({ id: "openai" })],
      [
        fixtureModel({ key: "openai/gpt-chat", providerId: "openai" }),
        fixtureModel({ key: "openai/o", providerId: "openai", reasoning: fixtureReasoning({ readableState: "summary", domain: ["openai/o"] }) }),
      ],
    );
    const registry = createRegistry(catalog);
    registry.register(scriptedAdapter({ id: "openai-adapter" }));
    const resolveFacts = createEndpointResolver(registry);
    expect(resolveFacts({ providerId: "openai", modelKey: "openai/gpt-chat", family: "openai" }).continuation).toBe("none");
    expect(resolveFacts({ providerId: "openai", modelKey: "openai/o", family: "openai" }).continuation).toBe("opaque-provider-state");
    // No catalog row at all leaves it UNKNOWN rather than asserting "none".
    expect(resolveFacts({ providerId: "gone", modelKey: "gone/m", family: "openai" }).continuation).toBeUndefined();
  });

  test("`readableState` comes from evidence, and its absence reads as `none`", () => {
    expect(readableStateOf(undefined)).toBe("none");
    expect(readableStateOf(fixtureModel({ key: "p/m", providerId: "p" }))).toBe("none");
    expect(readableStateOf(fixtureModel({ key: "p/m", providerId: "p", reasoning: fixtureReasoning({ readableState: "full-exposed" }) }))).toBe("full-exposed");
  });

  test("`shouldRequestSummary` keys on `summaryRequest`, NOT on readable state -- the DeepSeek case", () => {
    // DeepSeek exposes complete reasoning (`full-exposed`) and documents no way to REQUEST a summary:
    // asking anyway would send a field it does not honour on every request of the session.
    const deepseek = fixtureModel({ key: "deepseek/r", providerId: "deepseek", reasoning: fixtureReasoning({ readableState: "full-exposed" }) });
    expect(readableStateOf(deepseek)).toBe("full-exposed");
    expect(shouldRequestSummary(deepseek)).toBe(false);

    const openai = fixtureModel({
      key: "openai/o",
      providerId: "openai",
      reasoning: fixtureReasoning({ readableState: "summary", summaryRequest: { field: "reasoning.summary", values: ["auto", "detailed"] } }),
    });
    expect(shouldRequestSummary(openai)).toBe(true);
    expect(summaryRequestOf(openai)).toEqual({ field: "reasoning.summary", values: ["auto", "detailed"] });
    expect(shouldRequestSummary(undefined)).toBe(false);
  });
});

describe("endpoint resolution through the registry", () => {
  test("an origin whose model has left the catalog degrades to its OWN stamp, never to unknown", () => {
    const registry = createRegistry(fixtureCatalog([], []));
    const resolveFacts = createEndpointResolver(registry);
    const facts = resolveFacts({ providerId: "gone", modelKey: "gone/model", family: "openai", continuationDomain: "gone-domain" });
    expect(facts).toEqual({ providerId: "gone", modelKey: "gone/model", family: "openai", continuationDomain: "gone-domain", readableState: "none" });
    expect(sameDomain(facts, { continuationDomain: "gone-domain" })).toBe(true);
    expect(endpointFromOrigin({ providerId: "gone", modelKey: "gone/model", family: "openai" }).continuationDomain).toBeUndefined();
  });

  test("the resolver caches per model key (one catalog walk per model, not per message)", () => {
    const provider = fixtureProvider({ id: "openai" });
    const catalog = fixtureCatalog([provider], [fixtureModel({ key: "openai/o", providerId: "openai", reasoning: fixtureReasoning({ readableState: "summary", domain: ["openai/o"] }) })]);
    const registry = createRegistry(catalog);
    registry.register(scriptedAdapter({ id: "openai-adapter" }));
    let calls = 0;
    const counting = {
      ...registry,
      resolve(request: Parameters<typeof registry.resolve>[0]) {
        calls++;
        return registry.resolve(request);
      },
    };
    const resolveFacts = createEndpointResolver(counting);
    const origin = { providerId: "openai", modelKey: "openai/o", family: "openai" };
    resolveFacts(origin);
    resolveFacts(origin);
    resolveFacts(origin);
    expect(calls).toBe(1);
  });
});
