// THE LOCAL FETCH -- claude's own WebFetch reaches the target from the USER'S MACHINE (axios,
// `maxRedirects: 0`, its own redirect walk); the project owner ruled Winter's copy must "reach
// whatever claude does," so this module does the identical thing with Bun's `fetch`, never through a
// third-party relay. Registers nothing (see `_domains.ts`'s header for why that convention exists).
//
// EVERY DEPENDENCY IS INJECTABLE (`WebFetchNetDeps`) so a test drives this against a real loopback
// `Bun.serve` server without fighting TLS: `resolveHost` is stubbed to answer `127.0.0.1`, and
// `fetchImpl` rewrites the resulting `https://127.0.0.1:<port>` connect URL back to
// `http://127.0.0.1:<port>` before delegating to the real `fetch`.
//
// SECURITY REVIEW FIX ROUND (2026-09-18), summarised here because it explains the shape of almost
// everything below -- see the report for the full finding-by-finding record:
//   B1 the header fetch AND the body read now share ONE try/catch, so a body-phase failure (a slow
//      honest download crossing the timeout mid-body, a torn socket, a turn abort) is a typed result,
//      never an unhandled rejection that ends the whole turn.
//   B2 `fetch(..., { decompress: false })` plus a STREAMING zlib decode with the byte cap enforced as
//      output arrives -- a `fetch()` that auto-inflates before the reader sees a chunk is exposed to
//      a KB-sized compression bomb inflating to gigabytes of peak RSS; axios (claude's own client)
//      is not, because its `maxContentLength` checks a streaming zlib the same way this now does.
//   M1 every reason phrase is `node:http`'s fixed `STATUS_CODES` table, NEVER the wire's own
//      (server-controlled) status line text -- claude does the identical thing, and relaying the raw
//      text is a prompt-injection vector aimed at the MAIN model.
//   M2 REDIRECT DETECTED's Location handling: a non-http(s) target's URL line is WITHHELD (rebuilding
//      it via `URL.origin` for `data:`/`javascript:` yields the literal string "null" and an
//      un-percent-encoded opaque path -- an injection vector of its own); an unparseable or blank
//      Location is an `http-error`, never a redirect message; nothing server-supplied is ever used as
//      a `String.replace` REPLACEMENT PATTERN (`$&`/`$'` expansion).
//   M6 DNS-rebinding TOCTOU: `resolveHost` is now called EXACTLY ONCE per hop, and the fetch connects
//      DIRECTLY to the address that resolution returned (`Host` header + `tls.serverName` carry the
//      logical hostname for virtual-hosting and certificate validation) -- Bun's own `fetch` would
//      otherwise re-resolve internally with its own cache, a SECOND, unpinned query an attacker's
//      rebinding DNS answer can win. A resolution failure refuses outright (there is no address left
//      to fail open onto).
import { STATUS_CODES } from "node:http";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { isDomainBlocked } from "./_domains.ts";
import { preapprovedScopeOf, staysWithinScope, type PreapprovedMatch } from "../../web/preapproved-hosts.ts";
import { classifyIpLiteral, classifyReservedName, classifyResolvedAddress, stripIpv6Brackets, type PrivateAddressFinding } from "../../web/private-address.ts";

export const WEB_FETCH_MAX_BYTES = 10_485_760;
export const WEB_FETCH_TIMEOUT_MS = 60_000;
export const WEB_FETCH_MAX_REDIRECTS = 10;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RETRY_AFTER_RE = /^[0-9]{1,6}$/;

/** claude's own `I_e(code)`: a FIXED table lookup, never the wire's own (server-controlled) reason phrase -- see the module header, finding M1. */
export function reasonPhrase(status: number): string {
  return STATUS_CODES[status] ?? "Unknown Status";
}

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

/** Exported so `web-fetch.ts`'s own upfront (pre-cache) gate uses the SAME default resolver -- never a second, drifting copy. */
export async function defaultResolveHost(hostname: string): Promise<readonly string[]> {
  const results = await dnsLookup(hostname, { all: true });
  return results.map((r) => r.address);
}

function upgradeToHttps(url: URL): URL {
  if (url.protocol !== "http:") return url;
  const upgraded = new URL(url.toString());
  upgraded.protocol = "https:";
  return upgraded;
}

/** `validateInput`'s own parse-failure text -- WITH the `Error: ` prefix (fidelity #2). */
export function parseFailureMessage(raw: string): string {
  return `Error: Invalid URL "${raw}". The URL provided could not be parsed.`;
}

/** The three FETCH-TIME rejects' text: a bare `Invalid URL`, never the fuller parse-failure sentence (fidelity #2, corrected). */
const FETCH_TIME_INVALID_URL = "Invalid URL";

/**
 * claude's own fetch-time rejects: overlong, embedded credentials, a hostname with fewer than two
 * labels. Run PER HOP (claude runs it once on the raw input; running it again on every upgraded hop
 * is strictly stricter and is kept deliberately -- a disclosed, safe deviation, not a fidelity gap).
 */
