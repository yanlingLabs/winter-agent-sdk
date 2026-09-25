// Provider error normalization. FROZEN as of P6 T2's merge (R6-12).
//
// Ported and conformed from Norma's `packages/core/src/providers/{errors.ts,openai-compatible.ts}`
// (`parseProviderErrorCode`, `mapHttpError`), with Winter names and three changes the port needed:
//
//   1. THREE DIALECTS, not one. Norma's parser reads OpenAI's `error.code`. Anthropic has no `code`
//      at all — its machine-readable value is `error.type` (`overloaded_error`, `rate_limit_error`,
//      `not_found_error`, …) — and Gemini's `error.code` is the NUMERIC http status with the real
//      value in `error.status` (`RESOURCE_EXHAUSTED`). Requiring a STRING `code` is what makes the
//      fallthrough work by type rather than by sniffing which provider answered. WS-23 added a
//      fourth, ADDITIVELY: xAI's flat `{code, error: "<message>"}` (`parseFlatError`), recognised only
//      when `error` is a string, so the three structured envelopes read exactly as they did.
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
  // xAI's FLAT dialect (WS-23; see `parseFlatError`): `error` is the message itself, and the code, when
  // there is one, is the TOP-LEVEL `code`. Reached only when `error` is a string, so the structured
  // envelope below — OpenAI's, Anthropic's, Gemini's — is read exactly as before.
  if (typeof err === "string") return parseFlatError(body)?.code;
  if (err === null || typeof err !== "object") return undefined;
  const envelope = err as { code?: unknown; type?: unknown; status?: unknown };
  for (const candidate of [envelope.code, envelope.type, envelope.status]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

/**
 * xAI's FLAT error body — a fourth dialect, added in WS-23 when the api-key `xai` provider moved onto
 * the Responses adapter: `{"code": "<status text>", "error": "<message>"}`, where `error` is the human
 * message ITSELF rather than OpenAI's `{message, type, code}` object. Observed from `api.x.ai`
 * (a live 400 quoted verbatim at forum.cursor.com/t/grok-code-broken/142879:
 * `{"code":"Client specified an invalid argument","error":"Incorrect API key provided: sk***kA. …"}`)
 * and from xAI's subscription proxy (`{"error":"Invalid or expired credentials …"}`, no `code`;
 * packages/conformance/compat/xai/grok-build/derived-shapes-p6b-xai.md §4). xAI documents HTTP
 * status meanings only, never a body schema (https://docs.x.ai/developers/debugging).
 *
 * `code` there is a gRPC status DESCRIPTION ("Client specified an invalid argument" is
 * INVALID_ARGUMENT's), carried verbatim as `providerCode` like every other dialect's code — never
 * translated into a name the body did not send.
 *
 * `undefined` for anything that is not EXACTLY this shape — the keys are `{error}` or `{error, code}`
 * and nothing else (fix round 1, I1). A string `error` alone is not enough: a Fastify-style body
 * (`{statusCode, code, error: "Bad Request", message: "<the real detail>"}`) also has one, and reading
 * it as this dialect replaced the raw-body snippet with the bare reason phrase, dropping the detail
 * for every adapter that shares this normalizer. Anything else keeps the pre-WS-23 reading.
 */
function parseFlatError(body: string): { message: string; code?: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as { error?: unknown; code?: unknown };
  if (typeof record.error !== "string" || record.error.length === 0) return undefined;
  if (Object.keys(record).some((key) => key !== "error" && key !== "code")) return undefined;
  return { message: record.error, ...(typeof record.code === "string" && record.code.length > 0 ? { code: record.code } : {}) };
}

/**
 * xAI answers a WRONG KEY with HTTP 400, not 401 — the live body quoted at `parseFlatError` is a 400
 * — reusing OpenAI's own sentence for it ("Incorrect API key provided", which OpenAI sends as a 401).
 * By status alone that is `bad_request`, which tells a user their request was malformed when their
 * key is wrong, and makes `validateViaModels` report an unreachable endpoint instead of an invalid
 * credential. Matched ONLY on the flat dialect and only when the message BEGINS with this sentence
 * (fix round 1, I2: unanchored, a 400 quoting the phrase mid-message — an invalid tool name, a
 * validation error echoing input — was misread as a credential failure). A message heuristic, kept as
 * narrow as the evidence it rests on (three independent reports of the same body), and a live-gate
 * item (the WS-23 probe's bad-key step).
 */
function isFlatCredentialRejection(status: number, flat: { message: string } | undefined): boolean {
  return status === 400 && flat !== undefined && /^\s*incorrect api key provided\b/i.test(flat.message);
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
const BILLING_CODES = new Set([
  "insufficient_quota", "billing_hard_limit_reached", "billing_not_active", "credit_balance_too_low",
  // ChatGPT Codex backend (measured 2026-09-16): a subscription's usage window is exhausted and resets on a
  // clock the body names (`resets_in_seconds`). Ten backed-off retries cannot help and cost the user ~90 s
  // of silence before the truth surfaced; it is terminal like the billing codes above.
  "usage_limit_reached", "usage_limit_exceeded",
]);

/** The Codex backend's usage-window fields, when the body carries them (`resets_in_seconds`, `plan_type`). */
function parseUsageWindow(body: string): { resetsInSeconds?: number; planType?: string } {
  try {
    const parsed = JSON.parse(body) as { error?: { resets_in_seconds?: unknown; plan_type?: unknown } };
    const e = parsed?.error;
    if (!e || typeof e !== "object") return {};
    return {
      ...(typeof e.resets_in_seconds === "number" && Number.isFinite(e.resets_in_seconds) ? { resetsInSeconds: e.resets_in_seconds } : {}),
      ...(typeof e.plan_type === "string" ? { planType: e.plan_type } : {}),
    };
  } catch {
    return {};
  }
}
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
  if (body.length === 0) return "";
  // Scanned on the FULL body, BEFORE truncation. Truncating first is worse than not scanning at
  // all in one specific way: a key straddling the 200-char boundary leaves only its PREFIX in the
  // snippet, and the scanner's patterns are length-based, so the partial no longer matches — the
  // truncation turns a detectable secret into an undetectable fragment that still discloses the
  // key's prefix (verified: a body ending `…zzzsk-proj-Ab` passed the snippet-only scan).
  //
  // On any hit the whole snippet goes, not just the matching span: a partial mask still discloses
  // length and prefix, and the snippet is a diagnostic aid rather than evidence worth that cost.
  if (scanForSecrets(body).length > 0) return "[redacted: the provider's error body contained a credential-shaped string]";
  return body.slice(0, BODY_SNIPPET_CHARS);
}

/**
 * Removes EXACT occurrences of a request's OWN credential material from a provider error body.
 *
 * HOISTED HERE from the Bedrock adapter (T2 carry), because the gap it closes is not Bedrock's.
 * `scrubbedSnippet` scrubs a body whose contents `scanForSecrets` RECOGNISES, and that scanner is
 * pattern-based: it knows `sk-`, `AKIA…`, `AIza…`, a PEM block. What it cannot know is a credential
 * with no recognisable shape — an AWS SECRET access key is forty base64-ish characters, and no
 * pattern could match that without matching arbitrary prose of the same length. Such a value echoed
 * back by an endpoint survives verbatim into `ProviderError.message`, one of the most
 * reliably-logged strings in the system, and the next family's shapeless token will do the same.
 *
 * Exact matching against the material THIS request actually carried is the complement: precise (no
 * false positives, unlike a "40 base64-ish characters" heuristic) and family-agnostic, because the
 * caller names its own secrets rather than this file guessing their shape. Belt and braces — the
 * pattern scan still runs, and either one alone leaves the other's blind spot reachable.
 */
export function redactCredentialMaterial(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    // Short values are skipped: a two-character "secret" would rewrite unrelated prose, and no real
    // credential component is that short.
    if (secret.length < 8) continue;
    out = out.split(secret).join("***");
  }
  return out;
}

