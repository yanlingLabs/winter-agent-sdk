// Phase 6 Task 3 (R6-4): the runtime-side bridge -- an adapter's `AsyncIterable<ProviderEvent>`
// folded into ONE `ProviderTurn`.
//
// WHY IT LIVES HERE AND NOT IN `provider-runtime`. That package must never import the runtime (a
// cycle whose compiled and dev resolutions differ), and `ProviderTurn`/`ProviderMessage`/
// `ContentBlock` stay defined in `engine.ts` because they are the ENGINE's contract. So the
// conversion between the two vocabularies has exactly one place it can live, and this is it: the
// dependency runs runtime -> provider-runtime, one way, always.
//
// WHAT THE FOLD IS RESPONSIBLE FOR, stated as obligations rather than steps:
//
//   1. **Opaque state reaches the sidecar and nowhere else.** `native_state` items are carried on
//      `ProviderTurn.nativeState` (whose only sink is the provider-state sidecar) and are NEVER
//      forwarded as a `stream_event`, never logged, never placed in an error message. A
//      `thinking_summary_delta` is FOREIGN reasoning: it goes to `sink.onReasoningSummary` and onto
//      `turn.thinking.summary`, never into `assistant.message.content` (R6-8).
//   2. **In-dialect thinking rides in-dialect.** `native_thinking_block` carries a COMPLETE
//      Anthropic-family block with its REAL signature; it becomes a `ContentBlock` the engine
//      persists verbatim, because that signature is replay-critical (capture (F)).
//   3. **No retry past the first byte.** This fold never retries anything. Retry is
//      `withRetry`'s job inside the adapter, strictly before the stream begins (WS-13 §13: no unsafe
//      replay of effectful turns) -- an error arriving mid-stream is final, and `bridge.test.ts`
//      asserts `streamTurn` was invoked exactly once when one does.
//   4. **Errors are typed and redacted.** Everything that goes wrong becomes a `ProviderTurnError`
//      carrying the provider's status and structured code -- never a raw body, never credential
//      material, never opaque state.
import type { ProviderAdapter, ProviderContext, ProviderError, ProviderEvent, ProviderMessageLike, ResolvedModel, TurnRequest } from "@yanlinglabs/winter-provider-runtime";
import { normalizeThrown, shouldRequestSummary } from "@yanlinglabs/winter-provider-runtime";
import type { WireContentBlock, WireStreamEvent } from "@yanlinglabs/winter-agent-sdk";
import {
  ProviderTurnError,
  type ContentBlock,
  type MessageOrigin,
  type Provider,
  type ProviderMessage,
  type ProviderNativeState,
  type ProviderRequest,
  type ProviderStopReason,
  type ProviderStreamSink,
  type ProviderThinkingOutput,
  type ProviderTurn,
  type ProviderUsage,
} from "../engine.ts";
import type { ContinuationChain } from "../store/provider-state.ts";

// Re-exported so a lane reads the error type from the module it is working in. DECLARED in
// `engine.ts` (see its own header): the engine must recognise a provider failure without importing
// this module, and a value import in both directions would be a runtime cycle.
export { ProviderTurnError, isProviderTurnError } from "../engine.ts";

/**
 * R6-3 / Lane C: renders the engine's history into what THIS target may actually be sent.
 *
 * Lane C implements the real one (per-message cross-family decoration, the switch coordinator's own
 * loss matrix). T3 ships the IDENTITY renderer below, which is deliberately the most conservative
 * thing that is still correct.
 */
export interface HistoryRenderer {
  render(
    messages: ProviderMessage[],
    chain: ContinuationChain,
    target: { family: string; continuationDomain?: string; readableState: "none" | "summary" | "full-exposed" },
  ): ProviderMessage[];
}

/**
 * The T3 renderer: NO decoration, and native state replayed ONLY inside the same continuation domain.
 *
 * Both halves are refusals rather than features, and that is the point. Decoration is Lane C's --
 * inventing a cross-family note here would put Winter-authored text into a model's context that no
 * ruling has approved. Replaying native state ACROSS a domain boundary is worse than not replaying
 * it: opaque items are meaningful only to the provider that minted them, so a cross-domain replay is
 * at best rejected and at worst silently misinterpreted. When the domains disagree the annotation is
 * dropped and the message rides as plain content -- which is exactly R6-7's "degrade to
 * summary-level", applied at the point of use.
 *
 * A message with no `origin` at all (every pre-P6 history, and every message the host supplied) is
 * passed through untouched: absence is not a domain mismatch.
 */
