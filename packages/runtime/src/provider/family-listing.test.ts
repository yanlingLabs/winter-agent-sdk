// WS-13c §7: `buildModelFamilyListing`'s own tests. A typed fixture catalog built LOCALLY from the
// spine's pure helpers (`packages/provider-catalog/src/families.ts`) — never Lane A's `slots.test.ts`
// fixture, per the P6.6 ownership map (each lane owns its own fixture so the two never drift
// together silently).
import { describe, expect, test } from "bun:test";
import { buildModelFamilyListing } from "./family-listing.ts";
import { stampFamilyFields } from "@yanlinglabs/winter-provider-catalog";
import type { ModelFamilyDescriptor, ModelStatus, WinterCatalog, WinterModelDescriptor, WinterProviderDescriptor } from "@yanlinglabs/winter-provider-catalog";
import type { ActiveSlotSet } from "@yanlinglabs/winter-agent-sdk";

// --- fixture --------------------------------------------------------------------------------------
//
// `RawRow` is `WinterModelDescriptor` minus the two fields `stampFamilyFields` derives
// (`modelFamily`/`canonicalModelId`). `stampRow` is the one-line identity helper that gives each row
// literal a CONTEXTUAL type before it goes into the array `stampFamilyFields` is called on — without
// it, TS infers each literal's own widened shape (`status: string`, not the `ModelStatus` union), the
// generic `stampFamilyFields<T>` infers that widened `T`, and the result stops being assignable to
// `WinterCatalog.models: WinterModelDescriptor[]`.
type RawRow = Omit<WinterModelDescriptor, "modelFamily" | "canonicalModelId">;
const stampRow = (row: RawRow): RawRow => row;

function baseRow(key: string, providerId: string, upstreamId: string, displayName: string, status: ModelStatus = "candidate"): RawRow {
  return stampRow({
    key,
    providerId,
    upstreamId,
    displayName,
    aliases: [],
    endpoints: ["chat"],
    inputModalities: { value: ["text"], source: "winter-default", confidence: "unknown" },
    outputModalities: { value: ["text"], source: "winter-default", confidence: "unknown" },
    toolCalling: { value: "native", source: "winter-default", confidence: "unknown" },
    nativeTools: { value: true, source: "winter-default", confidence: "unknown" },
    unsupportedParameters: [],
    status,
  });
}

function baseProvider(id: string, pricingBasis: WinterProviderDescriptor["pricingBasis"]): WinterProviderDescriptor {
  return {
    id,
    displayName: id,
    protocols: ["openai-responses"],
    authKinds: ["api-key"],
    defaultEndpoints: {},
    modelDiscovery: "none",
    liveCatalogAuthority: "unknown",
    adapterId: id,
    family: id,
    upstream: { project: "winter", commit: "", sourcePaths: [] },
    risk: { class: "approved", reasons: [] },
    scope: "llm",
    pricingBasis,
    admission: { basis: "api-key", citation: "local", tier: "local" },
  };
}

function slot(name: string, canonicalModelId: string): ModelFamilyDescriptor["slots"][number] {
  return { name, canonicalModelId, description: "d", reason: "r", basis: "user-ruling", citation: "c", status: "candidate" };
}

// codepoint order would be claude < gpt < other < qwen; the fixture pins `other` after `qwen`
// specifically so the "other always last" rule has something real to override (WS-13c §7).
const FAMILIES: ModelFamilyDescriptor[] = [
  {
    id: "gpt",
    displayName: "GPT",
    vendor: "OpenAI",
    vendorProviders: ["codex-oauth", "openai"],
    matchers: [{ pattern: "^gpt-(?!oss)", note: "" }],
    status: "candidate",
    citation: "c",
    slots: [slot("astra", "gpt-6-astra"), slot("sol", "gpt-5.6-sol"), slot("terra", "gpt-5.6-terra"), slot("luna", "gpt-5.6-luna")],
  },
  {
    id: "qwen",
    displayName: "Qwen",
    vendor: "Alibaba",
    vendorProviders: ["qwen-cloud"],
    matchers: [{ pattern: "^qwen", note: "" }],
    status: "candidate",
    citation: "c",
    slots: [slot("max", "qwen3.8-max")],
  },
  { id: "other", displayName: "Other", vendor: "", vendorProviders: [], matchers: [], status: "candidate", citation: "c", slots: [] },
];

const PROVIDERS: WinterProviderDescriptor[] = [
  baseProvider("openai", "token"),
  baseProvider("codex-oauth", "subscription"),
  baseProvider("openrouter", "token"),
  baseProvider("beta-provider", "token"),
  baseProvider("legacy-provider", "token"),
  baseProvider("qwen-cloud", "token"),
  baseProvider("vendor-x", "token"),
];

