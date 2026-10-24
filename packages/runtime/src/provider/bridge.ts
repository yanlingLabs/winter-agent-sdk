// Phase 6 Task 3 (R6-4): the runtime-side bridge -- an adapter's `AsyncIterable<ProviderEvent>`
// folded into ONE `ProviderTurn`.
//
// WHAT LIVES HERE AND WHAT DOES NOT (0.0.56, W8). The fold itself -- events in, one assembled turn out --
// moved to `provider-runtime` (`stream-assembler.ts`), so a host with its own agent loop assembles turns
// with the same code; this file imports it and keeps only what is the ENGINE's: `ProviderTurnError`
// (the fold's failures are mapped onto it here), the engine's sink and turn types, and the adapter
// wrapper. That package still never imports the runtime (a cycle whose compiled and dev resolutions
// differ): the dependency runs runtime -> provider-runtime, one way, always.
//
// WHAT THE FOLD IS RESPONSIBLE FOR, stated as obligations rather than steps:
//
//   1. **Opaque state reaches the sidecar and nowhere else.** `native_state` items are carried on
//      `ProviderTurn.nativeState` (whose only sink is the provider-state sidecar) and are NEVER
//      forwarded as a `stream_event`, never logged, never placed in an error message. A
//      `thinking_summary_delta` is FOREIGN reasoning: it goes to `sink.onReasoningSummary` and onto
//      `turn.thinking.summary`, never into `assistant.message.content` (R6-8). Its live twin,
//      `reasoning_progress` (0.0.47), goes to `sink.onReasoningProgress` and nowhere else.
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
import type { ProviderAdapter, ProviderContext, ProviderError, ProviderEvent, ProviderMessageLike, ResolvedModel, StreamAssemblySink, TurnRequest } from "@yanlinglabs/winter-provider-runtime";
import {
  foldProviderStream as assembleProviderStream,
  imageBudgetFor,
  normalizeThrown,
  shouldRequestSummary,
  stampNativeState as stampAssembledNativeState,
  stripOpaque,
  withinImageBudget,
} from "@yanlinglabs/winter-provider-runtime";
import { ProviderTurnError, type MessageOrigin, type Provider, type ProviderMessage, type ProviderRequest, type ProviderStreamSink, type ProviderTurn } from "../engine.ts";
import type { ContinuationChain } from "../store/provider-state.ts";

// Re-exported so a lane reads the error type from the module it is working in. DECLARED in
// `engine.ts` (see its own header): the engine must recognise a provider failure without importing
// this module, and a value import in both directions would be a runtime cycle.
export { ProviderTurnError, isProviderTurnError } from "../engine.ts";

/**
 * R6-3 / Lane C: renders the engine's history into what THIS target may actually be sent.
 *
 * Lane C implements the real one (per-message cross-family decoration, `classifySwitch`'s loss
 * matrix at the engine's switch point). T3 ships the IDENTITY renderer below, which is deliberately the most conservative
 * thing that is still correct.
 */
