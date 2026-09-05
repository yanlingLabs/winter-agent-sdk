// Phase 6 Task 6 (Lane B): the Google GenerateContent adapter -- `google-generate-content@1`.
//
// ADDED under `adapters/google/` (R6-12). `boundedFetch`, `parseSse`, `withRetry`,
// `normalizeHttpError`, `createEndpointPolicy` and `applyPrivilegedHeaders` are Task 2's frozen core
// and this adapter's only doors to the network, retries and error normalization.
//
// ONE WIRE MAPPING, TWO TRANSPORTS. Vertex Gemini (`vertex.ts`, R6-16/R6-A) speaks the SAME dialect
// at a different URL with a different credential, so everything below is parameterised by a
// `GoogleTransport` and Vertex supplies its own rather than duplicating a single line of the
// mapping. That is the review rubric's "no duplicated wire mappings" made structural.
//
// FIVE DECISIONS THAT LOOK OPTIONAL AND ARE NOT:
//
//   1. **`thoughtSignature` is captured only from the COMPLETING chunk.** This family's stream has
//      no per-block terminator: the only thing that says a turn finished is a chunk carrying
//      `finishReason`. Signatures are accumulated as parts arrive and emitted as ONE `native_state`
//      event after that chunk -- so a stream that dies mid-turn produces no native state at all,
//      rather than a continuation object the provider never finished minting.
//
//   2. **A signature is keyed by the tool call it arrived on, not only by its wire index.** The
//      fold FLATTENS a turn (every text delta into one string, the calls after it), so a wire part
//      index does not survive into the message that will be replayed. Each item therefore records
//      BOTH the wire `partIndex` (the family's own truth) and the `callId` this adapter minted for
//      a `functionCall` part, and replay re-attaches the signature to that exact part.
//
//   3. **A `thought: true` part is FOREIGN reasoning.** It rides `thinking_summary_delta` -> the
//      sidecar and the Winter-only `system/reasoning_summary` frame, never
//      `assistant.message.content` (R6-8). It is never dressed as an in-dialect thinking block,
//      because this family's summaries carry no signature and doing so would fabricate one.
//
//   4. **Reasoning from ANOTHER dialect is dropped at this boundary, and counted.** An Anthropic
//      `thinking`/`redacted_thinking` block has no representation in `parts`. Writing its text as a
//      plain part would put another model's reasoning into this model's context as if it had said
//      it; refusing the turn outright would make a cross-family resume unusable. So it is dropped,
//      and the drop is reported through `ctx.log` as a COUNT (never content). Replacing it with a
//      Winter-authored decoration is Lane C's `HistoryRenderer`, not this adapter's.
//
//   5. **A `functionResponse` needs the function NAME, which a `tool_result` does not carry.** It
//      is looked up from the assistant `tool_use` that minted the id. A lookup that fails is a
//      typed error, never a dropped result -- a silently missing tool response is indistinguishable
//      to the model from a tool that was never called.
import type { WinterCatalog, WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { boundedFetch, ProviderRequestError } from "../../http.ts";
import { normalizeHttpError, normalizeThrown } from "../../errors.ts";
import { createRetryPolicy, withRetry, type RetryPolicyOptions } from "../../retry.ts";
import { applyPrivilegedHeaders, createEndpointPolicy, type EndpointPolicy } from "../../endpoint-policy.ts";
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

export const GOOGLE_ADAPTER_ID = "winter.google-generate-content";
/** The GENERATED endpoint. Immutable (R6-11); pinned to the catalog row by a test. */
export const GOOGLE_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
export const GOOGLE_API_VERSION_PATH = "v1beta";

/**
 * The effort -> `thinkingBudget` ladder.
 *
 * WINTER-AUTHORED AND DISCLOSED, on the same reasoning as the Anthropic ladder: the pin states no
 * unit, range or mapping for effort (OQ-P6-2), and this family's only reasoning dial is a token
 * budget. `mapEffort` refuses any tier the MODEL'S OWN `reasoning.efforts` does not list, so the
 * ladder can never invent a capability -- and the seed catalog's `google` row declares `efforts: []`,
 * which means every effort level is refused for it until Lane X lands real evidence.
 */
const EFFORT_THINKING_BUDGET: Readonly<Record<string, number>> = {
  low: 1_024,
  medium: 4_096,
  high: 8_192,
  xhigh: 16_384,
  max: 24_576,
};

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_DISCOVERY_PAGES = 10;

export interface GoogleAdapterOptions {
  catalog?: WinterCatalog;
  requestTimeoutMs?: number;
  maxBodyBytes?: number;
  retry?: RetryPolicyOptions;
  defaultMaxOutputTokens?: number;
}

/**
 * What differs between the Gemini API and Vertex: the URL, the credential, and whether a bounded
 * list endpoint is in scope. Everything else -- the whole wire mapping and the whole normalizer --
 * is shared.
 */
export interface GoogleTransport {
  readonly id: string;
  readonly version: string;
  /** Resolves the base URL and its endpoint policy, or throws a typed capability refusal. */
  endpoint(ctx: ProviderContext): { base: string; policy: EndpointPolicy };
  headers(ctx: ProviderContext, policy: EndpointPolicy, json: boolean): Promise<Record<string, string>>;
  // EVERY path builder takes the CONTEXT as well as the model, and that is not decoration: Vertex's
  // path carries the connection's project and location, and a transport that captured the connection
  // in a closure instead would race between two concurrent turns on different connections -- sending
  // one session's generation to another session's project.
  streamPath(ctx: ProviderContext, model: string): string;
  countTokensPath(ctx: ProviderContext, model: string): string;
  /** ABSENT when this transport has no bounded model-list endpoint in this phase's scope (Vertex). */
  listPath?: (ctx: ProviderContext, pageToken: string | undefined, pageSize: number) => string;
  /** Credential kinds this transport can authenticate with, for `validateCredential`'s honest `unsupported`. */
  readonly credentialKinds: readonly string[];
}

function capabilityRefusal(reason: string): ProviderRequestError {
  return new ProviderRequestError({ code: "capability", message: reason, retryable: false });
}

function malformed(detail: string): ProviderError {
  return { code: "bad_request", message: `the provider stream carried a frame this adapter could not decode: ${detail}`, retryable: false };
}

// --- native state -----------------------------------------------------------------------------------

/**
 * One opaque continuation item: a `thoughtSignature` and enough addressing to put it back on the
 * EXACT part it came from.
 *
 * The value itself is OPAQUE (Global Constraints): it reaches the provider-state sidecar and the
 * next request body, and nothing else -- never a log line, never an error message, never a frame.
 */
export interface GoogleThoughtSignatureItem {
  /** The wire part index it arrived on. The family's own truth, recorded even though replay keys on `callId` where one exists. */
  partIndex: number;
  /** The tool-call id this adapter minted for the `functionCall` part. Absent for a text part. */
  callId?: string;
  signature: string;
}

function coerceItem(value: unknown): GoogleThoughtSignatureItem | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v["signature"] !== "string" || typeof v["partIndex"] !== "number") return undefined;
  return { partIndex: v["partIndex"], signature: v["signature"], ...(typeof v["callId"] === "string" ? { callId: v["callId"] } : {}) };
}