function validateFetchTimeUrl(url: URL): { ok: true } | { ok: false; message: string } {
  const str = url.toString();
  if (str.length > 2000) return { ok: false, message: FETCH_TIME_INVALID_URL };
  if (url.username !== "" || url.password !== "") return { ok: false, message: FETCH_TIME_INVALID_URL };
  if (url.hostname.split(".").length < 2) return { ok: false, message: FETCH_TIME_INVALID_URL };
  return { ok: true };
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

function decompressorFor(token: string) {
  switch (token) {
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "br":
      return createBrotliDecompress();
    case "deflate":
      return createInflate();
    default:
      return undefined;
  }
}

/**
 * Reads up to `WEB_FETCH_MAX_BYTES` of DECOMPRESSED output, streaming through the matching decoder
 * (finding B2). The cap is enforced as bytes ARRIVE, never after fully materialising the body: for a
 * gzip/brotli bomb (a few KB of input, gigabytes of output) this reads only the handful of decoded
 * chunks needed to cross the cap before the stream is destroyed, bounding both time and peak memory
 * to the cap's own order of magnitude regardless of the compression ratio. `undefined` means
 * exceeded -- a caller error (network drop, abort, malformed compressed data) PROPAGATES instead of
 * being swallowed here, so the caller's own try/catch (B1) can classify it as aborted/timeout/
 * network-error using the SAME signal it already has in scope.
 */
async function readBodyCapped(response: Response, contentEncoding: string): Promise<Uint8Array | undefined> {
  if (response.body === null || response.body === undefined) return new Uint8Array(0);
  const token = (contentEncoding.split(",")[0] ?? "").trim().toLowerCase();
  const decompressor = decompressorFor(token);
  const source = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>);
  const stream: NodeJS.ReadableStream = decompressor !== undefined ? source.pipe(decompressor) : source;
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      total += buf.byteLength;
      if (total > WEB_FETCH_MAX_BYTES) return undefined;
      chunks.push(buf);
    }
  } finally {
    // Destroying the SOURCE (not just the decompressor) stops the underlying HTTP read immediately;
    // for the identity path `stream === source`, this is the same object.
    source.destroy();
    decompressor?.destroy();
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

interface ResolvedTarget {
  /** What the fetch actually connects to -- an IP literal, unbracketed. */
  connectAddress: string;
  family: 4 | 6;
  verdict: PrivateAddressFinding;
}

/**
 * Resolves `hostname` EXACTLY ONCE and returns both the classification AND the address to connect
 * to, so the two can never disagree (finding M6): the address the private-address policy was
 * evaluated against is the SAME one the fetch call below pins to, never a second, independently
 * (and possibly differently) resolved one. `undefined` means resolution genuinely failed or answered
 * no addresses -- the caller refuses outright; there is no address left to fail open onto.
 */
async function resolveTarget(hostname: string, resolveHost: (hostname: string) => Promise<readonly string[]>): Promise<ResolvedTarget | undefined> {
  const bare = stripIpv6Brackets(hostname);
  const literalFamily = isIP(bare);
  if (literalFamily !== 0) {
    const verdict = classifyIpLiteral(bare) ?? { class: "public" as const };
    return { connectAddress: bare, family: literalFamily as 4 | 6, verdict };
  }
  const reserved = classifyReservedName(hostname);
  let addresses: readonly string[];
  try {
    addresses = await resolveHost(hostname);
  } catch {
    return undefined;
  }
  if (addresses.length === 0) return undefined;
  const familyOf = (addr: string): 4 | 6 => {
    const f = isIP(addr);
    return f === 6 ? 6 : 4;
  };
  if (reserved !== undefined) {
    // A reserved NAME is private regardless of what it resolves to -- but a connect address is still
    // needed if the policy ends up "allow," so resolution runs anyway, best-effort.
    const first = addresses[0]!;
    return { connectAddress: first, family: familyOf(first), verdict: reserved };
  }
  for (const address of addresses) {
    const verdict = classifyResolvedAddress(address);
    if (verdict.class === "private") return { connectAddress: address, family: familyOf(address), verdict };
  }
  const first = addresses[0]!;
  return { connectAddress: first, family: familyOf(first), verdict: { class: "public" } };
}

/**
 * Performs the whole fetch, including the manual redirect walk -- one HTTP request per hop, each
 * hop re-checked against the domain floor and the private-address policy (closing the short-link
 * bypass: a blocked/private host reached via an intermediate redirect is refused exactly like one
 * reached directly).
 */
export async function performWebFetch(inputUrl: string, prompt: string, opts: WebFetchNetOptions, deps: WebFetchNetDeps = {}): Promise<WebFetchNetOutcome> {
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const resolveHost = deps.resolveHost ?? defaultResolveHost;
  const timeoutMs = deps.timeoutMs ?? WEB_FETCH_TIMEOUT_MS;

  let current: URL;
  try {
    current = new URL(inputUrl);
  } catch {
    return { kind: "invalid-url", message: parseFailureMessage(inputUrl) };
  }
  current = upgradeToHttps(current);

  // COUNTS REDIRECTS FOLLOWED, not total requests: the initial request is never itself a "hop," so
  // this permits the initial fetch PLUS up to `WEB_FETCH_MAX_REDIRECTS` eligible redirects (11 total
  // requests in the worst case) before refusing an 11th -- MEASURED against the binary (fidelity #9):
  // `if(o>10) throw` with `o` incremented per followed hop, i.e. exactly this shape. The 60 s timeout
  // is PER HOP in claude too (fidelity #9) -- not a shared total budget, by design.
  let redirectsFollowed = 0;
  for (;;) {
    const fv = validateFetchTimeUrl(current);
    if (!fv.ok) return { kind: "invalid-url", message: fv.message };

    if (isDomainBlocked(current.hostname, opts.blockedDomains)) return { kind: "blocked-domain", host: current.hostname };

    const resolved = await resolveTarget(current.hostname, resolveHost);
    if (resolved === undefined) {
      return { kind: "network-error", message: `WebFetch could not resolve any address for ${current.hostname}.` };
    }
    if (resolved.verdict.class === "private") {
      if (opts.privateAddressPolicy === "deny") return { kind: "private-address", host: current.hostname, policy: "deny" };
      if (opts.privateAddressPolicy === "ask") return { kind: "private-address", host: current.hostname, policy: "ask" };
      // "allow" falls through to the fetch, pinned to the SAME address just classified.
    }

    const scope = preapprovedScopeOf(current);

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal !== undefined ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;

    // Pin the CONNECTION to the address just resolved and classified (finding M6): the logical
    // hostname travels as `Host` (virtual hosting) and `tls.serverName` (certificate validation by
    // name), never as the DNS name `fetch()` itself would otherwise resolve a SECOND, unpinned time.
    const connectUrl = new URL(current.toString());
    connectUrl.hostname = resolved.family === 6 ? `[${resolved.connectAddress}]` : resolved.connectAddress;

    let response: Response;
    let outcome: WebFetchNetOutcome | undefined;
    try {
      response = await fetchImpl(connectUrl.toString(), {
        redirect: "manual",
        headers: { Accept: "text/markdown, text/html, */*", "User-Agent": opts.userAgent, Host: current.hostname },
        signal,
        decompress: false,
        tls: { serverName: current.hostname },
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel().catch(() => {});
        const location = response.headers.get("location");
        let target: URL | undefined;
        if (location !== null && location.trim() !== "") {
          try {
            target = new URL(location, current);
          } catch {
            target = undefined;
          }
        }
        // An unparseable OR blank Location is an http_error, never a redirect message (finding M2).
        if (target === undefined) {
          outcome = { kind: "http-error", status: response.status, statusText: reasonPhrase(response.status) };
        } else {
          const notHttp = target.protocol !== "http:" && target.protocol !== "https:";
          if (!notHttp && isEligibleAutoFollow(current, target, scope)) {
            if (redirectsFollowed >= WEB_FETCH_MAX_REDIRECTS) {
              outcome = { kind: "too-many-redirects", message: `Too many redirects (exceeded ${WEB_FETCH_MAX_REDIRECTS})` };
            } else {
              redirectsFollowed += 1;
              current = target;
              continue;
            }
          } else {
            outcome = { kind: "redirect-blocked", message: renderRedirectDetected(current.toString(), notHttp ? undefined : target, response.status, prompt) };
          }
        }
      } else if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => {});
        const rawRetryAfter = response.headers.get("retry-after");
        const retryAfter = rawRetryAfter !== null && RETRY_AFTER_RE.test(rawRetryAfter) ? rawRetryAfter : undefined;
        outcome = { kind: "http-error", status: response.status, statusText: reasonPhrase(response.status), ...(retryAfter !== undefined ? { retryAfter } : {}) };
      } else {
        const body = await readBodyCapped(response, response.headers.get("content-encoding") ?? "");
        if (body === undefined) {
          outcome = { kind: "size-exceeded", message: `The response body exceeded WebFetch's ${WEB_FETCH_MAX_BYTES.toLocaleString("en-US")}-byte limit and was not retrieved.` };
        } else {
          outcome = {
            kind: "success",
            finalUrl: current.toString(),
            status: response.status,
            statusText: reasonPhrase(response.status),
            contentType: response.headers.get("content-type") ?? "",
            body,
          };
        }
      }
    } catch (err) {
      // ONE catch for BOTH the header fetch and the body read (finding B1) -- a body-phase failure
      // (a torn socket, the hop timeout crossed mid-body, a turn abort) is classified exactly like a
      // header-phase one, never an unhandled rejection.
      if (opts.signal?.aborted === true) return { kind: "aborted" };
      if (timeoutSignal.aborted) return { kind: "timeout", message: `WebFetch timed out after ${Math.round(timeoutMs / 1000)}s.` };
      return { kind: "network-error", message: err instanceof Error ? err.name : "the fetch failed" };
    }
    return outcome;
  }
}
