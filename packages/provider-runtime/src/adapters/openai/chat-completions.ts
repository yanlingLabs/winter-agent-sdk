// `openai-chat-completions@1` — the OpenAI Chat Completions API, and every surface that speaks it:
// DeepSeek, OpenRouter, Azure's deployment path, and the twelve local servers.
//
// The wire differs from Responses in every part that matters, which is why this is a second adapter
// rather than a flag on the first: messages instead of input items, `tool_calls` on the assistant
// message instead of standalone `function_call` items, arguments assembled by INDEX rather than by
// item id, usage behind `stream_options.include_usage` instead of on the completion event, and
// `reasoning_effort` as a top-level field instead of a `reasoning` object.
//
// DEEPSEEK'S EXPOSED REASONING IS THE ONE STRUCTURAL ADDITION, and §6.3 of the continuity report is
// the reason it cannot be optional: with `tools` present, ALL preceding `reasoning_content` must be
// replayed or the next request fails with a 400 — a hard error, not a degradation
// (`toolLoopRequirement: "hard-error"` in the descriptor). So the adapter captures it as
// `native_state` (whose only sink is the provider-state sidecar) AND surfaces it as
// `thinking_exposed_delta` (which is what makes a portable cross-family handoff possible at all),
// and replays it verbatim onto the assistant message inside its own continuation domain.

import type { WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { parseSse } from "../../sse.ts";
import type { CredentialRef, CredentialStatus, DiscoveryContext, ModelCatalogResult, ProviderAdapter, ProviderContext, ProviderEvent, ProviderMessageLike, TurnRequest } from "../../types.ts";
import { privilegedHeaders } from "./responses.ts";
import {
  EventQueue,
  asBlocks,
  assertRepresentableTools,
  assertWithinLimits,
  buildHeaders,
  capabilitiesFrom,
  capabilityRefusal,
  decorationText,
  errorEvent,
  fetchOpenAiModels,
  imageDataUrl,
  isStreamTerminator,
  makeRetryPolicy,
  mapEffortAgainst,
  openStream,
  parseSseJson,
  pumpEvents,
  resolveAuth,
  resolveEndpoint,
  resolveReasoning,
  toolResultText,
  validateViaModels,
  type AuthStyle,
  type OpenAiAdapterOptions,
  type ReasoningPlan,
  type ResolvedEndpoint,
} from "./shared.ts";

export const OPENAI_CHAT_BASE_URL = "https://api.openai.com/v1";
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** The `native_state` item DeepSeek-class exposed reasoning rides in. A Winter-shaped wrapper, because the text is ours to place — it is not an opaque provider object. */
export interface ExposedReasoningItem {
  type: "winter.exposed_reasoning";
  text: string;
}

function isExposedReasoningItem(item: unknown): item is ExposedReasoningItem {
  return item !== null && typeof item === "object" && (item as { type?: unknown }).type === "winter.exposed_reasoning" && typeof (item as { text?: unknown }).text === "string";
}

// --- request mapping ----------------------------------------------------------------------------------

function userContentParts(blocks: ReturnType<typeof asBlocks>, decoration?: string): { content: unknown; hasParts: boolean } {
  const parts: unknown[] = [];
  let text = decoration ?? "";
  let sawImage = false;
  if (decoration !== undefined) parts.push({ type: "text", text: decoration });
  for (const block of blocks) {
    if (block.type === "text") {
      text += text.length > 0 ? `\n${block.text}` : block.text;
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      sawImage = true;
      // The chat-completions image shape is the OBJECT form, `{ image_url: { url } }` — the exact
      // opposite of the Responses surface's plain string. Getting this backwards is a 400 on both.
      parts.push({ type: "image_url", image_url: { url: imageDataUrl(block) } });
    }
  }
  // A text-only message goes as a plain string: every OpenAI-compatible server accepts it, and some
  // local ones accept nothing else.
  return sawImage ? { content: parts, hasParts: true } : { content: text, hasParts: false };
}

/**
 * `ProviderMessageLike[]` -> chat `messages`.
 *
 * `system` is prepended by the caller rather than derived here, so the ordering is visible at the
 * one place that owns the body.
 */
export function mapChatMessages(messages: readonly ProviderMessageLike[], replayExposedReasoning: boolean): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    const blocks = asBlocks(message.content);

    if (message.role === "tool") {
      // A `tool` message has no room for prose — its content IS the result, keyed to a call id — so
      // an annotation on one rides as a leading USER message, exactly as the Responses mapper
      // flushes it ahead of the `function_call_output`. Before this it was silently dropped on the
      // chat surface only, which is the worst shape of the same bug minor 11 fixed: present on one
      // surface, absent on another, with nothing saying so.
      const toolDecoration = decorationText(message);
      if (toolDecoration !== undefined) out.push({ role: "user", content: toolDecoration });
      for (const block of blocks) {
        if (block.type === "tool_result") out.push({ role: "tool", tool_call_id: block.tool_use_id, content: toolResultText(block.content) });
      }
      continue;
    }

    if (message.role === "assistant") {
      const toolCalls: unknown[] = [];
      // The Winter annotation LEADS its message, so the model reads it before the content it
      // annotates (minor 11).
      let text = decorationText(message) ?? "";
      for (const block of blocks) {
        if (block.type === "text") text += text.length > 0 ? `\n${block.text}` : block.text;
        else if (block.type === "tool_use") {
          toolCalls.push({ id: block.id, type: "function", function: { name: block.name, arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}) } });
        }
        // `thinking` / `redacted_thinking` are Anthropic-family shapes with no chat representation,
        // and R6-8 forbids inventing one. They never originate here.
      }
      // §6.3: with tools in play, DROPPING this is a 400 on the very next request — the descriptor
      // records it as `toolLoopRequirement: "hard-error"`. The renderer has already removed native
      // state from a foreign domain, so anything reaching here is replayable by construction.
      const exposed = replayExposedReasoning ? (message.nativeState?.items ?? []).filter(isExposedReasoningItem).map((i) => i.text).join("") : "";
      out.push({
        role: "assistant",
        content: text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(exposed.length > 0 ? { reasoning_content: exposed } : {}),
      });
      continue;
    }

    // A user message may also carry tool results (a host-supplied history in the wire's own shape).
    const results = blocks.filter((b) => b.type === "tool_result");
    if (results.length > 0) {
      for (const block of results) {
        if (block.type === "tool_result") out.push({ role: "tool", tool_call_id: block.tool_use_id, content: toolResultText(block.content) });
      }
      const rest = blocks.filter((b) => b.type !== "tool_result");
      if (rest.length > 0) out.push({ role: "user", content: userContentParts(rest, decorationText(message)).content });
      continue;
    }
    out.push({ role: "user", content: userContentParts(blocks, decorationText(message)).content });
  }
  return out;
}

