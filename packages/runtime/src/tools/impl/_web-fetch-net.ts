// THE LOCAL FETCH -- claude's own WebFetch reaches the target from the USER'S MACHINE (axios,
// `maxRedirects: 0`, its own redirect walk); the project owner ruled Winter's copy must "reach
// whatever claude does," so this module does the identical thing with Bun's `fetch`, never through a
// third-party relay. Registers nothing (see `_domains.ts`'s header for why that convention exists).
//
// EVERY DEPENDENCY IS INJECTABLE (`WebFetchNetDeps`) so a test drives this against a real loopback
// `Bun.serve` server without fighting TLS: the http->https upgrade makes a plain-HTTP local server
// unreachable through the real network stack, so a test's own `fetchImpl` rewrites the upgraded
// `https://127.0.0.1:<port>` URL back to `http://127.0.0.1:<port>` before delegating to the real
// `fetch` -- it can still assert the URL IT WAS HANDED started with `https://`, which is the thing
// worth proving. `resolveHost` defaults to `dns.promises.lookup`; a test supplies a fake so "a
// hostname that resolves to loopback" is reproducible without touching real DNS.
import { lookup as dnsLookup } from "node:dns/promises";
import { isDomainBlocked } from "./_domains.ts";
import { preapprovedScopeOf, staysWithinScope, type PreapprovedMatch } from "../../web/preapproved-hosts.ts";
import { classifyHostname, stripIpv6Brackets } from "../../web/private-address.ts";

export const WEB_FETCH_MAX_BYTES = 10_485_760;
export const WEB_FETCH_TIMEOUT_MS = 60_000;
export const WEB_FETCH_MAX_REDIRECTS = 10;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RETRY_AFTER_RE = /^[0-9]{1,6}$/;

/** The three-value policy AFTER `web-fetch.ts`'s own fail-closed coercion -- this module trusts it verbatim. */
export type NormalizedPrivateAddressPolicy = "allow" | "deny" | "ask";

