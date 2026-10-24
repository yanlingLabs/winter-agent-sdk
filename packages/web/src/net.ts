// THE FETCH -- one HTTP request per hop, each hop re-validated, the connection pinned to the address
// that was validated.
//
// PER HOP, in this order, before a single byte leaves the machine:
//   1. the https upgrade and the lexical refusals (`url.ts`): overlong, embedded credentials, fewer
//      than two labels, a scheme other than http(s);
//   2. the `blockedDomains` floor (`domains.ts`);
//   3. under `privateAddressPolicy: "deny"`: the hostname's LEXICAL verdict (an address literal in any
//      notation, `localhost`, `.local`), then -- for an ordinary name -- ONE resolution, every
//      answer classified (`address.ts`). ANY non-public answer refuses the hop: a mixed answer (one
//      public A record, one private AAAA) is refused as a whole, never "connect to the public one";
//   4. the connection, made to the validated ADDRESS ITSELF (`WebFetchTransportRequest.address`),
//      never to the hostname. Nothing resolves the name a second time, so a DNS-rebinding answer
//      after the check has nothing to act on. The logical hostname travels only as the `Host`
//      header and the TLS server name (certificate validation is by name, as usual).
//
// The default transport (`transport-node.ts`) is `node:http`/`node:https`, which behaves the same
// under Node and Bun; it also checks, under Node, that the socket's remote address IS the pinned
// one. Redirects are never followed by the transport: every Location is walked here, through the
// same four steps, up to `maxRedirects`.
//
// Every refusal is a typed value, never a throw, and no message carries URL userinfo, a proxy URL or
// any server-controlled text (status reason phrases come from Node's fixed table).
import { STATUS_CODES } from "node:http";
import { lookup as dnsLookup } from "node:dns/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { classifyAddress, classifyHostnameLexically, formatAddress, hostnameAsAddress, parseIpLiteral, type AddressRefusalReason } from "./address.ts";
import { isDomainBlocked } from "./domains.ts";
import { fetchTimeUrlRefusal, upgradeToHttps, urlWithoutCredentials, type UnfetchableUrlReason } from "./url.ts";
import { createNodeWebFetchTransport } from "./transport-node.ts";

export const WEB_FETCH_MAX_BYTES = 10_485_760;
/** The cap on COMPRESSED bytes read for a body with a real `Content-Encoding` (an empty-block stream inflates to nothing while its input runs forever). */
export const WEB_FETCH_MAX_ENCODED_BYTES = 2 * 1024 * 1024;
export const WEB_FETCH_TIMEOUT_MS = 60_000;
export const WEB_FETCH_MAX_REDIRECTS = 10;
/** How long one resolved address gets to connect before the next one is tried. */
export const WEB_FETCH_CONNECT_BUDGET_MS = 10_000;
export const WEB_FETCH_ACCEPT = "text/markdown, text/html, */*";
export const WEB_FETCH_DEFAULT_USER_AGENT = "winter-web (+https://github.com/yanlingLabs/winter-agent-sdk)";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RETRY_AFTER_RE = /^[0-9]{1,6}$/;

/** The standard reason phrase for `status`, from Node's fixed table -- never the server's own status line. */
export function reasonPhrase(status: number): string {
  return STATUS_CODES[status] ?? "Unknown Status";
}

export type PrivateAddressPolicy = "deny" | "allow";

/**
 * Which redirects are followed (each one re-validated in full):
 *   `"any"` (default) -- every http(s) Location, upgraded to https;
 *   `"same-host"` -- only one to the same scheme, port and host (a `www.` prefix ignored), as
 *     claude's WebFetch does; any other is returned as `redirect_not_followed`;
 *   a function -- yours to decide, given the hop's URL and the parsed Location.
 */
export type RedirectPolicy = "any" | "same-host" | ((from: URL, to: URL) => boolean);

/** What happens to a body over `maxBytes`: `"truncate"` (default) keeps the first `maxBytes`, `"fail"` refuses it. */
export type OverflowPolicy = "truncate" | "fail";

