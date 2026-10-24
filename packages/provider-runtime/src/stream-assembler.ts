// 0.0.56 (W8): THE STREAM ASSEMBLER -- an adapter's `AsyncIterable<ProviderEvent>` folded into ONE turn.
//
// MOVED HERE from the runtime's `provider/bridge.ts` (`foldProviderStream`, `stampNativeState`), so a
// host that drives `streamTurn` itself -- its own agent loop, in-process, under Node -- assembles a turn
// with the SAME code the Winter engine does. The runtime now imports this module; there is one copy.
// What stayed in the bridge is only what is the ENGINE's: its `ProviderTurnError` (the runtime maps
// this module's failures onto it through `AssembleOptions.errors`), its sink type, and the adapter
// wrapper. Nothing here imports the runtime (R6-4).
//
// WHAT THE ASSEMBLER IS RESPONSIBLE FOR, stated as obligations rather than steps (carried from the
// bridge's own header, unchanged):
//
//   1. **Opaque state reaches the turn's `nativeState` and nowhere else.** `native_state` items are
//      carried on `AssembledTurn.nativeState` and are NEVER forwarded as a stream event, never logged,
//      never placed in an error message. A `thinking_summary_delta` is FOREIGN reasoning: it goes to
//      `sink.onReasoningSummary` and onto `turn.thinking.summary`, never into the content (R6-8). Its
//      live twin, `reasoning_progress` (0.0.47), goes to `sink.onReasoningProgress` and nowhere else.
//   2. **In-dialect thinking rides in-dialect.** `native_thinking_block` carries a COMPLETE
//      Anthropic-family block with its REAL signature; it becomes a content block persisted verbatim,
//      because that signature is replay-critical.
//   3. **No retry past the first byte.** This fold never retries anything. Retry is `withRetry`'s job
//      inside the adapter, strictly before the stream begins.
//   4. **Errors are typed and redacted.** Everything that goes wrong becomes one typed failure carrying
//      the provider's status and structured code and whether the stream had begun (`committed`) --
//      never a raw body, never credential material, never opaque state.
import { randomUUID } from "node:crypto";
import { normalizeThrown } from "./errors.ts";
import type { ContentBlockLike, MessageOrigin, ProviderError, ProviderEvent, ProviderMessageLike, ProviderNativeState, ReasoningProgressKind, SdkAssistantMessageError } from "./types.ts";

// --- the result -------------------------------------------------------------------------------------

/** The content blocks an assembled turn can carry: text, tool calls and in-dialect reasoning blocks. */
export type AssembledContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

/** Why the provider stopped -- the `done` event's own vocabulary. */
export type AssembledStopReason = Extract<ProviderEvent, { type: "done" }>["stopReason"];

/** The turn's usage, in the seam's one convention (`inputTokens` is the NON-cached prompt). */
export interface AssembledUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWrite1hTokens?: number;
  cacheMiss?: { type: string; missedInputTokens?: number };
  thinkingBlocksDropped?: number;
  reasoningTokens?: number;
  /** 0.0.56 (W5): the provider's own reported cost in USD (OpenRouter's `usage.cost`), when it reported one. */
  reportedCostUsd?: number;
}

/** What a turn reports about its own reasoning. `blocks` are in-dialect (Anthropic-family) and complete; `summary`/`exposed` are foreign and never enter the content. */
export interface AssembledThinking {
  summary?: string;
  exposed?: string;
  /** True iff `exposed` is the WHOLE reasoning trace for the turn: a normal stop (`end_turn`/`tool_use`). Meaningless without `exposed`. */
  exposedComplete?: boolean;
  blocks?: AssembledContentBlock[];
}

interface AssembledCommon {
  usage?: AssembledUsage;
  stopReason?: AssembledStopReason;
  stopDetails?: { category: string | null; explanation: string | null };
  thinking?: AssembledThinking;
  /** Opaque continuation state, as the adapter captured it. Its `family`/`continuationDomain` are BLANK until `stampNativeState`. */
  nativeState?: ProviderNativeState;
  /** The turn's content IN STREAM ORDER (thinking, text and calls interleaved as produced). Absent for an empty turn. */
  content?: AssembledContentBlock[];
  /** The provider's own id for this response. */
  responseId?: string;
}

