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
//
// SECOND FIX ROUND (2026-09-18), against the first round's own regressions and residuals:
//   N1 `source.pipe(decompressor)` never forwarded a SOURCE error to the decoder -- a hop timeout,
//      `ctx.signal`, or a socket reset left the decoder waiting forever for an `end`/`error` it was
//      never going to get, an INFINITE hang (not even the 60 s timeout saved it, since the timeout's
//      own abort is exactly the source error that failed to propagate). `node:stream/promises`'
//      `pipeline()` replaces `.pipe()` throughout: it forwards a source error to every downstream
//      stream and guarantees every stream is destroyed, proven against this exact Bun version.
//   N3 the byte-meter now sits BEFORE the decoder, capping COMPRESSED input independently of the
//      (still-enforced) decompressed-output cap -- an endless stream of empty stored deflate blocks
//      has near-infinite input and almost no output, so the output cap alone never trips. Encoded
//      bodies get a LOWER input cap (`WEB_FETCH_MAX_ENCODED_BYTES`, 2 MiB) than identity ones: even
//      capped at the full 10 MiB, empty-block input measurably cost ~1.4 GB of transient RSS inside
//      Bun's own zlib binding, independent of this module's own bookkeeping.
//   N4 pinning to `addresses[0]` had no fallback: a broken-IPv6 network turns every dual-stack site
//      into a full 60 s timeout, because `dns.lookup(...,{all:true})` orders results (often IPv6
//      first) and this module tried only the first one. Every classified-public address is now a
//      CONNECT-phase candidate, tried in resolution order with a short per-candidate connect budget;
//      a candidate is abandoned only before any `Response` comes back (a connect/TLS failure), never
//      once bytes have arrived.
//   Minor: `Content-Encoding` decodes MULTIPLE tokens in REVERSE (undo) order and refuses an
//      unrecognised one outright rather than passing raw compressed bytes through as garbled "text";
//      the `Host` header and TLS `tls.serverName` now use `current.host` (port included) with a
//      single trailing dot stripped (RFC 6066 forbids it in SNI, and Bun's TLS layer refused the
//      connection outright over it); a network-error message relays Bun's own structural `err.code`
//      (`"ConnectionRefused"`, `"DEPTH_ZERO_SELF_SIGNED_CERT"`, ...) instead of the near-useless
//      `err.name` (almost always the bare string `"Error"`), never `.message`; a sub-second timeout
//      no longer rounds down to "0s".
import { STATUS_CODES } from "node:http";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
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

export const WEB_FETCH_MAX_ENCODED_BYTES = 2 * 1024 * 1024;

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

export type BodyReadResult =
  | { kind: "ok"; body: Uint8Array }
  | { kind: "output-cap-exceeded" }
  | { kind: "input-cap-exceeded" }
  | { kind: "unsupported-encoding"; encoding: string };

