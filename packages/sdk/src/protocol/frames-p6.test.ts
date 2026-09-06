// Phase 6 Task 3: codec fixtures for the P6 provider-facing frame family.
//
// Every frame below is a ROUND-TRIP fixture through the real codec (encodeFrame/decodeFrame), not a
// type-only assertion: a frame that type-checks but loses a field on the wire is exactly the class
// of defect a declaration test cannot see. The field sets are derived-shapes-p6.md item (b)'s, and
// each test names the shape fact it pins so a later edit that drops a field fails with a reason.
import { test, expect } from "bun:test";
import { encodeFrame, decodeFrame } from "./codec.ts";
import type { WinterFrame } from "./frames.ts";
import type {
  SDKAPIRetryMessage,
  SDKAssistantMessageError,
  SDKAuthStatusMessage,
  SDKContinuityWarningMessage,
  SDKModelRefusalFallbackMessage,
  SDKModelRefusalNoFallbackMessage,
  SDKModelSwitchMessage,
  SDKPartialAssistantMessage,
  SDKRateLimitEvent,
  SDKReasoningSummaryMessage,
  SDKThinkingTokensMessage,
  SdkMessage,
  WireContentBlock,
  WireStreamEvent,
} from "./frames.ts";

function roundTrip(message: SdkMessage): SdkMessage {
  const frame: WinterFrame = { type: "data", message };
  const decoded = decodeFrame(encodeFrame(frame).trimEnd()) as { type: "data"; message: SdkMessage };
  return decoded.message;
}

test("stream_event carries exactly the six pinned fields, with parent_tool_use_id present-and-null on the main thread", () => {
  // derived-shapes-p6.md (a): six fields plus the discriminant. `parent_tool_use_id` is
  // `string | null`, NOT optional -- a main-thread frame emits the key explicitly.
  const message: SDKPartialAssistantMessage = {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "he" } },
    parent_tool_use_id: null,
    uuid: "11111111-1111-4111-8111-111111111111",
    session_id: "s-1",
    ttft_ms: 42,
  };
  const back = roundTrip(message) as SDKPartialAssistantMessage;
  expect(back).toEqual(message);
  expect(Object.keys(back).sort()).toEqual(["event", "parent_tool_use_id", "session_id", "ttft_ms", "type", "uuid"]);
  expect("parent_tool_use_id" in back).toBe(true);
});

test("the stream-event union is the six pinned names and the four observed delta variants", () => {
  // Capture (F): exactly six `event.type` values reach a consumer, and four `delta.type` values are
  // forwarded verbatim. `ping` is deliberately NOT a member -- the runtime filters it.
  const events: WireStreamEvent[] = [
    { type: "message_start", message: { id: "m1", model: "winter-test/echo", role: "assistant", content: [] } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a" } },
    { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "t" } },
    { type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "sig" } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"a"' } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ];
  const names = [...new Set(events.map((e) => e.type))];
  expect(names).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
  for (const event of events) {
    const back = roundTrip({ type: "stream_event", event, parent_tool_use_id: null, uuid: "u", session_id: "s" }) as SDKPartialAssistantMessage;
    expect(back.event).toEqual(event);
  }
});

test("the wire content-block union covers the six captured shapes, including a blocks-valued tool_result", () => {
  // derived-shapes-p6.md (f): `tool_result.content` admits blocks, established from the pin's own
  // prose about its own Read tool ("extracted page images delivered solely as image blocks").
  const blocks: WireContentBlock[] = [
    { type: "text", text: "hi" },
    { type: "thinking", thinking: "reasoning", signature: "sig" },
    { type: "redacted_thinking", data: "opaque" },
    { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/tmp/x" } },
    { type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }] },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
  ];
  const back = roundTrip({ type: "assistant", message: { content: blocks } }) as { message: { content: WireContentBlock[] } };
  expect(back.message.content).toEqual(blocks);
});

test("api_retry carries all nine keys, error_status is null-able, and error is the closed 11-member union", () => {
  const taxonomy: SDKAssistantMessageError[] = [
    "authentication_failed",
    "oauth_org_not_allowed",
    "account_on_hold",
    "billing_error",
    "rate_limit",
    "overloaded",
    "invalid_request",
    "model_not_found",
    "server_error",
    "unknown",
    "max_output_tokens",
  ];
  expect(taxonomy).toHaveLength(11);
  const message: SDKAPIRetryMessage = {
    type: "system",
    subtype: "api_retry",
    attempt: 1,
    max_retries: 10,
    retry_delay_ms: 2000,
    error_status: null, // a connection error with no HTTP response
    error: "server_error",
    uuid: "u",
    session_id: "s",
  };
  const back = roundTrip(message) as SDKAPIRetryMessage;
  expect(back).toEqual(message);
  expect(Object.keys(back).sort()).toEqual(["attempt", "error", "error_status", "max_retries", "retry_delay_ms", "session_id", "subtype", "type", "uuid"]);
});

