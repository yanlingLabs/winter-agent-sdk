// Phase 6 Task 3 (R6-5 / R6-B / R6-G): the ONE place a provider's live observations become frames.
//
// Extracted from `engine.ts` in review round 1 (M8). It is a pure function of its deps -- it reads no
// engine state and writes nothing but frames -- so pulling it out costs nothing and buys a module a
// lane can read without paging through 4900 lines of turn loop.
//
// THE GATING IS PER-FRAME AND NOT UNIFORM, which is the single fact most likely to be got wrong here:
//
//   - `stream_event` is gated on `includePartialMessages`. It is the ONLY frame in this family the pin
//     gates at all (`sdk.d.ts:1712-1716`), and it is ADDITIVE -- the complete `assistant` message
//     still follows, which is what lets a host ignore it entirely.
//   - `thinking_tokens` is deliberately NOT gated on it (item (b): "notably it is not tied to
//     `includePartialMessages`, which matters: a host that never opts into `stream_event` still gets
//     thinking progress"). So its digest runs BEFORE the `stream_event` gate, never after.
//   - `api_retry`, `rate_limit_event` and `auth_status` carry no gating option on the pin either.
//
// AND THE SINK ITSELF IS THE GATE FOR AUXILIARY CALLS (R6-G): a compaction, classifier, advisor or
// `countTokens` generation is built with NO sink at all rather than with one that is filtered later,
// because capture (F) observed the pinned runtime forwarding stream events for two of its three POSTs
// and suppressing the third's entirely.
import { randomUUID } from "node:crypto";
import type { ProtocolSdkMessage as SdkMessage, WireStreamEvent } from "@yanlinglabs/winter-agent-sdk";
import type { ProviderStreamSink } from "../engine.ts";

export interface StreamFrameSinkDeps {
  sessionId: string;
  /** The pin's own `Options.includePartialMessages`. Absent/false gates `stream_event` OFF and nothing else. */
  includePartialMessages: boolean;
  /** Writes one frame. Never throws to the caller -- see the wrapper below. */
  write: (message: SdkMessage) => void;
  /** Read LIVE, not captured: a `set_model` between generations changes what `reasoning_summary` should name. */
  identity: () => { providerId?: string; modelKey?: string } | undefined;
  /** The session's CURRENT model, for the same reason. */
  model: () => string;
  /** Injected for deterministic `ttft_ms` in tests. */
  now?: () => number;
}

/**
 * Builds the sink for ONE generation.
 *
 * Per generation, not per session, because `ttft_ms` is per generation: capture (F) observed exactly
 * two frames carrying it across a run -- one per FORWARDED turn, on that turn's `message_start`.
 */
