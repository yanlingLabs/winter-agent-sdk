import { describe, expect, test } from "bun:test";
import { scanForSecrets } from "@yanlinglabs/winter-provider-catalog";
import {
  ProviderStallError,
  normalizeHttpError,
  normalizeThrown,
  parseProviderErrorCode,
  parseRetryAfterMs,
  toSdkAssistantMessageError,
} from "./errors.ts";

const h = (init: Record<string, string> = {}): Headers => new Headers(init);

describe("parseProviderErrorCode — three dialects, one function", () => {
  test("OpenAI: error.code", () => {
    expect(parseProviderErrorCode(JSON.stringify({ error: { message: "too long", type: "invalid_request_error", code: "context_length_exceeded" } }))).toBe("context_length_exceeded");
  });

  test("Anthropic: error.type, because Anthropic has no `code`", () => {
    expect(parseProviderErrorCode(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }))).toBe("overloaded_error");
  });

  test("Gemini: error.status, because Gemini's error.code is the NUMERIC http status", () => {
    // Requiring a STRING `code` is what makes the fallthrough work: Gemini's `code: 429` is skipped
    // by type, not by a provider-sniffing special case.
    expect(parseProviderErrorCode(JSON.stringify({ error: { code: 429, message: "quota", status: "RESOURCE_EXHAUSTED" } }))).toBe("RESOURCE_EXHAUSTED");
  });

  test("never throws and never guesses", () => {
    for (const body of ["", "not json", "<html>502 Bad Gateway</html>", "null", "[]", JSON.stringify({ error: "a string" }), JSON.stringify({ error: { code: 500 } })]) {
      expect(parseProviderErrorCode(body)).toBeUndefined();
    }
  });

  test("is parsed off the FULL body, before any truncation", () => {
    // The envelope puts the machine-readable code AFTER an unbounded human message, so a body
    // truncated to 200 chars loses exactly the field a consumer wants. This is the Norma finding
    // this port carries over verbatim.
    const long = "x".repeat(4000);
    const body = JSON.stringify({ error: { message: long, type: "invalid_request_error", code: "context_length_exceeded" } });
    const err = normalizeHttpError(400, h(), body);
    expect(err.providerCode).toBe("context_length_exceeded");
    expect(err.message.length).toBeLessThan(300);
  });
});

describe("parseRetryAfterMs", () => {
  test("reads the delta-seconds form", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs(" 30 ")).toBe(30000);
  });

  test("reads the HTTP-date form, relative to now", () => {
    const at = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfterMs(at);
    expect(ms).toBeGreaterThan(3000);
    expect(ms).toBeLessThanOrEqual(6000);
  });

  test("a past date, zero, a negative and junk are all ABSENT rather than zero", () => {
    // Returning 0 would read as "retry immediately", which is a different instruction from "the
    // header told us nothing" — the latter must fall through to the computed backoff.
    for (const value of ["0", "-5", "soon", "", new Date(Date.now() - 60_000).toUTCString()]) {
      expect(parseRetryAfterMs(value)).toBeUndefined();
    }
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });
});

describe("normalizeHttpError — the five-way map plus retryability", () => {
  test("401/403 are auth and NOT retryable", () => {
    for (const status of [401, 403]) {
      const err = normalizeHttpError(status, h(), "");
      expect(err.code).toBe("auth");
      expect(err.retryable).toBe(false);
      expect(err.status).toBe(status);
    }
  });

  test("429 is rate_limit, retryable, and carries Retry-After verbatim", () => {
    const err = normalizeHttpError(429, h({ "retry-after": "2" }), JSON.stringify({ error: { type: "rate_limit_error" } }));
    expect(err.code).toBe("rate_limit");
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(2000);
    expect(err.providerCode).toBe("rate_limit_error");
  });

  test("a 429 whose provider code is a BILLING exhaustion is not retryable", () => {
    // `insufficient_quota` means the account is out of credit. Ten exponentially-backed-off retries
    // cannot fix that; they just delay the error the user needs to see by ~90 seconds.
    const err = normalizeHttpError(429, h(), JSON.stringify({ error: { code: "insufficient_quota", message: "quota" } }));
    expect(err.code).toBe("rate_limit");
    expect(err.retryable).toBe(false);
    expect(toSdkAssistantMessageError(err)).toBe("billing_error");
  });

  test("408 and 409 are retryable (R6-6's list), other 4xx are not", () => {
    expect(normalizeHttpError(408, h(), "").retryable).toBe(true);
    expect(normalizeHttpError(409, h(), "").retryable).toBe(true);
    expect(normalizeHttpError(400, h(), "").retryable).toBe(false);
    expect(normalizeHttpError(404, h(), "").retryable).toBe(false);
    expect(normalizeHttpError(422, h(), "").retryable).toBe(false);
  });

  test("every 5xx is a retryable server error, 529 included", () => {
    for (const status of [500, 502, 503, 529]) {
      const err = normalizeHttpError(status, h(), "");
      expect(err.code).toBe("server");
      expect(err.retryable).toBe(true);
    }
  });

  test("embeds a bounded body snippet, never the whole body", () => {
    const err = normalizeHttpError(500, h(), "y".repeat(10_000));
    expect(err.message.length).toBeLessThan(300);
    expect(err.message).toContain("HTTP 500");
  });

  test("omits providerCode entirely when there is none — never an empty string", () => {
    expect("providerCode" in normalizeHttpError(500, h(), "plain text")).toBe(false);
  });
});

