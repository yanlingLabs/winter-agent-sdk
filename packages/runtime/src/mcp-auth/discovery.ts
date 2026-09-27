// WS-25 (MCP OAuth): re-finding a signed-in server's authorization server -- for a refresh and a
// revocation, which run long after the sign-in's own discovery and must reach the SAME authorization
// server the tokens came from -- PLUS (additive) a side-effect-free discovery for a caller that has no
// sign-in yet: the daemon's own authorization-server bookkeeping, which must tell two tenants behind one
// reverse-proxy origin apart (`https://host/tenant/a` vs `https://host/tenant/b`) BEFORE it ever signs in.
//
// The refresh/revoke functions read where a PAST discovery landed from the client record
// (`authorizationServerUrl`, `resourceMetadataUrl`), so nothing there probes the MCP server itself.
// `discoverMcpOAuthIssuer` is the one exception: it IS a fresh discovery (no record to read yet), run
// read-only -- every request rides the caller's policy fetch, and nothing here registers a client, writes
// a store or opens a listener.
import { buildDiscoveryUrls, checkResourceAllowed, discoverAuthorizationServerMetadata, discoverOAuthProtectedResourceMetadata, discoverOAuthServerInfo, resourceUrlFromServerUrl, type AuthorizationServerMetadata } from "@modelcontextprotocol/client";
import type { McpOAuthConfig } from "@yanlinglabs/winter-agent-sdk";
import { boundedReason, McpOAuthError } from "./errors.ts";
import { createMcpAuthFetch, evaluateMcpAuthUrl, isLoopbackMcpServer, type McpAuthFetch } from "./fetch-policy.ts";
import { sameIssuer } from "./records.ts";

/** True when `url` names a metadata DOCUMENT (the config's `oauth.authServerMetadataUrl`) rather than an issuer. */
export function isMetadataDocumentUrl(url: string): boolean {
  try {
    return new URL(url).pathname.includes("/.well-known/");
  } catch {
    return false;
  }
}

/**
 * Fetches an RFC 8414 document from an explicit URL (`oauth.authServerMetadataUrl`) -- the out-of-band
 * seed the MCP client's own `discoveryState` exists for. Validated for the fields a sign-in uses, and for
 * its ISSUER: the URL must be one of that issuer's own well-known locations (`fetchedFromIssuersOwnLocation`).
 */
/**
 * FIX ROUND 3 (the document may not name just ANY issuer): a metadata document fetched from a URL the
 * CONFIG named is trusted for an issuer only when it was fetched from one of THAT issuer's own well-known
 * locations -- RFC 8414 §3/§3.3 (`/.well-known/oauth-authorization-server` inserted before the issuer's
 * path) or OIDC Discovery (`/.well-known/openid-configuration`, both placements), exactly the candidates
 * the MCP client's own `buildDiscoveryUrls(issuer)` probes. Without it a document served from an
 * attacker's host could claim a legitimate issuer (defeating a secret's issuer binding and showing the
 * user the legitimate origin) while naming the attacker's token endpoint.
 */
function fetchedFromIssuersOwnLocation(fetchUrl: string, issuer: string): boolean {
  let fetched: URL;
  try {
    fetched = new URL(fetchUrl);
    new URL(issuer);
  } catch {
    return false;
  }
  if (fetched.search !== "" || fetched.hash !== "") return false;
  return buildDiscoveryUrls(issuer).some((candidate) => candidate.url.href === fetched.href);
}

export async function fetchAuthorizationServerMetadataDocument(url: string, fetchFn: McpAuthFetch): Promise<AuthorizationServerMetadata> {
  const response = await fetchFn(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    await response.text().catch(() => {});
    throw new Error(`the authorization server metadata document answered HTTP ${response.status}`);
  }
  const doc = (await response.json()) as Record<string, unknown>;
  for (const key of ["issuer", "authorization_endpoint", "token_endpoint"] as const) {
    if (typeof doc[key] !== "string") throw new Error(`the authorization server metadata document has no "${key}"`);
  }
  if (!Array.isArray(doc.response_types_supported)) throw new Error('the authorization server metadata document has no "response_types_supported"');
  if (!fetchedFromIssuersOwnLocation(url, doc.issuer as string)) {
    throw new McpOAuthError("metadata_issuer_mismatch", `the authorization server metadata document at ${new URL(url).origin} names an issuer it was not published under (RFC 8414 §3.3); it is refused`);
  }
  return doc as unknown as AuthorizationServerMetadata;
}