// --- wire serialization -------------------------------------------------------------------------------

type WirePart = Record<string, unknown>;

/** The name a `functionResponse` must carry, recovered from the assistant `tool_use` that minted the id. */
function toolNamesById(messages: ProviderMessageLike[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type === "tool_use") names.set(block.id, block.name);
    }
  }
  return names;
}

/**
 * A tool result's payload as this family's `response` object.
 *
 * The wire wants an OBJECT. A string result is wrapped under a single key rather than being
 * stringified into JSON-inside-JSON, which is what makes the model see the text it was given.
 */
function toFunctionResponsePayload(content: string | ContentBlockLike[]): Record<string, unknown> {
  if (typeof content === "string") return { output: content };
  const text = content
    .map((block) => (block.type === "text" ? block.text : block.type === "image" ? "" : ""))
    .filter((s) => s.length > 0)
    .join("\n");
  const images = content.filter((b): b is Extract<ContentBlockLike, { type: "image" }> => b.type === "image");
  return { output: text, ...(images.length > 0 ? { imageCount: images.length } : {}) };
}

interface SerializeResult {
  contents: Array<{ role: "user" | "model"; parts: WirePart[] }>;
  /** How many blocks from ANOTHER dialect were dropped at this boundary. Reported as a count, never as content. */
  droppedForeignReasoning: number;
}

/**
 * Engine messages -> `contents`.
 *
 * `assistant` becomes `model`; `tool` becomes `user` carrying `functionResponse` parts (this family
 * has no tool role either). Adjacent same-role entries are merged, which preserves part ORDER
 * exactly and keeps a two-tool-message history from producing the consecutive same-role entries the
 * endpoint rejects.
 */
