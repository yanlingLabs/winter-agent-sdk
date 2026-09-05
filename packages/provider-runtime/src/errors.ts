// Provider error normalization. FROZEN as of P6 T2's merge (R6-12).
//
// Ported and conformed from Norma's `packages/core/src/providers/{errors.ts,openai-compatible.ts}`
// (`parseProviderErrorCode`, `mapHttpError`), with Winter names and three changes the port needed:
//
//   1. THREE DIALECTS, not one. Norma's parser reads OpenAI's `error.code`. Anthropic has no `code`
//      at all — its machine-readable value is `error.type` (`overloaded_error`, `rate_limit_error`,
//      `not_found_error`, …) — and Gemini's `error.code` is the NUMERIC http status with the real
//      value in `error.status` (`RESOURCE_EXHAUSTED`). Requiring a STRING `code` is what makes the
//      fallthrough work by type rather than by sniffing which provider answered.
//   2. `retryable` is computed here rather than left to a caller (R6-6's list: 408/409/429/5xx plus
//      network/timeout), so exactly one place decides it.
//   3. `toSdkAssistantMessageError` maps Winter's coarse taxonomy onto the pin's CLOSED 11-member
//      `SDKAssistantMessageError` (`sdk.d.ts:3159`), because that union is what `api_retry.error`
//      and `SDKAssistantMessage.error` carry.
//
// The load-bearing Norma finding is carried over intact: the provider's structured code is parsed
// off the **FULL body, BEFORE the 200-char cap**. The OpenAI envelope puts `code` after an unbounded
// human `message`, so on a real context-overflow body the cap slices away exactly the field a
// consumer wants.

import { scanForSecrets } from "@yanlinglabs/winter-provider-catalog";
import type { ProviderError, SdkAssistantMessageError } from "./types.ts";

/** The body snippet embedded in a normalized message. Norma's own value, kept: enough to diagnose, short enough to log. */
const BODY_SNIPPET_CHARS = 200;

/** A stream that produced no bytes for `providerStallTimeoutMs`. Thrown by `parseSse`; NOT retryable (bytes may already have been consumed — R6-6 forbids replaying an effectful turn). */
export class ProviderStallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderStallError";
  }
}

/**
 * Lifts the provider's STRUCTURED error code out of a raw HTTP error body, across the three
 * dialects Winter speaks. Never throws and never guesses: a non-JSON body (an HTML 502 page), a
 * body with no envelope, or a non-string value all yield `undefined`.
 */
