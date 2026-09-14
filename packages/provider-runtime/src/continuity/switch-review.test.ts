import { describe, expect, test } from "bun:test";
import type { SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";
import type { WinterCatalog, WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { reviewModelSwitch, switchFactsFor } from "./switch-review.ts";
import type { ProviderStateRecord } from "./claude-ready.ts";
import type { ContinuityEndpoint } from "./domains.ts";

// Fix round 2 (controller ruling): `reviewModelSwitch`'s own "same-family" skip compares MODEL
// LINEAGE (WS-13c's `modelFamily`), resolved through a real-or-injected catalog -- never the fake
// endpoints' own `.family` string (that field is now read ONLY for `ContinuityEndpoint.family`'s
// other purposes, e.g. `classifySwitch`'s prose). SONNET/OPUS/TERRA/LUNA below are fixture keys that
// do not exist in the REAL compiled catalog, so a same-family test for them needs its own tiny
// injected catalog naming their lineage explicitly -- every OTHER fixture key here (GPT/CLAUDE/
// DEEPSEEK/GLM) is deliberately left OUT of it, so it resolves "unknown family" against both the
// real catalog and this one, which is exactly the fact those tests need ("no family evidence on
// either side never buys a same-family skip").
function familyRow(key: string, providerId: string, modelFamily: string): WinterModelDescriptor {
  return {
    key,
    providerId,
    upstreamId: key.slice(providerId.length + 1),
    modelFamily,
    canonicalModelId: key.slice(providerId.length + 1),
    displayName: key,
    aliases: [],
    endpoints: ["chat"],
    inputModalities: { value: ["text"], source: "winter-default", confidence: "unknown" },
    outputModalities: { value: ["text"], source: "winter-default", confidence: "unknown" },
    toolCalling: { value: "none", source: "winter-default", confidence: "unknown" },
    nativeTools: { value: false, source: "winter-default", confidence: "unknown" },
    unsupportedParameters: [],
    status: "candidate",
  };
}
const FIXTURE_CATALOG: WinterCatalog = {
  schemaVersion: 2,
  catalogVersion: "test",
  upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" },
  providers: [],
  families: [],
  models: [
    familyRow("anthropic/sonnet", "anthropic", "claude"),
    familyRow("anthropic/opus", "anthropic", "claude"),
    familyRow("openai/terra", "openai", "gpt"),
    familyRow("openai/luna", "openai", "gpt"),
  ],
};

function origin(anchorUuid: string, providerId: string, modelKey: string, family: string): ProviderStateRecord {
  return { type: "winter_provider_state", uuid: `${anchorUuid}-o`, timestamp: "t", sessionId: "s", anchorUuid, provider: providerId, model: modelKey, family, itemIndex: 0, kind: "origin", payload: {} };
}
function summary(anchorUuid: string, text: string, material?: "exposed", complete?: boolean): ProviderStateRecord {
  return { type: "winter_provider_state", uuid: `${anchorUuid}-s`, timestamp: "t", sessionId: "s", anchorUuid, provider: "x", model: "x", family: "x", itemIndex: 1, kind: "summary", payload: { text, ...(material !== undefined ? { material, complete: complete === true } : {}) } };
}

const GPT: ContinuityEndpoint = { providerId: "openai", modelKey: "openai/gpt-x", family: "openai", continuationDomain: "openai/gpt-x", continuation: "opaque-provider-state", readableState: "summary" };
const CLAUDE: ContinuityEndpoint = { providerId: "anthropic", modelKey: "anthropic/claude-x", family: "anthropic", continuationDomain: "anthropic/claude-x", continuation: "opaque-provider-state", readableState: "summary" };
const SONNET: ContinuityEndpoint = { providerId: "anthropic", modelKey: "anthropic/sonnet", family: "anthropic", continuationDomain: "anthropic/sonnet", readableState: "summary" };
const OPUS: ContinuityEndpoint = { providerId: "anthropic", modelKey: "anthropic/opus", family: "anthropic", continuationDomain: "anthropic/opus", readableState: "summary" };
const TERRA: ContinuityEndpoint = { providerId: "openai", modelKey: "openai/terra", family: "openai", readableState: "summary" };
const LUNA: ContinuityEndpoint = { providerId: "openai", modelKey: "openai/luna", family: "openai", readableState: "summary" };
const DEEPSEEK: ContinuityEndpoint = { providerId: "deepseek", modelKey: "deepseek/r-reason", family: "deepseek-style", continuationDomain: "deepseek/r-reason", continuation: "opaque-provider-state", readableState: "full-exposed" };
const GLM: ContinuityEndpoint = { providerId: "glm", modelKey: "glm/x", family: "glm-style", continuationDomain: "glm/x", readableState: "summary" };

function oneTurnEntries(assistantUuid: string): SessionStoreEntry[] {
  return [
    { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "hi" } },
    { type: "assistant", uuid: assistantUuid, parentUuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } },
  ];
}

