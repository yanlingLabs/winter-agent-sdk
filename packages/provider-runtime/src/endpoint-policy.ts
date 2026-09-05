// Endpoint policy — R6-11 and WS-13 §13's security floor for provider endpoints.
//
// FROZEN as of P6 T2's merge (R6-12).
//
// Two endpoint populations with DIFFERENT policies, which is the whole point of `opts.generated`:
//
//   GENERATED — a descriptor's `defaultEndpoints` entry. Immutable and reviewed at catalog-build
//     time (the catalog validator already rejects userinfo, query strings and non-http(s) schemes on
//     one). Its plain-`http` loopback form is legitimate: the twelve local providers are all
//     `http://127.0.0.1:<port>` by construction.
//   USER — a `ConnectionProfile.baseUrl`. Untrusted input. https is required unless the host
//     explicitly declares the connection `local` AND the address literally classifies as
//     loopback/RFC-1918/link-local/unique-local.
//
// SYNCHRONOUS BY CONTRACT, and that is a security property rather than a convenience: this function
// performs NO DNS resolution, so it never has a resolved address to be lied to about. A DNS name is
// therefore never "local" — `local: true` only ever relaxes the rule for a literal address the
// shared classifier itself just judged. (P3's ruling P3-I documents the matching trap on the other
// side: resolving once and connecting again re-resolves independently, which a TTL-0 rebinding
// resolver turns into a validated-then-different address. Refusing to resolve at all is the version
// of that defence a synchronous policy can actually keep.)

import { isIP } from "node:net";
import { classifyAddress, isLocalAddressClass, type AddressClass } from "./address-classifier.ts";

export type EndpointEvaluation = { ok: true; origin: string; local: boolean } | { ok: false; reason: string };

export interface EndpointEvaluationOptions {
  /** True for a descriptor's own immutable endpoint; false for a user-supplied `baseUrl`. */
  generated: boolean;
  /** The host's explicit declaration that this endpoint is a local installation. Only meaningful for a LITERAL local address. */
  local?: boolean;
}

/**
 * Headers that carry (or can carry) a credential and must never survive an origin change, and must
 * never be attached to a user endpoint that inherited them from a generated one.
 *
 * Lowercase; `Headers` matching is case-insensitive but a raw record's is not, so callers compare
 * against these exact strings.
 */
export const CREDENTIAL_HEADER_NAMES: readonly string[] = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "cookie2",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "x-amz-security-token",
  "x-amz-date",
  "x-amz-content-sha256",
  "openai-organization",
  "openai-project",
  "x-goog-user-project",
];

/** Returns a COPY with every credential-bearing header removed. Never mutates its argument — a caller that reuses the original for a same-origin hop must still have it intact. */
export function stripCredentialHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  for (const name of CREDENTIAL_HEADER_NAMES) out.delete(name);
  return out;
}

/** `URL.hostname` keeps the brackets on an IPv6 literal (verified in P3's own monitor work); both `isIP` and the classifier need them gone. */
function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Classifies a URL's host WITHOUT resolving anything.
 *
 * Three outcomes: a literal address gets its real class; `localhost` (and its `.localhost` subdomain
 * form) is loopback by RFC 6761, which is the one name whose meaning is reserved rather than
 * resolved; every other name is `undefined` — unknown, and therefore never local.
 */
function classifyHost(hostname: string): AddressClass | undefined {
  const bare = stripBrackets(hostname);
  const family = isIP(bare);
  if (family !== 0) return classifyAddress(bare, family);
  const lower = bare.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return "loopback";
  return undefined;
}

/**
 * The checks that apply to ANY url — a stored base URL, a live request URL, or a redirect target:
 * scheme, userinfo, address class, and the local/plain-http rules.
 *
 * Split out from `evaluateEndpoint` because the query/fragment refusal must NOT apply to a live
 * request URL. That refusal is about what may be STORED in a connection profile; a real request
 * legitimately carries query parameters, and two of the cohort's providers cannot be called without
 * them — Gemini's `?alt=sse` selects streaming, Azure OpenAI's `?api-version=…` is mandatory on
 * every call. Applying the stored-endpoint rule to request URLs made both providers fail on their
 * first request, with the fake receiving nothing at all (review finding C1).
 */