export function toContents(messages: ProviderMessageLike[]): SerializeResult {
  const names = toolNamesById(messages);
  const contents: SerializeResult["contents"] = [];
  let droppedForeignReasoning = 0;

  for (const message of messages) {
    const role: "user" | "model" = message.role === "assistant" ? "model" : "user";
    const parts: WirePart[] = [];
    const items = (message.nativeState?.items ?? []).map(coerceItem).filter((i): i is GoogleThoughtSignatureItem => i !== undefined);
    const textItems = items.filter((i) => i.callId === undefined);
    let textOrdinal = 0;

    const blocks: ContentBlockLike[] = typeof message.content === "string" ? (message.content.length > 0 ? [{ type: "text", text: message.content }] : []) : message.content;
    for (const block of blocks) {
      switch (block.type) {
        case "text": {
          // The signature goes back on the EXACT part it came from. After the fold there is at most
          // one text part per message, so the first text-keyed item is the one that belongs here.
          const signature = textItems[textOrdinal]?.signature;
          textOrdinal++;
          parts.push({ text: block.text, ...(signature !== undefined ? { thoughtSignature: signature } : {}) });
          break;
        }
        case "image":
          parts.push({ inlineData: { mimeType: block.source.media_type, data: block.source.data } });
          break;
        case "tool_use": {
          const signature = items.find((i) => i.callId === block.id)?.signature;
          parts.push({
            functionCall: { name: block.name, args: typeof block.input === "object" && block.input !== null ? block.input : {} },
            ...(signature !== undefined ? { thoughtSignature: signature } : {}),
          });
          break;
        }
        case "tool_result": {
          const name = names.get(block.tool_use_id);
          if (name === undefined) {
            // A silently missing tool response is indistinguishable to the model from a tool that
            // was never called, which is exactly the class WS-13 §9 forbids.
            throw capabilityRefusal(
              `a tool_result for "${block.tool_use_id}" has no matching tool_use in this history, so the functionResponse has no name to carry; Winter refuses the turn rather than dropping the result`,
            );
          }
          parts.push({ functionResponse: { name, response: toFunctionResponsePayload(block.content) } });
          break;
        }
        case "thinking":
        case "redacted_thinking":
          // Another dialect's reasoning. Dropped at the boundary and COUNTED -- see decision 4 in
          // this file's header.
          droppedForeignReasoning++;
          break;
        case "tool_reference":
          throw capabilityRefusal(
            "a `tool_reference` block reached the Google serializer; it is a Winter streaming-only block with no wire counterpart and is never silently dropped",
          );
      }
    }

    if (parts.length === 0) continue;
    const last = contents[contents.length - 1];
    if (last !== undefined && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  }

  return { contents, droppedForeignReasoning };
}

export function findDescriptor(catalog: WinterCatalog, providerId: string, model: string): WinterModelDescriptor | undefined {
  return catalog.models.find((m) => m.providerId === providerId && (m.upstreamId === model || m.key === model || m.aliases.includes(model)));
}

export type GoogleEffortMapping = { ok: true; value: { thinkingBudget: number } } | { ok: false; reason: string };

/** Effort -> the model's VERIFIED vocabulary, or a refusal (WS-13 §8.2). Identical rule to the Anthropic adapter's; the LADDER differs because the families' budgets do. */
export function mapGoogleEffort(effort: TurnRequest["effort"], descriptor: WinterModelDescriptor | undefined): GoogleEffortMapping {
  if (effort === undefined) return { ok: false, reason: "no effort was requested" };
  if (descriptor === undefined) {
    return { ok: false, reason: "this model is not in the catalog, so its effort vocabulary is unknown; Winter refuses an unverified effort rather than guessing one" };
  }
  const efforts = descriptor.reasoning?.efforts ?? [];
  if (efforts.length === 0) return { ok: false, reason: `model "${descriptor.key}" declares no effort vocabulary, so no effort level can be verified for it` };
  let tier: string;
  if (typeof effort === "number") {
    if (!Number.isFinite(effort)) return { ok: false, reason: `numeric effort ${String(effort)} is not a finite number` };
    const clamped = Math.min(100, Math.max(0, effort));
    tier = efforts[Math.round((clamped / 100) * (efforts.length - 1))]!;
  } else {
    if (!efforts.includes(effort)) {
      return { ok: false, reason: `effort "${effort}" is not in model "${descriptor.key}"'s verified vocabulary (${efforts.join(", ")}); Winter never silently downgrades to a provider default` };
    }
    tier = effort;
  }
  const budget = EFFORT_THINKING_BUDGET[tier];
  if (budget === undefined) return { ok: false, reason: `model "${descriptor.key}" declares effort tier "${tier}", which this adapter has no verified thinking budget for` };
  return { ok: true, value: { thinkingBudget: budget } };
}

type WireThinkingConfig = { thinkingBudget?: number; includeThoughts?: boolean };

/**
 * The `thinkingConfig`, from `TurnRequest.thinking`, `TurnRequest.effort` and `requestSummary`.
 *
 * `adaptive` OMITS the budget rather than sending a sentinel. The arm means "the model decides"; the
 * family expresses that as the absence of a budget, and inventing a magic number to say the same
 * thing would be an undisclosed wire claim.
 */
function buildThinkingConfig(req: TurnRequest, descriptor: WinterModelDescriptor | undefined): { ok: true; value: WireThinkingConfig | undefined } | { ok: false; reason: string } {
  const reasoning = descriptor?.reasoning;
  const supported = reasoning?.supported.value === true;
  let config: WireThinkingConfig | undefined;

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
    if (req.thinking.type === "disabled") config = { thinkingBudget: 0 };
    else if (req.thinking.type === "enabled") config = req.thinking.budgetTokens !== undefined ? { thinkingBudget: req.thinking.budgetTokens } : {};
    else config = {};
  }

  if (req.effort !== undefined) {
    const mapped = mapGoogleEffort(req.effort, descriptor);
    if (!mapped.ok) return { ok: false, reason: mapped.reason };
    if (!supported) return { ok: false, reason: `model "${descriptor?.key ?? req.model}" does not declare reasoning support, so an effort level cannot be mapped onto its thinking budget` };
    config = config ?? mapped.value;
  }

  if (req.requestSummary === true && config !== undefined && config.thinkingBudget !== 0) {
    const summaryRequest = reasoning?.summaryRequest?.value;
    // The FIELD comes from the descriptor's own evidence, never from a hard-coded string: a model
    // whose row does not say how to ask for a summary is not asked.
    if (summaryRequest !== undefined && summaryRequest.field === "thinkingConfig.includeThoughts") config = { ...config, includeThoughts: true };
  }

  if (config !== undefined && Object.keys(config).length === 0) return { ok: true, value: undefined };
  return { ok: true, value: config };
}

