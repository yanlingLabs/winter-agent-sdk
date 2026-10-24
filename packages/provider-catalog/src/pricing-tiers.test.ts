// 0.0.56 (W4): prompt-length price tiers in the catalog schema, and the 0.0.56 rows (W2, W7, W1).
import { describe, expect, test } from "bun:test";
import catalogJson from "../generated/catalog.json" with { type: "json" };
import catalogSchema from "../schema/catalog.schema.json" with { type: "json" };
import { loadCatalog, validateCatalog } from "./index.ts";
import type { WinterCatalog } from "./types.ts";

const catalog = loadCatalog();
const row = (key: string) => {
  const found = catalog.models.find((m) => m.key === key);
  if (found === undefined) throw new Error(`no catalog row ${key}`);
  return found;
};

/** The shipped catalog with ONE row's pricing value replaced. */
function withHaikuPricing(value: unknown): unknown {
  const copy = structuredClone(catalogJson) as unknown as WinterCatalog;
  const haiku = copy.models.find((m) => m.key === "anthropic/claude-haiku-5-5")!;
  (haiku.pricing as { value: unknown }).value = value;
  return copy;
}

function messages(result: ReturnType<typeof validateCatalog>): string[] {
  return result.ok ? [] : result.errors.map((e) => `${e.code} ${e.path}: ${e.message}`);
}

describe("longContextTiers validation", () => {
  const base = { inputPerMTokUsd: 0.1, outputPerMTokUsd: 0.5 };
  const tier = (minPromptTokens: unknown, extra: Record<string, unknown> = {}) => ({ minPromptTokens, inputPerMTokUsd: 0.5, outputPerMTokUsd: 2.5, ...extra });

  test("a flat row (no tiers) and a tiered row both validate", () => {
    expect(validateCatalog(withHaikuPricing(base)).ok).toBe(true);
    expect(validateCatalog(withHaikuPricing({ ...base, longContextTiers: [tier(100001), tier(500000)] })).ok).toBe(true);
  });

  test("tiers must be STRICTLY ascending: a repeated or descending threshold is refused", () => {
    expect(messages(validateCatalog(withHaikuPricing({ ...base, longContextTiers: [tier(100001), tier(100001)] }))).join("\n")).toContain("pricing-tier-order");
    expect(messages(validateCatalog(withHaikuPricing({ ...base, longContextTiers: [tier(500000), tier(100001)] }))).join("\n")).toContain("pricing-tier-order");
  });

  test("a threshold must be a positive integer; rates finite and non-negative; no unknown fields; no empty list", () => {
    for (const bad of [0, -1, 1.5, "100000", null]) expect(messages(validateCatalog(withHaikuPricing({ ...base, longContextTiers: [tier(bad)] }))).join("\n")).toContain("pricing-tier-invalid");
    expect(validateCatalog(withHaikuPricing({ ...base, longContextTiers: [tier(1, { outputPerMTokUsd: -1 })] })).ok).toBe(false);
    expect(validateCatalog(withHaikuPricing({ ...base, longContextTiers: [tier(1, { cacheReadPerMTokUsd: Number.NaN })] })).ok).toBe(false);
    expect(validateCatalog(withHaikuPricing({ ...base, longContextTiers: [tier(1, { cacheWrite1hPerMTokUsd: 1 })] })).ok).toBe(false);
    expect(validateCatalog(withHaikuPricing({ ...base, longContextTiers: [] })).ok).toBe(false);
  });

  test("the JSON Schema states the same shape", () => {
    const pricing = (catalogSchema as unknown as { $defs: Record<string, { properties: { value: { properties: Record<string, { items?: { required: string[]; additionalProperties: boolean } }> } } }> }).$defs["evidencePricing"]!.properties.value.properties;
    expect(pricing["longContextTiers"]!.items!.required).toEqual(["minPromptTokens", "inputPerMTokUsd", "outputPerMTokUsd"]);
    expect(pricing["longContextTiers"]!.items!.additionalProperties).toBe(false);
  });
});

describe("0.0.56 rows", () => {
  test("anthropic/claude-haiku-5-5: the vendor's two tiers, the threshold 'over 100,000' written inclusively as 100001", () => {
    const haiku = row("anthropic/claude-haiku-5-5");
    expect(haiku.pricing!.value).toEqual({
      inputPerMTokUsd: 0.1,
      outputPerMTokUsd: 0.5,
      cacheWritePerMTokUsd: 0.125,
      cacheReadPerMTokUsd: 0.01,
      longContextTiers: [{ minPromptTokens: 100001, inputPerMTokUsd: 0.5, outputPerMTokUsd: 2.5, cacheWritePerMTokUsd: 0.625, cacheReadPerMTokUsd: 0.05 }],
    });
    expect([haiku.contextWindow!.value, haiku.maxOutputTokens!.value, haiku.toolCalling.value, haiku.promptCaching!.value]).toEqual([1000000, 128000, "native", true]);
    expect(haiku.inputModalities.value).toContain("image");
    expect(haiku.reasoning!.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(haiku.reasoning!.defaultEffort).toBe("medium");
    expect(haiku.reasoning!.continuation).toBe("opaque-provider-state");
    expect(haiku.unsupportedParameters).toContain("thinking.type.disabled+output_config.effort.max");
  });

  test("the three new OpenRouter rows carry every field the consumer reads", () => {
    for (const key of ["openrouter/anthropic/claude-haiku-5.5", "openrouter/openai/gpt-6.1-sol", "openrouter/meta/muse-spark-1.3-contributor"]) {
      const r = row(key);
      expect([key, r.pricing?.source, r.toolCalling.value, r.inputModalities.value.includes("image"), r.reasoning!.efforts.length > 0, typeof r.contextWindow?.value, typeof r.maxOutputTokens?.value, r.promptCaching?.value]).toEqual([key, "official-doc", "native", true, true, "number", "number", true]);
    }
    expect(row("openrouter/anthropic/claude-haiku-5.5").pricing!.value.longContextTiers).toEqual([{ minPromptTokens: 100000, inputPerMTokUsd: 0.5, outputPerMTokUsd: 2.5, cacheReadPerMTokUsd: 0.05, cacheWritePerMTokUsd: 0.625 }]);
    expect(row("openrouter/openai/gpt-6.1-sol").pricing!.value.longContextTiers![0]!.minPromptTokens).toBe(272000);
  });

  test("W7: the OpenRouter reasoning routes replay reasoning_details (opaque state, own-route domain); Muse Spark stays 'none'", () => {
    for (const key of ["openrouter/anthropic/claude-haiku-5.5", "openrouter/anthropic/claude-sonnet-5.5", "openrouter/deepseek/deepseek-v4.1-flash", "openrouter/openai/gpt-6-luna", "openrouter/openai/gpt-6.1-sol"]) {
      expect([key, row(key).reasoning!.continuation, row(key).reasoning!.continuationDomain!.value]).toEqual([key, "opaque-provider-state", [key]]);
    }
    expect(row("openrouter/meta/muse-spark-1.3-contributor").reasoning!.continuation).toBe("none");
  });

  test("W1: every openrouter/anthropic/* row declares promptCaching", () => {
    const rows = catalog.models.filter((m) => m.key.startsWith("openrouter/anthropic/"));
    expect(rows.length).toBeGreaterThan(4);
    for (const r of rows) expect([r.key, r.promptCaching?.value]).toEqual([r.key, true]);
  });
});
