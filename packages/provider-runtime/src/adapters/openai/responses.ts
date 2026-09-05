// `openai-responses@1` — the OpenAI Responses API.
//
// Ported from Norma's `packages/core/src/providers/{openai-compatible.ts,responses-sse.ts}` and
// conformed to the Winter seam. The request shape's required-field set is Norma's LIVE-VERIFIED
// finding (2026-06-13 against the codex backend: `tools`, `tool_choice`, `parallel_tool_calls`,
// `store`, `include` are all required — omitting any of them is an HTTP 400), and it is carried over
// intact rather than re-derived from documentation.
//
// Three things this file does that the port did not, each because a Winter ruling requires it:
//
//   THE COMPLETED REASONING ITEM IS COLLECTED, THEN EMITTED ONCE. Norma emitted a `reasoning_item`
//     event per `response.output_item.done`. Winter's `native_state` is a WHOLE-TURN value the fold
//     takes "last one wins" from, so items are accumulated BY OUTPUT INDEX and emitted as a single
//     `native_state` at `response.completed` — in output order, which is the order §5.3 requires
//     them to be replayed in. `response.output_item.added` is never a source (its encrypted content
//     may be incomplete), and that is the brief's own hard rule.
//
//   TOOL ARGUMENTS STREAM. Norma ignored `response.function_call_arguments.delta` and used the final
//     item's `arguments`. Winter's fold accumulates deltas, so the deltas are forwarded — and the
//     final item is used ONLY when no delta was seen for that call, which is what keeps a provider
//     that sends the complete item and nothing else working identically.
//
//   AN UNREPRESENTABLE CALL IS AN ERROR. A `computer_call` / `mcp_call` / `custom_tool_call` arriving
//     in the output stream is a tool the model invoked that this adapter cannot express as a
//     `tool_call_*` triple. WS-13 §9 forbids dropping it silently, so it is a typed refusal.

