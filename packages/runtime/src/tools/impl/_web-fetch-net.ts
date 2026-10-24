// THE LOCAL FETCH -- claude's own WebFetch reaches the target from the USER'S MACHINE (axios,
// `maxRedirects: 0`, its own redirect walk); the project owner ruled Winter's copy must "reach
// whatever claude does," so this module does the identical thing, never through a third-party relay.
// Registers nothing (see `_domains.ts`'s header for why that convention exists).
//
// THE WALK ITSELF LIVES IN `@yanlinglabs/winter-web` (`fetchWebResource`): per hop the https upgrade,
// the fetch-time URL rejects, the domain floor, the private-address policy on the LEXICAL host and on
// EVERY resolved address, then a connection PINNED to the address that was classified (the logical
// name rides only as `Host` and the TLS server name -- the M6 rebinding fix), the per-hop timeout
// with the DNS lookup inside it, the connect-phase candidate fallback (N4), and the body read through
// a streaming decoder chain with independent decoded-output and encoded-input caps (B2/N1/N3/N5).
// What stays here is Winter's own: the model-facing texts (claude's REDIRECT DETECTED message, the
// fixed reason phrases, the size/timeout wording), the preapproved-scope rule on auto-follow, the
// "ask" policy (refused here exactly like "deny", rendered differently by `web-fetch.ts`), and the
// TRANSPORT -- Bun's `fetch`, pinned with `tls.serverName` and `decompress: false`, exactly as before.
//
// PROXIES: Bun's `fetch` honours `HTTPS_PROXY`; the proxy is handed the PINNED address (`CONNECT
// [<ip>]:443`, measured), never the hostname, so it cannot re-resolve it. A proxy that allowlists by
// hostname may refuse that CONNECT, and its 502 then reads as WebFetch's generic HTTP-error text.
import { fetchWebResource, reasonPhrase, WEB_FETCH_MAX_BYTES, WEB_FETCH_MAX_ENCODED_BYTES, WEB_FETCH_MAX_REDIRECTS, WEB_FETCH_TIMEOUT_MS, type WebFetchTransport } from "@yanlinglabs/winter-web";
import { preapprovedScopeOf, staysWithinScope, type PreapprovedMatch } from "../../web/preapproved-hosts.ts";
import { FETCH_TIME_INVALID_URL } from "../../web/fetchable-url.ts";

export { defaultResolveHost, reasonPhrase, WEB_FETCH_MAX_BYTES, WEB_FETCH_MAX_ENCODED_BYTES, WEB_FETCH_MAX_REDIRECTS, WEB_FETCH_TIMEOUT_MS } from "@yanlinglabs/winter-web";

/** The three-value policy AFTER `web-fetch.ts`'s own fail-closed coercion -- this module trusts it verbatim. */
export type NormalizedPrivateAddressPolicy = "allow" | "deny" | "ask";

export interface WebFetchNetDeps {
  fetchImpl?: (url: string, init: { redirect: "manual"; headers: Record<string, string>; signal: AbortSignal; decompress: false; tls: { serverName: string } }) => Promise<Response>;
  resolveHost?: (hostname: string) => Promise<readonly string[]>;
  now?: () => number;
  timeoutMs?: number;
}

export interface WebFetchNetOptions {
  blockedDomains: readonly string[];
  privateAddressPolicy: NormalizedPrivateAddressPolicy;
  userAgent: string;
  signal?: AbortSignal;
}

export type WebFetchNetOutcome =
  | { kind: "invalid-url"; message: string }
  | { kind: "blocked-domain"; host: string }
  | { kind: "private-address"; host: string; policy: "deny" | "ask" }
  | { kind: "redirect-blocked"; message: string }
  | { kind: "too-many-redirects"; message: string }
  | { kind: "http-error"; status: number; statusText: string; retryAfter?: string }
  | { kind: "size-exceeded"; message: string }
  | { kind: "timeout"; message: string }
  | { kind: "aborted" }
  | { kind: "network-error"; message: string }
  | { kind: "success"; finalUrl: string; status: number; statusText: string; contentType: string; body: Uint8Array };

