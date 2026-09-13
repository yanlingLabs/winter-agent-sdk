// SDK 0.0.11: the router review that found `zai/*` GLM rows shipping with `reasoning: null` (fixed
// in `provider-catalog`'s overlay, R-10b-8/W18-16) also found that every hand-built `ContinuityEndpoint`
// fixture in this lane's OTHER test files could not have caught it — they construct the descriptor
// they imagine, never the one the catalog actually ships. `real-catalog.test.ts` (Phase 6 Lane C,
// review round 2) exists for exactly this reason for `opaque-provider-state` rows; this file is its
// sibling for GLM's `plaintext`/`full-exposed` shape, built the SAME way `winter-runtime-sdk`'s
// `defaultEndpointResolver` builds its registry (loadCatalog -> createRegistry -> one never-invoked
// stub adapter per distinct adapterId -> createEndpointResolver) -- so a passing test here is a fact
// about the REAL catalog + the REAL registry/resolver code, not about what this file assumes either
// one does.
//
// THE BUG THIS FILE PINS: with `reasoning: null`, `domains.ts`'s `endpointFromRegistry` reported
// `continuation: "none"` / `readableState: "none"` for GLM -- the SAME shape a plain chat model with
// NO reasoning at all gets. `classifySwitch` then read `sourceReasons: false` and classified
// GLM -> GPT `lossless-native` with zero warnings: silent, but for the WRONG reason (it believed
// there was nothing to lose, not that everything losslessly crossed as text). And in `renderer.ts`,
// `materialFor` decides `kind: "exposed"` vs `kind: "summary"` from `source.readableState` alone --
// with `readableState: "none"` a GLM turn's OWN raw chain-of-thought (which the OpenAI adapter
// already captured into the sidecar independently of any catalog evidence -- `engine.ts`'s
// `turnProvenance` stamps `material: "exposed"` from the fold's own `turn.thinking.exposed`, never
// from the catalog) was carried to a foreign destination MISLABELLED as `kind: "summary"` -- a
// private family's own returned summary, not raw reasoning -- which would also have made a
// `allowExposedForwarding: false` policy fail to block it (the gate only fires for `kind: "exposed"`).
import { describe, expect, test } from "bun:test";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";
import { createRegistry, type ProviderRegistry } from "../registry.ts";
import type { MessageOrigin, ProviderAdapter, ProviderMessageLike } from "../types.ts";
import { createEndpointResolver, type ContinuityEndpoint } from "./domains.ts";
import { createHistoryRenderer, type HistoryTarget } from "./renderer.ts";
import { classifySwitch } from "./warnings.ts";
import { reviewModelSwitch, switchFactsFor } from "./switch-review.ts";
import { toClaudeReady, type ProviderStateRecord } from "./claude-ready.ts";
import { RECOVERED_REASONING_TAG } from "./decoration.ts";

// --- the SAME registry-building shape as winter-runtime-sdk's defaultEndpointResolver --------------
//
// (That module lives in a sibling repo and cannot be imported here -- provider-runtime ships
// standalone, R6-4's cycle rule -- so this reimplements its documented construction: a catalog-backed
// registry with one never-invoked stub adapter per distinct `adapterId`, resolved through
// `createEndpointResolver`, provider-runtime's own domain/readable-state derivation. `resolve()`
// reads capability facts off the DESCRIPTOR, never the adapter, so a throwing stub is sufficient and
// is what proves nothing here quietly depends on a real adapter being wired.)
function stubAdapter(adapterId: string): ProviderAdapter {
  const notCalled = (member: string) => (): never => {
    throw new Error(`zai-glm-real-catalog.test.ts: stub adapter "${adapterId}" had ${member} called -- it exists only to satisfy ProviderRegistry.resolve()'s presence check`);
  };
  return {
    id: adapterId,
    version: "stub-for-endpoint-resolution-only",
    family: "custom",
    protocol: "custom",
    validateCredential: notCalled("validateCredential"),
    listModels: notCalled("listModels"),
    streamTurn: notCalled("streamTurn"),
    mapEffort: notCalled("mapEffort"),
    capabilities: notCalled("capabilities"),
  };
}

function realCatalogRegistry(): ProviderRegistry {
  const catalog = loadCatalog();
  const registry = createRegistry(catalog);
  const seen = new Set<string>();
  for (const provider of catalog.providers) {
    if (seen.has(provider.adapterId)) continue;
    seen.add(provider.adapterId);
    registry.register(stubAdapter(provider.adapterId));
  }
  return registry;
}

