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
import type { ContentBlockLike, CredentialRef, CredentialStatus, DiscoveryContext, ModelCatalogResult, ProviderAdapter, ProviderContext, ProviderEvent, ProviderMessageLike, TurnRequest } from "../../types.ts";
import { carriesToolResultsAt, privilegedHeaders } from "./responses.ts";
import {
  EventQueue,
  asBlocks,
  assertRepresentableTools,
  assertWithinLimits,
  buildHeaders,
  capabilitiesFrom,
  capabilityRefusal,
  decorationText,
  prefixToolResult,
  errorEvent,
  fetchOpenAiModels,
  identityFor,
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
  toolResultFollowUpBlocks,
  toolResultText,
  validateViaModels,
  type AuthStyle,
  type OpenAiAdapterOptions,
  type ReasoningPlan,
  type ResolvedEndpoint,
  normalizedPromptUsage,
} from "./shared.ts";

export const OPENAI_CHAT_BASE_URL = "https://api.openai.com/v1";
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * The adapter's compiled-in vendor endpoint, for THIS turn's provider — which is only ever OpenAI's.
 *
 * WS-24 (follow-up 2), mirroring `responses.ts`'s `vendorFallbackFor` (WS-23): this adapter serves
 * every OpenAI-compatible dialect (DeepSeek, OpenRouter, Azure's deployment path, the twelve local
 * servers, and any other row wired against it), so "the adapter's own default" is not "the
 * provider's own endpoint" — it never was. Unconditionally handing every provider `api.openai.com`
 * meant a chat-completions row shipped with no catalog `defaultEndpoints` entry and no connection
 * `baseUrl` sent ITS OWN credential to OpenAI's host, silently, exactly the no-silent-fallback rule
 * responses.ts was already fixed for. Every other provider gets NO fallback here: its endpoint comes
 * from its own catalog row (`generatedBaseUrls`) or its connection profile, and with neither the
 * turn is refused typed by `resolveEndpoint`.
 */
function vendorFallbackFor(ctx: ProviderContext): string | undefined {
  return ctx.connection.providerId === "openai" ? OPENAI_CHAT_BASE_URL : undefined;
}

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

/** An assistant message as `mapChatMessages` writes it. */
interface ChatAssistantWire {
  role: "assistant";
  content: string;
  tool_calls?: unknown[];
  reasoning_content?: string;
}

/** Two non-empty parts joined on a newline; an empty part adds nothing (a call-only message has no text). */
function joinParts(a: string, b: string): string {
  return a.length === 0 ? b : b.length === 0 ? a : `${a}\n${b}`;
}

/** `previous` with the next consecutive assistant message's text, calls and replayed reasoning appended (fix round 24). */
function mergeChatAssistant(previous: ChatAssistantWire, text: string, toolCalls: unknown[], exposed: string): ChatAssistantWire {
  const calls = [...(previous.tool_calls ?? []), ...toolCalls];
  const reasoning = joinParts(previous.reasoning_content ?? "", exposed);
  return {
    role: "assistant",
    content: joinParts(previous.content, text),
    ...(calls.length > 0 ? { tool_calls: calls } : {}),
    ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
  };
}

/**
 * `ProviderMessageLike[]` -> chat `messages`.
 *
 * `system` is prepended by the caller rather than derived here, so the ordering is visible at the
 * one place that owns the body.
 */
/**
 * Code-mode images: how a chat-completions surface carries a tool result's images.
 *
 * `"follow-up"` (OpenAI's own shape, the default): a `tool` message is text only
 * (`ChatCompletionToolMessageParam.content` is "string or array of ChatCompletionContentPartText"), so the
 * images ride a `user` message after the tool replies.
 *
 * `"tool-message"` (Mistral): Mistral REFUSES a `user` message directly after a `tool` message -- HTTP 400
 * "Unexpected role 'user' after role 'tool'" (reported against Mistral's API in zed-industries/zed#31491,
 * danny-avila/LibreChat#12429, yetone/avante.nvim#2562), so the follow-up would fail that request and,
 * the image being in the history, every later one. Its own `ToolMessage.content` is "string | array of
 * chunks" and the chunk union includes `ImageURLChunk` (`{type:"image_url", image_url: ImageURL | string}`,
 * https://docs.mistral.ai/api/endpoint/chat, messages > ToolMessage > content). So on Mistral the images
 * ride INSIDE the tool message, and any trailing content of the same turn is folded into the last tool
 * message too -- nothing `user`-role follows a tool reply.
 *
 * A provider-id rule, not a catalog trait: the catalog has no per-provider wire-dialect field for this
 * surface today, and Mistral's API (`mistral`, `codestral`) is the one chat surface with evidence of the
 * refusal.
 */
