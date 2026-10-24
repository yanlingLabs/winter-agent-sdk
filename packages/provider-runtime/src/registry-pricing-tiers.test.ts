// 0.0.56 (W4, W5): estimateCostUsd prices a request at the long-context tier its whole prompt reaches,
// and carries the provider's reported cost beside the estimate.
import { describe, expect, test } from "bun:test";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { estimateCostUsd, pricingTierFor } from "./registry.ts";

const catalog = loadCatalog();
const haiku = catalog.models.find((m) => m.key === "anthropic/claude-haiku-5-5")!;
const sonnet = catalog.models.find((m) => m.key === "anthropic/claude-sonnet-5-5")!;
const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-12);

describe("long-context tiers (Claude Haiku 5.5: over 100,000 prompt tokens)", () => {
  test("100,000 prompt tokens is the BASE tier; 100,001 is the long tier -- the boundary, both sides", () => {
    const at = estimateCostUsd({ inputTokens: 100_000, outputTokens: 1_000 }, haiku);
    close(at.costUsd, (100_000 / 1e6) * 0.1 + (1_000 / 1e6) * 0.5);
    expect(at.pricingTierMinPromptTokens).toBeUndefined();
    const over = estimateCostUsd({ inputTokens: 100_001, outputTokens: 1_000 }, haiku);
    close(over.costUsd, (100_001 / 1e6) * 0.5 + (1_000 / 1e6) * 2.5);
    expect(over.pricingTierMinPromptTokens).toBe(100_001);
  });

  test("the threshold counts cache reads and writes too, and the tier prices the WHOLE request, cache rates included", () => {
    const usage = { inputTokens: 1_000, outputTokens: 2_000, cacheReadTokens: 90_000, cacheWriteTokens: 10_000, cacheWrite1hTokens: 4_000 };
    const est = estimateCostUsd(usage, haiku);
    expect(est.pricingTierMinPromptTokens).toBe(100_001);
    close(est.costUsd, (1_000 / 1e6) * 0.5 + (2_000 / 1e6) * 2.5 + (90_000 / 1e6) * 0.05 + (6_000 / 1e6) * 0.625 + (4_000 / 1e6) * 0.5 * 2);
    // Exactly 100,000 in all (1,000 + 89,000 + 10,000): every rate falls back to the base tier.
    const below = estimateCostUsd({ ...usage, cacheReadTokens: 89_000 }, haiku);
    expect(below.pricingTierMinPromptTokens).toBeUndefined();
    close(below.costUsd, (1_000 / 1e6) * 0.1 + (2_000 / 1e6) * 0.5 + (89_000 / 1e6) * 0.01 + (6_000 / 1e6) * 0.125 + (4_000 / 1e6) * 0.1 * 2);
  });

  test("the HIGHEST tier the prompt reaches wins, whatever order the tiers are read in", () => {
    const pricing = { inputPerMTokUsd: 1, outputPerMTokUsd: 1, longContextTiers: [{ minPromptTokens: 10, inputPerMTokUsd: 2, outputPerMTokUsd: 2 }, { minPromptTokens: 20, inputPerMTokUsd: 3, outputPerMTokUsd: 3 }] };
    expect(pricingTierFor(pricing, 9).minPromptTokens).toBeUndefined();
    expect(pricingTierFor(pricing, 10).minPromptTokens).toBe(10);
    expect(pricingTierFor(pricing, 19).rates.inputPerMTokUsd).toBe(2);
    expect(pricingTierFor(pricing, 20).rates.inputPerMTokUsd).toBe(3);
    expect(pricingTierFor({ ...pricing, longContextTiers: [...pricing.longContextTiers].reverse() }, 25).rates.inputPerMTokUsd).toBe(3);
  });

  test("a flat-priced row is priced exactly as before 0.0.56", () => {
    const est = estimateCostUsd({ inputTokens: 900_000, outputTokens: 10_000, cacheReadTokens: 50_000 }, sonnet);
    close(est.costUsd, 0.9 * 2 + 0.01 * 10 + 0.05 * 0.2);
    expect(est).toEqual({ costUsd: est.costUsd, costBasis: "list" });
  });
});

describe("the provider's reported cost (W5)", () => {
  test("rides beside the estimate, verbatim", () => {
    expect(estimateCostUsd({ inputTokens: 10, outputTokens: 10, reportedCostUsd: 0.0123 }, sonnet).reportedCostUsd).toBe(0.0123);
  });
  test("is carried even for an unpriced route, whose estimate stays 0 / unknown", () => {
    expect(estimateCostUsd({ inputTokens: 10, outputTokens: 10, reportedCostUsd: 0.5 }, undefined)).toEqual({ costUsd: 0, costBasis: "unknown", reportedCostUsd: 0.5 });
  });
  test("a malformed report (negative, NaN) is dropped, never surfaced", () => {
    expect(estimateCostUsd({ inputTokens: 1, outputTokens: 1, reportedCostUsd: -1 }, sonnet).reportedCostUsd).toBeUndefined();
    expect(estimateCostUsd({ inputTokens: 1, outputTokens: 1, reportedCostUsd: Number.NaN }, sonnet).reportedCostUsd).toBeUndefined();
  });
});
