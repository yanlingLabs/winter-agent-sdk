// The provider-runtime seam — every adapter lane's import surface.
//
// FROZEN as of P6 T2's merge (R6-12): lanes ADD files under `adapters/<family>/`, never edit this
// one. A lane that needs a change here stops with NEEDS_CONTEXT.
//
// STRUCTURAL RULE (R6-4): this package NEVER imports `winter-agent-runtime`. The engine's
// `ProviderTurn`/`ProviderMessage`/`ContentBlock` stay defined in `engine.ts`, the runtime-side
// bridge (T3) folds an adapter's event stream into one `ProviderTurn`, and the dependency runs
// runtime → provider-runtime only. It DOES import `@yanlinglabs/winter-agent-sdk` (dependency-free,
// no cycle) for the one type Options must also carry: `CredentialRef`.

import type { ProviderProtocol, ToolCalling, WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";

// ONE declaration, re-exported — see the sdk's own protocol/config.ts header for why it lives there.
// A lane importing `CredentialRef` from either package gets the identical type.
export type { CredentialRef } from "@yanlinglabs/winter-agent-sdk";
import type { CredentialRef } from "@yanlinglabs/winter-agent-sdk";

/** The wire-mapping family an adapter belongs to. Coarser than `ProviderProtocol`: Azure and OpenRouter are both `openai`, Vertex and the Gemini API are both `google`. */
export type ProviderFamily = "openai" | "anthropic" | "google" | "bedrock" | "local-openai" | "custom";

/**
 * Non-secret connection metadata for one provider (WS-13 §6). `baseUrl` is a USER endpoint and goes
 * through `evaluateEndpoint`; a generated descriptor endpoint is immutable and never arrives here.
 *
 * `local: true` is a DECLARATION by the host, not a discovery: it is what lets `evaluateEndpoint`
 * accept a loopback/RFC-1918 `http://` target. An undeclared private address is still refused.
 */
export interface ConnectionProfile {
  providerId: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  region?: string;
  project?: string;
  location?: string;
  deployment?: string;
  apiVersion?: string;
  local?: boolean;
}

/**
 * The material a `CredentialRef` resolves to, at the last responsible moment. NEVER persisted by
 * this package, never logged, never placed in an error message — `redactMaterial()` (credentials/
 * types.ts) is the only sanctioned way to render one.
 */
export type CredentialMaterial =
  | { kind: "api-key"; key: string }
  | { kind: "bearer"; token: string }
  | { kind: "oauth"; accessToken: string; refreshToken?: string; expiresAt?: number; accountId?: string; idToken?: string }
  | { kind: "aws"; accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  | { kind: "gcp-service-account"; clientEmail: string; privateKeyPem: string; tokenUri: string }
  | { kind: "gcp-access-token"; token: string };

/**
 * Resolves credential references. `set`/`delete` are Keychain-only BY TYPE, not by convention: the
 * SDK never persists an `inline` value (a host responsibility), never writes an env var, and never
 * writes a credentials file. Making those unrepresentable is cheaper than documenting them.
 */
export interface CredentialStore {
  get(ref: CredentialRef): Promise<CredentialMaterial | null>;
  set(ref: Extract<CredentialRef, { kind: "keychain" }>, material: CredentialMaterial): Promise<void>;
  delete(ref: Extract<CredentialRef, { kind: "keychain" }>): Promise<void>;
}

/** The verdict of `ProviderAdapter.validateCredential`. `unsupported` means the adapter cannot check this ref KIND — not that the credential is bad. */
export type CredentialStatus =
  | { ok: true; accountId?: string; scopes?: string[] }
  | { ok: false; code: "missing" | "invalid" | "expired" | "network" | "unsupported"; message: string };

// --- message-level continuity ---------------------------------------------------------------------
//
// CANONICAL HOME of `MessageOrigin`/`ProviderNativeState`: the engine IMPORTS AND RE-EXPORTS them
// from here (it cannot be imported by this package — cycle), and T3's contract test asserts the
// engine's own `ContentBlock` is assignable to `ContentBlockLike` and back for every shared variant.

/** Which provider/model produced a message — the input to R6-9's continuation-domain check on resume, fallback and handoff. */
export interface MessageOrigin {
  providerId: string;
  modelKey: string;
  family: ProviderFamily | string;
  continuationDomain?: string;
}

/**
 * OPAQUE, adapter-owned provider state (OpenAI `encrypted_content`, Gemini `thoughtSignature`, xAI
 * opaque items). **Never logged, never model-readable, never in an error message or frame.** Its
 * only sink is the provider-state sidecar (R6-7); `items` is `unknown[]` precisely so nothing is
 * tempted to inspect it.
 */
export interface ProviderNativeState {
  family: string;
  continuationDomain: string;
  items: unknown[];
}

/**
 * The structural mirror of the captured wire content blocks (R6-D). Deliberately declared here
 * rather than imported from a floating `@anthropic-ai/sdk` peer: the pin declares NO wire block
 * shape at all (derived-shapes-p6.md item (f) — `redacted_thinking`, a `type: 'thinking'` literal
 * and `signature`-as-a-block-field have ZERO occurrences in the pinned artifact), so these shapes
 * come from the runtime's observed behaviour, and a dependency would buy nothing but drift.
 *
 * `thinking.signature` is a plain `string` that MAY be `""`: capture (F) shows the runtime
 * normalising a signatureless thinking block to exactly that and REPLAYING it. Typing it optional
 * would let a producer omit it and break the signature chain silently.
 */
export type ContentBlockLike =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string | ContentBlockLike[]; [k: string]: unknown }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_reference"; tool_names: string[] };

export interface ProviderMessageLike {
  role: "user" | "assistant" | "tool";
  content: string | ContentBlockLike[];
  uuid?: string;
  origin?: MessageOrigin;
  nativeState?: ProviderNativeState;
  /** A Winter-authored annotation shown to the model (a handoff note, a foreign-reasoning summary) — carried plainly, never dressed as signed thinking (R6-8). */
  decoration?: { text: string; door: "tag" | "thinking-channel" };
}

export interface TurnRequest {
  model: string;
  system?: string;
  messages: ProviderMessageLike[];
  tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  toolChoice?: { type: "auto" } | { type: "any" } | { type: "tool"; name: string };
  /**
   * KEEPS `number`, unlike `Options.effort` (R6-E): a child carries numeric effort
   * (`AgentDefinition.effort` is the pin's only numeric-admitting effort surface), and it reaches an
   * adapter through here. `mapEffort` maps a number to the nearest verified tier of the model's own
   * `reasoning.efforts` — the pin states no unit, range or mapping (a documented absence, OQ-P6-2),
   * so that is gap-filling rather than divergence, and it is disclosed.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | number;
  thinking?: { type: "disabled" } | { type: "enabled"; budgetTokens?: number } | { type: "adaptive" };
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** Ask the provider for a readable reasoning SUMMARY where its descriptor's `reasoning.summaryRequest` says how. Never a request for raw reasoning. */
  requestSummary?: boolean;
}

/**
 * The normalized stream every adapter produces. R6-5: the runtime-side bridge folds this into one
 * `ProviderTurn`, and only under `includePartialMessages` does any of it become `stream_event`s.
 */
export type ProviderEvent =
  | { type: "message_start"; id?: string; model?: string }
  | { type: "text_delta"; text: string }
  /** A provider-produced SUMMARY of reasoning. Never written into `assistant.message.content` (R6-8) — it rides the sidecar and the Winter-only `system/reasoning_summary` frame. */
  | { type: "thinking_summary_delta"; text: string }
  /** Raw exposed reasoning, for the models whose `readableState` is `full-exposed`. Same destination rule as the summary. */
  | { type: "thinking_exposed_delta"; text: string }
  /** A COMPLETE Anthropic-family in-dialect thinking/redacted block, carried verbatim with its real signature so it can be replayed in-dialect. */
  | { type: "native_thinking_block"; block: unknown }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; argumentsJsonDelta: string }
  | { type: "tool_call_end"; id: string }
  /** Opaque continuation state, COMPLETE, captured from the completion event — never an earlier partial copy (the descriptor's `reasoning.completionEvent` names which). */
  | { type: "native_state"; items: unknown[] }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  /**
   * R6-B: SUBSCRIPTION-QUOTA states ONLY, and the `kind` discriminant is what says so at the type
   * level. An HTTP 429 is NOT this event — capture (G) proved the pinned runtime emits zero
   * `rate_limit_event` frames for a 429 carrying a full `anthropic-ratelimit-*` header set with a
   * `rejected` unified status; the pinned 429 path is `api_retry` with `error_status: 429` and
   * `error: "rate_limit"`. So a 429 here is a `retry` event plus a normalized `rate_limit` error
   * code, and HEADER-DERIVED limits never become events at all.
   */
  | { type: "rate_limit"; kind: "subscription-quota"; info: Record<string, unknown> }
  /**
   * R6-C: mirrors the pinned `api_retry` payload minus its frame envelope (`uuid`/`session_id`,
   * which the runtime stamps). `error` is the CLOSED 11-member union, not a free string — the pin
   * types it that way (`sdk.d.ts:3092`) and `withRetry`'s producer already returns exactly that, so
   * a bare `string` here only made a consumer's exhaustive switch impossible to write.
   */
  | { type: "retry"; attempt: number; maxRetries: number; retryDelayMs: number; errorStatus?: number; error: SdkAssistantMessageError }
  /** A LOGIN-FLOW progress channel (codex-oauth login/refresh only), never the credential-failure frame — a bad key is a `ProviderError` with `code: "auth"`. */
  | { type: "auth_status"; isAuthenticating: boolean; output?: string[]; error?: string }
  | { type: "done"; stopReason: "end_turn" | "tool_use" | "max_tokens" | "aborted" | "refusal" }
  | { type: "error"; error: ProviderError };

