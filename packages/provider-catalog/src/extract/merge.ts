// Upstream literals -> the generated UPSTREAM LAYER, and the two-layer merge rules around it.
//
// WS-13 §3 step 4: "Two layers, merged deterministically: the immutable upstream snapshot vs the
// Winter overlay. The overlay wins intentionally; a re-sync MUST NEVER overwrite it."
//
// Two things live here and nothing else does:
//
//   `buildUpstreamLayer` — the MAPPER. Upstream's `RegistryEntry`/`RegistryModel`/product-catalog
//   literals become `WinterProviderDescriptor`/`WinterModelDescriptor` rows, with every row that
//   does not survive recorded in the rejection ledger. This is where WS-13 §1's category
//   disposition table is applied and where "unknown category/auth/executor/protocol values fail"
//   is enforced.
//
//   `mergeLayers` / `OVERLAY_FILES` — the merge SEMANTICS, mirrored from the frozen
//   `scripts/provider-catalog.ts` so this package can validate a layer before the script ever runs.
//   The committed `generated/catalog.json` is written by THAT script and only that script: two
//   serializers would be two chances to drift, and `--check`'s byte comparison would then be
//   checking one of them against the other rather than against the layers.
//
// EVIDENCE DISCIPLINE (WS-13 §4, R6-14): every capability an upstream literal produces is
// `source: "upstream-static"` with `confidence: "inferred"` and the run's `observedAt`. Nothing here
// ever emits `official-doc`, `live-probe`, `verified`, `pricing`, or `classifierEligible` — those
// are overlay-only, by construction rather than by discipline.

import type {
  CapabilityEvidence,
  ProviderAuthKind,
  ProviderProtocol,
  ReasoningCapabilities,
  WinterCatalog,
  WinterModelDescriptor,
  WinterProviderDescriptor,
} from "../types.ts";
import type { ExclusionClass, LiteralValue, Rejection } from "./literal-extractor.ts";
// The `unknown`-citation rule has ONE definition, in the validator. Two copies of "which
// citations are refused" is how an extraction gate and a document gate start disagreeing.
import { UNKNOWN_CITATION_RE } from "../validate.ts";

// --- the allowlist file's shape (the extractor's input contract) --------------------------------

export interface AllowlistProviderRow {
  upstreamId: string;
  winterId: string;
  expectedCategory: string;
  /**
   * The `status` every extracted model of this provider starts at. Absent means `candidate`.
   *
   * R6-16 puts the native-cloud families in the catalog as `experimental`; nothing here can ever
   * reach `supported`, which requires the behavioural corpus (WS-13 §13).
   */
  initialModelStatus?: "candidate" | "experimental";
  /**
   * The adapter this provider's rows must name, when it is NOT the one its protocol implies.
   *
   * Vertex shares the GenerateContent dialect with the Gemini API, so deriving the adapter from the
   * protocol named `winter.google-generate-content` — and a registry resolves an adapter BY ID, so a
   * Vertex session would have been served by the Gemini API adapter with no location-scoped URL and
   * no ADC credential. A protocol is not an adapter.
   */
  adapterIdOverride?: string;
  risk: { class: "approved" | "review-required" | "blocked"; reasons: string[] };
  /**
   * WS-13b §1: how the vendor charges for the credential Winter uses. COPIED VERBATIM onto the
   * generated row — the extractor never derives it, because nothing in the pinned upstream tree
   * states it and a derivation would be Winter guessing at a billing fact.
   */
  pricingBasis: "token" | "subscription" | "free";
  /**
   * WS-13b §1 (D21): the documented third-party path this row ships through, with its citation.
   * Also copied verbatim, and REQUIRED: an allowlist entry missing it fails the run rather than
   * producing a row whose admission nobody can check (see `admissionOf` below).
   */
  admission: { basis: "api-key" | "oauth-documented" | "keyless-documented" | "local" | "cloud-credential"; citation: string };
}

/** A hand-reviewed, per-model deviation from what the pinned upstream tree says. Always recorded. */
export interface ModelOverride {
  /** Corrects a wire id upstream spells differently from the provider's own documentation. */
  id?: string;
  /** Keeps the row OUT of the catalog entirely (WS-13 §4: a non-`llm` row never reaches the worker-model picker). */
  exclude?: boolean;
  /** Overrides the provider's `initialModelStatus` for this one row. */
  status?: "candidate" | "experimental";
  why: string;
}

export interface CategoryDisposition {
  disposition: "blocked" | "candidate-pool" | "winter-owned";
  exclusionClass: ExclusionClass;
  reason: string;
}

export interface Allowlist {
  allowlistVersion: number;
  paths: Array<{ pattern: string; role: "extract" | "claim" | "notice"; why: string }>;
  providers: AllowlistProviderRow[];
  categoryDispositions: Record<string, CategoryDisposition>;
  /** providerId -> upstream model id -> a hand-reviewed override. Every field is optional but `why`. */
  modelOverrides?: Record<string, Record<string, ModelOverride>>;
  blocked: Array<{ upstreamId: string; reason: string }>;
  importBoundary: { resolveIdentifiersWithin: string; failOnUnresolvedFields: string[] };
}

// --- closed upstream vocabularies. An UNKNOWN value FAILS the row (WS-13 §13). -------------------
//
// These are not "the values we happen to have seen": they are the values Winter has decided how to
// represent. Upstream adding a new `format` or `authType` must stop the pipeline for review, which
// is the entire point of enumerating them rather than passing them through.

/** Upstream `format` -> the Winter wire protocol. */
const FORMAT_TO_PROTOCOL: Readonly<Record<string, ProviderProtocol>> = {
  openai: "openai-chat-completions",
  "openai-responses": "openai-responses",
  claude: "anthropic-messages",
  gemini: "google-generate-content",
};