export function createIdentityHistoryRenderer(): HistoryRenderer {
  return {
    render(messages, _chain, target) {
      return messages.map((message) => {
        if (message.nativeState === undefined) return message;
        const sameDomain = target.continuationDomain !== undefined && message.nativeState.continuationDomain === target.continuationDomain;
        if (sameDomain) return message;
        const { nativeState: _dropped, ...rest } = message;
        return rest;
      });
    },
  };
}

/** What `adapterAsProvider` needs beyond the adapter and its context. */
export interface AdapterProviderOptions {
  renderer?: HistoryRenderer;
  /** Overrides the adapter on `resolved`. The one caller is a test that wants a scripted adapter against a real `ResolvedModel`. */
  adapter?: ProviderAdapter;
  /**
   * Phase 6 Task 10 (Lane C wiring item 2): THE RESUMED CONTINUATION CHAIN.
   *
   * A GETTER, because the chain is re-attached asynchronously at the start of a run
   * (`attachContinuationChain`) — long after this provider is constructed — so a captured value would
   * always be the empty map this option replaces.
   *
   * What it buys: `createHistoryRenderer` reads a message's `origin` off the message itself when the
   * engine already annotated it, and otherwise off `chain.get(message.uuid)`. The second path is the
   * one that matters for a RESUMED history whose `summary` records (R6-8's foreign reasoning, which
   * may never enter the transcript) live only in the sidecar: without the chain those messages render
   * with no decoration at all, which looks exactly like a session that had nothing to say.
   *
   * Absent -> an empty chain, which is what T3 shipped and what a non-persistent session genuinely has.
   */
  chain?: () => ContinuationChain;
}

/**
 * A `Provider` that is known to produce only the two PRODUCTION turn kinds.
 *
 * Narrower than `Provider` on purpose: no adapter stream can express `rpc_probe`, so a caller reading
 * `turn.nativeState`/`turn.thinking` off one of these needs no cast -- and a cast is exactly what
 * would also silence a real mistake.
 */
export interface AdapterProvider extends Provider {
  generate(input: ProviderRequest): Promise<FoldedProviderTurn>;
}

/**
 * Wraps a resolved adapter as the engine's `Provider`.
 *
 * The whole conversion in one place: render the history, build a `TurnRequest`, consume
 * `streamTurn`, fold, STAMP the resolved identity onto any native state, and normalize any failure
 * into a `ProviderTurnError`.
 */