export function parseProviderErrorCode(body: string): string | undefined {
  if (!body) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const err = (parsed as { error?: unknown }).error;
  if (err === null || typeof err !== "object") return undefined;
  const envelope = err as { code?: unknown; type?: unknown; status?: unknown };
  for (const candidate of [envelope.code, envelope.type, envelope.status]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

/**
 * Parses a `Retry-After` header in either RFC 7231 form: delta-seconds, or an HTTP-date.
 *
 * Returns `undefined` — never `0` — for anything unusable, including a past date and a
 * non-positive delta. That distinction matters downstream: `0` reads as "retry immediately", a
 * different instruction from "the header told us nothing", which must fall through to the computed
 * backoff.
 */
export function parseRetryAfterMs(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  // Delta-seconds first: a bare integer is unambiguous, and `Date.parse("2")` is not reliably NaN
  // across engines, so trying the date form first would misread it.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  const delta = at - now;
  return delta > 0 ? delta : undefined;
}

/** Provider codes that mean "the account cannot pay", not "you are going too fast" — the distinction is what makes a 429 unretryable. */
const BILLING_CODES = new Set(["insufficient_quota", "billing_hard_limit_reached", "billing_not_active", "credit_balance_too_low"]);
/** Provider codes (any dialect) that mean the model id does not exist. */
const MODEL_NOT_FOUND_CODES = new Set(["model_not_found", "not_found_error", "NOT_FOUND", "model_not_supported"]);
/** Provider codes that mean the request asked for more output than the model allows. */
const MAX_OUTPUT_CODES = new Set(["max_tokens_exceeded", "max_output_tokens_exceeded", "string_above_max_length"]);
/** Provider codes that mean the upstream is overloaded rather than broken. */
const OVERLOADED_CODES = new Set(["overloaded_error", "overloaded", "server_overloaded", "UNAVAILABLE"]);

/**
 * The five-way HTTP map, plus `retryable` and `retryAfterMs`.
 *
 * `retryable` follows R6-6's list — 408/409/429/5xx — and is deliberately ORTHOGONAL to `code`: 409
 * is a client-class status whose Winter code is `bad_request`, and it is on the retry list anyway
 * because provider conflicts are routinely transient. The one place the two interact is a 429 whose
 * provider code names a billing exhaustion, which no amount of backoff fixes.
 */
/**
 * The body snippet, scrubbed.
 *
 * A provider's error body is not guaranteed innocuous: a 401 routinely echoes part of the
 * credential it rejected, and a 400 echoes the offending request back. `ProviderError.message` is
 * one of the most reliably-logged strings in the system, so anything credential-shaped is replaced
 * WHOLESALE rather than partially masked — a partial mask still discloses length and prefix, and
 * the snippet is a diagnostic aid, not evidence worth preserving at that cost.
 *
 * Reuses the catalog's own exported scanner, so the definition of "credential-shaped" is the same
 * one the catalog gate enforces and cannot drift into a second, weaker copy here.
 */
function scrubbedSnippet(body: string): string {
  const snippet = body.slice(0, BODY_SNIPPET_CHARS);
  if (snippet.length === 0) return "";
  return scanForSecrets(snippet).length > 0 ? "[redacted: the provider's error body contained a credential-shaped string]" : snippet;
}

export function normalizeHttpError(status: number, headers: Headers, body: string): ProviderError {
  // Parsed off the FULL body BEFORE both the cap and the scrub: the structured code is the one part
  // of the body a consumer needs, and it is never itself a credential.
  const providerCode = parseProviderErrorCode(body);
  const snippet = scrubbedSnippet(body);
  const message = `HTTP ${status}${snippet.length > 0 ? ` — ${snippet}` : ""}`;
  const retryAfterMs = parseRetryAfterMs(headers.get("retry-after"));

  // Spread as optionals so an error with no structured code / no Retry-After keeps a minimal shape
  // (exactOptionalPropertyTypes is on: an absent key, never an explicit undefined).
  const extra = {
    ...(providerCode !== undefined ? { providerCode } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };

  if (status === 401 || status === 403) return { code: "auth", message, status, retryable: false, ...extra };
  if (status === 429) {
    const billing = providerCode !== undefined && BILLING_CODES.has(providerCode);
    return { code: "rate_limit", message, status, retryable: !billing, ...extra };
  }
  if (status === 408) return { code: "timeout", message, status, retryable: true, ...extra };
  if (status >= 500) return { code: "server", message, status, retryable: true, ...extra };
  if (status >= 400) return { code: "bad_request", message, status, retryable: status === 409, ...extra };
  // A non-error status reaching here is a caller bug, not a provider condition; it is still typed
  // rather than thrown, so one mis-wired call site cannot take a stream down.
  return { code: "server", message: `${message} (unexpected non-error status)`, status, retryable: false, ...extra };
}

/** True for anything already shaped as a normalized `ProviderError`. */
export function isProviderError(value: unknown): value is ProviderError {
  if (value === null || typeof value !== "object") return false;
  const v = value as { code?: unknown; message?: unknown; retryable?: unknown };
  return typeof v.code === "string" && typeof v.message === "string" && typeof v.retryable === "boolean";
}

/**
 * Normalizes anything thrown by a transport into a `ProviderError`.
 *
 * The two NOT-retryable transport cases are the load-bearing ones: an abort is a deliberate
 * cancellation (retrying it would resurrect a turn the caller stopped), and a stall means bytes
 * already flowed — R6-6 forbids replaying an effectful turn once a response has begun.
 */
export function normalizeThrown(err: unknown): ProviderError {
  if (isProviderError(err)) return err;
  if (err instanceof ProviderStallError) return { code: "stall", message: err.message, retryable: false };
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return err.name === "AbortError"
      ? { code: "aborted", message: err.message, retryable: false }
      : { code: "timeout", message: err.message, retryable: true };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: "network", message, retryable: true };
}

/**
 * Maps a normalized Winter error onto the pin's CLOSED 11-member `SDKAssistantMessageError`
 * (`sdk.d.ts:3159`) — the value `api_retry.error` and `SDKAssistantMessage.error` carry.
 *
 * Two members have NO WINTER PRODUCER and that is recorded rather than faked:
 * `oauth_org_not_allowed` and `account_on_hold` describe first-party subscription states that a
 * provider-API session cannot be in. Nothing here ever returns them; if a codex-oauth quota state
 * ever needs one, it comes from that adapter's own quota manager, not from an HTTP status.
 *
 * Transport failures (`network`/`timeout`/`stall`/`aborted`/`capability`) collapse to `unknown`.
 * The pinned union has no transport member — the pin represents that case with
 * `api_retry.error_status: null` while `error` still has to be one of the eleven — so `unknown` is
 * the honest bucket rather than a stretched `server_error`.
 */
export function toSdkAssistantMessageError(err: ProviderError): SdkAssistantMessageError {
  const code = err.providerCode;
  switch (err.code) {
    case "auth":
      return "authentication_failed";
    case "rate_limit":
      return code !== undefined && BILLING_CODES.has(code) ? "billing_error" : "rate_limit";
    case "server":
      // 529 is Anthropic's overloaded status, and capture (G) observed exactly this mapping
      // (`error_status: 529`, `error: "overloaded"`).
      if (err.status === 529) return "overloaded";
      if (code !== undefined && OVERLOADED_CODES.has(code)) return "overloaded";
      return "server_error";
    case "bad_request":
      // 402 Payment Required is a BILLING state, not a malformed request — telling a user their
      // request was invalid when their card expired sends them to debug the wrong thing entirely.
      if (err.status === 402) return "billing_error";
      if (code !== undefined && MODEL_NOT_FOUND_CODES.has(code)) return "model_not_found";
      if (code !== undefined && MAX_OUTPUT_CODES.has(code)) return "max_output_tokens";
      if (code !== undefined && BILLING_CODES.has(code)) return "billing_error";
      return "invalid_request";
    case "network":
    case "timeout":
    case "stall":
    case "aborted":
    case "capability":
      return "unknown";
  }
}
