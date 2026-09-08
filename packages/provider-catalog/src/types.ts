// The Winter provider catalog's inert data shapes — WS-13 §4, Winter-named (D17).
//
// FROZEN BETWEEN PHASES (R6-12): only a phase's SPINE task edits this file (P6.6's did, WS-13c
// §1); lanes ADD files, never edit this one. Everything
// here is *data*: no function, no class, no Bun API, no `fetch`, no filesystem. WS-13 §4's own MUST
// is that descriptors are "safe inert data, decodable in Bun and Swift without executing upstream
// code", which is why this package is inside tsconfig.sdk-fence.json (type-checked with Node's
// ambient globals only — see that file's header).
//
// The evidence wrapper is the point of the whole schema: WS-13 §4 requires "capability claims carry
// evidence + date, never timeless booleans". A bare `contextWindow: 200000` is a claim nobody can
// audit; `CapabilityEvidence<number>` records where the number came from, when it was observed, and
// how much the reader should trust it.

/** The wire dialect an adapter speaks. One adapter family per protocol (WS-13 §5) — never one ported executor per upstream row. */
export type ProviderProtocol =
  | "openai-responses"
  | "openai-chat-completions"
  | "anthropic-messages"
  | "google-generate-content"
  | "bedrock-converse"
  | "azure-openai"
  | "custom";

/** How a provider is authenticated. `local-none` is a real, first-class kind — a local endpoint with no key is not a degenerate api-key case (WS-13 §6). */
export type ProviderAuthKind = "api-key" | "oauth-approved" | "cloud-credential-chain" | "local-none" | "custom";

/**
 * Where a capability claim came from. Ordered loosely from most to least durable.
 *
 * The last two are WINTER'S OWN, and they exist because the alternative was a false label. The
 * upstream mapper has to stamp `outputModalities` on every row, upstream's `RegistryModel` declares
 * no output modality for ANY model, and the only members available were provider-shaped -- so
 * `["text"]`, which is Winter's inference for a chat registry, shipped as `source: "upstream-static"`
 * with the caveat pushed into a `sourceRef` sentence nothing reads programmatically. A reader
 * filtering for "what upstream said" got a Winter guess (whole-branch review, Lane X r1 carry).
 *
 *   `winter-default` — a value WINTER chose in the absence of any upstream or vendor statement. Not
 *     a normalization of anything: the field is required and something has to be in it.
 *   `local-override` — a value from a LOCAL, non-vendor declaration: an operator's own configuration
 *     for a local endpoint, which is neither a vendor document nor a probe of one.
 *
 * Both are strictly less durable than `user-override` (a deliberate human statement about a specific
 * row), so they sort last. Neither may ever carry `confidence: "verified"`; the validator enforces it.
 */
export type EvidenceSource = "official-doc" | "live-discovery" | "live-probe" | "upstream-static" | "user-override" | "local-override" | "winter-default";

/** How much the reader should trust the claim. `unknown` is a legitimate, recordable state — never a reason to omit the evidence wrapper and assert a bare value. */
export type EvidenceConfidence = "verified" | "declared" | "inferred" | "unknown";

/** A capability claim with its provenance. `observedAt` is an ISO-8601 instant when present. */
export interface CapabilityEvidence<T> {
  value: T;
  source: EvidenceSource;
  sourceRef?: string;
  observedAt?: string;
  confidence: EvidenceConfidence;
}

/**
 * WS-13 §8.1's three-state tool capability. `native` becomes agent-eligible only after schema/
 * streaming proof; `emulated` is DISABLED BY DEFAULT for agent modes; `none` fails capability
 * negotiation when the mode requires tools. Silently dropping tools and continuing as plain chat is
 * prohibited — which is why this is three states and not a boolean.
 *
 * Disclosed divergence (derived-shapes-p6.md item (d), OQ-P6-3): the pinned `ModelInfo` has NO
 * tool-capability field at all, so this three-state model is a Winter extension with no pinned
 * counterpart, not a mirror of one.
 */