import type { WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { parseSse } from "../../sse.ts";
import type { CredentialRef, CredentialStatus, DiscoveryContext, ModelCatalogResult, ProviderAdapter, ProviderContext, ProviderEvent, ProviderMessageLike, TurnRequest } from "../../types.ts";
import {
  EventQueue,
  asBlocks,
  assertRepresentableTools,
  assertWithinLimits,
  buildHeaders,
  capabilitiesFrom,
  capabilityRefusal,
  errorEvent,
  fetchOpenAiModels,
  imageDataUrl,
  makeRetryPolicy,
  mapEffortAgainst,
  openStream,
  parseSseJson,
  pumpEvents,
  resolveAuth,
  resolveEndpoint,
  resolveReasoning,
  decorationText,
  prefixToolResult,
  toolResultText,
  validateViaModels,
  type OpenAiAdapterOptions,
  type ReasoningPlan,
  type ResolvedEndpoint,
} from "./shared.ts";

export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

// --- request mapping --------------------------------------------------------------------------------

/**
 * `ProviderMessageLike[]` -> the Responses `input` array.
 *
 * The STRUCTURED content form is mandatory, and that is a live finding rather than a style choice:
 * the flat `{ role, content: "string" }` form was rejected with an HTTP 400 by the codex backend
 * (Norma, 2026-06-13). Assistant content is `output_text`, everything else `input_text`.
 *
 * NATIVE STATE LEADS ITS MESSAGE. §5.3 requires the provider's completed output items to be replayed
 * in their original order among messages and tool calls; a turn's real order is reasoning item(s)
 * first, then the message / function_call it produced. The renderer has already dropped any state
 * from a foreign continuation domain before this sees it, so what arrives here is replayable by
 * construction.
 */
export function mapResponsesInput(messages: readonly ProviderMessageLike[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.nativeState !== undefined) {
      // Replayed VERBATIM and never inspected: these are the provider's own completed items, and
      // `items` is `unknown[]` precisely so nothing here is tempted to look inside.
      for (const item of message.nativeState.items) out.push(item);
    }
    // The Responses `input` has NO "tool" role — a tool result is a standalone
    // `function_call_output` item, and any residual text on such a message rides as a user message.
    // Emitting `role: "tool"` is a 400 (minor 4).
    const wireRole = message.role === "tool" ? "user" : message.role;
    const partType = wireRole === "assistant" ? "output_text" : "input_text";
    const blocks = asBlocks(message.content);
    const contentParts: unknown[] = [];
    // A Winter annotation LEADS its message, so the model reads it before the content it annotates —
    // EXCEPT on a message carrying tool results, where it prefixes the first result's own output
    // instead. A `message` item between a `function_call` and its `function_call_output` breaks the
    // pairing the surface requires (round 3), and an annotation that fails the turn is worse than
    // one that is dropped.
    const decoration = decorationText(message);
    const carriesToolResults = blocks.some((block) => block.type === "tool_result");
    if (decoration !== undefined && !carriesToolResults) contentParts.push({ type: partType, text: decoration });
    let resultPrefix = carriesToolResults ? decoration : undefined;
    for (const block of blocks) {
      switch (block.type) {
        case "text":
          if (block.text.length > 0) contentParts.push({ type: partType, text: block.text });
          break;
        case "image":
          // The Responses shape is `input_image` + `image_url` as a PLAIN data-URL string — not the
          // chat-completions `{ image_url: { url } }` object. Verified live by Norma's CU spike.
          contentParts.push({ type: "input_image", image_url: imageDataUrl(block) });
          break;
        case "tool_use":
          // Flushed before the call so the assistant's own text keeps its position ahead of it.
          if (contentParts.length > 0) {
            out.push({ type: "message", role: wireRole, content: [...contentParts] });
            contentParts.length = 0;
          }
          out.push({ type: "function_call", call_id: block.id, name: block.name, arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}) });
          break;
        case "tool_result":
          if (contentParts.length > 0) {
            out.push({ type: "message", role: wireRole, content: [...contentParts] });
            contentParts.length = 0;
          }
          out.push({ type: "function_call_output", call_id: block.tool_use_id, output: prefixToolResult(resultPrefix, toolResultText(block.content)) });
          // The FIRST result carries it; a message with several results annotates the set once.
          resultPrefix = undefined;
          break;
        default:
          // `thinking` / `redacted_thinking` / `tool_reference` are Anthropic-family or Winter-side
          // shapes with no Responses representation. They never originate here; across a family
          // switch Lane C's renderer strips them, and carrying a fabricated equivalent would be
          // exactly the impersonation R6-8 forbids.
          break;
      }
    }
    if (contentParts.length > 0) out.push({ type: "message", role: wireRole, content: contentParts });
  }
  return out;
}

export function mapResponsesTools(tools: TurnRequest["tools"]): unknown[] {
  return (tools ?? []).map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false }));
}

function mapToolChoice(choice: TurnRequest["toolChoice"]): unknown {
  if (choice === undefined) return "auto";
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  return { type: "function", name: choice.name };
}

/**
 * The Responses request body.
 *
 * `instructions` is sent ONLY when the caller supplied a non-empty system prompt — a deliberate
 * deviation from the port, which sent a default string. Global Constraints forbid vendor prompt
 * text, and inventing a Winter one would put an instruction in front of the model that no caller
 * asked for; codex-rs itself skips the field when it is empty.
 */
export function buildResponsesBody(req: TurnRequest, reasoning: ReasoningPlan, descriptor: WinterModelDescriptor | undefined): Record<string, unknown> {
  const reasoningObject =
    reasoning.enabled && (reasoning.effort !== undefined || reasoning.summary !== undefined)
      ? { ...(reasoning.effort !== undefined ? { effort: reasoning.effort } : {}), ...(reasoning.summary !== undefined ? { summary: reasoning.summary } : {}) }
      : undefined;
  return {
    model: req.model,
    ...(req.system !== undefined && req.system.length > 0 ? { instructions: req.system } : {}),
    input: mapResponsesInput(req.messages),
    tools: mapResponsesTools(req.tools),
    tool_choice: mapToolChoice(req.toolChoice),
    parallel_tool_calls: descriptor?.parallelTools?.value === false ? false : true,
    store: false,
    stream: true,
    include: reasoning.wantsEncryptedContent ? ["reasoning.encrypted_content"] : [],
    ...(reasoningObject !== undefined ? { reasoning: reasoningObject } : {}),
    ...(req.maxOutputTokens !== undefined ? { max_output_tokens: req.maxOutputTokens } : {}),
  };
}