/**
 * Reads up to `WEB_FETCH_MAX_BYTES` of DECOMPRESSED output, streaming through the matching decoder
 * chain (finding B2, and finding N1/N3 below). `undefined`-shaped results (the two `-cap-exceeded`
 * kinds, and `unsupported-encoding`) are ORDINARY VALUES; a genuine stream error (network drop, the
 * hop timeout, a turn abort, malformed compressed data) PROPAGATES instead of being swallowed here,
 * so the caller's own try/catch (B1) classifies it as aborted/timeout/network-error using the SAME
 * signal it already has in scope.
 *
 * `Content-Encoding` may list SEVERAL codings (`"gzip, br"`), applied in that order when the server
 * encoded the body -- decoding undoes them in REVERSE, so the decoder chain is built over the
 * REVERSED token list. An unrecognised coding is refused OUTRIGHT, before a single byte is read: the
 * earlier version silently passed an unknown coding's raw compressed bytes through as "text," which a
 * `TextDecoder` renders as garbled nonsense reaching the digest model -- wrong, not merely ugly.
 *
 * TWO independent caps, finding N3: `WEB_FETCH_MAX_BYTES` bounds the DECOMPRESSED output exactly as
 * B2 already did, but for an ENCODED body that alone is not enough -- an endless stream of empty
 * stored deflate blocks has near-infinite COMPRESSED input and almost no decompressed output, so the
 * output cap never trips while the input read (and the decoder's own internal buffering) runs
 * unbounded. `WEB_FETCH_MAX_ENCODED_BYTES` (2 MiB, well below `WEB_FETCH_MAX_BYTES`) caps the
 * COMPRESSED bytes read off the wire for any body carrying a real `Content-Encoding`; identity bodies
 * keep the full 10 MiB cap, since there is no decompression amplification to bound there.
 *
 * `pipeline()`, not `.pipe()` (finding N1): `.pipe()` never forwards a SOURCE stream's own `error`
 * event to what it is piped into, so a source that errors (the hop timeout firing, `ctx.signal`
 * aborting, a socket reset) left a downstream decoder waiting on an `end`/`error` it would never
 * receive -- an unconditional hang, worse than any cap this function enforces itself. `pipeline()`
 * forwards a source error to every stream in the chain and guarantees each one is destroyed,
 * measured against this exact Bun version (a 400 ms `AbortSignal.timeout` on a stalled body returned
 * a catchable `TimeoutError` in ~400 ms; a mid-body socket reset returned in ~50 ms; neither hung).
 */
async function readBodyCapped(response: Response, contentEncoding: string): Promise<BodyReadResult> {
  if (response.body === null || response.body === undefined) return { kind: "ok", body: new Uint8Array(0) };

  const tokens = contentEncoding
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0 && t !== "identity");
  const decoders: Transform[] = [];
  for (const token of [...tokens].reverse()) {
    const decoder = decompressorFor(token);
    if (decoder === undefined) return { kind: "unsupported-encoding", encoding: token };
    decoders.push(decoder);
  }
  const inputCap = decoders.length > 0 ? WEB_FETCH_MAX_ENCODED_BYTES : WEB_FETCH_MAX_BYTES;

  const source = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>);
  let inBytes = 0;
  let verdict: "input-cap-exceeded" | "output-cap-exceeded" | undefined;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      inBytes += chunk.byteLength;
      if (inBytes > inputCap) {
        verdict = "input-cap-exceeded";
        cb(new Error("WebFetch: input cap exceeded"));
      } else {
        cb(null, chunk);
      }
    },
  });

  const chunks: Buffer[] = [];
  let total = 0;
  const sink = async (src: NodeJS.ReadableStream): Promise<void> => {
    for await (const chunk of src) {
      const buf = chunk as Buffer;
      total += buf.byteLength;
      if (total > WEB_FETCH_MAX_BYTES) {
        verdict = "output-cap-exceeded";
        throw new Error("WebFetch: output cap exceeded");
      }
      chunks.push(buf);
    }
  };

  try {
    await pipeline(source, meter, ...decoders, sink);
  } catch (err) {
    if (verdict !== undefined) return { kind: verdict };
    throw err;
  }
  return { kind: "ok", body: new Uint8Array(Buffer.concat(chunks, total)) };
}

interface ConnectCandidate {
  /** An IP literal, unbracketed. */
  address: string;
  family: 4 | 6;
}

interface ResolvedTarget {
  verdict: PrivateAddressFinding;
  /**
   * Every candidate to CONNECT to, in resolution order (finding N4). Used only when `verdict` is
   * public: `dns.lookup(..., {all:true})` orders its answers (often IPv6 first on a dual-stack
   * machine), and pinning to `candidates[0]` alone means a network with broken IPv6 turns every
   * dual-stack site into a full timeout instead of falling back to the next, working address --
   * EVERY address here already went through the SAME classification `verdict` summarises (a private
   * one among them refuses outright, before any candidate is ever tried), so advancing through this
   * list on a connect failure never reaches an address the policy would have refused.
   */
  candidates: readonly ConnectCandidate[];
}

