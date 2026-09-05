// Phase 6 Task 6 (Lane B): the Anthropic Messages adapter -- `anthropic-messages@1`.
//
// ADDED under `adapters/anthropic/` (R6-12). It touches nothing frozen: `boundedFetch`, `parseSse`,
// `withRetry`, `normalizeHttpError`, `createEndpointPolicy` and `applyPrivilegedHeaders` are Task 2's
// core and this adapter's ONLY doors to the network, to retries and to error normalization.
//
// FIVE DECISIONS THAT LOOK OPTIONAL AND ARE NOT:
//
//   1. **The capability checks run BEFORE the request, not after it fails upstream.** WS-13 §8.2 and
//      the lane's own constraint ("unsupported effort/thinking is rejected BEFORE the request with a
//      typed error") mean an unverified effort, an unsupported thinking arm, a tool set a model
//      cannot call natively, an image a model cannot see, or a thinking budget that does not fit
//      inside `max_tokens` all fail with a typed `capability` error and ZERO requests on the wire.
//      A fixture asserts `fake.requests` is empty for each -- which is the only assertion that can
//      tell "rejected before" from "rejected after".
//
//   2. **The adapter reads its model's descriptor from the CATALOG, not from `ProviderContext`.**
//      `ProviderAdapter.mapEffort(effort, model)` takes a descriptor, but `streamTurn(req, ctx)` has
//      no way to see one -- and `mapEffort` has no production caller anywhere in the repo (verified
//      by grep). So a pre-request check that depended on someone else calling `mapEffort` would
//      never run. The factory takes an optional `catalog` (defaulting to the compiled one) and looks
//      the descriptor up by `ctx.connection.providerId` + `req.model`; `mapEffort` stays the public,
//      descriptor-taking seam and delegates to the same function, so the two can never disagree.
//
//   3. **In-dialect thinking is captured at `content_block_stop` and NOWHERE else.** A `thinking`
//      block's `signature_delta` arrives last inside its own block, so a block emitted at
//      `content_block_start` (or on its first delta) would carry no signature -- and R6-8's whole
//      point is that the REAL signature rides in-dialect. A stream that drops mid-block therefore
//      yields no `native_thinking_block` at all, which is the completion-event rule stated as
//      behaviour.
//
//   4. **Anthropic thinking is never a `thinking_summary_delta`.** That event is for FOREIGN
//      reasoning a Winter-only frame carries (R6-8). Anthropic's own thinking blocks are in-dialect:
//      they ride `native_thinking_block`, become `ContentBlock`s the engine persists, and are
//      replayed byte-identically. `requestSummary` therefore only sets the descriptor's own
//      `thinking.display` field -- it never re-routes the reasoning to another channel.
//
//   5. **Retry stops at the first byte, and the retry OBSERVATIONS still reach the consumer.**
//      `withRetry` wraps only the fetch; `parseSse` runs outside it, so nothing past the first byte
//      can be replayed (WS-13 §13). `withRetry`'s callback cannot `yield`, so its events are
//      buffered and flushed ahead of the first stream event -- the same order a consumer would have
//      seen, since every retry precedes the stream by construction.
import type { WinterCatalog, WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { boundedFetch, ProviderRequestError } from "../../http.ts";
import { normalizeHttpError, normalizeThrown } from "../../errors.ts";
import { createRetryPolicy, withRetry, type RetryPolicyOptions } from "../../retry.ts";
import { applyPrivilegedHeaders, createEndpointPolicy, type EndpointPolicy } from "../../endpoint-policy.ts";
import { hostHeaders } from "../privileged-headers.ts";
import { containsImage } from "../content-blocks.ts";
import { parseSse } from "../../sse.ts";
import type {
  ContentBlockLike,
  CredentialRef,
  CredentialStatus,
  DiscoveryContext,
  ModelCatalogResult,
  ProviderAdapter,
  ProviderContext,
  ProviderError,
  ProviderEvent,
  ProviderMessageLike,
  TurnRequest,
} from "../../types.ts";

/** The provider id this adapter is registered for, and the catalog's own `adapterId` for it. */
export const ANTHROPIC_ADAPTER_ID = "winter.anthropic-messages";
/** The GENERATED endpoint. Immutable (R6-11); a user override rides `ConnectionProfile.baseUrl`. Pinned to the catalog row by a test. */
export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
/** The `anthropic-version` header every request carries. A protocol header, never a privileged one (R6-L). */
export const ANTHROPIC_API_VERSION = "2023-06-01";

/**
 * The wire `max_tokens` when neither the request nor the descriptor names one.
 *
 * DISCLOSED GAP-FILL: `max_tokens` is mandatory on this endpoint, `streamTurn` receives no
 * descriptor guarantee, and the seed catalog carries no `maxOutputTokens` evidence for either
 * Anthropic row. Capture (F) observed the pinned runtime sending 64000 for `claude-sonnet-5`, but
 * that is one model's ceiling and inventing it for every model would be a capability claim with no
 * evidence behind it. 4096 is the value the family's own documentation has used as the conservative
 * default for as long as the endpoint has existed; a host that wants more sets
 * `TurnRequest.maxOutputTokens` or the descriptor carries `maxOutputTokens` evidence.
 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

/**
 * The effort -> thinking-budget ladder.
 *
 * WINTER-AUTHORED AND DISCLOSED. The pin states no unit, no range and no mapping for effort
 * (derived-shapes-p6.md item (c): "the answer is a documented absence", OQ-P6-2), and the Messages
 * endpoint declares no `effort` field at all -- the only reasoning dial it exposes is the `thinking`
 * budget, and the pin's own `maxThinkingTokens` deprecation note is explicit that the two are the
 * same knob. So effort maps onto a budget, and the ladder doubles per tier from a 4k floor. It is a
 * gap-fill rather than a divergence, and `mapEffort` refuses any tier the MODEL'S OWN
 * `reasoning.efforts` does not list, so the ladder can never invent a capability.
 */
const EFFORT_BUDGET_TOKENS: Readonly<Record<string, number>> = {
  low: 4_096,
  medium: 8_192,
  high: 16_384,
  xhigh: 32_768,
  max: 65_536,
};

export interface AnthropicAdapterOptions {
  /** The catalog the descriptor is looked up in. Defaults to the compiled one; injected in tests so a fixture owns its own rows. */
  catalog?: WinterCatalog;
  /** Milliseconds allowed for RESPONSE HEADERS. Not a bound on the generation -- mid-stream silence is `ctx.stallTimeoutMs`'s job. */
  requestTimeoutMs?: number;
  maxBodyBytes?: number;
  /** Injected for deterministic retry fixtures (no real sleeping, no real jitter). */
  retry?: RetryPolicyOptions;
  /** `anthropic-beta` values, joined with commas. A PROTOCOL header (R6-L): every endpoint needs it to be spoken to, and it names no account. */
  betas?: string[];
  defaultMaxOutputTokens?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
/** Discovery reads a JSON page, not a generation: its own byte bound comes from `DiscoveryContext.limits`. */
const MAX_DISCOVERY_PAGES = 10;

// --- wire serialization ---------------------------------------------------------------------------

/** A capability refusal, raised BEFORE any request reaches the network. Never retryable: no amount of backoff makes a model gain a capability. */
function capabilityRefusal(reason: string): ProviderRequestError {
  return new ProviderRequestError({ code: "capability", message: reason, retryable: false });
}

/**
 * One engine content block -> one wire block.
 *
 * `thinking` and `redacted_thinking` pass through VERBATIM -- signature and opaque data intact --
 * because that is what "Anthropic-family blocks ride in-dialect with their real signatures" (R6-8)
 * means at the only place it can be enforced. Nothing here strips, re-signs or normalizes them.
 */
function toWireBlock(block: ContentBlockLike): Record<string, unknown> {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return { type: "image", source: { type: block.source.type, media_type: block.source.media_type, data: block.source.data } };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "thinking":
      // VERBATIM, both fields. A signature-stripped replay is exactly the failure R6-8 forbids.
      return { type: "thinking", thinking: block.thinking, signature: block.signature };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: block.data };
    case "tool_result": {
      const content = Array.isArray(block.content) ? block.content.map(toWireBlock) : block.content;
      // Winter's provisional markers (`interrupted`/`denied`/`deferred`/`loadFirst`) are BOOKKEEPING,
      // not wire fields: the result's own content already carries what the model needs to read. Only
      // `error` has a wire counterpart, and dropping it would tell the model a failed call succeeded.
      const isError = (block as { error?: unknown }).error === true;
      return { type: "tool_result", tool_use_id: block.tool_use_id, content, ...(isError ? { is_error: true } : {}) };
    }
    case "tool_reference":
      // A Winter-owned, STREAMING-ONLY block (engine.ts writes it straight to the output frame
      // stream and never into a `ProviderMessage`). It has no wire counterpart, so it is a typed
      // refusal rather than a silent drop -- the lane's "no silent tool-dropping" rule applies to
      // history as much as to calls.
      throw capabilityRefusal("a `tool_reference` block reached the Anthropic serializer; it is a Winter streaming-only block with no wire counterpart and is never silently dropped");
  }
}