export type ToolCalling = "native" | "emulated" | "none";

/**
 * A row's promotion state. Every row a lane adds starts `candidate`; promotion to `supported`
 * requires the behavioural corpus (WS-13 §13). `blocked` is the only value the registry refuses to
 * resolve — a `candidate` row is resolvable (that is what makes a lane's own fixtures runnable).
 */
export type ModelStatus = "candidate" | "experimental" | "supported" | "deprecated" | "blocked";

/**
 * WS-13 §8.2, amended 2026-09-02 from the reasoning-continuity report. "Provider" is NOT the
 * capability unit here — the exact endpoint+model is: same-provider does not imply same
 * continuation domain (Anthropic strips thinking across Claude models), so `continuationDomain`
 * lists the models PROVEN to accept this endpoint's native continuation object.
 */
export interface ReasoningCapabilities {
  supported: CapabilityEvidence<boolean>;
  /** The model's own effort vocabulary, verbatim. Vocabularies are NOT interchangeable across providers (WS-13 §8.2). */
  efforts: string[];
  defaultEffort?: string;
  continuation: "none" | "plaintext" | "opaque-provider-state" | "server-response-handle";
  readableState?: CapabilityEvidence<"none" | "summary" | "full-exposed">;
  /** e.g. Anthropic `display: "summarized"`, OpenAI `reasoning.summary`, Gemini `includeThoughts`. */
  summaryRequest?: CapabilityEvidence<{ field: string; values: string[] }>;
  replayScope?: CapabilityEvidence<"current-tool-loop" | "current-turn" | "selected-turns" | "all-turns">;
  continuationDomain?: CapabilityEvidence<string[]>;
  /** The stream/final event from which the COMPLETE replay object must be captured — never an earlier partial copy. */
  completionEvent?: CapabilityEvidence<string>;
  /** What missing reasoning state costs mid-tool-loop (DeepSeek with tools: a 400). */
  toolLoopRequirement?: CapabilityEvidence<"hard-error" | "silent-degradation" | "not-required">;
}

/** List prices, USD per million tokens. R6-H: the ONLY price source Winter has — an unpriced model reports `0` / `costBasis: "unknown"`, never an invented number. */
export interface ModelPricing {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  cacheReadPerMTokUsd?: number;
  cacheWritePerMTokUsd?: number;
}

/**
 * WS-13c §2: where a slot's ranking and its description came from.
 *
 * `user-ruling` carries the user's own framing verbatim (or a faithful one-sentence condensation
 * that keeps the user's key phrase); `vendor-doc` cites the vendor's model page; `winter-curated` is
 * Winter's own editorial judgement and enters `candidate` until the user reviews it (§9).
 */
export type SlotBasis = "user-ruling" | "vendor-doc" | "winter-curated";

/** A slot's promotion state, mirroring `ModelStatus`'s two reviewed values (WS-13c §2/§9). */
export type SlotStatus = "candidate" | "supported";

/**
 * One ranked option in a family's lineup (WS-13c §2).
 *
 * POSITION IN THE ARRAY IS THE OPTION ORDER, NOT A STRENGTH CLAIM (D26): the Gemini case is the
 * whole reason the two text fields are required and separate — 3.8 Flash is documented as the
 * strongest while 3.1 Pro still leads the list on breadth. `description` says what it is good for
 * and `reason` says why it holds this position; neither may carry a currency amount, because pricing
 * lives on model rows with its own evidence wrapper and a price copied into prose is a price nobody
 * can audit or update.
 */
