// WS-25 (MCP OAuth): re-finding a signed-in server's authorization server -- for a refresh and a
// revocation, which run long after the sign-in's own discovery and must reach the SAME authorization
// server the tokens came from.
//
// The client record says where discovery found it (`authorizationServerUrl`, `resourceMetadataUrl`), so
// nothing here probes the MCP server itself. Every request rides the caller's policy fetch.
import { buildDiscoveryUrls, checkResourceAllowed, discoverAuthorizationServerMetadata, discoverOAuthProtectedResourceMetadata, resourceUrlFromServerUrl, type AuthorizationServerMetadata } from "@modelcontextprotocol/client";
import { McpOAuthError } from "./errors.ts";
import type { McpAuthFetch } from "./fetch-policy.ts";

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
  if (metadata !== undefined && metadata.issuer !== expectedIssuer && `${metadata.issuer}/` !== expectedIssuer && metadata.issuer !== `${expectedIssuer}/`) {
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