/** One request the transport must make: to `address`, never to a name. */
export interface WebFetchTransportRequest {
  /** The URL to request: https, its host already replaced by `address` (bracketed for IPv6). */
  url: URL;
  /** The validated address to connect to, unbracketed. */
  address: string;
  family: 4 | 6;
  /** The logical hostname with one trailing dot removed -- for TLS SNI and certificate validation. Equal to `address` for an address-literal target. */
  serverName: string;
  /** Request headers, `Host` (the logical host, port included) among them. */
  headers: Record<string, string>;
  /** Aborts the request and its body. */
  signal: AbortSignal;
}

export interface WebFetchTransportResponse {
  status: number;
  headers: { get(name: string): string | null };
  /** The body, still encoded (the transport must not decompress). `null` for none. */
  body: AsyncIterable<Uint8Array> | null;
  /** Releases the connection without reading the body. Never throws. */
  cancel(): void;
}

/** Makes one request; never follows a redirect and never decompresses. A thrown error is a connect-phase failure. */
export type WebFetchTransport = (request: WebFetchTransportRequest) => Promise<WebFetchTransportResponse>;

export interface WebFetchOptions {
  signal?: AbortSignal;
  /** Per hop -- DNS, connect, headers and body together. Default 60 s. */
  timeoutMs?: number;
  /** The cap on the DECODED body. Default 10 MiB. */
  maxBytes?: number;
  /** The cap on COMPRESSED input for an encoded body. Default 2 MiB. */
  maxEncodedBytes?: number;
  onOverflow?: OverflowPolicy;
  /** `"deny"` unless exactly `"allow"` is passed -- any other value, `undefined` included, is `"deny"`. */
  privateAddressPolicy?: PrivateAddressPolicy;
  userAgent?: string;
  /** Hosts never fetched, on any hop (suffix match on a label boundary). */
  blockedDomains?: readonly string[];
  /** Redirects followed before `too_many_redirects`. Default 10. */
  maxRedirects?: number;
  followRedirects?: RedirectPolicy;
  /** Resolves a hostname to its addresses (ADVANCED; a test's fake resolver). Default `dns.lookup(host, { all: true })`. */
  resolveHost?: (hostname: string) => Promise<readonly string[]>;
  /** Makes the request (ADVANCED). Default `createNodeWebFetchTransport()`. It is handed only validated addresses. */
  transport?: WebFetchTransport;
  /** Per-address connect budget before the next resolved address is tried. Default 10 s. */
  connectBudgetMs?: number;
}

export type WebFetchFailureCode =
  | "invalid_url"
  | "blocked_domain"
  | "private_address"
  | "unresolvable"
  | "redirect_not_followed"
  | "too_many_redirects"
  | "http_error"
  | "too_large"
  | "unsupported_encoding"
  | "timeout"
  | "aborted"
  | "network_error";

export type WebFetchFailure =
  | { ok: false; code: "invalid_url"; reason: UnfetchableUrlReason | "unparseable"; message: string }
  | { ok: false; code: "blocked_domain"; host: string; message: string }
  | { ok: false; code: "private_address"; host: string; reason: AddressRefusalReason; message: string }
  | { ok: false; code: "unresolvable"; host: string; message: string }
  /** `location` is the server's target with any userinfo removed; absent when it was not an http(s) URL. */
  | { ok: false; code: "redirect_not_followed"; from: string; status: number; location?: string; message: string }
  | { ok: false; code: "too_many_redirects"; maxRedirects: number; message: string }
  | { ok: false; code: "http_error"; status: number; statusText: string; retryAfter?: string; message: string }
  | { ok: false; code: "too_large"; limit: "decoded" | "encoded"; maxBytes: number; message: string }
  | { ok: false; code: "unsupported_encoding"; encoding: string; message: string }
  | { ok: false; code: "timeout"; timeoutMs: number; message: string }
  | { ok: false; code: "aborted"; message: string }
  /** `detail` is a structural error code (`ECONNREFUSED`, `CERT_HAS_EXPIRED`, ...) or an error name -- never an error message. */
  | { ok: false; code: "network_error"; detail: string; message: string };

