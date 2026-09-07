// WS-13c §3/§4 (P6.6 Lane A): the active slot set, the Agent tool's rendered `model` schema, and
// slot -> provider resolution.
//
// THE FIXTURE IS TYPED, deliberately (spine addendum): `selection.test.ts`'s own `catalog()` is an
// `as unknown as WinterCatalog` over partial rows, so building on it would let a missing field ride
// straight past `tsc` into a function that reads it. Rows here are stamped by the SAME
// `stampFamilyFields` the build pipeline uses, so `modelFamily`/`canonicalModelId` in this file
// cannot drift from what a real catalog carries.
import { describe, expect, test } from "bun:test";
import { SLOT_NAME_RE, stampFamilyFields } from "@yanlinglabs/winter-provider-catalog";
import type { ModelFamilyDescriptor, WinterCatalog, WinterModelDescriptor, WinterProviderDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { computeActiveSlotSet, renderAgentModelSchema, resolveSlotToProvider, type CredentialPresence } from "./slots.ts";

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
      { name: "fable", canonicalModelId: "claude-fable-5", description: "the most capable Claude model", reason: "First because it is the strongest.", basis: "winter-curated", citation: "c", status: "candidate" },
      { name: "opus", canonicalModelId: "claude-opus-5", description: "very capable on complex, multi-step engineering", reason: "Second: near the top at a lower price.", basis: "winter-curated", citation: "c", status: "candidate" },
      { name: "sonnet", canonicalModelId: "claude-sonnet-5", description: "fast, capable everyday coding", reason: "Third: the balance.", basis: "winter-curated", citation: "c", status: "candidate" },
      { name: "haiku", canonicalModelId: "claude-haiku-4.5", description: "the fastest and cheapest", reason: "Fourth: cost.", basis: "winter-curated", citation: "c", status: "candidate" },
    ],
  },
  {
    id: "gpt",
    displayName: "GPT",
    vendor: "OpenAI",
    // The subscription row FIRST (WS-13c §4 step 3-i, R-6c-15).
    vendorProviders: ["codex-oauth", "openai"],
    matchers: [{ pattern: "^gpt-(?!oss)", note: "" }],
    status: "candidate",
    citation: "c",
    slots: [
      { name: "astra", canonicalModelId: "gpt-6-astra", description: "for seemingly impossible, novelty-like tasks", reason: "First: nothing else reaches it.", basis: "user-ruling", citation: "c", status: "candidate" },
      { name: "sol", canonicalModelId: "gpt-5.6-sol", description: "a highly capable model for VERY complex novelty tasks", reason: "Second: the ceiling before Astra.", basis: "user-ruling", citation: "c", status: "candidate" },
      { name: "terra", canonicalModelId: "gpt-5.6-terra", description: "a highly reliable and capable model for demanding work", reason: "Third: the demanding-work default.", basis: "user-ruling", citation: "c", status: "candidate" },
      { name: "luna", canonicalModelId: "gpt-5.6-luna", description: "probably the best cheap implementer on the market", reason: "Fourth: cost.", basis: "user-ruling", citation: "c", status: "candidate" },
    ],
  },
  {
    id: "gemini",
    displayName: "Gemini",
    vendor: "Google",
    vendorProviders: ["google", "vertex"],
    matchers: [{ pattern: "^gemini-", note: "" }],
    status: "candidate",
    citation: "c",
    slots: [
      { name: "pro", canonicalModelId: "gemini-3.1-pro-preview", description: "long-context analysis", reason: "First by breadth.", basis: "winter-curated", citation: "c", status: "candidate" },
      { name: "flash", canonicalModelId: "gemini-3.7-flash", description: "fast agentic coding", reason: "Second: strength.", basis: "vendor-doc", citation: "c", status: "candidate" },
    ],
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    vendor: "DeepSeek",
    vendorProviders: ["deepseek"],
    matchers: [{ pattern: "^deepseek", note: "" }],
    status: "candidate",
    citation: "c",
    slots: [
      { name: "pro", canonicalModelId: "deepseek-v4-pro", description: "the strongest DeepSeek", reason: "First: strength.", basis: "winter-curated", citation: "c", status: "candidate" },
      { name: "flash", canonicalModelId: "deepseek-v4-flash", description: "the fast, cheap implementer", reason: "Second: cost and speed.", basis: "winter-curated", citation: "c", status: "candidate" },
    ],
  },
  // A family with NO slots, exactly as the real overlay ships it: `other` claims a row no matcher
  // wanted, and a session on such a row renders its own model (WS-13c §3).
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
  provider("anthropic"),
  provider("openai"),
  provider("codex-oauth", { pricingBasis: "subscription", admission: { basis: "oauth-documented", citation: "spec:WS-13b §0", tier: "spec-ruling" } }),
  provider("openrouter", { admission: { basis: "api-key", citation: "https://openrouter.ai/docs", tier: "fetched-document" } }),
  provider("zenmux", { admission: { basis: "api-key", citation: "https://zenmux.example/docs", tier: "pinned-upstream" } }),
  provider("google"),
  provider("deepseek"),
  provider("doubao"),
];