// --- stream mapping -----------------------------------------------------------------------------------

/** Output item types that are a TOOL INVOCATION this adapter cannot express. Seeing one is an error, never a skip (WS-13 §9). */
function isUnrepresentableCall(itemType: string): boolean {
  return itemType !== "function_call" && (itemType.endsWith("_call") || itemType === "custom_tool_call");
}

/**
 * Responses SSE frames -> Winter's normalized `ProviderEvent`s.
 *
 * One instance per turn: the reasoning-item accumulator, the seen-a-call flag and the
 * did-this-call-stream-its-arguments map are all per-turn state.
 */
export class ResponsesStreamMapper {
  private sawToolCall = false;
  private sawRefusal = false;
  private started = false;
  /**
   * The completed reasoning items, ordered by the response's OWN `output_index` and, for anything
   * that carried none, by arrival after everything that did.
   *
   * A list rather than a `Map<number, unknown>` keyed on `output_index ?? 0` (minor 6): that default
   * made every indexless item collide on key 0, so a stream carrying two of them replayed ONE — a
   * silently truncated continuation whose next turn fails at the provider, far from here.
   */
  private readonly reasoningItems: Array<{ index: number; arrival: number; item: unknown }> = [];
  private arrivals = 0;
  /** Item ids already reported as unrepresentable, so `added` + `done` for one call is ONE error (minor 5). */
  private readonly reportedUnrepresentable = new Set<string>();
  /** item_id -> call_id, so an arguments delta (which carries only the item id) can name its call. */
  private readonly callIdByItem = new Map<string, string>();
  /** call_ids whose arguments arrived as deltas — the final item must not re-send them. */
  private readonly streamedArguments = new Set<string>();
  private completed = false;

  map(data: string): ProviderEvent[] {
    const payload = parseSseJson(data);
    if (payload === undefined) return [];
    const type = typeof payload.type === "string" ? payload.type : "";
    switch (type) {
      case "response.created":
        return this.onCreated(payload);
      case "response.output_text.delta": {
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        return delta.length > 0 ? [{ type: "text_delta", text: delta }] : [];
      }
      case "response.reasoning_summary_text.delta": {
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        // A provider-produced SUMMARY. It rides the sidecar and the Winter-only frame, never
        // `assistant.message.content` (R6-8).
        return delta.length > 0 ? [{ type: "thinking_summary_delta", text: delta }] : [];
      }
      case "response.output_item.added":
        return this.onItemAdded(payload);
      case "response.function_call_arguments.delta":
        return this.onArgumentsDelta(payload);
      case "response.output_item.done":
        return this.onItemDone(payload);
      case "response.completed":
      case "response.incomplete":
        return this.onCompleted(payload);
      case "response.failed":
        return [{ type: "error", error: { code: "server", message: this.failureMessage(payload), retryable: false } }];
      case "error":
        return [{ type: "error", error: { code: "server", message: this.failureMessage(payload), retryable: false } }];
      default:
        // Forward compatibility: an unknown event is ignored, exactly as the port did. The ONE
        // exception is an unrepresentable CALL, which arrives on `output_item.added`/`.done` and is
        // handled there.
        return [];
    }
  }

  /**
   * Called when the byte stream ended.
   *
   * A stream that stopped before `response.completed` is a TRUNCATED turn, and reporting it as a
   * finished one would hand the caller a partial answer as if it were whole. It becomes a
   * non-retryable `network` error: bytes flowed, so R6-6 forbids replaying it.
   */
  finish(): ProviderEvent[] {
    if (this.completed) return [];
    return [{ type: "error", error: { code: "network", message: "the provider's stream ended before `response.completed` — the turn is incomplete", retryable: false } }];
  }

