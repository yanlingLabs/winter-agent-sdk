// The provider-runtime seam — every adapter lane's import surface.
//
// FROZEN as of P6 T2's merge (R6-12): lanes ADD files under `adapters/<family>/`, never edit this
// one. A lane that needs a change here stops with NEEDS_CONTEXT. WS-23's anthropic-cache lane was
// assigned this file explicitly (the `system` message role, `outputConfig`, the cache fields on
// `TurnRequest` and the richer `usage` event); every change it made is ADDITIVE and optional.
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
  /**
   * P7a: WHERE `baseUrl` came from — the sdk's `ProviderConnectionConfig.endpointOrigin`, carried
   * across the wire and into every adapter through `createProviderContext`.
   *
   * `"reviewed"` the catalog's own endpoint, copied into the profile by the runtime for an adapter
   * that serves several providers and so has no vendor default to fall back on.
   * `"user"`     a host- or user-entered endpoint. ABSENT means the same thing (see
   *              `connectionEndpointOptions` in endpoint-policy.ts for why unknown must read as
   *              user, and why only the runtime's copy path may stamp `"reviewed"`).
   *
   * Read in exactly one place — `connectionEndpointOptions` — so no adapter re-derives the rule.
   */
  endpointOrigin?: "reviewed" | "user";
}

/**
 * The material a `CredentialRef` resolves to, at the last responsible moment. NEVER persisted by
 * this package, never logged, never placed in an error message — `redactMaterial()` (credentials/
 * types.ts) is the only sanctioned way to render one.
 */
export type CredentialMaterial =
  | { kind: "api-key"; key: string }
  | {
      kind: "bearer";
      token: string;
      /**
       * P10a-4 (2026-09-13): when the token is host-brokered and renewable (Anthropic Console's
       * `ant auth print-credentials`, refreshed on a timer ahead of expiry), the host stamps this so
       * the renewer knows when to run again. OPTIONAL: most `bearer` material (a gateway or proxy
       * token a host pastes in by hand) has no known expiry, and absence must read as "unknown", not
       * "already expired" -- the same reasoning `oauth`'s own `expiresAt` already follows below.
       */
      expiresAt?: number;
    }
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
  /**
   * `system` (WS-23) is a MID-CONVERSATION system message: Anthropic's `role: "system"` entry inside
   * `messages` (https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages).
   * The engine produces one only in an OUTBOUND request, never in its history, and only for a model
   * whose catalog row documents it -- so an adapter for any other family never receives one.
   */
  role: "user" | "assistant" | "tool" | "system";
  content: string | ContentBlockLike[];
  /**
   * WS-23: a `system` message's own `output_config` -- the per-message effort change
   * (https://platform.claude.com/docs/en/build-with-claude/effort#change-effort-mid-conversation-beta).
   * An effort-only marker has EMPTY `content` and applies "from the next `user` turn". Only ever set on
   * a `system` message, and only for a row whose `reasoning.perMessageEffort` evidence documents it.
   */
  outputConfig?: { effort: string };
  uuid?: string;
  origin?: MessageOrigin;
  nativeState?: ProviderNativeState;
  /** A Winter-authored annotation shown to the model (a handoff note, a foreign-reasoning summary) — carried plainly, never dressed as signed thinking (R6-8). */
  decoration?: { text: string; door: "tag" | "thinking-channel" };
  /**
   * 0.0.16 request layout: a PERSISTED attachment (claude's `type: "attachment"` transcript entry).
   * The message's `content` is the attachment's rendered, `<system-reminder>`-wrapped text; this
   * field carries the attachment payload itself. Bookkeeping only -- no adapter reads it.
   */
  meta?: { attachment: { type: string; [k: string]: unknown } };
  /** 0.0.16 request layout: the per-request userContext message at index 0 (never persisted). Bookkeeping only. */
  isMeta?: true;
}

/**
 * 0.0.16 request layout: one system-prompt block and the cache scope claude assigns it.
 *
 * `global` is the cross-session static prefix, `org` the session-specific rest (including the
 * systemContext lines), `null` a block that is never cache-marked. An adapter with a native
 * block-level cache marker maps the scope onto it; every other adapter sends `TurnRequest.system`,
 * which is always these texts joined by a blank line.
 */
export interface SystemPromptBlock {
  text: string;
  cacheScope: "global" | "org" | null;
}

export interface TurnRequest {
  model: string;
  system?: string;
  /**
   * 0.0.16 request layout: `system` split into claude's cache blocks. When present, `system` is
   * exactly `systemBlocks.map(b => b.text).join("\n\n")` -- an adapter that has no block-level cache
   * marker ignores this field and sends `system`. Its presence is also the request layout's opt-in
   * to message-level prompt-cache markers (see the Anthropic adapter).
   */
  systemBlocks?: SystemPromptBlock[];
  messages: ProviderMessageLike[];
  /**
   * `deferLoading` (WS-23): declared but withheld until a `tool_reference` surfaces it (Anthropic's
   * `defer_loading: true`). The engine sets it only for a row whose catalog evidence documents
   * deferred tool loading, so no other family's adapter ever receives one.
   */
  tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; deferLoading?: true }>;
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
  /**
   * WS-23: the cache lifetime of the SYSTEM prompt's breakpoints. ABSENT means the provider's own
   * default (5 minutes on Anthropic); `"1h"` is written at twice the input price
   * (https://platform.claude.com/docs/en/build-with-claude/prompt-caching#1-hour-cache-duration). An
   * adapter with no such control ignores it.
   */
  cacheTtl?: "5m" | "1h";
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
  /**
   * ONE CONVENTION FOR EVERY FAMILY (review r1 finding 5): `inputTokens` is the NON-cached prompt
   * tokens only; `cacheReadTokens` / `cacheWriteTokens` are the cached / cache-written prompt tokens,
   * disjoint from it -- Anthropic's own accounting. A family whose API reports the TOTAL prompt with
   * the cached count as a subset (OpenAI Responses / Chat Completions, DeepSeek, Google) is
   * normalized in its adapter (`inputTokens = prompt - cached`), so `input + cacheRead + cacheWrite`
   * is the whole prompt, counted once, for every provider.
   */
  //
  // WS-23: `cacheWrite1hTokens` is the part of `cacheWriteTokens` written at the 1-hour lifetime
  // (Anthropic's `usage.cache_creation.ephemeral_1h_input_tokens`; `cache_creation_input_tokens` is
  // the sum of both lifetimes). A SUBSET, never added on top -- it exists so a 1-hour write is priced
  // at its own rate. Absent means every write was at the default lifetime.
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; cacheWrite1hTokens?: number }
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
