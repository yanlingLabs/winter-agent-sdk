// WS-23 (reasoning-state) review r1: the switch fit estimate -- the budget is the auto-compaction
// trigger's own `window x threshold` (I-1), images and documents cost a fixed amount per item (I-2), and
// non-ASCII text counts about a token per character (M-6).
import { describe, expect, test } from "bun:test";
import type { SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";
import type { WinterCatalog, WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { DOCUMENT_PAGE_TOKENS, IMAGE_TOKENS, estimateTextTokens, estimateValueTokens, fitBudgetTokens, fitVerdict } from "./fit.ts";
import { reviewModelSwitch } from "./switch-review.ts";
import type { ContinuityEndpoint } from "./domains.ts";

describe("I-1: the budget is window x threshold, never less the row's maximum output", () => {
  test("a row whose maximum output equals its window still takes a normal history", () => {
    expect(fitBudgetTokens(200_000, 0.92)).toBe(184_000);
    expect(fitVerdict(30_000, 200_000, 0.92).fits).toBe(true);
  });

  test("through the review, on a catalog row with maxOutput === contextWindow", () => {
    const row: WinterModelDescriptor = {
      key: "minimax/m2-like",
      providerId: "minimax",
      upstreamId: "m2-like",
      modelFamily: "minimax",
      canonicalModelId: "m2-like",
      displayName: "m2-like",
      aliases: [],
      endpoints: ["chat"],
      inputModalities: { value: ["text"], source: "winter-default", confidence: "unknown" },
      outputModalities: { value: ["text"], source: "winter-default", confidence: "unknown" },
      toolCalling: { value: "native", source: "winter-default", confidence: "unknown" },
      nativeTools: { value: false, source: "winter-default", confidence: "unknown" },
      unsupportedParameters: [],
      status: "candidate",
      contextWindow: { value: 204_800, source: "winter-default", confidence: "unknown" },
      maxOutputTokens: { value: 204_800, source: "winter-default", confidence: "unknown" },
    };
    const catalog = { schemaVersion: 2, catalogVersion: "t", upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" }, providers: [], families: [], models: [row] } as unknown as WinterCatalog;
    const entries: SessionStoreEntry[] = [
      { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "x".repeat(40_000) } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ];
    const from: ContinuityEndpoint = { providerId: "openai", modelKey: "openai/gpt-x", family: "openai", readableState: "none", continuation: "opaque-provider-state" };
    const to: ContinuityEndpoint = { providerId: "minimax", modelKey: "minimax/m2-like", family: "openai", readableState: "none" };
    const review = reviewModelSwitch({ entries, sidecarRecords: [], from, to, catalog });
    expect(review.fits).toBe(true);
    expect(review.prompt).toBe(false);
  });
});

describe("I-2: images and documents are charged per item, never by their bytes", () => {
  test("a 1 MB screenshot is one image", () => {
    const screenshot = { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(1024 * 1024 * 4 / 3) } };
    const tokens = estimateValueTokens([{ type: "text", text: "look" }, screenshot]);
    expect(tokens).toBeGreaterThanOrEqual(IMAGE_TOKENS);
    expect(tokens).toBeLessThan(IMAGE_TOKENS + 100);
  });

  test("nested inside a tool_result, and on every carrier's spelling", () => {
    const img = (type: string) => ({ type, source: { type: "base64", media_type: "image/png", data: "B".repeat(500_000) } });
    const tokens = estimateValueTokens([{ type: "tool_result", tool_use_id: "t", content: [img("image"), img("input_image")] }]);
    expect(tokens).toBeLessThan(2 * IMAGE_TOKENS + 100);
  });

  test("a PDF costs its pages: declared, or counted from its own page objects", () => {
    expect(estimateValueTokens({ type: "document", page_count: 12, source: { type: "base64", data: "C".repeat(900_000) } })).toBeLessThan(12 * DOCUMENT_PAGE_TOKENS + 100);
    const pdf = Buffer.from("%PDF-1.7\n1 0 obj << /Type /Pages /Count 3 >>\n2 0 obj << /Type /Page >>\n3 0 obj << /Type /Page >>\n4 0 obj << /Type/Page >>\n").toString("base64");
    const tokens = estimateValueTokens({ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf } });
    expect(tokens).toBeGreaterThanOrEqual(3 * DOCUMENT_PAGE_TOKENS);
    expect(tokens).toBeLessThan(3 * DOCUMENT_PAGE_TOKENS + 100);
  });
});

describe("M-6: non-ASCII text is counted at about a token per character", () => {
  test("CJK is not underestimated threefold", () => {
    const cjk = "漢".repeat(3_500);
    expect(estimateTextTokens(cjk)).toBeGreaterThanOrEqual(3_500);
    expect(estimateTextTokens("a".repeat(3_500))).toBe(Math.ceil(1_000 * 1.1));
  });

  test("a surrogate pair is one character", () => {
    expect(estimateTextTokens("😀")).toBe(estimateTextTokens("é"));
  });
});
