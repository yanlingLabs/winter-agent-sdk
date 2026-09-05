import { describe, expect, test } from "bun:test";
import { loadCatalog, scanForSecrets, validateCatalog } from "../index.ts";
import type { WinterModelDescriptor } from "../types.ts";
import upstreamLayer from "../../generated/upstream-layer.json" with { type: "json" };
import rejectionsLedger from "../../generated/rejections.json" with { type: "json" };
import denominator from "../../generated/denominator.json" with { type: "json" };
import outputPin from "../../UPSTREAM.json" with { type: "json" };
import type { ExclusionClass } from "./literal-extractor.ts";

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
      "anthropic/claude-haiku-4-5-20251001",
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-5",
      "google/gemini-2.5-pro",
      "openai/gpt-4.1",
      "openai/o4-mini",
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
    const standalone = {
      schemaVersion: 1 as const,
      catalogVersion: catalog.catalogVersion,
      upstream: catalog.upstream,
      providers: upstreamLayer.providers,
      models: upstreamLayer.models,
    };
    const result = validateCatalog(standalone);
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  test("every extracted capability records itself as `upstream-static`, never as documentation or a probe", () => {
    for (const model of upstreamLayer.models as unknown as WinterModelDescriptor[]) {
      for (const evidence of [model.contextWindow, model.inputModalities, model.outputModalities, model.toolCalling, model.nativeTools, model.maxInputTokens, model.maxOutputTokens]) {
        if (evidence === undefined) continue;
        expect(evidence.source).toBe("upstream-static");
        expect(["inferred", "unknown"]).toContain(evidence.confidence);
      }
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
    const byId = new Map(catalog.providers.map((p) => [p.id, p]));
    const responsesShaped = new Set(["winter.openai-responses", "winter.azure-openai", "winter.codex-oauth"]);
    for (const model of catalog.models) {
      const provider = byId.get(model.providerId)!;
      const responsesOnly = model.endpoints.includes("responses") && !model.endpoints.includes("chat");
      if (!responsesOnly) continue;
      expect([model.key, responsesShaped.has(provider.adapterId)]).toEqual([model.key, true]);
    }
    // The two rows that were wrong now ship on the surface their capability is documented for.
    for (const key of ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"]) {
      expect([key, catalog.models.find((m) => m.key === key)?.endpoints]).toEqual([key, ["chat"]]);
    }
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
    for (const model of catalog.models) {
      expect([model.key, model.outputModalities.confidence]).toEqual([model.key, "unknown"]);
      expect(model.outputModalities.sourceRef).toContain("WINTER DEFAULT");
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
      expect([model.key, model.reasoning.summaryRequest?.value.field]).toEqual([model.key, model.reasoning.summaryRequest?.value.field]);
      expect(model.reasoning.summaryRequest).toBeDefined();
      expect(model.reasoning.summaryRequest!.source).toBe("official-doc");
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
