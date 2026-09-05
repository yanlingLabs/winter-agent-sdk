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

/** Wraps a body so the cap is enforced as bytes are consumed, whatever the headers claimed. */
function capBody(body: ReadableStream<Uint8Array>, maxBodyBytes: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let seen = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      seen += value.byteLength;
      if (seen > maxBodyBytes) {
        // Cancel the source before erroring: leaving an oversized response draining in the
        // background is how a "limit" turns into a limit on what the caller SEES rather than on
        // what the process actually pulls down.
        void reader.cancel().catch(() => {});
        controller.error(new ProviderBodyLimitError(maxBodyBytes));
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
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
  const { timeoutMs, maxBodyBytes, policy, signal, maxRedirects: _ignored, ...requestInit } = init;

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
      response = await fetch(currentUrl, { ...requestInit, headers, redirect: "manual", signal: controller.signal });
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
      return new Response(capBody(response.body, maxBodyBytes), {
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
    if (!verdict.sameOrigin) headers = stripCredentialHeaders(headers);
    currentUrl = target;
  }
}