function normalizeContent(content: string | ContentBlockLike[]): Record<string, unknown>[] {
  if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
  return content.map(toWireBlock);
}

/**
 * Engine messages -> wire messages.
 *
 * TWO transformations, both dialect facts rather than conveniences:
 *   - `role: "tool"` becomes a `user` message. The engine keeps tool results on their own role for
 *     unambiguous accumulation (engine.ts says so); the wire has no tool role at all.
 *   - ADJACENT same-role messages are MERGED. After the first transformation a turn reads
 *     user / assistant / user / assistant, but a history with two consecutive tool messages (or a
 *     host that supplied two user turns) would otherwise produce consecutive same-role messages,
 *     which this endpoint rejects. Merging preserves block ORDER exactly, which is what the replay
 *     rule cares about.
 */
export function toWireMessages(messages: ProviderMessageLike[]): Array<{ role: "user" | "assistant"; content: Record<string, unknown>[] }> {
  const out: Array<{ role: "user" | "assistant"; content: Record<string, unknown>[] }> = [];
  for (const message of messages) {
    const role: "user" | "assistant" = message.role === "assistant" ? "assistant" : "user";
    const blocks = normalizeContent(message.content);
    if (blocks.length === 0) continue;
    const last = out[out.length - 1];
    if (last !== undefined && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  }
  return out;
}

// --- capability resolution ------------------------------------------------------------------------

/** Looks a descriptor up by provider + the id/alias/key the request named. `undefined` for an `allowUnlisted` passthrough, which is a FACT the checks below fail closed on. */
export function findDescriptor(catalog: WinterCatalog, providerId: string, model: string): WinterModelDescriptor | undefined {
  return catalog.models.find((m) => m.providerId === providerId && (m.upstreamId === model || m.key === model || m.aliases.includes(model)));
}

export type EffortMapping = { ok: true; value: { type: "enabled"; budget_tokens: number } } | { ok: false; reason: string };

/**
 * Effort -> the model's VERIFIED vocabulary, or a refusal (WS-13 §8.2).
 *
 * A NUMBER is mapped to the nearest declared tier by treating it as a 0-100 intensity across the
 * model's own `reasoning.efforts` list. The pin admits a numeric effort on exactly one surface
 * (`AgentDefinition.effort`, `sdk.d.ts:87`) and states no unit, range or mapping for it -- so this
 * is gap-filling, disclosed, and it can only ever select a tier the model already declares.
 */
export function mapAnthropicEffort(effort: TurnRequest["effort"], descriptor: WinterModelDescriptor | undefined): EffortMapping {
  if (effort === undefined) return { ok: false, reason: "no effort was requested" };
  if (descriptor === undefined) {
    return { ok: false, reason: "this model is not in the catalog, so its effort vocabulary is unknown; Winter refuses an unverified effort rather than guessing one" };
  }
  const efforts = descriptor.reasoning?.efforts ?? [];
  if (efforts.length === 0) {
    return { ok: false, reason: `model "${descriptor.key}" declares no effort vocabulary, so no effort level can be verified for it` };
  }
  let tier: string;
  if (typeof effort === "number") {
    if (!Number.isFinite(effort)) return { ok: false, reason: `numeric effort ${String(effort)} is not a finite number` };
    const clamped = Math.min(100, Math.max(0, effort));
    const index = Math.round((clamped / 100) * (efforts.length - 1));
    tier = efforts[index]!;
  } else {
    if (!efforts.includes(effort)) {
      return { ok: false, reason: `effort "${effort}" is not in model "${descriptor.key}"'s verified vocabulary (${efforts.join(", ")}); Winter never silently downgrades to a provider default` };
    }
    tier = effort;
  }
  const budget = EFFORT_BUDGET_TOKENS[tier];
  if (budget === undefined) {
    return { ok: false, reason: `model "${descriptor.key}" declares effort tier "${tier}", which this adapter has no verified thinking budget for` };
  }
  return { ok: true, value: { type: "enabled", budget_tokens: budget } };
}

type WireThinking = { type: "disabled" } | { type: "enabled"; budget_tokens?: number; display?: string } | { type: "adaptive"; display?: string };

/**
 * The `thinking` envelope, from `TurnRequest.thinking` and `TurnRequest.effort`.
 *
 * FORWARDED VERBATIM by arm. Capture (F) observed the pinned runtime re-resolving `enabled` to
 * `adaptive` for `claude-sonnet-5`, and R6-E permits an adapter to do the same "for models whose
 * evidence says adaptive-only" -- but the catalog carries no such evidence field, so re-resolving
 * here would be an invented capability claim. Recorded as a disclosed difference from the pinned
 * runtime's own behaviour rather than imitated without evidence.
 *
 * `display` comes from the DESCRIPTOR'S OWN `summaryRequest` evidence (`field: "thinking.display"`),
 * never from a hard-coded string, and only when the caller asked for a summary.
 */
function buildThinking(req: TurnRequest, descriptor: WinterModelDescriptor | undefined): { ok: true; value: WireThinking | undefined } | { ok: false; reason: string } {
  const reasoning = descriptor?.reasoning;
  const supported = reasoning?.supported.value === true;

  let base: WireThinking | undefined;
  if (req.thinking !== undefined) {
    if (req.thinking.type !== "disabled" && !supported) {
      return {
        ok: false,
        reason:
          descriptor === undefined
            ? `thinking was requested for "${req.model}", which is not in the catalog; Winter refuses an unverified reasoning request rather than sending it and hoping`
            : `model "${descriptor.key}" does not declare reasoning support, so a thinking config cannot be honoured`,
      };
    }
    const requestedBudget = req.thinking.type === "enabled" ? req.thinking.budgetTokens : undefined;
    if (req.thinking.type === "enabled" && requestedBudget === undefined) {
      // The pin types `budgetTokens` OPTIONAL while its own JSDoc renders the arm as requiring one --
      // "a well-typed value with undefined semantics in the pin" (derived-shapes item (c)). This
      // endpoint requires `budget_tokens` on an enabled thinking config, so forwarding the arm
      // budget-less is a request we KNOW will fail upstream. That is exactly what the
      // reject-before-the-request rule exists for, and the `budget >= max_tokens` check below cannot
      // catch it (an absent budget skips it).
      return { ok: false, reason: 'thinking `{ type: "enabled" }` carries no budgetTokens, which this endpoint requires. Pass `budgetTokens`, or ask for `{ type: "adaptive" }` if the model should decide.' };
    }
    base = requestedBudget !== undefined ? { type: "enabled", budget_tokens: requestedBudget } : { type: req.thinking.type };
  }

  if (req.effort !== undefined) {
    const mapped = mapAnthropicEffort(req.effort, descriptor);
    if (!mapped.ok) return { ok: false, reason: mapped.reason };
    if (!supported) return { ok: false, reason: `model "${descriptor?.key ?? req.model}" does not declare reasoning support, so an effort level cannot be mapped onto its thinking budget` };
    // An explicit `thinking` wins: the pin says the same about `thinking` vs `maxThinkingTokens`
    // ("`thinking`, when set, takes precedence"), and effort is the coarser dial of the two.
    base = base ?? mapped.value;
  }

  if (base === undefined) return { ok: true, value: undefined };

  if (req.requestSummary === true && base.type !== "disabled") {
    const summaryRequest = reasoning?.summaryRequest?.value;
    if (summaryRequest !== undefined && summaryRequest.field === "thinking.display" && summaryRequest.values.includes("summarized")) {
      base = { ...base, display: "summarized" };
    }
  }
  return { ok: true, value: base };
}

/** The pre-request capability gate. Returns the request body, or a typed refusal that never reaches the network. */
/**
 * `purpose` exists for ONE reason (Minor 4): a token COUNT has no output allowance, so running the
 * "does the thinking budget fit inside `max_tokens`?" check for it refuses a count against a
 * generation limit the count was never going to be subject to. The count path used to build the full
 * body and then delete `max_tokens`/`stream` — which meant the check ran on a field that was about to
 * be thrown away.
 */
function buildRequestBody(req: TurnRequest, descriptor: WinterModelDescriptor | undefined, opts: AnthropicAdapterOptions, purpose: "generate" | "count" = "generate"): Record<string, unknown> {
  // Tools: WS-13 §8.1's three states. `emulated` is disabled for agent modes and `none` fails
  // negotiation -- neither is a reason to drop the tools and continue as plain chat.
  if (req.tools !== undefined && req.tools.length > 0 && descriptor !== undefined) {
    const toolCalling = descriptor.toolCalling.value;
    if (toolCalling !== "native") {
      throw capabilityRefusal(
        `model "${descriptor.key}" declares tool calling "${toolCalling}", so the ${req.tools.length} advertised tool(s) cannot be sent natively; Winter fails capability negotiation rather than silently dropping them (WS-13 §8.1)`,
      );
    }
  }

  // Vision: an image block reaches the wire only where the descriptor advertises it.
  if (descriptor !== undefined && !descriptor.inputModalities.value.includes("image")) {
    // RECURSIVE, and that is the whole point: P3-M's multimodal `Read` delivers its page images
    // SOLELY as image blocks inside a model-facing `tool_result` (derived-shapes item (f)), so a
    // top-level-only scan saw none of them and let exactly the interesting case reach a non-vision
    // model -- an upstream 400 in place of the typed refusal this gate exists to produce.
    for (const message of req.messages) {
      if (containsImage(message.content)) {
        throw capabilityRefusal(`model "${descriptor.key}" does not advertise image input, so an image block is refused before the request rather than sent and rejected upstream`);
      }
    }
  }

  // Parameters the row says this model rejects.
  for (const parameter of descriptor?.unsupportedParameters ?? []) {
    if (parameter === "thinking" && (req.thinking !== undefined || req.effort !== undefined)) {
      throw capabilityRefusal(`model "${descriptor?.key ?? req.model}" lists "thinking" in its unsupportedParameters`);
    }
    if (parameter === "tools" && req.tools !== undefined && req.tools.length > 0) {
      throw capabilityRefusal(`model "${descriptor?.key ?? req.model}" lists "tools" in its unsupportedParameters`);
    }
  }

  const thinking = buildThinking(req, descriptor);
  if (!thinking.ok) throw capabilityRefusal(thinking.reason);

  // `max_tokens` has TWO AUTHORITATIVE sources -- what the caller asked for and what the model's row
  // declares -- and a third, this adapter's own fallback, which is authoritative over nothing.
  //
  // The distinction is what the corpus found on its first run: a `high` effort maps to a 16k thinking
  // budget, which cannot fit inside a 4k fallback, so an effort request that named no output budget
  // was rejected as "over the limit" by a number the CALLER never chose. A declared or requested
  // ceiling is a real limit and a budget that overruns it is a real refusal; the fallback is not a
  // limit at all, so it GROWS to hold the reasoning plus a full answer's worth of output.
  const declaredMax = req.maxOutputTokens ?? descriptor?.maxOutputTokens?.value;
  const fallbackMax = opts.defaultMaxOutputTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS;
  const budget = thinking.value !== undefined && thinking.value.type === "enabled" ? thinking.value.budget_tokens : undefined;
  if (req.maxOutputTokens !== undefined && descriptor?.maxOutputTokens?.value !== undefined && req.maxOutputTokens > descriptor.maxOutputTokens.value) {
    throw capabilityRefusal(`requested max output ${req.maxOutputTokens} exceeds model "${descriptor.key}"'s declared maximum of ${descriptor.maxOutputTokens.value}`);
  }
  const maxTokens = declaredMax ?? (budget !== undefined ? budget + fallbackMax : fallbackMax);
  if (purpose === "count") {
    // A count carries the PROMPT and nothing else: no `stream`, no `max_tokens`, and therefore no
    // ceiling for a thinking budget to overrun.
    return {
      model: req.model,
      messages: toWireMessages(req.messages),
      ...(req.system !== undefined ? { system: req.system } : {}),
      ...(req.tools !== undefined && req.tools.length > 0 ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } : {}),
      ...(thinking.value !== undefined ? { thinking: thinking.value } : {}),
    };
  }
  if (budget !== undefined && budget >= maxTokens) {
    // A real endpoint constraint, and the honest place to enforce it: a thinking budget that does
    // not fit inside the output allowance is rejected upstream, so catching it here turns a remote
    // 400 into a typed local refusal with the two numbers in it.
    throw capabilityRefusal(`thinking budget ${budget} does not fit inside max_tokens ${maxTokens}; the budget must be strictly smaller`);
  }

  return {
    model: req.model,
    max_tokens: maxTokens,
    messages: toWireMessages(req.messages),
    stream: true,
    ...(req.system !== undefined ? { system: req.system } : {}),
    ...(req.tools !== undefined && req.tools.length > 0
      ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) }
      : {}),
    ...(req.toolChoice !== undefined ? { tool_choice: req.toolChoice.type === "tool" ? { type: "tool", name: req.toolChoice.name } : { type: req.toolChoice.type } } : {}),
    ...(thinking.value !== undefined ? { thinking: thinking.value } : {}),
  };
}