export interface FamilySlot {
  /** The facing enum token people know (`astra`, `flash`, `grok-4.6`). Matches `^[a-z0-9][a-z0-9.-]{0,31}$`; never a version number alone. */
  name: string;
  /** Resolves to at least one model row's `canonicalModelId` — the integrity suite refuses a slot on a missing row, so no id is invented into `generated/`. */
  canonicalModelId: string;
  /** Pins a serving provider id (WS-13c §4 step 4). Optional; it must survive the credential/enablement filter or the slot is unservable. */
  provider?: string;
  /** What this option is for. No currency amounts. */
  description: string;
  /** Why it holds this position in the lineup. */
  reason: string;
  basis: SlotBasis;
  citation: string;
  status: SlotStatus;
}

/**
 * A vendor lineup, independent of the provider that serves it (WS-13c §1).
 *
 * `matchers` are anchored RegExp SOURCES evaluated over `canonicalModelId`, first match wins. They
 * are authored DISJOINT (`^gpt-(?!oss)` beside `^gpt-oss-`) so the pipeline's sort-by-id can never
 * change a row's stamp; `catalog-integrity.test.ts` asserts that order independence over the real
 * catalog rather than trusting the authoring.
 *
 * `vendorProviders` is ORDERED and is step 3-i of slot resolution: the vendor's own rows first, a
 * configured SUBSCRIPTION row before a token row of the same vendor.
 */
export interface ModelFamilyDescriptor {
  /** `^[a-z0-9][a-z0-9-]{0,31}$`. `other` is the reserved id for a row no matcher claims. */
  id: string;
  displayName: string;
  vendor: string;
  /** Ordered provider ids, subscription row before token row of the same vendor (WS-13c §4 step 3-i). */
  vendorProviders: string[];
  /** Anchored RegExp sources over `canonicalModelId`; first match wins. Authored disjoint. */
  matchers: Array<{ pattern: string; note: string }>;
  /** 0..4, unique names. A family with zero slots is legal — it is listed under "more options" only. */
  slots: FamilySlot[];
  status: "candidate" | "supported";
  citation: string;
}

export interface WinterModelDescriptor {
  /** The stable Winter key, `<providerId>/<model>` (WS-13 §8.3). Globally unique across the catalog. */
  key: string;
  providerId: string;
  /** The provider-local id sent on the wire. Unique within a provider, and never assumed unique across providers. */
  upstreamId: string;
  /**
   * WS-13c §1: the family id this row's model belongs to, or `"other"` when no matcher claims it.
   *
   * DERIVED AT BUILD by `stampFamilyFields`; an overlay row MAY set it as an override, and the
   * stamper never overwrites a value that is already there. Never `WinterProviderDescriptor.family`,
   * which is the ADAPTER family and keeps its own meaning (R13c-1).
   */
  modelFamily: string;
  /**
   * WS-13c §1: the vendor's model identity with the provider's spelling removed, so
   * `deepseek/deepseek-v4-pro`, `vertex/DeepSeek-V4-Pro` and `qwen-cloud/deepseek-v4-pro` are ONE
   * canonical model.
   *
   * DERIVED AT BUILD by `stampFamilyFields` (via `canonicalModelIdOf`); an overlay row MAY set it as
   * an override, which is how `kimi-coding/k3` — whose coding-plan id is just `k3` — reaches the
   * same canonical model as `moonshot/kimi-k3`.
   */
  canonicalModelId: string;
  displayName: string;
  aliases: string[];
  endpoints: Array<"chat" | "responses" | "embeddings" | "image" | "audio" | "video">;
  contextWindow?: CapabilityEvidence<number>;
  maxInputTokens?: CapabilityEvidence<number>;
  maxOutputTokens?: CapabilityEvidence<number>;
  inputModalities: CapabilityEvidence<string[]>;
  outputModalities: CapabilityEvidence<string[]>;
  toolCalling: CapabilityEvidence<ToolCalling>;
  nativeTools: CapabilityEvidence<boolean>;
  parallelTools?: CapabilityEvidence<boolean>;
  structuredOutput?: CapabilityEvidence<boolean>;
  promptCaching?: CapabilityEvidence<boolean>;
  reasoning?: ReasoningCapabilities;
  pricing?: CapabilityEvidence<ModelPricing>;
  /** R6-14: set only after the safety corpus passes live. A worker with no configured classifier route serves only when this is true AND `structuredOutput.confidence === "verified"`. */
  classifierEligible?: CapabilityEvidence<boolean>;
  /** Request parameters this model rejects. Adapters must not send them (WS-13 §8.2: reject the selection BEFORE sending). */
  unsupportedParameters: string[];
  status: ModelStatus;
}