export function mapChatTools(tools: TurnRequest["tools"]): unknown[] {
  return (tools ?? []).map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
}

function mapChatToolChoice(choice: TurnRequest["toolChoice"]): unknown {
  if (choice === undefined) return "auto";
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  return { type: "function", function: { name: choice.name } };
}

/**
 * The chat request body.
 *
 * `max_completion_tokens` vs `max_tokens`: the newer spelling is required on reasoning models and
 * rejected by many local servers, and the old one is the reverse. The descriptor's own reasoning
 * evidence is what decides, which keeps the choice a recorded FACT about the model rather than a
 * guess about the endpoint. Disclosed.
 */
export function buildChatBody(req: TurnRequest, reasoning: ReasoningPlan, descriptor: WinterModelDescriptor | undefined, replayExposedReasoning: boolean): Record<string, unknown> {
  const messages: unknown[] = [];
  if (req.system !== undefined && req.system.length > 0) messages.push({ role: "system", content: req.system });
  messages.push(...mapChatMessages(req.messages, replayExposedReasoning));
  const tools = mapChatTools(req.tools);
  const budgetField = descriptor?.reasoning !== undefined ? "max_completion_tokens" : "max_tokens";
  return {
    model: req.model,
    messages,
    stream: true,
    // Usage does not arrive at all without this: the final chunk carrying it is opt-in.
    stream_options: { include_usage: true },
    ...(tools.length > 0 ? { tools, tool_choice: mapChatToolChoice(req.toolChoice) } : {}),
    ...(reasoning.enabled && reasoning.effort !== undefined ? { reasoning_effort: reasoning.effort } : {}),
    ...(req.maxOutputTokens !== undefined ? { [budgetField]: req.maxOutputTokens } : {}),
  };
}

// --- stream mapping -------------------------------------------------------------------------------------

interface PendingCall {
  id: string;
  name: string;
}

/**
 * Chat Completions SSE chunks -> Winter's normalized events.
 *
 * ARGUMENTS ARE ASSEMBLED BY `index`, NOT BY ID: only the FIRST fragment of a call carries its `id`
 * and `function.name`; every later fragment carries the index alone. An adapter keyed on id would
 * drop every continuation fragment and produce empty arguments for every call — silently.
 */