function evaluateUrlShape(rawUrl: string, opts: EndpointEvaluationOptions): EndpointEvaluation {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `endpoint "${rawUrl}" is not a parseable absolute URL` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: `endpoint "${rawUrl}" has an unsupported scheme "${url.protocol}" — only http and https are endpoints` };
  }
  if (url.username.length > 0 || url.password.length > 0) {
    // The value is deliberately NOT echoed back: it is a credential, and a refusal message is one of
    // the most reliably-logged strings in any system.
    return { ok: false, reason: `endpoint "${url.origin}${url.pathname}" carries userinfo — a credential must never ride a URL` };
  }

  const cls = classifyHost(url.hostname);

  // Classes nothing rescues. `invalid`/`unspecified`/`multicast`/`cgnat` are never a legitimate
  // provider endpoint, and letting `local: true` cover them would turn one honest declaration
  // ("my Ollama is on loopback") into blanket permission for a whole address space.
  if (cls === "invalid" || cls === "unspecified" || cls === "multicast" || cls === "cgnat") {
    return { ok: false, reason: `endpoint "${url.origin}" resolves to a ${cls} address, which is never a provider endpoint` };
  }

  const literalLocal = cls !== undefined && isLocalAddressClass(cls);
  // A generated endpoint is reviewed, so its own loopback form counts as declared. A user endpoint
  // needs the host to say so.
  const treatAsLocal = literalLocal && (opts.local === true || opts.generated);

  if (literalLocal && !treatAsLocal) {
    return {
      ok: false,
      reason: `endpoint "${url.origin}" points at a ${cls} address but the connection is not declared local — set \`connection.local: true\` to reach a local installation deliberately`,
    };
  }

  if (url.protocol === "http:" && !treatAsLocal) {
    return {
      ok: false,
      reason: `endpoint "${url.origin}" uses plain http, which is permitted only for a literal loopback/private/link-local address on a connection declared local`,
    };
  }

  return { ok: true, origin: url.origin, local: treatAsLocal };
}

/**
 * Evaluates a STORED endpoint — a descriptor's `defaultEndpoints` entry or a
 * `ConnectionProfile.baseUrl`.
 *
 * Everything `evaluateUrlShape` checks, PLUS a refusal of any query string or fragment. That extra
 * pair is specific to stored endpoints: a persisted `?key=…` reaches every log line, error message
 * and telemetry record verbatim, and a fragment is meaningless to a request. Live request URLs and
 * redirect targets go through `EndpointPolicy.evaluateRedirect` instead, which deliberately does
 * NOT apply it — see `evaluateUrlShape`'s own header.
 */
export function evaluateEndpoint(baseUrl: string, opts: EndpointEvaluationOptions): EndpointEvaluation {
  const shape = evaluateUrlShape(baseUrl, opts);
  if (!shape.ok) return shape;
  // Re-parsed rather than threaded out of the helper: this keeps `evaluateUrlShape`'s return type
  // the plain public `EndpointEvaluation` (one shape, no internal variant), and the URL has already
  // been proven parseable above.
  const url = new URL(baseUrl);
  if (url.search.length > 0) {
    return { ok: false, reason: `endpoint "${url.origin}${url.pathname}" carries a query string — request parameters belong in the adapter's own request, never in a stored endpoint` };
  }
  if (url.hash.length > 0) {
    return { ok: false, reason: `endpoint "${url.origin}${url.pathname}" carries a fragment, which is meaningless to a request` };
  }
  return shape;
}

