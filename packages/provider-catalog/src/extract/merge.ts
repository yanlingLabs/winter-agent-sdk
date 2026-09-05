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

// --- the allowlist file's shape (the extractor's input contract) --------------------------------

export interface AllowlistProviderRow {
  upstreamId: string;
  winterId: string;
  expectedCategory: string;
  risk: { class: "approved" | "review-required" | "blocked"; reasons: string[] };
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
  const hardBlocked = new Map(allowlist.blocked.filter((b) => b.upstreamId !== "*").map((b) => [b.upstreamId, b.reason]));

  const reject = (upstreamId: string, scope: LedgerRejection["scope"], exclusionClass: ExclusionClass, path: string, sourcePath: string, reason: string): void => {
    rejections.push({ upstreamId, scope, exclusionClass, path, sourcePath, reason });
  };

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
      reject(upstreamId, "provider", "category-local-live-discovery", upstreamId, catalogued.sourcePath, hard);
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
        "unrepresentable-protocol",
        `${allowed.upstreamId}.format`,
        registryPath,
        `upstream declares format ${JSON.stringify(format)} with executor ${JSON.stringify(executor)}: the OpenAI shape is what its own executor TRANSLATES FROM, not what the provider speaks on the wire. Winter records the executor's protocol (${protocol}) and drops the format claim.`,
      );
    }

    const adapter = PROTOCOL_TO_ADAPTER[protocol];
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

    for (const raw of rawModels) {
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
      const unsupportedParameters = strArray(raw, "unsupportedParams") ?? [];
      const aliases = (strArray(raw, "aliases") ?? []).filter((alias) => alias !== id);
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
        key: `${allowed.winterId}/${id}`,
        providerId: allowed.winterId,
        upstreamId: id,
        displayName: str(raw, "name") ?? id,
        aliases,
        endpoints,
        ...(contextWindow !== undefined ? { contextWindow: upstreamEvidence(contextWindow, observedAt, ref) } : {}),
        ...(maxInput !== undefined ? { maxInputTokens: upstreamEvidence(maxInput, observedAt, ref) } : {}),
        ...(maxOutput !== undefined ? { maxOutputTokens: upstreamEvidence(maxOutput, observedAt, ref) } : {}),
        inputModalities: upstreamEvidence(inputModalities, observedAt, ref),
        outputModalities: upstreamEvidence(["text"], observedAt, ref),
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
        status: "candidate",
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
  const keyA = `${a.upstreamId} ${a.exclusionClass} ${a.sourcePath} ${a.path} ${a.reason}`;
  const keyB = `${b.upstreamId} ${b.exclusionClass} ${b.sourcePath} ${b.path} ${b.reason}`;
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
