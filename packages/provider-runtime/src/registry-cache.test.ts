// WS-23 item 6: a 1-hour cache write is priced at twice the input rate; the rest of the writes keep
// the row's own cache-write rate.
import { describe, expect, test } from "bun:test";
import type { WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { stampFamilyFields } from "@yanlinglabs/winter-provider-catalog";
import { estimateCostUsd, ONE_HOUR_CACHE_WRITE_INPUT_MULTIPLIER } from "./registry.ts";

const row = (): WinterModelDescriptor =>
  stampFamilyFields(
    [
      <Omit<WinterModelDescriptor, "modelFamily" | "canonicalModelId">>{
        key: "anthropic/claude-opus-5-5",
        providerId: "anthropic",
        upstreamId: "claude-opus-5-5",
        displayName: "Claude Opus 5.5",
        aliases: [],
        endpoints: ["chat"],
        inputModalities: { value: ["text"], source: "official-doc", confidence: "declared" },
        outputModalities: { value: ["text"], source: "official-doc", confidence: "declared" },
        toolCalling: { value: "native", source: "official-doc", confidence: "declared" },
        nativeTools: { value: true, source: "official-doc", confidence: "declared" },
        pricing: { value: { inputPerMTokUsd: 10, outputPerMTokUsd: 50, cacheReadPerMTokUsd: 1, cacheWritePerMTokUsd: 12.5 }, source: "official-doc", confidence: "declared" },
        unsupportedParameters: [],
        status: "candidate",
      },
    ],
    [],
  )[0]!;

describe("1-hour cache writes (WS-23 item 6)", () => {
  test("the 1-hour share of the writes costs 2x input; the rest the row's own 5-minute write rate", () => {
    expect(ONE_HOUR_CACHE_WRITE_INPUT_MULTIPLIER).toBe(2);
    const { costUsd } = estimateCostUsd({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 3_000_000, cacheWrite1hTokens: 1_000_000 }, row());
    // 2M x $12.50 (5-minute) + 1M x $20 (2 x $10 input)
    expect(costUsd).toBeCloseTo(25 + 20, 10);
  });

  test("with no 1-hour share the price is exactly what it was before", () => {
    expect(estimateCostUsd({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 }, row()).costUsd).toBeCloseTo(12.5, 10);
  });

  test("a malformed 1-hour count larger than the writes is clamped, never priced twice", () => {
    expect(estimateCostUsd({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 5_000_000 }, row()).costUsd).toBeCloseTo(20, 10);
  });
});