export function adapterAsProvider(resolved: ResolvedModel, ctx: ProviderContext, opts: AdapterProviderOptions = {}): AdapterProvider {
  const adapter = opts.adapter ?? resolved.adapter;
  const renderer = opts.renderer ?? createIdentityHistoryRenderer();
  const capabilities = resolved.descriptor !== undefined ? adapter.capabilities(resolved.descriptor) : undefined;
  const target = {
    family: adapter.family as string,
    ...(resolved.continuationDomain !== undefined ? { continuationDomain: resolved.continuationDomain } : {}),
    readableState: capabilities?.readableState ?? ("none" as const),
  };

  return {
    async generate(input: ProviderRequest): Promise<FoldedProviderTurn> {
      // The chain is the RENDERER's input. The engine's own messages already carry their annotations
      // for everything THIS run produced; `opts.chain` is what supplies the RESUMED half (T10's
      // wiring passes the sidecar-derived chain, see `AdapterProviderOptions.chain`). Absent -> the
      // empty map T3 shipped, which is what a non-persistent session genuinely has.
      const rendered = renderer.render(input.messages, opts.chain?.() ?? new Map(), target);
      const request: TurnRequest = {
        // THE PROVIDER-LOCAL ID, never the catalog KEY.
        //
        // The engine puts `currentModel` on every request, and `currentModel` starts at `config.model`
        // — which for a catalog-resolved session is the QUALIFIED `<providerId>/<model>` key (R6-9's
        // own selection spelling). Forwarding it verbatim put `anthropic/claude-sonnet-5` in the wire
        // body of every such session: a model id no provider has ever heard of, on every request, and
        // invisible to any test that passed `model` explicitly. The equivalence scenarios found it
        // because a loopback fake records what was actually sent.
        //
        // A DIFFERENT id still passes through verbatim, which is what makes `set_model` to another
        // model on the same provider work — the qualified form is translated, anything else is the
        // caller's own word.
        model: input.model === undefined || input.model === resolved.modelKey ? resolved.providerModelId : input.model,
        messages: rendered as ProviderMessageLike[],
        ...(input.system !== undefined ? { system: input.system } : {}),
        ...(input.tools !== undefined ? { tools: input.tools } : {}),
        ...(input.toolChoice !== undefined ? { toolChoice: input.toolChoice } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        // Ask for a readable SUMMARY only where the model's own evidence says HOW to ask.
        //
        // T10 RECONCILIATION (Lane C wiring item 7). This keyed on `readableState !== "none"`, which
        // is a different question: `readableState` says a summary is READABLE, `summaryRequest` says
        // the descriptor knows which field to set to ask for one. A model with the first and not the
        // second got `requestSummary: true` and every adapter then had nothing to do with it —
        // silently, since asking for nothing is indistinguishable from not asking. `shouldRequestSummary`
        // is Lane C's own predicate and is now the single reader of that evidence.
        ...(shouldRequestSummary(resolved.descriptor) ? { requestSummary: true } : {}),
      };

      let stream: AsyncIterable<ProviderEvent>;
      try {
        stream = adapter.streamTurn(request, ctx);
      } catch (err) {
        // A THROW before the iterable even exists (a bad request an adapter refuses to send). Same
        // typed shape as an in-stream failure, so a caller has one thing to catch.
        throw toProviderTurnError(err);
      }
      // STAMPED, and the stamp is load-bearing rather than cosmetic. The fold sees only an adapter's
      // `items` -- it cannot know the family or the continuation domain -- so it emits blanks for
      // both. Returning that unstamped would have the engine copy `{family: "", continuationDomain:
      // ""}` onto the in-memory message, and the identity renderer would compare `""` against the
      // real domain on the very NEXT generation and drop the state. Live native replay would be dead
      // while resumed sessions kept working (the chain rebuilds family/domain from the record) --
      // the common case broken, the rarer one fine, and nothing failing anywhere.
      return stampNativeState(await foldProviderStream(stream, input.sink), {
        providerId: resolved.providerId,
        modelKey: resolved.modelKey,
        family: adapter.family,
        ...(resolved.continuationDomain !== undefined ? { continuationDomain: resolved.continuationDomain } : {}),
      });
    },
  };
}

/**
 * What a fold can produce: the two PRODUCTION turn kinds and nothing else.
 *
 * `rpc_probe` is a P1-only test affordance the engine performs on a provider's behalf; no adapter
 * stream can express it, so narrowing the return type here is not a convenience -- it is what lets a
 * caller read `turn.thinking`/`turn.nativeState` without a cast that would also silence a real
 * mistake.
 */
export type FoldedProviderTurn = Exclude<ProviderTurn, { kind: "rpc_probe" }>;

/**
 * The fold itself, exported so a lane can test its own adapter's stream against the REAL consumer
 * rather than a re-implementation of it.
 */
export async function foldProviderStream(stream: AsyncIterable<ProviderEvent>, sink?: ProviderStreamSink): Promise<FoldedProviderTurn> {
  let text = "";
  let summary = "";
  let exposed = "";
  const thinkingBlocks: ContentBlock[] = [];
  const calls: Array<{ id: string; name: string; input: unknown }> = [];
  const callOrder: string[] = [];
  const pendingCalls = new Map<string, { name: string; argumentsJson: string }>();
  let usage: ProviderUsage | undefined;
  let stopReason: ProviderStopReason | undefined;
  let nativeState: ProviderNativeState | undefined;
  const emitter = new StreamEventEmitter(sink);

  try {
    for await (const event of stream) {
      switch (event.type) {
        case "message_start":
          emitter.messageStart(event.id, event.model);
          break;
        case "text_delta":
          text += event.text;
          emitter.textDelta(event.text);
          break;
        case "thinking_summary_delta":
          // FOREIGN reasoning. Accumulated for the sidecar's `summary` record and the Winter-only
          // frame; NEVER forwarded as a `stream_event` (there is no pinned raw event for a foreign
          // summary, and inventing one would put it in the model-facing block stream).
          summary += event.text;
          break;
        case "thinking_exposed_delta":
          exposed += event.text;
          break;
        case "native_thinking_block": {
          // An IN-DIALECT Anthropic-family block, complete, with its real signature. Structurally
          // validated rather than cast: these bytes came off a provider's wire.
          const block = coerceDialectThinkingBlock(event.block);
          if (block !== undefined) {
            thinkingBlocks.push(block);
            emitter.thinkingBlock(block);
          }
          break;
        }
        case "tool_call_start":
          pendingCalls.set(event.id, { name: event.name, argumentsJson: "" });
          callOrder.push(event.id);
          emitter.toolCallStart(event.id, event.name);
          break;
        case "tool_call_delta": {
          const pending = pendingCalls.get(event.id);
          // FRAGMENTED ARGUMENTS are the normal case, not an edge one: every family streams tool
          // arguments as partial JSON, so the fold accumulates and parses ONCE at the end.
          if (pending !== undefined) pending.argumentsJson += event.argumentsJsonDelta;
          emitter.toolCallDelta(event.id, event.argumentsJsonDelta);
          break;
        }
        case "tool_call_end":
          emitter.toolCallEnd(event.id);
          break;
        case "native_state":
          // CAPTURED FROM THE COMPLETION EVENT ONLY, which here means "the last one wins": an
          // adapter emits this once, from the event its descriptor names as the completion. Taking
          // an earlier partial copy would persist a continuation state the provider never finished
          // minting, and the replay would fail on the next turn rather than here.
          nativeState = { family: "", continuationDomain: "", items: event.items };
          break;
        case "usage":
          usage = {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            ...(event.cacheReadTokens !== undefined ? { cacheReadTokens: event.cacheReadTokens } : {}),
            ...(event.cacheWriteTokens !== undefined ? { cacheWriteTokens: event.cacheWriteTokens } : {}),
          };
          break;
        case "retry":
          sink?.onRetry({
            attempt: event.attempt,
            maxRetries: event.maxRetries,
            retryDelayMs: event.retryDelayMs,
            ...(event.errorStatus !== undefined ? { errorStatus: event.errorStatus } : {}),
            error: event.error,
          });
          break;
        case "rate_limit":
          sink?.onRateLimit({ kind: event.kind, info: event.info });
          break;
        case "auth_status":
          sink?.onAuthStatus({
            isAuthenticating: event.isAuthenticating,
            ...(event.output !== undefined ? { output: event.output } : {}),
            ...(event.error !== undefined ? { error: event.error } : {}),
          });
          break;
        case "done":
          stopReason = event.stopReason;
          emitter.messageStop(event.stopReason);
          break;
        case "error":
          throw providerErrorToTurnError(event.error);
      }
    }
  } catch (err) {
    throw toProviderTurnError(err);
  }

  // The summary reaches the host ONCE, complete -- not per delta. A frame per delta would be a
  // second, ungated streaming channel for reasoning text, which is precisely what R6-8 and the
  // "streaming foreign thinking deltas is a recorded carry, not this phase" ruling exclude.
  if (summary.length > 0) sink?.onReasoningSummary(summary);

  for (const id of callOrder) {
    const pending = pendingCalls.get(id);
    if (pending === undefined) continue;
    calls.push({ id, name: pending.name, input: parseToolArguments(pending.argumentsJson) });
  }

  const thinking: ProviderThinkingOutput | undefined =
    summary.length > 0 || exposed.length > 0 || thinkingBlocks.length > 0
      ? {
          ...(summary.length > 0 ? { summary } : {}),
          ...(exposed.length > 0 ? { exposed } : {}),
          ...(thinkingBlocks.length > 0 ? { blocks: thinkingBlocks } : {}),
        }
      : undefined;

  const common = {
    ...(usage !== undefined ? { usage } : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(nativeState !== undefined ? { nativeState } : {}),
  };

  // A turn with CALLS is a `tool_use` turn even when it also produced text -- and the text rides
  // along on `text?` rather than being dropped, which is the whole reason R6-3 added that field.
  if (calls.length > 0) return { kind: "tool_use", calls, ...(text.length > 0 ? { text } : {}), ...common };
  return { kind: "text", text, ...common };
}

/**
 * Maps the fold's own progress onto the six pinned raw stream events (R6-5).
 *
 * Winter's normalized `ProviderEvent` vocabulary is NOT the Anthropic raw shape -- a family's stream
 * is normalized once, by its adapter, into `ProviderEvent`, and translated once, here, into what the
 * pinned `stream_event` frame carries. The block INDEX is maintained here for the same reason: it is
 * a property of the assembled message, not of any single event, so an adapter cannot get it wrong.
 *
 * Every method is a no-op without a sink, so an auxiliary generation costs nothing (R6-G).
 */
class StreamEventEmitter {
  private index = -1;
  private textOpen = false;
  private readonly toolIndex = new Map<string, number>();
  constructor(private readonly sink: ProviderStreamSink | undefined) {}

  private emit(event: WireStreamEvent): void {
    this.sink?.onStreamEvent(event);
  }

  messageStart(id: string | undefined, model: string | undefined): void {
    if (this.sink === undefined) return;
    this.emit({ type: "message_start", message: { ...(id !== undefined ? { id } : {}), ...(model !== undefined ? { model } : {}), role: "assistant", content: [] } });
  }

  textDelta(text: string): void {
    if (this.sink === undefined) return;
    if (!this.textOpen) {
      this.closeText();
      this.index++;
      this.textOpen = true;
      this.emit({ type: "content_block_start", index: this.index, content_block: { type: "text", text: "" } });
    }
    this.emit({ type: "content_block_delta", index: this.index, delta: { type: "text_delta", text } });
  }

  thinkingBlock(block: { type: "thinking"; thinking: string; signature: string } | { type: "redacted_thinking"; data: string }): void {
    if (this.sink === undefined) return;
    this.closeText();
    this.index++;
    // A COMPLETE block arrives as one event, so it is emitted as start + its delta(s) + stop rather
    // than being withheld: a host rendering the stream must see the same content the completed
    // `assistant` message will carry.
    this.emit({ type: "content_block_start", index: this.index, content_block: block as WireContentBlock });
    if (block.type === "thinking") {
      this.emit({ type: "content_block_delta", index: this.index, delta: { type: "thinking_delta", thinking: block.thinking } });
      this.emit({ type: "content_block_delta", index: this.index, delta: { type: "signature_delta", signature: block.signature } });
    }
    this.emit({ type: "content_block_stop", index: this.index });
  }

  toolCallStart(id: string, name: string): void {
    if (this.sink === undefined) return;
    this.closeText();
    this.index++;
    this.toolIndex.set(id, this.index);
    this.emit({ type: "content_block_start", index: this.index, content_block: { type: "tool_use", id, name, input: {} } });
  }

  toolCallDelta(id: string, partialJson: string): void {
    if (this.sink === undefined) return;
    const index = this.toolIndex.get(id);
    if (index === undefined) return;
    this.emit({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: partialJson } });
  }

  toolCallEnd(id: string): void {
    if (this.sink === undefined) return;
    const index = this.toolIndex.get(id);
    if (index === undefined) return;
    this.emit({ type: "content_block_stop", index });
  }

  messageStop(stopReason: ProviderStopReason): void {
    if (this.sink === undefined) return;
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
 * Fragmented tool arguments -> the call's `input`.
 *
 * An UNPARSEABLE accumulation is not an exception: the model produced something, the turn is real,
 * and refusing the whole turn over a malformed argument string would discard every other call in it.
 * The raw text is preserved under a marked key so the tool's own validation reports the real problem.
 */
function parseToolArguments(argumentsJson: string): unknown {
  if (argumentsJson.trim().length === 0) return {};
  try {
    return JSON.parse(argumentsJson);
  } catch {
    return { __winter_unparsed_arguments: argumentsJson };
  }
}

/** Structural validation of an adapter-supplied in-dialect thinking block. Never a cast: these bytes came off a provider's wire. */
function coerceDialectThinkingBlock(value: unknown): ({ type: "thinking"; thinking: string; signature: string } | { type: "redacted_thinking"; data: string }) | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (v.type === "thinking" && typeof v.thinking === "string") {
    // `signature` is REQUIRED and may be `""`: capture (F) shows the pinned runtime materialising
    // exactly that when a stream carries none, and replaying it byte-for-byte. Defaulting to `""`
    // here reproduces the pinned normalisation rather than dropping the block.
    return { type: "thinking", thinking: v.thinking, signature: typeof v.signature === "string" ? v.signature : "" };
  }
  if (v.type === "redacted_thinking" && typeof v.data === "string") return { type: "redacted_thinking", data: v.data };
  return undefined;
}

/** The longest a provider's own message may be in a `ProviderTurnError`. A provider error body can be arbitrarily long, and this string reaches a frame and a log. */
const MAX_ERROR_MESSAGE_CHARS = 400;

function providerErrorToTurnError(error: ProviderError): ProviderTurnError {
  const message = error.message.length > MAX_ERROR_MESSAGE_CHARS ? `${error.message.slice(0, MAX_ERROR_MESSAGE_CHARS)}...` : error.message;
  return new ProviderTurnError(`provider request failed (${error.code}): ${message}`, {
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(error.providerCode !== undefined ? { providerCode: error.providerCode } : {}),
    // Fix wave (Ruling E-3): the R6-6 class rides the typed error, so the engine's fallback trigger
    // reads a verdict rather than parsing a message.
    code: error.code,
    retryable: error.retryable,
  });
}

/**
 * Anything thrown -> a `ProviderTurnError`.
 *
 * The ORIGINAL is never re-thrown, and never attached as `cause`. An arbitrary throw from an adapter
 * can carry a request object, a response body, or a header map -- any of which may hold credential
 * material or opaque provider state, and all of which would then ride the error into a frame and a
 * log. Only a BOUNDED message survives (Global Constraints: credential material is redacted
 * everywhere, including thrown error messages).
 */
export function toProviderTurnError(err: unknown): ProviderTurnError {
  if (err instanceof ProviderTurnError) return err;
  if (typeof err === "object" && err !== null && (err as { winterProviderFailure?: unknown }).winterProviderFailure === true) return err as ProviderTurnError;
  // A resolution refusal is R6-F's shape by NAME (`isProviderTurnError`) and keeps its typed `code`:
  // re-wrapping it would hide the code a caller reads (Ruling E-1's `no-credential-for-provider`).
  if (typeof err === "object" && err !== null && (err as { name?: unknown }).name === "WinterProviderResolutionError") return err as ProviderTurnError;
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw.length > MAX_ERROR_MESSAGE_CHARS ? `${raw.slice(0, MAX_ERROR_MESSAGE_CHARS)}...` : raw;
  // Fix wave (Ruling E-3): the SAME normalization the adapters apply, so a raw throw carries R6-6's
  // verdict too. `normalizeThrown` never quotes a body -- the bounded `message` above is what travels.
  const normalized = normalizeThrown(err);
  const status = typeof err === "object" && err !== null && typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : normalized.status;
  return new ProviderTurnError(`provider request failed: ${message}`, { ...(status !== undefined ? { status } : {}), code: normalized.code, retryable: normalized.retryable });
}

/**
 * Stamps the RESOLVED identity's family and continuation domain onto a folded turn's native state.
 *
 * The fold has no access to either -- it consumes an adapter's event stream, not its resolution -- so
 * this is the one place the two meet. A turn with no native state is returned untouched: stamping
 * never fabricates state that an adapter did not produce.
 */
export function stampNativeState(turn: FoldedProviderTurn, origin: MessageOrigin): FoldedProviderTurn {
  if (turn.nativeState === undefined) return turn;
  return {
    ...turn,
    nativeState: { family: origin.family, continuationDomain: origin.continuationDomain ?? origin.family, items: turn.nativeState.items },
  };
}
