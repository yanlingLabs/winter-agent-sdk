// The three ledgers WS-13 §3 step 5 requires, and the denominator report it names explicitly.
//
//   `generated/rejections.json`  — every excluded provider/field with a reason and an exclusion
//                                  class. Written by the frozen `scripts/provider-catalog.ts` from
//                                  the upstream layer's own `rejections` array; this module only
//                                  shapes and orders it.
//   `extraction-manifest.json`   — blob id + sha256 + byte count for every materialized upstream
//                                  file, plus the pin. This is what makes "the same commit produces
//                                  the same catalog" checkable by someone who does not trust our
//                                  git invocation.
//   `PROVENANCE.md`              — the per-field classification (copied verbatim / mechanically
//                                  normalized / official-doc-derived / live-probe-proven / local
//                                  override). Its FIELD TABLE is generated from `FIELD_PROVENANCE`
//                                  below so the document cannot drift from the mapper.
//
// And the denominator: "the extractor reports the upstream 351/352 denominator discrepancy rather
// than hiding it". Taken as a standing OBLIGATION rather than a fixed pair of numbers — the numbers
// are recomputed from the pinned tree at every run and compared with upstream's own claims, so the
// report says what is true at THIS pin instead of restating what was true at the audited head.

import type { MaterializedFile, UpstreamPin } from "./fetch.ts";
import type { LedgerRejection } from "./merge.ts";

export interface DenominatorReport {
  /** Distinct upstream ids across every product-catalog category file. */
  catalogueUnion: number;
  /** Per-category distinct-id counts, in the order WS-13 §1's table lists them. */
  byCategory: Array<{ category: string; count: number }>;
  /** Ids appearing in more than one category file — each would be double-counted by a naive sum. */
  duplicatedAcrossCategories: string[];
  /** Naive sum of per-category counts, i.e. what double-counting would produce. */
  categorySum: number;
  /** Keys of the backend `REGISTRY` map — the EXECUTABLE catalog, always smaller than the product one. */
  registryEntries: number;
  /**
   * How many of those keys the literal walker could actually RESOLVE to an entry object.
   *
   * Reported separately and deliberately: many upstream entries are built by a helper call
   * (`buildOpenAiCompatibleRegistryEntry({…})`), which the extractor rejects as an executable value,
   * so their bindings do not exist. Folding the two numbers into one would report the extractor's
   * own blind spot as an upstream fact — which is exactly the kind of quiet denominator error this
   * report exists to expose.
   */
  registryEntriesResolved: number;
  /** Catalogued ids with no backend registry entry. */
  catalogueWithoutRegistry: number;
  /** Registry ids with no product-catalog row. */
  registryWithoutCatalogue: number;
  /** What upstream itself CLAIMS, per claim source. */
  claims: Array<{ sourcePath: string; claimed: number | undefined; note: string }>;
  /** Human-readable summary, embedded verbatim in PROVENANCE.md. */
  summary: string;
}

export interface DenominatorInput {
  /** category name -> the distinct upstream ids it contains. */
  byCategory: ReadonlyMap<string, ReadonlySet<string>>;
  /** Every key of the backend `REGISTRY` map, read from the object's TEXT (never from resolved values). */
  registryIds: ReadonlySet<string>;
  /** The subset whose entry object the literal walker resolved. */
  registryIdsResolved: ReadonlySet<string>;
  /** Claim source path -> its raw text, scanned for the headline provider count. */
  claimSources: ReadonlyArray<{ sourcePath: string; text: string }>;
}

/** WS-13 §1's table order — kept explicit so the report is comparable across bumps. */
const CATEGORY_ORDER = ["noauth", "oauth", "web-cookie", "apikey", "local", "search", "audio", "upstream-proxy", "cloud-agent", "system"];

/**
 * Pull upstream's own headline provider count out of a claim source.
 *
 * Two spellings at the pin: the generated reference says "Total providers: **352**", the README says
 * "352 AI providers". Both are matched, and a source that states neither returns `undefined` rather
 * than a zero — "we could not find a claim" and "upstream claims none" are different facts.
 */
