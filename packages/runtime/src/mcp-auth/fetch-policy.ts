// WS-25 (MCP OAuth) §6: THE auth-HTTP policy. Every request a sign-in, a refresh or a revocation makes --
// RFC 9728 protected-resource metadata, RFC 8414 / OIDC discovery, RFC 7591 registration, the token
// endpoint, RFC 7009 revocation -- goes through the `fetch` this file builds, handed to the MCP client
// package's auth functions as their `fetchFn`. Nothing in `mcp-auth` calls the network any other way.
//
// WHY A POLICY AT ALL. Every URL those requests reach comes from a DOCUMENT a server published: the MCP
// server names its authorization server, the authorization server names its token endpoint. A hostile or
// compromised MCP server (a project-scoped one from a cloned repository, spec §1.6) can therefore point
// the host's own process at anything -- the cloud metadata address, a LAN admin page, a plain-http
// endpoint whose traffic anyone on the path reads. The rules:
//
//   1. HTTPS ONLY, except a LITERAL loopback address (127.0.0.0/8, ::1, and the literal `localhost`,
//      which provider-runtime's classifier and the MCP client's own `assertSecureTokenEndpoint` both read
//      as loopback) -- and loopback at all (http OR https) ONLY when the MCP server itself is on loopback
//      (`allowLoopback`, fix round 1 M4): a public server's documents must not steer the host into its
//      own machine's services. A loopback server is a local installation (and the fixture's case).
//   2. A LITERAL private, link-local, unique-local, CGNAT, multicast or unspecified address is refused
//      whatever the scheme (SSRF). SYNCHRONOUS and resolver-free, exactly like provider-runtime's endpoint
//      policy: a DNS name is never resolved here, so it is never "local", and there is no resolved address
//      to be lied to about (the DNS-rebinding half is that file's header's argument, not repeated here).
//   3. NO CROSS-ORIGIN REDIRECTS -- refused outright, not followed with credentials stripped. A token
//      request carries a code verifier, a refresh token or a client secret in its BODY, and stripping
//      headers protects none of that; a discovery GET that hops origins is a server steering the host.
//      Same-origin hops (a trailing-slash redirect) are followed, at most `DEFAULT_MAX_REDIRECTS`.
//   4. CAPS: the WHOLE exchange -- headers AND body -- within `timeoutMs` (a server that drips its body
//      cannot hold a sign-in or a refresh open), a body of at most `maxBodyBytes`.
//   5. No userinfo in any URL.
//
// THE NETWORK UNDER IT. By default, provider-runtime's `boundedFetch` (manual redirects re-validated
// against the policy object built here, the header timeout, the body cap enforced while reading). A host
// or test that injects its own `fetch` gets the SAME URL rules and caps, and EVERY redirect refused
// (`redirect: "error"`) -- `boundedFetch` cannot run over a foreign network function, and a policy that
// followed hops on one it cannot see would be a policy in name only.
import { boundedFetch, classifyAddress, DEFAULT_MAX_REDIRECTS, ProviderBodyLimitError, ProviderRequestError, type EndpointPolicy } from "@yanlinglabs/winter-provider-runtime";
import { isIP } from "node:net";
import { McpOAuthError } from "./errors.ts";

/** The MCP client package's `FetchLike`: what `auth()`, `refreshAuthorization()` and friends call. */
export type McpAuthFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

export const MCP_AUTH_FETCH_TIMEOUT_MS = 30_000;
/** Metadata documents, a registration answer and a token answer are all small; 1 MiB is generous. */
export const MCP_AUTH_FETCH_MAX_BODY_BYTES = 1024 * 1024;

export interface McpAuthFetchOptions {
  /** The network. Absent: provider-runtime's `boundedFetch`. See this file's header for what changes when it is injected. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBodyBytes?: number;
  /** Whether a literal loopback address may be reached at all: true only when the MCP server itself is loopback. Default false. */
  allowLoopback?: boolean;
}

export type McpAuthUrlVerdict = { ok: true; origin: string; loopback: boolean } | { ok: false; reason: string };

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * The URL rules (1, 2 and 5 of the header), for ONE absolute URL. Exported because the sign-in applies
 * the same rules to URLs it never fetches: the authorize URL a browser opens, and the MCP server URL
 * itself.
 */
