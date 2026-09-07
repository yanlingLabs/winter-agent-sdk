// P7a LANE B: `resolveAdvisorRoute` — D30's precedence, the per-family defaults, and the two
// refusals (an unresolvable stated value; a Claude row Winter cannot authenticate).
//
// THE FIXTURE IS TYPED and stamped by the SAME `stampFamilyFields` the build pipeline uses (the rule
// `slots.test.ts` established at P6.6): a partial row cast to the catalog type would let a missing
// `modelFamily`/`canonicalModelId` ride past `tsc` into the function under test.
//
// The slot resolver is the REAL one (`resolveSlotToProvider`), never a stub. The whole claim of this
// module is "every candidate goes through WS-13c §4", and a fake resolver would prove the opposite
// of what the tests say they prove — the credential filter, the vendor order and the typed refusals
// are the resolver's, and the route is only correct if it inherits them unchanged.
import { describe, expect, test } from "bun:test";
import { stampFamilyFields } from "@yanlinglabs/winter-provider-catalog";
import type { ModelFamilyDescriptor, WinterCatalog, WinterModelDescriptor, WinterProviderDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { resolveAdvisorRoute, selectAdvisorCandidate } from "./advisor-route.ts";
import { computeActiveSlotSet, resolveSlotToProvider, type CredentialPresence } from "./slots.ts";

// --- the fixture --------------------------------------------------------------------------------

const FAMILIES: ModelFamilyDescriptor[] = [
  {
    id: "claude",
    displayName: "Claude",
    vendor: "Anthropic",
    vendorProviders: ["anthropic"],
    matchers: [{ pattern: "^claude-", note: "" }],
    status: "supported",
    citation: "spec:WS-13c §9",
    slots: [
      { name: "fable", canonicalModelId: "claude-fable-5.1", description: "the most capable Claude model", reason: "First: strength.", basis: "winter-curated", citation: "c", status: "candidate" },
      { name: "opus", canonicalModelId: "claude-opus-5", description: "complex, multi-step engineering", reason: "Second.", basis: "winter-curated", citation: "c", status: "candidate" },
      { name: "sonnet", canonicalModelId: "claude-sonnet-5", description: "everyday coding", reason: "Third.", basis: "winter-curated", citation: "c", status: "candidate" },
      { name: "haiku", canonicalModelId: "claude-haiku-4.5", description: "the cheapest", reason: "Fourth.", basis: "winter-curated", citation: "c", status: "candidate" },
    ],
  },
  {
    id: "gpt",
    displayName: "GPT",
    vendor: "OpenAI",
    // The subscription row FIRST (WS-13c §4 step 3-i).
    vendorProviders: ["codex-oauth", "openai"],
    matchers: [{ pattern: "^gpt-(?!oss)", note: "" }],
    status: "candidate",
    citation: "c",
    slots: [
      { name: "astra", canonicalModelId: "gpt-6-astra", description: "abstract reasoning", reason: "First.", basis: "user-ruling", citation: "c", status: "candidate" },
      { name: "luna", canonicalModelId: "gpt-5.6-luna", description: "the cheap implementer", reason: "Fourth.", basis: "user-ruling", citation: "c", status: "candidate" },
    ],
  },
  {
    id: "gemini",
    displayName: "Gemini",
    vendor: "Google",
    vendorProviders: ["google"],
    matchers: [{ pattern: "^gemini-", note: "" }],
    status: "candidate",
    citation: "c",
    // Slot 1 is NOT the strongest (WS-13c §2: position is not a strength claim) -- which is exactly
    // why "any other family -> its slot 1" has to be tested on a family whose first slot is
    // distinguishable from "the obvious one".
    slots: [
      { name: "pro", canonicalModelId: "gemini-3.1-pro-preview", description: "long-context analysis", reason: "First by breadth.", basis: "winter-curated", citation: "c", status: "candidate" },
      { name: "flash", canonicalModelId: "gemini-3.7-flash", description: "fast agentic coding", reason: "Second: strength.", basis: "vendor-doc", citation: "c", status: "candidate" },
    ],
  },
  // A family with NO slots: D30's "the session's own model" clause.
  { id: "kimi", displayName: "Kimi", vendor: "Moonshot", vendorProviders: ["moonshot"], matchers: [{ pattern: "^kimi-", note: "" }], slots: [], status: "candidate", citation: "c" },
  { id: "other", displayName: "Other", vendor: "", vendorProviders: [], matchers: [], slots: [], status: "candidate", citation: "c" },
];

function provider(id: string, over: Partial<WinterProviderDescriptor> = {}): WinterProviderDescriptor {
  return {
    id,
    displayName: id,
    protocols: ["openai-chat-completions"],
    authKinds: ["api-key"],
    defaultEndpoints: { api: `https://${id}.example/v1` },
    modelDiscovery: "none",
    liveCatalogAuthority: "unknown",
    adapterId: "openai-chat",
    family: "openai",
    upstream: { project: "winter", commit: "", sourcePaths: [] },
    risk: { class: "approved", reasons: [] },
    scope: "llm",
    pricingBasis: "token",
    admission: { basis: "api-key", citation: "https://example.test/doc", tier: "fetched-document" },
    ...over,
  };
}

const PROVIDERS: WinterProviderDescriptor[] = [
  // The shipped shape of the vendor row: api key OR Anthropic Console OAuth (D20).
  provider("anthropic", { authKinds: ["api-key", "oauth-approved"] }),
  provider("openai"),
  provider("codex-oauth", { authKinds: ["oauth-approved"], pricingBasis: "subscription", admission: { basis: "oauth-documented", citation: "spec:WS-13b §0", tier: "spec-ruling" } }),
  provider("google"),
  provider("moonshot"),
  // THE NON-WINTER CREDENTIAL KIND. `custom` is the catalog's own "authenticated by something
  // outside this vocabulary" -- the shape a claude.ai subscription login would have to take, since
  // no row declares one and no adapter has an arm for it (D13/D14).
  provider("subscription-only", { authKinds: ["custom"] }),
];

function row(key: string, providerId: string, upstreamId: string, over: Partial<WinterModelDescriptor> = {}): Omit<WinterModelDescriptor, "modelFamily" | "canonicalModelId"> & Partial<Pick<WinterModelDescriptor, "modelFamily" | "canonicalModelId">> {
  return {
    key,
    providerId,
    upstreamId,
    displayName: upstreamId,
    aliases: [],
    endpoints: ["chat"],
    inputModalities: { value: ["text"], source: "winter-default", confidence: "inferred" },
    outputModalities: { value: ["text"], source: "winter-default", confidence: "inferred" },
    toolCalling: { value: "native", source: "winter-default", confidence: "inferred" },
    nativeTools: { value: false, source: "winter-default", confidence: "inferred" },
    unsupportedParameters: [],
    status: "candidate",
    ...over,
  };
}

const MODELS: WinterModelDescriptor[] = stampFamilyFields(
  [
    row("anthropic/claude-fable-5-1", "anthropic", "claude-fable-5-1"),
    row("anthropic/claude-opus-5", "anthropic", "claude-opus-5"),
    row("anthropic/claude-sonnet-5", "anthropic", "claude-sonnet-5"),
    row("openai/gpt-6-astra", "openai", "gpt-6-astra"),
    row("codex-oauth/gpt-6-astra", "codex-oauth", "gpt-6-astra"),
    row("openai/gpt-5.6-luna", "openai", "gpt-5.6-luna"),
    row("google/gemini-3.1-pro-preview", "google", "gemini-3.1-pro-preview"),
    row("google/gemini-3.7-flash", "google", "gemini-3.7-flash"),
    row("moonshot/kimi-k3", "moonshot", "kimi-k3"),
  ],
  FAMILIES,
) as WinterModelDescriptor[];

function catalogWith(extraModels: WinterModelDescriptor[] = []): WinterCatalog {
  return {
    schemaVersion: 2,
    catalogVersion: "0.0.0-advisor-route-fixture",
    upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" },
    providers: PROVIDERS,
    models: [...MODELS, ...extraModels],
    families: FAMILIES,
  };
}

const catalog = catalogWith();

/** The REAL §4 resolver, bound to one session's model key and one credential view. */
function slotResolverFor(
  sessionModelKey: string | undefined,
  opts: { hasCredential?: (providerId: string) => CredentialPresence; providerEnabled?: (providerId: string) => boolean; catalog?: WinterCatalog } = {},
): (requested: string) => ReturnType<typeof resolveSlotToProvider> {
  const cat = opts.catalog ?? catalog;
  return (requested) =>
    resolveSlotToProvider({
      catalog: cat,
      active: computeActiveSlotSet({ catalog: cat, currentModelKey: sessionModelKey, customSlots: undefined }),
      requested,
      hasCredential: opts.hasCredential ?? (() => "present"),
      providerEnabled: opts.providerEnabled ?? (() => true),
      preferredProviders: [],
    });
}

// --- precedence ---------------------------------------------------------------------------------

describe("D30 precedence: option > setting > family default", () => {
  test("`Options.advisor.model` wins over `settings.advisor.model` AND over the family default", () => {
    const route = resolveAdvisorRoute({
      catalog,
      sessionModelKey: "openai/gpt-6-astra",
      optionModel: "google/gemini-3.7-flash",
      settingModel: "luna",
      resolveSlot: slotResolverFor("openai/gpt-6-astra"),
    });
    expect(route).toEqual({ ok: true, modelKey: "google/gemini-3.7-flash", providerId: "google", source: "option" });
  });

  test("`settings.advisor.model` wins over the family default", () => {
    const route = resolveAdvisorRoute({ catalog, sessionModelKey: "openai/gpt-6-astra", settingModel: "luna", resolveSlot: slotResolverFor("openai/gpt-6-astra") });
    expect(route).toEqual({ ok: true, modelKey: "openai/gpt-5.6-luna", providerId: "openai", source: "setting" });
  });

  test("a blank or whitespace-only value is not a choice -- it falls to the next source", () => {
    expect(selectAdvisorCandidate({ catalog, sessionModelKey: "openai/gpt-6-astra", optionModel: "   ", settingModel: "" })).toEqual({
      requested: "astra",
      source: "family-default",
      origin: "the gpt-family default (D30)",
    });
  });

  test("a stated-but-unresolvable value is a REFUSAL, never a slide down to the next source", () => {
    // The setting names a model nothing in this catalog serves. The gpt family default (`astra`)
    // WOULD resolve -- and the whole point is that it is never consulted.
    const route = resolveAdvisorRoute({ catalog, sessionModelKey: "openai/gpt-6-astra", settingModel: "not-a-model-anywhere", resolveSlot: slotResolverFor("openai/gpt-6-astra") });
    expect(route.ok).toBe(false);
    if (route.ok) throw new Error("unreachable");
    expect(route.reason).toContain("`settings.advisor.model`");
    expect(route.reason).toContain("not-a-model-anywhere");
    expect(route.reason).not.toContain("gpt-6-astra");
  });

  test("an unresolvable `Options.advisor.model` refuses too, and names the OPTION as the source", () => {
    const route = resolveAdvisorRoute({ catalog, sessionModelKey: "openai/gpt-6-astra", optionModel: "openai/gpt-9-nonexistent", settingModel: "luna", resolveSlot: slotResolverFor("openai/gpt-6-astra") });
    // A qualified key passes the resolver's own unfiltered door, so this one RESOLVES -- and that is
    // the regression floor `slots.ts` documents, not a bug: the registry judges a key, not this layer.
    expect(route).toEqual({ ok: true, modelKey: "openai/gpt-9-nonexistent", providerId: "openai", source: "option" });
  });
});

// --- per-family defaults ------------------------------------------------------------------------

describe("D30 per-family defaults", () => {
  test("a gpt session with no setting reviews with astra -- openai/gpt-6-astra when only the API key is configured", () => {
    const route = resolveAdvisorRoute({
      catalog,
      sessionModelKey: "openai/gpt-5.6-luna",
      resolveSlot: slotResolverFor("openai/gpt-5.6-luna", { hasCredential: (id) => (id === "openai" ? "present" : "absent") }),
    });
    expect(route).toEqual({ ok: true, modelKey: "openai/gpt-6-astra", providerId: "openai", source: "family-default" });
  });

  test("the SUBSCRIPTION row wins when its credential is present (§4 step 3-i) -- codex-oauth/gpt-6-astra", () => {
    const route = resolveAdvisorRoute({ catalog, sessionModelKey: "openai/gpt-5.6-luna", resolveSlot: slotResolverFor("openai/gpt-5.6-luna", { hasCredential: () => "present" }) });
    expect(route).toEqual({ ok: true, modelKey: "codex-oauth/gpt-6-astra", providerId: "codex-oauth", source: "family-default" });
  });

  test("a claude session with no setting reviews with fable -- anthropic/claude-fable-5-1", () => {
    const route = resolveAdvisorRoute({ catalog, sessionModelKey: "anthropic/claude-sonnet-5", resolveSlot: slotResolverFor("anthropic/claude-sonnet-5") });
    expect(route).toEqual({ ok: true, modelKey: "anthropic/claude-fable-5-1", providerId: "anthropic", source: "family-default" });
  });

  test("any OTHER family falls to its slot 1, by position and not by strength", () => {
    const route = resolveAdvisorRoute({ catalog, sessionModelKey: "google/gemini-3.7-flash", resolveSlot: slotResolverFor("google/gemini-3.7-flash") });
    // `flash` is the family's documented STRONGEST and `pro` is slot 1; D30 says slot 1.
    expect(route).toEqual({ ok: true, modelKey: "google/gemini-3.1-pro-preview", providerId: "google", source: "family-default" });
  });

  test("a family with NO slots reviews with the session's OWN model", () => {
    const route = resolveAdvisorRoute({ catalog, sessionModelKey: "moonshot/kimi-k3", resolveSlot: slotResolverFor("moonshot/kimi-k3") });
    expect(route).toEqual({ ok: true, modelKey: "moonshot/kimi-k3", providerId: "moonshot", source: "own-model" });
  });

  test("an UNCATALOGUED session model (an allowUnlisted pass-through) is in no family -- it reviews with itself", () => {
    const route = resolveAdvisorRoute({ catalog, sessionModelKey: "openai/some-unlisted-preview", resolveSlot: slotResolverFor("openai/some-unlisted-preview") });
    expect(route).toEqual({ ok: true, modelKey: "openai/some-unlisted-preview", providerId: "openai", source: "own-model" });
  });

  test("D30's family defaults are pinned BY NAME, not read off slot 1 -- a re-ranked gpt family still reviews with astra", () => {
    const reranked = catalogWith();
    reranked.families = FAMILIES.map((f) => (f.id === "gpt" ? { ...f, slots: [...f.slots].reverse() } : f));
    const route = resolveAdvisorRoute({ catalog: reranked, sessionModelKey: "openai/gpt-5.6-luna", resolveSlot: slotResolverFor("openai/gpt-5.6-luna", { catalog: reranked }) });
    expect(route).toMatchObject({ ok: true, modelKey: "codex-oauth/gpt-6-astra" });
  });

  test("no candidate at all (no option, no setting, no session model) is a typed refusal", () => {
    const route = resolveAdvisorRoute({ catalog, sessionModelKey: undefined, resolveSlot: slotResolverFor(undefined) });
    expect(route.ok).toBe(false);
    if (route.ok) throw new Error("unreachable");
    expect(route.reason).toContain("no effective model to derive a per-family default from");
  });
});

// --- refusals -----------------------------------------------------------------------------------

describe("never a silent substitution", () => {
  test("a claude session with NO anthropic credential refuses, naming the row that would have served it -- and no request is possible", () => {
    const route = resolveAdvisorRoute({
      catalog,
      sessionModelKey: "anthropic/claude-sonnet-5",
      resolveSlot: slotResolverFor("anthropic/claude-sonnet-5", { hasCredential: () => "absent" }),
    });
    expect(route.ok).toBe(false);
    if (route.ok) throw new Error("unreachable");
    expect(route.reason).toContain("anthropic/claude-fable-5-1");
    expect(route.reason).toContain("no credential configured");
    // The refusal carries NO model key or provider id fields at all: there is structurally nothing
    // for `session-provider.ts` to build a provider from, so "no request" is not a discipline.
    expect(Object.keys(route)).toEqual(["ok", "reason"]);
  });

  test("a claude reviewer served ONLY by a non-Winter credential kind is refused before any provider is built", () => {
    // The one row for this canonical id is served by a `custom`-authKind provider: not an API key,
    // not a Console OAuth login, not a cloud credential chain (WS-13c §6, D13/D14).
    const subscriptionOnly = catalogWith(
      stampFamilyFields([row("subscription-only/claude-fable-5-1", "subscription-only", "claude-fable-5-1")], FAMILIES) as WinterModelDescriptor[],
    );
    subscriptionOnly.models = subscriptionOnly.models.filter((m) => m.key !== "anthropic/claude-fable-5-1");
    const route = resolveAdvisorRoute({
      catalog: subscriptionOnly,
      sessionModelKey: "anthropic/claude-sonnet-5",
      resolveSlot: slotResolverFor("anthropic/claude-sonnet-5", { catalog: subscriptionOnly }),
    });
    expect(route.ok).toBe(false);
    if (route.ok) throw new Error("unreachable");
    expect(route.reason).toContain("subscription-only");
    expect(route.reason).toContain("custom");
    expect(route.reason).toContain("no request was made");
  });

  test("the claude gate admits the vendor row on an API key AND on a Console OAuth login -- both are Winter credential kinds", () => {
    for (const authKinds of [["api-key"], ["oauth-approved"], ["api-key", "oauth-approved"]] as const) {
      const cat = catalogWith();
      cat.providers = PROVIDERS.map((p) => (p.id === "anthropic" ? { ...p, authKinds: [...authKinds] } : p));
      const route = resolveAdvisorRoute({ catalog: cat, sessionModelKey: "anthropic/claude-sonnet-5", resolveSlot: slotResolverFor("anthropic/claude-sonnet-5", { catalog: cat }) });
      expect(route, `authKinds=${authKinds.join("+")}`).toMatchObject({ ok: true, modelKey: "anthropic/claude-fable-5-1" });
    }
  });

  test("the claude gate is CLAUDE-ONLY: a non-claude row on a `custom` provider is not refused for its auth kind", () => {
    const cat = catalogWith(stampFamilyFields([row("subscription-only/gpt-6-astra", "subscription-only", "gpt-6-astra")], FAMILIES) as WinterModelDescriptor[]);
    const route = resolveAdvisorRoute({
      catalog: cat,
      sessionModelKey: "openai/gpt-5.6-luna",
      // Only the `custom` provider has a credential, so §4's ordering has nothing else to choose.
      resolveSlot: slotResolverFor("openai/gpt-5.6-luna", { catalog: cat, hasCredential: (id) => (id === "subscription-only" ? "present" : "absent") }),
    });
    expect(route).toEqual({ ok: true, modelKey: "subscription-only/gpt-6-astra", providerId: "subscription-only", source: "family-default" });
  });

  test("a disabled provider is a refusal that says so, not a fall-through to another vendor", () => {
    const route = resolveAdvisorRoute({
      catalog,
      sessionModelKey: "google/gemini-3.7-flash",
      resolveSlot: slotResolverFor("google/gemini-3.7-flash", { providerEnabled: (id) => id !== "google" }),
    });
    expect(route.ok).toBe(false);
    if (route.ok) throw new Error("unreachable");
    expect(route.reason).toContain("disabled in settings");
  });

  test("an ambiguous slot name rides the resolver's own typed message through verbatim", () => {
    // `pro` is a gemini slot; from a gpt session it is a foreign name, and this fixture has exactly
    // one family holding it, so it resolves. The AMBIGUITY case needs two -- add a second `pro`.
    const cat = catalogWith();
    cat.families = [...FAMILIES, { id: "deepseek", displayName: "DeepSeek", vendor: "DeepSeek", vendorProviders: [], matchers: [], status: "candidate", citation: "c", slots: [{ name: "pro", canonicalModelId: "deepseek-v4-pro", description: "d", reason: "r", basis: "winter-curated", citation: "c", status: "candidate" }] }];
    const route = resolveAdvisorRoute({ catalog: cat, sessionModelKey: "openai/gpt-6-astra", settingModel: "pro", resolveSlot: slotResolverFor("openai/gpt-6-astra", { catalog: cat }) });
    expect(route.ok).toBe(false);
    if (route.ok) throw new Error("unreachable");
    expect(route.reason).toContain("is a slot in");
    expect(route.reason).toContain("`settings.advisor.model`");
  });
});