/**
 * The one-liner the spine addendum names: a plain object literal per row, widened to the row type by
 * ONE annotated helper rather than by a generic at the `stampFamilyFields` call (which would infer
 * `endpoints: string[]` and refuse the descriptor's own tuple union).
 */
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
    row("anthropic/claude-opus-5", "anthropic", "claude-opus-5"),
    row("anthropic/claude-sonnet-5", "anthropic", "claude-sonnet-5"),
    // The three rows for `gpt-6-astra`, one per provider — the whole ordering rule of §4 step 3.
    row("openai/gpt-6-astra", "openai", "gpt-6-astra"),
    row("codex-oauth/gpt-6-astra", "codex-oauth", "gpt-6-astra"),
    // A gateway spells the vendor's own qualified id as its upstream id; the normaliser strips it,
    // so this row IS the same canonical model as the two above.
    row("openrouter/openai/gpt-6-astra", "openrouter", "openai/gpt-6-astra"),
    row("openai/gpt-5.6-luna", "openai", "gpt-5.6-luna"),
    // Three rows for one Gemini model: the vendor plus two aggregators, so `preferredProviders` has
    // a real tail to reorder.
    row("google/gemini-3.7-flash", "google", "gemini-3.7-flash"),
    row("openrouter/google/gemini-3.7-flash", "openrouter", "google/gemini-3.7-flash"),
    row("zenmux/gemini-3.7-flash", "zenmux", "gemini-3.7-flash"),
    row("deepseek/deepseek-v4-flash", "deepseek", "deepseek-v4-flash"),
    // No matcher claims it -> `other` (WS-13c §1).
    row("doubao/doubao-seed-2.0", "doubao", "doubao-seed-2.0"),
    // A slot whose only row cannot serve a chat turn: the explicit empty-candidates branch.
    row("openai/gpt-5.6-terra", "openai", "gpt-5.6-terra", { endpoints: ["embeddings"] }),
  ],
  FAMILIES,
) as WinterModelDescriptor[];

const catalog: WinterCatalog = {
  schemaVersion: 2,
  catalogVersion: "0.0.0-slots-fixture",
  upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" },
  providers: PROVIDERS,
  models: MODELS,
  families: FAMILIES,
};

// --- computeActiveSlotSet ------------------------------------------------------------------------