describe("toSdkAssistantMessageError — the pinned 11-member taxonomy (item (b))", () => {
  test("529 is `overloaded` — the value capture (G) observed verbatim", () => {
    expect(toSdkAssistantMessageError(normalizeHttpError(529, h(), ""))).toBe("overloaded");
  });

  test("an Anthropic overloaded_error at any 5xx is `overloaded`; a plain 500 is `server_error`", () => {
    expect(toSdkAssistantMessageError(normalizeHttpError(500, h(), JSON.stringify({ error: { type: "overloaded_error" } })))).toBe("overloaded");
    expect(toSdkAssistantMessageError(normalizeHttpError(500, h(), ""))).toBe("server_error");
  });

  test("429 is `rate_limit` — the value capture (G) observed verbatim", () => {
    expect(toSdkAssistantMessageError(normalizeHttpError(429, h(), ""))).toBe("rate_limit");
  });

  test("401/403 are `authentication_failed`", () => {
    expect(toSdkAssistantMessageError(normalizeHttpError(401, h(), ""))).toBe("authentication_failed");
    expect(toSdkAssistantMessageError(normalizeHttpError(403, h(), ""))).toBe("authentication_failed");
  });

  test("a model-not-found code maps to `model_not_found`, in all three dialects", () => {
    expect(toSdkAssistantMessageError(normalizeHttpError(404, h(), JSON.stringify({ error: { code: "model_not_found" } })))).toBe("model_not_found");
    expect(toSdkAssistantMessageError(normalizeHttpError(404, h(), JSON.stringify({ error: { type: "not_found_error" } })))).toBe("model_not_found");
    expect(toSdkAssistantMessageError(normalizeHttpError(404, h(), JSON.stringify({ error: { code: 404, status: "NOT_FOUND" } })))).toBe("model_not_found");
  });

  test("an output-token cap maps to `max_output_tokens`", () => {
    expect(toSdkAssistantMessageError(normalizeHttpError(400, h(), JSON.stringify({ error: { code: "max_tokens_exceeded" } })))).toBe("max_output_tokens");
  });

  test("an ordinary 4xx is `invalid_request`", () => {
    expect(toSdkAssistantMessageError(normalizeHttpError(400, h(), ""))).toBe("invalid_request");
  });

  test("402 Payment Required is `billing_error`, not `invalid_request` (Minor 13)", () => {
    // Telling a user their REQUEST was invalid when their card expired sends them to debug entirely
    // the wrong thing.
    expect(toSdkAssistantMessageError(normalizeHttpError(402, h(), ""))).toBe("billing_error");
    expect(normalizeHttpError(402, h(), "").retryable).toBe(false);
  });

  test("transport failures collapse to `unknown` — the pinned union has no transport member", () => {
    for (const code of ["network", "timeout", "stall", "aborted", "capability"] as const) {
      expect(toSdkAssistantMessageError({ code, message: "x", retryable: false })).toBe("unknown");
    }
  });

  test("returns only members of the closed 11-set, whatever it is handed", () => {
    const members = new Set([
      "authentication_failed", "oauth_org_not_allowed", "account_on_hold", "billing_error", "rate_limit",
      "overloaded", "invalid_request", "model_not_found", "server_error", "unknown", "max_output_tokens",
    ]);
    for (let status = 400; status < 600; status += 7) {
      expect(members.has(toSdkAssistantMessageError(normalizeHttpError(status, h(), "")))).toBe(true);
    }
  });
});