export interface WebResource {
  ok: true;
  /** The URL actually fetched (after the upgrade and any redirects). */
  finalUrl: string;
  status: number;
  statusText: string;
  contentType: string;
  /** The decoded body. */
  body: Uint8Array;
  /** True when the body was cut at `maxBytes` (or the encoded cap) under `onOverflow: "truncate"`. */
  truncated: boolean;
}

export type WebFetchResult = WebResource | WebFetchFailure;

/** The default resolver: every address the system resolver returns, in its order. */
export async function defaultResolveHost(hostname: string): Promise<readonly string[]> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

function stripWww(hostname: string): string {
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}

/** claude's WebFetch auto-follow rule: same scheme, same port (compared as written), no userinfo, same host with a `www.` prefix ignored. */
export function isSameHostRedirect(from: URL, to: URL): boolean {
  if (to.protocol !== from.protocol) return false;
  if (to.port !== from.port) return false;
  if (to.username !== "" || to.password !== "") return false;
  return stripWww(to.hostname) === stripWww(from.hostname);
}

function stripTrailingDot(hostname: string): string {
  return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}

function bare(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function errorLabel(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) return code;
  const name = err instanceof Error ? err.name : "";
  return /^[A-Za-z0-9_.-]{1,64}$/.test(name) ? name : "Error";
}

function timeoutMessage(timeoutMs: number): string {
  const seconds = timeoutMs / 1000;
  return `the fetch timed out after ${seconds < 1 ? `${timeoutMs}ms` : `${Math.round(seconds)}s`}`;
}

const INVALID_URL_MESSAGES: Record<UnfetchableUrlReason | "unparseable", string> = {
  unparseable: "the URL could not be parsed",
  "too-long": "the URL is longer than 2000 characters",
  "embedded-credentials": "the URL carries embedded credentials",
  "single-label-hostname": "the URL's hostname has fewer than two dot-separated labels",
  "unsupported-scheme": "only http and https URLs can be fetched",
};

function invalidUrl(reason: UnfetchableUrlReason | "unparseable"): WebFetchFailure {
  return { ok: false, code: "invalid_url", reason, message: `Invalid URL: ${INVALID_URL_MESSAGES[reason]}` };
}

// --- resolution --------------------------------------------------------------------------------------

interface Candidate {
  address: string;
  family: 4 | 6;
}

type Resolved =
  | { kind: "ok"; candidates: Candidate[]; refusal?: AddressRefusalReason }
  | { kind: "unresolvable" }
  | { kind: "aborted" };

function candidateOf(address: string): Candidate | undefined {
  const bytes = parseIpLiteral(address);
  if (bytes === undefined) return undefined;
  return { address: formatAddress(bytes), family: bytes.length === 16 ? 6 : 4 };
}

/**
 * The hop's connect candidates and, when any answer is not public, the refusal reason. Resolution
 * happens at most ONCE, and the candidates are what was classified: the caller connects to these
 * strings and nothing else.
 */
async function resolveHop(hostname: string, resolveHost: (hostname: string) => Promise<readonly string[]>, signal: AbortSignal, deny: boolean): Promise<Resolved> {
  const lexical = classifyHostnameLexically(hostname);
  const literal = hostnameAsAddress(hostname);
  if (literal !== undefined) {
    const candidate = { address: formatAddress(literal), family: literal.length === 16 ? 6 : 4 } as Candidate;
    return lexical !== undefined && !lexical.public ? { kind: "ok", candidates: [candidate], refusal: lexical.reason } : { kind: "ok", candidates: [candidate] };
  }
  // A name that is private by itself (`localhost`, `.local`) is refused without a lookup.
  if (deny && lexical !== undefined && !lexical.public) return { kind: "ok", candidates: [], refusal: lexical.reason };
  if (signal.aborted) return { kind: "aborted" };
  let addresses: readonly string[];
  try {
    const answer = resolveHost(stripTrailingDot(hostname));
    addresses = await new Promise<readonly string[] | "aborted">((resolve, reject) => {
      signal.addEventListener("abort", () => resolve("aborted"), { once: true });
      answer.then(resolve, reject);
    }).then((v) => {
      if (v === "aborted") throw ABORTED;
      return v;
    });
  } catch (err) {
    return err === ABORTED ? { kind: "aborted" } : { kind: "unresolvable" };
  }
  if (!Array.isArray(addresses) || addresses.length === 0) return { kind: "unresolvable" };
  const candidates: Candidate[] = [];
  let refusal: AddressRefusalReason | undefined = lexical !== undefined && !lexical.public ? lexical.reason : undefined;
  for (const address of addresses) {
    const verdict = classifyAddress(typeof address === "string" ? address : String(address));
    if (!verdict.public && refusal === undefined) refusal = verdict.reason;
    const candidate = typeof address === "string" ? candidateOf(address) : undefined;
    if (candidate !== undefined) candidates.push(candidate);
  }
  if (candidates.length === 0) return refusal !== undefined ? { kind: "ok", candidates, refusal } : { kind: "unresolvable" };
  return refusal !== undefined ? { kind: "ok", candidates, refusal } : { kind: "ok", candidates };
}