/**
 * The input-validation parse-failure text -- WITH the `Error: ` prefix (fidelity #2).
 *
 * claude's own text for this case, which in claude itself no input reaches: claude validates a call
 * against the tool's input schema (`url: format uri`) BEFORE the tool's own validation, so an
 * unparseable URL is refused by the schema and anything the schema lets through also parses here.
 * This runtime has no schema-validation step in front of its executors, so the same text IS
 * reachable, as the backstop for exactly the inputs claude's schema refuses.
 */
export function parseFailureMessage(raw: string): string {
  return `Error: Invalid URL "${raw}". The URL provided could not be parsed.`;
}

function stripWww(hostname: string): string {
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}

/**
 * Rebuilds the Location target's own display line and renders claude's exact REDIRECT DETECTED
 * message. `target` must already be a PARSED http(s) URL when `notHttp` is false -- the non-http(s)
 * and unparseable/blank-Location cases are handled by the CALLER before this is ever invoked (see
 * finding M2: computing `target.origin` for a `data:`/`javascript:` URL yields the literal string
 * "null" and an un-percent-encoded opaque path, which is exactly the injection this function must
 * never construct).
 */
function renderRedirectDetected(currentUrl: string, target: URL | undefined, status: number, prompt: string): string {
  const statusText = reasonPhrase(status);
  let redirectUrlLine: string;
  let relayableUrl: string | undefined;
  if (target === undefined) {
    redirectUrlLine = "Redirect URL: (withheld — the server sent a redirect target that is not a valid http(s) URL)";
  } else {
    const full = `${target.origin}${target.pathname}${target.search}${target.hash}`;
    const capped = full.length > 1000;
    const value = capped ? full.slice(0, 1000) : full;
    let line = `Redirect URL (from the server's Location header — server-supplied, not verified): ${value}`;
    if (capped) line += ` […${full.length - 1000} more characters withheld: too long to relay]`;
    const hostTooLong = target.hostname.length > 255;
    if (hostTooLong) line += ` [hostname longer than any DNS name (255 characters): not a fetchable address]`;
    redirectUrlLine = line;
    if (!capped && !hostTooLong) relayableUrl = full;
  }
  const header = `REDIRECT DETECTED: The URL redirects to a location that was not fetched automatically.\n\nOriginal URL: ${currentUrl}\n${redirectUrlLine}\nStatus: ${status} ${statusText}\n\n`;
  if (relayableUrl === undefined) {
    return `${header}The redirect target could not be relayed in full or is not a fetchable address, so it cannot be fetched from here; report the redirect instead.`;
  }
  return `${header}To complete your request, I need to fetch content from the redirected URL. Please use WebFetch again with these parameters:\n- url: "${relayableUrl}"\n- prompt: "${prompt}"`;
}

/**
 * The auto-follow eligibility gate. Ports compare as RAW strings (fidelity #7): claude does NOT
 * normalise an explicit `:443`/`:80` to the implicit default, so a Location naming the default port
 * explicitly is returned as a redirect rather than followed, even though it is the "same" port a
 * browser would treat as equal.
 */
function isEligibleAutoFollow(current: URL, target: URL, scope: PreapprovedMatch | undefined): boolean {
  if (target.protocol !== current.protocol) return false;
  if (target.port !== current.port) return false;
  if (target.username !== "" || target.password !== "") return false;
  if (stripWww(target.hostname) !== stripWww(current.hostname)) return false;
  if (scope !== undefined && scope.pathPrefix !== undefined && !staysWithinScope(scope, target)) return false;
  return true;
}

/** Item 3: the ONE spelling of a hop timeout. */
function timeoutMessage(timeoutMs: number): string {
  const seconds = timeoutMs / 1000;
  return `WebFetch timed out after ${seconds < 1 ? `${timeoutMs}ms` : `${Math.round(seconds)}s`}.`;
}

/**
 * The transport: Bun's `fetch`, handed the PINNED address and the logical name as `Host` and
 * `tls.serverName`, never decompressing, never following a redirect. A test's `fetchImpl` stands in.
 */