export function evaluateMcpAuthUrl(raw: string | URL, opts: { allowLoopback?: boolean } = {}): McpAuthUrlVerdict {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    return { ok: false, reason: "an auth URL is not a parseable absolute URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: `${url.protocol} is not an auth URL scheme (https only)` };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: `the auth URL for ${url.origin} carries userinfo` };
  const host = stripBrackets(url.hostname);
  const family = isIP(host);
  const cls = family !== 0 ? classifyAddress(host, family) : host.toLowerCase() === "localhost" ? "loopback" : undefined;
  if (cls !== undefined && cls !== "loopback" && cls !== "public") {
    return { ok: false, reason: `${url.origin} is a literal ${cls} address, which an auth request never reaches` };
  }
  const loopback = cls === "loopback";
  if (loopback && opts.allowLoopback !== true) return { ok: false, reason: `${url.origin} is a loopback address, which an auth request reaches only for an MCP server that is itself on loopback` };
  if (url.protocol === "http:" && !loopback) return { ok: false, reason: `${url.origin} uses plain http; auth requests are https-only except to a literal loopback address` };
  return { ok: true, origin: url.origin, loopback };
}

/** True when the MCP server URL is itself a literal loopback address -- the one case its auth URLs may be too. */
export function isLoopbackMcpServer(serverUrl: string): boolean {
  const verdict = evaluateMcpAuthUrl(serverUrl, { allowLoopback: true });
  return verdict.ok && verdict.loopback;
}

function refusal(reason: string): McpOAuthError {
  return new McpOAuthError("policy_refused", `auth request refused: ${reason}`);
}

/** The policy object `boundedFetch` enforces for one request: its own origin, and nothing else. */
function sameOriginOnlyPolicy(origin: string, loopback: boolean, allowLoopback: boolean): EndpointPolicy {
  return {
    origin,
    local: loopback,
    // Never "generated": nothing an MCP auth request reaches is a reviewed catalog endpoint, so no
    // privileged header could ever be attached through this policy.
    generated: false,
    evaluateRedirect(target: string) {
      const verdict = evaluateMcpAuthUrl(target, { allowLoopback });
      if (!verdict.ok) return { ok: false, reason: verdict.reason };
      if (verdict.origin !== origin) return { ok: false, reason: `a redirect from ${origin} to ${verdict.origin} (auth requests never follow a cross-origin redirect)` };
      return { ok: true, origin: verdict.origin, sameOrigin: true };
    },
  };
}

function headersOf(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers ?? {});
}

/** Caps an injected network's answer the way `boundedFetch` caps its own. */
function capResponse(response: Response, maxBodyBytes: number): Response {
  if (response.body === null) return response;
  const reader = response.body.getReader();
  let seen = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      seen += value.byteLength;
      if (seen > maxBodyBytes) {
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
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Builds THE auth fetch. Every `mcp-auth` door builds one per operation from its own `fetch?` option. */
export function createMcpAuthFetch(opts: McpAuthFetchOptions = {}): McpAuthFetch {
  const timeoutMs = opts.timeoutMs ?? MCP_AUTH_FETCH_TIMEOUT_MS;
  const maxBodyBytes = opts.maxBodyBytes ?? MCP_AUTH_FETCH_MAX_BODY_BYTES;
  const allowLoopback = opts.allowLoopback === true;
  return async (input, init) => {
    const target = String(input);
    const verdict = evaluateMcpAuthUrl(target, { allowLoopback });
    if (!verdict.ok) throw refusal(verdict.reason);
    // `redirect`/`signal` are the two `RequestInit` keys `boundedFetch` owns itself; the caller's signal
    // is combined with the WHOLE-EXCHANGE deadline below. The deadline's timer is left armed after the
    // headers arrive, on purpose: it is what bounds the body read (it aborts a stream that has not
    // finished by then, and does nothing to one that has). `unref`, so it never keeps a process alive.
    const { redirect: _redirect, signal, ...rest } = init ?? {};
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    timer.unref?.();
    const combined = signal !== undefined && signal !== null ? AbortSignal.any([deadline.signal, signal]) : deadline.signal;
    if (opts.fetch !== undefined) {
      try {
        const response = await opts.fetch(target, { ...rest, headers: headersOf(init), redirect: "error", signal: combined });
        return capResponse(response, maxBodyBytes);
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof McpOAuthError) throw err;
        // A refused redirect and a dead connection both surface from `fetch` as a TypeError, so an
        // injected network cannot tell them apart; `network` (retryable) is the honest code for both.
        throw new McpOAuthError("network", `the auth request to ${verdict.origin} failed (${err instanceof Error ? err.name : "error"}); redirects are refused on an injected network`);
      }
    }
    try {
      return await boundedFetch(target, {
        ...rest,
        headers: headersOf(init),
        timeoutMs,
        maxBodyBytes,
        maxRedirects: DEFAULT_MAX_REDIRECTS,
        policy: sameOriginOnlyPolicy(verdict.origin, verdict.loopback, allowLoopback),
        signal: combined,
      });
    } catch (err) {
      clearTimeout(timer);
      // `boundedFetch`'s policy refusals (`capability`) and transport failures (`network`/`timeout`/
      // `aborted`) are typed `ProviderRequestError`s whose messages name origins and reasons only;
      // re-typed here so every auth door reports one class, keeping "refused" apart from "retry later".
      if (err instanceof ProviderRequestError && err.code === "capability") throw refusal(err.message);
      throw new McpOAuthError("network", `the auth request to ${verdict.origin} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