/**
 * Resolves `hostname` EXACTLY ONCE and returns both the classification AND the address to connect
 * to, so the two can never disagree (finding M6): the address the private-address policy was
 * evaluated against is the SAME one the fetch call below pins to, never a second, independently
 * (and possibly differently) resolved one. `undefined` means resolution genuinely failed or answered
 * no addresses -- the caller refuses outright; there is no address left to fail open onto.
 *
 * NIT, corrected (security review round 2 -- the FIRST round's version of this comment was factually
 * wrong): Bun's `fetch` honours `HTTPS_PROXY`/`https_proxy` at the process level, but MEASURED against
 * a real proxy, pinning to the resolved IP SURVIVES it -- the proxy receives `CONNECT
 * [<pinned-ip>]:443`, not the logical hostname, so it never re-resolves `hostname` itself, and proxy
 * auth (if any) reaches only the proxy, never the origin. The real caveat is narrower: a proxy that
 * allowlists by HOSTNAME may refuse an IP-literal `CONNECT` outright, and its refusal (a 502) then
 * reaches the caller as `WebFetch`'s own generic "the response body was not retrieved... if this URL
 * requires authentication" wording -- a misattribution (the proxy refused the CONNECT, not the
 * origin demanding credentials), disclosed here since nothing in this module can tell the two apart
 * from a bare 502.
 */
async function resolveTarget(hostname: string, resolveHost: (hostname: string) => Promise<readonly string[]>): Promise<ResolvedTarget | undefined> {
  const bare = stripIpv6Brackets(hostname);
  const literalFamily = isIP(bare);
  if (literalFamily !== 0) {
    const verdict = classifyIpLiteral(bare) ?? { class: "public" as const };
    return { verdict, candidates: [{ address: bare, family: literalFamily as 4 | 6 }] };
  }
  const reserved = classifyReservedName(hostname);
  let addresses: readonly string[];
  try {
    addresses = await resolveHost(hostname);
  } catch {
    return undefined;
  }
  if (addresses.length === 0) return undefined;
  const familyOf = (addr: string): 4 | 6 => (isIP(addr) === 6 ? 6 : 4);
  const candidates: ConnectCandidate[] = addresses.map((address) => ({ address, family: familyOf(address) }));
  if (reserved !== undefined) {
    // A reserved NAME is private regardless of what it resolves to -- but candidates are still
    // gathered in case the policy ends up "allow," best-effort.
    return { verdict: reserved, candidates };
  }
  for (const address of addresses) {
    const verdict = classifyResolvedAddress(address);
    if (verdict.class === "private") return { verdict, candidates };
  }
  return { verdict: { class: "public" }, candidates };
}

/** The DNS root's trailing dot (RFC 6066 forbids it in a TLS SNI `server_name`; Bun's own TLS layer refuses the handshake outright over it). Stripped for BOTH `tls.serverName` and the `Host` header -- a security review minor. */
function stripTrailingDot(hostname: string): string {
  return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}

/** The `Host` header and TLS SNI name for `url` -- `url.host` (port included, security review minor: the earlier version used `.hostname` alone and silently dropped a non-default port), dot-stripped. */
function hostAndSniFor(url: URL): { host: string; sni: string } {
  const sni = stripTrailingDot(url.hostname);
  const host = url.port !== "" ? `${sni}:${url.port}` : sni;
  return { host, sni };
}

/** A connect-phase failure's safe label: Bun's own structural `err.code` (`"ConnectionRefused"`, `"DEPTH_ZERO_SELF_SIGNED_CERT"`, ...) when it is a non-empty string, else the error's NAME -- never `.message` (security review minor: `err.name` is almost always the bare string `"Error"`, which tells the model nothing; `.code` is what actually distinguishes a refused connection from a bad certificate). */
function errorLabel(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.length > 0) return code;
  return err instanceof Error ? err.name : "unknown error";
}

/** Item 3: the ONE spelling of a hop timeout, shared by the pre-resolve race below and the fetch's own catch, so the two can never drift apart. */
function timeoutMessage(timeoutMs: number): string {
  const seconds = timeoutMs / 1000;
  return `WebFetch timed out after ${seconds < 1 ? `${timeoutMs}ms` : `${Math.round(seconds)}s`}.`;
}

