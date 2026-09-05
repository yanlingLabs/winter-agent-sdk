// `bedrock-converse@1` — Amazon Bedrock's Converse + ConverseStream. Lane N (Task 9, R6-16).
//
// Wire field names throughout are AWS's own, taken from the public API reference (permitted: field
// names only, never vendor prose). The two operations share one request body and one content-block
// vocabulary; they differ only in how the answer arrives, which is why `streamTurn` can drive either
// and produce the identical `ProviderEvent` sequence.
//
// FIVE DECISIONS THAT SHAPE THIS FILE. Each has an obvious-looking alternative that is wrong:
//
//  1. THE REGION-DERIVED URL IS `generated: true`; `connection.baseUrl` IS ALWAYS A USER ENDPOINT.
//     Bedrock's catalog row carries `defaultEndpoints: {}` — there is literally no reviewed endpoint
//     to inherit — so the adapter knows its own vendor URL shape and builds a GENERATED policy for
//     it, while a host-supplied `baseUrl` is untrusted input and gets a USER policy unconditionally.
//     That is what makes `applyPrivilegedHeaders` a real gate rather than plumbing: point Bedrock at
//     a proxy and the account/role identifiers stop going out. (Lane A took the same shape; the
//     consequence a host must know is that a loopback fake reached through `baseUrl` needs the
//     host's own `connection.local: true`, because `evaluateEndpoint` refuses plain http otherwise.)
//
//  2. PRIVILEGED HEADERS ARE GATED BEFORE THEY ARE SIGNED, and the order is load-bearing. SigV4
//     signs the header set it is given and names it in `SignedHeaders`; gating after signing would
//     leave a header in the signature that is not on the request (an instant 403), and gating a
//     signed header away would do the same. So `applyPrivilegedHeaders` runs first and the signer
//     only ever sees what is actually going out. R6-L: SigV4's own headers (`authorization`,
//     `x-amz-date`, `x-amz-security-token`, `x-amz-content-sha256`) are AUTH/PROTOCOL headers and are
//     deliberately NOT routed through that gate — a user endpoint needs them to be reachable at all.
//
//  3. RETRY OBSERVATIONS ARE PUMPED, NOT FLUSHED. `withRetry`'s `onRetry` is synchronous and fires
//     while this generator is suspended inside `await withRetry(...)`, so an adapter cannot `yield`
//     from it. A post-hoc flush would report every retry AFTER the attempt that finally succeeded,
//     inverting capture (G)'s pinned ordering. `pumpProviderEvents` runs the work and the queue
//     concurrently so a `retry` event reaches the consumer while the backoff is still being taken.
//
//  4. `commit()` HAPPENS ON THE 2xx, BEFORE THE BODY IS TOUCHED. After it, nothing is retried —
//     including a `ThrottlingException` that arrives as an event-stream EXCEPTION FRAME rather than
//     as an HTTP status. That is Bedrock's distinctive shape and exactly the case R6-6's first-byte
//     rule exists for: the model may already have emitted a tool call, and a "retry" would be a
//     replay of an effectful turn.
//
//  5. REASONING GOES TO THE SIDECAR, AND ITS TEXT SURFACES ONLY WHERE EVIDENCE SAYS IT MAY.
//     `reasoningContent` (its text, its `signature`, its `redactedContent`) is captured whole and
//     emitted ONCE, from the completing event, as `native_state` — whose only sink is the provider-
//     state sidecar. The readable text is additionally emitted as `thinking_summary_delta` ONLY when
//     the seam asked for a summary (`TurnRequest.requestSummary`, which `adapterAsProvider` sets from
//     the descriptor's own `readableState` evidence). A signature NEVER leaves native state.

