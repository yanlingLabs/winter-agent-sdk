// Bounded, policy-enforcing HTTP. FROZEN as of P6 T2's merge (R6-12).
//
// WS-13 §13's per-request floor, in one place so no adapter has to re-implement it:
// cancellation, timeouts, connection and body limits, manual redirects with revalidation, and no
// credential forwarding across an origin change (R6-11).
//
// Three decisions worth stating, because each has an obvious-looking alternative that is wrong:
//
//   `redirect: "manual"`, NOT `"follow"`. The platform's own redirect following replays request
//     headers — including `Authorization` — to whatever host the `Location` names. That is precisely
//     the manoeuvre R6-11 forbids, and it is invisible from the call site. Following redirects by
//     hand is what makes the revalidation possible at all.
//
//   THE BODY CAP LIVES IN THE READ PATH, not on `Content-Length`. A streamed or chunked response has
//     no `Content-Length` — which is exactly the shape every provider stream takes — so a
//     header-based cap would bound only the responses that were never the risk.
//
//   `timeoutMs` BOUNDS HEADERS, NOT THE WHOLE RESPONSE. A generation legitimately runs far longer
//     than any sane connect budget; the timer is cleared the moment headers arrive, and mid-stream
//     silence is the stall watchdog's job (`parseSse`, `providerStallTimeoutMs`).

import type { ProviderError } from "./types.ts";
import { stripCredentialHeaders, type EndpointPolicy } from "./endpoint-policy.ts";

/** Following more than this many hops is a loop, not a route. */
export const DEFAULT_MAX_REDIRECTS = 5;

/**
 * A `ProviderError` that is also a real `Error` — so it carries a stack, and `normalizeThrown`
 * passes it through untouched (it satisfies `isProviderError` structurally).
 */
export class ProviderRequestError extends Error implements ProviderError {
  readonly code: ProviderError["code"];
  readonly retryable: boolean;
  // `declare`, not an ordinary optional field, and that is load-bearing under
  // `useDefineForClassFields` (implied by target ES2022): a plain `readonly status?: number` is
  // EMITTED as a field initialiser, so every instance gets an own `status` key holding `undefined`.
  // With `exactOptionalPropertyTypes` on, that is precisely the shape the codebase forbids — and it
  // is observable: `"status" in err` becomes true for a connection error that has no HTTP status,
  // which is exactly the case the pinned `api_retry.error_status: number | null` distinguishes.
  // `declare` emits nothing, and the conditional Object.assign below writes only present keys.
  declare readonly status?: number;
  declare readonly providerCode?: string;
  declare readonly retryAfterMs?: number;
  constructor(fields: ProviderError) {
    super(fields.message);
    this.name = "ProviderRequestError";
    this.code = fields.code;
    this.retryable = fields.retryable;
    Object.assign(this, {
      ...(fields.status !== undefined ? { status: fields.status } : {}),
      ...(fields.providerCode !== undefined ? { providerCode: fields.providerCode } : {}),
      ...(fields.retryAfterMs !== undefined ? { retryAfterMs: fields.retryAfterMs } : {}),
    });
  }
}

/** Thrown while READING a response body that exceeded `maxBodyBytes`. Not retryable: the peer is oversized, and a retry gets the same oversized answer. */
export class ProviderBodyLimitError extends ProviderRequestError {
  constructor(maxBodyBytes: number) {
    super({ code: "capability", message: `provider response body exceeded the ${maxBodyBytes}-byte limit`, retryable: false });
    this.name = "ProviderBodyLimitError";
  }
}

export interface BoundedFetchInit extends Omit<RequestInit, "redirect" | "signal"> {
  /** Milliseconds allowed for RESPONSE HEADERS to arrive. Cleared once they do. */
  timeoutMs: number;
  maxBodyBytes: number;
  policy: EndpointPolicy;
  signal?: AbortSignal;
  maxRedirects?: number;
}