// --- endpoint + headers ---------------------------------------------------------------------------

interface Endpoint {
  base: string;
  policy: EndpointPolicy;
}

/**
 * The connection's endpoint policy.
 *
 * A user `baseUrl` is evaluated as a USER endpoint (`generated: false`), which is what makes
 * `applyPrivilegedHeaders` drop this family's privileged header for it (R6-L). The compiled default
 * is `generated: true` -- it is the reviewed, immutable descriptor endpoint.
 */
function resolveEndpoint(ctx: ProviderContext, defaultBaseUrl: string): Endpoint {
  const userBase = ctx.connection.baseUrl;
  const base = (userBase ?? defaultBaseUrl).replace(/\/+$/, "");
  const built = createEndpointPolicy(base, userBase !== undefined ? { generated: false, ...(ctx.connection.local === true ? { local: true } : {}) } : { generated: true });
  if (!built.ok) throw capabilityRefusal(built.reason);
  return { base, policy: built.policy };
}

/**
 * The request headers.
 *
 * PROTOCOL vs PRIVILEGED, per R6-L and `endpoint-policy.ts`'s own split: `x-api-key`,
 * `anthropic-version`, `anthropic-beta`, `content-type` and `accept` are all PROTOCOL headers --
 * every endpoint speaking this dialect needs them and none names the operator's account. This family
 * has no privileged header of its own, so `applyPrivilegedHeaders` is called with an empty set: the
 * call site exists so the rule is enforced by code rather than by this comment, and so a later
 * account-scoped header lands in the right place.
 */