/**
 * The normalized provider failure. `code` is Winter's own coarse taxonomy; `providerCode` is the
 * provider's VERBATIM structured code, parsed off the FULL body before any truncation (the OpenAI
 * envelope puts `code` after an unbounded human message, so a truncated body loses exactly the field
 * a consumer wants).
 *
 * `status` is carried so the engine can set the pinned `result.api_error_status` (R6-F). It is
 * ABSENT — not `null` — for a connection error with no HTTP response, which is the case the pinned
 * `api_retry.error_status: number | null` describes and which capture (G) could not reach.
 */
export interface ProviderError {
  code: "auth" | "rate_limit" | "server" | "network" | "bad_request" | "timeout" | "stall" | "aborted" | "capability";
  message: string;
  status?: number;
  providerCode?: string;
  retryAfterMs?: number;
  retryable: boolean;
}

/**
 * The pinned provider-error taxonomy, `sdk.d.ts:3159` — the closed 11-member `SDKAssistantMessageError`
 * carried on `api_retry.error`, `SDKAssistantMessage.error?` and `StopFailureHookInput.error`.
 *
 * These eleven buckets are all a Winter adapter has to map into for parity; anything finer is a
 * Winter extension to disclose (which is exactly what `ProviderError.providerCode` is).
 */
export type SdkAssistantMessageError =
  | "authentication_failed"
  | "oauth_org_not_allowed"
  | "account_on_hold"
  | "billing_error"
  | "rate_limit"
  | "overloaded"
  | "invalid_request"
  | "model_not_found"
  | "server_error"
  | "unknown"
  | "max_output_tokens";

