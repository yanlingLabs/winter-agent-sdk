// The Winter provider catalog's inert data shapes — WS-13 §4, Winter-named (D17).
//
// FROZEN as of Phase 6 Task 2's merge (R6-12): lanes ADD files, never edit this one. Everything
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

/** Where a capability claim came from. Ordered loosely from most to least durable. */
export type EvidenceSource = "official-doc" | "live-discovery" | "live-probe" | "upstream-static" | "user-override";

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

export interface WinterModelDescriptor {
  /** The stable Winter key, `<providerId>/<model>` (WS-13 §8.3). Globally unique across the catalog. */
  key: string;
  providerId: string;
  /** The provider-local id sent on the wire. Unique within a provider, and never assumed unique across providers. */
  upstreamId: string;
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
}

export interface WinterCatalog {
  schemaVersion: 1;
  catalogVersion: string;
  /** The upstream pin the generated layer came from. All-empty on the hand-authored SEED (`catalogVersion: "0.0.0-seed"`) — that emptiness is what says "not extracted". */
  upstream: { tag: string; tagObject: string; commit: string; extractorVersion: string; overlayVersion: string };
  providers: WinterProviderDescriptor[];
  models: WinterModelDescriptor[];
}

/** The result of `validateCatalog`. A failure carries EVERY error found, not just the first — a generator run wants the whole list. */
export type CatalogValidationResult = { ok: true; catalog: WinterCatalog } | { ok: false; errors: string[] };