function policyRefusal(reason: string): ProviderRequestError {
  return new ProviderRequestError({ code: "capability", message: reason, retryable: false });
}

/**
 * Wraps a body so the cap is enforced as bytes are consumed, whatever the headers claimed, and so
 * the caller's abort keeps reaching the stream AFTER headers have arrived.
 *
 * The header deadline is cleared once headers land (a generation legitimately runs far longer than
 * any connect budget), and the caller's abort listener went with it — which left a caller that
 * simply does `await res.text()` with no way to cancel at all. The listener is re-attached here for
 * the body's lifetime instead, so `interrupt` reaches a streaming read and a buffering one alike.
 */
function capBody(body: ReadableStream<Uint8Array>, maxBodyBytes: number, signal: AbortSignal | undefined): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let seen = 0;
  let onAbort: (() => void) | undefined;
  const detach = (): void => {
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    onAbort = undefined;
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (signal === undefined) return;
      const abortError = (): Error => {
        const err = new Error("provider response body aborted by the caller");
        err.name = "AbortError";
        return err;
      };
      if (signal.aborted) {
        void reader.cancel().catch(() => {});
        controller.error(abortError());
        return;
      }
      onAbort = () => {
        void reader.cancel().catch(() => {});
        controller.error(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        detach();
        controller.close();
        return;
      }
      seen += value.byteLength;
      if (seen > maxBodyBytes) {
        // Cancel the source before erroring: leaving an oversized response draining in the
        // background is how a "limit" turns into a limit on what the caller SEES rather than on
        // what the process actually pulls down.
        detach();
        void reader.cancel().catch(() => {});
        controller.error(new ProviderBodyLimitError(maxBodyBytes));
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      detach();
      void reader.cancel(reason).catch(() => {});
    },
  });
}

/** Normalizes whatever `fetch` threw into a typed provider error, distinguishing a caller abort from our own header deadline. */
function transportError(err: unknown, callerAborted: boolean, timedOut: boolean, timeoutMs: number): ProviderRequestError {
  if (callerAborted) return new ProviderRequestError({ code: "aborted", message: "provider request aborted by the caller", retryable: false });
  if (timedOut) return new ProviderRequestError({ code: "timeout", message: `provider did not send response headers within ${timeoutMs}ms`, retryable: true });
  return new ProviderRequestError({ code: "network", message: err instanceof Error ? err.message : String(err), retryable: true });
}