function buildRequestBody(req: TurnRequest, descriptor: WinterModelDescriptor | undefined, opts: GoogleAdapterOptions, ctx: ProviderContext): Record<string, unknown> {
  if (req.tools !== undefined && req.tools.length > 0 && descriptor !== undefined && descriptor.toolCalling.value !== "native") {
    throw capabilityRefusal(
      `model "${descriptor.key}" declares tool calling "${descriptor.toolCalling.value}", so the ${req.tools.length} advertised tool(s) cannot be sent natively; Winter fails capability negotiation rather than silently dropping them (WS-13 §8.1)`,
    );
  }
  if (descriptor !== undefined && !descriptor.inputModalities.value.includes("image")) {
    for (const message of req.messages) {
      if (typeof message.content === "string") continue;
      if (message.content.some((b) => b.type === "image")) {
        throw capabilityRefusal(`model "${descriptor.key}" does not advertise image input, so an image block is refused before the request rather than sent and rejected upstream`);
      }
    }
  }
  for (const parameter of descriptor?.unsupportedParameters ?? []) {
    if (parameter === "thinkingConfig" && (req.thinking !== undefined || req.effort !== undefined)) {
      throw capabilityRefusal(`model "${descriptor?.key ?? req.model}" lists "thinkingConfig" in its unsupportedParameters`);
    }
    if (parameter === "tools" && req.tools !== undefined && req.tools.length > 0) {
      throw capabilityRefusal(`model "${descriptor?.key ?? req.model}" lists "tools" in its unsupportedParameters`);
    }
  }

  const thinkingConfig = buildThinkingConfig(req, descriptor);
  if (!thinkingConfig.ok) throw capabilityRefusal(thinkingConfig.reason);

  const declaredMax = req.maxOutputTokens ?? descriptor?.maxOutputTokens?.value;
  if (req.maxOutputTokens !== undefined && descriptor?.maxOutputTokens?.value !== undefined && req.maxOutputTokens > descriptor.maxOutputTokens.value) {
    throw capabilityRefusal(`requested max output ${req.maxOutputTokens} exceeds model "${descriptor.key}"'s declared maximum of ${descriptor.maxOutputTokens.value}`);
  }
  const budget = thinkingConfig.value?.thinkingBudget;
  if (declaredMax !== undefined && budget !== undefined && budget >= declaredMax) {
    throw capabilityRefusal(`thinking budget ${budget} does not fit inside maxOutputTokens ${declaredMax}; the budget must be strictly smaller`);
  }

  const { contents, droppedForeignReasoning } = toContents(req.messages);
  if (droppedForeignReasoning > 0) {
    // A COUNT, never content. The drop is real and is reported; what replaces it is Lane C's.
    ctx.log({ kind: "provider.request.foreign-reasoning-dropped", providerId: ctx.connection.providerId, model: req.model, bytes: droppedForeignReasoning });
  }

  const generationConfig: Record<string, unknown> = {
    ...(declaredMax !== undefined ? { maxOutputTokens: declaredMax } : opts.defaultMaxOutputTokens !== undefined ? { maxOutputTokens: opts.defaultMaxOutputTokens } : {}),
    ...(thinkingConfig.value !== undefined ? { thinkingConfig: thinkingConfig.value } : {}),
  };

  return {
    contents,
    ...(req.system !== undefined ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
    ...(req.tools !== undefined && req.tools.length > 0
      ? { tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })) }] }
      : {}),
    ...(req.toolChoice !== undefined ? { toolConfig: { functionCallingConfig: toFunctionCallingConfig(req.toolChoice) } } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  };
}