/**
 * @param secrets Credential material THIS request carried, redacted from the body by exact match
 *   before the snippet is taken. Optional and empty by default: a family with nothing to declare
 *   passes nothing and gets exactly the previous behaviour.
 */
export function normalizeHttpError(status: number, headers: Headers, body: string, secrets: readonly string[] = []): ProviderError {
  // Parsed off the FULL, UNREDACTED body BEFORE the redaction, the cap and the scrub: the structured
  // code is the one part of the body a consumer needs, it is never itself a credential, and reading
  // it after a redaction pass would risk losing it to a coincidental overlap.
  const providerCode = parseProviderErrorCode(body);
  // The flat dialect's `error` IS the human message, so it is what the snippet shows — the whole body
  // would spend the 200-char budget on the JSON punctuation and the status text first. Same redaction
  // and scrub as the body gets. Every other dialect keeps the raw-body snippet, byte for byte.
  const flat = parseFlatError(body);
  const snippet = scrubbedSnippet(redactCredentialMaterial(flat?.message ?? body, secrets));
  const usage = status === 429 && providerCode !== undefined && providerCode.startsWith("usage_limit") ? parseUsageWindow(body) : {};
  const resetNote = usage.resetsInSeconds !== undefined ? ` — resets in ${Math.ceil(usage.resetsInSeconds / 60)} min` : "";
  const message = usage.resetsInSeconds !== undefined || usage.planType !== undefined
    ? `HTTP ${status} — usage limit reached${usage.planType !== undefined ? ` (plan: ${usage.planType})` : ""}${resetNote}`
    : `HTTP ${status}${snippet.length > 0 ? ` — ${snippet}` : ""}`;
  // `Retry-After` stays authoritative when the provider sends it; the body's own reset clock is the fallback.
  const retryAfterMs = parseRetryAfterMs(headers.get("retry-after")) ?? (usage.resetsInSeconds !== undefined ? usage.resetsInSeconds * 1000 : undefined);

  // Spread as optionals so an error with no structured code / no Retry-After keeps a minimal shape
  // (exactOptionalPropertyTypes is on: an absent key, never an explicit undefined).
  const extra = {
    ...(providerCode !== undefined ? { providerCode } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };

  if (status === 401 || status === 403 || isFlatCredentialRejection(status, flat)) return { code: "auth", message, status, retryable: false, ...extra };
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