/** Upstream `authType` -> the Winter auth kind. */
const AUTHTYPE_TO_KIND: Readonly<Record<string, ProviderAuthKind>> = {
  apikey: "api-key",
  none: "local-none",
};

/**
 * Upstream `executor` -> whether Winter has a representation for it.
 *
 * `default` is the shared OpenAI-compatible path; `bedrock`/`vertex` are the two native-cloud
 * executors in the allowlisted cohort. Every other executor name (browser pools, CLI passthroughs,
 * custom session state machines) is a REFUSAL, not a fallback to `default` — WS-13 §1's exclusion
 * classes are exactly the executors this map does not contain.
 */
const KNOWN_EXECUTORS: ReadonlySet<string> = new Set(["default", "bedrock", "vertex"]);

/**
 * Executors whose PROTOCOL is not the one their `format` field names — the executor wins.
 *
 * Upstream's `bedrock` entry is `format: "openai"` with `executor: "bedrock"`, because OmniRoute
 * translates an OpenAI-shaped request inside its own Bedrock executor. Reading `format` alone
 * mapped the row to `openai-chat-completions` / `winter.openai-chat-completions`: a row that
 * validates cleanly and would send Converse traffic to the OpenAI chat adapter the day its overlay
 * shadow is removed. It is shadowed today, which is exactly why it needed catching here — a latent
 * misroute in a layer nothing currently reads is the kind that surfaces months later as "why is
 * Bedrock speaking Chat Completions".
 *
 * `vertex` needs no entry: its `format: "gemini"` already names the right protocol, and its executor
 * only changes the URL, which Winter never takes from upstream anyway.
 */
const EXECUTOR_PROTOCOL_OVERRIDE: Readonly<Record<string, ProviderProtocol>> = {
  bedrock: "bedrock-converse",
};

/**
 * Adapter ids the PROTOCOL does not imply — the second dimension, and the one whose absence shipped
 * a misroute into the upstream layer.
 *
 * `EXECUTOR_PROTOCOL_OVERRIDE` fixes the dialect; it does not fix WHO speaks it. Vertex speaks the
 * same GenerateContent dialect as the Gemini API, so its protocol is right and its adapter is not:
 * `PROTOCOL_TO_ADAPTER` derived `winter.google-generate-content`, and a registry resolves an adapter
 * BY ID. The overlay row was corrected first, which hid the layer's own defect — and `--offline`
 * validates the upstream layer STANDALONE precisely so a shadowed row is still checked.
 *
 * A provider's allowlist row may override this too (`adapterIdOverride`), which is the reviewed door.
 */
const EXECUTOR_ADAPTER_OVERRIDE: Readonly<Record<string, string>> = {
  vertex: "winter.vertex-gemini",
};

/** `reasoningTransport` -> the descriptor's continuation kind. */
const TRANSPORT_TO_CONTINUATION: Readonly<Record<string, ReasoningCapabilities["continuation"]>> = {
  opaque: "opaque-provider-state",
  plaintext: "plaintext",
  none: "none",
};

/** Winter protocol -> the adapter family + id an upstream-derived row is routed to. */
const PROTOCOL_TO_ADAPTER: Readonly<Record<ProviderProtocol, { family: string; adapterId: string }>> = {
  "openai-responses": { family: "openai", adapterId: "winter.openai-responses" },
  "openai-chat-completions": { family: "openai", adapterId: "winter.openai-chat-completions" },
  "anthropic-messages": { family: "anthropic", adapterId: "winter.anthropic-messages" },
  "google-generate-content": { family: "google", adapterId: "winter.google-generate-content" },
  "bedrock-converse": { family: "bedrock", adapterId: "winter.bedrock-converse" },
  "azure-openai": { family: "openai", adapterId: "winter.azure-openai" },
  custom: { family: "custom", adapterId: "winter.custom" },
};

/**
 * Adapter id -> the ONE protocol it speaks. The reverse of `PROTOCOL_TO_ADAPTER`, plus the adapters
 * a protocol does not imply.
 *
 * Exported because the cross-layer gate must key on the ADAPTER, not on the provider's `protocols`
 * list: resolution hands a model to `provider.adapterId` and nothing reads `protocols` at all, so a
 * gate that consulted the list passed a responses-only model under a provider that merely DECLARED
 * `openai-responses` while its adapter spoke Chat Completions.
 */
export const ADAPTER_PROTOCOL: Readonly<Record<string, ProviderProtocol>> = {
  "winter.openai-responses": "openai-responses",
  "winter.openai-chat-completions": "openai-chat-completions",
  "winter.local-openai": "openai-chat-completions",
  "winter.codex-oauth": "openai-responses",
  "winter.azure-openai": "azure-openai",
  "winter.anthropic-messages": "anthropic-messages",
  "winter.google-generate-content": "google-generate-content",
  "winter.vertex-gemini": "google-generate-content",
  "winter.bedrock-converse": "bedrock-converse",
};

/** `targetFormat` on a MODEL, and whether the descriptor schema can express it. */
const MODEL_TARGET_FORMAT_ENDPOINT: Readonly<Record<string, "chat" | "responses">> = {
  "openai-responses": "responses",
  openai: "chat",
  gemini: "chat",
  claude: "chat",
};

// --- the layer's own shape ----------------------------------------------------------------------

export interface UpstreamLayer {
  $comment: string;
  providers: WinterProviderDescriptor[];
  models: WinterModelDescriptor[];
  rejections: LedgerRejection[];
}

/** A rejection row as it is COMMITTED — the extractor's `Rejection` plus its upstream identity. */
export interface LedgerRejection {
  upstreamId: string;
  scope: Rejection["scope"];
  exclusionClass: ExclusionClass;
  path: string;
  sourcePath: string;
  reason: string;
}