describe("computeActiveSlotSet", () => {
  test("a gpt session advertises astra, sol, terra, luna as family-default", () => {
    const a = computeActiveSlotSet({ catalog, currentModelKey: "openai/gpt-6-astra", customSlots: undefined });
    expect(a.source).toBe("family-default");
    expect(a.family).toBe("gpt");
    expect(a.slots.map((s) => s.name)).toEqual(["astra", "sol", "terra", "luna"]);
  });

  test("a claude session is pinned even with custom slots configured", () => {
    const a = computeActiveSlotSet({ catalog, currentModelKey: "anthropic/claude-opus-5", customSlots: [{ name: "master", model: "gpt-6-astra" }] });
    expect(a).toMatchObject({ family: "claude", source: "claude-pinned" });
    expect(a.slots.map((s) => s.name)).toEqual(["fable", "opus", "sonnet", "haiku"]);
  });

  test("custom slots replace the family default on a non-claude session, with the user's description or Winter's", () => {
    const a = computeActiveSlotSet({
      catalog,
      currentModelKey: "openai/gpt-6-astra",
      customSlots: [
        { name: "master", model: "gpt-6-astra", description: "the big one" },
        { name: "strong", model: "anthropic/claude-opus-5" },
      ],
    });
    expect(a.source).toBe("custom");
    expect(a.slots[0]).toMatchObject({ name: "master", description: "the big one" });
    // The fallback searches EVERY family, not the active one: a cross-family custom set (D27's own
    // example) would otherwise lose Winter's description for exactly the models it borrows.
    expect(a.slots[1]!.description).toBe(catalog.families.find((f) => f.id === "claude")!.slots[1]!.description);
    expect(a.slots[1]!.canonicalModelId).toBe("claude-opus-5");
  });

  test("a custom slot naming a model with no family slot falls back to the row's displayName", () => {
    const a = computeActiveSlotSet({ catalog, currentModelKey: "openai/gpt-6-astra", customSlots: [{ name: "odd", model: "doubao/doubao-seed-2.0" }] });
    expect(a.slots[0]).toMatchObject({ name: "odd", canonicalModelId: "doubao-seed-2.0", description: "doubao-seed-2.0" });
  });

  test("a family without slots renders the session's own model as one slot", () => {
    const a = computeActiveSlotSet({ catalog, currentModelKey: "doubao/doubao-seed-2.0", customSlots: undefined });
    expect(a).toMatchObject({ source: "own-model", family: "other" });
    expect(a.slots).toHaveLength(1);
    expect(a.slots[0]!.name).toBe("doubao-seed-2.0");
  });

  // TOTAL, never a throw: a session whose model failed to resolve (or a scripted double) still calls
  // this on every turn, and an exception there would take down the tool advertisement itself.
  test("an unknown or absent model key is an honest own-model answer, never an exception", () => {
    // The provider prefix is stripped and the SHARED normaliser does the rest, so an unlisted row is
    // named the same way a catalogued one would be — never a second, private spelling rule.
    const unlisted = computeActiveSlotSet({ catalog, currentModelKey: "openrouter/openai/never-seeded", customSlots: undefined });
    expect(unlisted).toMatchObject({ family: "other", source: "own-model" });
    expect(unlisted.slots[0]!.canonicalModelId).toBe("never-seeded");
    const none = computeActiveSlotSet({ catalog, currentModelKey: undefined, customSlots: undefined });
    expect(none).toMatchObject({ family: "other", source: "own-model", slots: [] });
  });

  // I-3 / R-6c-26: an UNCATALOGUED session (an `allowUnlisted` / custom-base-URL model, which WS-13
  // supports on purpose) used to advertise exactly one option that could never be taken -- its
  // canonical id has no rows, so the single slot always refused `slot-unservable` -- and the emitted
  // name could contain a `/` or a `:tag`, breaking the pinned slot grammar.
  describe("an uncatalogued own-model session", () => {
    test("names the slot legally and points it at the session's own row", () => {
      const a = computeActiveSlotSet({ catalog, currentModelKey: "zenmux/weird-model-9", customSlots: undefined });
      expect(a).toMatchObject({ family: "other", source: "own-model" });
      expect(a.slots[0]!.name).toBe("weird-model-9");
      expect(SLOT_NAME_RE.test(a.slots[0]!.name)).toBe(true);
      expect(a.slots[0]!.resolvesTo).toEqual({ providerId: "zenmux", key: "zenmux/weird-model-9" });
    });

    test("a gateway-nested id keeps a legal name — every path segment before the last is stripped", () => {
      const a = computeActiveSlotSet({ catalog, currentModelKey: "openrouter/some-vendor/unlisted-thing", customSlots: undefined });
      expect(a.slots[0]!.name).toBe("unlisted-thing");
      expect(SLOT_NAME_RE.test(a.slots[0]!.name)).toBe(true);
      expect(a.slots[0]!.resolvesTo).toEqual({ providerId: "openrouter", key: "openrouter/some-vendor/unlisted-thing" });
    });

    test("a non-size ollama tag is stripped rather than emitted into the enum", () => {
      const a = computeActiveSlotSet({ catalog, currentModelKey: "zenmux/llama3.1:latest", customSlots: undefined });
      expect(a.slots[0]!.name).toBe("llama3.1");
      expect(SLOT_NAME_RE.test(a.slots[0]!.name)).toBe(true);
    });

    test("a name that cannot be made legal yields an EMPTY set — the engine then keeps the static default", () => {
      const a = computeActiveSlotSet({ catalog, currentModelKey: "zenmux/_", customSlots: undefined });
      expect(a).toMatchObject({ family: "other", source: "own-model", slots: [] });
    });

    test("the single option RESOLVES, unfiltered, to the session's own key — never a permanent slot-unservable", () => {
      const active = computeActiveSlotSet({ catalog, currentModelKey: "zenmux/weird-model-9", customSlots: undefined });
      const r = resolveSlotToProvider({ catalog, active, requested: "weird-model-9", hasCredential: () => "absent", providerEnabled: () => false, preferredProviders: [] });
      expect(r).toMatchObject({ ok: true, modelKey: "zenmux/weird-model-9", providerId: "zenmux", viaSlotName: true });
    });

    test("a CATALOGUED own-model session is unchanged: no resolvesTo, and §4 chooses the row", () => {
      const active = computeActiveSlotSet({ catalog, currentModelKey: "doubao/doubao-seed-2.0", customSlots: undefined });
      expect(active.slots[0]!.resolvesTo).toBeUndefined();
      expect(resolveSlotToProvider({ catalog, active, requested: "doubao-seed-2.0", hasCredential: () => "present", providerEnabled: () => true, preferredProviders: [] })).toMatchObject({ ok: true, providerId: "doubao" });
    });
  });

  test("an empty custom set is not a custom set", () => {
    expect(computeActiveSlotSet({ catalog, currentModelKey: "openai/gpt-6-astra", customSlots: [] }).source).toBe("family-default");
  });
});