test("rate_limit_event is a TOP-LEVEL type, not a system subtype", () => {
  // derived-shapes-p6.md (b): `type: 'rate_limit_event'`, unlike api_retry/status/thinking_tokens.
  // R6-B: Winter emits it ONLY for subscription-shaped quota, never for an HTTP 429.
  const message: SDKRateLimitEvent = {
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", resetsAt: 1_800_000_000, utilization: 0.87 },
    uuid: "u",
    session_id: "s",
  };
  const back = roundTrip(message) as SDKRateLimitEvent;
  expect(back).toEqual(message);
  expect(back.type).toBe("rate_limit_event");
  expect((back as { subtype?: unknown }).subtype).toBeUndefined();
});

test("auth_status is a top-level type and a login-flow progress channel", () => {
  const message: SDKAuthStatusMessage = { type: "auth_status", isAuthenticating: true, output: ["opening browser"], uuid: "u", session_id: "s" };
  const back = roundTrip(message) as SDKAuthStatusMessage;
  expect(back).toEqual(message);
  expect(back.type).toBe("auth_status");
});

test("thinking_tokens carries the running total and this frame's increment", () => {
  const message: SDKThinkingTokensMessage = { type: "system", subtype: "thinking_tokens", estimated_tokens: 120, estimated_tokens_delta: 20, uuid: "u", session_id: "s" };
  expect(roundTrip(message)).toEqual(message);
});

test("the refusal pair: trigger is the one-member literal 'refusal', and the no-fallback arm has no fallback_model", () => {
  const withFallback: SDKModelRefusalFallbackMessage = {
    type: "system",
    subtype: "model_refusal_fallback",
    trigger: "refusal",
    direction: "retry",
    scope: "session",
    original_model: "a/one",
    fallback_model: "a/two",
    request_id: null,
    content: "the model declined",
    uuid: "u",
    session_id: "s",
  };
  expect(roundTrip(withFallback)).toEqual(withFallback);

  const noFallback: SDKModelRefusalNoFallbackMessage = {
    type: "system",
    subtype: "model_refusal_no_fallback",
    trigger: "refusal",
    original_model: "a/one",
    request_id: null,
    content: "the model declined",
    uuid: "u",
    session_id: "s",
  };
  const back = roundTrip(noFallback) as Record<string, unknown>;
  expect(back).toEqual(noFallback as unknown as Record<string, unknown>);
  expect("fallback_model" in back).toBe(false);
});

test("the Winter-only reasoning_summary frame carries the summary OUT of the transcript (R6-8)", () => {
  const message: SDKReasoningSummaryMessage = { type: "system", subtype: "reasoning_summary", text: "considered two options", provider: "openai", model: "openai/o-test", uuid: "u", session_id: "s" };
  expect(roundTrip(message)).toEqual(message);
});

test("the Winter-only model_switch frame names the reason and the two models (R6-C)", () => {
  const message: SDKModelSwitchMessage = { type: "system", subtype: "model_switch", reason: "fallback", from_model: "a/one", to_model: "a/two", provider: "a", uuid: "u", session_id: "s" };
  const back = roundTrip(message) as SDKModelSwitchMessage;
  expect(back).toEqual(message);
  expect(back.reason).toBe("fallback");
});

test("the Winter-only continuity_warning frame reports a degraded resume without naming opaque state", () => {
  const message: SDKContinuityWarningMessage = {
    type: "system",
    subtype: "continuity_warning",
    warning: "provider_state_missing",
    detail: "1 assistant message has no origin record; it was degraded to summary-level.",
    uuid: "u",
    session_id: "s",
  };
  expect(roundTrip(message)).toEqual(message);
});

test("the fix wave's two continuity_warning values round-trip: cross_domain_replay_dropped (a lossy switch) and child_provider_refused (an R6-17 child with no credential of its own)", () => {
  for (const warning of ["cross_domain_replay_dropped", "child_provider_refused"] as const) {
    const message: SDKContinuityWarningMessage = {
      type: "system",
      subtype: "continuity_warning",
      warning,
      detail: "counts and identity only",
      uuid: "u",
      session_id: "s",
    };
    expect(roundTrip(message)).toEqual(message);
  }
});

test("a provider failure that ends a turn rides result.subtype 'success' with is_error and api_error_status (R6-F)", () => {
  const message: SdkMessage = {
    type: "result",
    subtype: "success",
    is_error: true,
    result: "provider request failed",
    terminal_reason: "api_error",
    api_error_status: 529,
    permission_denials: [],
  };
  const back = roundTrip(message) as { subtype: string; is_error: boolean; terminal_reason: string; api_error_status: number | null };
  expect(back.subtype).toBe("success");
  expect(back.is_error).toBe(true);
  expect(back.terminal_reason).toBe("api_error");
  expect(back.api_error_status).toBe(529);
});

test("api_error_status is null-able for a connection error with no HTTP response", () => {
  const back = roundTrip({ type: "result", subtype: "success", is_error: true, terminal_reason: "api_error", api_error_status: null, permission_denials: [] }) as { api_error_status: number | null };
  expect(back.api_error_status).toBeNull();
});
