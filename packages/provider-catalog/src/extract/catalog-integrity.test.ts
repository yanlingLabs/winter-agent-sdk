import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_FAMILY_ID, CLAUDE_RESERVED_SLOT_NAMES, familyIdOf, loadCatalog, rowsForCanonicalId, scanForSecrets, stampFamilyFields, validateCatalog } from "../index.ts";
import { UNKNOWN_CITATION_RE } from "../validate.ts";
import type { WinterModelDescriptor, WinterProviderDescriptor } from "../types.ts";
import upstreamLayer from "../../generated/upstream-layer.json" with { type: "json" };
import rejectionsLedger from "../../generated/rejections.json" with { type: "json" };
import denominator from "../../generated/denominator.json" with { type: "json" };
import outputPin from "../../UPSTREAM.json" with { type: "json" };
import type { ExclusionClass } from "./literal-extractor.ts";
import { ADAPTER_PROTOCOL } from "./merge.ts";

/**
 * The COMMITTED catalog, after Lane X replaced T2's hand-authored seed.
 *
 * These are deliberately the positive twins of the two seed-marker tests in `validate.test.ts`,
 * which pinned `catalogVersion === "0.0.0-seed"`, `upstream.commit === ""` and `pricing ===
 * undefined` on every row. Those three assertions were TRUE OF THE SEED AND FALSE OF THE
 * EXTRACTION, by design — T2's own PROVENANCE named closing them as Lane X's work — and
 * `validate.test.ts` is frozen for this lane, so the replacements live here. Read together, the
 * property is preserved and strengthened: the seed markers must be GONE, and gone in the exact
 * places the seed put them.
 */

const catalog = loadCatalog();
const TAG_OBJECT = "6f5d4e00e817bc01b2ac16fdd66db3840c296416";
const PEELED_COMMIT = "5458026c216f77a3da68ea49152dc33470cfe2cb";