  private onCreated(payload: Record<string, unknown>): ProviderEvent[] {
    if (this.started) return [];
    this.started = true;
    const response = payload.response;
    const record = response !== null && typeof response === "object" ? (response as { id?: unknown; model?: unknown }) : {};
    return [
      {
        type: "message_start",
        ...(typeof record.id === "string" ? { id: record.id } : {}),
        ...(typeof record.model === "string" ? { model: record.model } : {}),
      },
    ];
  }

  private onItemAdded(payload: Record<string, unknown>): ProviderEvent[] {
    const item = itemOf(payload);
    if (item === undefined) return [];
    const itemType = typeof item.type === "string" ? item.type : "";
    if (isUnrepresentableCall(itemType)) return this.unrepresentable(itemType, item);
    if (itemType !== "function_call") return [];
    const callId = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : undefined;
    const name = typeof item.name === "string" ? item.name : undefined;
    if (callId === undefined || name === undefined) {
      return [{ type: "error", error: { code: "bad_request", message: "the provider opened a function call with no call id or name, which cannot be represented as a tool call", retryable: false } }];
    }
    if (typeof item.id === "string") this.callIdByItem.set(item.id, callId);
    this.sawToolCall = true;
    return [{ type: "tool_call_start", id: callId, name }];
  }

  private onArgumentsDelta(payload: Record<string, unknown>): ProviderEvent[] {
    const delta = typeof payload.delta === "string" ? payload.delta : "";
    if (delta.length === 0) return [];
    const itemId = typeof payload.item_id === "string" ? payload.item_id : undefined;
    const callId = itemId !== undefined ? this.callIdByItem.get(itemId) : undefined;
    if (callId === undefined) return [];
    this.streamedArguments.add(callId);
    return [{ type: "tool_call_delta", id: callId, argumentsJsonDelta: delta }];
  }

  private onItemDone(payload: Record<string, unknown>): ProviderEvent[] {
    const item = itemOf(payload);
    if (item === undefined) return [];
    const itemType = typeof item.type === "string" ? item.type : "";

    if (itemType === "reasoning") {
      // ONLY items with non-empty `encrypted_content` are replayable — a summary-only reasoning item
      // (which is what arrives when `include` was not sent) would restore nothing on replay, so
      // capturing it would grow the next request for no benefit. `id` and `status` are stripped:
      // both are response-only fields the endpoint clears on a `store: false` replay.
      const encrypted = item.encrypted_content;
      if (typeof encrypted === "string" && encrypted.length > 0) {
        const { id: _id, status: _status, ...replayable } = item;
        // `Number.MAX_SAFE_INTEGER` for an item with no `output_index`: it sorts after everything
        // the response DID position, and the arrival counter keeps two such items distinct.
        const index = typeof payload.output_index === "number" ? payload.output_index : Number.MAX_SAFE_INTEGER;
        this.reasoningItems.push({ index, arrival: this.arrivals++, item: replayable });
      }
      return [];
    }

    if (isUnrepresentableCall(itemType)) return this.unrepresentable(itemType, item);

    if (itemType === "function_call") {
      const callId = typeof item.call_id === "string" ? item.call_id : undefined;
      if (callId === undefined) return [];
      const events: ProviderEvent[] = [];
      if (!this.streamedArguments.has(callId)) {
        // The provider sent the complete item and no deltas (the codex backend's own behaviour). The
        // fold accumulates deltas, so the whole argument string is handed over as one.
        const args = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {});
        if (args.length > 0) events.push({ type: "tool_call_delta", id: callId, argumentsJsonDelta: args });
      }
      events.push({ type: "tool_call_end", id: callId });
      return events;
    }