import type { ToolCalling, WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
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
import { applyPrivilegedHeaders, createEndpointPolicy, type EndpointPolicy } from "../../endpoint-policy.ts";
import { ProviderRequestError, boundedFetch } from "../../http.ts";
import { ProviderStallError, normalizeHttpError, normalizeThrown } from "../../errors.ts";
import { createRetryPolicy, withRetry, type RetryPolicyOptions } from "../../retry.ts";
import { requireRegion, resolveAwsCredentials } from "./credentials.ts";
import { createEventStreamDecoder, jsonPayload, messageType, stringHeader, type EventStreamMessage } from "./eventstream.ts";
import { BEDROCK_SERVICE, signRequest } from "./sigv4.ts";

export const BEDROCK_ADAPTER_ID = "winter.bedrock-converse";
export const BEDROCK_ADAPTER_VERSION = "1";

/** Bedrock's own default body ceiling for one response. Generous; `ctx.limits` bounds discovery separately. */
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
/** Header deadline only — a generation legitimately runs far longer, and mid-stream silence is the stall watchdog's job. */
const DEFAULT_HEADER_TIMEOUT_MS = 30_000;

/** The image formats Converse's `ImageBlock.format` admits. Anything else is refused BEFORE a request rather than 400'd upstream. */
const BEDROCK_IMAGE_FORMATS: ReadonlyMap<string, string> = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpeg"],
  ["image/jpg", "jpeg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

/** R6-E / Lane A parity: a numeric effort is a POSITION on the pinned five-tier ladder, then snapped to what the model verifies. */
const PINNED_EFFORT_LADDER = ["low", "medium", "high", "xhigh", "max"] as const;

export interface BedrockAdapterOptions {
  /**
   * The descriptor for a provider-local model id.
   *
   * A WIRING OBLIGATION, and nothing fails to compile without it: the frozen `ProviderAdapter` hands
   * a descriptor to `mapEffort` and `capabilities` but NOT to `streamTurn`, while WS-13 §8.2 requires
   * effort, thinking and limit refusals to happen BEFORE a request is sent. An adapter built without
   * this is a WEAKER adapter, not a broken one — it cannot refuse, so those selections reach Bedrock
   * instead. Both branches are pinned by fixtures.
   */
  descriptors?: (modelId: string) => WinterModelDescriptor | undefined;
  /**
   * Whether a model's answer is streamed. Default: always.
   *
   * `GetFoundationModel`/`ListFoundationModels` report `responseStreamingSupported`, and a model
   * without it must be driven through `Converse` — whose completed JSON this adapter maps into the
   * IDENTICAL `ProviderEvent` sequence, so a consumer cannot tell which operation answered.
   */
  streaming?: (modelId: string) => boolean;
  /** R6-L PRIVILEGED: cross-account confused-deputy identifiers. They name the operator's account topology and must never reach a user endpoint. */
  sourceAccount?: string;
  sourceArn?: string;
  maxBodyBytes?: number;
  timeoutMs?: number;
  retry?: RetryPolicyOptions;
  /** Injected so a fixture can pin a signature against a known-answer vector. */
  now?: () => Date;
}

// --- endpoints --------------------------------------------------------------------------------------

/** The two planes Bedrock speaks on. They are DIFFERENT ORIGINS in production, so each needs its own policy. */
function runtimeBase(ctx: ProviderContext, region: string): { url: string; generated: boolean } {
  const baseUrl = ctx.connection.baseUrl;
  if (baseUrl !== undefined && baseUrl.length > 0) return { url: baseUrl.replace(/\/+$/, ""), generated: false };
  return { url: `https://bedrock-runtime.${region}.amazonaws.com`, generated: true };
}

function controlBase(ctx: ProviderContext, region: string): { url: string; generated: boolean } {
  const baseUrl = ctx.connection.baseUrl;
  // A host that overrode the base URL overrode BOTH planes: it is pointing the adapter at one server
  // (a fake, a proxy, a gateway), and silently reaching past it to the real AWS control plane would
  // be a request the host never authorised.
  if (baseUrl !== undefined && baseUrl.length > 0) return { url: baseUrl.replace(/\/+$/, ""), generated: false };
  return { url: `https://bedrock.${region}.amazonaws.com`, generated: true };
}

function policyFor(base: { url: string; generated: boolean }, ctx: ProviderContext): EndpointPolicy {
  const built = createEndpointPolicy(base.url, { generated: base.generated, ...(ctx.connection.local !== undefined ? { local: ctx.connection.local } : {}) });
  if (!built.ok) throw new ProviderRequestError({ code: "capability", message: built.reason, retryable: false });
  return built.policy;
}

// --- errors -----------------------------------------------------------------------------------------

/**
 * Bedrock's structured error code, which `normalizeHttpError` cannot find on its own.
 *
 * The frozen normalizer reads `error.code` / `error.type` / `error.status` — the three JSON dialects
 * of the P6 cohort. Bedrock is a fourth: its REST-JSON error body is a bare `{"message": "..."}` and
 * the machine-readable value rides the `x-amzn-errortype` HEADER (or, on some paths, a `__type`
 * field). Both spellings carry a trailing namespace (`ThrottlingException:http://internal…`,
 * `com.amazon.coral#ValidationException`) that is stripped here so the code is the bare exception
 * name — which is what a consumer matches on and what the corpus asserts is preserved verbatim.
 *
 * Read off the FULL body, before any truncation, for the same reason `errors.ts` states: a cap
 * applied first slices away exactly the field a consumer wants.
 */
export function bedrockErrorCode(headers: Headers, body: string): string | undefined {
  const fromHeader = headers.get("x-amzn-errortype");
  const bare = (value: string): string | undefined => {
    const name = value.split(":")[0]?.split("#").pop()?.trim();
    return name !== undefined && name.length > 0 ? name : undefined;
  };
  if (fromHeader !== null && fromHeader.length > 0) return bare(fromHeader);
  if (body.length === 0) return undefined;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const typed = (parsed as { __type?: unknown; code?: unknown }).__type ?? (parsed as { code?: unknown }).code;
      if (typeof typed === "string" && typed.length > 0) return bare(typed);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** The five-way taxonomy from the HTTP status (the frozen normalizer's job), with Bedrock's own code layered on. */
export function normalizeBedrockError(status: number, headers: Headers, body: string): ProviderError {
  const base = normalizeHttpError(status, headers, body);
  const providerCode = bedrockErrorCode(headers, body);
  return providerCode !== undefined ? { ...base, providerCode } : base;
}

/**
 * An exception or error FRAME, which arrives after the 200 and is therefore always final.
 *
 * `retryable: false` on every arm, unconditionally, and that is R6-6 rather than pessimism: bytes
 * have been consumed, so a retry would be a REPLAY of a turn whose tool calls the caller may already
 * have executed. The status each exception maps to over HTTP is recorded in the message rather than
 * on `status`, because no HTTP status accompanied THIS failure.
 */
function exceptionFrameError(exceptionType: string, detail: string): ProviderError {
  const name = exceptionType.toLowerCase();
  const code: ProviderError["code"] = name.includes("throttling")
    ? "rate_limit"
    : name.includes("validation")
      ? "bad_request"
      : name.includes("accessdenied")
        ? "auth"
        : "server";
  return {
    code,
    message: `Bedrock stream failed with ${exceptionType}${detail.length > 0 ? `: ${detail}` : ""}`,
    providerCode: exceptionType,
    retryable: false,
  };
}

// --- request mapping --------------------------------------------------------------------------------

/** A capability refusal, raised BEFORE any request is sent. WS-13 §8.2: never a silent downgrade, never sent-and-failed-upstream. */
function refuse(message: string): ProviderRequestError {
  return new ProviderRequestError({ code: "capability", message, retryable: false });
}

type BedrockBlock = Record<string, unknown>;

function toolResultContent(content: string | ContentBlockLike[]): BedrockBlock[] {
  if (typeof content === "string") return content.length > 0 ? [{ text: content }] : [{ text: "(no output)" }];
  const out: BedrockBlock[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text.length > 0) out.push({ text: block.text });
    else if (block.type === "image") out.push(imageBlock(block));
  }
  // `ToolResultBlock.content` is REQUIRED and Bedrock rejects an empty array, so a result that
  // mapped to nothing gets an explicit marker rather than a 400 the caller cannot diagnose.
  return out.length > 0 ? out : [{ text: "(no output)" }];
}

function imageBlock(block: Extract<ContentBlockLike, { type: "image" }>): BedrockBlock {
  const format = BEDROCK_IMAGE_FORMATS.get(block.source.media_type.toLowerCase());
  if (format === undefined) {
    throw refuse(
      `Bedrock Converse accepts image formats ${[...new Set(BEDROCK_IMAGE_FORMATS.values())].join(", ")}, and this turn carries an image of media type "${block.source.media_type}"`,
    );
  }
  // `ImageSource.bytes` is a base64-encoded blob over the REST JSON surface, which is exactly what
  // the engine's own image block already holds — so it is carried across verbatim, never re-encoded.
  return { image: { format, source: { bytes: block.source.data } } };
}

/** One Winter message's content -> Bedrock content blocks. Throws a typed refusal for anything Bedrock cannot represent. */
function mapContent(message: ProviderMessageLike): BedrockBlock[] {
  const out: BedrockBlock[] = [];

  // NATIVE STATE FIRST. Bedrock wants an assistant turn's `reasoningContent` blocks ahead of the
  // text they preceded, and the items are replayed EXACTLY as the provider minted them — that is
  // what "opaque" means. They only ever reach here inside their own continuation domain: the
  // history renderer drops the annotation across a domain boundary before this code sees it.
  if (message.nativeState !== undefined) {
    for (const item of message.nativeState.items) {
      if (typeof item === "object" && item !== null) out.push(item as BedrockBlock);
    }
  }

  const content = message.content;
  if (typeof content === "string") {
    if (content.length > 0) out.push({ text: content });
  } else {
    for (const block of content) {
      switch (block.type) {
        case "text":
          // An EMPTY text block is a `ValidationException` on Bedrock and carries nothing, so it is
          // dropped rather than sent. Lossless by construction.
          if (block.text.length > 0) out.push({ text: block.text });
          break;
        case "tool_use":
          out.push({ toolUse: { toolUseId: block.id, name: block.name, input: block.input ?? {} } });
          break;
        case "tool_result": {
          const isError = (block as { is_error?: unknown }).is_error === true;
          out.push({ toolResult: { toolUseId: block.tool_use_id, content: toolResultContent(block.content), status: isError ? "error" : "success" } });
          break;
        }
        case "image":
          out.push(imageBlock(block));
          break;
        case "thinking":
        case "redacted_thinking":
          // DROPPED, deliberately, and this is the one drop worth arguing for. These are
          // ANTHROPIC-DIALECT blocks carrying a signature minted by a different endpoint; Bedrock's
          // replay channel is `reasoningContent`, reached through `nativeState`. Re-dressing a
          // foreign signed block as Bedrock reasoning would present a signature this endpoint never
          // issued — precisely the impersonation R6-8 forbids — and sending the text WITHOUT its
          // signature is what R6-7 calls degrading to summary level. So the block does not ride, and
          // a fixture asserts its signature reaches no request.
          break;
        case "tool_reference":
          // REFUSED, never dropped. A `tool_reference` tells the model a tool surface exists that it
          // has not been handed in full; Bedrock has no counterpart, and dropping it silently would
          // leave the model believing in tools no `toolConfig` declares — the shape WS-13 §9's
          // no-silent-tool-dropping rule exists to prevent.
          throw refuse(
            `this turn carries a tool_reference block naming ${block.tool_names.length} tool(s), and Bedrock Converse has no way to express a deferred tool surface; the tools must be passed in \`toolConfig\` or the reference removed`,
          );
      }
    }
  }

  // A Winter-authored ANNOTATION (Lane C's cross-family decoration) rides as PLAIN TEXT, whichever
  // door it names. Bedrock has no reasoning channel a client may write to, and putting a
  // Winter-authored note into `reasoningContent` would dress it as model reasoning — R6-8 again.
  if (message.decoration !== undefined && message.decoration.text.length > 0) out.push({ text: message.decoration.text });

  return out;
}

/**
 * Winter's message list -> Bedrock's `messages`.
 *
 * TWO SHAPE RULES BEDROCK ENFORCES AND WINTER'S UNION DOES NOT: roles are only `user` and
 * `assistant` (a `tool` message becomes a `user` message carrying `toolResult` blocks, which is
 * Bedrock's own convention), and the two must strictly ALTERNATE. Consecutive same-role messages are
 * merged by concatenating their content, which is lossless — the alternative, sending them as-is, is
 * a `ValidationException` naming nothing the caller can act on.
 */
export function toBedrockMessages(messages: readonly ProviderMessageLike[]): Array<{ role: "user" | "assistant"; content: BedrockBlock[] }> {
  const out: Array<{ role: "user" | "assistant"; content: BedrockBlock[] }> = [];
  for (const message of messages) {
    const role: "user" | "assistant" = message.role === "assistant" ? "assistant" : "user";
    const content = mapContent(message);
    // A message that mapped to nothing at all is dropped: sending an empty `content` array is a
    // `ValidationException`, and an empty message conveys nothing that merging would preserve.
    if (content.length === 0) continue;
    const last = out[out.length - 1];
    if (last !== undefined && last.role === role) last.content.push(...content);
    else out.push({ role, content });
  }
  return out;
}

function toolChoiceOf(choice: TurnRequest["toolChoice"]): BedrockBlock | undefined {
  if (choice === undefined) return undefined;
  if (choice.type === "auto") return { auto: {} };
  if (choice.type === "any") return { any: {} };
  return { tool: { name: choice.name } };
}

/** The `additionalModelRequestFields.thinking` object, or a typed refusal. `budget_tokens` is Anthropic's own spelling, passed through verbatim as `additionalModelRequestFields` is designed for. */
function thinkingFields(thinking: TurnRequest["thinking"], descriptor: WinterModelDescriptor | undefined, model: string): BedrockBlock | undefined {
  if (thinking === undefined || thinking.type === "disabled") return undefined;
  const supported = descriptor?.reasoning?.supported.value === true;
  if (!supported) {
    throw refuse(
      `a thinking configuration was requested for "${model}", whose catalog descriptor ${descriptor === undefined ? "is not available to this adapter" : "records no reasoning support"}; Winter rejects an unsupported thinking selection before sending it rather than silently dropping it (WS-13 §8.2)`,
    );
  }
  if (thinking.type === "enabled" && thinking.budgetTokens !== undefined) return { type: "enabled", budget_tokens: thinking.budgetTokens };
  // R6-E: an adapter MAY re-resolve `enabled` -> `adaptive`. Here it MUST: Converse's `enabled` arm
  // requires a budget, and inventing one would send a number the caller never chose.
  return { type: "adaptive" };
}

export interface BedrockRequestBody {
  messages: Array<{ role: string; content: BedrockBlock[] }>;
  system?: Array<{ text: string }>;
  inferenceConfig?: BedrockBlock;
  toolConfig?: BedrockBlock;
  additionalModelRequestFields?: BedrockBlock;
}

/** Builds the shared Converse/ConverseStream body. Every refusal this can raise happens before a socket is opened. */
export function buildConverseBody(req: TurnRequest, descriptor: WinterModelDescriptor | undefined, mappedEffort: string | undefined): BedrockRequestBody {
  const tools = req.tools ?? [];
  if (tools.length > 0) {
    const toolCalling: ToolCalling | undefined = descriptor?.toolCalling.value;
    if (descriptor !== undefined && toolCalling !== "native") {
      throw refuse(
        `this turn declares ${tools.length} tool(s) but "${req.model}"'s catalog descriptor records tool calling as "${toolCalling}"; Winter refuses the turn rather than sending it as plain chat (WS-13 §8.1)`,
      );
    }
  }

  const maxOutput = descriptor?.maxOutputTokens?.value;
  if (req.maxOutputTokens !== undefined && maxOutput !== undefined && req.maxOutputTokens > maxOutput) {
    throw refuse(`this turn asks for ${req.maxOutputTokens} output tokens and "${req.model}" declares a maximum of ${maxOutput}`);
  }

  const thinking = thinkingFields(req.thinking, descriptor, req.model);
  const additional: BedrockBlock = {
    ...(thinking !== undefined ? { thinking } : {}),
    ...(mappedEffort !== undefined ? { effort: mappedEffort } : {}),
  };
  const toolChoice = toolChoiceOf(req.toolChoice);

  return {
    messages: toBedrockMessages(req.messages),
    ...(req.system !== undefined && req.system.length > 0 ? { system: [{ text: req.system }] } : {}),
    ...(req.maxOutputTokens !== undefined ? { inferenceConfig: { maxTokens: req.maxOutputTokens } } : {}),
    ...(tools.length > 0
      ? {
          toolConfig: {
            tools: tools.map((tool) => ({ toolSpec: { name: tool.name, description: tool.description, inputSchema: { json: tool.inputSchema } } })),
            ...(toolChoice !== undefined ? { toolChoice } : {}),
          },
        }
      : {}),
    ...(Object.keys(additional).length > 0 ? { additionalModelRequestFields: additional } : {}),
  };
}

// --- the stall-bounded byte reader --------------------------------------------------------------------

/**
 * Races one read against the stall deadline and the caller's abort.
 *
 * A near-twin of `sse.ts`'s own private helper, and duplicated rather than shared because that
 * module is FROZEN and does not export it — a two-line export would be a spine edit, which R6-12
 * forbids a lane from making. The behaviour is deliberately identical: the timer is created and
 * cleared PER READ, so the deadline is "silence since the last byte" rather than "elapsed since the
 * stream opened", and a long steady generation cannot trip it.
 */
async function readWithStall<T>(read: Promise<T>, stallTimeoutMs: number, signal: AbortSignal | undefined): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProviderStallError(`Bedrock stream produced no bytes for ${stallTimeoutMs}ms`)), stallTimeoutMs);
        if (signal !== undefined) {
          onAbort = () => {
            const err = new Error("Bedrock stream aborted by the caller");
            err.name = "AbortError";
            reject(err);
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Runs `work` while draining the events it emits, CONCURRENTLY.
 *
 * See decision 3 in the file header. `withRetry`'s callback is synchronous and fires while this
 * generator is suspended awaiting it, so the queue is the only way an observation can reach the
 * consumer at the moment it happens rather than after the work finishes.
 */
async function* pumpProviderEvents<T>(work: (emit: (event: ProviderEvent) => void) => Promise<T>): AsyncGenerator<ProviderEvent, T> {
  const queue: ProviderEvent[] = [];
  let wake: (() => void) | undefined;
  const ring = (): void => {
    const w = wake;
    wake = undefined;
    w?.();
  };
  const emit = (event: ProviderEvent): void => {
    queue.push(event);
    ring();
  };
  let settled: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  // The rejection is CAPTURED rather than left floating: an unhandled rejection here would be
  // attributed to whichever test happens to be running when it lands.
  const running = work(emit).then(
    (value) => {
      settled = { ok: true, value };
      ring();
    },
    (error: unknown) => {
      settled = { ok: false, error };
      ring();
    },
  );
  for (;;) {
    while (queue.length > 0) yield queue.shift()!;
    if (settled !== undefined) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
  await running;
  if (!settled.ok) throw settled.error;
  return settled.value;
}

// --- the stream mapping ------------------------------------------------------------------------------

/** One accumulating reasoning block. `signature` and `redactedContent` are opaque and never leave `native_state`. */
interface ReasoningAccumulator {
  text: string;
  signature: string;
  redactedContent: string;
}

/**
 * The ConverseStream event mapping, as a fold over decoded frames.
 *
 * Written as a class-free state object driven by `handleFrame` so the SAME mapping serves the
 * non-streaming `Converse` path: that operation's completed JSON is replayed through these very
 * handlers, which is what makes "a consumer cannot tell which operation answered" a property of the
 * code rather than a claim.
 */
class ConverseFold {
  private readonly tools = new Map<number, { id: string; name: string }>();
  private readonly reasoning = new Map<number, ReasoningAccumulator>();
  private stop: "end_turn" | "tool_use" | "max_tokens" | "aborted" | "refusal" | undefined;
  sawMessageStop = false;

  constructor(private readonly wantsSummary: boolean) {}

  /** Bedrock's nine stop reasons -> Winter's five. `stop_sequence` is an ordinary end of turn; the two guardrail outcomes are refusals. */
  private static mapStopReason(raw: unknown): "end_turn" | "tool_use" | "max_tokens" | "refusal" {
    switch (raw) {
      case "tool_use":
        return "tool_use";
      case "max_tokens":
      case "model_context_window_exceeded":
        return "max_tokens";
      case "guardrail_intervened":
      case "content_filtered":
        return "refusal";
      // `stop_sequence` ended the turn normally — the model produced a stop string it was given.
      // `malformed_model_output` / `malformed_tool_use` are ends of turn whose CONTENT is suspect;
      // reporting them as refusals would tell a caller the model declined, which it did not.
      default:
        return "end_turn";
    }
  }

  /** Handles one decoded event payload, returning the `ProviderEvent`s it produces, in order. */
  handle(eventType: string, payload: Record<string, unknown>, model: string): ProviderEvent[] {
    const out: ProviderEvent[] = [];
    switch (eventType) {
      case "messageStart":
        out.push({ type: "message_start", model });
        break;

      case "contentBlockStart": {
        const index = typeof payload.contentBlockIndex === "number" ? payload.contentBlockIndex : 0;
        const start = payload.start as { toolUse?: { toolUseId?: unknown; name?: unknown } } | undefined;
        const toolUse = start?.toolUse;
        if (toolUse !== undefined && typeof toolUse.toolUseId === "string" && typeof toolUse.name === "string") {
          this.tools.set(index, { id: toolUse.toolUseId, name: toolUse.name });
          out.push({ type: "tool_call_start", id: toolUse.toolUseId, name: toolUse.name });
        }
        break;
      }

      case "contentBlockDelta": {
        const index = typeof payload.contentBlockIndex === "number" ? payload.contentBlockIndex : 0;
        const delta = payload.delta as { text?: unknown; toolUse?: { input?: unknown }; reasoningContent?: { text?: unknown; signature?: unknown; redactedContent?: unknown } } | undefined;
        if (delta === undefined) break;
        if (typeof delta.text === "string") out.push({ type: "text_delta", text: delta.text });
        if (delta.toolUse !== undefined && typeof delta.toolUse.input === "string") {
          const tool = this.tools.get(index);
          // A delta for a block whose start was never seen is DROPPED rather than invented: a
          // fabricated tool id would reach the engine as a call the model never made.
          if (tool !== undefined) out.push({ type: "tool_call_delta", id: tool.id, argumentsJsonDelta: delta.toolUse.input });
        }
        if (delta.reasoningContent !== undefined) {
          const acc = this.reasoning.get(index) ?? { text: "", signature: "", redactedContent: "" };
          if (typeof delta.reasoningContent.text === "string") {
            acc.text += delta.reasoningContent.text;
            // Gated on the SEAM's own request, which `adapterAsProvider` sets from the descriptor's
            // `readableState` evidence. Without it, reasoning text reaches the sidecar and nothing
            // else — surfacing it would be a claim about the model that no evidence supports.
            if (this.wantsSummary) out.push({ type: "thinking_summary_delta", text: delta.reasoningContent.text });
          }
          // NEVER emitted as an event, in either case: a signature is replay material and
          // `redactedContent` is encrypted by the provider. Both reach `native_state` alone.
          if (typeof delta.reasoningContent.signature === "string") acc.signature += delta.reasoningContent.signature;
          if (typeof delta.reasoningContent.redactedContent === "string") acc.redactedContent += delta.reasoningContent.redactedContent;
          this.reasoning.set(index, acc);
        }
        break;
      }

      case "contentBlockStop": {
        const index = typeof payload.contentBlockIndex === "number" ? payload.contentBlockIndex : 0;
        const tool = this.tools.get(index);
        if (tool !== undefined) out.push({ type: "tool_call_end", id: tool.id });
        break;
      }

      case "messageStop": {
        this.sawMessageStop = true;
        this.stop = ConverseFold.mapStopReason(payload.stopReason);
        // THE COMPLETING EVENT, and the only place native state is captured. An earlier copy would
        // persist a continuation object the provider had not finished minting, and the failure would
        // surface on the NEXT turn rather than here.
        const items = this.nativeStateItems();
        if (items.length > 0) out.push({ type: "native_state", items });
        break;
      }

      case "metadata": {
        const usage = payload.usage as { inputTokens?: unknown; outputTokens?: unknown; cacheReadInputTokens?: unknown; cacheWriteInputTokens?: unknown } | undefined;
        if (usage !== undefined) {
          out.push({
            type: "usage",
            inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : 0,
            outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : 0,
            ...(typeof usage.cacheReadInputTokens === "number" ? { cacheReadTokens: usage.cacheReadInputTokens } : {}),
            ...(typeof usage.cacheWriteInputTokens === "number" ? { cacheWriteTokens: usage.cacheWriteInputTokens } : {}),
          });
        }
        break;
      }

      default:
        // An event type this adapter does not map (`citation`, a future arm) is IGNORED rather than
        // fatal: the stream is still well-formed and the turn is still real.
        break;
    }
    return out;
  }

  /** The complete replay object: Bedrock's own `reasoningContent` blocks, in block order, exactly as they were minted. */
  private nativeStateItems(): unknown[] {
    return [...this.reasoning.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, acc]) =>
        acc.redactedContent.length > 0
          ? { reasoningContent: { redactedContent: acc.redactedContent } }
          : { reasoningContent: { reasoningText: { text: acc.text, signature: acc.signature } } },
      );
  }

  /** The turn's terminating event. `end_turn` is the honest default for a stream that produced content and stopped. */
  done(): ProviderEvent {
    return { type: "done", stopReason: this.stop ?? "end_turn" };
  }
}

// --- the adapter --------------------------------------------------------------------------------------

/**
 * WS-13 §8.2: map onto the model's VERIFIED vocabulary, or refuse BEFORE a request is sent.
 *
 * Standalone rather than a method so `streamTurn`'s pre-request check and the frozen
 * `ProviderAdapter.mapEffort` seam are provably the SAME rule — a second copy is exactly how an
 * adapter comes to refuse a selection at one door and send it at another.
 */
export function mapBedrockEffort(effort: TurnRequest["effort"], model: WinterModelDescriptor): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (effort === undefined) return { ok: true, value: undefined };
  const verified = model.reasoning?.efforts ?? [];
  if (verified.length === 0) {
    return { ok: false, reason: `"${model.key}" records no verified effort vocabulary, so an effort selection cannot be mapped onto it — Winter refuses rather than sending the provider's default (WS-13 §8.2)` };
  }
  if (typeof effort === "string") {
    if (verified.includes(effort)) return { ok: true, value: effort };
    return { ok: false, reason: `"${model.key}" verifies efforts [${verified.join(", ")}] and does not accept "${effort}"` };
  }
  // R6-E gap-filling, identical to Lane A's rule so a numeric child effort means the same thing
  // whichever family serves it: a POSITION on the pinned five-tier ladder (1 = low … 5 = max),
  // clamped, then snapped DOWN to the nearest tier this model actually verifies.
  const position = Math.min(PINNED_EFFORT_LADDER.length, Math.max(1, Math.round(effort)));
  for (let i = position - 1; i >= 0; i--) {
    const tier = PINNED_EFFORT_LADDER[i]!;
    if (verified.includes(tier)) return { ok: true, value: tier };
  }
  for (const tier of PINNED_EFFORT_LADDER) if (verified.includes(tier)) return { ok: true, value: tier };
  return { ok: false, reason: `"${model.key}" verifies efforts [${verified.join(", ")}], none of which is on the pinned five-tier ladder, so a numeric effort cannot be snapped onto it` };
}

export interface BedrockAdapter extends ProviderAdapter {
  /** The raw `ListFoundationModels` rows, including `responseStreamingSupported` — the input a host needs to build `BedrockAdapterOptions.streaming`. */
  listFoundationModels(ctx: DiscoveryContext): Promise<Array<{ modelId: string; modelName?: string; inputModalities?: string[]; responseStreamingSupported?: boolean }>>;
}

export function createBedrockConverseAdapter(options: BedrockAdapterOptions = {}): BedrockAdapter {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const streamingFor = options.streaming ?? ((): boolean => true);

  /**
   * Builds and signs one request.
   *
   * The privileged gate runs BEFORE the signer — decision 2 in the file header.
   */
  async function signedRequest(
    ctx: ProviderContext,
    policy: EndpointPolicy,
    method: string,
    url: string,
    body: Uint8Array,
    region: string,
    contentType?: string,
  ): Promise<Record<string, string>> {
    const credentials = await resolveAwsCredentials(ctx);
    const privileged = applyPrivilegedHeaders(policy, {
      ...(options.sourceAccount !== undefined ? { "x-amz-source-account": options.sourceAccount } : {}),
      ...(options.sourceArn !== undefined ? { "x-amz-source-arn": options.sourceArn } : {}),
    });
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(contentType !== undefined ? { "content-type": contentType } : {}),
      // The host's own extra headers ride BEFORE the privileged set and the signed set, so neither
      // can be overwritten by a connection profile.
      ...(ctx.connection.headers ?? {}),
      ...privileged,
    };
    const signed = await signRequest({ method, url, headers, body, credentials, region, service: BEDROCK_SERVICE, date: now() });
    return { ...headers, ...signed.headers };
  }

  async function callControlPlane(ctx: DiscoveryContext, path: string): Promise<Response> {
    const region = requireRegion(ctx);
    const base = controlBase(ctx, region);
    const policy = policyFor(base, ctx);
    const url = `${base.url}${path}`;
    const headers = await signedRequest(ctx, policy, "GET", url, new Uint8Array(0), region);
    return await boundedFetch(url, {
      method: "GET",
      headers,
      timeoutMs: Math.min(timeoutMs, ctx.limits.timeoutMs),
      maxBodyBytes: Math.min(maxBodyBytes, ctx.limits.maxBytes),
      policy,
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });
  }

  async function foundationModels(ctx: DiscoveryContext): Promise<Array<{ modelId: string; modelName?: string; inputModalities?: string[]; responseStreamingSupported?: boolean }>> {
    const response = await callControlPlane(ctx, "/foundation-models");
    const text = await response.text();
    if (!response.ok) throw new ProviderRequestError(normalizeBedrockError(response.status, response.headers, text));
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new ProviderRequestError({ code: "bad_request", message: "Bedrock's ListFoundationModels response was not JSON", status: response.status, retryable: false });
    }
    const summaries = (parsed as { modelSummaries?: unknown }).modelSummaries;
    if (!Array.isArray(summaries)) return [];
    // Row shape is checked but NOT sanitized here: `discoverModels` owns the id/name/limits
    // validation for every family, and a second, weaker copy of it is exactly what R6-11's
    // "one classifier, one fixture set" reasoning warns against.
    return summaries.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null).map((row) => ({
      modelId: typeof row.modelId === "string" ? row.modelId : "",
      ...(typeof row.modelName === "string" ? { modelName: row.modelName } : {}),
      ...(Array.isArray(row.inputModalities) ? { inputModalities: row.inputModalities.filter((m): m is string => typeof m === "string").map((m) => m.toLowerCase()) } : {}),
      ...(typeof row.responseStreamingSupported === "boolean" ? { responseStreamingSupported: row.responseStreamingSupported } : {}),
    }));
  }

  return {
    id: BEDROCK_ADAPTER_ID,
    version: BEDROCK_ADAPTER_VERSION,
    family: "bedrock",
    protocol: "bedrock-converse",

    async validateCredential(ref: CredentialRef, ctx: ProviderContext): Promise<CredentialStatus> {
      // Goes through the SAME control-plane path a real discovery uses, so a URL that the service
      // rejects cannot make a valid credential report as unreachable (Lane A's Azure defect, which
      // shipped precisely because `validateCredential` had its own unexercised URL builder).
      const discoveryCtx: DiscoveryContext = { ...ctx, authRef: ref, limits: { maxBytes: 1024 * 1024, maxItems: 1000, timeoutMs: timeoutMs } };
      try {
        await foundationModels(discoveryCtx);
        return { ok: true };
      } catch (err) {
        const normalized = normalizeThrown(err);
        if (normalized.code === "auth") return { ok: false, code: "invalid", message: normalized.message };
        if (normalized.code === "capability") return { ok: false, code: "missing", message: normalized.message };
        return { ok: false, code: "network", message: normalized.message };
      }
    },

    async listModels(ctx: DiscoveryContext): Promise<ModelCatalogResult> {
      const rows = await foundationModels(ctx);
      return {
        models: rows.map((row) => ({
          id: row.modelId,
          ...(row.modelName !== undefined ? { displayName: row.modelName } : {}),
          ...(row.inputModalities !== undefined ? { inputModalities: row.inputModalities } : {}),
        })),
        // ListFoundationModels returns the account's whole visible inventory in one answer, so a
        // truncation can only come from the bounds layer above — which sets `partial` itself.
        partial: false,
        cached: false,
        warnings: [],
      };
    },

    listFoundationModels: foundationModels,

    streamTurn(req: TurnRequest, ctx: ProviderContext): AsyncIterable<ProviderEvent> {
      return streamBedrockTurn(req, ctx, { maxBodyBytes, timeoutMs, streamingFor, signedRequest, options });
    },

    mapEffort: mapBedrockEffort,

    capabilities(model: WinterModelDescriptor): { toolCalling: ToolCalling; continuationDomain?: string; readableState: "none" | "summary" | "full-exposed" } {
      const reasoning = model.reasoning;
      // The registry's own rule, restated over the same data so an adapter and the registry cannot
      // disagree about which models may replay each other's continuation objects.
      const members = reasoning?.continuationDomain?.value;
      const domain = reasoning === undefined || reasoning.continuation === "none" ? undefined : members !== undefined && members.length > 0 ? [...members].sort()[0] : model.key;
      return {
        toolCalling: model.toolCalling.value,
        ...(domain !== undefined ? { continuationDomain: domain } : {}),
        readableState: reasoning?.readableState?.value ?? "none",
      };
    },
  };
}