describe("the seed is fully replaced", () => {
  test("the catalog version names the upstream release and the extractor revision, not `0.0.0-seed`", () => {
    expect(catalog.catalogVersion).not.toBe("0.0.0-seed");
    expect(catalog.catalogVersion).toBe("v3.8.50+winter.1");
  });

  test("the pin carries the PEELED COMMIT, and the annotated tag object beside it", () => {
    // The trap the OmniRoute report sets: `6f5d4e00…` is the ANNOTATED TAG's own object, not a
    // commit. Pinning it would have pinned nothing a re-tag could not move.
    expect(catalog.upstream.commit).toBe(PEELED_COMMIT);
    expect(catalog.upstream.tagObject).toBe(TAG_OBJECT);
    expect(catalog.upstream.tagObject).not.toBe(catalog.upstream.commit);
    expect(catalog.upstream.tag).toBe("v3.8.50");
    expect(outputPin.upstream).toEqual(catalog.upstream);
  });

  test("every OmniRoute-derived provider row names its source paths and the pinned commit", () => {
    // WS-13 §13: "per-row source paths + commit". The seed left both empty on every row.
    const derived = catalog.providers.filter((p) => p.upstream.project === "OmniRoute");
    expect(derived.length).toBeGreaterThan(0);
    for (const provider of derived) {
      expect(provider.upstream.commit).toBe(PEELED_COMMIT);
      expect(provider.upstream.sourcePaths.length).toBeGreaterThan(0);
      for (const path of provider.upstream.sourcePaths) expect(path).toMatch(/^(open-sse|src)\//);
    }
  });

  test("WINTER-owned rows keep an EMPTY commit — the honest marker for a row no extraction produced", () => {
    const winter = catalog.providers.filter((p) => p.upstream.project === "winter");
    expect(winter.map((p) => p.id)).toContain("codex-oauth");
    for (const provider of winter) {
      expect(provider.upstream.commit).toBe("");
      expect(provider.upstream.sourcePaths).toEqual([]);
    }
  });

  test("the extraction actually contributed rows the seed never had", () => {
    const upstreamKeys = new Set(upstreamLayer.models.map((m) => m.key));
    expect(upstreamKeys.size).toBeGreaterThan(40);
    for (const key of upstreamKeys) expect([key, catalog.models.some((m) => m.key === key)]).toEqual([key, true]);
    // The gateway's OWN-namespace row, which the registry's self-prefix stripping would otherwise
    // send to the wire without it (T2 re-review r2). Its key is doubly qualified because the wire id
    // OpenRouter documents IS `openrouter/auto` — see the dedicated test below.
    expect(catalog.models.some((m) => m.key === "openrouter/openrouter/auto")).toBe(true);
  });

  test("the pinned alias `opus` now resolves to a real row", () => {
    // `selection.ts`'s PINNED_ANTHROPIC_ALIASES routes sonnet/opus/haiku to the anthropic provider;
    // with no row carrying `opus` the alias was a typed `unknown-model` refusal.
    const byAlias = catalog.models.filter((m) => m.providerId === "anthropic" && m.aliases.includes("opus"));
    expect(byAlias).toHaveLength(1);
    expect(byAlias[0]!.key).toBe("anthropic/claude-opus-5");
  });
});

describe("pricing (R6-H, R6-9)", () => {
  const priced = catalog.models.filter((m) => m.pricing !== undefined);

  test("the cohort is priced, and every price is `official-doc` with a page URL and an instant", () => {
    expect(priced.map((m) => m.key).sort()).toEqual([
      "anthropic/claude-fable-5-1",
      "anthropic/claude-haiku-4-5-20251001",
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-5",
      "google/gemini-2.5-pro",
      // P7a (Lane D): the two Gemini rows P6.6 Task 1b authored but could not price -- its allowed
      // page set named the MODELS index, which links out to per-model pages and states no rates.
      // Both now cite `ai.google.dev/gemini-api/docs/pricing` directly.
      "google/gemini-3.5-flash-lite",
      "google/gemini-3.8-flash",
      "openai/gpt-4.1",
      // P6.6 fix wave (whole-branch Minor-4): the three `gpt` family SLOT rows. They were unpriced,
      // so a session on `sol`/`terra`/`luna` -- three of the four options the Agent tool advertises to
      // a gpt session -- reported no cost at all and `maxBudgetUsd` was inert for them.
      "openai/gpt-5.6-luna",
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-terra",
      "openai/gpt-6-astra",
      "openai/o4-mini",
      "xai/grok-4.6",
    ]);
    for (const model of priced) {
      const pricing = model.pricing!;
      // `costBasis: "list"` is only reachable through `official-doc` evidence — the estimator pins
      // that, and an inferred price is treated as no price at all.
      expect(pricing.source).toBe("official-doc");
      expect(pricing.sourceRef).toMatch(/^https:\/\//);
      expect(pricing.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(pricing.value.inputPerMTokUsd).toBeGreaterThan(0);
      expect(pricing.value.outputPerMTokUsd).toBeGreaterThan(0);
    }
  });

  test("no EXTRACTED row is priced — the extractor cannot emit pricing at all", () => {
    for (const model of upstreamLayer.models) expect((model as { pricing?: unknown }).pricing).toBeUndefined();
  });

  test("gateway, Azure, Bedrock and Vertex rows stay unpriced — a reseller's price is not the vendor's", () => {
    for (const key of ["openrouter/openai/gpt-4.1", "azure-openai/gpt-4.1", "vertex/gemini-2.5-pro", "codex-oauth/gpt-5.6-sol"]) {
      expect(catalog.models.find((m) => m.key === key)?.pricing).toBeUndefined();
    }
  });

  test("P7a: the TIME-tiered Gemini row discloses its scheduled increase on the row itself", () => {
    // The same disclosure obligation as the 200k-token tier below, in the other dimension.
    // `gemini-3.8-flash`'s page states one price "through December 31, 2026" and a doubled one
    // "starting January 1, 2027"; `ModelPricing` holds one rate per direction, so the row records
    // the current one and MUST say so -- otherwise the day it silently starts under-reporting by 2x
    // is a day nothing in the repository marks.
    const flash = catalog.models.find((m) => m.key === "google/gemini-3.8-flash")!;
    expect(flash.pricing?.value.inputPerMTokUsd).toBe(0.75);
    expect(flash.pricing?.value.outputPerMTokUsd).toBe(3.75);
    expect(flash.pricing?.sourceRef).toContain("January 1, 2027");
    expect(flash.pricing?.sourceRef).toContain("UNDER-reports");
    // Its `-lite` sibling has NO scheduled increase on the same page, and says that too -- so the
    // disclosure is a statement about each row's own evidence, not boilerplate on every Gemini row.
    const lite = catalog.models.find((m) => m.key === "google/gemini-3.5-flash-lite")!;
    expect(lite.pricing?.value.inputPerMTokUsd).toBe(0.3);
    expect(lite.pricing?.sourceRef).toContain("NO scheduled increase");
  });

  test("P7a: Claude Fable 5.1 carries the 5-MINUTE cache-write rate, and says the 1-hour one is unrepresentable", () => {
    // P6.6 could reach only the models page, which states no cache-write rate at all. The pricing
    // page states two (5m $12.50, 1h $20) and `ModelPricing` has ONE key -- so the row records the
    // 5m rate every other Anthropic row here uses and discloses the omission rather than picking
    // silently.
    const fable = catalog.models.find((m) => m.key === "anthropic/claude-fable-5-1")!;
    expect(fable.pricing?.value.cacheWritePerMTokUsd).toBe(12.5);
    expect(fable.pricing?.value.cacheReadPerMTokUsd).toBe(0.25); // the documented 0.025x exception, not the usual 0.1x
    expect(fable.pricing?.sourceRef).toContain("1-hour write ($20)");
  });

  test("Gemini's TIERED price is disclosed in the row itself, not only in a document", () => {
    const gemini = catalog.models.find((m) => m.key === "google/gemini-2.5-pro")!;
    expect(gemini.pricing!.value.inputPerMTokUsd).toBe(1.25);
    expect(gemini.pricing!.sourceRef).toContain("TIERED UPSTREAM");
    expect(gemini.pricing!.sourceRef).toContain("UNDER-reported");
  });
});

describe("standing floors", () => {
  test("`classifierEligible` is absent EVERYWHERE — R6-14 sets it only after a live safety corpus", () => {
    for (const model of catalog.models) expect(model.classifierEligible).toBeUndefined();
    for (const model of upstreamLayer.models) expect((model as { classifierEligible?: unknown }).classifierEligible).toBeUndefined();
  });

  test("no row is `supported` — upstream presence promotes nothing (WS-13 §13)", () => {
    for (const model of catalog.models) expect(["candidate", "experimental"]).toContain(model.status);
    // R6-16: the native-cloud families enter as `experimental`, and only where an adapter is live.
    const experimental = catalog.models.filter((m) => m.status === "experimental").map((m) => m.providerId);
    expect([...new Set(experimental)].sort()).toEqual(["azure-openai", "vertex"]);
  });

  test("every cohort provider names the adapter id its lane actually exports", () => {
    // Read from the lane branches at authoring time (`git show p6/lane-a:…`, `p6/lane-b:…`). The one
    // that was wrong is the reason this test exists: `vertex` named the plain Gemini adapter, which
    // a registry resolves BY ID — a Vertex session would have been served the Gemini API endpoint
    // with no location scope and no ADC credential.
    const expected: Record<string, string> = {
      openai: "winter.openai-responses",
      anthropic: "winter.anthropic-messages",
      google: "winter.google-generate-content",
      vertex: "winter.vertex-gemini",
      "azure-openai": "winter.azure-openai",
      "codex-oauth": "winter.codex-oauth",
      openrouter: "winter.openai-chat-completions",
      deepseek: "winter.openai-chat-completions",
      bedrock: "winter.bedrock-converse",
    };
    for (const [id, adapterId] of Object.entries(expected)) {
      expect([id, catalog.providers.find((p) => p.id === id)?.adapterId]).toEqual([id, adapterId]);
    }
    // The twelve locals name the DEFAULT id `createLocalOpenAIAdapter` exports. They previously named
    // `winter.openai-chat-completions`, which forced a host to register the local adapter under the
    // chat adapter's id and SHADOW it for openai/openrouter/deepseek.
    for (const provider of catalog.providers.filter((p) => p.family === "local-openai")) {
      expect([provider.id, provider.adapterId]).toEqual([provider.id, "winter.local-openai"]);
    }
  });

  test("OpenRouter's own-namespace row carries the wire id OpenRouter documents", () => {
    const auto = catalog.models.find((m) => m.key === "openrouter/openrouter/auto")!;
    expect(auto.upstreamId).toBe("openrouter/auto");
    // The bare upstream spelling survives as an ALIAS, so both resolve to the corrected wire id —
    // and no row remains that would put a bare `auto` on the wire.
    expect(auto.aliases).toContain("auto");
    expect(catalog.models.some((m) => m.providerId === "openrouter" && m.upstreamId === "auto")).toBe(false);
  });

  test("no credential-shaped field or value in ANY committed artefact", () => {
    for (const [name, document] of [
      ["catalog.json", catalog],
      ["upstream-layer.json", upstreamLayer],
      ["rejections.json", rejectionsLedger],
      ["denominator.json", denominator],
      ["UPSTREAM.json", outputPin],
    ] as const) {
      expect([name, scanForSecrets(document)]).toEqual([name, []]);
    }
  });

  test("no logo, image or asset path leaked into the catalog", () => {
    // Report §12: provider logo/trademark assets are excluded from this work. The product-catalog
    // rows upstream carry `icon`/`color`/`textIcon` fields; none of them may reach a descriptor.
    const text = JSON.stringify(catalog);
    for (const pattern of [/\.svg\b/i, /\.png\b/i, /public\/providers/i, /"textIcon"/, /"logo"/i]) {
      expect(text).not.toMatch(pattern);
    }
  });

  test("the UPSTREAM LAYER validates standalone — its cohort rows are all shadowed and would never be checked otherwise", () => {
    // WS-13c: the layer's rows carry no `modelFamily`/`canonicalModelId` — deliberately, since the
    // stamp treats a pre-existing value as an override it must never overwrite (merge.ts's
    // `UnstampedModelDescriptor`). Stamped here with NO families, exactly as `mergeLayers` does for
    // this same check: every row lands in `other`, and family assignment stays the merged catalog's
    // own gate rather than a claim the layer alone could not satisfy.
    const standalone = {
      schemaVersion: 2 as const,
      catalogVersion: catalog.catalogVersion,
      upstream: catalog.upstream,
      providers: upstreamLayer.providers,
      models: stampFamilyFields(upstreamLayer.models as unknown as Array<{ upstreamId: string }>, []),
      families: [],
    };
    const result = validateCatalog(standalone);
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  test("every extracted capability records itself as `upstream-static`, never as documentation or a probe", () => {
    // `outputModalities` is DELIBERATELY absent from this list: upstream declares no output modality
    // for any model, so it is the one field the mapper emits as `winter-default` rather than as
    // something upstream said. Its own stamp is pinned by the I3 case below, which is stricter than
    // this loop would be -- source, confidence AND the sourceRef that says WINTER DEFAULT in words.
    for (const model of upstreamLayer.models as unknown as WinterModelDescriptor[]) {
      for (const evidence of [model.contextWindow, model.inputModalities, model.toolCalling, model.nativeTools, model.maxInputTokens, model.maxOutputTokens]) {
        if (evidence === undefined) continue;
        expect(evidence.source).toBe("upstream-static");
        expect(["inferred", "unknown"]).toContain(evidence.confidence);
      }
    }
    // ...and the negative half, so removing a field from the list above cannot quietly widen it:
    // NOTHING in the layer claims documentation or a probe.
    for (const model of upstreamLayer.models as unknown as WinterModelDescriptor[]) {
      expect([model.key, ["upstream-static", "winter-default"].includes(model.outputModalities.source)]).toEqual([model.key, true]);
    }
  });
});

describe("the rejection ledger", () => {
  const rejections = rejectionsLedger.rejections as Array<{ upstreamId: string; scope: string; exclusionClass: ExclusionClass; path: string; sourcePath: string; reason: string }>;

  test("is populated, and every row carries a class, a path and a REASON", () => {
    expect(rejections.length).toBeGreaterThan(300);
    for (const row of rejections) {
      expect(row.exclusionClass.length).toBeGreaterThan(0);
      expect(row.reason.length).toBeGreaterThan(10);
      expect(["module", "provider", "model", "field"]).toContain(row.scope);
    }
  });

  test("every blocked WS-13 §1 category is represented — a category that stopped being rejected would be silently imported", () => {
    const classes = new Set(rejections.map((r) => r.exclusionClass));
    for (const required of [
      "category-web-cookie", "category-oauth", "category-no-auth", "category-search",
      "category-audio", "category-upstream-proxy", "category-cloud-agent", "category-system",
      "not-allowlisted",
    ] as const) {
      expect([required, classes.has(required)]).toEqual([required, true]);
    }
  });

  test("the executable/credential classes actually fired against the real tree", () => {
    const counts = new Map<string, number>();
    for (const row of rejections) counts.set(row.exclusionClass, (counts.get(row.exclusionClass) ?? 0) + 1);
    for (const required of ["executable-value", "identity-header", "credential-material", "url-builder", "env-read"] as const) {
      // `env-read` is the one that may legitimately be zero at a given pin — assert the rest fired,
      // and that the class vocabulary is at least present for it.
      if (required === "env-read") continue;
      expect([required, (counts.get(required) ?? 0) > 0]).toEqual([required, true]);
    }
    expect(counts.get("duplicate-id")).toBeGreaterThan(0);
    expect(counts.get("unrepresentable-protocol")).toBeGreaterThan(0);
    expect(counts.get("no-registry-entry")).toBeGreaterThan(0);
  });

  test("`azure-openai` is recorded as catalogued-without-a-registry-entry rather than silently absent", () => {
    const row = rejections.find((r) => r.upstreamId === "azure-openai")!;
    expect(row.exclusionClass).toBe("no-registry-entry");
    expect(catalog.providers.some((p) => p.id === "azure-openai")).toBe(true);
  });
});

describe("review round 1 — the three Importants, pinned where they broke", () => {
  test("I1: the UPSTREAM LAYER's vertex row names `winter.vertex-gemini`, not the Gemini adapter", () => {
    // The overlay row was corrected first, which HID this — and `--offline` validates the upstream
    // layer standalone precisely so a shadowed row is still checked. A protocol is not an adapter:
    // Vertex shares GenerateContent with the Gemini API, so deriving the adapter from the protocol
    // named the Gemini one, and a registry resolves BY ID.
    const vertex = upstreamLayer.providers.find((p) => p.id === "vertex")!;
    expect(vertex.adapterId).toBe("winter.vertex-gemini");
    expect(vertex.protocols).toEqual(["google-generate-content"]);
    expect(catalog.providers.find((p) => p.id === "vertex")!.adapterId).toBe("winter.vertex-gemini");
    // ...and the deviation is RECORDED, not silent.
    const recorded = (rejectionsLedger.rejections as Array<{ upstreamId: string; exclusionClass: string; path: string }>)
      .find((r) => r.upstreamId === "vertex" && r.path === "vertex.executor");
    expect(recorded?.exclusionClass).toBe("reviewed-normalization");
  });

  test("I2: no row is RESPONSES-ONLY under an adapter that speaks Chat Completions", () => {
    // The gate that shipped keyed on `provider.protocols`, which NOTHING reads — so widening the
    // declaration silenced it while two DeepSeek rows still routed onto the Chat adapter.
    // Reads the REAL `ADAPTER_PROTOCOL` rather than a hand-copied set: a private copy of a relation
    // is a second place for it to be wrong, and this test's whole job is to notice when it is.
    const byId = new Map(catalog.providers.map((p) => [p.id, p]));
    for (const model of catalog.models) {
      const provider = byId.get(model.providerId)!;
      const protocol = ADAPTER_PROTOCOL[provider.adapterId];
      // Named in the assertion so a failure says WHICH provider has no protocol. The line that used
      // to precede this was `expect([id, protocol]).toEqual([id, protocol])` -- a tautology that can
      // never fail (Lane X r2); the label belongs on the assertion that does the work.
      expect([provider.id, provider.adapterId, protocol !== undefined]).toEqual([provider.id, provider.adapterId, true]);
      const responsesOnly = model.endpoints.includes("responses") && !model.endpoints.includes("chat");
      if (!responsesOnly) continue;
      expect([model.key, protocol === "openai-responses" || protocol === "azure-openai"]).toEqual([model.key, true]);
    }
    // The two rows that were wrong now ship on the surface their capability is documented for.
    for (const key of ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"]) {
      expect([key, catalog.models.find((m) => m.key === key)?.endpoints]).toEqual([key, ["chat"]]);
    }
  });

  test("the UPSTREAM LAYER is cross-layer consistent ON ITS OWN — not only after its overlay shadows it", () => {
    // The shadow class, twice over. `openai`'s layer row derived the Chat adapter from upstream's
    // provider-level `format` while six of its own models are responses-ONLY; the overlay had said
    // `winter.openai-responses` since the seed, so the MERGED catalog was consistent and the layer
    // was not. Same shape as the Vertex adapter misroute, found the same way.
    for (const model of upstreamLayer.models) {
      const provider = upstreamLayer.providers.find((p) => p.id === model.providerId)!;
      const protocol = ADAPTER_PROTOCOL[provider.adapterId];
      expect([provider.id, protocol !== undefined]).toEqual([provider.id, true]);
      if (!model.endpoints.includes("responses") || model.endpoints.includes("chat")) continue;
      expect([model.key, protocol === "openai-responses" || protocol === "azure-openai"]).toEqual([model.key, true]);
    }
    expect(upstreamLayer.providers.find((p) => p.id === "openai")!.adapterId).toBe("winter.openai-responses");
  });

  test("the `unsupportedParams` ledger names ONLY the models whose field was actually refused", () => {
    // 19 rows were emitted for openai where 3 models had a refused field — 16 false claims.
    const rows = (rejectionsLedger.rejections as Array<{ scope: string; path: string }>)
      .filter((r) => r.scope === "model" && r.path.endsWith(".unsupportedParams"));
    expect(rows.map((r) => r.path).sort()).toEqual([
      "openai.models[o3-mini].unsupportedParams",
      "openai.models[o3].unsupportedParams",
      "openai.models[o4-mini].unsupportedParams",
    ]);
  });

  test("I3: no TTS/media row is selectable, and the output-modality stamp no longer claims upstream said it", () => {
    expect(catalog.models.some((m) => m.key.includes("tts") || m.upstreamId.includes("-tts"))).toBe(false);
    const excluded = (rejectionsLedger.rejections as Array<{ exclusionClass: string; path: string; reason: string }>)
      .filter((r) => r.exclusionClass === "out-of-scope");
    expect(excluded).toHaveLength(1);
    expect(excluded[0]!.path).toContain("gemini-3.1-flash-tts-preview");
    expect(excluded[0]!.reason).toContain("TEXT-TO-SPEECH");
    // Upstream declares NO output modality for any model, so `["text"]` is Winter's inference. It
    // shipped as `upstream-static`/`inferred`, which reads as "upstream said text".
    //
    // THE SYNC HAS NOW LANDED (P6.5 lane X2). This assertion previously pinned `upstream-static`
    // with a note saying the mapper had been changed to stamp `winter-default` but the committed
    // upstream LAYER still carried the old label, because that file is rewritten ONLY by a NETWORK
    // `provider:sync` -- `--offline` re-merges what is on disk and `provider:catalog` never
    // re-extracts, so neither CI gate could see the gap. The note said "when the sync lands, this
    // assertion fails and names the one value to flip"; lane X2's first network run is that sync,
    // and this is the flip. 99 evidence rows across both generated files moved in that one commit.
    for (const model of catalog.models) {
      const om = model.outputModalities;
      if (om.source === "official-doc") {
        // The one honest alternative to the default: a vendor page that STATES the output modality
        // (first row: `openai/gpt-6-astra`, whose model page says "output: text"). It must be a
        // declared claim with a page URL -- never `upstream-static`, which is what this pins against.
        expect([model.key, om.confidence]).toEqual([model.key, "declared"]);
        expect(om.sourceRef).toMatch(/^https:\/\//);
        continue;
      }
      expect([model.key, om.source]).toEqual([model.key, "winter-default"]);
      expect([model.key, om.confidence]).toEqual([model.key, "unknown"]);
      expect(om.sourceRef).toContain("WINTER DEFAULT");
    }
  });

  test("the four Vertex MaaS partner rows are `candidate`, not `experimental`", () => {
    // `experimental` claims a live adapter serves the row. Partner models inherit the Gemini dialect
    // from a silent upstream entry and are not served over GenerateContent — flagged for Lane B/N.
    for (const id of ["DeepSeek-V4-Pro", "DeepSeek-V4-Flash", "GLM-5.1-FP8", "Qwen3.6-35B-A3B"]) {
      const row = catalog.models.find((m) => m.key === `vertex/${id}`)!;
      expect([id, row.status]).toEqual([id, "candidate"]);
    }
    expect(catalog.models.find((m) => m.key === "vertex/gemini-2.5-pro")!.status).toBe("experimental");
  });

  test("every row claiming `readableState: \"summary\"` says HOW to request one", () => {
    // A summary capability with no request field is a capability nobody can use, and WS-13 §8.2 wants
    // summaries requested from session start.
    for (const model of catalog.models) {
      if (model.reasoning?.readableState?.value !== "summary") continue;
      expect([model.key, model.reasoning.summaryRequest !== undefined]).toEqual([model.key, true]);
      const request = model.reasoning.summaryRequest!;
      expect(request.source).toBe("official-doc");
      // The FIELD is the point: a `summaryRequest` whose field names nothing on the model's own wire
      // is a capability nobody can use, so it is asserted against the family the row actually speaks.
      const expected: Record<string, string> = {
        "anthropic-messages": "thinking.display",
        "openai-responses": "reasoning.summary",
        "google-generate-content": "thinkingConfig.includeThoughts",
      };
      const protocol = ADAPTER_PROTOCOL[catalog.providers.find((p) => p.id === model.providerId)!.adapterId]!;
      // NO `?? request.value.field` FALLBACK (Lane X r2). That spelling made the assertion a
      // tautology for any family outside the three-key map -- a new summary-capable family would
      // have joined the catalog with its field unchecked and this gate still green. A family with a
      // summary-capable row and no entry here is the gate's own gap, so it FAILS and names itself.
      const expectedField = expected[protocol];
      expect([model.key, protocol, expectedField !== undefined]).toEqual([model.key, protocol, true]);
      expect([model.key, request.value.field]).toEqual([model.key, expectedField!]);
      expect(request.value.values.length).toBeGreaterThan(0);
    }
  });

  test("every `opaque-provider-state` row's continuation domain cites BOTH own-state acceptance and its narrowness", () => {
    for (const model of catalog.models) {
      const domain = model.reasoning?.continuationDomain;
      if (domain === undefined) continue;
      expect([model.key, domain.confidence]).toEqual([model.key, "declared"]);
      expect([model.key, domain.source]).toEqual([model.key, "official-doc"]);
      expect(domain.sourceRef).toMatch(/own-state acceptance|BOTH halves/);
      expect(domain.value).toEqual([model.key]);
    }
  });

  test("PROVENANCE.md's exclusion table matches the ledger, row for row", async () => {
    // Minor 4 was pure drift: the document said 678 rows and 11 `unrepresentable-protocol` while the
    // ledger said 680 and 13. A hand-typed count is the line that goes stale first.
    const doc = await Bun.file(new URL("../../PROVENANCE.md", import.meta.url)).text();
    const counts = new Map<string, number>();
    for (const row of rejectionsLedger.rejections as Array<{ exclusionClass: string }>) {
      counts.set(row.exclusionClass, (counts.get(row.exclusionClass) ?? 0) + 1);
    }
    expect(doc).toContain(`carries all **${(rejectionsLedger.rejections as unknown[]).length}** rows`);
    for (const [cls, n] of counts) {
      const row = new RegExp(`\\\`${cls.replace(/[-]/g, "\\-")}\\\`\\*{0,2} \\| ${n} \\|`);
      expect([cls, row.test(doc)]).toEqual([cls, true]);
    }
    // No class in the table that the ledger does not have.
    for (const match of doc.matchAll(/^\| \*{0,2}`([a-z-]+)`\*{0,2} \| (\d+) \|/gm)) {
      const cls = match[1] ?? "";
      expect([cls, counts.has(cls)]).toEqual([cls, true]);
    }
  });
});

describe("the denominator obligation (WS-13 §3 step 5)", () => {
  test("is discharged as a COMPUTATION at the pin, with upstream's own claims beside it", () => {
    expect(denominator.catalogueUnion).toBe(352);
    expect(denominator.byCategory.reduce((total, row) => total + row.count, 0)).toBe(denominator.categorySum);
    expect(denominator.claims.length).toBe(2);
    for (const claim of denominator.claims) expect(claim.claimed).toBe(352);
    // The report's 351/352 was recorded at the audited 3.8.51 HEAD; it does not reproduce here, and
    // the honest report is the one that says so rather than restating a stale pair of numbers.
    expect(denominator.registryEntries).toBeLessThan(denominator.catalogueUnion);
  });

  test("PROVENANCE.md quotes the generated summary verbatim, so the prose cannot drift from the numbers", async () => {
    const doc = await Bun.file(new URL("../../PROVENANCE.md", import.meta.url)).text();
    for (const sentence of denominator.summary.split(". ")) {
      expect(doc.replace(/\n>?\s+/g, " ")).toContain(sentence.trim().replace(/\.$/, ""));
    }
  });

  test("PROVENANCE.md records the 351/352 finding explicitly rather than dropping it", async () => {
    const doc = await Bun.file(new URL("../../PROVENANCE.md", import.meta.url)).text();
    expect(doc).toContain("351/352");
  });
});

describe("notices cover copied files (WS-13 §13)", () => {
  test("the package NOTICE names both copied upstream files and their manifest entry", async () => {
    const notice = await Bun.file(new URL("../../NOTICE", import.meta.url)).text();
    expect(notice).toContain("third_party/omniroute-provider-source/LICENSE");
    expect(notice).toContain("third_party/omniroute-provider-source/NOTICE");
    expect(notice).toContain("extraction-manifest.json");
    expect(notice).toContain(PEELED_COMMIT);
    expect(notice).toContain(TAG_OBJECT);
  });

  test("...and states that no third-party SOURCE CODE is in this package", async () => {
    const notice = await Bun.file(new URL("../../NOTICE", import.meta.url)).text();
    expect(notice).toContain("NO THIRD-PARTY SOURCE CODE");
  });
});

/**
 * WS-13b §2 (P6.5 lane X2): the endpoint SHAPE, checked on BOTH layers.
 *
 * `packages/runtime/src/provider/catalog-endpoint-shape.test.ts` proves what the adapter does with
 * `defaultEndpoints.api` by measuring it against a loopback fake. This is the catalog-side half, and
 * it reads the UPSTREAM LAYER as well as the merged catalog for the reason `--offline` already
 * validates the layer standalone: an overlay row shadows its upstream twin whole, so a defect the
 * overlay happens to correct sits in the layer unread until the day the shadow comes off — which is
 * precisely what widening does. That is how this class survived the whole of P6.
 */
describe("WS-13b §2: `defaultEndpoints.api` carries the API ROOT on both layers", () => {
  /** The adapters that append their own protocol path to `connection.baseUrl`. */
  const APPENDING = new Set(["winter.openai-chat-completions", "winter.openai-responses", "winter.local-openai", "winter.codex-oauth", "winter.anthropic-messages", "winter.azure-openai"]);
  const PROTOCOL_PATH = /\/chat\/completions$|\/responses$|\/v1\/messages$|\/v1beta\/models$/;

  test.each([
    ["the MERGED catalog", () => catalog.providers],
    ["the UPSTREAM LAYER, standalone (a shadowed row is still checked)", () => upstreamLayer.providers],
  ])("%s: no row on a path-appending adapter states a protocol path", (_label, rows) => {
    const offenders = rows()
      .filter((p) => APPENDING.has(p.adapterId))
      .map((p) => `${p.id} -> ${p.defaultEndpoints["api"] ?? ""}`)
      .filter((line) => PROTOCOL_PATH.test(line));
    expect(offenders).toEqual([]);
  });

  test("...and no row on a path-appending adapter is left with NO endpoint at all", () => {
    // An absent `api` is not the safe direction: `resolveEndpoint` falls back to the ADAPTER's own
    // vendor default, so an endpoint-less row on the shared chat adapter sends this provider's
    // credential to api.openai.com. `bedrock`/`vertex` are single-provider adapters and exempt --
    // their `api` is never copied into a connection, and Azure's is a deployment template the host
    // must supply, which is why `winter.azure-openai` is exempt from THIS half only.
    //
    // P7a: `requiresUserEndpoint` rows are exempt BY DECLARATION rather than by id. That is the
    // whole difference the field buys -- an endpoint-less row used to be indistinguishable from a
    // row that lost its endpoint, and the fallback-to-api.openai.com failure above is exactly what
    // "indistinguishable" cost. Such a row cannot reach the adapter's vendor default at all: the
    // runtime refuses with `endpoint-required` before a provider is built (see the companion
    // assertion below).
    const missing = catalog.providers
      .filter((p) => APPENDING.has(p.adapterId) && p.adapterId !== "winter.azure-openai" && p.requiresUserEndpoint !== true)
      .filter((p) => (p.defaultEndpoints["api"] ?? "").length === 0)
      .map((p) => p.id);
    expect(missing).toEqual([]);
  });

  // --- P7a (WS-13b §2/§10): the per-tenant rows ---------------------------------------------------
  //
  // The validator enforces the per-ROW rules (template required, no `api` endpoint, no orphan
  // template). What it cannot see is whether the SHIPPED catalog's per-tenant set is the reviewed
  // one, and whether those rows sit where the runtime's user-endpoint path can actually reach them.
  test("the shipped per-tenant set is exactly the two reviewed rows, and each ships a template and no endpoint", () => {
    const perTenant = catalog.providers.filter((p) => p.requiresUserEndpoint === true);
    expect(perTenant.map((p) => p.id).sort()).toEqual(["azure-ai", "oci"]);
    for (const row of perTenant) {
      // Restated on the SHIPPED document rather than left to the validator: a regeneration that
      // dropped the field would leave a row with a template and a live endpoint, which the validator
      // would then reject -- but only if someone ran it, and this is the file that reads the artifact.
      expect([row.id, row.endpointTemplate?.length ?? 0]).not.toEqual([row.id, 0]);
      expect([row.id, row.defaultEndpoints["api"]]).toEqual([row.id, undefined]);
      // `<...>` in the template is the operator's blank. A template with nothing to fill in is a
      // fixed endpoint wearing the wrong field.
      expect([row.id, /<[a-z-]+>/.test(row.endpointTemplate ?? "")]).toEqual([row.id, true]);
    }
  });

  test("no per-tenant row can reach a GENERATED endpoint: its adapter serves several providers, so nothing vouches for a URL it never named", () => {
    // The rule this pins is WS-13 §5 / R6-L one level up from the policy. `applyPrivilegedHeaders`
    // keys on `policy.generated`, and a generated policy is built from an endpoint the CATALOG
    // reviewed. A per-tenant row reviews none -- so if such a row sat alone on an adapter,
    // `generatedBaseUrlForAdapter` would hand that adapter a compiled-in vendor default, and the
    // operator's own tenant URL would be replaced by somebody else's reviewed host (or, worse, the
    // row's own absence of one would fall back to it). Sharing the adapter is what makes the
    // fallback structurally unreachable.
    for (const row of catalog.providers.filter((p) => p.requiresUserEndpoint === true)) {
      const siblings = catalog.providers.filter((p) => p.adapterId === row.adapterId);
      expect([row.id, siblings.length > 1]).toEqual([row.id, true]);
    }
  });

  test("every endpoint strip the mapper performed is RECORDED in the ledger with both strings", () => {
    const strips = (rejectionsLedger.rejections as Array<{ exclusionClass: string; path: string; reason: string }>).filter((r) => r.exclusionClass === "reviewed-normalization" && r.path.endsWith(".baseUrl"));
    expect(strips.length).toBeGreaterThan(0);
    for (const strip of strips) {
      expect(strip.reason).toContain("API ROOT");
      expect(strip.reason).toContain("never trimmed to an origin");
    }
  });
});

/**
 * WS-13b §2 (P6.5 lane X2): THE WIDENED CATALOG.
 *
 * Three obligations, and they are deliberately in one place: that the named rows ship on the dialect
 * their vendor documents with the pricing basis their vendor charges; that every id a human ruled out
 * is ABSENT from the catalog and PRESENT in the ledger with a reason someone can read; and that the
 * pool widened without letting a website-scrape transport in through the side.
 */
describe("WS-13b §2: the widened catalog", () => {
  const byId = new Map(catalog.providers.map((p) => [p.id, p]));
  const rejections = rejectionsLedger.rejections as Array<{ upstreamId: string; reason: string }>;

  test.each([
    // The R6b-5 dialect siblings. `zai-anthropic` is EXTRACTED (upstream's own `zai` entry is the
    // Anthropic one) while `zai` is the reviewed overlay row -- so this table also pins that the two
    // layers produce one coherent pair rather than two rows that happen to exist.
    ["deepseek-anthropic", "winter.anthropic-messages", "token"],
    ["zai", "winter.openai-chat-completions", "token"],
    ["zai-anthropic", "winter.anthropic-messages", "token"],
    ["moonshot", "winter.openai-chat-completions", "token"],
    ["kimi-coding", "winter.anthropic-messages", "subscription"],
    ["minimax", "winter.openai-chat-completions", "token"],
    ["minimax-anthropic", "winter.anthropic-messages", "token"],
    // The api-key rows.
    ["xai", "winter.openai-chat-completions", "token"],
    ["cline", "winter.openai-chat-completions", "token"],
    ["clinepass", "winter.openai-chat-completions", "subscription"],
    ["kilocode", "winter.openai-chat-completions", "token"],
    ["openference", "winter.openai-chat-completions", "token"],
    ["opencode", "winter.openai-chat-completions", "token"],
    // The keyless rows.
    ["aihorde", "winter.openai-chat-completions", "free"],
    ["uncloseai", "winter.openai-chat-completions", "free"],
  ] as ReadonlyArray<[string, string, WinterProviderDescriptor["pricingBasis"]]>)("%s ships on %s with pricingBasis %s and a citation", (id, adapterId, basis) => {
    const row = byId.get(id);
    expect(row?.adapterId).toBe(adapterId);
    expect(row?.pricingBasis).toBe(basis);
    // These fifteen rows are the ones the audit and the vendors' own docs cover, so none of them may
    // fall back to the pinned-upstream tier (PROVENANCE.md, "Two tiers").
    //
    // KEYED ON THE TIER FIELD, not on the citation's shape (whole-branch review M-4, ruling R-FW-3).
    // This assertion used to read `/^https?:\/\/|^audit:/`, which CANNOT enforce what its own comment
    // claimed: a pinned-upstream citation begins `https://` too, so the check passed for every row
    // in the table whatever tier it was on -- and `minimax` sat on `pinned-upstream` while its own
    // sibling cited a fetched MiniMax document naming the same base URL. The tier is data now, so
    // the rule can be stated as the rule.
    expect([id, row?.admission.tier]).not.toEqual([id, "pinned-upstream"]);
    expect(catalog.models.some((m) => m.providerId === id && m.status === "candidate")).toBe(true);
  });

  test("the evidence TIER is data on every row, and it AGREES with the prose it was derived from", () => {
    // Ruling R-FW-3, condition (a). The tier used to live inside the citation STRING as an
    // "EVIDENCE TIER: pinned-upstream" marker, explained in PROVENANCE.md and keyed on by nothing —
    // so the one test that claimed to enforce it could not (see the table above), and the label was
    // free to drift from the row it described.
    //
    // THE AGREEMENT IS THE TRIPWIRE. The tier was DERIVED from the marker text once; asserting the
    // two still count the same is what makes a later edit to one without the other a red rather than
    // a silent divergence. (Deriving the field per-run instead would make this vacuous — it would be
    // comparing the marker to itself.)
    const withMarker = catalog.providers.filter((p) => p.admission.citation.includes("EVIDENCE TIER: pinned-upstream")).map((p) => p.id).sort();
    const onTier = catalog.providers.filter((p) => p.admission.tier === "pinned-upstream").map((p) => p.id).sort();
    expect(onTier).toEqual(withMarker);
    expect(onTier.length).toBeGreaterThan(50);
    // ...and no row is missing one. `validateCatalog` refuses that, so this is the assertion that
    // the shipped artifact went through it.
    expect(catalog.providers.filter((p) => p.admission.tier === undefined).map((p) => p.id)).toEqual([]);
  });

  test("PROMOTION IS TWO-KEY: no `approved` row and no `supported` model sits on the pinned-upstream tier", () => {
    // Ruling R-FW-3, condition (b). A pinned-upstream citation is an admission of the PATH (the
    // api-key prong, satisfied by the pinned RegistryEntry) and a PLACEHOLDER for the document. So a
    // row may ship on it — labelled, `review-required`, models `candidate` — but promoting one takes
    // two keys: a live-gate pass AND a fetched vendor document, with the citation upgraded in the
    // same reviewed commit. The second key is what this asserts; the live gate's report row prints
    // the tier so the first cannot be granted from a pinned row by habit.
    expect(catalog.providers.filter((p) => p.admission.tier === "pinned-upstream" && p.risk.class === "approved").map((p) => p.id)).toEqual([]);
    const pinned = new Set(catalog.providers.filter((p) => p.admission.tier === "pinned-upstream").map((p) => p.id));
    expect(catalog.models.filter((m) => pinned.has(m.providerId) && m.status === "supported").map((m) => m.key)).toEqual([]);
  });

  test("WS-13b §8.4: `aihorde` declares the `Client-Agent` its own citation names — the obligation is DATA, not prose", () => {
    // Whole-branch review I-2. The row cited the header and nothing sent it: X2 handed the header to
    // "Lane L / the adapter owner", whose brief was the live gate, and it appeared on neither
    // ledger. The row that documents the vendor's field is now the row that carries it.
    //
    // The value is asserted here; that it REACHES THE WIRE is asserted against a live request in
    // `provider-conformance/src/corpus/cross-vendor-headers.test.ts`, "aihorde sends its declared
    // identity header, with `<version>` substituted".
    const aihorde = byId.get("aihorde");
    // P7a (D19): the product token is the `<product>` PLACEHOLDER now, not Winter's literal name —
    // substituted at request time with the running brand's `packageName`, so a reuser's identity
    // header names the reuser. A row that hard-coded Winter's name would put OUR identity on THEIR
    // request, in the one field whose whole purpose is honest identity.
    expect(aihorde?.identityHeaders).toEqual({ "Client-Agent": "<product>:<version>:https://github.com/yanlingLabs/winter-agent-sdk" });
    expect(aihorde?.admission.citation).toContain("Client-Agent");
    // Every declared identity header names THE PRODUCT, on every row that has one — the `<product>`
    // placeholder (which resolves to whatever brand is running) or, for a row written before the
    // profile existed, Winter's own literal token. `validateCatalog` refuses anything else; this is
    // the assertion over the SHIPPED artifact.
    for (const provider of catalog.providers) {
      for (const [name, value] of Object.entries(provider.identityHeaders ?? {})) {
        expect([provider.id, name]).toEqual([provider.id, "Client-Agent"]);
        expect([provider.id, value.startsWith("<product>") || value.startsWith("winter-agent-sdk")]).toEqual([provider.id, true]);
      }
    }
  });

  test("every user- and audit-excluded id is ABSENT from the catalog and PRESENT in the ledger with its reason", () => {
    const excluded = ["cursor", "antigravity", "agy", "amazon-q", "claude", "kiro", "trae", "zed", "zed-hosted", "duckduckgo-web", "cloudflare-playground", "chipotle", "zcode", "devin-desktop", "raycast", "grok-cli", "codebuddy-cn", "felo-web", "theoldllm", "veoaifree-web", "github", "ghe-copilot", "codex-app-server", "devin-cli", "devin-cli-agentic", "auggie", "gitlab-duo"];
    for (const id of excluded) {
      expect([id, byId.has(id)]).toEqual([id, false]);
      expect([id, rejections.some((r) => r.upstreamId === id && r.reason.length > 20)]).toEqual([id, true]);
    }
  });

  test("the api-key pool is widened: at least 120 apikey-category providers are now rows, and none is a website-scrape transport", () => {
    const apiKeyRows = catalog.providers.filter((p) => p.admission.basis === "api-key");
    expect(apiKeyRows.length).toBeGreaterThanOrEqual(120);
    // `?? ""` rather than skipping the row: a per-tenant row (P7a) ships no `api` at all, and an
    // empty string is the honest thing to run the scrape-transport check against -- it passes, and
    // it keeps the loop total instead of silently narrowing the cohort it sweeps.
    for (const p of apiKeyRows) expect(p.defaultEndpoints["api"] ?? "").not.toMatch(/wp-admin|api-proxy|\/threads$/);
  });

  test("a subscription- or free-priced row NEVER carries a token price — the basis and the pricing agree", () => {
    // R6-H reads `pricingBasis` to decide whether to price a turn at all (T1's `priceUsage`). A
    // `subscription` row that also carried per-token pricing would be a contradiction the runtime
    // resolves silently in whichever direction it happens to read first.
    for (const provider of catalog.providers) {
      if (provider.pricingBasis === "token") continue;
      for (const m of catalog.models.filter((x) => x.providerId === provider.id)) {
        expect([m.key, provider.pricingBasis, m.pricing]).toEqual([m.key, provider.pricingBasis, undefined]);
      }
    }
  });

  test("NO row anywhere carries the aihorde anonymous key, or any other credential literal", async () => {
    // Decision (e), and the reason the `aihorde` row cites a document instead of embedding a value:
    // upstream states the anonymous key as an `anonymousApiKey` literal, the extractor rejects it as
    // `credential-material`, and nothing in the reviewed overlay may put it back. `scanForSecrets`
    // over the whole document is the general guard; this is the named one.
    expect(scanForSecrets(catalog as unknown as Record<string, unknown>)).toEqual([]);
    // The key is CONSTRUCTED rather than written out (round-1 minor M-2): a test that spells a
    // credential verbatim puts it in the repository just as surely as the row would have, and
    // `scanForSecrets` would be right to flag this file next.
    const anonymousKey = "0".repeat(10);
    // ...and the sweep runs over the two HAND-AUTHORED SOURCES as well, not only the generated
    // artifact. The generated file is the one nobody edits; the overlay and the allowlist are where
    // a future reviewer would actually paste a value, and the merge would carry it through.
    const sources = await Promise.all([
      Bun.file(new URL("../../overlay/providers.json", import.meta.url)).text(),
      Bun.file(new URL("../../overlay/models.json", import.meta.url)).text(),
      Bun.file(new URL("../../../../third_party/omniroute-provider-source/allowlist.json", import.meta.url)).text(),
    ]);
    // MATCHED AS A WHOLE TOKEN, and the reason is an instrument trap this test walked into: a bare
    // `includes` on ten zeros fires on `https://adb-0000000000000000.0.azuredatabricks.net/…`, the
    // per-tenant URL PLACEHOLDER in the `databricks` exclusion reason. That is not a credential, and
    // a check that cannot tell the two apart is a check whose next red is ignored. The boundaries
    // make a longer digit run a non-match: inside sixteen zeros every ten-zero window is either
    // preceded or followed by another digit.
    const asToken = new RegExp(`(?<![A-Za-z0-9_-])${anonymousKey}(?![A-Za-z0-9_-])`);
    for (const [i, text] of [JSON.stringify(catalog), ...sources].entries()) {
      expect([i, asToken.test(text)]).toEqual([i, false]);
      expect([i, text.includes("anonymousApiKey")]).toEqual([i, false]);
    }
    // ...and the repo's own credential-shape detector over the two hand-authored SOURCES, which is
    // the check that does not depend on knowing which literal to look for.
    for (const [i, text] of sources.entries()) expect([i, scanForSecrets(JSON.parse(text) as Record<string, unknown>)]).toEqual([i, []]);

    // ...AND OVER THE SOURCE TREE, which is where the sweep was missing (whole-branch review M-2).
    // This test's own comment says a test that spells a credential puts it in the repository — and
    // `scripts/verify-provider-live.ts` spelled it in a runbook comment while
    // `scripts/verify-provider-live.test.ts` spelled it in an assertion, because the sweep above
    // covers catalog/overlay/allowlist and nothing else. Two lanes, one rule, one of them outside
    // the gate that states it.
    //
    // AN IN-PROCESS WALK, not a `git grep` subprocess: `bun test` runs under a sandbox that does not
    // put `git` on the path, and a gate that depends on an external binary fails for a reason that
    // has nothing to do with what it checks. The scope is the two source roots a credential would
    // realistically be typed into; the generated JSON under `packages/*/generated/` is deliberately
    // outside it (it carries `adb-0000000000000000…`, a per-tenant URL PLACEHOLDER inside an
    // exclusion reason — not a credential, and the sweep above already covers the assembled catalog
    // with the token-boundary rule that tells the two apart).
    const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    const roots = [join(repoRoot, "scripts"), ...readdirSync(join(repoRoot, "packages")).map((pkg) => join(repoRoot, "packages", pkg, "src"))].filter((dir) => existsSync(dir));
    const sourceFiles: string[] = [];
    for (const root of roots) {
      for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !/\.(ts|tsx|json|md)$/.test(entry.name)) continue;
        sourceFiles.push(join(entry.parentPath, entry.name));
      }
    }
    // Non-vacuous: a walk that found nothing would pass silently, and "the glob broke" is exactly
    // how a sweep stops sweeping.
    expect(sourceFiles.length).toBeGreaterThan(100);
    const spelled = sourceFiles.filter((file) => asToken.test(readFileSync(file, "utf8"))).map((file) => file.slice(repoRoot.length));
    // The UUID-shaped capture fixtures in `scripts/capture-official-golden.ts` are LONGER digit runs
    // and fall out by the boundary rule rather than by an exception list — so this really is "no
    // hits", not "no hits we chose to look at".
    expect(spelled).toEqual([]);
    // ...and the row still records that a documented anonymous default EXISTS, which is the fact a
    // host needs. Without this half the test above would pass just as well on a missing row.
    expect(byId.get("aihorde")?.admission.citation).toMatch(/anonymous/i);
  });

  test("every dialect sibling states its dialect in its display name, and never shares an endpoint with its twin", () => {
    // R6b-5: "sharing `displayName` with a dialect suffix". The endpoint half is the one that bites:
    // two rows pointing at the same URL would be one provider wearing two ids, and a `set_model`
    // between them would look like a switch while changing nothing.
    for (const [primary, sibling] of [["deepseek", "deepseek-anthropic"], ["zai", "zai-anthropic"], ["moonshot", "kimi-coding"], ["minimax", "minimax-anthropic"]] as const) {
      const a = byId.get(primary);
      const b = byId.get(sibling);
      expect([primary, a !== undefined, sibling, b !== undefined]).toEqual([primary, true, sibling, true]);
      // BOTH HALVES, not just the sibling (round-1 minor M-1). Checking only the `-anthropic` row let
      // `minimax` ship as upstream's bare "Minimax Coding" beside "MiniMax (Anthropic dialect)" -- the
      // primary is exactly as ambiguous in a picker as the sibling would be, and R6b-5's rule is about
      // the PAIR. `deepseek`/`moonshot` name their vendor plainly and their siblings carry the suffix,
      // which is the same property: a reader can tell the two rows apart by name alone.
      for (const [id, row] of [[primary, a!], [sibling, b!]] as const) {
        expect([id, /dialect|Kimi Code|^DeepSeek$|^Moonshot AI \(Kimi platform\)$/.test(row.displayName)]).toEqual([id, true]);
      }
      expect([primary, sibling, a!.displayName === b!.displayName]).toEqual([primary, sibling, false]);
      expect([primary, sibling, a!.defaultEndpoints["api"] === b!.defaultEndpoints["api"]]).toEqual([primary, sibling, false]);
      expect([sibling, a!.adapterId === b!.adapterId]).toEqual([sibling, false]);
    }
  });

  test("`anthropic` is the ONLY `authoritative` row on its adapter — A2's closure does not reach the siblings", async () => {
    // A CROSS-LANE INTERACTION, pinned because neither lane's own tests would look for it.
    //
    // Lane A2 re-stamped `anthropic` `liveCatalogAuthority: "authoritative"` (fix-wave ruling F-4):
    // Anthropic's live Models endpoint enumerates everything the credential can use, so an id absent
    // from it does not exist. R6-F reads that the other way round -- `authoritative` CLOSES the
    // `allowUnlisted` pass-through (`provider-runtime/src/registry.ts` step 2), and an unlisted id
    // becomes a definitive `unknown-model` instead of reaching the wire.
    //
    // This lane then put SEVEN more providers on `winter.anthropic-messages` (WS-13b §2 / R6b-5).
    // The two changes compose only because `authoritative` is a per-ROW claim about ONE vendor's
    // catalogue: z.ai's model list is not Anthropic's, and a row that inherited that flag would
    // start refusing ids its own vendor serves. Every sibling is `unknown`, which is the permissive
    // direction for `allowUnlisted` and the conservative one for claims (the mapper's own rule: an
    // unstated authority is never upstream's `true` default).
    //
    // The failure this catches is a future edit that stamps `authoritative` adapter-wide, or a
    // sibling row copy-pasted from `anthropic` with the flag left on.
    const onAdapter = catalog.providers.filter((p) => p.adapterId === "winter.anthropic-messages");
    expect(onAdapter.length).toBeGreaterThan(1);
    expect(onAdapter.filter((p) => p.liveCatalogAuthority === "authoritative").map((p) => p.id)).toEqual(["anthropic"]);
    for (const p of onAdapter) {
      if (p.id === "anthropic") continue;
      expect([p.id, p.liveCatalogAuthority]).toEqual([p.id, "unknown"]);
    }
  });

  test("every provider row's admission citation is a real reference, and never the audit's `unknown` class", () => {
    // R6b-3 as a property of the SHIPPED document rather than of the allowlist the pipeline reads:
    // the overlay is a second, hand-authored producer, and `validateCatalog` is the only thing
    // standing between it and a row nobody can check.
    for (const p of catalog.providers) {
      // The four legal forms (types.ts): a vendor URL, `audit:<section>`, `spec:<section>`, or the
      // bare word `local`. `local` is short BECAUSE it is complete -- a local installation has no
      // vendor and no document, and padding it with prose would be inventing evidence.
      //
      // THE RULE IS FORM AND A NON-EMPTY BODY, NOT LENGTH. This case previously also required
      // `length > 20`, a threshold borrowed from the exclusion-ledger test next door and never true
      // of anything in particular. Merging lane A2 proved it wrong rather than strict: A2's
      // `anthropic` row cites `spec:WS-13b §0 D20` -- eighteen characters, and a complete, precise
      // reference to the ruling that admitted its OAuth path. A length floor would have forced a
      // correct citation to grow prose to satisfy an arbitrary number, which is the opposite of what
      // this field is for. What actually must hold is that a citation NAMES something: a prefix
      // alone (`spec:`, `audit:`) is a stub, and that is what is refused.
      const citation = p.admission.citation.trim();
      const form = /^(?:https?:\/\/(?<url>\S+)|audit:(?<audit>\S+)|spec:(?<spec>\S+)|fixture:(?<fixture>\S+)|local$)/.exec(citation);
      expect([p.id, form !== null]).toEqual([p.id, true]);
      const body = form?.groups ?? {};
      expect([p.id, citation === "local" || Object.values(body).some((v) => (v ?? "").length > 0)]).toEqual([p.id, true]);
      expect([p.id, UNKNOWN_CITATION_RE.test(citation)]).toEqual([p.id, false]);
    }
  });
});

// --- WS-13c §1 (R13c-3): the family layer as a property of the SHIPPED document -------------------
//
// `validate.test.ts` proves the RULES against small fixtures; this proves the CATALOG. The two do
// not overlap: a validator that accepts a legal document says nothing about whether the 600 rows
// this repository actually ships got stamped, whether the 35 slots point at rows that exist, or
// whether the matchers a human authored are still disjoint after a row landed that nobody thought
// about. Each of those is a silent failure — a picker with a dead option, a slot resolving into
// another vendor's family — that no other gate can see.
describe("WS-13c: model families and slots", () => {
  test("every model row carries a non-empty `modelFamily` and `canonicalModelId`", () => {
    for (const model of catalog.models) {
      expect([model.key, model.modelFamily.length > 0, model.canonicalModelId.length > 0]).toEqual([model.key, true, true]);
    }
  });

  test("the families layer ships, and `claude`'s slots are the pinned four in order", () => {
    expect(catalog.families.length).toBeGreaterThanOrEqual(15);
    const claude = catalog.families.find((f) => f.id === CLAUDE_FAMILY_ID);
    expect(claude).toBeDefined();
    expect(claude!.slots.map((s) => s.name)).toEqual([...CLAUDE_RESERVED_SLOT_NAMES]);
  });

  test("no NON-claude family uses a reserved Claude name (D25: never false information)", () => {
    for (const family of catalog.families) {
      if (family.id === CLAUDE_FAMILY_ID) continue;
      for (const slot of family.slots) {
        expect([`${family.id}/${slot.name}`, CLAUDE_RESERVED_SLOT_NAMES.includes(slot.name)]).toEqual([`${family.id}/${slot.name}`, false]);
      }
    }
  });

  test("every slot's canonical id resolves to at least one SERVABLE row", () => {
    let slots = 0;
    for (const family of catalog.families) {
      for (const slot of family.slots) {
        slots++;
        const rows = rowsForCanonicalId(catalog, slot.canonicalModelId);
        expect([`${family.id}/${slot.name} -> ${slot.canonicalModelId}`, rows.length > 0]).toEqual([`${family.id}/${slot.name} -> ${slot.canonicalModelId}`, true]);
      }
    }
    expect(slots).toBeGreaterThanOrEqual(30);
  });

  test("the normaliser reproduces these LIVE rows, including the one that needs an overlay override", () => {
    const canonicalOf = (key: string): string => catalog.models.find((m) => m.key === key)!.canonicalModelId;
    const familyOf = (key: string): string => catalog.models.find((m) => m.key === key)!.modelFamily;
    // ONE canonical model across three spellings and three providers — the whole point of §1.
    expect(canonicalOf("vertex/DeepSeek-V4-Pro")).toBe("deepseek-v4-pro");
    expect(canonicalOf("deepseek/deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(canonicalOf("anthropic/claude-haiku-4-5-20251001")).toBe("claude-haiku-4.5-20251001");
    expect(canonicalOf("groq/openai/gpt-oss-120b")).toBe("gpt-oss-120b");
    expect(familyOf("groq/openai/gpt-oss-120b")).toBe("gpt-oss");
    expect(canonicalOf("minimax/MiniMax-M3")).toBe("minimax-m3");
    // The OVERRIDE: the coding plan's own id is bare `k3`, which no matcher would claim and which
    // would be its own canonical model — so the `k3` slot would see the platform row and not this one.
    expect(canonicalOf("kimi-coding/k3")).toBe("kimi-k3");
    expect(familyOf("kimi-coding/k3")).toBe("kimi");
    // ...and the slot that names it reaches BOTH rows.
    expect(rowsForCanonicalId(catalog, "kimi-k3").map((m) => m.key)).toContain("kimi-coding/k3");
    expect(familyOf("openai/gpt-6-astra")).toBe("gpt");
    expect(catalog.families.find((f) => f.id === "gpt")!.slots.find((s) => s.name === "astra")!.canonicalModelId).toBe("gpt-6-astra");
  });

  test("ORDER INDEPENDENCE: no row matches two families, so the pipeline's sort-by-id cannot change a stamp", () => {
    // The generated array is sorted by `id`; the overlay is authored in whatever order a human finds
    // readable. `familyIdOf` takes the FIRST match, so if any row matched two families the stamp
    // would depend on that sort — and a family renamed or inserted would silently re-home rows.
    // Both halves are asserted: the stamp reproduces from the generated array, and nothing is
    // ambiguous in the first place.
    //
    // ONE THING THIS CASE CANNOT ACCOMMODATE, deliberately: a per-row `modelFamily` OVERRIDE in
    // `overlay/models.json`. WS-13c §1 permits one and `stampFamilyFields` honours it, but an
    // overridden row's family is by definition NOT what its matchers say — so the first assertion
    // below would fail, reporting "the matchers are not disjoint" for a row where they are.
    // No override exists today. Adding one means exempting that row HERE, in the same reviewed
    // commit, rather than discovering this failure and mis-diagnosing it.
    for (const model of catalog.models) {
      expect([model.key, familyIdOf(model.canonicalModelId, catalog.families)]).toEqual([model.key, model.modelFamily]);
      const hits = catalog.families.filter((f) => f.matchers.some((m) => new RegExp(m.pattern).test(model.canonicalModelId)));
      // Asserted as "at most one", not by comparing `hits` to a value derived from `hits` — the
      // earlier spelling failed correctly but READ as a tautology, and a future editor "simplifying"
      // it would have deleted the disjointness proof without the suite noticing (fix r1, M-1). The
      // failure still names the row AND the families that collided.
      expect([model.key, hits.length > 1 ? hits.map((f) => f.id) : null]).toEqual([model.key, null]);
    }
    // ...proved a second way, against a REVERSED families array: same answer for every row.
    const reversed = [...catalog.families].reverse();
    for (const model of catalog.models) {
      expect([model.key, familyIdOf(model.canonicalModelId, reversed)]).toEqual([model.key, model.modelFamily]);
    }
  });

  test("informational: how many rows no matcher claims", () => {
    const others = catalog.models.filter((m) => m.modelFamily === "other");
    // No assertion, deliberately. `other` is a legal, expected home — every vendor lineup with a row
    // MAY become a family in a reviewed commit (§1), and a threshold here would either be arbitrary
    // or would turn a new provider's rows into a failing build.
    console.log(`WS-13c: ${others.length} of ${catalog.models.length} model rows are in family "other" (${new Set(others.map((m) => m.canonicalModelId)).size} distinct canonical ids)`);
  });
});