/**
 * One assembled turn. A turn with CALLS is a `tool_use` turn even when it also produced text, and the
 * text rides along on `text?` rather than being dropped.
 */
export type AssembledTurn = ({ kind: "text"; text: string } & AssembledCommon) | ({ kind: "tool_use"; calls: Array<{ id: string; name: string; input: unknown }>; text?: string } & AssembledCommon);

// --- the sink ---------------------------------------------------------------------------------------

/**
 * The six raw stream events the assembler emits on `onStreamEvent` -- the Anthropic Messages streaming
 * shape every Winter host already renders (`message_start`, `content_block_start`/`_delta`/`_stop`,
 * `message_delta`, `message_stop`). Reasoning blocks are emitted WITHOUT their attestation (`signature:
 * ""`, `data: ""`): no host reads those bytes.
 */
export type AssemblerStreamEvent =
  | { type: "message_start"; message: { id?: string; model?: string; role: "assistant"; content: [] } }
  | { type: "content_block_start"; index: number; content_block: { type: "text"; text: "" } | { type: "thinking"; thinking: ""; signature: "" } | { type: "redacted_thinking"; data: "" } | { type: "tool_use"; id: string; name: string; input: Record<string, never> } }
  | { type: "content_block_delta"; index: number; delta: { type: "text_delta"; text: string } | { type: "thinking_delta"; thinking: string } | { type: "input_json_delta"; partial_json: string } }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason: AssembledStopReason } }
  | { type: "message_stop" };

/** One live step of one reasoning block. `blockId` is a fresh UUID per block; every `start` gets exactly one `end`. Never carries opaque material. */
export interface AssembledReasoningProgress {
  blockId: string;
  phase: "start" | "delta" | "end";
  kind: ReasoningProgressKind;
  text?: string;
  part?: number;
}

/**
 * Where a host watches a turn LIVE -- every method optional.
 *
 * A THROWING method ends the turn: the throw becomes the assembler's failure (mapped like any other
 * throw, `committed` as the stream was), which is how a host stops consuming early -- an SSE client that
 * went away, a UI that was closed. The one exception is `onReasoningProgress`, which is observation
 * only: a throw there is dropped. (The Winter engine relies on exactly this split.)
 *
 * `onTextDelta` is the simplest door for a host that forwards the answer as it streams (an SSE
 * endpoint, a chat UI): it receives exactly the `text_delta` text, in order, and nothing else.
 * `onStreamEvent` is the full block-indexed stream for a host that renders reasoning blocks and tool
 * calls too.
 */
export interface StreamAssemblySink {
  onTextDelta?(text: string): void;
  onStreamEvent?(event: AssemblerStreamEvent): void;
  onRetry?(info: { attempt: number; maxRetries: number; retryDelayMs: number; errorStatus?: number; error: SdkAssistantMessageError }): void;
  onRateLimit?(info: { kind: "subscription-quota"; info: Record<string, unknown> }): void;
  onAuthStatus?(info: { isAuthenticating: boolean; output?: string[]; error?: string }): void;
  /** The COMPLETE foreign reasoning summary, once, at the end of the turn. */
  onReasoningSummary?(text: string): void;
  onReasoningProgress?(progress: AssembledReasoningProgress): void;
}

// --- failures ---------------------------------------------------------------------------------------

/** The longest a provider's own message may be in a `ProviderStreamError`. A provider error body can be arbitrarily long, and this string reaches a log. */
export const MAX_STREAM_ERROR_MESSAGE_CHARS = 400;

const STREAM_ERROR_BRAND = Symbol.for("@yanlinglabs/winter-provider-runtime:ProviderStreamError");

/**
 * The assembler's default failure: the normalized `ProviderError` and whether the stream had begun.
 *
 * `committed` is the first-byte rule: `false` means nothing reached the host and nothing ran, so a host
 * may retry or fall back; `true` means the turn had started and a retry would replay it. A context or
 * image overflow the stream reported before producing anything is NOT committed (the request can be
 * compacted and sent again).
 *
 * The ORIGINAL throw is never attached as `cause`: an adapter's throw can carry a request, a body or a
 * header map. Only the bounded message travels.
 */