export async function boundedFetch(url: string, init: BoundedFetchInit): Promise<Response> {
  const maxRedirects = init.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  // `body` and `method` are pulled OUT of the spread: a redirect can change either, and spreading
  // `requestInit` verbatim across a hop would silently re-add the original of each.
  const { timeoutMs, maxBodyBytes, policy, signal, maxRedirects: _ignored, body: initialBody, method: initialMethod, ...requestInit } = init;

  // The FIRST url must be ON the policy's own origin, and that is stricter than the redirect rule on
  // purpose. An adapter builds its request URL from the connection profile the policy was built
  // from, so a first hop that lands anywhere else is a construction bug or an injected value — not
  // a route the provider chose. Cross-origin is reachable only by following a Location header the
  // provider itself sent, where `evaluateRedirect` applies and credentials are dropped.
  const firstHop = policy.evaluateRedirect(url);
  if (!firstHop.ok) throw policyRefusal(firstHop.reason);
  if (!firstHop.sameOrigin) {
    throw policyRefusal(`request URL origin ${firstHop.origin} is not this connection's endpoint origin ${policy.origin}`);
  }

  let currentUrl = url;
  let headers = new Headers(requestInit.headers ?? {});
  let method = initialMethod ?? "GET";
  let body: BodyInit | null | undefined = initialBody;

  for (let hop = 0; ; hop++) {
    const controller = new AbortController();
    let timedOut = false;
    let callerAborted = signal?.aborted === true;
    const onCallerAbort = (): void => {
      callerAborted = true;
      controller.abort();
    };
    if (callerAborted) throw transportError(undefined, true, false, timeoutMs);
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let response: Response;
    try {
      // `body` is spread CONDITIONALLY: exactOptionalPropertyTypes forbids an explicit `undefined`,
      // and a GET carrying `body: undefined` is rejected by the platform anyway.
      response = await fetch(currentUrl, { ...requestInit, method, ...(body !== undefined && body !== null ? { body } : {}), headers, redirect: "manual", signal: controller.signal });
    } catch (err) {
      throw transportError(err, callerAborted, timedOut, timeoutMs);
    } finally {
      // Cleared whether or not headers arrived. Leaving it armed would abort the controller
      // mid-BODY, killing exactly the long generations `timeoutMs` was never meant to bound.
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    }

    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (location === null) {
      if (response.body === null) return response;
      return new Response(capBody(response.body, maxBodyBytes, signal), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    if (hop >= maxRedirects) throw policyRefusal(`provider request exceeded ${maxRedirects} redirects — refusing to follow further`);

    // Resolve relative Locations against the CURRENT url (the standard), then revalidate the
    // ABSOLUTE result. `evaluateRedirect` itself refuses a relative string, which is why resolution
    // happens here rather than being pushed into the policy.
    let target: string;
    try {
      target = new URL(location, currentUrl).toString();
    } catch {
      throw policyRefusal(`provider returned an unparseable Location header`);
    }
    const verdict = policy.evaluateRedirect(target);
    if (!verdict.ok) throw policyRefusal(verdict.reason);
    // Drain the 3xx body so the connection can be reused rather than left half-read.
    void response.body?.cancel().catch(() => {});
    if (!verdict.sameOrigin) {
      // A CROSS-ORIGIN redirect of a request that HAS A BODY is refused outright, not merely
      // stripped of its credentials.
      //
      // Dropping the Authorization header protects the KEY. It does nothing for the PAYLOAD, and a
      // provider turn body is not innocuous: it replays `nativeState.items` (OpenAI
      // `encrypted_content`, Gemini `thoughtSignature`), thinking blocks with their real signatures,
      // the system prompt, and the whole conversation. Global Constraints are categorical that
      // opaque provider state reaches the sidecar and nothing else — re-POSTing it to a host the
      // provider named in a Location header is precisely the disclosure that rule exists to prevent.
      //
      // Nor is there a legitimate case to preserve: no provider in the cohort answers a turn request
      // with a cross-origin redirect. A GET (discovery, a token endpoint) still follows, with its
      // credentials stripped.
      if (body !== undefined && body !== null) {
        throw policyRefusal(
          `provider redirected a request WITH A BODY from ${policy.origin} to ${verdict.origin}; refusing to re-send the request payload (which may carry conversation content and opaque provider state) to another origin`,
        );
      }
      headers = stripCredentialHeaders(headers);
    }

    if (response.status === 303) {
      // 303 means "go GET this other thing" — the classic POST-then-redirect-to-a-result shape.
      // Replaying the original method and body would re-submit the request against a URL that
      // explicitly asked for a GET, which for a turn request means submitting it twice.
      method = "GET";
      body = undefined;
      // A body-shaped header on a request that no longer has one is a lie the server may act on.
      headers.delete("content-type");
      headers.delete("content-length");
    } else if (body !== undefined && body !== null && typeof body === "object" && "getReader" in (body as object)) {
      // 307/308 (and a 301/302 kept as-is) must replay the body verbatim — and a ReadableStream body
      // is already partly consumed by the first attempt, so "replaying" it would send a truncated
      // request or none at all. Refused with a typed error rather than silently mangled; an adapter
      // that needs redirect-following must buffer its body.
      throw policyRefusal(`provider redirected a request whose body is a stream, which cannot be replayed — buffer the body or point the connection at the final URL`);
    }
    currentUrl = target;
  }
}