/** Resolves a catalog model KEY (e.g. "zai/glm-5") to the ContinuityEndpoint the real registry + real domains.ts derivation produce. */
function realEndpoint(registry: ProviderRegistry, modelKey: string): ContinuityEndpoint {
  const resolve = createEndpointResolver(registry);
  const resolved = registry.resolve({ model: modelKey });
  if (resolved instanceof Error) throw resolved;
  const origin: MessageOrigin = {
    providerId: resolved.providerId,
    modelKey: resolved.modelKey,
    // The catalog PROVIDER's own `family` (what actually goes on the wire: "openai" for zai/deepseek/
    // openai, "anthropic" for anthropic/zai-anthropic) -- NEVER the stub adapter's `family`, which
    // (mirroring `default-endpoint-resolver.ts`'s own stub) is a fixed "custom" placeholder that
    // would make every cross-provider pair compare `sameFamily` TRUE and skip the review entirely.
    family: resolved.provider.family,
    ...(resolved.continuationDomain !== undefined ? { continuationDomain: resolved.continuationDomain } : {}),
  };
  return resolve(origin);
}

function originRecord(anchorUuid: string, endpoint: ContinuityEndpoint): ProviderStateRecord {
  return {
    type: "winter_provider_state",
    uuid: `${anchorUuid}-origin`,
    timestamp: "2026-09-14T00:00:00.000Z",
    sessionId: "s",
    anchorUuid,
    provider: endpoint.providerId,
    model: endpoint.modelKey,
    family: endpoint.family,
    ...(endpoint.continuationDomain !== undefined ? { continuationDomain: endpoint.continuationDomain } : {}),
    itemIndex: 0,
    kind: "origin",
    payload: {},
  };
}

function summaryRecord(anchorUuid: string, text: string, material?: "exposed", complete?: boolean): ProviderStateRecord {
  return {
    type: "winter_provider_state",
    uuid: `${anchorUuid}-summary`,
    timestamp: "2026-09-14T00:00:00.000Z",
    sessionId: "s",
    anchorUuid,
    provider: "x",
    model: "x",
    family: "x",
    itemIndex: 1,
    kind: "summary",
    payload: { text, ...(material !== undefined ? { material, complete: complete === true } : {}) },
  };
}

function oneTurnEntries(assistantUuid: string): SessionStoreEntry[] {
  return [
    { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "hi" } },
    { type: "assistant", uuid: assistantUuid, parentUuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } },
  ];
}