// --- the turn ------------------------------------------------------------------------------------------

interface TurnDeps {
  maxBodyBytes: number;
  timeoutMs: number;
  streamingFor: (modelId: string) => boolean;
  signedRequest: (ctx: ProviderContext, policy: EndpointPolicy, method: string, url: string, body: Uint8Array, region: string, contentType?: string) => Promise<Record<string, string>>;
  options: BedrockAdapterOptions;
}

async function* streamBedrockTurn(req: TurnRequest, ctx: ProviderContext, deps: TurnDeps): AsyncGenerator<ProviderEvent> {
  const region = requireRegion(ctx);
  const descriptor = deps.options.descriptors?.(req.model);

  // EVERY CAPABILITY REFUSAL HAPPENS HERE, before a socket exists. A fixture proves each one by
  // asserting the fake's request count did not change — the only form of the claim an adapter
  // cannot satisfy by sending the request and ignoring the answer.
  let mappedEffort: string | undefined;
  if (req.effort !== undefined) {
    if (descriptor === undefined) {
      throw new ProviderRequestError({
        code: "capability",
        message: `an effort was requested for "${req.model}", but no catalog descriptor is available to this adapter, so it cannot be mapped onto a verified vocabulary`,
        retryable: false,
      });
    }
    const mapped = mapBedrockEffort(req.effort, descriptor);
    if (!mapped.ok) throw new ProviderRequestError({ code: "capability", message: mapped.reason, retryable: false });
    mappedEffort = typeof mapped.value === "string" ? mapped.value : undefined;
  }

  const body = new TextEncoder().encode(JSON.stringify(buildConverseBody(req, descriptor, mappedEffort)));

  const base = runtimeBase(ctx, region);
  const policy = policyFor(base, ctx);
  const streaming = deps.streamingFor(req.model);
  const url = `${base.url}/model/${encodeURIComponent(req.model)}/${streaming ? "converse-stream" : "converse"}`;
  const retryPolicy = createRetryPolicy(deps.options.retry ?? {});

  const fold = new ConverseFold(req.requestSummary === true);
  // An internal controller so an ABANDONED generator (the consumer breaks out of the loop) tears the
  // request down rather than leaving a socket draining in the background.
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort();
  if (req.signal !== undefined) {
    if (req.signal.aborted) {
      const err = new Error("Bedrock turn aborted by the caller");
      err.name = "AbortError";
      throw err;
    }
    req.signal.addEventListener("abort", forwardAbort, { once: true });
  }

  try {
    const response = yield* pumpProviderEvents<Response>(async (emit) =>
      withRetry(
        async () => {
          const headers = await deps.signedRequest(ctx, policy, "POST", url, body, region, "application/json");
          const res = await boundedFetch(url, {
            method: "POST",
            headers,
            body,
            timeoutMs: deps.timeoutMs,
            maxBodyBytes: deps.maxBodyBytes,
            policy,
            signal: controller.signal,
          });
          if (!res.ok) {
            const text = await res.text();
            throw new ProviderRequestError(normalizeBedrockError(res.status, res.headers, text));
          }
          // THE COMMIT POINT. Everything after this is final — including an exception FRAME, which
          // is Bedrock's way of reporting a throttle that began after the 200.
          retryPolicy.commit();
          return res;
        },
        retryPolicy,
        emit,
        controller.signal,
      ),
    );

    ctx.log({ kind: "provider.request", providerId: ctx.connection.providerId, model: req.model, bytes: body.byteLength });

    if (!streaming) {
      // NON-STREAMING `Converse`: the completed JSON is replayed through the SAME fold, in the same
      // order the stream would have produced, so a consumer cannot tell which operation answered.
      const text = await response.text();
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        yield { type: "error", error: { code: "bad_request", message: "Bedrock's Converse response was not JSON", status: 200, retryable: false } };
        return;
      }
      yield* replayConverseResponse(parsed, fold, req.model);
      yield fold.done();
      return;
    }

    if (response.body === null) {
      yield { type: "error", error: { code: "network", message: "Bedrock answered the stream request with no body", retryable: false } };
      return;
    }

    const reader = response.body.getReader();
    const decoder = createEventStreamDecoder();
    try {
      for (;;) {
        const chunk = await readWithStall(reader.read(), ctx.stallTimeoutMs, controller.signal);
        if (chunk.done) break;
        ctx.log({ kind: "provider.stream", providerId: ctx.connection.providerId, model: req.model, bytes: chunk.value.byteLength });
        let messages: EventStreamMessage[];
        try {
          messages = decoder.push(chunk.value);
        } catch (err) {
          // A malformed frame (a CRC mismatch, an impossible length) is a provider failure, not a
          // transport one, and it is final: bytes were consumed.
          yield { type: "error", error: { code: "bad_request", message: err instanceof Error ? err.message : String(err), retryable: false } };
          return;
        }
        for (const message of messages) {
          const kind = messageType(message);
          if (kind !== "event") {
            const exceptionType = stringHeader(message, ":exception-type") ?? stringHeader(message, ":error-code") ?? "UnknownException";
            const detail = (jsonPayload(message)?.message as string | undefined) ?? stringHeader(message, ":error-message") ?? "";
            yield { type: "error", error: exceptionFrameError(exceptionType, detail) };
            return;
          }
          const payload = jsonPayload(message);
          if (payload === undefined) {
            yield { type: "error", error: { code: "bad_request", message: "a Bedrock stream frame carried a payload that is not a JSON object", retryable: false } };
            return;
          }
          const eventType = stringHeader(message, ":event-type") ?? "";
          for (const event of fold.handle(eventType, payload, req.model)) yield event;
        }
      }
    } finally {
      void reader.cancel().catch(() => {});
    }

    if (!fold.sawMessageStop) {
      // A TRUNCATED stream: the connection ended before the turn did. `network`, with NO status
      // (absent, not null — the case `api_retry.error_status: number | null` describes), and NOT
      // retryable, because bytes were consumed (R6-6).
      yield {
        type: "error",
        error: { code: "network", message: `the Bedrock stream ended before its messageStop event${decoder.pending() > 0 ? ` (${decoder.pending()} bytes of a partial frame were held)` : ""}`, retryable: false },
      };
      return;
    }
    yield fold.done();
  } catch (err) {
    // A caller abort is a `done` with `aborted`, not an error: the caller stopped this, and
    // reporting it as a provider failure would put a red frame in front of a user who pressed stop.
    const normalized = normalizeThrown(err);
    if (normalized.code === "aborted") {
      yield { type: "done", stopReason: "aborted" };
      return;
    }
    yield { type: "error", error: normalized };
  } finally {
    if (req.signal !== undefined) req.signal.removeEventListener("abort", forwardAbort);
    controller.abort();
  }
}