export type ChatToolResultImages = "follow-up" | "tool-message";

// Every catalog provider served by Mistral's own API: `mistral` (api.mistral.ai) and `codestral`
// (codestral.mistral.ai) -- the only two whose endpoint is Mistral's.
const TOOL_MESSAGE_IMAGE_PROVIDERS: ReadonlySet<string> = new Set(["mistral", "codestral"]);

/** The tool-result image shape for a provider (see `ChatToolResultImages`). */
export function chatToolResultImagesFor(providerId: string): ChatToolResultImages {
  return TOOL_MESSAGE_IMAGE_PROVIDERS.has(providerId) ? "tool-message" : "follow-up";
}

/** A block list as Mistral-style content chunks: text as `text`, images as `image_url`. */
function contentChunks(blocks: readonly ContentBlockLike[]): unknown[] {
  const out: unknown[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text.length > 0) out.push({ type: "text", text: block.text });
    else if (block.type === "image") out.push({ type: "image_url", image_url: { url: imageDataUrl(block) } });
  }
  return out;
}

/** One tool result as a `tool` message. In `"tool-message"` mode a result with images is a chunk array. */
function toolMessage(block: Extract<ContentBlockLike, { type: "tool_result" }>, prefix: string | undefined, mode: ChatToolResultImages): Record<string, unknown> {
  if (mode === "tool-message" && Array.isArray(block.content) && block.content.some((b) => b.type === "image")) {
    return { role: "tool", tool_call_id: block.tool_use_id, content: [...(prefix !== undefined ? [{ type: "text", text: prefix }] : []), ...contentChunks(block.content)] };
  }
  return { role: "tool", tool_call_id: block.tool_use_id, content: prefixToolResult(prefix, toolResultText(block.content)) };
}

/** `"tool-message"` mode: the turn's trailing content folded into the LAST tool message, as chunks. */
function foldIntoLastToolMessage(out: unknown[], trailing: readonly ContentBlockLike[]): void {
  const last = out[out.length - 1] as { content: unknown };
  const existing = typeof last.content === "string" ? (last.content.length > 0 ? [{ type: "text", text: last.content }] : []) : (last.content as unknown[]);
  last.content = [...existing, ...contentChunks(trailing)];
}