export class ProviderStreamError extends Error {
  readonly error: ProviderError;
  readonly committed: boolean;
  constructor(error: ProviderError, committed: boolean) {
    const message = error.message.length > MAX_STREAM_ERROR_MESSAGE_CHARS ? `${error.message.slice(0, MAX_STREAM_ERROR_MESSAGE_CHARS)}...` : error.message;
    super(`provider request failed (${error.code}): ${message}`);
    this.name = "ProviderStreamError";
    this.error = { ...error, message };
    this.committed = committed;
    Object.defineProperty(this, STREAM_ERROR_BRAND, { value: true });
  }
  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[STREAM_ERROR_BRAND] === true;
  }
}

/** How the assembler turns a failure into what it throws. The runtime supplies its own `ProviderTurnError` mapping; a host takes the default. */
export interface StreamErrorMapping {
  /** An `error` EVENT from the adapter. */
  fromEvent(error: ProviderError, committed: boolean): unknown;
  /** Anything the stream THREW. */
  fromThrown(err: unknown, committed: boolean): unknown;
}

const DEFAULT_ERRORS: StreamErrorMapping = {
  fromEvent: (error, committed) => new ProviderStreamError(error, committed),
  fromThrown: (err, committed) => (err instanceof ProviderStreamError ? err : new ProviderStreamError(normalizeThrown(err), committed)),
};

export interface AssembleOptions {
  sink?: StreamAssemblySink;
  /** The request's own signal: an interrupt closes the open reasoning blocks at once. */
  signal?: AbortSignal;
  errors?: StreamErrorMapping;
}

// --- the fold ---------------------------------------------------------------------------------------

/**
 * Folds an adapter's event stream into one turn. Exported under the bridge's own name, so a host tests
 * its adapter against the REAL consumer rather than a re-implementation of it.
 */