export function findClaimedProviderCount(text: string): number | undefined {
  const explicit = /Total providers:\s*\*{0,2}(\d+)\*{0,2}/.exec(text);
  if (explicit?.[1] !== undefined) return Number(explicit[1]);
  const prose = /(\d{2,4})\s+AI providers/.exec(text);
  if (prose?.[1] !== undefined) return Number(prose[1]);
  return undefined;
}

export function computeDenominator(input: DenominatorInput): DenominatorReport {
  const seen = new Map<string, string[]>();
  for (const [category, ids] of input.byCategory) {
    for (const id of ids) {
      const where = seen.get(id);
      if (where === undefined) seen.set(id, [category]);
      else where.push(category);
    }
  }
  const duplicated = [...seen.entries()].filter(([, where]) => where.length > 1).map(([id]) => id).sort();
  const known = [...input.byCategory.keys()];
  const ordered = [...CATEGORY_ORDER.filter((c) => input.byCategory.has(c)), ...known.filter((c) => !CATEGORY_ORDER.includes(c)).sort()];
  const byCategory = ordered.map((category) => ({ category, count: input.byCategory.get(category)!.size }));
  const categorySum = byCategory.reduce((total, row) => total + row.count, 0);
  const catalogueUnion = seen.size;

  let catalogueWithoutRegistry = 0;
  for (const id of seen.keys()) if (!input.registryIds.has(id)) catalogueWithoutRegistry++;
  let registryWithoutCatalogue = 0;
  for (const id of input.registryIds) if (!seen.has(id)) registryWithoutCatalogue++;

  const claims = input.claimSources.map((source) => {
    const claimed = findClaimedProviderCount(source.text);
    return {
      sourcePath: source.sourcePath,
      claimed,
      note:
        claimed === undefined
          ? "no headline provider count found in this source at the pin"
          : claimed === catalogueUnion
            ? "matches the enumerated product-catalog union at this pin"
            : `differs from the enumerated product-catalog union by ${claimed - catalogueUnion}`,
    };
  });

  const claimLine = claims.map((c) => `${c.sourcePath}=${c.claimed ?? "none"}`).join(", ");
  const summary = [
    `Enumerated product-catalog union at the pin: ${catalogueUnion} distinct provider ids`,
    `(per-category sum ${categorySum}${duplicated.length > 0 ? `, ${duplicated.length} id(s) counted in more than one category: ${duplicated.join(", ")}` : ", no id appears in two categories"}).`,
    `Backend REGISTRY entries: ${input.registryIds.size} (${input.registryIdsResolved.size} resolvable by the literal extractor; the remainder are built by a helper CALL, which is never evaluated).`,
    `${catalogueWithoutRegistry} catalogued id(s) have no backend registry entry; ${registryWithoutCatalogue} registry id(s) have no product-catalog row.`,
    `Upstream's own claims: ${claimLine}.`,
  ].join(" ");

  return {
    catalogueUnion,
    byCategory,
    duplicatedAcrossCategories: duplicated,
    categorySum,
    registryEntries: input.registryIds.size,
    registryEntriesResolved: input.registryIdsResolved.size,
    catalogueWithoutRegistry,
    registryWithoutCatalogue,
    claims,
    summary,
  };
}

// --- extraction manifest -------------------------------------------------------------------------

export interface ExtractionManifest {
  $comment: string;
  upstream: UpstreamPin & { packageVersion?: string };
  extractorVersion: string;
  generatedFrom: string;
  /** Files COPIED into this repository (upstream licence/notices), with their provenance. */
  copiedFiles: Array<{ upstreamPath: string; localPath: string; blobId: string; sha256: string; bytes: number; licence: string; modifications: "none" }>;
  /** Files READ during extraction and deliberately NOT copied. */
  readOnlyFiles: Array<{ path: string; blobId: string; sha256: string; bytes: number; role: string; admittedBy: string }>;
  outOfAllowlistImports: string[];
}