export class ChatStreamMapper {
  private started = false;
  private stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | undefined;
  private exposed = "";
  private completed = false;
  private readonly callsByIndex = new Map<number, PendingCall>();
  private readonly order: number[] = [];

  constructor(private readonly captureExposedReasoning: boolean) {}

  map(data: string): ProviderEvent[] {
    if (isStreamTerminator(data)) return this.finalize();
    const payload = parseSseJson(data);
    if (payload === undefined) return [];
    const events: ProviderEvent[] = [];

    // A provider may report an error INSIDE a 200 stream rather than as a status.
    const inlineError = payload.error;
    if (inlineError !== null && typeof inlineError === "object") {
      const message = (inlineError as { message?: unknown }).message;
      const code = (inlineError as { code?: unknown }).code;
      return [
        {
          type: "error",
          error: { code: "server", message: typeof message === "string" ? message : "the provider reported an error mid-stream", retryable: false, ...(typeof code === "string" ? { providerCode: code } : {}) },
        },
      ];
    }

    if (!this.started) {
      this.started = true;
      events.push({
        type: "message_start",
        ...(typeof payload.id === "string" ? { id: payload.id } : {}),
        ...(typeof payload.model === "string" ? { model: payload.model } : {}),
      });
    }

    const usage = payload.usage;
    if (usage !== null && typeof usage === "object") {
      const u = usage as { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: unknown; prompt_cache_hit_tokens?: unknown };
      const details = u.prompt_tokens_details !== null && typeof u.prompt_tokens_details === "object" ? (u.prompt_tokens_details as { cached_tokens?: unknown }).cached_tokens : undefined;
      // DeepSeek reports its cache hits under its own name; both are the same accounting fact.
      const cached = typeof details === "number" ? details : typeof u.prompt_cache_hit_tokens === "number" ? u.prompt_cache_hit_tokens : undefined;
      events.push({
        type: "usage",
        inputTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0,
        outputTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
        ...(cached !== undefined ? { cacheReadTokens: cached } : {}),
      });
    }

    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    for (const choice of choices) {
      if (choice === null || typeof choice !== "object") continue;
      const record = choice as { delta?: unknown; finish_reason?: unknown };
      events.push(...this.mapDelta(record.delta));
      const finish = record.finish_reason;
      if (typeof finish === "string" && finish.length > 0) {
        for (const index of this.order) {
          const call = this.callsByIndex.get(index);
          if (call !== undefined) events.push({ type: "tool_call_end", id: call.id });
        }
        this.stopReason = finish === "tool_calls" ? "tool_use" : finish === "length" ? "max_tokens" : finish === "content_filter" ? "refusal" : "end_turn";
      }
    }
    return events;
  }

  /** The stream ended. A turn that reached a `finish_reason` is complete even without a `[DONE]` — many OpenAI-compatible servers never send one. */
  finish(): ProviderEvent[] {
    if (this.completed) return [];
    if (this.stopReason !== undefined) return this.finalize();
    return [{ type: "error", error: { code: "network", message: "the provider's stream ended before any finish_reason — the turn is incomplete", retryable: false } }];
  }

  private finalize(): ProviderEvent[] {
    if (this.completed) return [];
    this.completed = true;
    const events: ProviderEvent[] = [];
    // Captured at COMPLETION, once, whole — the same rule the Responses surface follows, for the
    // same reason: a partial copy replayed on the next turn is a request the provider rejects.
    if (this.captureExposedReasoning && this.exposed.length > 0) {
      events.push({ type: "native_state", items: [{ type: "winter.exposed_reasoning", text: this.exposed } satisfies ExposedReasoningItem] });
    }
    events.push({ type: "done", stopReason: this.stopReason ?? "end_turn" });
    return events;
  }