export async function foldProviderStream(stream: AsyncIterable<ProviderEvent>, options: AssembleOptions = {}): Promise<AssembledTurn> {
  const { sink, signal } = options;
  const errors = options.errors ?? DEFAULT_ERRORS;
  let text = "";
  let summary = "";
  let exposed = "";
  const thinkingBlocks: AssembledContentBlock[] = [];
  const calls: Array<{ id: string; name: string; input: unknown }> = [];
  const callOrder: string[] = [];
  const pendingCalls = new Map<string, { name: string; argumentsJson: string }>();
  // WS-23 (block order): the turn's content IN THE ORDER THE STREAM PRODUCED IT, alongside the per-kind
  // buckets above. The buckets alone lose the interleaving: a `[thinking, text, thinking, tool_use]`
  // response used to be persisted as `[thinking, thinking, text, tool_use]`, and Anthropic requires the
  // thinking blocks of an active tool loop to come back UNMODIFIED and in place. A text run opens one
  // text block and is closed by the next thinking block or call, the same boundary rule the stream
  // emitter applies, so the content and the streamed frames describe one sequence. Tool calls are
  // placeholders here (their arguments are still streaming) and are materialised at the end.
  // CAVEAT: this is EVENT order, which equals wire order only for an adapter that emits each block when
  // it completes.
  const ordered: Array<{ kind: "text"; text: string } | { kind: "block"; block: AssembledContentBlock } | { kind: "call"; id: string }> = [];
  let orderedTextOpen = false;
  let usage: AssembledUsage | undefined;
  let stopReason: AssembledStopReason | undefined;
  let stopDetails: { category: string | null; explanation: string | null } | undefined;
  let nativeState: ProviderNativeState | undefined;
  let responseId: string | undefined;
  const emitter = new StreamEventEmitter(sink);
  // Has the STREAM begun? Every event except the pre-stream observations (`retry`, `rate_limit`,
  // `auth_status`) and the failure itself marks it -- the same line the adapters' `policy.commit()`
  // draws (the first SSE event).
  let committed = false;
  const progress = new ReasoningProgressTracker(sink);
  // An interrupt aborts the request signal BEFORE the caller unwinds the turn, and abort listeners run
  // inside `abort()` -- so the open blocks' `end` frames are written first.
  const onAbort = (): void => progress.stop();
  if (signal?.aborted === true) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  // The failure an `error` EVENT produced, rethrown as-is by the catch below (never re-mapped).
  let eventFailure: { value: unknown } | undefined;

  try {
    for await (const event of stream) {
      if (event.type !== "retry" && event.type !== "rate_limit" && event.type !== "auth_status" && event.type !== "error") committed = true;
      switch (event.type) {
        case "message_start":
          if (event.id !== undefined) responseId = event.id;
          emitter.messageStart(event.id, event.model);
          break;
        case "text_delta": {
          text += event.text;
          const open = ordered[ordered.length - 1];
          if (orderedTextOpen && open !== undefined && open.kind === "text") open.text += event.text;
          else {
            ordered.push({ kind: "text", text: event.text });
            orderedTextOpen = true;
          }
          emitter.textDelta(event.text);
          break;
        }
        case "thinking_summary_delta":
          // FOREIGN reasoning: accumulated for `thinking.summary`, NEVER forwarded as a stream event.
          summary += event.text;
          break;
        case "thinking_exposed_delta":
          exposed += event.text;
          break;
        case "reasoning_progress":
          // OBSERVATIONAL ONLY: accumulates nothing into the turn.
          progress.handle(event);
          break;
        case "native_thinking_block": {
          // Structurally validated rather than cast: these bytes came off a provider's wire.
          const block = coerceDialectThinkingBlock(event.block);
          if (block !== undefined) {
            thinkingBlocks.push(block);
            ordered.push({ kind: "block", block });
            orderedTextOpen = false;
            emitter.thinkingBlock(block);
          }
          break;
        }
        case "tool_call_start":
          // A REPEATED start for an id already open is not a second call.
          if (!pendingCalls.has(event.id)) {
            callOrder.push(event.id);
            ordered.push({ kind: "call", id: event.id });
          }
          pendingCalls.set(event.id, { name: event.name, argumentsJson: "" });
          orderedTextOpen = false;
          emitter.toolCallStart(event.id, event.name);
          break;
        case "tool_call_delta": {
          const pending = pendingCalls.get(event.id);
          // FRAGMENTED ARGUMENTS are the normal case: accumulated, parsed ONCE at the end.
          if (pending !== undefined) pending.argumentsJson += event.argumentsJsonDelta;
          emitter.toolCallDelta(event.id, event.argumentsJsonDelta);
          break;
        }
        case "tool_call_end":
          emitter.toolCallEnd(event.id);
          break;
        case "native_state":
          // CAPTURED FROM THE COMPLETION EVENT ONLY: "the last one wins". `family`/`continuationDomain`
          // are blank until `stampNativeState` -- the fold cannot know either.
          nativeState = { family: "", continuationDomain: "", items: event.items };
          break;
        case "usage":
          usage = {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            ...(event.cacheReadTokens !== undefined ? { cacheReadTokens: event.cacheReadTokens } : {}),
            ...(event.cacheWriteTokens !== undefined ? { cacheWriteTokens: event.cacheWriteTokens } : {}),
            ...(event.cacheWrite1hTokens !== undefined ? { cacheWrite1hTokens: event.cacheWrite1hTokens } : {}),
            ...(event.cacheMiss !== undefined ? { cacheMiss: event.cacheMiss } : {}),
            ...(event.thinkingBlocksDropped !== undefined ? { thinkingBlocksDropped: event.thinkingBlocksDropped } : {}),
            ...(event.reasoningTokens !== undefined ? { reasoningTokens: event.reasoningTokens } : {}),
            ...(event.reportedCostUsd !== undefined ? { reportedCostUsd: event.reportedCostUsd } : {}),
          };
          break;
        case "retry":
          sink?.onRetry?.({
            attempt: event.attempt,
            maxRetries: event.maxRetries,
            retryDelayMs: event.retryDelayMs,
            ...(event.errorStatus !== undefined ? { errorStatus: event.errorStatus } : {}),
            error: event.error,
          });
          break;
        case "rate_limit":
          sink?.onRateLimit?.({ kind: event.kind, info: event.info });
          break;
        case "auth_status":
          sink?.onAuthStatus?.({
            isAuthenticating: event.isAuthenticating,
            ...(event.output !== undefined ? { output: event.output } : {}),
            ...(event.error !== undefined ? { error: event.error } : {}),
          });
          break;
        case "done":
          stopReason = event.stopReason;
          stopDetails = event.stopDetails;
          emitter.messageStop(event.stopReason);
          break;
        case "error":
          // An overflow the stream reported before producing anything is not a committed turn --
          // nothing reached the host, nothing ran -- so it may be compacted and retried.
          eventFailure = { value: errors.fromEvent(event.error, committed && !((event.error.contextOverflow === true || event.error.imageOverflow === true) && ordered.length === 0)) };
          throw eventFailure.value;
      }
    }
  } catch (err) {
    if (eventFailure !== undefined && err === eventFailure.value) throw err;
    throw errors.fromThrown(err, committed);
  } finally {
    // Every started block gets its `end`, however the stream stopped.
    signal?.removeEventListener("abort", onAbort);
    progress.closeAll();
  }

  // The COMPLETE summary still reaches the host once, at the end of the generation. (Outside the fold's
  // try, as it always was: a throw here reaches the caller as thrown.)
  if (summary.length > 0) sink?.onReasoningSummary?.(summary);

  for (const id of callOrder) {
    const pending = pendingCalls.get(id);
    if (pending === undefined) continue;
    calls.push({ id, name: pending.name, input: parseToolArguments(pending.argumentsJson) });
  }

  // The ordered content, materialised. Each call is the SAME object `calls` carries, and an empty text
  // run is dropped: this endpoint family rejects an empty text block on replay.
  const callsById = new Map(calls.map((c) => [c.id, c]));
  const content: AssembledContentBlock[] = [];
  for (const entry of ordered) {
    if (entry.kind === "text") {
      if (entry.text.length > 0) content.push({ type: "text", text: entry.text });
    } else if (entry.kind === "block") {
      content.push(entry.block);
    } else {
      const call = callsById.get(entry.id);
      if (call !== undefined) content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
    }
  }

  // Whether the accumulated exposed text is the WHOLE trace: a normal stop. An error mid-stream never
  // reaches this point (the `throw` above ends the fold first).
  const exposedComplete = exposed.length > 0 && (stopReason === "end_turn" || stopReason === "tool_use");

  const thinking: AssembledThinking | undefined =
    summary.length > 0 || exposed.length > 0 || thinkingBlocks.length > 0
      ? {
          ...(summary.length > 0 ? { summary } : {}),
          ...(exposed.length > 0 ? { exposed, exposedComplete } : {}),
          ...(thinkingBlocks.length > 0 ? { blocks: thinkingBlocks } : {}),
        }
      : undefined;

  const common: AssembledCommon = {
    ...(usage !== undefined ? { usage } : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(stopDetails !== undefined ? { stopDetails } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(nativeState !== undefined ? { nativeState } : {}),
    ...(content.length > 0 ? { content } : {}),
    ...(responseId !== undefined ? { responseId } : {}),
  };

  if (calls.length > 0) return { kind: "tool_use", calls, ...(text.length > 0 ? { text } : {}), ...common };
  return { kind: "text", text, ...common };
}

/**
 * Stamps the RESOLVED identity's family and continuation domain onto an assembled turn's native state.
 *
 * The fold has no access to either -- it consumes an adapter's event stream, not its resolution -- so
 * this is the one place the two meet. A turn with no native state is returned untouched: stamping never
 * fabricates state. A row with no certified domain stamps its MODEL KEY, never the family string -- its
 * state is valid for that model alone.
 */
export function stampNativeState<T extends { nativeState?: ProviderNativeState }>(turn: T, origin: MessageOrigin): T {
  if (turn.nativeState === undefined) return turn;
  return {
    ...turn,
    nativeState: { family: origin.family, continuationDomain: origin.continuationDomain ?? origin.modelKey, items: turn.nativeState.items },
  };
}

/**
 * An assembled turn as the ASSISTANT MESSAGE a host appends to its history -- the input
 * `createHistoryRenderer` and every adapter's `streamTurn` take on the next request.
 *
 * `origin` is the resolved identity of the model that produced the turn (`resolved.providerId`,
 * `resolved.modelKey`, the adapter's `family`, `resolved.continuationDomain`). It rides the message, and
 * the native state is stamped with it (`stampNativeState`), so the renderer replays that state only to
 * the same continuation domain and strips it everywhere else.
 *
 * CONTENT ORDER follows the Winter engine exactly: the STREAM ORDER for the Anthropic family (in-dialect
 * thinking blocks must come back in place), and the per-kind assembly -- reasoning blocks, then the
 * joined text, then the calls -- for every other family, whose serializers key opaque state on that
 * shape (Gemini's text `thoughtSignature` rides the message's FIRST text part). A text-only turn with no
 * reasoning blocks keeps its content as a plain string, as the engine's history does.
 */
export function assembledToMessage(turn: AssembledTurn, origin: MessageOrigin): ProviderMessageLike {
  const stamped = stampNativeState(turn, origin);
  const blocks = turn.thinking?.blocks ?? [];
  const orderedContent = origin.family === "anthropic" ? inStreamOrder(turn) : undefined;
  let content: string | ContentBlockLike[];
  if (orderedContent !== undefined) content = orderedContent;
  else if (turn.kind === "text") content = blocks.length === 0 ? turn.text : [...blocks, ...(turn.text.length > 0 ? [{ type: "text" as const, text: turn.text }] : [])];
  else
    content = [
      ...blocks,
      ...(turn.text !== undefined && turn.text.length > 0 ? [{ type: "text" as const, text: turn.text }] : []),
      ...turn.calls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input })),
    ];
  return { role: "assistant", content, origin: { ...origin }, ...(stamped.nativeState !== undefined ? { nativeState: stamped.nativeState } : {}) };
}