export interface LoadedAuthorizationServer {
  /** What the token-endpoint helpers take as `authorizationServerUrl` (the legacy `/token` fallback's base). */
  authorizationServerUrl: string;
  /** Absent for the legacy variant (no RFC 8414 document anywhere): the helpers then use `/token` on the base. */
  metadata?: AuthorizationServerMetadata;
}

/**
 * The authorization server a stored sign-in belongs to. `expectedIssuer` is the token record's: a
 * document that now names another issuer is refused (tokens are bound to the issuer that minted them,
 * SEP-2352) rather than sent a refresh token it never issued.
 */
export async function loadAuthorizationServer(opts: { authorizationServerUrl: string; expectedIssuer: string; fetchFn: McpAuthFetch }): Promise<LoadedAuthorizationServer> {
  const { authorizationServerUrl, expectedIssuer, fetchFn } = opts;
  const metadata = isMetadataDocumentUrl(authorizationServerUrl)
    ? await fetchAuthorizationServerMetadataDocument(authorizationServerUrl, fetchFn)
    : await discoverAuthorizationServerMetadata(authorizationServerUrl, { fetchFn });
  // THE canonical issuer comparison (`records.ts`'s `sameIssuer`): exact, or differing only by one
  // trailing slash. Every caller that must decide "is this the same authorization server" uses this one
  // function, never origin equality (an origin can host many issuers behind tenant paths) and never a
  // second hand-rolled trailing-slash check.
  if (metadata !== undefined && !sameIssuer(metadata.issuer, expectedIssuer)) {
    throw new Error("the authorization server now names a different issuer than the one this sign-in came from");
  }
  const base = isMetadataDocumentUrl(authorizationServerUrl) && metadata !== undefined ? metadata.issuer : authorizationServerUrl;
  return { authorizationServerUrl: base, ...(metadata !== undefined ? { metadata } : {}) };
}

/**
 * The RFC 8707 `resource` a token request names: the protected-resource metadata's own `resource`
 * string, VERBATIM (the MCP client's `auth()` sends it that way, #1968), when the document exists and
 * matches the server; absent for a server that publishes none (the legacy variant).
 */
export async function resolveResourceIndicator(opts: { serverUrl: string; resourceMetadataUrl?: string; fetchFn: McpAuthFetch }): Promise<string | undefined> {
  let resource: string | undefined;
  try {
    const prm = await discoverOAuthProtectedResourceMetadata(opts.serverUrl, opts.resourceMetadataUrl !== undefined ? { resourceMetadataUrl: new URL(opts.resourceMetadataUrl) } : undefined, opts.fetchFn);
    resource = prm.resource;
  } catch {
    return undefined;
  }
  if (!checkResourceAllowed({ requestedResource: resourceUrlFromServerUrl(opts.serverUrl), configuredResource: resource })) {
    throw new Error("the protected-resource metadata names a resource that is not this MCP server");
  }
  return resource;
}

export interface DiscoverMcpOAuthIssuerOptions {
  /** The MCP server's URL (the protected resource) -- the same value `startMcpOAuthLogin` takes. */
  serverUrl: string;
  /** The server config's `oauth` block, when it has one (only `authServerMetadataUrl` matters here). */
  oauth?: McpOAuthConfig;
  /** The network under the auth-HTTP policy (tests; a host that must go through its own dispatcher). */
  fetch?: typeof fetch;
}

export interface McpOAuthIssuerInfo {
  /** The full verified issuer string -- identical to what a sign-in on this config would store/return. */
  issuer: string;
  /** `issuer`'s origin, for display only (compare tenants by `issuer`/`sameIssuer`, never this). */
  issuerOrigin: string;
  /** The origin the authorize request would load in a browser -- usually the issuer's. */
  authorizeOrigin: string;
}