export interface HistoryRenderer {
  render(
    messages: ProviderMessage[],
    chain: ContinuationChain,
    target: { family: string; continuationDomain?: string; readableState: "none" | "summary" | "full-exposed"; providerId?: string; modelKey?: string; readsImages?: boolean },
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
 * A message WITH an `origin` is passed through untouched apart from the nativeState domain check
 * above: absence of a domain match is not this renderer's job to carry across (that is Lane C's).
 *
 * A message with NO `origin` at all (every pre-P6 history, and every message the host supplied) --
 * micro-round Minor 2, mirroring `provider-runtime`'s own renderer fix: FAIL CLOSED, LAYERED ON TOP
 * of the nativeState domain check above rather than replacing it (a live, same-turn message can
 * carry a stamped `nativeState.continuationDomain` with no `.origin` of its own -- `stampNativeState`
 * stamps the former directly, per this file's own header; the two are independent facts, and the
 * domain check must still run for a message that only has the first). Unknown provenance is this
 * renderer's worst-informed case too, and "decoration is Lane C's" was never a reason to also skip
 * STRIPPING what `stripOpaque` already knows how to strip -- the in-dialect `thinking`/
 * `redacted_thinking` blocks that ride in the CONTENT (the exact gap this function's own header used
 * to name and accept: "which the identity renderer could not do anything about"). Delegates to
 * `stripOpaque` itself (exported for exactly this) rather than reimplementing the two-carrier rule a
 * second time and risking the two copies drifting apart on what counts as opaque. Object identity is
 * preserved when there is truly nothing to strip.
 */
export function createIdentityHistoryRenderer(): HistoryRenderer {
  return {
    render(messages, _chain, target) {
      return messages.map((message) => {
        let next = message;
        if (next.nativeState !== undefined) {
          const sameDomain = target.continuationDomain !== undefined && next.nativeState.continuationDomain === target.continuationDomain;
          if (!sameDomain) {
            const { nativeState: _dropped, ...rest } = next;
            next = rest;
          }
        }
        if (next.origin === undefined) {
          const { content } = stripOpaque(next as unknown as ProviderMessageLike);
          if (content !== next.content) next = { ...next, content } as typeof message;
        }
        return next;
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
    // The target's OWN identity, the same two ids `stampNativeState` and the engine's `origin` carry.
    // Without them the renderer cannot recognise the model's own prior turns on a row the catalog
    // gives no continuation domain (`continuation: "none"`), and handed the model its own reasoning
    // back as a quoted `<recovered_reasoning>` text block (provider-runtime `sameModel`).
    providerId: resolved.providerId,
    modelKey: resolved.modelKey,
    // WS-23 (reasoning-state, decision 9): a model that reads no images gets a note in place of each one.
    ...(Array.isArray(resolved.descriptor?.inputModalities?.value) ? { readsImages: resolved.descriptor.inputModalities.value.includes("image") } : {}),
  };

  const imageBudget = imageBudgetFor({
    family: adapter.family as string,
    providerId: resolved.providerId,
    ...(typeof resolved.descriptor?.contextWindow?.value === "number" ? { contextWindow: resolved.descriptor.contextWindow.value } : {}),
  });

  return {
    async generate(input: ProviderRequest): Promise<FoldedProviderTurn> {
      // The chain is the RENDERER's input. The engine's own messages already carry their annotations
      // for everything THIS run produced; `opts.chain` is what supplies the RESUMED half (T10's
      // wiring passes the sidecar-derived chain, see `AdapterProviderOptions.chain`). Absent -> the
      // empty map T3 shipped, which is what a non-persistent session genuinely has.
      // Code-mode images: the OLDEST images past the target's per-request image budget become a note
      // (provider-runtime continuity/image-budget.ts) -- after the renderer, so it counts only the images
      // that really reach this target.
      const rendered = withinImageBudget(renderer.render(input.messages, opts.chain?.() ?? new Map(), target) as ProviderMessageLike[], imageBudget);
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
        // 0.0.16 request layout: the cache blocks ride alongside `system` (which stays their join).
        ...(input.systemBlocks !== undefined ? { systemBlocks: input.systemBlocks } : {}),
        ...(input.tools !== undefined ? { tools: input.tools } : {}),
        ...(input.toolChoice !== undefined ? { toolChoice: input.toolChoice } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
        ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
        // WS-23 (anthropic-cache): the prompt-cache fields, verbatim -- each adapter decides from its
        // own catalog evidence whether its wire takes one (Anthropic: `cacheTtl`, `cacheDiagnostics`;
        // OpenAI Responses/Codex: `cacheKey`).
        ...(input.cacheTtl !== undefined ? { cacheTtl: input.cacheTtl } : {}),
        ...(input.cacheDiagnostics !== undefined ? { cacheDiagnostics: input.cacheDiagnostics } : {}),
        ...(input.cacheKey !== undefined ? { cacheKey: input.cacheKey } : {}),
        // WS-23 (midconv): the tool epoch's per-request facts, verbatim (the adapter owns the wire form).
        ...(input.allowedTools !== undefined ? { allowedTools: input.allowedTools } : {}),
        ...(input.toolChanges !== undefined ? { toolChanges: input.toolChanges } : {}),
        ...(input.resumesPausedTurn !== undefined ? { resumesPausedTurn: input.resumesPausedTurn } : {}),
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
      // The request's own signal: an interrupt closes the open reasoning blocks at once (see the fold).
      const folded = await foldProviderStream(stream, input.sink, input.signal);
      // WS-23 (review M-5): the stream-order `content` is kept for the ANTHROPIC family only. Its
      // purpose is replaying in-dialect thinking blocks in place, which no other family has; and at
      // least one other family's serializer keys opaque state on the per-kind shape -- Gemini's
      // text `thoughtSignature` is re-attached to the message's FIRST text part, assuming at most one
      // per message, so a `[text, functionCall, text]` turn in stream order would put the trailing
      // text's signature on the leading one. Dropping the key restores the pre-WS-23 assembly
      // exactly (joined text, then calls) for every non-Anthropic family.
      const turn: FoldedProviderTurn = adapter.family === "anthropic" || folded.content === undefined ? folded : (({ content: _ordered, ...rest }) => rest as FoldedProviderTurn)(folded);
      return stampNativeState(turn, {
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
 *
 * 0.0.56 (W8): THE FOLD NOW LIVES IN PROVIDER-RUNTIME (`stream-assembler.ts`, `foldProviderStream`), so a
 * host driving `streamTurn` itself assembles turns with the same code. This is the engine's door onto
 * it, unchanged in behaviour: the engine's sink, and every failure mapped onto `ProviderTurnError`
 * exactly as before (`providerErrorToTurnError` for an `error` event, `toProviderTurnError` for a throw).
 * The provider-reported cost (`usage.reportedCostUsd`) is not part of the engine's `ProviderUsage` and is
 * dropped here, so the engine's turn is byte-for-byte what it was.
 */
export async function foldProviderStream(stream: AsyncIterable<ProviderEvent>, sink?: ProviderStreamSink, signal?: AbortSignal): Promise<FoldedProviderTurn> {
  const assembled = await assembleProviderStream(stream, {
    ...(sink !== undefined ? { sink: sink as StreamAssemblySink } : {}),
    ...(signal !== undefined ? { signal } : {}),
    errors: { fromEvent: (error, committed) => providerErrorToTurnError(error, committed), fromThrown: (err, committed) => toProviderTurnError(err, committed) },
  });
  if (assembled.usage?.reportedCostUsd === undefined) return assembled as FoldedProviderTurn;
  const { reportedCostUsd: _notEngineUsage, ...usage } = assembled.usage;
  return { ...assembled, usage } as FoldedProviderTurn;
}

/** The longest a provider's own message may be in a `ProviderTurnError`. A provider error body can be arbitrarily long, and this string reaches a frame and a log. */
const MAX_ERROR_MESSAGE_CHARS = 400;

function providerErrorToTurnError(error: ProviderError, committed = false): ProviderTurnError {
  const message = error.message.length > MAX_ERROR_MESSAGE_CHARS ? `${error.message.slice(0, MAX_ERROR_MESSAGE_CHARS)}...` : error.message;
  return new ProviderTurnError(`provider request failed (${error.code}): ${message}`, {
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(error.providerCode !== undefined ? { providerCode: error.providerCode } : {}),
    // Fix wave (Ruling E-3): the R6-6 class rides the typed error, so the engine's fallback trigger
    // reads a verdict rather than parsing a message. Round 2 (R-E2): and whether the stream had begun.
    code: error.code,
    retryable: error.retryable,
    committed,
    // WS-23: the adapter's own context-overflow verdict, carried as a flag -- the engine's reactive
    // compaction reads it, never the (capped, redacted) message text.
    ...(error.contextOverflow === true ? { contextOverflow: true } : {}),
    // Code-mode images: the adapter's verdict that the request was refused for its IMAGES.
    ...(error.imageOverflow === true ? { imageOverflow: true } : {}),
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
export function toProviderTurnError(err: unknown, committed = false): ProviderTurnError {
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
  // The overflow verdicts ride a THROWN typed error too (an adapter that throws its `ProviderRequestError`
  // rather than yielding an `error` event -- Bedrock's refusals), so the engine's recovery reaches them.
  return new ProviderTurnError(`provider request failed: ${message}`, {
    ...(status !== undefined ? { status } : {}),
    code: normalized.code,
    retryable: normalized.retryable,
    committed,
    ...(normalized.contextOverflow === true ? { contextOverflow: true as const } : {}),
    ...(normalized.imageOverflow === true ? { imageOverflow: true as const } : {}),
  });
}

/**
 * Stamps the RESOLVED identity's family and continuation domain onto a folded turn's native state.
 *
 * 0.0.56 (W8): provider-runtime's `stampNativeState` (stream-assembler.ts), re-exported under the engine's
 * turn type. A turn with no native state is returned untouched; a row with no certified domain stamps
 * its MODEL KEY.
 */
export function stampNativeState(turn: FoldedProviderTurn, origin: MessageOrigin): FoldedProviderTurn {
  return stampAssembledNativeState(turn, origin);
}