  private mapDelta(delta: unknown): ProviderEvent[] {
    if (delta === null || typeof delta !== "object") return [];
    const record = delta as { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: unknown };
    const events: ProviderEvent[] = [];

    if (typeof record.content === "string" && record.content.length > 0) events.push({ type: "text_delta", text: record.content });

    // DeepSeek spells it `reasoning_content`; OpenRouter re-exports the same channel as `reasoning`.
    // Both are FULL EXPOSED reasoning, which never becomes assistant content (R6-8).
    const exposedDelta = typeof record.reasoning_content === "string" ? record.reasoning_content : typeof record.reasoning === "string" ? record.reasoning : undefined;
    if (exposedDelta !== undefined && exposedDelta.length > 0) {
      this.exposed += exposedDelta;
      events.push({ type: "thinking_exposed_delta", text: exposedDelta });
    }

    const toolCalls = record.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const fragment of toolCalls) {
        if (fragment === null || typeof fragment !== "object") continue;
        const f = fragment as { index?: unknown; id?: unknown; function?: unknown };
        const index = typeof f.index === "number" ? f.index : 0;
        const fn = f.function !== null && typeof f.function === "object" ? (f.function as { name?: unknown; arguments?: unknown }) : {};
        const existing = this.callsByIndex.get(index);
        if (existing === undefined) {
          const id = typeof f.id === "string" && f.id.length > 0 ? f.id : undefined;
          const name = typeof fn.name === "string" && fn.name.length > 0 ? fn.name : undefined;
          if (id === undefined || name === undefined) {
            // A NEW call slot with no identity is a tool invocation this adapter cannot express.
            // Assembling it under an invented id would hand the caller a call the model never named.
            events.push({
              type: "error",
              error: {
                code: "capability",
                message: `the provider opened tool call slot ${index} with no id or function name, so the call cannot be represented — Winter fails the turn rather than dropping it silently (WS-13 §9)`,
                retryable: false,
              },
            });
            continue;
          }
          this.callsByIndex.set(index, { id, name });
          this.order.push(index);
          events.push({ type: "tool_call_start", id, name });
        }
        const call = this.callsByIndex.get(index);
        if (call !== undefined && typeof fn.arguments === "string" && fn.arguments.length > 0) {
          events.push({ type: "tool_call_delta", id: call.id, argumentsJsonDelta: fn.arguments });
        }
      }
    }
    return events;
  }
}

// --- the turn -------------------------------------------------------------------------------------------------

export interface ChatTurnOptions extends OpenAiAdapterOptions {
  /** Azure's deployment surface needs `api-key`; everything else is a bearer. */
  authStyle?: AuthStyle;
}

/**
 * The chat turn, from selection validation to the last event.
 *
 * Everything refusable is refused before the endpoint is even resolved, so a rejected selection
 * leaves the fake with zero recorded requests — which is what the corpus asserts on.
 */
export async function* chatTurn(
  req: TurnRequest,
  ctx: ProviderContext,
  options: ChatTurnOptions,
  fallbackBaseUrl: string | undefined,
  urlFor: (endpoint: ResolvedEndpoint) => string,
  extraProtocolHeaders: Record<string, string> = {},
): AsyncIterable<ProviderEvent> {
  const queue = new EventQueue();
  const policy = makeRetryPolicy(options);
  let url: string;
  let headers: Record<string, string>;
  let endpoint: ResolvedEndpoint;
  let body: string;
  let captureExposed: boolean;
  try {
    const descriptor = options.descriptors?.(req.model);
    assertRepresentableTools(req.tools);
    const reasoning = resolveReasoning(req, descriptor);
    assertWithinLimits(req, descriptor, [
      ...(reasoning.effort !== undefined ? ["reasoning_effort"] : []),
      ...(req.maxOutputTokens !== undefined ? [descriptor?.reasoning !== undefined ? "max_completion_tokens" : "max_tokens"] : []),
      ...((req.tools?.length ?? 0) > 0 ? ["tools"] : []),
    ]);
    // `full-exposed` is the descriptor's own recorded observation of the endpoint's behaviour, not
    // an inference from the model family (§6.4 is explicit that the serving stack decides).
    captureExposed = descriptor?.reasoning?.readableState?.value === "full-exposed";
    endpoint = resolveEndpoint(ctx, options, fallbackBaseUrl);
    const auth = await resolveAuth(ctx, options.authStyle ?? "bearer");
    if (auth.material === null && !endpoint.policy.local) {
      throw capabilityRefusal(`no credential is configured for provider "${ctx.connection.providerId}" — an OpenAI-compatible endpoint that is not a declared local installation needs one`);
    }
    headers = buildHeaders({
      policy: endpoint.policy,
      protocol: { "content-type": "application/json", accept: "text/event-stream", ...extraProtocolHeaders, ...auth.headers },
      privileged: { ...privilegedHeaders(options), ...(auth.accountId !== undefined ? { "chatgpt-account-id": auth.accountId } : {}) },
      userSupplied: ctx.connection.headers,
    });
    url = urlFor(endpoint);
    body = JSON.stringify(buildChatBody(req, reasoning, descriptor, captureExposed));
  } catch (err) {
    yield errorEvent(err);
    return;
  }

  let response: Response;
  try {
    response = yield* pumpEvents(
      queue,
      openStream({ url, headers, body, policy: endpoint.policy, ctx, options, ...(req.signal !== undefined ? { signal: req.signal } : {}) }, policy, (event) => queue.push(event)),
    );
  } catch (err) {
    yield errorEvent(err);
    return;
  }
  if (response.body === null) {
    yield { type: "error", error: { code: "network", message: "the provider returned no response body", retryable: false } };
    return;
  }

  const mapper = new ChatStreamMapper(captureExposed);
  try {
    for await (const sse of parseSse(response.body, {
      stallTimeoutMs: ctx.stallTimeoutMs,
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
      onBytes: (n) => ctx.log({ kind: "provider.stream", providerId: ctx.connection.providerId, bytes: n }),
    })) {
      policy.commit();
      for (const event of mapper.map(sse.data)) yield event;
    }
    for (const event of mapper.finish()) yield event;
  } catch (err) {
    yield errorEvent(err);
  }
}