/**
 * Item 3: races `promise` against `signal` aborting, resolving `"aborted"` first if the signal wins.
 * Used to bound `resolveTarget`'s own DNS lookup by the SAME per-hop signal (turn abort + the 60 s
 * hop timeout, `AbortSignal.any`-combined) the fetch itself already races against below --
 * `resolveTarget` used to run BEFORE that signal even existed, so a resolver that never settles sat
 * outside the hop timeout entirely and ignored `ctx.signal` altogether: an UNCONDITIONAL hang, not
 * merely an unbounded one, and never a throw -- `resolveTarget` itself never rejects (its own
 * try/catch already turns a throwing resolver into `undefined`), so there is no rejection branch to
 * forward here, unlike `web-fetch.ts`'s own `raceAgainstAbort`, which races a promise that can.
 *
 * NEVER calls `signal.removeEventListener` -- measured (Bun 1.3.14): calling `removeEventListener
 * ("abort", ...)` on an `AbortSignal.timeout()`/`AbortSignal.any()` signal that is later handed to
 * `fetch()` as ITS OWN abort signal silently disables that signal's future abort delivery, so the
 * fetch that follows this race, on the SAME `signal`, then never times out at all (reproduced in
 * isolation: add+remove -> the subsequent fetch runs to completion past its timeout; add alone,
 * never removed -> the fetch aborts correctly). The abort listener below is therefore added once and
 * simply left attached for the signal's whole lifetime -- a single per-hop signal, so this is not a
 * leak -- and `Promise.race`'s losing side (whichever of the two never settles first) is never
 * awaited again; its eventual settlement is ignored, not cancelled.
 */
function raceResolveAgainstSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | "aborted"> {
  if (signal.aborted) return Promise.resolve("aborted");
  const aborted = new Promise<"aborted">((resolve) => {
    signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
  return Promise.race([promise, aborted]);
}

/** How long ONE candidate address gets to complete its TCP/TLS connect before this module gives up on it and tries the next (finding N4) -- short relative to the whole hop's own `timeoutMs`, so one unreachable address cannot eat the entire budget when a working one is still available. */
const CONNECT_BUDGET_MS = 10_000;

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

    // Item 3: the per-hop timeout/abort signal is created HERE, before `resolveTarget`, not after it
    // -- so the DNS lookup itself is inside the hop's own budget, exactly like the fetch that follows
    // it. Created once per hop (matching the pre-existing "60 s timeout is PER HOP" design, above).
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal !== undefined ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;

    const resolved = await raceResolveAgainstSignal(resolveTarget(current.hostname, resolveHost), signal);
    if (resolved === "aborted") {
      if (opts.signal?.aborted === true) return { kind: "aborted" };
      return { kind: "timeout", message: timeoutMessage(timeoutMs) };
    }
    if (resolved === undefined) {
      return { kind: "network-error", message: `WebFetch could not resolve any address for ${current.hostname}.` };
    }
    if (resolved.verdict.class === "private") {
      if (opts.privateAddressPolicy === "deny") return { kind: "private-address", host: current.hostname, policy: "deny" };
      if (opts.privateAddressPolicy === "ask") return { kind: "private-address", host: current.hostname, policy: "ask" };
      // "allow" falls through to the fetch, pinned to the SAME address just classified.
    }

    const scope = preapprovedScopeOf(current);

    const { host: hostHeader, sni } = hostAndSniFor(current);

    let response: Response;
    let outcome: WebFetchNetOutcome | undefined;
    try {
      // Try every classified candidate address in order (finding N4), abandoning one ONLY before a
      // `Response` comes back (a connect/TLS failure) -- never once bytes have arrived. Every attempt
      // carries the FULL hop `signal` (never a shortened one): the connect BUDGET is a separate,
      // LOCAL race against a timer, not a second abort signal handed to `fetchImpl` -- an abort
      // signal that fired the request itself, so shortening it for a candidate that goes on to
      // SUCCEED would then wrongly cut its own BODY read short later, at the budget's 10 s mark
      // rather than the real, full hop timeout. The losing side of a race (a candidate that is still
      // connecting when the next one starts) keeps running in the background and is never awaited
      // again; its own eventual settlement is swallowed so it can never become an unhandled rejection.
      let connectFailure: unknown;
      let connected: Response | undefined;
      for (let i = 0; i < resolved.candidates.length; i++) {
        const candidate = resolved.candidates[i]!;
        const isLast = i === resolved.candidates.length - 1;
        // Pin the CONNECTION to the address just resolved and classified (finding M6): the logical
        // hostname travels as `Host` (virtual hosting) and `tls.serverName` (certificate validation by
        // name), never as the DNS name `fetch()` itself would otherwise resolve a SECOND, unpinned time.
        const connectUrl = new URL(current.toString());
        connectUrl.hostname = candidate.family === 6 ? `[${candidate.address}]` : candidate.address;
        const attempt = fetchImpl(connectUrl.toString(), {
          redirect: "manual",
          headers: { Accept: "text/markdown, text/html, */*", "User-Agent": opts.userAgent, Host: hostHeader },
          signal,
          decompress: false,
          tls: { serverName: sni },
        });
        attempt.catch(() => {}); // see the comment above: a background loser must never surface as unhandled.
        if (isLast) {
          try {
            connected = await attempt;
          } catch (err) {
            connectFailure = err;
          }
          break;
        }
        const settled = await Promise.race([
          attempt.then((r): { ok: true; r: Response } => ({ ok: true, r })).catch((e: unknown): { ok: false; e: unknown } => ({ ok: false, e })),
          new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), CONNECT_BUDGET_MS)),
        ]);
        if (settled === "timed-out") {
          connectFailure = new Error("WebFetch: candidate connect budget exceeded");
          continue;
        }
        if (!settled.ok) {
          connectFailure = settled.e;
          // The WHOLE hop is out of time or the turn was aborted -- stop trying candidates; the outer
          // catch below classifies this exactly as it always has.
          if (opts.signal?.aborted === true || timeoutSignal.aborted) break;
          continue;
        }
        connected = settled.r;
        break;
      }
      if (connected === undefined) throw connectFailure ?? new Error("WebFetch: no candidate address could be reached");
      response = connected;

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
        const bodyResult = await readBodyCapped(response, response.headers.get("content-encoding") ?? "");
        switch (bodyResult.kind) {
          case "ok":
            outcome = {
              kind: "success",
              finalUrl: current.toString(),
              status: response.status,
              statusText: reasonPhrase(response.status),
              contentType: response.headers.get("content-type") ?? "",
              body: bodyResult.body,
            };
            break;
          case "output-cap-exceeded":
            outcome = { kind: "size-exceeded", message: `The response body exceeded WebFetch's ${WEB_FETCH_MAX_BYTES.toLocaleString("en-US")}-byte limit and was not retrieved.` };
            break;
          case "input-cap-exceeded":
            outcome = { kind: "size-exceeded", message: `The response's encoded body exceeded WebFetch's ${WEB_FETCH_MAX_ENCODED_BYTES.toLocaleString("en-US")}-byte limit for compressed content and was not retrieved.` };
            break;
          case "unsupported-encoding":
            outcome = { kind: "network-error", message: `the response uses an unsupported Content-Encoding ("${bodyResult.encoding}") and could not be decoded` };
            break;
        }
      }
    } catch (err) {
      // ONE catch for BOTH the header fetch and the body read (finding B1) -- a body-phase failure
      // (a torn socket, the hop timeout crossed mid-body, a turn abort) is classified exactly like a
      // header-phase one, never an unhandled rejection.
      if (opts.signal?.aborted === true) return { kind: "aborted" };
      if (timeoutSignal.aborted) return { kind: "timeout", message: timeoutMessage(timeoutMs) };
      return { kind: "network-error", message: errorLabel(err) };
    }
    return outcome;
  }
}