/** The stream-order content when it is consistent with the turn's calls (the engine's `inStreamOrder`), else `undefined`. */
function inStreamOrder(turn: AssembledTurn): AssembledContentBlock[] | undefined {
  const content = turn.content;
  if (content === undefined || content.length === 0) return undefined;
  const orderedCallIds = content.flatMap((block) => (block.type === "tool_use" ? [block.id] : []));
  if (turn.kind === "text") return orderedCallIds.length === 0 ? content : undefined;
  if (orderedCallIds.length !== turn.calls.length || orderedCallIds.some((id, i) => id !== turn.calls[i]!.id)) return undefined;
  return content;
}

// --- internals --------------------------------------------------------------------------------------

/** `onReasoningProgress` is observation only: a throw there never breaks a generation. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // swallowed: the turn is the record, the progress stream is observation
  }
}

/**
 * Maps the fold's own progress onto the six raw stream events (R6-5). The block INDEX is maintained here:
 * it is a property of the assembled message, not of any single event. Every method is a no-op without a
 * sink, so an auxiliary generation costs nothing.
 */
class StreamEventEmitter {
  private index = -1;
  private textOpen = false;
  private readonly toolIndex = new Map<string, number>();
  constructor(private readonly sink: StreamAssemblySink | undefined) {}