const ABORTED = Symbol("aborted");

/**
 * The hop rules for a host WITHOUT fetching it -- what a cache hit is re-checked against: the
 * blocked-domain floor and, under "deny", the lexical verdict and every resolved address. Resolution
 * failure refuses (`unresolvable`): there is no address to judge.
 */
export async function checkHostAllowed(
  hostname: string,
  options: Pick<WebFetchOptions, "privateAddressPolicy" | "blockedDomains" | "resolveHost" | "signal" | "timeoutMs">,
): Promise<WebFetchFailure | undefined> {
  if (isDomainBlocked(hostname, options.blockedDomains ?? [])) return { ok: false, code: "blocked_domain", host: hostname, message: `${hostname} is on the blocked-domain list` };
  if (options.privateAddressPolicy === "allow") return undefined;
  const timeoutMs = positive(options.timeoutMs, WEB_FETCH_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new HopTimeout("hop timeout")), timeoutMs);
  const onAbort = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted === true) controller.abort(options.signal.reason);
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const resolved = await resolveHop(hostname, options.resolveHost ?? defaultResolveHost, controller.signal, true);
    if (resolved.kind === "aborted") {
      if (options.signal?.aborted === true) return { ok: false, code: "aborted", message: "the fetch was aborted" };
      return { ok: false, code: "timeout", timeoutMs, message: timeoutMessage(timeoutMs) };
    }
    if (resolved.kind === "unresolvable") return { ok: false, code: "unresolvable", host: hostname, message: `could not resolve any address for ${hostname}` };
    if (resolved.refusal !== undefined) return { ok: false, code: "private_address", host: hostname, reason: resolved.refusal, message: privateMessage(hostname, resolved.refusal) };
    return undefined;
  } finally {
    clearTimeout(timer);
    if (!isBun) options.signal?.removeEventListener("abort", onAbort);
  }
}

function privateMessage(hostname: string, reason: AddressRefusalReason): string {
  return `${hostname} is a private, loopback or otherwise non-public address (${reason}), and private addresses are denied`;
}

// --- the body ------------------------------------------------------------------------------------