export function createStreamFrameSink(deps: StreamFrameSinkDeps): ProviderStreamSink {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  let firstEventSent = false;
  // The running total for the CURRENT thinking block (item (b)): reset when a new block opens, so a
  // turn with two thinking blocks reports two independent progressions rather than one cumulative one.
  let thinkingTokens = 0;

  const write = (message: SdkMessage): void => {
    try {
      deps.write(message);
    } catch {
      // A sink must never break a generation: it is an OBSERVATION channel, and a failed write of an
      // observation is not a failed turn.
    }
  };

  return {
    onStreamEvent(event) {
      // The `thinking_tokens` digest runs FIRST, before the `stream_event` gate, because the two have
      // different gating (see this file's header). Reversing them would silently make thinking
      // progress an `includePartialMessages` feature.
      digestThinkingTokens(event);
      if (!deps.includePartialMessages) return;
      const ttft = firstEventSent ? {} : { ttft_ms: now() - startedAt };
      firstEventSent = true;
      write({
        type: "stream_event",
        event,
        // ALWAYS `null` here, and present rather than omitted: the pin types this `string | null`, not
        // optional. A CHILD engine emits `null` too -- the correlation is stamped at the PARENT's
        // forwarding boundary (`transformChildFrame`), the one place that knows the spawning
        // tool_use id, exactly as it already works for the `assistant`/`user` frames.
        //
        // `user_message_uuid` is ABSENT, and pin-correctly so: item (a)'s three-way rule conditions
        // both its arms on the turn having a CLIENT-supplied uuid, and capture (F) observed the field
        // on zero frames for exactly that reason. Winter has no client-uuid concept yet;
        // `turnUserMessageUuid` is Winter's OWN minted checkpoint id (R5-11), and stamping it would
        // misrepresent an internal id as the client's.
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: deps.sessionId,
        ...ttft,
      });
    },

    onRetry(info) {
      write({
        type: "system",
        subtype: "api_retry",
        attempt: info.attempt,
        max_retries: info.maxRetries,
        retry_delay_ms: info.retryDelayMs,
        // ABSENT on the seam becomes NULL on the frame: the pin's `error_status: number | null`
        // describes exactly the connection-error case that has no HTTP response.
        error_status: info.errorStatus ?? null,
        error: info.error,
        uuid: randomUUID(),
        session_id: deps.sessionId,
      });
    },

    onRateLimit(info) {
      // R6-B: this arrives ONLY for subscription-shaped quota (the payload's own `kind` says so at the
      // type level). An HTTP 429 reaches `onRetry` above with `error: "rate_limit"`, which is the
      // pinned 429 path capture (G) measured.
      write({ type: "rate_limit_event", rate_limit_info: { status: "allowed", ...info.info } as never, uuid: randomUUID(), session_id: deps.sessionId });
    },

    onAuthStatus(info) {
      write({
        type: "auth_status",
        isAuthenticating: info.isAuthenticating,
        output: info.output ?? [],
        ...(info.error !== undefined ? { error: info.error } : {}),
        uuid: randomUUID(),
        session_id: deps.sessionId,
      });
    },

    onReasoningSummary(text) {
      // R6-8: a foreign summary NEVER enters `assistant.message.content`. It rides this Winter-only
      // frame live and the sidecar durably -- the durable half is written by `recordAssistant`'s
      // `summary` record, from the turn's own `thinking.summary`.
      const identity = deps.identity();
      write({
        type: "system",
        subtype: "reasoning_summary",
        text,
        provider: identity?.providerId ?? "",
        model: identity?.modelKey ?? deps.model(),
        uuid: randomUUID(),
        session_id: deps.sessionId,
      });
    },
  };

  /**
   * Item (b)'s `thinking_tokens`, digested from a `thinking_delta`'s own `estimated_tokens`.
   *
   * The pin's semantics, restated: the value is approximate progress for a SPINNER during the
   * redacted-thinking phase (where the API otherwise streams only pings), `estimated_tokens` is the
   * running total for the CURRENT thinking block and `estimated_tokens_delta` is this frame's
   * increment -- explicitly NOT the billed `output_tokens`.
   *
   * WINTER DIGESTS RATHER THAN INVENTS: a `thinking_delta` with no `estimated_tokens` produces no
   * frame at all. The pin's own mention of the field is second-hand (prose about a different type,
   * item (b) says so outright), so fabricating a count from a delta's character length would be
   * inventing a number the pinned surface never claims to carry.
   */
  function digestThinkingTokens(event: WireStreamEvent): void {
    if (event.type === "content_block_start") {
      // A new block resets the running total -- "the current thinking block", not the turn.
      thinkingTokens = 0;
      return;
    }
    if (event.type !== "content_block_delta" || event.delta.type !== "thinking_delta") return;
    const estimated = event.delta.estimated_tokens;
    if (typeof estimated !== "number" || !Number.isFinite(estimated)) return;
    // The wire carries the RUNNING TOTAL; the frame carries both it and this step's increment. A
    // non-increasing report yields a zero delta rather than a negative one.
    const delta = Math.max(0, estimated - thinkingTokens);
    thinkingTokens = estimated;
    write({ type: "system", subtype: "thinking_tokens", estimated_tokens: estimated, estimated_tokens_delta: delta, uuid: randomUUID(), session_id: deps.sessionId });
  }
}