export interface WinterProviderDescriptor {
  id: string;
  displayName: string;
  protocols: ProviderProtocol[];
  authKinds: ProviderAuthKind[];
  /** Generated endpoints are IMMUTABLE (R6-11): a user override rides `ConnectionProfile.baseUrl` and goes through the endpoint policy instead. */
  defaultEndpoints: Record<string, string>;
  modelDiscovery: "none" | "openai-models" | "provider-native" | "local";
  /**
   * Whether the live catalog is the last word on which models exist. `authoritative` means an id
   * absent from live discovery does not exist; anything else means the compiled seed may still be
   * right — and, per R6-F, is the precondition for an `allowUnlisted` connection passing an
   * unlisted id straight through.
   */
  liveCatalogAuthority: "authoritative" | "partial" | "unknown";
  adapterId: string;
  /** The adapter FAMILY this provider's wire mapping belongs to; mirrors `ProviderFamily` in provider-runtime (kept a bare string here so the data package stays free of the runtime's unions). */
  family: string;
  /** `project: "winter"` marks a Winter-owned provider (codex-oauth per D11, and every local id) that no upstream extraction produced. */
  upstream: { project: "OmniRoute" | "winter"; commit: string; sourcePaths: string[] };
  risk: { class: "approved" | "review-required" | "blocked"; reasons: string[] };
  /** WS-13 §4: only `llm` rows feed the Agent SDK's model selection; the other scopes feed separate subsystems and must never reach the worker-model picker. */
  scope: "llm" | "stt" | "tts" | "embedding" | "image" | "video" | "search";
  /**
   * WS-13b §1: how the vendor charges for the credential Winter actually uses.
   *
   * DATA, not a derived guess, and it is the whole reason the field exists: R6-H prices a turn from
   * the model row's `pricing` evidence, and a subscription-priced backend (the ChatGPT Codex
   * entitlement, a "coding plan") has list prices published for its API twin that do NOT describe
   * what this credential is billed. `subscription`/`free` rows never feed `total_cost_usd`/
   * `modelUsage` — a per-token number for a seat is not a smaller error than no number, it is a
   * wrong one that reads as authoritative.
   */
  pricingBasis: "token" | "subscription" | "free";
  /**
   * WS-13b §1 (D21): the documented third-party path this row ships through, and the citation that
   * admits it.
   *
   * R6b-3 makes the citation load-bearing rather than decorative: `validateCatalog` refuses a row
   * whose `citation` is absent or empty (`admission-missing`), and refuses one that cites the
   * audit's own `unknown` evidence class (`admission-unknown`) — "the decisive document was not
   * found" is a disposition to EXCLUDE, so a row may not ship carrying it.
   *
   * `citation` forms, in order of strength: a URL to the vendor document; `audit:<section>` for the
   * third-party-access audit's evidence table; `spec:<section>` for a Winter spec ruling that admits
   * a class of rows (WS-13 §1's disposition table admits the reviewed api-key/cloud allowlist rows);
   * `local` for a `local-none` row, whose "vendor" is the operator's own machine.
   */
  admission: { basis: "api-key" | "oauth-documented" | "keyless-documented" | "local" | "cloud-credential"; citation: string; tier: AdmissionTier };
  /**
   * WS-13b §2/§7/§8.4 (fix-wave ruling R-FW-2): the SECOND identity field this vendor names, if it
   * names one.
   *
   * Winter's `User-Agent` is unconditional and lives in code (`identity.ts`). This is the per-row
   * half: AI Horde documents a `Client-Agent: <name>:<version>:<contact>` field, and the spec's own
   * words are "a truthful `Client-Agent`" — an obligation that fell between the row author (who
   * cited the header) and the adapter owner (whose lane was the live gate), and shipped as prose on
   * neither side. Making it DATA on the row is what stops that: the row that documents the header is
   * the row that carries it, and one seam applies every row's.
   *
   * WHAT MAY BE HERE, enforced by `validateCatalog` rather than by review:
   *   - the NAME must be one of a Winter-authored allowlist (`Client-Agent` today). A row may not
   *     invent a header name, and it may certainly not name a vendor's product-identity field —
   *     that is the exact thing WS-13 §5 and D21 forbid, and a free-text name field would be a hole
   *     straight through both.
   *   - the VALUE must begin with the `<product>` PLACEHOLDER. The running product names ITSELF in
   *     every identity field; a value naming an editor, a CLI or a first-party product is not a
   *     configuration mistake to fix later, it is impersonation. The literal Winter package name was
   *     accepted here until the P7a fix wave, for "rows written before the profile existed" — no row
   *     was ever written that way, and a hard-coded product token is precisely what this rule calls
   *     impersonation when somebody else does it.
   *   - THREE PLACEHOLDERS are substituted by the adapter at request time (provider-runtime's
   *     `renderIdentityHeaders`): `<version>` with this build's own version, so a release cannot
   *     leave a stale number on the wire; `<product>` (P7a, D19) with the running brand's
   *     `packageName`, so a REUSER's identity header names the reuser rather than Winter; and
   *     `<contact>` (P7a fix wave) with `brand.contactUrl`. The contact is the half of the
   *     `<name>:<version>:<contact>` triple a vendor actually acts on, so a row hard-coding a
   *     repository URL sends every reuser's traffic to whoever owns that repository — the same
   *     untruth as the product token, and less visible, because the row still LOOKS rebranded.
   *
   * NOT routed through `applyPrivilegedHeaders`. This is Winter's own identity, the same class as
   * the `User-Agent` beside it — it discloses nothing about the operator, and gating it on a
   * generated endpoint would silently drop it for every multi-provider row, whose reviewed endpoint
   * is COPIED into the connection profile and therefore evaluated as a user endpoint (seam 1c).
   * `aihorde` is exactly such a row, so a privileged reading would have delivered the header in a
   * fixture and never in production.
   */
  identityHeaders?: Record<string, string>;
  /**
   * P7a carry (Lane D): a PER-TENANT provider whose API endpoint is the customer's own resource, so
   * the row ships with NO usable `defaultEndpoints.api` at all (`azure-ai`, `oci`).
   *
   * `true` is the only value: absence means "the row's endpoint is usable as shipped", and a `false`
   * would be a claim no row needs to make. A session selecting such a row without supplying an
   * endpoint is a typed `endpoint-required` refusal — never a request sent to a placeholder host.
   *
   * DECLARED AT P7a'S SPINE, RULED ON BY LANE D: the validator ACCEPTS this field (shape only) so
   * both halves can land independently; the rules that bind it to `defaultEndpoints`, and the rows
   * that set it, are Lane D's.
   */
  requiresUserEndpoint?: true;
  /**
   * DOCUMENTATION ONLY, never sent: the shape a user's own endpoint takes for a
   * `requiresUserEndpoint` row, e.g. `"https://<resource>.services.ai.azure.com/models"`.
   *
   * It exists so a host can TELL the user what to paste. Nothing resolves it, nothing substitutes
   * into it, and no request is ever built from it — a template that reached the wire would be a
   * request to a literal `<resource>` host.
   */
  endpointTemplate?: string;
}