describe("reviewModelSwitch (W18-20/21)", () => {
  test("GPT (summary records) -> Claude: prompt, warned-lossy", () => {
    const entries = oneTurnEntries("a1");
    const records = [origin("a1", GPT.providerId, GPT.modelKey, GPT.family), summary("a1", "gpt's own summary")];
    const review = reviewModelSwitch({ entries, sidecarRecords: records, from: GPT, to: CLAUDE });
    expect(review.prompt).toBe(true);
    expect(review.classification?.lossClass).toBe("warned-lossy");
    expect(review.skipped).toBeUndefined();
  });

  test("Claude (signed thinking, i.e. its own summary) -> DeepSeek: prompt", () => {
    const entries = oneTurnEntries("a1");
    const records = [origin("a1", CLAUDE.providerId, CLAUDE.modelKey, CLAUDE.family), summary("a1", "claude's summarized thinking")];
    const review = reviewModelSwitch({ entries, sidecarRecords: records, from: CLAUDE, to: DEEPSEEK });
    expect(review.prompt).toBe(true);
    expect(review.classification?.lossClass).toBe("warned-lossy");
  });

  test("DeepSeek (complete exposed) -> GLM: no prompt, lossless-portable", () => {
    const entries = oneTurnEntries("a1");
    const records = [origin("a1", DEEPSEEK.providerId, DEEPSEEK.modelKey, DEEPSEEK.family), summary("a1", "the whole raw trace", "exposed", true)];
    const review = reviewModelSwitch({ entries, sidecarRecords: records, from: DEEPSEEK, to: GLM });
    expect(review.prompt).toBe(false);
    expect(review.classification?.lossClass).toBe("lossless-portable");
  });

  test("DeepSeek (complete exposed) -> GPT: no prompt, lossless-portable", () => {
    const entries = oneTurnEntries("a1");
    const records = [origin("a1", DEEPSEEK.providerId, DEEPSEEK.modelKey, DEEPSEEK.family), summary("a1", "the whole raw trace", "exposed", true)];
    const review = reviewModelSwitch({ entries, sidecarRecords: records, from: DEEPSEEK, to: GPT });
    expect(review.prompt).toBe(false);
    expect(review.classification?.lossClass).toBe("lossless-portable");
  });

  test("DeepSeek with ONE incomplete exposed turn -> GPT: prompt", () => {
    const entries: SessionStoreEntry[] = [
      { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "hi" } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "reply one" }] } },
      { type: "user", uuid: "u2", parentUuid: "a1", message: { role: "user", content: "again" } },
      { type: "assistant", uuid: "a2", parentUuid: "u2", message: { role: "assistant", content: [{ type: "text", text: "reply two" }] } },
    ];
    const records = [
      origin("a1", DEEPSEEK.providerId, DEEPSEEK.modelKey, DEEPSEEK.family),
      summary("a1", "complete trace one", "exposed", true),
      origin("a2", DEEPSEEK.providerId, DEEPSEEK.modelKey, DEEPSEEK.family),
      summary("a2", "incomplete trace two", "exposed", false),
    ];
    const review = reviewModelSwitch({ entries, sidecarRecords: records, from: DEEPSEEK, to: GPT });
    expect(review.prompt).toBe(true);
  });

  test("Sonnet -> Opus: skipped same-family (by MODEL LINEAGE, via the injected fixture catalog)", () => {
    const entries = oneTurnEntries("a1");
    const records = [origin("a1", SONNET.providerId, SONNET.modelKey, SONNET.family), summary("a1", "s")];
    const review = reviewModelSwitch({ entries, sidecarRecords: records, from: SONNET, to: OPUS, catalog: FIXTURE_CATALOG });
    expect(review.prompt).toBe(false);
    expect(review.skipped).toBe("same-family");
    expect(review.classification).toBeUndefined();
  });

  test("Terra -> Luna: skipped same-family (by MODEL LINEAGE, via the injected fixture catalog)", () => {
    const entries = oneTurnEntries("a1");
    const records = [origin("a1", TERRA.providerId, TERRA.modelKey, TERRA.family), summary("a1", "s")];
    const review = reviewModelSwitch({ entries, sidecarRecords: records, from: TERRA, to: LUNA, catalog: FIXTURE_CATALOG });
    expect(review.prompt).toBe(false);
    expect(review.skipped).toBe("same-family");
  });

  test("Sonnet -> Opus WITHOUT the fixture catalog: no family evidence on either side (fake keys, absent from the real catalog) never buys a same-family skip -- the review runs", () => {
    const entries = oneTurnEntries("a1");
    const records = [origin("a1", SONNET.providerId, SONNET.modelKey, SONNET.family), summary("a1", "s")];
    const review = reviewModelSwitch({ entries, sidecarRecords: records, from: SONNET, to: OPUS });
    expect(review.skipped).toBeUndefined();
    expect(review.classification).toBeDefined();
  });

  test("GPT with ZERO assistant turns since the last boundary -> Claude: skipped no-source-turns", () => {
    // Only a USER entry since the boundary -- no assistant turn to have lost anything.
    const entries: SessionStoreEntry[] = [
      { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "hi, fresh session" } },
    ];
    const review = reviewModelSwitch({ entries, sidecarRecords: [], from: GPT, to: CLAUDE });
    expect(review.prompt).toBe(false);
    expect(review.skipped).toBe("no-source-turns");
  });

  test("GPT with turns entirely BEFORE the last compaction boundary -> Claude: also skipped no-source-turns", () => {
    const entries: SessionStoreEntry[] = [
      { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "old turn" } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "old reply" }] } },
      { type: "system", subtype: "compact_boundary", uuid: "b1", parentUuid: null, logicalParentUuid: "a1", compactMetadata: { trigger: "auto", preTokens: 1 } },
      { type: "user", uuid: "s1", parentUuid: "b1", message: { role: "user", content: "SUMMARY" }, isCompactSummary: true },
    ];
    const records = [origin("a1", GPT.providerId, GPT.modelKey, GPT.family), summary("a1", "old summary")];
    const review = reviewModelSwitch({ entries, sidecarRecords: records, from: GPT, to: CLAUDE });
    expect(review.skipped).toBe("no-source-turns");
  });

  test("truncated: true always prompts, even for an otherwise-lossless exposed source", () => {
    const entries = oneTurnEntries("a1");
    const records = [origin("a1", DEEPSEEK.providerId, DEEPSEEK.modelKey, DEEPSEEK.family), summary("a1", "the whole raw trace", "exposed", true)];
    const review = reviewModelSwitch({ entries, sidecarRecords: records, from: DEEPSEEK, to: GLM, truncated: true });
    expect(review.prompt).toBe(true);
  });

  test("same-profile (identical provider+model) is skipped BEFORE same-family, and before any classification", () => {
    const entries = oneTurnEntries("a1");
    const review = reviewModelSwitch({ entries, sidecarRecords: [], from: SONNET, to: SONNET });
    expect(review.skipped).toBe("same-profile");
    expect(review.prompt).toBe(false);
  });
});