const RAW_ROWS: RawRow[] = [
  baseRow("openai/gpt-6-astra", "openai", "gpt-6-astra", "GPT-6 Astra (OpenAI)"),
  baseRow("codex-oauth/gpt-6-astra", "codex-oauth", "gpt-6-astra", "GPT-6 Astra (Codex)"),
  baseRow("openrouter/gpt-6-astra", "openrouter", "gpt-6-astra", "GPT-6 Astra (OpenRouter)"),
  baseRow("openai/gpt-5.6-sol", "openai", "gpt-5.6-sol", "GPT-5.6 Sol"),
  baseRow("openai/gpt-5.6-terra", "openai", "gpt-5.6-terra", "GPT-5.6 Terra"),
  // Same upstreamId as the live Terra row above -> the SAME canonicalModelId, on a provider whose
  // row is blocked: proves the omission is row-scoped, not canonical-id-scoped.
  baseRow("beta-provider/gpt-5.6-terra", "beta-provider", "gpt-5.6-terra", "GPT-5.6 Terra (beta, blocked)", "blocked"),
  baseRow("openai/gpt-5.6-luna", "openai", "gpt-5.6-luna", "GPT-5.6 Luna"),
  baseRow("legacy-provider/gpt-5.6-luna", "legacy-provider", "gpt-5.6-luna", "GPT-5.6 Luna (legacy, deprecated)", "deprecated"),
  baseRow("qwen-cloud/qwen3.8-max", "qwen-cloud", "qwen3.8-max", "Qwen3.8 Max"),
  // Matches no family's matcher -> familyIdOf's OTHER_FAMILY_ID fallback (families.test.ts's own
  // "other when nothing matches" precedent, rebuilt here rather than imported).
  baseRow("vendor-x/doubao-seed-2.0", "vendor-x", "doubao-seed-2.0", "Doubao Seed 2.0"),
];

const catalog: WinterCatalog = {
  schemaVersion: 2,
  catalogVersion: "0.0.0-test",
  upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" },
  providers: PROVIDERS,
  models: stampFamilyFields(RAW_ROWS, FAMILIES),
  families: FAMILIES,
};

describe("buildModelFamilyListing", () => {
  test("families carry their slots and every model grouped by canonical id with per-row servable states", () => {
    // P7a: `servable` is the TRI-STATE `ModelRowServable`, not a boolean. This seam's own predicate
    // is still two-valued, so it renders exactly two of the three states and never `"unknown"` --
    // asserted here as the LITERAL strings, because `"absent"` is truthy and a test written against
    // truthiness would pass against a listing that had silently stopped distinguishing them.
    const listing = buildModelFamilyListing({ catalog, active: undefined, servable: (p) => p === "openai" });
    const gpt = listing.families.find((f) => f.id === "gpt")!;
    expect(gpt.slots.map((s) => s.name)).toEqual(["astra", "sol", "terra", "luna"]);
    const astra = gpt.models.find((m) => m.canonicalModelId === "gpt-6-astra")!;
    expect(astra.rows.map((r) => [r.providerId, r.servable])).toEqual(
      expect.arrayContaining([
        ["openai", "present"],
        ["codex-oauth", "absent"],
        ["openrouter", "absent"],
      ]),
    );
    expect(astra.rows.some((r) => r.servable === "unknown")).toBe(false);
  });

  test("blocked and deprecated rows are omitted; families are sorted by id; other is last", () => {
    const listing = buildModelFamilyListing({ catalog, active: undefined, servable: () => true });
    expect(listing.families.map((f) => f.id)).toEqual(["gpt", "qwen", "other"]);

    const gpt = listing.families.find((f) => f.id === "gpt")!;
    const terra = gpt.models.find((m) => m.canonicalModelId === "gpt-5.6-terra")!;
    expect(terra.rows.map((r) => r.key)).toEqual(["openai/gpt-5.6-terra"]); // the blocked sibling row is gone
    const luna = gpt.models.find((m) => m.canonicalModelId === "gpt-5.6-luna")!;
    expect(luna.rows.map((r) => r.key)).toEqual(["openai/gpt-5.6-luna"]); // the deprecated sibling row is gone

    const other = listing.families.find((f) => f.id === "other")!;
    expect(other.models.map((m) => m.canonicalModelId)).toEqual(["doubao-seed-2.0"]);
  });

  test("active is passed through verbatim and slot views gain resolvesTo when a resolver is given", () => {
    const active: ActiveSlotSet = {
      family: "gpt",
      source: "family-default",
      slots: [{ name: "astra", canonicalModelId: "gpt-6-astra", description: "d", reason: "r" }],
    };
    const resolveSlot = (canonicalModelId: string): { providerId: string; key: string } | undefined =>
      canonicalModelId === "gpt-6-astra" ? { providerId: "openai", key: "openai/gpt-6-astra" } : undefined;

    const listing = buildModelFamilyListing({ catalog, active, servable: () => true, resolveSlot });

    expect(listing.active).toBe(active); // verbatim passthrough, not a re-derivation

    const gpt = listing.families.find((f) => f.id === "gpt")!;
    const astraSlot = gpt.slots.find((s) => s.name === "astra")!;
    expect(astraSlot.resolvesTo).toEqual({ providerId: "openai", key: "openai/gpt-6-astra" });
    // sol's canonical id isn't handled by this test's resolver -> undefined -> key OMITTED, not
    // present-with-value-undefined (toEqual would treat those as equal; hasOwn does not).
    const solSlot = gpt.slots.find((s) => s.name === "sol")!;
    expect(solSlot.resolvesTo).toBeUndefined();
    expect(Object.hasOwn(solSlot, "resolvesTo")).toBe(false);
  });

  test("pricingBasis on each row joins to the serving provider's own pricingBasis, and a canonical model's displayName is its first row's", () => {
    const listing = buildModelFamilyListing({ catalog, active: undefined, servable: () => true });
    const gpt = listing.families.find((f) => f.id === "gpt")!;
    const astra = gpt.models.find((m) => m.canonicalModelId === "gpt-6-astra")!;
    expect(astra.displayName).toBe("GPT-6 Astra (OpenAI)"); // the first row pushed for this canonical id
    expect(astra.rows.find((r) => r.providerId === "openai")!.pricingBasis).toBe("token");
    expect(astra.rows.find((r) => r.providerId === "codex-oauth")!.pricingBasis).toBe("subscription");
  });
});