// --- renderAgentModelSchema ----------------------------------------------------------------------

describe("renderAgentModelSchema", () => {
  test("enum in slot order and one description line per slot", () => {
    const r = renderAgentModelSchema(computeActiveSlotSet({ catalog, currentModelKey: "openai/gpt-6-astra", customSlots: undefined }));
    expect(r.enum).toEqual(["astra", "sol", "terra", "luna"]);
    expect(r.descriptionLines[0]).toMatch(/^astra — gpt-6-astra: .+ \(.+\)$/);
    expect(r.descriptionLines).toHaveLength(4);
  });

  test("a claude session renders the pinned four and no other name", () => {
    const r = renderAgentModelSchema(computeActiveSlotSet({ catalog, currentModelKey: "anthropic/claude-opus-5", customSlots: undefined }));
    expect(r.enum).toEqual(["fable", "opus", "sonnet", "haiku"]);
    expect(r.descriptionLines.join("\n")).not.toContain("astra");
  });
});

// --- resolveSlotToProvider -----------------------------------------------------------------------

describe("resolveSlotToProvider (WS-13c §4)", () => {
  const base = { catalog, preferredProviders: [] as string[], providerEnabled: () => true };
  const gptSession = (): ReturnType<typeof computeActiveSlotSet> => computeActiveSlotSet({ catalog, currentModelKey: "openai/gpt-6-astra", customSlots: undefined });

  test("vendor row first, subscription before token, then preferred, then the rest", () => {
    const active = gptSession();
    const r = resolveSlotToProvider({ ...base, active, requested: "astra", hasCredential: (p) => (p === "openrouter" || p === "openai" || p === "codex-oauth" ? "present" : "absent") });
    expect(r).toMatchObject({ ok: true, providerId: "codex-oauth", modelKey: "codex-oauth/gpt-6-astra" });
    const r2 = resolveSlotToProvider({ ...base, active, requested: "astra", hasCredential: (p) => (p === "openrouter" || p === "openai" ? "present" : "absent") });
    expect(r2).toMatchObject({ ok: true, providerId: "openai" });
    const r3 = resolveSlotToProvider({ ...base, active, requested: "astra", hasCredential: (p) => (p === "openrouter" ? "present" : "absent") });
    expect(r3).toMatchObject({ ok: true, providerId: "openrouter" });
    expect(r.ok && r.slot).toEqual({ family: "gpt", name: "astra", source: "family-default" });
  });

  // R-6c-27: the shipped default that used to produce a false success. An openai-API-key-only user on
  // a gpt session asks for `astra`; codex-oauth leads the vendor group by §4 step 3-i, but nobody has
  // probed it. `unknown` must not outrank a credential we can actually see.
  test("an UNKNOWN credential never outranks a KNOWN one inside the same tier", () => {
    const active = gptSession();
    const onlyOpenai = (p: string): CredentialPresence => (p === "openai" ? "present" : "unknown");
    expect(resolveSlotToProvider({ ...base, active, requested: "astra", hasCredential: onlyOpenai })).toMatchObject({ ok: true, providerId: "openai", modelKey: "openai/gpt-6-astra" });
    // ...and once codex-oauth IS known present, the subscription-first rule takes over again.
    expect(resolveSlotToProvider({ ...base, active, requested: "astra", hasCredential: () => "present" })).toMatchObject({ ok: true, providerId: "codex-oauth" });
    // An `unknown` row is still a candidate -- it is ordered last in its tier, never filtered out,
    // and it is never reported as "no credential configured".
    const allUnknown = resolveSlotToProvider({ ...base, active, requested: "astra", hasCredential: () => "unknown" });
    expect(allUnknown).toMatchObject({ ok: true, providerId: "codex-oauth" });
    const absent = resolveSlotToProvider({ ...base, active, requested: "astra", hasCredential: (p) => (p === "openai" ? "unknown" : "absent") });
    expect(absent).toMatchObject({ ok: true, providerId: "openai" });
    expect(absent.ok === false && absent.wouldServe).toBe(false);
  });

  test("preferredProviders reorders the non-vendor tail", () => {
    // A gemini session with no Google credential: both survivors are aggregators, so the ONLY thing
    // that can order them is step 3-ii and then the admission tier.
    const active = computeActiveSlotSet({ catalog, currentModelKey: "google/gemini-3.7-flash", customSlots: undefined });
    const hasCredential = (p: string): CredentialPresence => (p !== "google" ? "present" : "absent");
    const byTier = resolveSlotToProvider({ ...base, active, requested: "flash", hasCredential });
    expect(byTier).toMatchObject({ ok: true, providerId: "openrouter" }); // fetched-document beats pinned-upstream
    const byPreference = resolveSlotToProvider({ ...base, preferredProviders: ["zenmux"], active, requested: "flash", hasCredential });
    expect(byPreference).toMatchObject({ ok: true, providerId: "zenmux" });
  });

  test("a disabled provider is skipped and named in wouldServe", () => {
    const active = gptSession();
    const r = resolveSlotToProvider({
      ...base,
      active,
      requested: "astra",
      hasCredential: () => "present",
      providerEnabled: (p) => p !== "openai" && p !== "codex-oauth" && p !== "openrouter",
    });
    expect(r).toMatchObject({ ok: false, code: "slot-unservable" });
    expect(!r.ok && r.wouldServe.map((w) => w.why)).toContain("disabled in settings");
    expect(!r.ok && r.message).toContain("gpt-6-astra");
    expect(!r.ok && r.message).toContain("openai/gpt-6-astra");
  });

  test("no credential is named as such, and never confused with a disabled provider", () => {
    const r = resolveSlotToProvider({ ...base, active: gptSession(), requested: "astra", hasCredential: () => "absent" });
    expect(r).toMatchObject({ ok: false, code: "slot-unservable" });
    expect(!r.ok && r.wouldServe.map((w) => w.why)).toEqual(["no credential configured", "no credential configured", "no credential configured"]);
  });

  test("a slot whose rows cannot serve a chat turn is unservable with an empty wouldServe", () => {
    const r = resolveSlotToProvider({ ...base, active: gptSession(), requested: "terra", hasCredential: () => "present" });
    expect(r).toMatchObject({ ok: false, code: "slot-unservable", wouldServe: [] });
    expect(!r.ok && r.message).toContain("gpt-5.6-terra");
  });

  test("a unique foreign name resolves; an ambiguous one refuses with both candidates; the Claude names always go to claude", () => {
    const active = gptSession();
    const foreign = resolveSlotToProvider({ ...base, active, requested: "opus", hasCredential: () => "present" });
    expect(foreign).toMatchObject({ ok: true, providerId: "anthropic" });
    // M-1: an UNADVERTISED foreign name records the source of the slot that resolved (`family-default`),
    // not of the set that happened to be active -- the record is a statement about where the slot came
    // from, and a claude-pinned session resolving `luna` did not get it from the pinned set.
    expect(foreign.ok && foreign.slot).toEqual({ family: "claude", name: "opus", source: "family-default" });
    const claudePinned = computeActiveSlotSet({ catalog, currentModelKey: "anthropic/claude-opus-5", customSlots: undefined });
    const fromPinned = resolveSlotToProvider({ ...base, active: claudePinned, requested: "luna", hasCredential: () => "present" });
    expect(fromPinned.ok && fromPinned.slot).toEqual({ family: "gpt", name: "luna", source: "family-default" });
    // ...while an ADVERTISED name keeps the active set's own source.
    const advertised = resolveSlotToProvider({ ...base, active: claudePinned, requested: "opus", hasCredential: () => "present" });
    expect(advertised.ok && advertised.slot).toEqual({ family: "claude", name: "opus", source: "claude-pinned" });
    const ambiguous = resolveSlotToProvider({ ...base, active, requested: "flash", hasCredential: () => "present" });
    expect(ambiguous).toMatchObject({ ok: false, code: "ambiguous-slot-name" });
    expect(!ambiguous.ok && ambiguous.message).toContain("gemini/flash");
    expect(!ambiguous.ok && ambiguous.message).toContain("deepseek/flash");
  });

  test("an unknown name is a typed unknown-slot refusal, never a substitution", () => {
    const r = resolveSlotToProvider({ ...base, active: gptSession(), requested: "turbo", hasCredential: () => "present" });
    expect(r).toMatchObject({ ok: false, code: "unknown-slot", wouldServe: [] });
  });

  test("a custom slot's pinned provider is honoured or unservable", () => {
    const customSlots = [{ name: "master", model: "gpt-6-astra", provider: "openrouter" }];
    const active = computeActiveSlotSet({ catalog, currentModelKey: "openai/gpt-6-astra", customSlots });
    const ok = resolveSlotToProvider({ ...base, active, customSlots, requested: "master", hasCredential: () => "present" });
    expect(ok).toMatchObject({ ok: true, providerId: "openrouter", modelKey: "openrouter/openai/gpt-6-astra" });
    expect(ok.ok && ok.slot).toEqual({ family: "gpt", name: "master", source: "custom" });
    const refused = resolveSlotToProvider({ ...base, active, customSlots, requested: "master", hasCredential: (p) => (p !== "openrouter" ? "present" : "absent") });
    expect(refused).toMatchObject({ ok: false, code: "slot-unservable" });
    // The two OTHER rows must be named as "pinned elsewhere", never silently substituted.
    expect(!refused.ok && refused.wouldServe.map((w) => w.why)).toContain('pinned provider is "openrouter"');
  });

  test("the own-model slot resolves by its own name", () => {
    const active = computeActiveSlotSet({ catalog, currentModelKey: "doubao/doubao-seed-2.0", customSlots: undefined });
    const r = resolveSlotToProvider({ ...base, active, requested: "doubao-seed-2.0", hasCredential: () => "present" });
    expect(r).toMatchObject({ ok: true, providerId: "doubao", modelKey: "doubao/doubao-seed-2.0" });
    expect(r.ok && r.slot).toEqual({ family: "other", name: "doubao-seed-2.0", source: "own-model" });
  });

  test("a full catalog key or canonical id passes through unchanged", () => {
    const active = gptSession();
    const byKey = resolveSlotToProvider({ ...base, active, requested: "openai/gpt-6-astra", hasCredential: () => "present" });
    expect(byKey).toMatchObject({ ok: true, modelKey: "openai/gpt-6-astra", providerId: "openai", viaSlotName: false });
    const byCanonical = resolveSlotToProvider({ ...base, active, requested: "gpt-6-astra", hasCredential: () => "present" });
    expect(byCanonical).toMatchObject({ ok: true, modelKey: "codex-oauth/gpt-6-astra", viaSlotName: false });
    const bySlot = resolveSlotToProvider({ ...base, active, requested: "astra", hasCredential: () => "present" });
    expect(bySlot).toMatchObject({ viaSlotName: true });
  });

  // THE REGRESSION TRIPWIRE. `resolveChildModel`'s default is `config.model` — a full key that may
  // be an `allowUnlisted` pass-through with no catalog row at all. Filtering it here would refuse
  // every child spawn a session with an unlisted model has ever made.
  test("a qualified key with no catalog row passes through verbatim, unfiltered", () => {
    const r = resolveSlotToProvider({
      ...base,
      active: gptSession(),
      requested: "openrouter/some-vendor/never-seeded",
      hasCredential: () => "absent",
      providerEnabled: () => false,
    });
    expect(r).toMatchObject({ ok: true, modelKey: "openrouter/some-vendor/never-seeded", providerId: "openrouter", viaSlotName: false });
  });

  test("the reserved winter-test namespace passes through like any other qualified key", () => {
    const r = resolveSlotToProvider({ ...base, active: gptSession(), requested: "winter-test/echo", hasCredential: () => "absent", providerEnabled: () => false });
    expect(r).toMatchObject({ ok: true, modelKey: "winter-test/echo", viaSlotName: false });
  });
});