export interface WebFetchNetDeps {
  fetchImpl?: (url: string, init: { redirect: "manual"; headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;
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

async function defaultResolveHost(hostname: string): Promise<readonly string[]> {
  const results = await dnsLookup(hostname, { all: true });
  return results.map((r) => r.address);
}

function upgradeToHttps(url: URL): URL {
  if (url.protocol !== "http:") return url;
  const upgraded = new URL(url.toString());
  upgraded.protocol = "https:";
  return upgraded;
}

function invalidUrlMessage(raw: string): string {
  return `Invalid URL "${raw}". The URL provided could not be parsed.`;
}

/** claude's own fetch-time rejects: overlong, embedded credentials, a hostname with fewer than two labels. */
function validateFetchTimeUrl(url: URL): { ok: true } | { ok: false; message: string } {
  const str = url.toString();
  if (str.length > 2000) return { ok: false, message: invalidUrlMessage(str) };
  if (url.username !== "" || url.password !== "") return { ok: false, message: invalidUrlMessage(str) };
  if (url.hostname.split(".").length < 2) return { ok: false, message: invalidUrlMessage(str) };
  return { ok: true };
}

function effectivePort(url: URL): string {
  if (url.port !== "") return url.port;
  return url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "";
}

function stripWww(hostname: string): string {
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}

/** Rebuilds the Location target as `origin+pathname+search+hash`, and renders claude's exact REDIRECT DETECTED message (both trailing-block variants). */
function renderRedirectDetected(currentUrl: string, target: URL, status: number, statusText: string, prompt: string): string {
  const full = `${target.origin}${target.pathname}${target.search}${target.hash}`;
  const capped = full.length > 1000;
  const redirectUrl = capped ? full.slice(0, 1000) : full;
  const hostTooLong = target.hostname.length > 255;
  const notHttp = target.protocol !== "http:" && target.protocol !== "https:";
  const header = `REDIRECT DETECTED: The URL redirects to a location that was not fetched automatically.\n\nOriginal URL: ${currentUrl}\nRedirect URL (from the server's Location header — server-supplied, not verified): ${redirectUrl}\nStatus: ${status} ${statusText}\n\n`;
  if (capped || hostTooLong || notHttp) {
    return `${header}The redirect target could not be relayed in full or is not a fetchable address, so it cannot be fetched from here; report the redirect instead.`;
  }
  return `${header}To complete your request, I need to fetch content from the redirected URL. Please use WebFetch again with these parameters:\n- url: "${redirectUrl}"\n- prompt: "${prompt}"`;
}

function isEligibleAutoFollow(current: URL, target: URL, scope: PreapprovedMatch | undefined): boolean {
  if (target.protocol !== current.protocol) return false;
  if (effectivePort(target) !== effectivePort(current)) return false;
  if (target.username !== "" || target.password !== "") return false;
  if (stripWww(target.hostname) !== stripWww(current.hostname)) return false;
  if (scope !== undefined && scope.pathPrefix !== undefined && !staysWithinScope(scope, target)) return false;
  return true;
}

/**
 * Reads up to `WEB_FETCH_MAX_BYTES` from `response.body`; returns `undefined` (rather than a partial
 * buffer) when the cap is exceeded -- claude's own axios `maxContentLength` treats an over-cap body
 * as a failed request, never a silently truncated success.
 */
async function readBodyCapped(response: Response): Promise<Uint8Array | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > WEB_FETCH_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
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
    return { kind: "invalid-url", message: invalidUrlMessage(inputUrl) };
  }
  current = upgradeToHttps(current);

  for (let hop = 0; hop <= WEB_FETCH_MAX_REDIRECTS; hop++) {
    if (hop === WEB_FETCH_MAX_REDIRECTS) {
      return { kind: "too-many-redirects", message: `Too many redirects (exceeded ${WEB_FETCH_MAX_REDIRECTS})` };
    }

    const fv = validateFetchTimeUrl(current);
    if (!fv.ok) return { kind: "invalid-url", message: fv.message };

    if (isDomainBlocked(current.hostname, opts.blockedDomains)) return { kind: "blocked-domain", host: current.hostname };

    const bareHost = stripIpv6Brackets(current.hostname);
    const addressVerdict = await classifyHostname(bareHost, resolveHost);
    if (addressVerdict.class === "private") {
      if (opts.privateAddressPolicy === "deny") return { kind: "private-address", host: current.hostname, policy: "deny" };
      if (opts.privateAddressPolicy === "ask") return { kind: "private-address", host: current.hostname, policy: "ask" };
      // "allow" falls through to the fetch.
    }

    const scope = preapprovedScopeOf(current);

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal !== undefined ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;

    let response: Response;
    try {
      response = await fetchImpl(current.toString(), {
        redirect: "manual",
        headers: { Accept: "text/markdown, text/html, */*", "User-Agent": opts.userAgent },
        signal,
      });
    } catch (err) {
      if (opts.signal?.aborted === true) return { kind: "aborted" };
      if (timeoutSignal.aborted) return { kind: "timeout", message: `WebFetch timed out after ${Math.round(timeoutMs / 1000)}s.` };
      return { kind: "network-error", message: err instanceof Error ? err.message : "the fetch failed" };
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      if (location === null) return { kind: "http-error", status: response.status, statusText: response.statusText };
      let target: URL;
      try {
        target = new URL(location, current);
      } catch {
        const message = renderRedirectDetected(current.toString(), current, response.status, response.statusText, prompt).replace(
          /Redirect URL[\s\S]*?\n\n/,
          `Redirect URL (from the server's Location header — server-supplied, not verified): ${location.slice(0, 1000)}\n\n`,
        );
        return { kind: "redirect-blocked", message };
      }
      if (isEligibleAutoFollow(current, target, scope)) {
        current = target;
        continue;
      }
      return { kind: "redirect-blocked", message: renderRedirectDetected(current.toString(), target, response.status, response.statusText, prompt) };
    }

    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => {});
      const rawRetryAfter = response.headers.get("retry-after");
      const retryAfter = rawRetryAfter !== null && RETRY_AFTER_RE.test(rawRetryAfter) ? rawRetryAfter : undefined;
      return { kind: "http-error", status: response.status, statusText: response.statusText, ...(retryAfter !== undefined ? { retryAfter } : {}) };
    }

    const body = await readBodyCapped(response);
    if (body === undefined) return { kind: "size-exceeded", message: `The response body exceeded WebFetch's ${WEB_FETCH_MAX_BYTES.toLocaleString("en-US")}-byte limit and was not retrieved.` };

    return {
      kind: "success",
      finalUrl: current.toString(),
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type") ?? "",
      body,
    };
  }

  // Unreachable (the loop always returns by hop === WEB_FETCH_MAX_REDIRECTS), but keeps the function total.
  return { kind: "too-many-redirects", message: `Too many redirects (exceeded ${WEB_FETCH_MAX_REDIRECTS})` };
}