async function buildHeaders(ctx: ProviderContext, policy: EndpointPolicy, opts: AnthropicAdapterOptions, json: boolean): Promise<Record<string, string>> {
  const material = await ctx.credentials.get(ctx.authRef);
  // HOST HEADERS FIRST, so nothing below can be silently overridden: spread LAST, a host header could
  // replace `anthropic-version` or `content-type`, and a wrong API version is a class of failure that
  // surfaces as an unexplained upstream 400 rather than as anything local.
  //
  // AND FILTERED (R6-L): `applyPrivilegedHeaders` gates the set the ADAPTER builds but cannot remove
  // a name from a map it never saw, so an identity header a host wrote into its own
  // `connection.headers` would otherwise ride a user endpoint past the rule. This family defines no
  // organisation header of its own today, so it adds nothing to the shared list -- the call site
  // exists so that when it does, the enforcement is already here.
  const headers: Record<string, string> = {
    ...hostHeaders(policy, ctx.connection.headers),
    "anthropic-version": ANTHROPIC_API_VERSION,
    ...(json ? { "content-type": "application/json" } : {}),
    ...(opts.betas !== undefined && opts.betas.length > 0 ? { "anthropic-beta": opts.betas.join(",") } : {}),
    // This family has no privileged header of its own; the call site exists so the R6-L rule is
    // enforced by code rather than by a comment, and so a later account-scoped header lands here.
    ...applyPrivilegedHeaders(policy, {}),
  };
  if (material !== null) {
    if (material.kind === "api-key") headers["x-api-key"] = material.key;
    else if (material.kind === "bearer") headers["authorization"] = `Bearer ${material.token}`;
    else if (material.kind === "oauth") headers["authorization"] = `Bearer ${material.accessToken}`;
    else throw capabilityRefusal(`the Anthropic Messages adapter cannot authenticate with credential material of kind "${material.kind}"`);
  }
  return headers;
}