/** The non-streaming answer, replayed through the streaming fold's own handlers. */
function* replayConverseResponse(parsed: Record<string, unknown>, fold: ConverseFold, model: string): Generator<ProviderEvent> {
  const output = parsed.output as { message?: { content?: unknown } } | undefined;
  const content = Array.isArray(output?.message?.content) ? (output.message.content as Array<Record<string, unknown>>) : [];
  yield* fold.handle("messageStart", { role: "assistant" }, model);
  let index = 0;
  for (const block of content) {
    if (typeof block.text === "string") {
      yield* fold.handle("contentBlockDelta", { contentBlockIndex: index, delta: { text: block.text } }, model);
    } else if (block.toolUse !== undefined) {
      const toolUse = block.toolUse as { toolUseId?: unknown; name?: unknown; input?: unknown };
      yield* fold.handle("contentBlockStart", { contentBlockIndex: index, start: { toolUse: { toolUseId: toolUse.toolUseId, name: toolUse.name } } }, model);
      yield* fold.handle("contentBlockDelta", { contentBlockIndex: index, delta: { toolUse: { input: JSON.stringify(toolUse.input ?? {}) } } }, model);
      yield* fold.handle("contentBlockStop", { contentBlockIndex: index }, model);
    } else if (block.reasoningContent !== undefined) {
      const reasoning = block.reasoningContent as { reasoningText?: { text?: unknown; signature?: unknown }; redactedContent?: unknown };
      const delta: Record<string, unknown> = {};
      if (typeof reasoning.reasoningText?.text === "string") delta.text = reasoning.reasoningText.text;
      if (typeof reasoning.reasoningText?.signature === "string") delta.signature = reasoning.reasoningText.signature;
      if (typeof reasoning.redactedContent === "string") delta.redactedContent = reasoning.redactedContent;
      yield* fold.handle("contentBlockDelta", { contentBlockIndex: index, delta: { reasoningContent: delta } }, model);
    }
    index++;
  }
  if (parsed.usage !== undefined) yield* fold.handle("metadata", { usage: parsed.usage }, model);
  yield* fold.handle("messageStop", { stopReason: parsed.stopReason }, model);
}
