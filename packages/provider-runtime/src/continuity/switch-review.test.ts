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
  // WS-23 (reasoning-state, decision 9): reasoning stays in the sidecar for the source, so a plain
  // cross-family switch no longer prompts -- only what the target cannot represent does (below).
  test("GPT (summary records) -> Claude: NO prompt -- GPT's reasoning is kept for GPT, not lost", () => {
    const entries = oneTurnEntries("a1");
    const records = [origin("a1", GPT.providerId, GPT.modelKey, GPT.family), summary("a1", "gpt's own summary")];
    const review = reviewModelSwitch({ entries, sidecarRecords: records, from: GPT, to: CLAUDE });
    expect(review.prompt).toBe(false);
    expect(review.classification?.lossClass).toBe("lossless-portable");
    expect(review.skipped).toBeUndefined();
  });

  test("Claude (signed thinking) -> DeepSeek: no prompt", () => {
    const entries = oneTurnEntries("a1");
    const records = [origin("a1", CLAUDE.providerId, CLAUDE.modelKey, CLAUDE.family), summary("a1", "claude's summarized thinking")];
    const review = reviewModelSwitch({ entries, sidecarRecords: records, from: CLAUDE, to: DEEPSEEK });
    expect(review.prompt).toBe(false);
    expect(review.classification?.lossClass).toBe("lossless-portable");
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
    // WS-23: an incomplete exposed trace is no longer a loss -- the trace stays with DeepSeek.
    expect(review.prompt).toBe(false);
  });

  test("Sonnet -> Opus: skipped same-family (by MODEL LINEAGE, via the injected fixture catalog)", () => {
    const entries = oneTurnEntries("a1");
    const records = [origin("a1", SONNET.providerId, SONNET.modelKey, SONNET.family), summary("a1", "s")];
    const review = reviewModelSwitch({ entries, sidecarRecords: records, from: SONNET, to: OPUS, catalog: FIXTURE_CATALOG });
    expect(review.prompt).toBe(false);
    expect(review.skipped).toBe("same-family");
    // WS-23: the classification is computed first now (a same-family switch can still lose something).
    expect(review.classification?.warnings).toEqual([]);
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

  test("WS-23: `truncated` (reasoning trimmed to fit) is accepted and no longer a loss -- the reasoning stays with the source", () => {
    const entries = oneTurnEntries("a1");
    const records = [origin("a1", DEEPSEEK.providerId, DEEPSEEK.modelKey, DEEPSEEK.family), summary("a1", "the whole raw trace", "exposed", true)];
    const review = reviewModelSwitch({ entries, sidecarRecords: records, from: DEEPSEEK, to: GLM, truncated: true });
    expect(review.prompt).toBe(false);
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

  // F2 (WS-21 fix round 23): claude writes a PARALLEL batch as one assistant entry per call and
  // parents each result on its own call's entry, so the leaf's single parentUuid chain holds only the
  // batch's last result. The warning's count must be what the Winter leg carries -- every result,
  // recovered the way `runtime/src/store/resume.ts`'s `recoverParallelToolResults` recovers them.
  // The transcript shape the pinned claude wrote in the router rig (lane-L2-report.md, "F2").
  function claudeParallelBatch(): SessionStoreEntry[] {
    const call = (uuid: string, parentUuid: string, id: string, name: string): SessionStoreEntry => ({
      type: "assistant",
      uuid,
      parentUuid,
      message: { id: "msg_f2_batch", role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] },
    });
    const result = (uuid: string, parentUuid: string, toolUseId: string): SessionStoreEntry => ({
      type: "user",
      uuid,
      parentUuid,
      sourceToolAssistantUUID: parentUuid,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] },
    });
    return [
      { type: "user", uuid: "25b2b70a", parentUuid: null, message: { role: "user", content: "run the F2 batch" } },
      call("69c00c59", "25b2b70a", "toolu_f2_skill", "Skill"),
      call("8552ed72", "69c00c59", "toolu_f2_search", "ToolSearch"),
      call("54487711", "8552ed72", "toolu_f2_mcp", "mcp__sv-user-mcp__echo"),
      result("cf52004b", "69c00c59", "toolu_f2_skill"),
      { type: "user", uuid: "caa5da55", parentUuid: "cf52004b", isMeta: true, message: { role: "user", content: [{ type: "text", text: "F2 SKILL BODY" }] } },
      result("4e5e7265", "8552ed72", "toolu_f2_search"),
      result("568f4afb", "54487711", "toolu_f2_mcp"),
      { type: "attachment", uuid: "519bfcd0", parentUuid: "568f4afb", attachment: { type: "f2_unrendered" } },
      { type: "assistant", uuid: "ba33ce5b", parentUuid: "519bfcd0", message: { id: "msg_f2_done", role: "assistant", content: [{ type: "text", text: "F2-DONE" }] } },
      { type: "user", uuid: "f2-next", parentUuid: "ba33ce5b", message: { role: "user", content: "and the next question" } },
    ];
  }

  test("F2: completedToolResults counts every result of a claude parallel batch, not only the one on the leaf's chain", () => {
    expect(switchFactsFor({ entries: claudeParallelBatch(), sidecarRecords: [], from: CLAUDE }).completedToolResults).toBe(3);
  });

  test("F2: a batch whose next turn chains through its FIRST call (claude yields concurrency-safe results in completion order) still counts all three", () => {
    const entries = claudeParallelBatch().map((e) => (e.uuid === "ba33ce5b" ? { ...e, parentUuid: "caa5da55" } : e));
    expect(switchFactsFor({ entries, sidecarRecords: [], from: CLAUDE }).completedToolResults).toBe(3);
  });

  test("F2: a parallel batch before the last compaction boundary still counts nothing", () => {
    const entries: SessionStoreEntry[] = [
      ...claudeParallelBatch(),
      { type: "system", subtype: "compact_boundary", uuid: "f2-boundary", parentUuid: null, logicalParentUuid: "f2-next", compactMetadata: { trigger: "auto", preTokens: 100 } },
      { type: "user", uuid: "f2-summary", parentUuid: "f2-boundary", isCompactSummary: true, message: { role: "user", content: "F2 SUMMARY" } },
    ];
    expect(switchFactsFor({ entries, sidecarRecords: [], from: CLAUDE }).completedToolResults).toBe(0);
  });
});