/**
 * WS-13b §1 (fix-wave ruling R-FW-3): HOW GOOD the evidence behind `admission.citation` is, as DATA.
 *
 * The tiers were prose before this — a marker inside the citation STRING, explained in PROVENANCE.md
 * — and the one test that claimed to keep the fifteen reviewed rows out of the weakest tier could
 * not: it matched `^https?:\/\/`, which a pinned-upstream citation also satisfies. Nothing in the
 * validator, the live gate or the promotion path could key on a substring, so the label drifted from
 * the rows it described (`minimax` sat in the weak tier while its own sibling cited a fetched
 * MiniMax document naming the same base URL).
 *
 *   `fetched-document`  a page this repository's lane FETCHED and READ, quoted in the citation with
 *                       the date it was retrieved. The strongest tier and the only one a `supported`
 *                       model may sit on.
 *   `pinned-upstream`   the vendor's own site as OmniRoute's product catalog records it at the pin,
 *                       plus the pinned `RegistryEntry` (auth type, dialect, base URL). An admission
 *                       of the PATH and a placeholder for the DOCUMENT: honest, consequential
 *                       (`review-required`, models `candidate`), and never a claimed review that did
 *                       not happen.
 *   `spec-ruling`       a Winter spec ruling admits the row as a class (WS-13b §0 D20).
 *   `audit`             the third-party-access audit's own evidence table.
 *   `local`             the "vendor" is the operator's own machine.
 *
 * PROMOTION IS TWO-KEY (ruling (b)): a live-gate pass AND a fetched vendor document, with the
 * citation upgraded in the same reviewed commit. `catalog-integrity.test.ts` asserts the half a test
 * can hold — no `approved` row and no `supported` model on `pinned-upstream` — and the live gate's
 * report row prints the tier so a promotion cannot be made from a pinned row by habit.
 */