// --- the normalized stream ------------------------------------------------------------------------

interface OpenBlock {
  type: string;
  thinking: string;
  signature: string | undefined;
  data: string | undefined;
  toolId: string | undefined;
}

/** Anthropic's stop reasons -> the seam's five. `stop_sequence` and anything unknown are an ordinary end of turn. */
function toStopReason(raw: unknown): "end_turn" | "tool_use" | "max_tokens" | "refusal" {
  switch (raw) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "end_turn";
  }
}

/**
 * At which event this family's COMPLETE in-dialect block is captured, from the descriptor's own
 * `completionEvent` evidence (Minor 7).
 *
 * Matched LENIENTLY by mention, for the same reason as the Google resolver: the field is a prose-ish
 * `CapabilityEvidence<string>`. An unrecognised value falls back to `block-stop`, this family's real
 * per-block terminator -- the conservative answer, since it is the earliest point at which a block is
 * genuinely complete and holding longer can only ever delay a capture, never take a partial one.
 */
export function anthropicCaptureEvent(descriptor: WinterModelDescriptor | undefined): "block-stop" | "message-stop" {
  const declared = descriptor?.reasoning?.completionEvent?.value;
  if (typeof declared === "string" && /message_stop|message-stop/i.test(declared)) return "message-stop";
  return "block-stop";
}

function malformed(detail: string): ProviderError {
  return { code: "bad_request", message: `the provider stream carried a frame this adapter could not decode: ${detail}`, retryable: false };
}