function decompressorFor(token: string): Transform | undefined {
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

type BodyRead = { kind: "ok"; body: Uint8Array; truncated: boolean } | { kind: "too-large"; limit: "decoded" | "encoded" } | { kind: "unsupported-encoding"; encoding: string };

/**
 * Reads the body through the `Content-Encoding` decoder chain (codings undone in REVERSE order; an
 * unknown coding is refused before a byte is read), with TWO independent caps: decoded output
 * (`maxBytes`) and, for an encoded body, compressed input (`maxEncodedBytes`). `pipeline()` carries
 * a source error to every stage, so a torn socket or an abort never leaves a decoder waiting; the
 * abort race bounds the wait even when a runtime ends the stream quietly instead of erroring it,
 * and the post-check refuses a body that ended cleanly at the moment the signal fired.
 */
async function readBody(body: AsyncIterable<Uint8Array> | null, contentEncoding: string, signal: AbortSignal, maxBytes: number, maxEncodedBytes: number, overflow: OverflowPolicy): Promise<BodyRead> {
  if (body === null) return { kind: "ok", body: new Uint8Array(0), truncated: false };
  const tokens = contentEncoding
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0 && t !== "identity");
  const decoders: Transform[] = [];
  for (const token of [...tokens].reverse()) {
    const decoder = decompressorFor(token);
    if (decoder === undefined) return { kind: "unsupported-encoding", encoding: token.slice(0, 64) };
    decoders.push(decoder);
  }
  const encoded = decoders.length > 0;
  const inputCap = maxEncodedBytes;

  const source = Readable.from(body, { objectMode: false });
  let inBytes = 0;
  let verdict: "input-over" | "output-over" | undefined;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      inBytes += chunk.byteLength;
      // An identity body is capped by the sink below (its input IS its output).
      if (!encoded || inBytes <= inputCap) return cb(null, chunk);
      verdict = "input-over";
      cb(new Error("encoded input cap reached"));
    },
  });
  const chunks: Buffer[] = [];
  let total = 0;
  const sink = async (src: AsyncIterable<Buffer>): Promise<void> => {
    for await (const chunk of src) {
      const remaining = maxBytes - total;
      if (chunk.byteLength > remaining) {
        if (overflow === "truncate" && remaining > 0) {
          chunks.push(chunk.subarray(0, remaining));
          total += remaining;
        }
        verdict = "output-over";
        throw new Error("output cap reached");
      }
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  };
  // Attached once and never removed: the signal is this hop's own.
  const aborted = new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  aborted.catch(() => {});
  const run = pipeline(source, meter, ...decoders, sink);
  run.catch(() => {});
  try {
    await Promise.race([run, aborted]);
  } catch (err) {
    if (signal.aborted) throw err;
    if (verdict === undefined) throw err;
    if (overflow === "fail") return { kind: "too-large", limit: verdict === "input-over" ? "encoded" : "decoded" };
    return { kind: "ok", body: new Uint8Array(Buffer.concat(chunks, total)), truncated: true };
  }
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
  return { kind: "ok", body: new Uint8Array(Buffer.concat(chunks, total)), truncated: false };
}

// --- the walk ------------------------------------------------------------------------------------

class HopTimeout extends Error {
  override name = "TimeoutError";
}

const isBun = typeof (process.versions as Record<string, string | undefined>)["bun"] === "string";

/**
 * Fetches `input`, walking redirects itself. Never throws for an expected failure: every refusal and
 * every network outcome is a typed `WebFetchFailure`.
 */