describe("switchFactsFor", () => {
  test("sourceTurns counts only assistant turns belonging to `from`, since the last boundary", () => {
    const entries: SessionStoreEntry[] = [
      { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "hi" } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } },
    ];
    const records = [origin("a1", GPT.providerId, GPT.modelKey, GPT.family)];
    expect(switchFactsFor({ entries, sidecarRecords: records, from: GPT }).sourceTurns).toBe(1);
    expect(switchFactsFor({ entries, sidecarRecords: records, from: CLAUDE }).sourceTurns).toBe(0);
  });

  test("an assistant entry with NO sidecar origin at all counts as belonging to the source (official-written, currently-active leg)", () => {
    const entries = oneTurnEntries("a1");
    expect(switchFactsFor({ entries, sidecarRecords: [], from: GPT }).sourceTurns).toBe(1);
  });

  test("summaryAvailable reflects the SOURCE's LAST assistant turn only", () => {
    const entries: SessionStoreEntry[] = [
      { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "hi" } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "one" }] } },
      { type: "user", uuid: "u2", parentUuid: "a1", message: { role: "user", content: "again" } },
      { type: "assistant", uuid: "a2", parentUuid: "u2", message: { role: "assistant", content: [{ type: "text", text: "two" }] } },
    ];
    const records = [origin("a1", GPT.providerId, GPT.modelKey, GPT.family), summary("a1", "captured for turn one only"), origin("a2", GPT.providerId, GPT.modelKey, GPT.family)];
    expect(switchFactsFor({ entries, sidecarRecords: records, from: GPT }).summaryAvailable).toBe(false);
  });

  test("midTurnAbort is always false", () => {
    const entries = oneTurnEntries("a1");
    expect(switchFactsFor({ entries, sidecarRecords: [], from: GPT }).midTurnAbort).toBe(false);
  });
});