export type AdmissionTier = "fetched-document" | "pinned-upstream" | "spec-ruling" | "local" | "audit";

export interface WinterCatalog {
  /** 2 since WS-13c: every model row carries `modelFamily`/`canonicalModelId` and the document carries `families`. */
  schemaVersion: 2;
  catalogVersion: string;
  /** The upstream pin the generated layer came from. All-empty on the hand-authored SEED (`catalogVersion: "0.0.0-seed"`) — that emptiness is what says "not extracted". */
  upstream: { tag: string; tagObject: string; commit: string; extractorVersion: string; overlayVersion: string };
  providers: WinterProviderDescriptor[];
  models: WinterModelDescriptor[];
  /** WS-13c §1: the vendor lineups, generated from `overlay/families.json` and sorted by `id`. May be empty (a layer validated standalone has no families). */
  families: ModelFamilyDescriptor[];
}

/**
 * One validation failure.
 *
 * `message` is the whole human sentence, `path`-prefixed — byte-identical to the strings this
 * result used to be an array of, so every existing consumer (`loadCatalog`'s throw, the two
 * scripts' stderr, the tests' `includes` helper) reads the same text it always did.
 *
 * `code` is P6.5's addition and the reason the shape changed at all: R6b-3 is a rule a GATE has to
 * key on ("a row without an admission citation fails validation"), and keying a gate on prose is
 * how a reworded message silently disarms it. Codes are opt-in — every pre-existing check reports
 * the generic `invalid`, and only the rules something else keys on carry a specific one. Widening
 * that is a later, deliberate edit, not a prerequisite for this one.
 */
export interface CatalogValidationError {
  code: string;
  /** JSON-pointer-ish location of the offending value, e.g. `providers[3].admission.citation`. */
  path: string;
  /** `${path}: ${reason}` — the complete sentence. */
  message: string;
}

/** The result of `validateCatalog`. A failure carries EVERY error found, not just the first — a generator run wants the whole list. */
export type CatalogValidationResult = { ok: true; catalog: WinterCatalog } | { ok: false; errors: CatalogValidationError[] };
