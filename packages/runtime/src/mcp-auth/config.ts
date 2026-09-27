// WS-25 (MCP OAuth) §2: the ONE validator for a server config's `oauth` block -- the runtime's
// `validateServerConfig` calls it, and a host that accepts the block at its own door (Winter's daemon:
// settings, `mcp.add`, a project's own MCP list) can import it from `/mcp-auth` rather than
// re-deriving the rules.
//
// STRICT, because the block names where a SECRET lives: an unknown key is refused rather than ignored (a
// typo like `clientSecretRefs` must not silently leave a confidential client unauthenticated), and a
// secret VALUE is refused by name -- a server config is written to settings files, echoed by `mcp.get`,
// and handed to hooks, none of which may ever carry one.
import { evaluateMcpAuthUrl, isLoopbackMcpServer } from "./fetch-policy.ts";

const OAUTH_KEYS: ReadonlySet<string> = new Set(["clientId", "clientSecretRef", "callbackPort", "authServerMetadataUrl", "scopes"]);
const SECRET_REF_KEYS: ReadonlySet<string> = new Set(["kind"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `undefined` when `oauth` is a valid `McpOAuthConfig`; otherwise why not (prose naming the field, never quoting a secret). */
/**
 * `serverUrl` is the server config's own `url`: an `authServerMetadataUrl` may name a loopback address
 * only when the server itself is on loopback (fix round 1 M4). Absent, loopback is refused.
 */
export function validateMcpOAuthConfig(oauth: unknown, serverUrl?: string): string | undefined {
  if (!isPlainObject(oauth)) return "MCP server config 'oauth' must be an object";
  for (const key of Object.keys(oauth)) {
    if (key === "clientSecret") return "MCP server config 'oauth.clientSecret' is refused: a client secret never lives in a config -- store it in the Keychain (the host's sign-in door) and mark it with 'oauth.clientSecretRef': { kind: \"keychain\" }";
    if (!OAUTH_KEYS.has(key)) return `MCP server config 'oauth' has an unknown key ${JSON.stringify(key)} (expected clientId, clientSecretRef, callbackPort, authServerMetadataUrl, scopes)`;
  }
  const { clientId, clientSecretRef, callbackPort, authServerMetadataUrl, scopes } = oauth;
  if (clientId !== undefined && (typeof clientId !== "string" || clientId.trim() === "")) return "MCP server config 'oauth.clientId' must be a non-empty string";
  if (clientSecretRef !== undefined) {
    if (clientId === undefined) return "MCP server config 'oauth.clientSecretRef' needs 'oauth.clientId': a secret belongs to a pre-registered client";
    if (!isPlainObject(clientSecretRef)) return "MCP server config 'oauth.clientSecretRef' must be { kind: \"keychain\" }";
    // A MARKER, never a locator: the account is derived from the server URL (`mcpOAuthClientSecretAccount`).
    // A config that names an account or a service could point the sign-in at ANY Keychain item -- a
    // provider API key -- and send it to an authorization server the config also chose.
    for (const key of Object.keys(clientSecretRef)) {
      if (!SECRET_REF_KEYS.has(key)) return `MCP server config 'oauth.clientSecretRef' has the key ${JSON.stringify(key)}, which is refused: it is { kind: "keychain" } only -- the secret's Keychain account is derived from the server URL, never named by a config`;
    }
    if (clientSecretRef.kind !== "keychain") return "MCP server config 'oauth.clientSecretRef.kind' must be \"keychain\"";
  }
  if (callbackPort !== undefined && (typeof callbackPort !== "number" || !Number.isInteger(callbackPort) || callbackPort < 1 || callbackPort > 65535)) {
    return "MCP server config 'oauth.callbackPort' must be an integer port (1-65535)";
  }
  if (authServerMetadataUrl !== undefined) {
    if (typeof authServerMetadataUrl !== "string") return "MCP server config 'oauth.authServerMetadataUrl' must be a URL string";
    const verdict = evaluateMcpAuthUrl(authServerMetadataUrl, { allowLoopback: serverUrl !== undefined && isLoopbackMcpServer(serverUrl) });
    if (!verdict.ok) return `MCP server config 'oauth.authServerMetadataUrl' is refused: ${verdict.reason}`;
  }
  if (scopes !== undefined && (!Array.isArray(scopes) || scopes.some((s) => typeof s !== "string" || s === "" || /\s/.test(s)))) {
    return "MCP server config 'oauth.scopes' must be an array of scope tokens (non-empty, no whitespace)";
  }
  return undefined;
}