    if (itemType === "message") this.noteRefusal(item);
    return [];
  }

  private onCompleted(payload: Record<string, unknown>): ProviderEvent[] {
    if (this.completed) return [];
    this.completed = true;
    const events: ProviderEvent[] = [];
    const response = payload.response;
    const record = response !== null && typeof response === "object" ? (response as Record<string, unknown>) : {};

    // THE COMPLETION EVENT IS THE ONLY SOURCE OF NATIVE STATE. Emitted once, complete, in output
    // order — the order §5.3 requires them to be replayed in.
    if (this.reasoningItems.length > 0) {
      const ordered = [...this.reasoningItems].sort((a, b) => a.index - b.index || a.arrival - b.arrival).map((entry) => entry.item);
      events.push({ type: "native_state", items: ordered });
    }

    const usage = record.usage;
    if (usage !== null && typeof usage === "object") {
      const u = usage as { input_tokens?: unknown; output_tokens?: unknown; input_tokens_details?: unknown };
      const cached = u.input_tokens_details !== null && typeof u.input_tokens_details === "object" ? (u.input_tokens_details as { cached_tokens?: unknown }).cached_tokens : undefined;
      events.push({
        type: "usage",
        inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : 0,
        outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : 0,
        ...(typeof cached === "number" ? { cacheReadTokens: cached } : {}),
      });
    }

    // A refusal can also arrive only in the final response object (a non-streamed message part).
    const output = record.output;
    if (Array.isArray(output)) for (const item of output) if (item !== null && typeof item === "object") this.noteRefusal(item as Record<string, unknown>);

    const incomplete = record.incomplete_details;
    const incompleteReason = incomplete !== null && typeof incomplete === "object" ? (incomplete as { reason?: unknown }).reason : undefined;
    const stopReason = this.sawRefusal ? "refusal" : incompleteReason === "max_output_tokens" ? "max_tokens" : this.sawToolCall ? "tool_use" : "end_turn";
    events.push({ type: "done", stopReason });
    return events;
  }

  private noteRefusal(item: Record<string, unknown>): void {
    const content = item.content;
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (part !== null && typeof part === "object" && (part as { type?: unknown }).type === "refusal") this.sawRefusal = true;
    }
  }

  /**
   * ONE error per unrepresentable CALL, not one per lifecycle event (minor 5).
   *
   * A call appears twice in the stream (`output_item.added`, then `.done`), so reporting on both
   * emitted two errors for one refusal — which a consumer counting failures reads as two problems.
   */
  private unrepresentable(itemType: string, item: Record<string, unknown>): ProviderEvent[] {
    const id = typeof item.id === "string" ? item.id : itemType;
    if (this.reportedUnrepresentable.has(id)) return [];
    this.reportedUnrepresentable.add(id);
    return [this.unrepresentableError(itemType)];
  }

  private unrepresentableError(itemType: string): ProviderEvent {
    return {
      type: "error",
      error: {
        code: "capability",
        message: `the model invoked a "${itemType}", which this adapter cannot represent as a tool call — Winter fails the turn rather than dropping the call silently (WS-13 §9)`,
        retryable: false,
      },
    };
  }

  private failureMessage(payload: Record<string, unknown>): string {
    const response = payload.response;
    const error = response !== null && typeof response === "object" ? (response as { error?: unknown }).error : payload.error;
    const message = error !== null && typeof error === "object" ? (error as { message?: unknown }).message : undefined;
    return typeof message === "string" && message.length > 0 ? message : "the provider reported the response failed";
  }
}

function itemOf(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const item = payload.item;
  return item !== null && typeof item === "object" ? (item as Record<string, unknown>) : undefined;
}

// --- the shared turn driver --------------------------------------------------------------------------------

/** What a Responses-speaking adapter (plain OpenAI, codex-oauth, Azure's preview surface) has to supply beyond the request body. */
export interface ResponsesTurnPlan {
  url: string;
  headers: Record<string, string>;
  endpoint: ResolvedEndpoint;
  ctx: ProviderContext;
  options: OpenAiAdapterOptions;
  body: string;
  beforeAttempt?: (attempt: number) => Promise<void>;
  recover?: (status: number, attempt: number) => Promise<Record<string, string> | undefined>;
  /** Observes the refused response before its body is read — the codex quota manager's only honest source for a limit window (finding I1). */
  onRefused?: (response: Response) => void;
  /** Observed after a successful turn — the codex quota manager's "we are no longer limited" hook. */
  onSuccess?: () => void;
  /** Observed on a rate-limited failure, BEFORE the retry sleeps. The one producer of `rate_limit` events (R6-B). */
  onRateLimited?: (retry: Extract<ProviderEvent, { type: "retry" }>, queue: EventQueue) => void;
  /** Pre-seeded observations (an `auth_status` from a token refresh that already happened). */
  queue?: EventQueue;
}