function bunFetchTransport(fetchImpl: NonNullable<WebFetchNetDeps["fetchImpl"]>): WebFetchTransport {
  return async (request) => {
    const response = await fetchImpl(request.url.toString(), {
      redirect: "manual",
      headers: request.headers,
      signal: request.signal,
      decompress: false,
      tls: { serverName: request.serverName },
    });
    return {
      status: response.status,
      headers: response.headers,
      body: response.body as unknown as AsyncIterable<Uint8Array> | null,
      cancel: () => void response.body?.cancel().catch(() => {}),
    };
  };
}

const defaultFetchImpl: NonNullable<WebFetchNetDeps["fetchImpl"]> = (url, init) => fetch(url, init);

/**
 * Performs the whole fetch, including the manual redirect walk -- one HTTP request per hop, each
 * hop re-checked against the domain floor and the private-address policy (closing the short-link
 * bypass: a blocked/private host reached via an intermediate redirect is refused exactly like one
 * reached directly).
 */
export async function performWebFetch(inputUrl: string, prompt: string, opts: WebFetchNetOptions, deps: WebFetchNetDeps = {}): Promise<WebFetchNetOutcome> {
  const timeoutMs = deps.timeoutMs ?? WEB_FETCH_TIMEOUT_MS;
  const result = await fetchWebResource(inputUrl, {
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    timeoutMs,
    maxBytes: WEB_FETCH_MAX_BYTES,
    maxEncodedBytes: WEB_FETCH_MAX_ENCODED_BYTES,
    onOverflow: "fail",
    // "ask" refuses exactly like "deny" here: no approval signal ever reaches this module.
    privateAddressPolicy: opts.privateAddressPolicy === "allow" ? "allow" : "deny",
    userAgent: opts.userAgent,
    blockedDomains: opts.blockedDomains,
    maxRedirects: WEB_FETCH_MAX_REDIRECTS,
    followRedirects: (from, to) => isEligibleAutoFollow(from, to, preapprovedScopeOf(from)),
    ...(deps.resolveHost !== undefined ? { resolveHost: deps.resolveHost } : {}),
    transport: bunFetchTransport(deps.fetchImpl ?? defaultFetchImpl),
  });
  if (result.ok) return { kind: "success", finalUrl: result.finalUrl, status: result.status, statusText: result.statusText, contentType: result.contentType, body: result.body };
  switch (result.code) {
    case "invalid_url":
      return { kind: "invalid-url", message: result.reason === "unparseable" ? parseFailureMessage(inputUrl) : FETCH_TIME_INVALID_URL };
    case "blocked_domain":
      return { kind: "blocked-domain", host: result.host };
    case "private_address":
      return { kind: "private-address", host: result.host, policy: opts.privateAddressPolicy === "ask" ? "ask" : "deny" };
    case "unresolvable":
      return { kind: "network-error", message: `WebFetch could not resolve any address for ${result.host}.` };
    case "redirect_not_followed": {
      let target: URL | undefined;
      try {
        target = result.location !== undefined ? new URL(result.location) : undefined;
      } catch {
        target = undefined;
      }
      return { kind: "redirect-blocked", message: renderRedirectDetected(result.from, target, result.status, prompt) };
    }
    case "too_many_redirects":
      return { kind: "too-many-redirects", message: `Too many redirects (exceeded ${WEB_FETCH_MAX_REDIRECTS})` };
    case "http_error":
      return { kind: "http-error", status: result.status, statusText: result.statusText, ...(result.retryAfter !== undefined ? { retryAfter: result.retryAfter } : {}) };
    case "too_large":
      return {
        kind: "size-exceeded",
        message:
          result.limit === "encoded"
            ? `The response's encoded body exceeded WebFetch's ${WEB_FETCH_MAX_ENCODED_BYTES.toLocaleString("en-US")}-byte limit for compressed content and was not retrieved.`
            : `The response body exceeded WebFetch's ${WEB_FETCH_MAX_BYTES.toLocaleString("en-US")}-byte limit and was not retrieved.`,
      };
    case "unsupported_encoding":
      return { kind: "network-error", message: `the response uses an unsupported Content-Encoding ("${result.encoding}") and could not be decoded` };
    case "timeout":
      return { kind: "timeout", message: timeoutMessage(timeoutMs) };
    case "aborted":
      return { kind: "aborted" };
    case "network_error":
      return { kind: "network-error", message: result.detail };
  }
}