// --- WS-23 (reasoning-state, decision 9): the four real losses, and the fit --------------------------------
describe("reviewModelSwitch reports what the target cannot represent, and whether the conversation fits it", () => {
  const withWindow = (key: string, providerId: string, window: number, image: boolean): WinterModelDescriptor => ({
    ...familyRow(key, providerId, `family-${key}`),
    inputModalities: { value: image ? ["text", "image"] : ["text"], source: "winter-default", confidence: "unknown" },
    contextWindow: { value: window, source: "winter-default", confidence: "unknown" },
    maxOutputTokens: { value: 1_000, source: "winter-default", confidence: "unknown" },
  });
  const catalogWith = (...rows: WinterModelDescriptor[]): WinterCatalog => ({ ...FIXTURE_CATALOG, models: [...FIXTURE_CATALOG.models, ...rows] });
  const SMALL: ContinuityEndpoint = { providerId: "tiny", modelKey: "tiny/text-only", family: "openai", readableState: "none" };

  test("the fit is reported whenever the target's row declares a window -- and a conversation that fits does not prompt", () => {
    const review = reviewModelSwitch({ entries: oneTurnEntries("a1"), sidecarRecords: [origin("a1", GPT.providerId, GPT.modelKey, GPT.family)], from: GPT, to: SMALL, catalog: catalogWith(withWindow("tiny/text-only", "tiny", 200_000, true)) });
    expect(review.fits).toBe(true);
    expect(review.window).toBe(200_000);
    expect(review.estimatedTokens).toBeGreaterThan(16_000);
    expect(review.prompt).toBe(false);
  });

  test("a conversation too big for the target prompts, naming the compaction the source will run", () => {
    const entries: SessionStoreEntry[] = [
      { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "x".repeat(200_000) } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } },
    ];
    const review = reviewModelSwitch({ entries, sidecarRecords: [origin("a1", GPT.providerId, GPT.modelKey, GPT.family)], from: GPT, to: SMALL, catalog: catalogWith(withWindow("tiny/text-only", "tiny", 64_000, true)) });
    expect(review.fits).toBe(false);
    expect(review.prompt).toBe(true);
    expect(review.classification?.warnings[0]).toContain("will summarize its older part before the switch");
  });

  test("images for a text-only target, and another vendor's server-tool blocks, each prompt", () => {
    const entries: SessionStoreEntry[] = [
      { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }] } },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        message: { role: "assistant", content: [{ type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "q" } }, { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", title: "T", url: "https://example.com" }] }, { type: "text", text: "found" }] },
      },
    ];
    const review = reviewModelSwitch({ entries, sidecarRecords: [origin("a1", CLAUDE.providerId, CLAUDE.modelKey, CLAUDE.family)], from: CLAUDE, to: SMALL, catalog: catalogWith(withWindow("tiny/text-only", "tiny", 200_000, false)) });
    expect(review.prompt).toBe(true);
    const warnings = review.classification!.warnings.join(" ");
    expect(warnings).toContain("cannot read images or documents: the 1 in this conversation");
    expect(warnings).toContain("2 steps of anthropic's own server-side tools");
  });
});