export function createAnthropicMessagesAdapter(opts: AnthropicAdapterOptions = {}): ProviderAdapter {
  // LAZY: `loadCatalog()` validates every row, and an adapter constructed in a fixture that supplies
  // its own catalog must never pay for (or depend on) the compiled one.
  let compiled: WinterCatalog | undefined;
  const catalogOf = (): WinterCatalog => opts.catalog ?? (compiled ??= loadCatalog());
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  /**
   * Everything that must be decided BEFORE the network: the descriptor, the endpoint policy, the
   * capability gate, the body and the headers.
   *
   * Separated so a refusal is a THROW here and a yielded `error` event there. The distinction
   * matters to a consumer: a thrown value loses the normalized `code`, and `capability` is exactly
   * the code that says "no request was made and none would have helped".
   */
  async function prepare(req: TurnRequest, ctx: ProviderContext): Promise<{ endpoint: Endpoint; body: Record<string, unknown>; headers: Record<string, string>; captureEvent: "block-stop" | "message-stop" }> {
    // CHECKED HERE, not left to `boundedFetch`: preparing a request can itself reach the network
    // (the Vertex transport exchanges a signed assertion for an access token), and an already-aborted
    // caller must not cause a credential exchange for a turn that will never be sent.
    if (req.signal?.aborted === true) throw new ProviderRequestError({ code: "aborted", message: "provider request aborted by the caller", retryable: false });
    const descriptor = findDescriptor(catalogOf(), ctx.connection.providerId, req.model);
    const endpoint = resolveEndpoint(ctx, ANTHROPIC_DEFAULT_BASE_URL);
    const body = buildRequestBody(req, descriptor, opts);
    const headers = await buildHeaders(ctx, endpoint.policy, opts, true);
    return { endpoint, body, headers, captureEvent: anthropicCaptureEvent(descriptor) };
  }

  async function* streamTurn(req: TurnRequest, ctx: ProviderContext): AsyncGenerator<ProviderEvent> {
    // BEFORE the network, always: a capability refusal here means `fake.requests` is empty, which is
    // the only observable difference between "rejected before the request" and "rejected after it".
    let endpoint: Endpoint;
    let body: Record<string, unknown>;
    let headers: Record<string, string>;
    let captureEvent: "block-stop" | "message-stop";
    try {
      ({ endpoint, body, headers, captureEvent } = await prepare(req, ctx));
    } catch (err) {
      yield { type: "error", error: normalizeThrown(err) };
      return;
    }

    const policy = createRetryPolicy(opts.retry ?? {});
    const retryEvents: Array<Extract<ProviderEvent, { type: "retry" }>> = [];
    let response: Response;
    try {
      response = await withRetry(
        async () => {
          const res = await boundedFetch(`${endpoint.base}/v1/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            timeoutMs,
            maxBodyBytes,
            policy: endpoint.policy,
            ...(req.signal !== undefined ? { signal: req.signal } : {}),
          });
          if (!res.ok) throw new ProviderRequestError(normalizeHttpError(res.status, res.headers, await res.text()));
          // THE FIRST-BYTE LINE. Past this point `withRetry` refuses to replay, whatever fails.
          policy.commit();
          return res;
        },
        policy,
        (event) => retryEvents.push(event),
        req.signal,
      );
    } catch (err) {
      for (const event of retryEvents) yield event;
      yield { type: "error", error: normalizeThrown(err) };
      return;
    }
    for (const event of retryEvents) yield event;

    if (response.body === null) {
      yield { type: "error", error: malformed("a 200 response with no body at all") };
      return;
    }

    let bytes = 0;
    const blocks = new Map<number, OpenBlock>();
    /** Completed in-dialect blocks, in wire order, when the descriptor defers the capture to `message_stop`. */
    const heldThinking: unknown[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens: number | undefined;
    let cacheWriteTokens: number | undefined;
    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" = "end_turn";
    let sawMessageStop = false;

    try {
      for await (const sse of parseSse(response.body, {
        stallTimeoutMs: ctx.stallTimeoutMs,
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
        onBytes: (n) => {
          bytes += n;
        },
      })) {
        // `ping` NEVER reaches the consumer -- capture (F) observed the pinned runtime filtering it,
        // and the SSE layer's own stall clock already reset on its bytes.
        if (sse.event === "ping") continue;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(sse.data) as Record<string, unknown>;
        } catch {
          yield { type: "error", error: malformed(`an unparseable ${sse.event ?? "unnamed"} frame`) };
          return;
        }
        const type = typeof payload["type"] === "string" ? (payload["type"] as string) : sse.event;

        switch (type) {
          case "message_start": {
            const message = payload["message"] as { id?: unknown; model?: unknown; usage?: Record<string, unknown> } | undefined;
            const usage = message?.usage;
            if (typeof usage?.["input_tokens"] === "number") inputTokens = usage["input_tokens"];
            if (typeof usage?.["output_tokens"] === "number") outputTokens = usage["output_tokens"];
            // PROMPT-CACHING COUNTERS. Anthropic reports them as two separate fields on the same
            // usage object, and they are what makes cost accounting honest for a cached prompt.
            if (typeof usage?.["cache_read_input_tokens"] === "number") cacheReadTokens = usage["cache_read_input_tokens"];
            if (typeof usage?.["cache_creation_input_tokens"] === "number") cacheWriteTokens = usage["cache_creation_input_tokens"];
            yield {
              type: "message_start",
              ...(typeof message?.id === "string" ? { id: message.id } : {}),
              ...(typeof message?.model === "string" ? { model: message.model } : {}),
            };
            break;
          }
          case "content_block_start": {
            const index = typeof payload["index"] === "number" ? payload["index"] : -1;
            const block = (payload["content_block"] ?? {}) as Record<string, unknown>;
            const blockType = typeof block["type"] === "string" ? block["type"] : "text";
            const open: OpenBlock = {
              type: blockType,
              thinking: typeof block["thinking"] === "string" ? block["thinking"] : "",
              signature: typeof block["signature"] === "string" ? block["signature"] : undefined,
              data: typeof block["data"] === "string" ? block["data"] : undefined,
              toolId: typeof block["id"] === "string" ? block["id"] : undefined,
            };
            blocks.set(index, open);
            if (blockType === "tool_use" && open.toolId !== undefined) {
              yield { type: "tool_call_start", id: open.toolId, name: typeof block["name"] === "string" ? block["name"] : "" };
            }
            break;
          }
          case "content_block_delta": {
            const index = typeof payload["index"] === "number" ? payload["index"] : -1;
            const open = blocks.get(index);
            const delta = (payload["delta"] ?? {}) as Record<string, unknown>;
            const deltaType = delta["type"];
            if (deltaType === "text_delta" && typeof delta["text"] === "string") {
              yield { type: "text_delta", text: delta["text"] };
            } else if (deltaType === "thinking_delta" && typeof delta["thinking"] === "string" && open !== undefined) {
              // ACCUMULATED, not emitted. Anthropic thinking is IN-DIALECT: it becomes one complete
              // `native_thinking_block` at `content_block_stop`, never a `thinking_summary_delta`
              // (that event is for FOREIGN reasoning, R6-8).
              open.thinking += delta["thinking"];
            } else if (deltaType === "signature_delta" && typeof delta["signature"] === "string" && open !== undefined) {
              open.signature = (open.signature ?? "") + delta["signature"];
            } else if (deltaType === "input_json_delta" && typeof delta["partial_json"] === "string" && open?.toolId !== undefined) {
              yield { type: "tool_call_delta", id: open.toolId, argumentsJsonDelta: delta["partial_json"] };
            }
            break;
          }
          case "content_block_stop": {
            const index = typeof payload["index"] === "number" ? payload["index"] : -1;
            const open = blocks.get(index);
            blocks.delete(index);
            if (open === undefined) break;
            if (open.type === "thinking") {
              // THE COMPLETION EVENT, and only it. The `signature` key is emitted only when the wire
              // carried one: capture (F) shows the pinned runtime materialising `""` for a
              // signatureless block, and the bridge's own coercion reproduces exactly that -- so
              // omitting it here keeps ONE normalizer for the rule instead of two that can drift.
              //
              // WHICH event that is comes from the descriptor (Minor 7): `block-stop` is this
              // family's real per-block terminator and the default, but a row whose evidence names
              // `message_stop` holds the completed block until then.
              const block = { type: "thinking", thinking: open.thinking, ...(open.signature !== undefined ? { signature: open.signature } : {}) };
              if (captureEvent === "message-stop") heldThinking.push(block);
              else yield { type: "native_thinking_block", block };
            } else if (open.type === "redacted_thinking") {
              if (open.data === undefined) {
                // The block IS the opaque continuation state. Dropping it silently breaks the
                // signature chain on the next replay, and the failure would surface as an upstream
                // rejection of a request this adapter had already decided was fine -- so it is the
                // same typed, unrepresentable refusal every other undecodable frame in this file gets.
                yield { type: "error", error: malformed("a redacted_thinking block completed with no `data`, so its opaque continuation state cannot be carried") };
                return;
              }
              const block = { type: "redacted_thinking", data: open.data };
              if (captureEvent === "message-stop") heldThinking.push(block);
              else yield { type: "native_thinking_block", block };
            } else if (open.type === "tool_use" && open.toolId !== undefined) {
              yield { type: "tool_call_end", id: open.toolId };
            }
            break;
          }
          case "message_delta": {
            const delta = (payload["delta"] ?? {}) as Record<string, unknown>;
            stopReason = toStopReason(delta["stop_reason"]);
            const usage = payload["usage"] as Record<string, unknown> | undefined;
            if (typeof usage?.["output_tokens"] === "number") outputTokens = usage["output_tokens"];
            if (typeof usage?.["input_tokens"] === "number") inputTokens = usage["input_tokens"];
            break;
          }
          case "message_stop":
            sawMessageStop = true;
            // Held blocks are released HERE, in wire order, for a row whose evidence names this as its
            // completion event. A stream that never reaches `message_stop` releases none of them --
            // the completion-event rule, stated the same way at whichever event the row names.
            for (const block of heldThinking) yield { type: "native_thinking_block", block };
            heldThinking.length = 0;
            break;
          case "error": {
            const error = (payload["error"] ?? {}) as Record<string, unknown>;
            const providerCode = typeof error["type"] === "string" ? error["type"] : undefined;
            yield {
              type: "error",
              error: {
                // A mid-stream `error` frame is a SERVER-side failure of an already-started
                // generation. It is never retryable here whatever it says: bytes have been consumed
                // and R6-6 forbids replaying an effectful turn.
                code: "server",
                message: `the provider ended the stream with an error frame${providerCode !== undefined ? ` (${providerCode})` : ""}`,
                retryable: false,
                ...(providerCode !== undefined ? { providerCode } : {}),
              },
            };
            return;
          }
          default:
            break;
        }
      }
    } catch (err) {
      yield { type: "error", error: normalizeThrown(err) };
      return;
    } finally {
      // BYTE COUNTS ONLY -- never content, never a header, never opaque state (Global Constraints).
      ctx.log({ kind: "provider.stream", providerId: ctx.connection.providerId, model: req.model, bytes });
    }

    if (!sawMessageStop) {
      // The stream ended without its terminator: a dropped upstream connection. Reporting the
      // partial accumulation as a completed turn is exactly the "half-decoded turn" the corpus
      // forbids.
      yield { type: "error", error: { code: "network", message: "the provider stream ended before message_stop; the turn is incomplete and is not reported as finished", retryable: false } };
      return;
    }

    yield {
      type: "usage",
      inputTokens,
      outputTokens,
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    };
    yield { type: "done", stopReason };
  }

  return {
    id: ANTHROPIC_ADAPTER_ID,
    version: "1",
    family: "anthropic",
    protocol: "anthropic-messages",

    streamTurn,

    /**
     * R6-15: a REAL count from the family's own endpoint, never an estimate. `compact_metadata.post_tokens`
     * is set from this or omitted entirely.
     */
    async countTokens(req: TurnRequest, ctx: ProviderContext): Promise<number> {
      const descriptor = findDescriptor(catalogOf(), ctx.connection.providerId, req.model);
      const endpoint = resolveEndpoint(ctx, ANTHROPIC_DEFAULT_BASE_URL);
      const body = buildRequestBody(req, descriptor, opts, "count");
      const headers = await buildHeaders(ctx, endpoint.policy, opts, true);
      const res = await boundedFetch(`${endpoint.base}/v1/messages/count_tokens`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        timeoutMs,
        maxBodyBytes,
        policy: endpoint.policy,
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      });
      const text = await res.text();
      if (!res.ok) throw new ProviderRequestError(normalizeHttpError(res.status, res.headers, text));
      let parsed: { input_tokens?: unknown };
      try {
        parsed = JSON.parse(text) as { input_tokens?: unknown };
      } catch {
        throw new ProviderRequestError(malformed("the count_tokens response was not JSON"));
      }
      if (typeof parsed.input_tokens !== "number") throw new ProviderRequestError(malformed("the count_tokens response carried no numeric input_tokens"));
      return parsed.input_tokens;
    },

    async validateCredential(ref: CredentialRef, ctx: ProviderContext): Promise<CredentialStatus> {
      if (ref.kind === "none") return { ok: false, code: "missing", message: "no credential is configured for this connection" };
      let material;
      try {
        material = await ctx.credentials.get(ref);
      } catch (err) {
        // The store's own typed refusal ("this store cannot resolve that ref KIND") is `unsupported`,
        // which is a FACT about the wiring rather than a verdict about the credential.
        return { ok: false, code: "unsupported", message: err instanceof Error ? err.message : String(err) };
      }
      if (material === null) return { ok: false, code: "missing", message: "the credential reference resolved to nothing" };
      if (material.kind !== "api-key" && material.kind !== "bearer" && material.kind !== "oauth") {
        return { ok: false, code: "unsupported", message: `the Anthropic Messages adapter cannot validate credential material of kind "${material.kind}"` };
      }
      const endpoint = resolveEndpoint(ctx, ANTHROPIC_DEFAULT_BASE_URL);
      const headers = await buildHeaders({ ...ctx, authRef: ref }, endpoint.policy, opts, false);
      try {
        const res = await boundedFetch(`${endpoint.base}/v1/models?limit=1`, { method: "GET", headers, timeoutMs, maxBodyBytes: 1024 * 1024, policy: endpoint.policy });
        const text = await res.text();
        if (res.ok) return { ok: true };
        const normalized = normalizeHttpError(res.status, res.headers, text);
        if (normalized.code === "auth") return { ok: false, code: "invalid", message: normalized.message };
        return { ok: false, code: "network", message: normalized.message };
      } catch (err) {
        return { ok: false, code: "network", message: normalizeThrown(err).message };
      }
    },

    /**
     * Live discovery over `/v1/models`, paginated by `last_id`/`after_id`.
     *
     * BOUNDED THREE WAYS, as WS-13 §7 requires: bytes by `boundedFetch` (`limits.maxBytes`), items by
     * `limits.maxItems`, and pages by a hard ceiling so a provider that always answers `has_more`
     * cannot make this loop forever. `partial` is set whenever the provider said there was more --
     * absence must never be read as removal.
     */
    async listModels(ctx: DiscoveryContext): Promise<ModelCatalogResult> {
      const endpoint = resolveEndpoint(ctx, ANTHROPIC_DEFAULT_BASE_URL);
      const headers = await buildHeaders(ctx, endpoint.policy, opts, false);
      const models: ModelCatalogResult["models"] = [];
      const warnings: string[] = [];
      let after: string | undefined;
      let partial = false;

      for (let page = 0; page < MAX_DISCOVERY_PAGES; page++) {
        const search = new URLSearchParams({ limit: String(Math.min(1000, Math.max(1, ctx.limits.maxItems))) });
        if (after !== undefined) search.set("after_id", after);
        const res = await boundedFetch(`${endpoint.base}/v1/models?${search.toString()}`, {
          method: "GET",
          headers,
          timeoutMs: Math.min(timeoutMs, ctx.limits.timeoutMs),
          maxBodyBytes: ctx.limits.maxBytes,
          policy: endpoint.policy,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        });
        const text = await res.text();
        if (!res.ok) throw new ProviderRequestError(normalizeHttpError(res.status, res.headers, text));
        let parsed: { data?: unknown; has_more?: unknown; last_id?: unknown };
        try {
          parsed = JSON.parse(text) as { data?: unknown; has_more?: unknown; last_id?: unknown };
        } catch {
          throw new ProviderRequestError(malformed("the /v1/models response was not JSON"));
        }
        const rows = Array.isArray(parsed.data) ? parsed.data : [];
        for (const row of rows) {
          if (row === null || typeof row !== "object") continue;
          const item = row as { id?: unknown; display_name?: unknown };
          // Ids and display names are UNTRUSTED input; `discoverModels` re-validates and bounds every
          // field, so this layer only shapes them.
          models.push({
            ...(typeof item.id === "string" ? { id: item.id } : { id: "" }),
            ...(typeof item.display_name === "string" ? { displayName: item.display_name } : {}),
          });
        }
        if (models.length >= ctx.limits.maxItems) {
          partial = partial || parsed.has_more === true || models.length > ctx.limits.maxItems;
          break;
        }
        if (parsed.has_more !== true) break;
        after = typeof parsed.last_id === "string" ? parsed.last_id : undefined;
        if (after === undefined) {
          warnings.push("the provider reported more models but returned no pagination cursor; the catalog is PARTIAL");
          partial = true;
          break;
        }
        if (page === MAX_DISCOVERY_PAGES - 1) {
          warnings.push(`discovery stopped after ${MAX_DISCOVERY_PAGES} pages; the catalog is PARTIAL`);
          partial = true;
        }
      }

      return { models, partial, cached: false, warnings };
    },

    mapEffort(effort: TurnRequest["effort"], model: WinterModelDescriptor) {
      const mapped = mapAnthropicEffort(effort, model);
      return mapped.ok ? { ok: true, value: mapped.value } : { ok: false, reason: mapped.reason };
    },

    capabilities(model: WinterModelDescriptor) {
      const domainMembers = model.reasoning?.continuationDomain?.value;
      const domain = domainMembers !== undefined && domainMembers.length > 0 ? [...domainMembers].sort()[0] : undefined;
      return {
        toolCalling: model.toolCalling.value,
        ...(domain !== undefined ? { continuationDomain: domain } : {}),
        // `summary` for this family means "ask for a summarized DISPLAY of in-dialect thinking" --
        // the blocks still ride in-dialect with their real signatures. It never re-routes reasoning
        // onto the foreign-summary channel.
        readableState: model.reasoning?.readableState?.value ?? "none",
      };
    },
  };
}