/**
 * Opens the stream, consumes it, and yields the normalized events.
 *
 * `policy.commit()` fires on the FIRST SSE event, not at header time: WS-13 §13's line is the first
 * response byte consumed, and a 5xx that arrives with headers and an error body is still safely
 * retryable.
 */
export async function* streamResponsesTurn(plan: ResponsesTurnPlan, signal: AbortSignal | undefined): AsyncIterable<ProviderEvent> {
  const queue = plan.queue ?? new EventQueue();
  const policy = makeRetryPolicy(plan.options);
  const mapper = new ResponsesStreamMapper();
  let response: Response;
  try {
    response = yield* pumpEvents(
      queue,
      openStream(
        {
          url: plan.url,
          headers: plan.headers,
          body: plan.body,
          policy: plan.endpoint.policy,
          ctx: plan.ctx,
          options: plan.options,
          ...(signal !== undefined ? { signal } : {}),
          ...(plan.beforeAttempt !== undefined ? { beforeAttempt: plan.beforeAttempt } : {}),
          ...(plan.recover !== undefined ? { recover: plan.recover } : {}),
          ...(plan.onRefused !== undefined ? { onRefused: plan.onRefused } : {}),
        },
        policy,
        (event) => {
          // R6-B: the quota manager is the ONE producer of `rate_limit`. It observes the retry here
          // — before the backoff is taken — so a subscription-quota state reaches the host at the
          // same moment the retry does, never after the turn.
          if (event.type === "retry" && event.errorStatus === 429) plan.onRateLimited?.(event, queue);
          queue.push(event);
        },
      ),
    );
  } catch (err) {
    yield errorEvent(err);
    return;
  }

  if (response.body === null) {
    yield { type: "error", error: { code: "network", message: "the provider returned no response body", retryable: false } };
    return;
  }

  try {
    for await (const sse of parseSse(response.body, {
      stallTimeoutMs: plan.ctx.stallTimeoutMs,
      ...(signal !== undefined ? { signal } : {}),
      // Telemetry counts BYTES, never content (Global Constraints).
      onBytes: (n) => plan.ctx.log({ kind: "provider.stream", providerId: plan.ctx.connection.providerId, bytes: n }),
    })) {
      policy.commit();
      for (const event of mapper.map(sse.data)) yield event;
      // Anything an observer queued while the stream was running (a quota state change) gets out
      // HERE: `pumpEvents` only pumps while `openStream` is in flight, so a push after that point
      // has no other door.
      for (const event of queue.drain()) yield event;
    }
    for (const event of mapper.finish()) yield event;
    plan.onSuccess?.();
    // The recovery observation is pushed BY `onSuccess`, i.e. after the pump has already returned.
    // Without this drain it was queued and never yielded — the "your account is serving again"
    // event simply never reached a host, and a test asserting only the FIRST rate_limit event
    // passed anyway.
    for (const event of queue.drain()) yield event;
  } catch (err) {
    yield errorEvent(err);
  }
}

// --- the adapter -------------------------------------------------------------------------------------------