// --- the adapter -------------------------------------------------------------------------------------------------

export function createChatCompletionsAdapter(options: ChatTurnOptions): ProviderAdapter {
  return {
    id: "winter.openai-chat-completions",
    version: "1",
    family: "openai",
    protocol: "openai-chat-completions",

    async validateCredential(ref: CredentialRef, ctx: ProviderContext): Promise<CredentialStatus> {
      const endpoint = resolveEndpoint(ctx, options, OPENAI_CHAT_BASE_URL);
      const auth = await resolveAuth(ctx, options.authStyle ?? "bearer");
      const headers = buildHeaders({ policy: endpoint.policy, protocol: { accept: "application/json", ...auth.headers }, privileged: privilegedHeaders(options), userSupplied: ctx.connection.headers });
      return validateViaModels(ref, ctx, endpoint, headers, options, auth.material !== null);
    },

    async listModels(ctx: DiscoveryContext): Promise<ModelCatalogResult> {
      const endpoint = resolveEndpoint(ctx, options, OPENAI_CHAT_BASE_URL);
      const auth = await resolveAuth(ctx, options.authStyle ?? "bearer");
      const headers = buildHeaders({ policy: endpoint.policy, protocol: { accept: "application/json", ...auth.headers }, privileged: privilegedHeaders(options), userSupplied: ctx.connection.headers });
      return fetchOpenAiModels(ctx, endpoint, headers, options);
    },

    streamTurn(req: TurnRequest, ctx: ProviderContext): AsyncIterable<ProviderEvent> {
      return chatTurn(req, ctx, options, OPENAI_CHAT_BASE_URL, (endpoint) => `${endpoint.baseUrl}/chat/completions`);
    },

    mapEffort(effort: TurnRequest["effort"], model: WinterModelDescriptor) {
      const mapped = mapEffortAgainst(effort, model);
      return mapped.ok ? { ok: true as const, value: mapped.value } : mapped;
    },

    capabilities: capabilitiesFrom,
  };
}

// --- connection profiles (R6-K) -------------------------------------------------------------------------------------

/**
 * OpenRouter as a CONNECTION PROFILE of the chat adapter, not a fourth adapter.
 *
 * The attribution headers are set ONLY when the caller supplies them. They identify the operator's
 * app to a third party, so defaulting them would disclose something the host never asked to
 * disclose — and they are user-supplied rather than privileged precisely because OpenRouter's own
 * endpoint is where they belong.
 */
export function openRouterProfile(opts: { baseUrl?: string; referer?: string; title?: string } = {}): { providerId: string; baseUrl: string; headers?: Record<string, string> } {
  const headers: Record<string, string> = {
    ...(opts.referer !== undefined ? { "HTTP-Referer": opts.referer } : {}),
    ...(opts.title !== undefined ? { "X-Title": opts.title } : {}),
  };
  return { providerId: "openrouter", baseUrl: opts.baseUrl ?? OPENROUTER_BASE_URL, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
}

/** DeepSeek as a connection profile. Its `reasoning_content` handling is descriptor-driven, so there is nothing endpoint-specific to configure beyond the base URL. */
export function deepSeekProfile(opts: { baseUrl?: string } = {}): { providerId: string; baseUrl: string } {
  return { providerId: "deepseek", baseUrl: opts.baseUrl ?? DEEPSEEK_BASE_URL };
}