export interface ManifestInput {
  pin: UpstreamPin & { packageVersion?: string };
  extractorVersion: string;
  files: readonly MaterializedFile[];
  /** upstream path -> where it was copied to inside this repository. */
  copiedTo: ReadonlyMap<string, string>;
  outOfAllowlistImports: readonly string[];
}

export function buildExtractionManifest(input: ManifestInput): ExtractionManifest {
  const files = [...input.files].sort((a, b) => (a.path < b.path ? -1 : 1));
  const copiedFiles: ExtractionManifest["copiedFiles"] = [];
  const readOnlyFiles: ExtractionManifest["readOnlyFiles"] = [];
  for (const file of files) {
    const localPath = input.copiedTo.get(file.path);
    if (localPath !== undefined) {
      copiedFiles.push({
        upstreamPath: file.path,
        localPath,
        blobId: file.blobId,
        sha256: file.sha256,
        bytes: file.bytes,
        licence: "MIT (OmniRoute root LICENSE)",
        modifications: "none",
      });
      continue;
    }
    readOnlyFiles.push({ path: file.path, blobId: file.blobId, sha256: file.sha256, bytes: file.bytes, role: file.role, admittedBy: file.admittedBy });
  }
  return {
    $comment:
      "GENERATED — do not edit. Every upstream file this extraction materialized, with git's own blob id and a sha256 of the bytes. `copiedFiles` are the ONLY upstream files that exist in this repository (the licence and notice texts, verbatim); `readOnlyFiles` were parsed in a scratch checkout that was deleted before the run ended. No executor, translator, or helper source was copied, so there is no `modifications` story to tell for any of them (report §12).",
    upstream: input.pin,
    extractorVersion: input.extractorVersion,
    generatedFrom: "scripts/provider-source-sync.ts",
    copiedFiles,
    readOnlyFiles,
    outOfAllowlistImports: [...new Set(input.outOfAllowlistImports)].sort(),
  };
}

// --- provenance ------------------------------------------------------------------------------------

export type ProvenanceClass = "copied-verbatim" | "mechanically-normalized" | "official-doc-derived" | "live-probe-proven" | "local-override";

export interface FieldProvenance {
  field: string;
  provenance: ProvenanceClass;
  note: string;
}

/**
 * The per-field classification report §6 asks for, as DATA.
 *
 * PROVENANCE.md renders this table rather than restating it in prose, because a hand-written
 * provenance table is exactly the document that goes stale the first time the mapper changes and
 * nobody notices — and a stale provenance claim is worse than none.
 */