export interface ProviderContext {
  connection: ConnectionProfile;
  credentials: CredentialStore;
  authRef: CredentialRef;
  stallTimeoutMs: number;
  /** Telemetry: provider/model identifiers and byte COUNTS only. Never content, never credential material, never opaque state (Global Constraints). */
  log: (event: { kind: string; providerId: string; model?: string; bytes?: number }) => void;
}

export interface DiscoveryContext extends ProviderContext {
  signal?: AbortSignal;
  /** WS-13 §7: discovery responses MUST be size-, time- and item-bounded. These are not advisory. */
  limits: { maxBytes: number; maxItems: number; timeoutMs: number };
}

export interface ModelCatalogResult {
  /** Model ids and names are UNTRUSTED display/input data (WS-13 §7) — never interpolated into a path, a command, or a log line unescaped. */
  models: Array<{ id: string; displayName?: string; contextWindow?: number; inputModalities?: string[] }>;
  /** True when the provider returned a page/subset rather than its whole catalog: the caller must NOT treat absence as removal. */
  partial: boolean;
  cached: boolean;
  warnings: string[];
}

export interface ProviderAdapter {
  readonly id: string;
  readonly version: string;
  readonly family: ProviderFamily;
  readonly protocol: ProviderProtocol;
  validateCredential(ref: CredentialRef, ctx: ProviderContext): Promise<CredentialStatus>;
  listModels(ctx: DiscoveryContext): Promise<ModelCatalogResult>;
  streamTurn(req: TurnRequest, ctx: ProviderContext): AsyncIterable<ProviderEvent>;
  /** R6-15: optional. `compact_metadata.post_tokens` is set from a REAL count when an adapter offers one, and omitted otherwise — never estimated. */
  countTokens?(req: TurnRequest, ctx: ProviderContext): Promise<number>;
  /** WS-13 §8.2: map onto the model's VERIFIED vocabulary or reject BEFORE sending a request. A silent downgrade to the provider's default is prohibited. */
  mapEffort(effort: TurnRequest["effort"], model: WinterModelDescriptor): { ok: true; value: unknown } | { ok: false; reason: string };
  capabilities(model: WinterModelDescriptor): { toolCalling: ToolCalling; continuationDomain?: string; readableState: "none" | "summary" | "full-exposed" };
}
