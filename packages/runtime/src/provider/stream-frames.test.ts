// Phase 6 Task 3 (M8): the extracted frame sink, tested as the pure function it is.
//
// The engine-level fixtures in `engine-seam-p6.test.ts` still drive this through a real `runEngine`
// and are what prove the WIRING; these prove the RULES, and the per-frame gating is the rule most
// likely to be got wrong -- `stream_event` is gated on `includePartialMessages` and nothing else in
// this family is.
import { test, expect, describe } from "bun:test";
import type { ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { createStreamFrameSink } from "./stream-frames.ts";

function harness(opts: { includePartialMessages?: boolean } = {}): { sink: ReturnType<typeof createStreamFrameSink>; frames: SdkMessage[] } {
  const frames: SdkMessage[] = [];
  let clock = 1000;
  const sink = createStreamFrameSink({
    sessionId: "sess",
    includePartialMessages: opts.includePartialMessages ?? false,
    write: (m) => frames.push(m),
    identity: () => ({ providerId: "openai", modelKey: "openai/o-test" }),
    model: () => "openai/o-test",
    now: () => (clock += 5),
  });
  return { sink, frames };
}

const subtypesOf = (frames: SdkMessage[]): string[] => frames.map((f) => (f.type === "system" ? String((f as { subtype: string }).subtype) : f.type));

describe("per-frame gating: `stream_event` is gated, everything else is not", () => {
  test("`stream_event` is withheld without includePartialMessages, and emitted with it", () => {
    const off = harness();
    off.sink.onStreamEvent({ type: "message_start" });
    expect(off.frames).toHaveLength(0);

    const on = harness({ includePartialMessages: true });
    on.sink.onStreamEvent({ type: "message_start" });
    expect(subtypesOf(on.frames)).toEqual(["stream_event"]);
  });

  test("api_retry / rate_limit_event / auth_status / reasoning_summary are UNGATED", () => {
    // None of the four carries a gating option on the pin, so a host that never opts into
    // `stream_event` still receives every one of them.
    const { sink, frames } = harness();
    sink.onRetry({ attempt: 1, maxRetries: 10, retryDelayMs: 2000, errorStatus: 529, error: "overloaded" });
    sink.onRateLimit({ kind: "subscription-quota", info: { status: "allowed_warning" } });
    sink.onAuthStatus({ isAuthenticating: true, output: ["refreshing"] });
    sink.onReasoningSummary("considered two options");
    expect(subtypesOf(frames)).toEqual(["api_retry", "rate_limit_event", "auth_status", "reasoning_summary"]);
  });

  test("an absent retry status becomes NULL on the frame", () => {
    const { sink, frames } = harness();
    sink.onRetry({ attempt: 2, maxRetries: 10, retryDelayMs: 100, error: "server_error" });
    expect((frames[0] as { error_status: number | null }).error_status).toBeNull();
  });

  test("`ttft_ms` rides the FIRST stream_event and no other", () => {
    const { sink, frames } = harness({ includePartialMessages: true });
    sink.onStreamEvent({ type: "message_start" });
    sink.onStreamEvent({ type: "message_stop" });
    expect((frames[0] as { ttft_ms?: number }).ttft_ms).toBe(5);
    expect((frames[1] as { ttft_ms?: number }).ttft_ms).toBeUndefined();
  });

  test("a write that THROWS never breaks the generation -- a sink is an observation channel", () => {
    const sink = createStreamFrameSink({
      sessionId: "s",
      includePartialMessages: true,
      write: () => {
        throw new Error("host went away");
      },
      identity: () => undefined,
      model: () => "m",
    });
    expect(() => sink.onStreamEvent({ type: "message_start" })).not.toThrow();
    expect(() => sink.onRetry({ attempt: 1, maxRetries: 1, retryDelayMs: 0, error: "unknown" })).not.toThrow();
  });

  test("the identity is read LIVE, so a model switch between generations is reflected", () => {
    // Captured values would report the model the session STARTED on.
    let identity: { providerId?: string; modelKey?: string } | undefined = { providerId: "openai", modelKey: "openai/one" };
    const frames: SdkMessage[] = [];
    const sink = createStreamFrameSink({ sessionId: "s", includePartialMessages: false, write: (m) => frames.push(m), identity: () => identity, model: () => "fallback" });
    sink.onReasoningSummary("a");
    identity = { providerId: "openai", modelKey: "openai/two" };
    sink.onReasoningSummary("b");
    expect(frames.map((f) => (f as { model: string }).model)).toEqual(["openai/one", "openai/two"]);
  });
});

describe("item (b): `thinking_tokens` is digested from a thinking_delta, and is NOT gated", () => {
  test("it is emitted even with includePartialMessages OFF", () => {
    // Item (b) is explicit: "notably it is not tied to `includePartialMessages` … a host that never
    // opts into `stream_event` still gets thinking progress". The digest therefore runs BEFORE the
    // `stream_event` gate; reversing them would silently make thinking progress an opt-in feature.
    const { sink, frames } = harness({ includePartialMessages: false });
    sink.onStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "…", estimated_tokens: 40 } });
    expect(subtypesOf(frames)).toEqual(["thinking_tokens"]);
    expect(frames[0]).toMatchObject({ estimated_tokens: 40, estimated_tokens_delta: 40 });
    // …and no `stream_event` slipped through the gate alongside it.
    expect(subtypesOf(frames)).not.toContain("stream_event");
  });

  test("`estimated_tokens` is the RUNNING TOTAL and `_delta` this frame's increment", () => {
    const { sink, frames } = harness();
    for (const total of [10, 25, 60]) sink.onStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "…", estimated_tokens: total } });
    expect(frames.map((f) => [(f as { estimated_tokens: number }).estimated_tokens, (f as { estimated_tokens_delta: number }).estimated_tokens_delta])).toEqual([
      [10, 10],
      [25, 15],
      [60, 35],
    ]);
  });

  test("a NEW content block resets the running total -- 'the current thinking block', not the turn", () => {
    const { sink, frames } = harness();
    sink.onStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "…", estimated_tokens: 50 } });
    sink.onStreamEvent({ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "", signature: "" } });
    sink.onStreamEvent({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "…", estimated_tokens: 12 } });
    expect(frames.map((f) => (f as { estimated_tokens_delta: number }).estimated_tokens_delta)).toEqual([50, 12]);
  });

  test("Winter DIGESTS rather than invents: a thinking_delta with no estimated_tokens emits NOTHING", () => {
    // The pin's own mention of the field is second-hand (prose about a different type), so fabricating
    // a count from a delta's character length would invent a number the pinned surface never claims.
    const { sink, frames } = harness();
    sink.onStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "a long stretch of reasoning" } });
    sink.onStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } });
    expect(frames).toHaveLength(0);
  });

  test("a non-increasing report yields a ZERO delta, never a negative one", () => {
    const { sink, frames } = harness();
    sink.onStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "…", estimated_tokens: 30 } });
    sink.onStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "…", estimated_tokens: 20 } });
    expect((frames[1] as { estimated_tokens_delta: number }).estimated_tokens_delta).toBe(0);
  });
});