export const FIELD_PROVENANCE: readonly FieldProvenance[] = [
  { field: "provider.id", provenance: "mechanically-normalized", note: "upstream id, renamed through the allowlist's reviewed `winterId` map (upstream `gemini` -> Winter `google`); every other id is copied verbatim" },
  { field: "provider.displayName", provenance: "copied-verbatim", note: "the product-catalog row's `name`" },
  { field: "provider.protocols", provenance: "mechanically-normalized", note: "upstream `format` through a closed map; an unknown format FAILS the run" },
  { field: "provider.authKinds", provenance: "mechanically-normalized", note: "upstream `authType` through a closed map; an unknown auth value FAILS the run" },
  { field: "provider.defaultEndpoints", provenance: "copied-verbatim", note: "upstream `baseUrl`/`responsesBaseUrl`/`modelsUrl` exactly as written, including the full chat path. Winter never trims one to an origin — that would be inventing an endpoint upstream never stated. A URL carrying userinfo or a query string is dropped and recorded (R6-11)" },
  { field: "provider.modelDiscovery", provenance: "mechanically-normalized", note: "derived from the presence of `modelsUrl`/`passthroughModels`; upstream has no such field" },
  { field: "provider.liveCatalogAuthority", provenance: "mechanically-normalized", note: "upstream `liveCatalogAuthoritative` when STATED; unstated becomes `unknown`, never upstream's `true` default (R6-F: `authoritative` makes an absent id a definitive fact)" },
  { field: "provider.adapterId / provider.family", provenance: "local-override", note: "Winter-owned: the adapter family the protocol routes to. Upstream's `executor` selects an OmniRoute execution path and is never carried across" },
  { field: "provider.risk", provenance: "local-override", note: "the reviewed allowlist row's risk class and reasons" },
  { field: "provider.upstream.{commit,sourcePaths}", provenance: "mechanically-normalized", note: "the pinned peeled commit and the repository-relative paths the row was read from" },
  { field: "model.key / model.providerId", provenance: "mechanically-normalized", note: "`<winterId>/<upstream model id>` (WS-13 §8.3)" },
  { field: "model.upstreamId", provenance: "copied-verbatim", note: "verbatim UNLESS the allowlist's reviewed `modelOverrides` corrects it (today: OpenRouter's `auto` -> `openrouter/auto`). Every correction is a `reviewed-normalization` ledger row, and the upstream spelling survives as an alias" },
  { field: "model.displayName / model.aliases", provenance: "copied-verbatim", note: "upstream `name` / `aliases`; a duplicate id is dropped and recorded rather than silently de-duplicated" },
  { field: "model.endpoints", provenance: "mechanically-normalized", note: "the provider's protocol, or the model's own `targetFormat` when it selects Responses within the same family. A `targetFormat` naming a DIFFERENT family is refused (no per-model protocol field exists)" },
  { field: "model.contextWindow / model.maxInputTokens / model.maxOutputTokens", provenance: "copied-verbatim", note: "upstream `contextLength` (falling back to the provider's `defaultContextLength`), `maxInputTokens`, `maxOutputTokens`. Non-positive or non-integer values are dropped" },
  { field: "model.inputModalities", provenance: "mechanically-normalized", note: "`text` plus `image`/`audio`/`video` from upstream's `supportsVision`/`supportsAudio`/`supportsVideo`" },
  { field: "model.outputModalities", provenance: "local-override", note: "a WINTER DEFAULT, not a normalization of anything: upstream's `RegistryModel` declares no output modality for ANY model, so `[\"text\"]` is Winter's inference for a chat registry. Stamped `source: \"winter-default\"` (the member added for this) at `confidence: \"unknown\"`, with a sourceRef saying so in words too" },
  { field: "model.toolCalling / model.nativeTools", provenance: "mechanically-normalized", note: "upstream `toolCalling` mapped to `native`/`none`. ABSENT upstream becomes `none` at `confidence: \"unknown\"` — fail-closed, because `native` is what makes a model agent-eligible (WS-13 §8.1)" },
  { field: "model.reasoning.{supported,efforts,continuation}", provenance: "mechanically-normalized", note: "upstream `supportsReasoning`/`supportedThinkingEfforts`/`defaultSupportedThinkingEfforts` and the provider's `reasoningTransport`; an unstated transport becomes `none`, never a guessed opaque one" },
  { field: "model.unsupportedParameters", provenance: "copied-verbatim", note: "upstream `unsupportedParams` when it is an accepted literal. Where upstream writes `Object.freeze([...])` the value is a CALL EXPRESSION and is rejected — see the rejection ledger's `executable-value`/`unresolved-reference` rows" },
  { field: "model.status", provenance: "local-override", note: "`candidate` by default; `experimental` where the allowlist's reviewed `initialModelStatus` says so (R6-16's native cloud), overridable per row through `modelOverrides`. Never `supported` — that requires the behavioural corpus (WS-13 §13), and upstream presence promotes nothing" },
  { field: "*.pricing", provenance: "official-doc-derived", note: "OVERLAY ONLY, from the vendors' own pricing pages with the page URL as `sourceRef` and the observation instant. The extractor cannot emit pricing at all (R6-H: `costBasis: \"list\"` is a claim about published prices)" },
  { field: "*.classifierEligible", provenance: "live-probe-proven", note: "NEVER SET by extraction or overlay. R6-14 sets it only after the safety corpus passes live; absence means Manual fallback, the fail-safe direction" },
  { field: "reasoning.continuationDomain / summaryRequest / readableState / completionEvent / toolLoopRequirement", provenance: "official-doc-derived", note: "OVERLAY ONLY. Continuation domain is a first-class documented fact, never inferred from a shared HTTP shape (WS-13 §8.2)" },
];