/**
 * The policy object `boundedFetch` carries: the accepted origin plus the rule a redirect target must
 * pass before the request follows it.
 *
 * PRIVILEGED HEADERS (R6-11, ruling R6-L). `generated` is not decoration — it is the input to
 * `applyPrivilegedHeaders` below, which is how "privileged headers only for generated endpoints"
 * stops being prose. The split, stated once so adapters classify consistently:
 *
 *   PRIVILEGED — headers a GENERATED descriptor implies and a user endpoint must never inherit:
 *     organisation / project / account identifiers (`OpenAI-Organization`, `OpenAI-Project`,
 *     `x-goog-user-project`, an AWS account or role identifier), the codex adapter's `originator`,
 *     and any header whose value only means something at the reviewed endpoint it was minted for.
 *     Sending these to a user-supplied base URL discloses the operator's account topology to a host
 *     the reviewed catalog never named.
 *
 *   PROTOCOL — headers EVERY endpoint needs to be spoken to at all, and which carry no
 *     cross-endpoint meaning: `content-type`, `accept`, `anthropic-version`, `anthropic-beta`,
 *     `x-goog-api-key`, `authorization` / `x-api-key` / `api-key`. These are NOT routed through
 *     `applyPrivilegedHeaders`; auth in particular is governed by the separate and stricter
 *     origin-change rule (`stripCredentialHeaders`), not by this one.
 */
export interface EndpointPolicy {
  readonly origin: string;
  readonly local: boolean;
  readonly generated: boolean;
  /**
   * Revalidates a redirect target against this policy.
   *
   * `sameOrigin: false` is an INSTRUCTION, not a note: the caller MUST strip credential headers
   * before following it (R6-11 — "no credential forwarding across an origin change"). A redirect
   * chain is the standard way a compliant client is talked into replaying its bearer token to a
   * host the user never named.
   */
  evaluateRedirect(target: string): { ok: true; origin: string; sameOrigin: boolean } | { ok: false; reason: string };
}

/** True when two origins name the same host, whatever their ports. Used only for the local-installation relaxation below. */
function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

export function createEndpointPolicy(
  baseUrl: string,
  opts: EndpointEvaluationOptions,
): { ok: true; policy: EndpointPolicy } | { ok: false; reason: string } {
  const evaluated = evaluateEndpoint(baseUrl, opts);
  if (!evaluated.ok) return evaluated;
  const { origin, local } = evaluated;
  const generated = opts.generated;
  return {
    ok: true,
    policy: {
      origin,
      local,
      generated,
      evaluateRedirect(target: string) {
        // A redirect target is re-evaluated as a USER endpoint — never as `generated`, whatever the
        // original was. A reviewed descriptor endpoint vouches for itself, not for wherever it
        // points next.
        //
        // The STRICT rule is applied first, with no local relaxation at all. The host's
        // `local: true` declaration described ONE endpoint, and carrying it across a cross-origin
        // hop would let a local server redirect the client into the rest of the private address
        // space — a `http://127.0.0.1:11434` connection pivoting to `http://169.254.169.254`,
        // credentials aside, is still a request the host never authorised. So the declaration is
        // re-applied ONLY when the target is the very origin it was made about, which is what keeps
        // an ordinary same-origin `/v1` -> `/v1/` hop on a local server working.
        // `evaluateUrlShape`, NOT `evaluateEndpoint`: a live request URL or a redirect target may
        // legitimately carry a query string (Gemini's `?alt=sse`, Azure's `?api-version=…`), and the
        // query/fragment refusal is a rule about what may be STORED (review finding C1).
        const strict = evaluateUrlShape(target, { generated: false });
        if (strict.ok) return { ok: true, origin: strict.origin, sameOrigin: strict.origin === origin };
        if (local) {
          const lenient = evaluateUrlShape(target, { generated: false, local: true });
          // SAME HOST, any port. A local reverse proxy handing off between ports on the same machine
          // is an ordinary local-installation shape, and the host already declared it trusts a local
          // installation HERE. What the host did not declare is trust in any OTHER machine, so a hop
          // to link-local metadata or to a LAN neighbour still falls through to the refusal below.
          // The hop is still cross-origin, so credentials are still dropped.
          if (lenient.ok && sameHost(lenient.origin, origin)) {
            return { ok: true, origin: lenient.origin, sameOrigin: lenient.origin === origin };
          }
        }
        return { ok: false, reason: `redirect refused: ${strict.reason}` };
      },
    },
  };
}