export interface BuildUpstreamLayerInput {
  allowlist: Allowlist;
  /** Upstream provider id -> its `RegistryEntry` literal. */
  registry: ReadonlyMap<string, LiteralValue>;
  /** Upstream provider id -> its product-catalog category (`apikey`, `web-cookie`, …). */
  categories: ReadonlyMap<string, { category: string; sourcePath: string; row: LiteralValue }>;
  /** Upstream provider id -> the repository-relative path its registry entry was read from. */
  registrySourcePaths: ReadonlyMap<string, string>;
  commit: string;
  /** ISO-8601 instant stamped onto every piece of extracted evidence. */
  observedAt: string;
  /** Field/value rejections the extractor already produced, keyed by source path. */
  moduleRejections: readonly Rejection[];
}

export class ExtractionRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionRefusal";
  }
}

function isRecord(value: LiteralValue | undefined): value is { [key: string]: LiteralValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const str = (row: { [key: string]: LiteralValue }, key: string): string | undefined => (typeof row[key] === "string" ? (row[key] as string) : undefined);
const num = (row: { [key: string]: LiteralValue }, key: string): number | undefined => (typeof row[key] === "number" ? (row[key] as number) : undefined);
const bool = (row: { [key: string]: LiteralValue }, key: string): boolean | undefined => (typeof row[key] === "boolean" ? (row[key] as boolean) : undefined);
const strArray = (row: { [key: string]: LiteralValue }, key: string): string[] | undefined => {
  const value = row[key];
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length === value.length ? out : undefined;
};

/**
 * The single evidence constructor for everything extracted from upstream.
 *
 * There is deliberately no parameter for `source` or `confidence`: an extraction cannot produce
 * `official-doc` or `verified` evidence, and a function that let it would be one refactor away from
 * doing so. A positive-integer guard sits here too, because the validator's own rule is that a
 * numeric evidence value is a POSITIVE INTEGER — an upstream `0` or `-1` must be dropped at the
 * source rather than fail the whole catalog later with a path nobody can trace back to a row.
 */
function upstreamEvidence<T>(value: T, observedAt: string, sourceRef: string): CapabilityEvidence<T> {
  return { value, source: "upstream-static", sourceRef, observedAt, confidence: "inferred" };
}

function positiveInt(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Build the upstream layer from the materialized literals.
 *
 * Order of operations matters and is deliberate:
 *  1. every upstream id in the product catalog is CLASSIFIED (category -> disposition);
 *  2. an allowlisted id whose category is not `candidate-pool` FAILS the run — that is WS-13 §3
 *     step 7's blocked class transition, and it is the only reason the allowlist is checked against
 *     the catalog rather than simply trusted;
 *  3. surviving ids are mapped, with unknown format/auth/executor values failing the row;
 *  4. everything else lands in the ledger with a class.
 */
export function buildUpstreamLayer(input: BuildUpstreamLayerInput): UpstreamLayer {
  const { allowlist, registry, categories, registrySourcePaths, commit, observedAt } = input;
  const rejections: LedgerRejection[] = [];
  const providers: WinterProviderDescriptor[] = [];
  const models: WinterModelDescriptor[] = [];

  const allowedByUpstreamId = new Map(allowlist.providers.map((p) => [p.upstreamId, p]));
  // A `"*"` sentinel is REFUSED, not filtered. One sat here restating WS-13 §5/§6's categorical
  // exclusions and was quietly dropped — documentation wearing the shape of a rule, which is the
  // worst of both: a reader believes a wildcard block exists and nothing enforces one. Those
  // exclusions live in `categoryDispositions`, which fails the run in both directions.
  const wildcard = allowlist.blocked.find((b) => b.upstreamId === "*");
  if (wildcard !== undefined) {
    throw new ExtractionRefusal(
      `allowlist.blocked contains a "*" wildcard. This list names INDIVIDUAL upstream ids and nothing here implements a wildcard, so the entry would be silently ignored. The categorical exclusions it is reaching for are enforced by \`categoryDispositions\`, which fails the run both ways; move the text to \`notes\`. Reason given: ${JSON.stringify(wildcard.reason)}`,
    );
  }
  const hardBlocked = new Map(allowlist.blocked.map((b) => [b.upstreamId, b.reason]));

  const reject = (upstreamId: string, scope: LedgerRejection["scope"], exclusionClass: ExclusionClass, path: string, sourcePath: string, reason: string): void => {
    rejections.push({ upstreamId, scope, exclusionClass, path, sourcePath, reason });
  };

  // --- (0) WS-13b §1 (D21 / R6b-3): every allowlisted entry carries its own ADMISSION EVIDENCE ----
  //
  // Checked BEFORE anything is classified, and by REFUSING the run rather than by dropping the row.
  // Dropping would be the wrong shape for the same reason an allowlist entry matching nothing is:
  // the reviewer wrote the entry, so a silently absent row is a silently empty extraction. Two
  // failures, one door:
  //
  //   `admission-missing` — the entry states no pricing basis, or no admission basis/citation.
  //   `admission-unknown` — it CITES the audit's `unknown` evidence class ("the decisive document
  //     was not found"), whose disposition is EXCLUDE. That is a row that may not ship, not a row
  //     with a weak note attached, so the pipeline refuses instead of importing it.
  //
  // `validateCatalog` enforces the same two rules on the finished document; this is the earlier of
  // the two gates, and it names the ALLOWLIST ENTRY, which is the file a reviewer would go and fix.
  for (const row of allowlist.providers) {
    if (row.pricingBasis === undefined) {
      throw new ExtractionRefusal(`admission-missing: allowlisted provider "${row.upstreamId}" declares no \`pricingBasis\` (WS-13b §1). A row whose billing basis is unstated would be priced per token by R6-H whatever the credential actually is.`);
    }
    const citation = typeof row.admission?.citation === "string" ? row.admission.citation.trim() : "";
    if (row.admission?.basis === undefined || citation.length === 0) {
      throw new ExtractionRefusal(`admission-missing: allowlisted provider "${row.upstreamId}" declares no \`admission\` basis + citation (WS-13b §1, D21). Every row names the documented third-party path it ships through and the document that admits it.`);
    }
    if (UNKNOWN_CITATION_RE.test(citation)) {
      throw new ExtractionRefusal(`admission-unknown: allowlisted provider "${row.upstreamId}" cites the audit's \`unknown\` evidence class (${JSON.stringify(row.admission.citation)}). WS-13b §1: a row whose evidence is \`unknown\` does not ship — find the document or remove the entry.`);
    }
  }

  // --- (1)+(2) classify, and refuse a class transition the allowlist has no right to make --------
  for (const [upstreamId, row] of allowlist.providers.map((p) => [p.upstreamId, p] as const)) {
    const catalogued = categories.get(upstreamId);
    if (catalogued === undefined) {
      throw new ExtractionRefusal(
        `allowlist names upstream provider "${upstreamId}", which has no product-catalog row at commit ${commit}. An allowlist entry that matches nothing is a silently empty extraction — fix the id (upstream renames are real: \`gemini\` is upstream's id for what Winter calls \`google\`) or remove the row.`,
      );
    }
    const disposition = allowlist.categoryDispositions[catalogued.category];
    if (disposition === undefined) {
      throw new ExtractionRefusal(`upstream provider "${upstreamId}" is in category "${catalogued.category}", which the allowlist's disposition table does not cover — an unknown category FAILS extraction (WS-13 §13)`);
    }
    if (disposition.disposition !== "candidate-pool") {
      throw new ExtractionRefusal(
        `class transition BLOCKED: the allowlist admits "${upstreamId}" as ${row.risk.class}, but at commit ${commit} its upstream category is "${catalogued.category}" (${disposition.reason}). WS-13 §3 step 7 blocks transitions into this class; the pipeline refuses rather than importing it.`,
      );
    }
    if (row.expectedCategory !== catalogued.category) {
      throw new ExtractionRefusal(
        `upstream provider "${upstreamId}" moved category: the allowlist records "${row.expectedCategory}", the pinned tree says "${catalogued.category}". A category change is a reviewed allowlist edit, never an automatic one.`,
      );
    }
  }

  // --- (4, first half) every NON-allowlisted catalogued id, with its class ------------------------
  const catalogueIds = [...categories.keys()].sort();
  for (const upstreamId of catalogueIds) {
    if (allowedByUpstreamId.has(upstreamId)) continue;
    const catalogued = categories.get(upstreamId)!;
    const hard = hardBlocked.get(upstreamId);
    if (hard !== undefined) {
      // The CLASS comes from the id's own upstream category, not a hardcode: a hand-blocked id can
      // sit in any category, and stamping every one of them `category-local-live-discovery` was true
      // only because today's two both happen to be `local`. The hand-written reason still wins over
      // the category's generic one — that is the whole point of naming an id individually.
      const disposition = allowlist.categoryDispositions[catalogued.category];
      reject(upstreamId, "provider", disposition?.exclusionClass ?? "unsupported-shape", upstreamId, catalogued.sourcePath, hard);
      continue;
    }
    const disposition = allowlist.categoryDispositions[catalogued.category];
    if (disposition === undefined) {
      reject(upstreamId, "provider", "unsupported-shape", upstreamId, catalogued.sourcePath, `upstream category "${catalogued.category}" has no disposition in the allowlist — unknown categories fail rather than default`);
      continue;
    }
    reject(upstreamId, "provider", disposition.exclusionClass, upstreamId, catalogued.sourcePath, disposition.reason);
  }

  // --- (3) map the survivors ---------------------------------------------------------------------
  for (const allowed of [...allowlist.providers].sort((a, b) => (a.winterId < b.winterId ? -1 : 1))) {
    const catalogued = categories.get(allowed.upstreamId)!;
    const entry = registry.get(allowed.upstreamId);
    const registryPath = registrySourcePaths.get(allowed.upstreamId);

    if (entry === undefined || !isRecord(entry) || registryPath === undefined) {
      // A product-catalog row with no backend RegistryEntry: upstream contributes identity and
      // nothing executable. That is a real state at this pin (azure-openai), and it is recorded
      // rather than papered over — the overlay owns the row's endpoints and auth.
      reject(
        allowed.upstreamId,
        "provider",
        "no-registry-entry",
        allowed.upstreamId,
        catalogued.sourcePath,
        `no backend RegistryEntry at this commit — the upstream row is product-catalog metadata only, so no endpoint, auth, executor or model list could be extracted. Winter's "${allowed.winterId}" descriptor is overlay-authored; upstream contributes identity only.`,
      );
      continue;
    }

    const sourcePaths = [registryPath, catalogued.sourcePath].sort();
    const format = str(entry, "format");
    const authType = str(entry, "authType");
    const executor = str(entry, "executor");

    for (const [field, value] of [["format", format], ["authType", authType], ["executor", executor]] as const) {
      if (value === undefined && allowlist.importBoundary.failOnUnresolvedFields.includes(field)) {
        throw new ExtractionRefusal(`allowlisted provider "${allowed.upstreamId}": identity-critical field \`${field}\` could not be resolved from materialized files — refusing to emit a row whose identity is a guess`);
      }
    }

    const byFormat = format === undefined ? undefined : FORMAT_TO_PROTOCOL[format];
    if (byFormat === undefined) {
      throw new ExtractionRefusal(`allowlisted provider "${allowed.upstreamId}" declares upstream format ${JSON.stringify(format)}, which Winter has no protocol for — an unknown protocol FAILS extraction (WS-13 §13) rather than defaulting`);
    }
    const authKind = authType === undefined ? undefined : AUTHTYPE_TO_KIND[authType];
    if (authKind === undefined) {
      throw new ExtractionRefusal(`allowlisted provider "${allowed.upstreamId}" declares upstream authType ${JSON.stringify(authType)}, which Winter has no auth kind for — an unknown auth value FAILS extraction (WS-13 §13)`);
    }
    if (executor === undefined || !KNOWN_EXECUTORS.has(executor)) {
      throw new ExtractionRefusal(`allowlisted provider "${allowed.upstreamId}" uses upstream executor ${JSON.stringify(executor)}, which is not one Winter represents — an unknown executor FAILS extraction (WS-13 §13)`);
    }
    // A native-cloud executor OVERRIDES its entry's `format` (see EXECUTOR_PROTOCOL_OVERRIDE).
    const protocol = EXECUTOR_PROTOCOL_OVERRIDE[executor] ?? byFormat;
    if (protocol !== byFormat) {
      reject(
        allowed.upstreamId,
        "field",
        "reviewed-normalization",
        `${allowed.upstreamId}.format`,
        registryPath,
        `upstream declares format ${JSON.stringify(format)} with executor ${JSON.stringify(executor)}: the OpenAI shape is what its own executor TRANSLATES FROM, not what the provider speaks on the wire. Winter records the executor's protocol (${protocol}) and drops the format claim.`,
      );
    }

    const derived = PROTOCOL_TO_ADAPTER[protocol];
    const adapterId = allowed.adapterIdOverride ?? EXECUTOR_ADAPTER_OVERRIDE[executor] ?? derived.adapterId;
    const adapter = { family: derived.family, adapterId };
    if (adapterId !== derived.adapterId) {
      reject(
        allowed.upstreamId,
        "field",
        "reviewed-normalization",
        `${allowed.upstreamId}.executor`,
        registryPath,
        `executor ${JSON.stringify(executor)} speaks the ${protocol} dialect but is served by a DIFFERENT adapter: Winter records ${JSON.stringify(adapterId)} rather than the protocol's default ${JSON.stringify(derived.adapterId)}. A protocol is not an adapter, and a registry resolves BY ID.`,
      );
    }
    const baseUrl = str(entry, "baseUrl");
    const defaultEndpoints: Record<string, string> = {};
    // R6-11: generated endpoints are IMMUTABLE and must be parseable absolute URLs with no query
    // string. Upstream's `baseUrl` is the full CHAT PATH (".../v1/chat/completions") with its own
    // `urlSuffix` query in some rows; the suffix was rejected as dynamic and the path is recorded
    // verbatim, because trimming it to an "origin" would be Winter inventing an endpoint upstream
    // never stated.
    if (baseUrl !== undefined) {
      const parsed = safeUrl(baseUrl);
      if (parsed === undefined || parsed.search.length > 0 || parsed.username.length > 0) {
        reject(allowed.upstreamId, "field", "unsupported-shape", `${allowed.upstreamId}.baseUrl`, registryPath, `upstream baseUrl ${JSON.stringify(baseUrl)} is not a credential-free, query-free absolute URL — R6-11 requires generated endpoints to be immutable and reviewable`);
      } else {
        defaultEndpoints["api"] = baseUrl;
      }
    }
    const responsesBaseUrl = str(entry, "responsesBaseUrl");
    if (responsesBaseUrl !== undefined && safeUrl(responsesBaseUrl) !== undefined) defaultEndpoints["responses"] = responsesBaseUrl;
    const modelsUrl = str(entry, "modelsUrl");
    if (modelsUrl !== undefined && safeUrl(modelsUrl) !== undefined) defaultEndpoints["models"] = modelsUrl;

    const passthrough = bool(entry, "passthroughModels") === true;
    const liveAuthoritative = bool(entry, "liveCatalogAuthoritative");

    providers.push({
      id: allowed.winterId,
      displayName: str(catalogued.row as { [key: string]: LiteralValue }, "name") ?? allowed.winterId,
      protocols: [protocol],
      authKinds: [authKind],
      defaultEndpoints,
      // Upstream has no `modelDiscovery` field; `modelsUrl` present or `passthroughModels` is the
      // closest inert signal, and "none" is the honest answer when neither is stated.
      modelDiscovery: modelsUrl !== undefined || passthrough ? "openai-models" : "none",
      // WS-13 §7 + R6-F: `authoritative` is the ONLY value that makes an absent id a definitive
      // fact. Upstream's default for the flag is `true`, but Winter refuses to infer that from a
      // default — an unstated authority is `unknown`, which is the permissive direction for
      // `allowUnlisted` and the conservative one for claims.
      liveCatalogAuthority: liveAuthoritative === true ? "authoritative" : liveAuthoritative === false ? "partial" : "unknown",
      adapterId: adapter.adapterId,
      family: adapter.family,
      upstream: { project: "OmniRoute", commit, sourcePaths },
      risk: allowed.risk,
      scope: "llm",
      // WS-13b §1: the reviewed allowlist entry's own evidence, copied onto the row. `admissionOf`
      // has already refused the run if either is missing or names the audit's `unknown` class.
      pricingBasis: allowed.pricingBasis,
      admission: allowed.admission,
    });

    // --- models ---------------------------------------------------------------------------------
    const rawModels = entry["models"];
    if (!Array.isArray(rawModels)) {
      reject(allowed.upstreamId, "provider", "unsupported-shape", `${allowed.upstreamId}.models`, registryPath, "no accepted `models` array — the provider row survives with no seeded model rows");
      continue;
    }
    const defaultContextLength = positiveInt(num(entry, "defaultContextLength"));
    const providerEfforts = strArray(entry, "defaultSupportedThinkingEfforts");
    const transport = str(entry, "reasoningTransport");
    const seen = new Set<string>();

    // FAIL-CLOSED ON THE INDEX CORRELATION (Lane X r2). `rawModels` is the extractor's COMPACTED
    // array: a refused element is dropped from it and a spread is expanded into it, while the
    // walker's rejection paths carry the SYNTACTIC element index. Where the two diverge, a
    // `models[N].unsupportedParams` rejection correlates to the wrong model — a ledger row making a
    // false claim about a row that never had the field, which is the exact defect class the
    // `path.includes("models[")` version of this correlation was fixed for.
    //
    // They agree today only because no allowlisted provider's `models` array compacts. That is a
    // property of the current pin, not of the code, and twelve real `models[N] (spread)` rejections
    // exist upstream — so the guard is on the CONDITION, not on today's data: a file whose module
    // rejections touch a `models[N]` element at all has its per-model correlation refused wholesale,
    // with one ledger row saying so. The rows still ship (the field fails open either way); what is
    // withheld is a per-model claim the indices cannot support.
    const correlationSafe = !modelIndexCorrelationBroken(input.moduleRejections, registryPath);
    if (!correlationSafe) {
      reject(
        allowed.upstreamId,
        "provider",
        "unsupported-shape",
        `${allowed.upstreamId}.models`,
        registryPath,
        "an element of this file's `models` array was itself refused or spread, so the extractor's COMPACTED array and the walker's SYNTACTIC element indices no longer line up. Per-model correlation of field-level rejections is refused for this file rather than reported against whichever row happens to share an index; the model rows ship unchanged, and an unreadable `unsupportedParams` fails open exactly as it does elsewhere.",
      );
    }

    for (const [modelIndex, raw] of rawModels.entries()) {
      if (!isRecord(raw)) {
        reject(allowed.upstreamId, "model", "unsupported-shape", `${allowed.upstreamId}.models[?]`, registryPath, "a model entry that is not an object literal");
        continue;
      }
      const id = str(raw, "id");
      if (id === undefined || id.length === 0) {
        reject(allowed.upstreamId, "model", "unsupported-shape", `${allowed.upstreamId}.models[?]`, registryPath, "a model entry with no string `id`");
        continue;
      }
      if (seen.has(id)) {
        // Upstream really does list `gpt-4o` twice at this pin. The catalog's model keys are unique
        // by construction (the validator enforces it), so a duplicate is dropped and RECORDED —
        // silently de-duplicating would hide an upstream defect that a bump might turn into two
        // genuinely different rows.
        reject(allowed.upstreamId, "model", "duplicate-id", `${allowed.upstreamId}.models[${id}]`, registryPath, `upstream lists model id ${JSON.stringify(id)} more than once; the first occurrence is kept and this one dropped (model keys are unique by schema)`);
        continue;
      }

      const targetFormat = str(raw, "targetFormat");
      if (targetFormat !== undefined) {
        const mapped = MODEL_TARGET_FORMAT_ENDPOINT[targetFormat];
        if (mapped === undefined) {
          reject(allowed.upstreamId, "model", "unrepresentable-protocol", `${allowed.upstreamId}.models[${id}].targetFormat`, registryPath, `unknown per-model targetFormat ${JSON.stringify(targetFormat)}`);
          continue;
        }
        const targetProtocol = FORMAT_TO_PROTOCOL[targetFormat];
        // A per-model protocol that differs from the provider's own has NO representation in the
        // descriptor schema (`protocols` is per-provider; `endpoints` distinguishes chat from
        // responses within one family, and nothing distinguishes families within one provider).
        // Emitting the row anyway would route it onto the provider's adapter and speak the wrong
        // dialect on the wire, so it is refused with the reason stated.
        if (targetProtocol !== undefined && targetProtocol !== protocol && PROTOCOL_TO_ADAPTER[targetProtocol].family !== adapter.family) {
          reject(
            allowed.upstreamId,
            "model",
            "unrepresentable-protocol",
            `${allowed.upstreamId}.models[${id}].targetFormat`,
            registryPath,
            `upstream routes this model over the ${JSON.stringify(targetFormat)} protocol while its provider speaks ${JSON.stringify(format)}. The Winter descriptor schema has no per-model protocol field, so the row would resolve onto the "${adapter.adapterId}" adapter and serialize the wrong dialect. Refused; a Winter row for it belongs in the overlay under a provider whose protocol matches.`,
          );
          continue;
        }
      }

      // A REVIEWED id correction: an upstream id that is not what the provider documents on its own
      // wire. Applied here and RECORDED, never silently — the ledger row is what makes it auditable
      // against the pinned source, which is the whole reason `copied verbatim` is a provenance class.
      const override = allowlist.modelOverrides?.[allowed.upstreamId]?.[id];
      if (override?.exclude === true) {
        reject(allowed.upstreamId, "model", "out-of-scope", `${allowed.upstreamId}.models[${id}]`, registryPath, `reviewed model exclusion: ${override.why}`);
        continue;
      }
      const wireId = override?.id ?? id;
      if (override?.id !== undefined) {
        reject(allowed.upstreamId, "model", "reviewed-normalization", `${allowed.upstreamId}.models[${id}].id`, registryPath, `reviewed model-id correction: upstream lists ${JSON.stringify(id)}, Winter records ${JSON.stringify(override.id)}. ${override.why}`);
      }
      if (override?.status !== undefined) {
        reject(allowed.upstreamId, "model", "reviewed-normalization", `${allowed.upstreamId}.models[${id}].status`, registryPath, `reviewed status override: ${JSON.stringify(override.status)} rather than this provider's ${JSON.stringify(allowed.initialModelStatus ?? "candidate")}. ${override.why}`);
      }

      seen.add(id);
      const endpoints: Array<"chat" | "responses"> =
        targetFormat !== undefined && MODEL_TARGET_FORMAT_ENDPOINT[targetFormat] === "responses"
          ? ["responses"]
          : protocol === "openai-responses"
            ? ["responses"]
            : ["chat"];

      const inputModalities = ["text"];
      if (bool(raw, "supportsVision") === true) inputModalities.push("image");
      if (bool(raw, "supportsAudio") === true) inputModalities.push("audio");
      if (bool(raw, "supportsVideo") === true) inputModalities.push("video");

      const contextWindow = positiveInt(num(raw, "contextLength") ?? defaultContextLength);
      const maxInput = positiveInt(num(raw, "maxInputTokens"));
      const maxOutput = positiveInt(num(raw, "maxOutputTokens"));
      const toolCalling = bool(raw, "toolCalling");
      const efforts = strArray(raw, "supportedThinkingEfforts") ?? providerEfforts ?? [];
      const reasoningSupported = bool(raw, "supportsReasoning") === true || efforts.length > 0;
      // FAILS OPEN, deliberately and visibly. `toolCalling` fails CLOSED because a wrong `native`
      // admits an unproven model to the agent modes; an empty `unsupportedParameters` only means
      // Winter will not pre-reject a parameter, and the provider's own 400 is the backstop. But
      // upstream writes some of these as `Object.freeze([...])` — a call the extractor never
      // evaluates — so an empty list can mean "upstream says none" OR "we could not read it", and
      // the two must not look alike. Every unreadable one gets a ledger row.
      const unsupportedParameters = strArray(raw, "unsupportedParams") ?? [];
      if (correlationSafe && raw["unsupportedParams"] === undefined && rawHasUnreadableUnsupportedParams(input.moduleRejections, registryPath, modelIndex)) {
        reject(allowed.upstreamId, "model", "unresolved-reference", `${allowed.upstreamId}.models[${id}].unsupportedParams`, registryPath, "upstream states unsupported parameters for this model, but as a value the literal extractor refuses (a call expression, or an identifier resolving to one). The row ships with an EMPTY `unsupportedParameters`, which fails OPEN: Winter will not pre-reject a parameter the provider does reject, and the provider's own error is the backstop. Correct it in the overlay with real evidence if the model matters.");
      }
      // A corrected id keeps the upstream spelling as an ALIAS, so both resolve to the corrected wire id.
      const aliases = [...(strArray(raw, "aliases") ?? []), ...(override?.id !== undefined ? [id] : [])].filter((alias) => alias !== wireId);
      const ref = `${registryPath}#${id}`;

      const reasoning: ReasoningCapabilities | undefined = reasoningSupported
        ? {
            supported: upstreamEvidence(true, observedAt, ref),
            efforts,
            // `continuation` is REQUIRED and has no "unknown" member. Where upstream states no
            // transport, Winter records `none` rather than guessing at an opaque one: a wrong
            // `opaque-provider-state` would have adapters replay a state object that does not
            // exist, while a wrong `none` costs a summary the overlay can correct with evidence.
            continuation: (transport !== undefined ? TRANSPORT_TO_CONTINUATION[transport] : undefined) ?? "none",
          }
        : undefined;

      models.push({
        key: `${allowed.winterId}/${wireId}`,
        providerId: allowed.winterId,
        upstreamId: wireId,
        displayName: str(raw, "name") ?? id,
        aliases,
        endpoints,
        ...(contextWindow !== undefined ? { contextWindow: upstreamEvidence(contextWindow, observedAt, ref) } : {}),
        ...(maxInput !== undefined ? { maxInputTokens: upstreamEvidence(maxInput, observedAt, ref) } : {}),
        ...(maxOutput !== undefined ? { maxOutputTokens: upstreamEvidence(maxOutput, observedAt, ref) } : {}),
        inputModalities: upstreamEvidence(inputModalities, observedAt, ref),
        // NOT `upstreamEvidence`, and no longer `upstream-static` either. Upstream's `RegistryModel`
        // declares NO output modality at all, so `["text"]` is Winter's own inference for a chat
        // registry — and the label now says that in the SOURCE FIELD rather than only in a sourceRef
        // sentence. `EvidenceSource` was frozen when this shipped, so the caveat had nowhere
        // machine-readable to live and a reader filtering for "what upstream said" got a Winter
        // guess; `winter-default` is the member added for exactly this (Lane X r1 carry). The
        // sourceRef prose stays, because "why" is not something an enum can carry. Disclosed in
        // PROVENANCE.md.
        outputModalities: { value: ["text"], source: "winter-default", sourceRef: `${ref} — WINTER DEFAULT: upstream declares no output modality for any model; "text" is Winter's inference for a chat registry, NOT an upstream statement`, observedAt, confidence: "unknown" },
        // WS-13 §8.1 read fail-closed. Upstream states tool calling on SOME rows only, and an
        // unstated capability is unknown — so an absent flag becomes `none` at `confidence:
        // "unknown"`, never `native`. `native` is what makes a model agent-eligible; inferring it
        // from silence would admit every unproven row to Code/Dispatch/Cowork/Build on a guess,
        // which is precisely the "silently continuing as plain chat" failure §8.1 prohibits. A row
        // whose provider really does support tools is corrected in the overlay with real evidence.
        toolCalling:
          toolCalling === undefined
            ? { value: "none", source: "upstream-static", sourceRef: ref, observedAt, confidence: "unknown" }
            : upstreamEvidence(toolCalling ? "native" : "none", observedAt, ref),
        nativeTools:
          toolCalling === undefined
            ? { value: false, source: "upstream-static", sourceRef: ref, observedAt, confidence: "unknown" }
            : upstreamEvidence(toolCalling, observedAt, ref),
        ...(reasoning !== undefined ? { reasoning } : {}),
        unsupportedParameters,
        status: override?.status ?? allowed.initialModelStatus ?? "candidate",
      });
    }
  }

  for (const rejection of input.moduleRejections) {
    rejections.push({
      upstreamId: rejection.upstreamId,
      scope: rejection.scope,
      exclusionClass: rejection.exclusionClass,
      path: rejection.path,
      sourcePath: rejection.sourcePath,
      reason: rejection.reason,
    });
  }

  providers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  models.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  rejections.sort(compareRejections);

  return {
    $comment:
      "GENERATED — do not edit. Produced by `bun run scripts/provider-source-sync.ts` from the pinned OmniRoute tree (see ../UPSTREAM.json). Every row here is shadowed by an overlay row of the same id/key if one exists (WS-13 §7: the overlay always wins), and every capability carries `upstream-static`/`inferred` evidence because that is all an extraction can honestly claim.",
    providers,
    models,
    rejections,
  };
}

/**
 * Did the extractor REFUSE **this** model's `unsupportedParams`, as opposed to upstream not stating any?
 *
 * The two produce the same empty array and only one is a gap, so the answer has to be per-MODEL —
 * and the first version of this was not. It matched `path.includes("models[")`, which is true for
 * every model in a file where ANY model had a refused field: three genuinely refused rows in
 * `openai/index.ts` produced nineteen ledger entries, sixteen of them asserting a refusal that never
 * happened. That is worse than a missing entry. A ledger whose job is "every place the catalog and
 * its source differ, with the reason" is read as evidence, so a false row is a false claim — the
 * same defect class as the `outputModalities` stamp this round's I3 fixed, reintroduced by the fix
 * for its sibling.
 *
 * The walker records ARRAY-INDEX paths (`openaiProvider.models[17].unsupportedParams`) — it has no
 * notion of a model id — so the index is the only thing the two sides genuinely share. Matching it
 * exactly is what makes this answer about one model rather than one file.
 */
function rawHasUnreadableUnsupportedParams(rejections: readonly Rejection[], sourcePath: string, modelIndex: number): boolean {
  const suffix = `models[${modelIndex}].unsupportedParams`;
  return rejections.some((r) => r.sourcePath === sourcePath && r.path.endsWith(suffix));
}

/**
 * Whether this file's model indices can be correlated at all (Lane X r2).
 *
 * The index the caller has is a position in the extractor's COMPACTED `models` array; the index in a
 * rejection path is the SYNTACTIC element position. A refused element is dropped from the first and
 * still counted in the second, and a spread contributes one syntactic index and any number of
 * compacted ones — so a single `models[N]`-level rejection in a file is enough to make every
 * correlation after it off by an unknown amount.
 *
 * The match is on ELEMENT-level paths only (`…models[7]`, `…models[7] (spread)`), not on field-level
 * ones (`…models[7].unsupportedParams`): a refused FIELD leaves its element in place and shifts
 * nothing. That distinction is the whole reason this can stay narrow instead of disabling the ledger
 * row for every file that has any rejection at all.
 */
function modelIndexCorrelationBroken(rejections: readonly Rejection[], sourcePath: string): boolean {
  return rejections.some((r) => r.sourcePath === sourcePath && /\.models\[\d+\](?: \(spread\))?$/.test(r.path));
}

function safeUrl(value: string): URL | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Total, stable rejection ordering: a ledger diff between two upstream bumps must show CHANGES, not churn. */
export function compareRejections(a: LedgerRejection, b: LedgerRejection): number {
  // NUL is the separator on purpose — every field here can contain a space, and a separator that
  // occurs in the data makes a composite key ambiguous. Written as an ESCAPE rather than as a
  // literal control character, which is what it was: eight raw NUL bytes on these two lines made the
  // whole file `data` to `file(1)`, so `grep` reported NO matches anywhere in it and anyone greping
  // for a symbol here — a reviewer reading the change, most of all — silently found nothing. Same
  // bytes in the key, same ordering, plain-text source.
  const SEP = "\u0000";
  const keyA = [a.upstreamId, a.exclusionClass, a.sourcePath, a.path, a.reason].join(SEP);
  const keyB = [b.upstreamId, b.exclusionClass, b.sourcePath, b.path, b.reason].join(SEP);
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

/** The overlay files a re-sync must NEVER write. Exported so the sync script's own guard and its test read the same list. */
export const OVERLAY_FILES = ["overlay/providers.json", "overlay/models.json"] as const;

/**
 * The overlay-wins merge, mirroring `scripts/provider-catalog.ts`.
 *
 * Used to VALIDATE a layer before the frozen script writes anything — never to write the committed
 * catalog. Row-level, not field-level: WS-13 §7's rule is that upstream never overwrites overlay
 * evidence, and a field-level merge would do exactly that for every field the overlay leaves out.
 */
export function mergeLayers(
  upstream: { providers: WinterProviderDescriptor[]; models: WinterModelDescriptor[] },
  overlay: { providers: WinterProviderDescriptor[]; models: WinterModelDescriptor[] },
  pin: WinterCatalog["upstream"],
): WinterCatalog {
  const overlayProviderIds = new Set(overlay.providers.map((p) => p.id));
  const overlayModelKeys = new Set(overlay.models.map((m) => m.key));
  const providers = [...upstream.providers.filter((p) => !overlayProviderIds.has(p.id)), ...overlay.providers];
  const models = [...upstream.models.filter((m) => !overlayModelKeys.has(m.key)), ...overlay.models];
  providers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  models.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    schemaVersion: 1,
    catalogVersion: pin.commit === "" ? "0.0.0-seed" : `${pin.tag}+${pin.extractorVersion}`,
    upstream: pin,
    providers,
    models,
  };
}