export function mapChatMessages(messages: readonly ProviderMessageLike[], replayExposedReasoning: boolean, opts: { toolResultImages?: ChatToolResultImages } = {}): unknown[] {
  const mode = opts.toolResultImages ?? "follow-up";
  const out: unknown[] = [];
  // Code-mode images: the follow-up `user` content of a tool-result message whose NEXT message also
  // carries tool results waits for the end of the run -- a `user` message between two `tool` replies of
  // one batch is refused ("messages with role 'tool' must be a response to a preceeding message with
  // 'tool_calls'"). A resumed claude transcript splits a parallel batch into one entry per result.
  let carried: ContentBlockLike[] = [];
  const emitFollowUp = (trailing: ContentBlockLike[], nextIndex: number): void => {
    const all = [...carried, ...trailing];
    carried = [];
    if (all.length === 0) return;
    if (carriesToolResultsAt(messages, nextIndex)) carried = all;
    else out.push({ role: "user", content: userContentParts(all).content });
  };
  for (const [messageIndex, message] of messages.entries()) {
    const blocks = asBlocks(message.content);

    if (message.role === "tool") {
      // An annotation on a tool message PREFIXES the result's own content (round 3). It cannot be a
      // message of its own: a `user` message between an assistant's `tool_calls` and its `tool`
      // reply is rejected outright ("messages with role 'tool' must be a response to a preceeding
      // message with 'tool_calls'"), which would fail the whole turn rather than merely lose the
      // note. Prefixing keeps it adjacent to exactly what it annotates and adds nothing to the wire.
      let toolPrefix = decorationText(message);
      let rendered = false;
      for (const block of blocks) {
        if (block.type !== "tool_result") continue;
        out.push(toolMessage(block, toolPrefix, mode));
        toolPrefix = undefined;
        rendered = true;
      }
      // A tool-role message with NO `tool_result` block — string content, say, from a host-supplied
      // history — used to render as NOTHING AT ALL: the message and its decoration vanished, and the
      // Responses mapper turned the same input into a user message (Lane A r3 carry). It cannot be a
      // `tool` message here, because this surface requires a `tool_call_id` and there is no result to
      // take one from; so it becomes what Responses already makes it, and the content survives.
      if (!rendered) {
        out.push({ role: "user", content: userContentParts(blocks, toolPrefix).content });
        continue;
      }
      // 0.0.16 request layout: TEXT AFTER THE TOOL RESULTS in one user turn (a persisted attachment
      // or a queued notification the engine merged onto this tool message, claude's own wire shape).
      // It used to be DROPPED here -- the loop above renders only the results. It becomes a
      // FOLLOW-ON `user` message after every `tool` reply, which is the one position this surface
      // accepts: nothing may sit between an assistant's `tool_calls` and its `tool` replies.
      //
      // Code-mode images: a `tool` message's content is text only on this surface -- the API's
      // `ChatCompletionToolMessageParam.content` is a string or an array of TEXT parts, with no image
      // part ("string or array of ChatCompletionContentPartText",
      // https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) -- so a result's
      // images ride the same follow-on `user` message, each result's set captioned with its call id, and
      // the result's own text says the image follows (`toolResultText`). Never dropped.
      if (mode === "tool-message") {
        // Mistral: the images already rode their tool messages; trailing content joins the last one.
        const rest = blocks.filter((b) => b.type !== "tool_result");
        if (contentChunks(rest).length > 0) foldIntoLastToolMessage(out, rest);
        continue;
      }
      emitFollowUp([...toolResultFollowUpBlocks(blocks), ...blocks.filter((b) => b.type !== "tool_result")], messageIndex + 1);
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
      // WS-21 fix round 24: CONSECUTIVE assistant messages become ONE wire message. claude writes a
      // parallel tool batch as one transcript entry per call, so a history rebuilt from its
      // transcript carries the batch as N one-call assistant messages followed by N results. This
      // wire requires every assistant `tool_calls` message to be followed DIRECTLY by its `tool`
      // replies, so the unmerged batch was refused outright on the first turn after a claude ->
      // Winter switch (and every later turn resent it). claude sends one API message per response
      // (the entries sharing a `message.id`). This history carries no message id; adjacency --
      // nothing, not a tool reply and not a user message, between the two -- is what marks one
      // response's entries here, and it is the same rule every other serializer in this package
      // already applies (adjacent same-role messages merge). Text, calls and replayed reasoning are
      // concatenated in message order, so nothing is lost and a batch already written as one
      // message maps exactly as before.
      const previous = out.at(-1) as ChatAssistantWire | undefined;
      if (previous !== undefined && previous.role === "assistant") {
        out[out.length - 1] = mergeChatAssistant(previous, text, toolCalls, exposed);
        continue;
      }
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
      // The SAME prefix rule (round 3): a host-supplied history can put tool results on a `user`
      // message, and this branch dropped the decoration entirely. It cannot lead them either, for
      // the adjacency reason above.
      let resultPrefix = decorationText(message);
      for (const block of results) {
        if (block.type !== "tool_result") continue;
        out.push(toolMessage(block, resultPrefix, mode));
        resultPrefix = undefined;
      }
      if (mode === "tool-message") {
        const trailingRest = blocks.filter((b) => b.type !== "tool_result");
        if (contentChunks(trailingRest).length > 0) foldIntoLastToolMessage(out, trailingRest);
        continue;
      }
      // Code-mode images: the results' images first (see the tool-role branch above), then the rest.
      // Trailing non-result content follows the tool messages, so nothing is inserted between a call
      // and its reply. The annotation already rode the first result.
      emitFollowUp([...toolResultFollowUpBlocks(results), ...blocks.filter((b) => b.type !== "tool_result")], messageIndex + 1);
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
export function buildChatBody(req: TurnRequest, reasoning: ReasoningPlan, descriptor: WinterModelDescriptor | undefined, replayExposedReasoning: boolean, opts: { toolResultImages?: ChatToolResultImages } = {}): Record<string, unknown> {
  const messages: unknown[] = [];
  if (req.system !== undefined && req.system.length > 0) messages.push({ role: "system", content: req.system });
  messages.push(...mapChatMessages(req.messages, replayExposedReasoning, opts));
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
      const u = usage as { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: unknown; prompt_cache_hit_tokens?: unknown; completion_tokens_details?: unknown };
      const details = u.prompt_tokens_details !== null && typeof u.prompt_tokens_details === "object" ? (u.prompt_tokens_details as { cached_tokens?: unknown }).cached_tokens : undefined;
      // DeepSeek reports its cache hits under its own name; both are the same accounting fact.
      const cached = typeof details === "number" ? details : typeof u.prompt_cache_hit_tokens === "number" ? u.prompt_cache_hit_tokens : undefined;
      // WS-24 (I-2): `completion_tokens_details.reasoning_tokens` -- the chat-completions dialect's
      // own name for the SAME fact `responses.ts`'s `output_tokens_details.reasoning_tokens` reports
      // (DeepSeek's `deepseek-reasoner` and any other row that documents it over this wire). A SUBSET
      // of `completion_tokens`, never added on top. Absent when the row omits it.
      const reasoning =
        u.completion_tokens_details !== null && typeof u.completion_tokens_details === "object"
          ? (u.completion_tokens_details as { reasoning_tokens?: unknown }).reasoning_tokens
          : undefined;
      // Review r1 finding 5: `prompt_tokens` is the TOTAL prompt (DeepSeek's hit + miss included), and
      // the cached count a subset of it -- normalized to the seam's non-cached `inputTokens`.
      events.push({
        type: "usage",
        ...normalizedPromptUsage(typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0, cached),
        outputTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
        ...(typeof reasoning === "number" ? { reasoningTokens: reasoning } : {}),
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
    const descriptor = options.descriptors?.(req.model, ctx.connection.providerId);
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
      // NO `chatgpt-account-id` (fix-wave R-FW-1 / whole-branch review I-1). It is the CODEX
      // backend's header and `codex-oauth.ts` authors it there; this adapter is the one `xai-oauth`
      // composes, so the branch that used to sit here sent another vendor's product header, holding
      // an account-scoped value, to xAI's subscription proxy. `ResolvedAuth` no longer carries an
      // `accountId` at all, so there is nothing here to author it from.
      privileged: privilegedHeaders(options),
      identity: identityFor(options, ctx),
      userSupplied: ctx.connection.headers,
    });
    url = urlFor(endpoint);
    body = JSON.stringify(buildChatBody(req, reasoning, descriptor, captureExposed, { toolResultImages: chatToolResultImagesFor(ctx.connection.providerId) }));
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
      const endpoint = resolveEndpoint(ctx, options, vendorFallbackFor(ctx));
      const auth = await resolveAuth(ctx, options.authStyle ?? "bearer");
      const headers = buildHeaders({ policy: endpoint.policy, protocol: { accept: "application/json", ...auth.headers }, privileged: privilegedHeaders(options), identity: identityFor(options, ctx), userSupplied: ctx.connection.headers });
      return validateViaModels(ref, ctx, endpoint, headers, options, auth.material !== null);
    },

    async listModels(ctx: DiscoveryContext): Promise<ModelCatalogResult> {
      const endpoint = resolveEndpoint(ctx, options, vendorFallbackFor(ctx));
      const auth = await resolveAuth(ctx, options.authStyle ?? "bearer");
      const headers = buildHeaders({ policy: endpoint.policy, protocol: { accept: "application/json", ...auth.headers }, privileged: privilegedHeaders(options), identity: identityFor(options, ctx), userSupplied: ctx.connection.headers });
      return fetchOpenAiModels(ctx, endpoint, headers, options);
    },

    streamTurn(req: TurnRequest, ctx: ProviderContext): AsyncIterable<ProviderEvent> {
      return chatTurn(req, ctx, options, vendorFallbackFor(ctx), (endpoint) => `${endpoint.baseUrl}/chat/completions`);
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