describe("zai/* GLM reasoning evidence through the REAL catalog registry (SDK 0.0.11, R-10b-8/W18-16)", () => {
  test("the real catalog resolves zai/glm-5 as plaintext/full-exposed reasoning, not none/none", () => {
    const registry = realCatalogRegistry();
    const glm = realEndpoint(registry, "zai/glm-5");
    expect(glm.continuation).toBe("plaintext");
    expect(glm.readableState).toBe("full-exposed");
    // The `zai-anthropic` sibling is DELIBERATELY untouched -- no official Z.ai documentation of an
    // Anthropic-dialect thinking contract was found.
    const glmAnthropic = realEndpoint(registry, "zai-anthropic/glm-5");
    // A descriptor WITH no `reasoning` block at all is the POSITIVE fact "this model does not
    // reason" (domains.ts's own comment) -- "none", never "undefined".
    expect(glmAnthropic.continuation).toBe("none");
    expect(glmAnthropic.readableState).toBe("none");
  });

  // FINDING (uncovered by resolving through the REAL catalog, not a hand-built fixture): `zai`,
  // `deepseek` and `openai` ALL carry the SAME catalog `provider.family: "openai"` -- it names the
  // WIRE dialect (openai-compatible chat/responses), not a vendor. `reviewModelSwitch`'s own
  // `sameFamily` skip (`switch-review.ts`, S7, P10b-1/2: "a same-family... switch never prompts")
  // therefore fires for EVERY pair among these three (and the other ~140 openai-wire providers),
  // returning `skipped:"same-family"` BEFORE `switchFactsFor`/`classifySwitch` ever run -- regardless
  // of how different the two MODELS' actual reasoning-loss risk is. This is a PRE-EXISTING
  // characteristic of `reviewModelSwitch` (S7's own design), not something this task's GLM catalog
  // fix introduced or is in scope to redesign; every hand-built fixture in `switch-review.test.ts`
  // paired same-VENDOR models for its "same-family" cases (Sonnet/Opus, Terra/Luna) and so never
  // exercised "same wire family, different vendor" at all. Reported to the coordinator as its own
  // finding. The tests below verify BOTH layers separately: `reviewModelSwitch`'s actual (skip-first)
  // behavior, and the underlying `switchFactsFor`/`classifySwitch` loss matrix it would run if the
  // skip did not fire -- which is where the GLM reasoning-evidence fix actually shows up.
  test("zai/glm-5 (complete exposed records) -> openai/gpt-5.6-luna: reviewModelSwitch is silent -- via the same-family skip (task 2, scenario 1)", () => {
    const registry = realCatalogRegistry();
    const glm = realEndpoint(registry, "zai/glm-5");
    const gpt = realEndpoint(registry, "openai/gpt-5.6-luna");
    const entries = oneTurnEntries("a1");
    const records = [originRecord("a1", glm), summaryRecord("a1", "the whole raw GLM trace", "exposed", true)];
    const review = reviewModelSwitch({ entries, sidecarRecords: records, from: glm, to: gpt });
    expect(review.prompt).toBe(false);
    expect(review.skipped).toBe("same-family");
    // The underlying loss matrix, run directly (what WOULD decide this pair if it were not skipped):
    // correctly lossless-portable, now that the catalog carries GLM's reasoning evidence.
    const facts = switchFactsFor({ entries, sidecarRecords: records, from: glm });
    expect(classifySwitch(glm, gpt, facts).lossClass).toBe("lossless-portable");
  });

  test("deepseek/deepseek-reasoner (complete exposed records) -> zai/glm-5: reviewModelSwitch is silent -- via the same-family skip (task 2, scenario 2)", () => {
    const registry = realCatalogRegistry();
    const deepseek = realEndpoint(registry, "deepseek/deepseek-reasoner");
    const glm = realEndpoint(registry, "zai/glm-5");
    const entries = oneTurnEntries("a1");
    const records = [originRecord("a1", deepseek), summaryRecord("a1", "the whole raw DeepSeek trace", "exposed", true)];
    const review = reviewModelSwitch({ entries, sidecarRecords: records, from: deepseek, to: glm });
    expect(review.prompt).toBe(false);
    expect(review.skipped).toBe("same-family");
    const facts = switchFactsFor({ entries, sidecarRecords: records, from: deepseek });
    expect(classifySwitch(deepseek, glm, facts).lossClass).toBe("lossless-portable");
  });

  test("openai/gpt-5.6-luna (a provider-authored summary, not exposed reasoning) -> zai/glm-5: the LOSS MATRIX prompts, but reviewModelSwitch's same-family skip currently suppresses it (task 2, scenario 3 -- see FINDING above)", () => {
    const registry = realCatalogRegistry();
    const gpt = realEndpoint(registry, "openai/gpt-5.6-luna");
    const glm = realEndpoint(registry, "zai/glm-5");
    const entries = oneTurnEntries("a1");
    const records = [originRecord("a1", gpt), summaryRecord("a1", "gpt's own returned summary")];

    // reviewModelSwitch's ACTUAL current behavior for this real-catalog pair: same-family skip
    // fires first, so `prompt` is unconditionally false here -- CONTRARY to "GPT -> GLM prompts"
    // taken literally at the router's own seam. This is the finding, pinned rather than hidden.
    const review = reviewModelSwitch({ entries, sidecarRecords: records, from: gpt, to: glm });
    expect(review.skipped).toBe("same-family");
    expect(review.prompt).toBe(false);

    // The loss matrix ITSELF -- switchFactsFor + classifySwitch, what reviewModelSwitch would run if
    // the same-family skip did not fire -- correctly treats this as lossy and prompt-worthy: a
    // provider-authored summary (not GLM's own complete exposed trace) crossing into GLM.
    const facts = switchFactsFor({ entries, sidecarRecords: records, from: gpt });
    const classification = classifySwitch(gpt, glm, facts);
    expect(classification.lossClass).toBe("warned-lossy");
  });

  test("addendum 2: at the loss-matrix layer, GLM -> GPT stays silent with a COMPLETE exposed record, and prompts when the same turn's record is incomplete", () => {
    // Run via switchFactsFor + classifySwitch directly (NOT reviewModelSwitch): zai and openai share
    // `family: "openai"` in the real catalog, so reviewModelSwitch's same-family skip would make
    // BOTH cases `prompt:false` and hide the very distinction this test exists to prove. This is
    // exactly the layer the GLM catalog fix (continuation:"plaintext", readableState:"full-exposed")
    // changes: `classifySwitch`'s `exposedComplete` gate is `from.readableState === "full-exposed"
    // && facts.exposedComplete === true` (warnings.ts) -- before the fix GLM's readableState was
    // "none", so this gate could never be satisfied regardless of the sidecar's own completeness.
    const registry = realCatalogRegistry();
    const glm = realEndpoint(registry, "zai/glm-5");
    const gpt = realEndpoint(registry, "openai/gpt-5.6-luna");
    const entries = oneTurnEntries("a1");

    const completeFacts = switchFactsFor({ entries, sidecarRecords: [originRecord("a1", glm), summaryRecord("a1", "complete GLM trace", "exposed", true)], from: glm });
    expect(classifySwitch(glm, gpt, completeFacts).lossClass).toBe("lossless-portable");
    expect(classifySwitch(glm, gpt, completeFacts).warnings).toEqual([]);

    const incompleteFacts = switchFactsFor({ entries, sidecarRecords: [originRecord("a1", glm), summaryRecord("a1", "partial GLM trace", "exposed", false)], from: glm });
    const incompleteClassification = classifySwitch(glm, gpt, incompleteFacts);
    expect(incompleteClassification.lossClass).toBe("warned-lossy");
    expect(incompleteClassification.warnings.join(" ")).toContain("part of this turn's trace was not captured");
  });

  test("addendum 1a: a GLM turn with an exposed sidecar record renders for a GPT destination as <recovered_reasoning kind=\"exposed\" .../>", () => {
    const registry = realCatalogRegistry();
    const glm = realEndpoint(registry, "zai/glm-5");
    const gpt = realEndpoint(registry, "openai/gpt-5.6-luna");
    const target: HistoryTarget = {
      family: gpt.family,
      ...(gpt.continuationDomain !== undefined ? { continuationDomain: gpt.continuationDomain } : {}),
      readableState: gpt.readableState,
    };
    const message: ProviderMessageLike = {
      role: "assistant",
      content: [{ type: "text", text: "the visible GLM answer" }],
      uuid: "a1",
      origin: { providerId: glm.providerId, modelKey: glm.modelKey, family: glm.family, ...(glm.continuationDomain !== undefined ? { continuationDomain: glm.continuationDomain } : {}) },
    };
    const chain = new Map([["a1", { summary: "the whole raw GLM chain-of-thought" }]]);
    const { messages, report } = createHistoryRenderer(registry).renderWithReport([message], chain, target);
    expect(report.decorations).toHaveLength(1);
    expect(report.decorations[0]!.kind).toBe("exposed");
    const decorated = messages[0]!.decoration;
    expect(decorated).toBeDefined();
    expect(decorated!.text).toContain(`<${RECOVERED_REASONING_TAG} kind="exposed" provider="zai" model="zai/glm-5">`);
    expect(decorated!.text).toContain("the whole raw GLM chain-of-thought");
    // BEFORE the catalog fix (readableState: "none"), this same input classified `kind: "summary"`
    // -- carried, but mislabelled as a private family's own returned summary rather than an open
    // model's raw reasoning, which would also have defeated an `allowExposedForwarding: false`
    // policy (that gate only fires for `kind: "exposed"`).
    expect(decorated!.text).not.toContain('kind="summary"');
  });

  test("addendum 1b: the same GLM turn renders for a Claude destination through toClaudeReady's step (e) as kind=\"exposed\"", () => {
    const registry = realCatalogRegistry();
    const glm = realEndpoint(registry, "zai/glm-5");
    const claude = realEndpoint(registry, "anthropic/claude-sonnet-5");
    const resolveEndpoint = createEndpointResolver(registry);
    const entries: SessionStoreEntry[] = [
      { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "hi" } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "the visible GLM answer" }] } },
    ];
    const records: ProviderStateRecord[] = [originRecord("a1", glm), summaryRecord("a1", "the whole raw GLM chain-of-thought", "exposed", true)];
    const { entries: out } = toClaudeReady(entries, records, { target: claude, resolveEndpoint });
    const content = (out.find((e) => e.uuid === "a1")!.message as { content: Array<Record<string, unknown>> }).content;
    const decoration = content.find((b) => b.type === "text" && (b.text as string).includes(RECOVERED_REASONING_TAG))!.text as string;
    // step (e) reads the sidecar's OWN `material` field directly (never the catalog's readableState),
    // so this path was already correct before the catalog fix -- proving the two carriage mechanisms
    // (the live renderer above, and this cold/resume-time rewrite) did NOT share the same bug, and
    // reporting that asymmetry rather than assuming both were broken the same way.
    expect(decoration).toContain('kind="exposed"');
    expect(decoration).toContain("the whole raw GLM chain-of-thought");
  });

  test("GLM as a DESTINATION of foreign reasoning now opens the thinking-channel door (W18-16), and the OpenAI-family adapter renders it identically to the tag door either way", () => {
    const registry = realCatalogRegistry();
    const glm = realEndpoint(registry, "zai/glm-5");
    // doorFor(target) keys ONLY on the TARGET's own readableState -- see decoration.ts. With the
    // catalog fix, GLM as a destination is `full-exposed`, so the door flips from "tag" to
    // "thinking-channel". shared.ts's own `decorationText` (the OpenAI-family adapter's sole
    // placement site) documents that BOTH doors render as plain text on this family -- there is no
    // in-dialect reasoning slot a caller may write into -- so this flip changes no wire bytes for
    // zai/GLM, openai/GPT, or any other OpenAI-compatible destination.
    expect(glm.readableState).toBe("full-exposed");
  });
});
