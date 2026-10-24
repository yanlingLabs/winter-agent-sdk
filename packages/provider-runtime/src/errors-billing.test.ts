// 0.0.57: `ProviderError.code: "billing"` -- the account cannot pay -- across the dialects, at HTTP time
// and mid-stream, never retried, and with the message built exactly as before.
import { describe, expect, test } from "bun:test";
import { normalizeHttpError, toSdkAssistantMessageError } from "./errors.ts";
import { createRetryPolicy, withRetry } from "./retry.ts";
import { streamErrorFrame } from "./adapters/anthropic/messages.ts";
import { ChatStreamMapper } from "./adapters/openai/chat-completions.ts";

const h = (init: Record<string, string> = {}) => new Headers(init);
const ANTHROPIC_CREDIT = "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
const anthropicCreditBody = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: ANTHROPIC_CREDIT }, request_id: "req_synthetic" });

describe("billing at HTTP time (normalizeHttpError)", () => {
  test("Anthropic direct: the 400 invalid_request_error whose message is the credit sentence", () => {
    const err = normalizeHttpError(400, h(), anthropicCreditBody);
    expect([err.code, err.status, err.retryable, err.providerCode]).toEqual(["billing", 400, false, "invalid_request_error"]);
    expect(toSdkAssistantMessageError(err)).toBe("billing_error");
    // The message is built exactly as before (status + the redacted, capped body snippet).
    expect(err.message.startsWith("HTTP 400 — ")).toBe(true);
    expect(err.message).toContain("credit balance is too low");
  });

  test("redaction is unchanged on a billing error: a secret echoed in the body never reaches the message", () => {
    const secret = "sk-ant-synthetic-0123456789abcdef";
    const body = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `${ANTHROPIC_CREDIT} key=${secret}` } });
    const err = normalizeHttpError(400, h(), body, [secret]);
    expect(err.code).toBe("billing");
    expect(err.message).not.toContain(secret);
  });

  test("Anthropic billing_error (402) and any bare 402 are billing", () => {
    expect(normalizeHttpError(402, h(), JSON.stringify({ type: "error", error: { type: "billing_error", message: "Payment failed." } })).code).toBe("billing");
    expect(normalizeHttpError(402, h(), "").code).toBe("billing");
  });

  test("OpenRouter: 402 payment_required, and Anthropic's credit refusal passed through in metadata.raw (string or object)", () => {
    expect(normalizeHttpError(402, h(), JSON.stringify({ error: { code: 402, message: "Insufficient credits. Add more using https://openrouter.ai/settings/credits", metadata: { error_type: "payment_required" } } })).code).toBe("billing");
    const passString = JSON.stringify({ error: { code: 400, message: "Provider returned error", metadata: { provider_name: "Anthropic", raw: anthropicCreditBody } } });
    const passObject = JSON.stringify({ error: { code: 400, message: "Provider returned error", metadata: { provider_name: "Anthropic", raw: JSON.parse(anthropicCreditBody) } } });
    const passCode = JSON.stringify({ error: { code: 400, message: "Provider returned error", metadata: { provider_name: "Anthropic", provider_code: "billing_error" } } });
    for (const body of [passString, passObject, passCode]) expect(normalizeHttpError(400, h(), body).code).toBe("billing");
  });

  test("OpenRouter's in-flight-budget 402 WITH Retry-After is a wait (rate_limit, retryable), not billing", () => {
    const err = normalizeHttpError(402, h({ "retry-after": "3" }), JSON.stringify({ error: { code: 402, message: "In-flight budget", metadata: { limit_source: "openrouter_in_flight_budget" } } }));
    expect([err.code, err.retryable, err.retryAfterMs]).toEqual(["rate_limit", true, 3000]);
  });

  test("OpenAI: insufficient_quota and its siblings (code or type) are billing at 429", () => {
    for (const error of [
      { code: "insufficient_quota", type: "insufficient_quota" },
      { code: "credit_balance_exhausted", type: "insufficient_quota" },
      { code: "organization_spend_limit_exceeded" },
      { code: "project_spend_limit_exceeded" },
      { code: "organization_usage_limit_exceeded" },
      { type: "insufficient_quota" },
    ]) {
      const err = normalizeHttpError(429, h(), JSON.stringify({ error: { message: "You exceeded your current quota.", ...error } }));
      expect([JSON.stringify(error), err.code, err.retryable]).toEqual([JSON.stringify(error), "billing", false]);
    }
  });

  test("NOT billing: a subscription usage window (still rate_limit, terminal), an ordinary 429, a 400 that only mentions credit elsewhere, a 5xx", () => {
    const window = normalizeHttpError(429, h(), JSON.stringify({ error: { code: "usage_limit_reached", resets_in_seconds: 60 } }));
    expect([window.code, window.retryable, toSdkAssistantMessageError(window)]).toEqual(["rate_limit", false, "billing_error"]);
    expect(normalizeHttpError(429, h(), JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } })).code).toBe("rate_limit");
    expect(normalizeHttpError(400, h(), JSON.stringify({ error: { type: "invalid_request_error", message: "bad field" }, echo: "credit balance is too low" })).code).toBe("bad_request");
    expect(normalizeHttpError(500, h(), anthropicCreditBody).code).toBe("server");
  });

  test("billing is never retried", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw normalizeHttpError(400, h(), anthropicCreditBody);
        },
        createRetryPolicy({ maxRetries: 5, baseDelayMs: 1, sleep: async () => {} } as never),
        () => {},
      ),
    ).rejects.toBeDefined();
    expect(calls).toBe(1);
  });
});

describe("billing mid-stream", () => {
  test("Anthropic error frames: billing_error, and invalid_request_error carrying the credit sentence", () => {
    expect(streamErrorFrame({ type: "billing_error", message: "Payment failed." }).code).toBe("billing");
    expect(streamErrorFrame({ type: "invalid_request_error", message: ANTHROPIC_CREDIT }).code).toBe("billing");
    expect(streamErrorFrame({ type: "invalid_request_error", message: "bad field" }).code).toBe("bad_request");
  });

  test("OpenRouter's mid-stream error event: numeric code 402, or metadata.error_type payment_required", () => {
    const at = (error: Record<string, unknown>) => new ChatStreamMapper(false).map(JSON.stringify({ id: "gen", object: "chat.completion.chunk", error, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] }))[0];
    expect(at({ code: 402, message: "Insufficient credits" })).toMatchObject({ type: "error", error: { code: "billing", retryable: false } });
    expect(at({ code: 400, message: "Provider returned error", metadata: { error_type: "payment_required" } })).toMatchObject({ error: { code: "billing" } });
    expect(at({ code: 502, message: "upstream broke", metadata: { error_type: "provider_unavailable" } })).toMatchObject({ error: { code: "server" } });
  });
});