describe("normalizeThrown", () => {
  test("an AbortError is `aborted` and NOT retryable", () => {
    const err = new Error("The operation was aborted.");
    err.name = "AbortError";
    const normalized = normalizeThrown(err);
    expect(normalized.code).toBe("aborted");
    expect(normalized.retryable).toBe(false);
  });

  test("a ProviderStallError is `stall` and NOT retryable — the bytes already started", () => {
    const normalized = normalizeThrown(new ProviderStallError("no bytes for 120000ms"));
    expect(normalized.code).toBe("stall");
    expect(normalized.retryable).toBe(false);
  });

  test("a generic transport error is `network` and retryable", () => {
    const normalized = normalizeThrown(new TypeError("fetch failed"));
    expect(normalized.code).toBe("network");
    expect(normalized.retryable).toBe(true);
    expect("status" in normalized).toBe(false);
  });

  test("an already-normalized ProviderError passes through untouched", () => {
    const original = { code: "server", message: "HTTP 503", status: 503, retryable: true } as const;
    expect(normalizeThrown(original)).toBe(original);
  });

  test("never leaks a credential-shaped substring it was handed", () => {
    // A thrown transport error's `message` is provider/library prose; Winter's own contribution to
    // it must never be a header value. This asserts the function adds no such context of its own.
    const normalized = normalizeThrown(new Error("connect ECONNREFUSED 127.0.0.1:11434"));
    expect(normalized.message).not.toContain("Authorization");
  });
});

// --- Minor 2 (round 1) / new Minor (round 2): the body snippet is SCRUBBED, and scanned on the FULL
// body. These tests did not exist when the round-1 report claimed them; the code was correct, the
// coverage was not.
describe("normalizeHttpError — the body snippet is scrubbed (Minor 2)", () => {
  const KEYS = [
    "sk-proj-Abcdefghijklmnopqrstuvwxyz012345",
    "AIzaSyA1234567890abcdefghijklmnopqrstuvw",
  ];

  test("a 401 body echoing a key-shaped string is redacted, and the structured code SURVIVES", () => {
    // A 401 body routinely echoes part of the credential it rejected, and `ProviderError.message` is
    // one of the most reliably-logged strings in the system.
    for (const key of KEYS) {
      const body = JSON.stringify({ error: { message: `Incorrect API key provided: ${key}`, type: "invalid_request_error", code: "invalid_api_key" } });
      const err = normalizeHttpError(401, h(), body);
      expect(err.message).toContain("[redacted");
      expect(err.message).not.toContain(key);
      // The redaction must not cost the caller the one machine-readable field it needs.
      expect(err.providerCode).toBe("invalid_api_key");
      expect(err.code).toBe("auth");
    }
  });

  test("a key STRADDLING the 200-char truncation boundary is still caught", () => {
    // The regression this pins: scanning the truncated snippet leaves only the key's PREFIX to
    // match against length-based patterns, so the partial slips through while still disclosing the
    // prefix. Scanning the full body first is what closes it.
    const key = KEYS[0]!;
    // A realistic body shape: the key is preceded by a delimiter, as it is in every provider
    // envelope. That matters, because the scanner's `sk-` pattern is word-boundary anchored on
    // purpose (the catalog validator documents why — an unanchored `contains` matches things like
    // `subcontext_length_exceeded`). A key glued directly to preceding word characters, with no
    // delimiter at all, is outside what the scanner claims to catch and is not a body shape any
    // provider produces; this test pins the shape that IS real.
    const body = `${"z".repeat(185)} ${key}`;
    const snippet = body.slice(0, 200);
    expect(snippet).toContain("sk-proj-"); // the prefix really is inside the snippet
    expect(snippet).not.toContain(key); // and the whole key really is not
    expect(scanForSecrets(snippet)).toEqual([]); // ...so scanning the SNIPPET alone finds nothing
    const err = normalizeHttpError(401, h(), body);
    expect(err.message).toContain("[redacted");
    expect(err.message).not.toContain("sk-proj-");
  });

  test("an ordinary body is NOT redacted — the scrubber must not eat every diagnostic", () => {
    const err = normalizeHttpError(400, h(), JSON.stringify({ error: { message: "messages: at least one message is required", code: "invalid_request_error" } }));
    expect(err.message).toContain("at least one message is required");
    expect(err.message).not.toContain("[redacted");
  });
});