function toFunctionCallingConfig(choice: NonNullable<TurnRequest["toolChoice"]>): Record<string, unknown> {
  switch (choice.type) {
    case "auto":
      return { mode: "AUTO" };
    case "any":
      return { mode: "ANY" };
    case "tool":
      return { mode: "ANY", allowedFunctionNames: [choice.name] };
  }
}

/** This family's finish reasons -> the seam's five. Every content-policy stop is a `refusal`, which is what makes a blocked turn distinguishable from a completed one. */
function toStopReason(raw: unknown, sawCall: boolean): "end_turn" | "tool_use" | "max_tokens" | "refusal" {
  if (raw === "MAX_TOKENS") return "max_tokens";
  if (raw === "SAFETY" || raw === "RECITATION" || raw === "PROHIBITED_CONTENT" || raw === "BLOCKLIST" || raw === "SPII" || raw === "IMAGE_SAFETY") return "refusal";
  return sawCall ? "tool_use" : "end_turn";
}

// --- the adapter --------------------------------------------------------------------------------------

export function createGoogleFamilyAdapter(transport: GoogleTransport, opts: GoogleAdapterOptions = {}): ProviderAdapter {
  let compiled: WinterCatalog | undefined;
  const catalogOf = (): WinterCatalog => opts.catalog ?? (compiled ??= loadCatalog());
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  // The URL is composed in `prepare`, not at the fetch site: a connection whose project or location
  // is missing or malformed must fail BEFORE the request as a typed `capability` refusal, not from
  // inside the retry callback where it would be normalised as a transport failure.
  async function prepare(req: TurnRequest, ctx: ProviderContext): Promise<{ url: string; policy: EndpointPolicy; body: Record<string, unknown>; headers: Record<string, string> }> {
    // CHECKED HERE, not left to `boundedFetch`: preparing a request can itself reach the network
    // (the Vertex transport exchanges a signed assertion for an access token), and an already-aborted
    // caller must not cause a credential exchange for a turn that will never be sent.
    if (req.signal?.aborted === true) throw new ProviderRequestError({ code: "aborted", message: "provider request aborted by the caller", retryable: false });
    const descriptor = findDescriptor(catalogOf(), ctx.connection.providerId, req.model);
    const { base, policy } = transport.endpoint(ctx);
    const url = `${base}${transport.streamPath(ctx, req.model)}`;
    const body = buildRequestBody(req, descriptor, opts, ctx);
    const headers = await transport.headers(ctx, policy, true);
    return { url, policy, body, headers };
  }

  async function* streamTurn(req: TurnRequest, ctx: ProviderContext): AsyncGenerator<ProviderEvent> {
    let prepared: { url: string; policy: EndpointPolicy; body: Record<string, unknown>; headers: Record<string, string> };
    try {
      prepared = await prepare(req, ctx);
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
          const res = await boundedFetch(prepared.url, {
            method: "POST",
            headers: prepared.headers,
            body: JSON.stringify(prepared.body),
            timeoutMs,
            maxBodyBytes,
            policy: prepared.policy,
            ...(req.signal !== undefined ? { signal: req.signal } : {}),
          });
          if (!res.ok) throw new ProviderRequestError(normalizeHttpError(res.status, res.headers, await res.text()));
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
    let started = false;
    let callIndex = 0;
    let sawCall = false;
    let finished = false;
    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" = "end_turn";
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens: number | undefined;
    const signatures: GoogleThoughtSignatureItem[] = [];
    let partIndex = 0;

    try {
      for await (const sse of parseSse(response.body, {
        stallTimeoutMs: ctx.stallTimeoutMs,
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
        onBytes: (n) => {
          bytes += n;
        },
      })) {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(sse.data) as Record<string, unknown>;
        } catch {
          yield { type: "error", error: malformed("an unparseable chunk") };
          return;
        }

        if (!started) {
          started = true;
          const modelVersion = payload["modelVersion"];
          yield { type: "message_start", ...(typeof modelVersion === "string" ? { model: modelVersion } : {}) };
        }

        const usage = payload["usageMetadata"] as Record<string, unknown> | undefined;
        if (typeof usage?.["promptTokenCount"] === "number") inputTokens = usage["promptTokenCount"];
        if (typeof usage?.["candidatesTokenCount"] === "number") outputTokens = usage["candidatesTokenCount"];
        // The family bills reasoning separately from the visible answer, so the two are SUMMED into
        // the seam's single `outputTokens` -- reporting only the visible half would under-report a
        // reasoning turn's real cost.
        if (typeof usage?.["thoughtsTokenCount"] === "number") outputTokens += usage["thoughtsTokenCount"];
        if (typeof usage?.["cachedContentTokenCount"] === "number") cacheReadTokens = usage["cachedContentTokenCount"];

        const promptFeedback = payload["promptFeedback"] as { blockReason?: unknown } | undefined;
        if (typeof promptFeedback?.blockReason === "string") {
          // A blocked PROMPT never produces a candidate at all -- it is a refusal, not an empty turn.
          stopReason = "refusal";
          finished = true;
          continue;
        }

        const candidates = payload["candidates"];
        const candidate = Array.isArray(candidates) ? (candidates[0] as { content?: { parts?: unknown }; finishReason?: unknown } | undefined) : undefined;
        if (candidate === undefined) continue;
        const parts = Array.isArray(candidate.content?.parts) ? (candidate.content.parts as Array<Record<string, unknown>>) : [];

        for (const part of parts) {
          const index = partIndex++;
          const signature = typeof part["thoughtSignature"] === "string" ? part["thoughtSignature"] : undefined;
          if (typeof part["functionCall"] === "object" && part["functionCall"] !== null) {
            const call = part["functionCall"] as { name?: unknown; args?: unknown };
            // The id is MINTED here: this family's `functionCall` carries none, and the engine keys
            // a tool result on one. It is stable within the turn, which is all a replay needs.
            const id = `google-call-${callIndex++}`;
            sawCall = true;
            yield { type: "tool_call_start", id, name: typeof call.name === "string" ? call.name : "" };
            yield { type: "tool_call_delta", id, argumentsJsonDelta: JSON.stringify(call.args ?? {}) };
            yield { type: "tool_call_end", id };
            if (signature !== undefined) signatures.push({ partIndex: index, callId: id, signature });
            continue;
          }
          if (signature !== undefined) signatures.push({ partIndex: index, signature });
          if (typeof part["text"] === "string") {
            // A `thought` part is FOREIGN reasoning (R6-8): it never becomes content.
            if (part["thought"] === true) yield { type: "thinking_summary_delta", text: part["text"] };
            else yield { type: "text_delta", text: part["text"] };
          }
        }

        if (candidate.finishReason !== undefined && candidate.finishReason !== null) {
          stopReason = toStopReason(candidate.finishReason, sawCall);
          finished = true;
        }
      }
    } catch (err) {
      yield { type: "error", error: normalizeThrown(err) };
      return;
    } finally {
      ctx.log({ kind: "provider.stream", providerId: ctx.connection.providerId, model: req.model, bytes });
    }

    if (!finished) {
      yield { type: "error", error: { code: "network", message: "the provider stream ended before a finishReason; the turn is incomplete and is not reported as finished", retryable: false } };
      return;
    }

    // THE COMPLETION EVENT, and only it: emitted after the chunk carrying `finishReason`, never from
    // a partial accumulation. A stream that dies mid-turn reaches the `!finished` return above and
    // emits no native state at all.
    if (signatures.length > 0) yield { type: "native_state", items: signatures };
    yield { type: "usage", inputTokens, outputTokens, ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}) };
    yield { type: "done", stopReason };
  }

  return {
    id: transport.id,
    version: transport.version,
    family: "google",
    protocol: "google-generate-content",

    streamTurn,

    async countTokens(req: TurnRequest, ctx: ProviderContext): Promise<number> {
      const descriptor = findDescriptor(catalogOf(), ctx.connection.providerId, req.model);
      const { base, policy } = transport.endpoint(ctx);
      const body = buildRequestBody(req, descriptor, opts, ctx);
      // The count endpoint takes the PROMPT, not the generation parameters.
      delete body["generationConfig"];
      delete body["toolConfig"];
      const headers = await transport.headers(ctx, policy, true);
      const res = await boundedFetch(`${base}${transport.countTokensPath(ctx, req.model)}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        timeoutMs,
        maxBodyBytes,
        policy,
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      });
      const text = await res.text();
      if (!res.ok) throw new ProviderRequestError(normalizeHttpError(res.status, res.headers, text));
      let parsed: { totalTokens?: unknown };
      try {
        parsed = JSON.parse(text) as { totalTokens?: unknown };
      } catch {
        throw new ProviderRequestError(malformed("the countTokens response was not JSON"));
      }
      if (typeof parsed.totalTokens !== "number") throw new ProviderRequestError(malformed("the countTokens response carried no numeric totalTokens"));
      return parsed.totalTokens;
    },

    async validateCredential(ref: CredentialRef, ctx: ProviderContext): Promise<CredentialStatus> {
      if (ref.kind === "none") return { ok: false, code: "missing", message: "no credential is configured for this connection" };
      let material;
      try {
        material = await ctx.credentials.get(ref);
      } catch (err) {
        return { ok: false, code: "unsupported", message: err instanceof Error ? err.message : String(err) };
      }
      if (material === null) return { ok: false, code: "missing", message: "the credential reference resolved to nothing" };
      if (!transport.credentialKinds.includes(material.kind)) {
        return { ok: false, code: "unsupported", message: `the ${transport.id} adapter cannot validate credential material of kind "${material.kind}"` };
      }
      if (transport.listPath === undefined) {
        // NOT a verdict about the credential: this transport has no bounded probe endpoint in this
        // phase's scope, and claiming `ok: true` without checking anything would be a lie.
        return { ok: false, code: "unsupported", message: `the ${transport.id} adapter has no live credential probe in this phase; the credential resolves but has not been verified` };
      }
      const { base, policy } = transport.endpoint(ctx);
      const headers = await transport.headers({ ...ctx, authRef: ref }, policy, false);
      try {
        const res = await boundedFetch(`${base}${transport.listPath(ctx, undefined, 1)}`, { method: "GET", headers, timeoutMs, maxBodyBytes: 1024 * 1024, policy });
        const text = await res.text();
        if (res.ok) return { ok: true };
        const normalized = normalizeHttpError(res.status, res.headers, text);
        if (normalized.code === "auth") return { ok: false, code: "invalid", message: normalized.message };
        return { ok: false, code: "network", message: normalized.message };
      } catch (err) {
        return { ok: false, code: "network", message: normalizeThrown(err).message };
      }
    },

    async listModels(ctx: DiscoveryContext): Promise<ModelCatalogResult> {
      if (transport.listPath === undefined) {
        // ABSENCE IS NOT REMOVAL. Returning an empty catalog marked `partial` says "this transport
        // cannot enumerate", which a caller must not read as "this provider has no models".
        return { models: [], partial: true, cached: false, warnings: [`the ${transport.id} adapter has no bounded model-list endpoint in this phase; the compiled catalog is the only inventory and is NOT authoritative`] };
      }
      const { base, policy } = transport.endpoint(ctx);
      const headers = await transport.headers(ctx, policy, false);
      const models: ModelCatalogResult["models"] = [];
      const warnings: string[] = [];
      let pageToken: string | undefined;
      let partial = false;

      for (let page = 0; page < MAX_DISCOVERY_PAGES; page++) {
        const res = await boundedFetch(`${base}${transport.listPath(ctx, pageToken, Math.min(1000, Math.max(1, ctx.limits.maxItems)))}`, {
          method: "GET",
          headers,
          timeoutMs: Math.min(timeoutMs, ctx.limits.timeoutMs),
          maxBodyBytes: ctx.limits.maxBytes,
          policy,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        });
        const text = await res.text();
        if (!res.ok) throw new ProviderRequestError(normalizeHttpError(res.status, res.headers, text));
        let parsed: { models?: unknown; nextPageToken?: unknown };
        try {
          parsed = JSON.parse(text) as { models?: unknown; nextPageToken?: unknown };
        } catch {
          throw new ProviderRequestError(malformed("the models response was not JSON"));
        }
        for (const row of Array.isArray(parsed.models) ? parsed.models : []) {
          if (row === null || typeof row !== "object") continue;
          const item = row as { name?: unknown; displayName?: unknown; inputTokenLimit?: unknown };
          // The family returns a RESOURCE NAME (`models/gemini-2.5-pro`); the catalog's `upstreamId`
          // is the bare id, so the prefix is stripped here. Disclosed: a row whose name has no
          // prefix is passed through unchanged rather than mangled.
          const name = typeof item.name === "string" ? item.name : "";
          models.push({
            id: name.startsWith("models/") ? name.slice("models/".length) : name,
            ...(typeof item.displayName === "string" ? { displayName: item.displayName } : {}),
            ...(typeof item.inputTokenLimit === "number" ? { contextWindow: item.inputTokenLimit } : {}),
          });
        }
        if (models.length >= ctx.limits.maxItems) {
          partial = partial || typeof parsed.nextPageToken === "string" || models.length > ctx.limits.maxItems;
          break;
        }
        if (typeof parsed.nextPageToken !== "string" || parsed.nextPageToken.length === 0) break;
        pageToken = parsed.nextPageToken;
        if (page === MAX_DISCOVERY_PAGES - 1) {
          warnings.push(`discovery stopped after ${MAX_DISCOVERY_PAGES} pages; the catalog is PARTIAL`);
          partial = true;
        }
      }

      return { models, partial, cached: false, warnings };
    },

    mapEffort(effort: TurnRequest["effort"], descriptorModel: WinterModelDescriptor) {
      const mapped = mapGoogleEffort(effort, descriptorModel);
      return mapped.ok ? { ok: true, value: mapped.value } : { ok: false, reason: mapped.reason };
    },

    capabilities(descriptorModel: WinterModelDescriptor) {
      const members = descriptorModel.reasoning?.continuationDomain?.value;
      const domain = members !== undefined && members.length > 0 ? [...members].sort()[0] : undefined;
      return {
        toolCalling: descriptorModel.toolCalling.value,
        ...(domain !== undefined ? { continuationDomain: domain } : {}),
        readableState: descriptorModel.reasoning?.readableState?.value ?? "none",
      };
    },
  };
}

/**
 * The Gemini API transport: `generativelanguage.googleapis.com`, `x-goog-api-key`.
 *
 * `x-goog-user-project` is the one PRIVILEGED header this family has (R6-L names it explicitly), so
 * it goes through `applyPrivilegedHeaders` and is therefore dropped for a user-supplied `baseUrl` --
 * an account identifier must never be disclosed to a host the reviewed catalog never named. The
 * api-key, content-type and accept headers are PROTOCOL headers and are not routed through it.
 */
export function geminiTransport(): GoogleTransport {
  return {
    id: GOOGLE_ADAPTER_ID,
    version: "1",
    credentialKinds: ["api-key", "bearer", "oauth"],
    endpoint(ctx) {
      const userBase = ctx.connection.baseUrl;
      const base = (userBase ?? GOOGLE_DEFAULT_BASE_URL).replace(/\/+$/, "");
      const built = createEndpointPolicy(base, userBase !== undefined ? { generated: false, ...(ctx.connection.local === true ? { local: true } : {}) } : { generated: true });
      if (!built.ok) throw capabilityRefusal(built.reason);
      return { base, policy: built.policy };
    },
    async headers(ctx, policy, json) {
      const material = await ctx.credentials.get(ctx.authRef);
      const headers: Record<string, string> = {
        ...(json ? { "content-type": "application/json" } : {}),
        ...applyPrivilegedHeaders(policy, ctx.connection.project !== undefined ? { "x-goog-user-project": ctx.connection.project } : {}),
        ...(ctx.connection.headers ?? {}),
      };
      if (material !== null) {
        if (material.kind === "api-key") headers["x-goog-api-key"] = material.key;
        else if (material.kind === "bearer") headers["authorization"] = `Bearer ${material.token}`;
        else if (material.kind === "oauth") headers["authorization"] = `Bearer ${material.accessToken}`;
        else throw capabilityRefusal(`the Google GenerateContent adapter cannot authenticate with credential material of kind "${material.kind}"`);
      }
      return headers;
    },
    // `?alt=sse` is what selects server-sent events over this family's default chunked-JSON-array
    // framing. A REQUEST url may carry a query string (a STORED endpoint may not) -- Task 2's own
    // review finding C1 exists because that distinction was once missing.
    streamPath: (_ctx, model) => `/${GOOGLE_API_VERSION_PATH}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    countTokensPath: (_ctx, model) => `/${GOOGLE_API_VERSION_PATH}/models/${encodeURIComponent(model)}:countTokens`,
    listPath: (_ctx, pageToken, pageSize) => {
      const search = new URLSearchParams({ pageSize: String(pageSize) });
      if (pageToken !== undefined) search.set("pageToken", pageToken);
      return `/${GOOGLE_API_VERSION_PATH}/models?${search.toString()}`;
    },
  };
}

export function createGoogleGenerateContentAdapter(opts: GoogleAdapterOptions = {}): ProviderAdapter {
  return createGoogleFamilyAdapter(geminiTransport(), opts);
}