export async function fetchWebResource(input: string | URL, options: WebFetchOptions = {}): Promise<WebFetchResult> {
  const policy: PrivateAddressPolicy = options.privateAddressPolicy === "allow" ? "allow" : "deny";
  const timeoutMs = positive(options.timeoutMs, WEB_FETCH_TIMEOUT_MS);
  const maxBytes = positive(options.maxBytes, WEB_FETCH_MAX_BYTES);
  const maxEncodedBytes = positive(options.maxEncodedBytes, WEB_FETCH_MAX_ENCODED_BYTES);
  const maxRedirects = redirectCap(options.maxRedirects);
  const connectBudgetMs = positive(options.connectBudgetMs, WEB_FETCH_CONNECT_BUDGET_MS);
  const overflow: OverflowPolicy = options.onOverflow === "fail" ? "fail" : "truncate";
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const transport = options.transport ?? defaultTransport();
  const blocked = options.blockedDomains ?? [];
  const follow = options.followRedirects ?? "any";
  const userAgent = options.userAgent ?? WEB_FETCH_DEFAULT_USER_AGENT;
  const caller = options.signal;
  const callerAborted = (): boolean => caller?.aborted === true;

  let parsed: URL;
  try {
    parsed = input instanceof URL ? new URL(input.toString()) : new URL(input);
  } catch {
    return invalidUrl("unparseable");
  }
  let current = upgradeToHttps(parsed);
  if (callerAborted()) return { ok: false, code: "aborted", message: "the fetch was aborted" };

  // ONE listener on the caller's signal for the whole walk, forwarding to the hop in flight. Under
  // Bun it is never removed: removing an abort listener from an `AbortSignal.timeout()` signal
  // disables that signal's later abort delivery to `fetch()` there (measured on 1.3.14), which would
  // break the caller's own use of its signal after this call.
  let hop: AbortController | undefined;
  const onCallerAbort = (): void => hop?.abort(caller?.reason);
  caller?.addEventListener("abort", onCallerAbort, { once: true });
  try {
    let redirects = 0;
    for (;;) {
      if (current.protocol !== "https:") return invalidUrl("unsupported-scheme");
      const lexical = fetchTimeUrlRefusal(current);
      if (lexical !== undefined) return invalidUrl(lexical);
      if (isDomainBlocked(current.hostname, blocked)) return { ok: false, code: "blocked_domain", host: current.hostname, message: `${current.hostname} is on the blocked-domain list` };

      hop = new AbortController();
      const hopController = hop;
      const timer = setTimeout(() => hopController.abort(new HopTimeout("hop timeout")), timeoutMs);
      if (callerAborted()) hopController.abort(caller?.reason);
      try {
        const outcome = await oneHop(current, hopController.signal, redirects);
        if (outcome.kind === "follow") {
          redirects += 1;
          current = outcome.next;
          continue;
        }
        return outcome.result;
      } catch (err) {
        if (callerAborted()) return { ok: false, code: "aborted", message: "the fetch was aborted" };
        if (hopController.signal.aborted && hopController.signal.reason instanceof HopTimeout) return { ok: false, code: "timeout", timeoutMs, message: timeoutMessage(timeoutMs) };
        return { ok: false, code: "network_error", detail: errorLabel(err), message: `the request failed (${errorLabel(err)})` };
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    if (!isBun) caller?.removeEventListener("abort", onCallerAbort);
  }

  async function oneHop(url: URL, signal: AbortSignal, redirectsDone: number): Promise<{ kind: "follow"; next: URL } | { kind: "done"; result: WebFetchResult }> {
    const done = (result: WebFetchResult) => ({ kind: "done" as const, result });
    const resolved = await resolveHop(url.hostname, resolveHost, signal, policy === "deny");
    if (resolved.kind === "aborted") {
      if (callerAborted()) return done({ ok: false, code: "aborted", message: "the fetch was aborted" });
      return done({ ok: false, code: "timeout", timeoutMs, message: timeoutMessage(timeoutMs) });
    }
    if (resolved.kind === "unresolvable") return done({ ok: false, code: "unresolvable", host: url.hostname, message: `could not resolve any address for ${url.hostname}` });
    if (resolved.refusal !== undefined && policy === "deny") {
      return done({ ok: false, code: "private_address", host: url.hostname, reason: resolved.refusal, message: privateMessage(url.hostname, resolved.refusal) });
    }
    if (resolved.candidates.length === 0) return done({ ok: false, code: "unresolvable", host: url.hostname, message: `could not resolve any address for ${url.hostname}` });

    const serverName = stripTrailingDot(bare(url.hostname));
    const hostHeader = url.port !== "" ? `${stripTrailingDot(url.hostname)}:${url.port}` : stripTrailingDot(url.hostname);
    const headers = { Accept: WEB_FETCH_ACCEPT, "User-Agent": userAgent, Host: hostHeader };

    let response: WebFetchTransportResponse | undefined;
    let connectFailure: unknown;
    const abandoned: Array<Promise<WebFetchTransportResponse>> = [];
    for (let i = 0; i < resolved.candidates.length; i++) {
      const candidate = resolved.candidates[i]!;
      const connectUrl = new URL(url.toString());
      connectUrl.hostname = candidate.family === 6 ? `[${candidate.address}]` : candidate.address;
      const attempt = untilAborted(
        Promise.resolve().then(() => transport({ url: connectUrl, address: candidate.address, family: candidate.family, serverName, headers: { ...headers }, signal })),
        signal,
      );
      attempt.catch(() => {});
      if (i === resolved.candidates.length - 1) {
        try {
          response = await attempt;
        } catch (err) {
          connectFailure = err;
        }
        break;
      }
      let budget: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        attempt.then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e })),
        new Promise<"budget">((resolve) => {
          budget = setTimeout(() => resolve("budget"), connectBudgetMs);
        }),
      ]).finally(() => clearTimeout(budget));
      if (settled === "budget") {
        abandoned.push(attempt);
        connectFailure = new Error("connect budget exceeded");
        continue;
      }
      if (!settled.ok) {
        connectFailure = settled.e;
        if (signal.aborted) break;
        continue;
      }
      response = settled.r;
      break;
    }
    for (const loser of abandoned) void loser.then((r) => r.cancel(), () => {});
    if (response === undefined) throw connectFailure ?? new Error("no address could be reached");

    if (REDIRECT_STATUSES.has(response.status)) {
      response.cancel();
      const location = response.headers.get("location");
      let target: URL | undefined;
      if (location !== null && location.trim() !== "") {
        try {
          target = new URL(location, url);
        } catch {
          target = undefined;
        }
      }
      const statusText = reasonPhrase(response.status);
      if (target === undefined) return done({ ok: false, code: "http_error", status: response.status, statusText, message: `HTTP ${response.status} ${statusText} (a redirect with no usable Location)` });
      const httpTarget = target.protocol === "http:" || target.protocol === "https:";
      const eligible = httpTarget && (follow === "any" ? true : follow === "same-host" ? isSameHostRedirect(url, target) : safePolicy(follow, url, target));
      if (!eligible) {
        return done({
          ok: false,
          code: "redirect_not_followed",
          from: urlWithoutCredentials(url),
          status: response.status,
          ...(httpTarget ? { location: urlWithoutCredentials(target) } : {}),
          message: `HTTP ${response.status} ${statusText}: a redirect that was not followed`,
        });
      }
      if (redirectsDone >= maxRedirects) return done({ ok: false, code: "too_many_redirects", maxRedirects, message: `Too many redirects (exceeded ${maxRedirects})` });
      return { kind: "follow", next: upgradeToHttps(target) };
    }
    if (response.status < 200 || response.status >= 300) {
      response.cancel();
      const raw = response.headers.get("retry-after");
      const retryAfter = raw !== null && RETRY_AFTER_RE.test(raw) ? raw : undefined;
      const statusText = reasonPhrase(response.status);
      return done({ ok: false, code: "http_error", status: response.status, statusText, ...(retryAfter !== undefined ? { retryAfter } : {}), message: `HTTP ${response.status} ${statusText}` });
    }
    const read = await readBody(response.body, response.headers.get("content-encoding") ?? "", signal, maxBytes, maxEncodedBytes, overflow);
    if (read.kind === "unsupported-encoding") {
      response.cancel();
      return done({ ok: false, code: "unsupported_encoding", encoding: read.encoding, message: `the response uses an unsupported Content-Encoding ("${read.encoding}")` });
    }
    if (read.kind === "too-large") {
      response.cancel();
      const cap = read.limit === "encoded" ? maxEncodedBytes : maxBytes;
      return done({ ok: false, code: "too_large", limit: read.limit, maxBytes: cap, message: `the response body exceeded the ${cap.toLocaleString("en-US")}-byte limit${read.limit === "encoded" ? " for compressed content" : ""}` });
    }
    if (read.truncated) response.cancel();
    return done({
      ok: true,
      finalUrl: url.toString(),
      status: response.status,
      statusText: reasonPhrase(response.status),
      contentType: response.headers.get("content-type") ?? "",
      body: read.body,
      truncated: read.truncated,
    });
  }
}

/** `promise`, or a rejection the moment `signal` aborts -- a transport that never settles cannot hold a hop past its deadline. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.then((r) => (r as { cancel?: () => void } | undefined)?.cancel?.(), () => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (signal.aborted) (value as { cancel?: () => void } | undefined)?.cancel?.();
        resolve(value);
      },
      reject,
    );
  });
}

function safePolicy(policy: (from: URL, to: URL) => boolean, from: URL, to: URL): boolean {
  try {
    return policy(new URL(from.toString()), new URL(to.toString())) === true;
  } catch {
    return false;
  }
}

/** A caller's redirect cap: a non-negative integer, else the default -- NaN, Infinity, a negative or a fraction must not switch the cap off. */
function redirectCap(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : WEB_FETCH_MAX_REDIRECTS;
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

let sharedTransport: WebFetchTransport | undefined;
function defaultTransport(): WebFetchTransport {
  sharedTransport ??= createNodeWebFetchTransport();
  return sharedTransport;
}