export function createResponsesAdapter(options: OpenAiAdapterOptions): ProviderAdapter {
  return {
    id: "winter.openai-responses",
    version: "1",
    family: "openai",
    protocol: "openai-responses",

    async validateCredential(ref: CredentialRef, ctx: ProviderContext): Promise<CredentialStatus> {
      const endpoint = resolveEndpoint(ctx, options, OPENAI_API_BASE_URL);
      const auth = await resolveAuth(ctx, "bearer");
      const headers = buildHeaders({ policy: endpoint.policy, protocol: { accept: "application/json", ...auth.headers }, privileged: privilegedHeaders(options), userSupplied: ctx.connection.headers });
      return validateViaModels(ref, ctx, endpoint, headers, options, auth.material !== null);
    },

    async listModels(ctx: DiscoveryContext): Promise<ModelCatalogResult> {
      const endpoint = resolveEndpoint(ctx, options, OPENAI_API_BASE_URL);
      const auth = await resolveAuth(ctx, "bearer");
      const headers = buildHeaders({ policy: endpoint.policy, protocol: { accept: "application/json", ...auth.headers }, privileged: privilegedHeaders(options), userSupplied: ctx.connection.headers });
      return fetchOpenAiModels(ctx, endpoint, headers, options);
    },

    streamTurn(req: TurnRequest, ctx: ProviderContext): AsyncIterable<ProviderEvent> {
      return responsesTurn(req, ctx, options, OPENAI_API_BASE_URL, (base) => `${base}/responses`);
    },

    mapEffort(effort: TurnRequest["effort"], model: WinterModelDescriptor) {
      const mapped = mapEffortAgainst(effort, model);
      return mapped.ok ? { ok: true as const, value: mapped.value } : mapped;
    },

    capabilities: capabilitiesFrom,
  };
}

/** PRIVILEGED headers (R6-L): identifiers that only mean something at the reviewed endpoint they were minted for. `applyPrivilegedHeaders` drops them for a user endpoint. */
export function privilegedHeaders(options: OpenAiAdapterOptions): Record<string, string> {
  return {
    ...(options.organization !== undefined ? { "OpenAI-Organization": options.organization } : {}),
    ...(options.project !== undefined ? { "OpenAI-Project": options.project } : {}),
  };
}

/**
 * The plain-OpenAI (and Azure-preview) turn: resolve the endpoint and credential, validate the
 * SELECTION before anything is sent, then stream.
 *
 * Everything that can be refused is refused here, synchronously enough that the fake records ZERO
 * requests — which is what the effort-mapping and limit-rejection fixtures assert on.
 */
export async function* responsesTurn(
  req: TurnRequest,
  ctx: ProviderContext,
  options: OpenAiAdapterOptions,
  fallbackBaseUrl: string | undefined,
  urlFor: (baseUrl: string) => string,
  extraProtocolHeaders: Record<string, string> = {},
): AsyncIterable<ProviderEvent> {
  let plan: ResponsesTurnPlan;
  try {
    const descriptor = options.descriptors?.(req.model);
    assertRepresentableTools(req.tools);
    const reasoning = resolveReasoning(req, descriptor);
    const parametersInPlay = [
      ...(reasoning.enabled && reasoning.effort !== undefined ? ["reasoning", "reasoning.effort"] : []),
      ...(reasoning.summary !== undefined ? ["reasoning.summary"] : []),
      ...(reasoning.wantsEncryptedContent ? ["include"] : []),
      ...(req.maxOutputTokens !== undefined ? ["max_output_tokens"] : []),
      ...((req.tools?.length ?? 0) > 0 ? ["tools"] : []),
    ];
    assertWithinLimits(req, descriptor, parametersInPlay);
    const endpoint = resolveEndpoint(ctx, options, fallbackBaseUrl);
    const auth = await resolveAuth(ctx, "bearer");
    if (auth.material === null && !endpoint.policy.local) {
      throw capabilityRefusal(`no credential is configured for provider "${ctx.connection.providerId}" — an OpenAI-family endpoint that is not a declared local installation needs one`);
    }
    const headers = buildHeaders({
      policy: endpoint.policy,
      protocol: { "content-type": "application/json", accept: "text/event-stream", ...extraProtocolHeaders, ...auth.headers },
      privileged: { ...privilegedHeaders(options), ...(auth.accountId !== undefined ? { "chatgpt-account-id": auth.accountId } : {}) },
      userSupplied: ctx.connection.headers,
    });
    plan = { url: urlFor(endpoint.baseUrl), headers, endpoint, ctx, options, body: JSON.stringify(buildResponsesBody(req, reasoning, descriptor)) };
  } catch (err) {
    yield errorEvent(err);
    return;
  }
  yield* streamResponsesTurn(plan, req.signal);
}