  private get streaming(): boolean {
    return this.sink?.onStreamEvent !== undefined;
  }

  private emit(event: AssemblerStreamEvent): void {
    this.sink?.onStreamEvent?.(event);
  }

  messageStart(id: string | undefined, model: string | undefined): void {
    if (!this.streaming) return;
    this.emit({ type: "message_start", message: { ...(id !== undefined ? { id } : {}), ...(model !== undefined ? { model } : {}), role: "assistant", content: [] } });
  }

  textDelta(text: string): void {
    this.sink?.onTextDelta?.(text);
    if (!this.streaming) return;
    if (!this.textOpen) {
      this.closeText();
      this.index++;
      this.textOpen = true;
      this.emit({ type: "content_block_start", index: this.index, content_block: { type: "text", text: "" } });
    }
    this.emit({ type: "content_block_delta", index: this.index, delta: { type: "text_delta", text } });
  }

  thinkingBlock(block: { type: "thinking"; thinking: string; signature: string } | { type: "redacted_thinking"; data: string }): void {
    if (!this.streaming) return;
    this.closeText();
    this.index++;
    // A COMPLETE block arrives as one event, so it is emitted as start + its delta + stop, WITHOUT its
    // attestation: the signed bytes are for the provider on replay, never for a host.
    this.emit({ type: "content_block_start", index: this.index, content_block: block.type === "thinking" ? { type: "thinking", thinking: "", signature: "" } : { type: "redacted_thinking", data: "" } });
    if (block.type === "thinking") this.emit({ type: "content_block_delta", index: this.index, delta: { type: "thinking_delta", thinking: block.thinking } });
    this.emit({ type: "content_block_stop", index: this.index });
  }

  toolCallStart(id: string, name: string): void {
    if (!this.streaming) return;
    this.closeText();
    this.index++;
    this.toolIndex.set(id, this.index);
    this.emit({ type: "content_block_start", index: this.index, content_block: { type: "tool_use", id, name, input: {} } });
  }