/**
 * WS-25, additive: finds a server's authorization server WITHOUT signing in -- no registration, no code
 * exchange, no loopback listener, no store read or write, no client secret ever touched. For a caller that
 * must know a server's issuer before (or without) starting an interactive sign-in: the daemon's own
 * authorization-server bookkeeping, which compares SERVERS, not origins (an origin can host many issuers
 * behind tenant paths -- `https://host/tenant/a` and `https://host/tenant/b` are two authorization servers
 * on the same origin, and a comparison that stopped at `issuerOrigin` would treat them as one).
 *
 * MIRRORS `startMcpOAuthLogin`'s own discovery leg exactly, so this door's `issuer` is PROVABLY the same
 * string a sign-in on the same config would store (`flow.test.ts` pins the equality against the fixture):
 *   - `oauth.authServerMetadataUrl` set: `fetchAuthorizationServerMetadataDocument` (login.ts's seeded
 *     path, `startMcpOAuthLogin` line ~252-261) -- the SAME RFC 8414 issuer-location check
 *     (`fetchedFromIssuersOwnLocation`, above), refusing `metadata_issuer_mismatch` on a document a
 *     config's `authServerMetadataUrl` did not actually come from.
 *   - absent: `discoverOAuthServerInfo` (RFC 9728 PRM -> RFC 8414 / OIDC discovery) -- the exact function
 *     the MCP client package's own `auth()` calls for a fresh (uncached) flow, so an unseeded sign-in's
 *     issuer is this door's issuer too, not a second implementation of the same two steps.
 *
 * `authorizeOrigin` is derived without ever building a real authorize URL (that needs a registered
 * client, which this door never creates): a metadata document's own `authorization_endpoint`, or --
 * the legacy variant, no document anywhere -- `startAuthorization`'s own fallback, `/authorize` on the
 * authorization server's base URL (same origin either way).
 */
export async function discoverMcpOAuthIssuer(opts: DiscoverMcpOAuthIssuerOptions): Promise<McpOAuthIssuerInfo> {
  const serverVerdict = evaluateMcpAuthUrl(opts.serverUrl, { allowLoopback: true });
  if (!serverVerdict.ok) throw new McpOAuthError("policy_refused", `the MCP server URL is refused: ${serverVerdict.reason}`);
  const oauth = opts.oauth ?? {};
  const allowLoopback = isLoopbackMcpServer(opts.serverUrl);
  const fetchFn = createMcpAuthFetch({ ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}), allowLoopback });

  let issuer: string;
  let authorizeEndpoint: string;
  try {
    if (oauth.authServerMetadataUrl !== undefined) {
      const metadata = await fetchAuthorizationServerMetadataDocument(oauth.authServerMetadataUrl, fetchFn);
      issuer = metadata.issuer;
      authorizeEndpoint = metadata.authorization_endpoint;
    } else {
      const info = await discoverOAuthServerInfo(opts.serverUrl, { fetchFn });
      issuer = info.authorizationServerMetadata?.issuer ?? info.authorizationServerUrl;
      authorizeEndpoint = info.authorizationServerMetadata?.authorization_endpoint ?? new URL("/authorize", info.authorizationServerUrl).toString();
    }
  } catch (err) {
    if (err instanceof McpOAuthError) throw err;
    // Discovery/registration errors may quote a server's unbounded text (no token exists yet on this leg);
    // bounded and coded like `startMcpOAuthLogin`'s own catch for the identical failure (login.ts ~385-390).
    throw new McpOAuthError("login_failed", `mcp-auth issuer discovery failed: ${boundedReason(err)}`);
  }
  const authorizeVerdict = evaluateMcpAuthUrl(authorizeEndpoint, { allowLoopback });
  if (!authorizeVerdict.ok) throw new McpOAuthError("policy_refused", `the authorization endpoint is refused: ${authorizeVerdict.reason}`);
  return { issuer, issuerOrigin: new URL(issuer).origin, authorizeOrigin: authorizeVerdict.origin };
}