  toolCallDelta(id: string, partialJson: string): void {
    if (!this.streaming) return;
    const index = this.toolIndex.get(id);
    if (index === undefined) return;
    this.emit({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: partialJson } });
  }

  toolCallEnd(id: string): void {
    if (!this.streaming) return;
    const index = this.toolIndex.get(id);
    if (index === undefined) return;
    this.emit({ type: "content_block_stop", index });
  }

  messageStop(stopReason: AssembledStopReason): void {
    if (!this.streaming) return;
    this.closeText();
    this.emit({ type: "message_delta", delta: { stop_reason: stopReason } });
    this.emit({ type: "message_stop" });
  }

  private closeText(): void {
    if (!this.textOpen) return;
    this.textOpen = false;
    this.emit({ type: "content_block_stop", index: this.index });
  }
}

/**
 * 0.0.47: an adapter's `reasoning_progress` events -> the sink's `onReasoningProgress`, with the
 * contract's invariants enforced HERE, once:
 *
 *   - `blockId` is a fresh UUID per block;
 *   - a block gets exactly one `start` and one `end`: a repeated `start` is dropped, a `delta`/`end` for
 *     a block never started opens it first, and anything for a block already ended is dropped;
 *   - `end` carries the block's LAST kind;
 *   - `closeAll()` ends every block still open; `stop()` does the same for an interrupt and drops
 *     whatever the abandoned stream still yields.
 *
 * An empty `delta` is dropped, kind and all. Every method is a no-op without a sink.
 */
class ReasoningProgressTracker {
  private readonly open = new Map<string, { blockId: string; kind: ReasoningProgressKind }>();
  private readonly ended = new Set<string>();
  private stopped = false;
  constructor(private readonly sink: StreamAssemblySink | undefined) {}

  handle(event: Extract<ProviderEvent, { type: "reasoning_progress" }>): void {
    if (this.sink?.onReasoningProgress === undefined || this.stopped || this.ended.has(event.block)) return;
    let block = this.open.get(event.block);
    if (block === undefined) {
      block = { blockId: randomUUID(), kind: event.kind };
      this.open.set(event.block, block);
      this.emit({ blockId: block.blockId, phase: "start", kind: event.kind });
      if (event.phase === "start") return;
    } else if (event.phase === "start") {
      return;
    }
    if (event.phase === "end") {
      this.close(event.block);
      return;
    }
    if (event.text === undefined || event.text.length === 0) return;
    block.kind = event.kind;
    this.emit({ blockId: block.blockId, phase: "delta", kind: block.kind, text: event.text, ...(event.part !== undefined ? { part: event.part } : {}) });
  }

  closeAll(): void {
    for (const key of [...this.open.keys()]) this.close(key);
  }

  stop(): void {
    this.closeAll();
    this.stopped = true;
  }

  private close(key: string): void {
    const block = this.open.get(key);
    if (block === undefined) return;
    this.open.delete(key);
    this.ended.add(key);
    this.emit({ blockId: block.blockId, phase: "end", kind: block.kind });
  }

  private emit(progress: AssembledReasoningProgress): void {
    safely(() => this.sink?.onReasoningProgress?.(progress));
  }
}

/**
 * Fragmented tool arguments -> the call's `input`. An UNPARSEABLE accumulation is not an exception: the
 * raw text is preserved under a marked key so the tool's own validation reports the real problem.
 */
function parseToolArguments(argumentsJson: string): unknown {
  if (argumentsJson.trim().length === 0) return {};
  try {
    return JSON.parse(argumentsJson);
  } catch {
    return { __winter_unparsed_arguments: argumentsJson };
  }
}

/** Structural validation of an adapter-supplied in-dialect thinking block. `signature` is REQUIRED and may be `""`. */
function coerceDialectThinkingBlock(value: unknown): ({ type: "thinking"; thinking: string; signature: string } | { type: "redacted_thinking"; data: string }) | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (v.type === "thinking" && typeof v.thinking === "string") return { type: "thinking", thinking: v.thinking, signature: typeof v.signature === "string" ? v.signature : "" };
  if (v.type === "redacted_thinking" && typeof v.data === "string") return { type: "redacted_thinking", data: v.data };
  return undefined;
}
