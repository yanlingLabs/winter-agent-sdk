// WS-25 (MCP OAuth) §2: which Keychain items hold ONE MCP server's sign-in.
//
// KEYED BY THE SERVER'S CANONICAL URL, never by its config name, scope or project (spec §1.6's default):
//   - one sign-in then serves every scope and every project that names the same server -- the user signs
//     in to Linear once, not once per repository;
//   - the key is derivable from the config ALONE, by the daemon (which writes it) and by a session (which
//     reads it) -- a run-home build hands the child no `Options.mcpServers` to carry anything else;
//   - renaming a server in a config orphans nothing (Claude Code keys by name+config hash, which is how
//     it strands items).
//
// The id is `sha256(canonical)` truncated to 16 hex characters (64 bits): an account NAME, not a secret
// and not a security boundary -- a collision would need two server URLs one user configures, and 2^32
// such URLs before a birthday collision is even likely.
import { createHash } from "node:crypto";
import { McpOAuthError } from "./errors.ts";

/** The token item's account prefix: `mcp-oauth:<id>`. Sessions read it; the host writes it. */
export const MCP_OAUTH_TOKEN_ACCOUNT_PREFIX = "mcp-oauth:";
/** The client-registration item's account prefix: `mcp-oauth-client:<id>`. Only the host reads it. */
export const MCP_OAUTH_CLIENT_ACCOUNT_PREFIX = "mcp-oauth-client:";

/**
 * The canonical form of an MCP server URL: lower-cased scheme and host (the URL parser does both), the
 * scheme's default port dropped (likewise), the path KEPT (two servers under one origin are two servers),
 * no query, no fragment, and trailing slashes removed (`https://x/mcp/` and `https://x/mcp` are the same
 * server; `https://x/` and `https://x` both become `https://x`).
 *
 * Refused, typed (`invalid_server_url`): an unparseable URL, a non-http(s) scheme, and userinfo -- a
 * credential in a URL is never a key, and never silently dropped into one either.
 */
export function canonicalMcpServerUrl(serverUrl: string): string {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new McpOAuthError("invalid_server_url", "an MCP server URL must be an absolute http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new McpOAuthError("invalid_server_url", `an MCP server URL must be http(s), not "${url.protocol}"`);
  }
  if (url.username !== "" || url.password !== "") {
    // The value is not echoed: it is a credential.
    throw new McpOAuthError("invalid_server_url", `the MCP server URL for ${url.origin} carries userinfo -- a credential never rides a server URL`);
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** `sha256(canonicalMcpServerUrl(serverUrl))`, first 16 hex characters. The ONE key derivation. */
export function mcpOAuthAccountId(serverUrl: string): string {
  return createHash("sha256").update(canonicalMcpServerUrl(serverUrl)).digest("hex").slice(0, 16);
}

/** The token item's full account name for a server URL: `mcp-oauth:<id>`. This is the `account` every door takes. */
export function mcpOAuthTokenAccount(serverUrl: string): string {
  return `${MCP_OAUTH_TOKEN_ACCOUNT_PREFIX}${mcpOAuthAccountId(serverUrl)}`;
}

/** The client-registration item's full account name for a server URL: `mcp-oauth-client:<id>`. */
export function mcpOAuthClientAccount(serverUrl: string): string {
  return `${MCP_OAUTH_CLIENT_ACCOUNT_PREFIX}${mcpOAuthAccountId(serverUrl)}`;
}

const ACCOUNT_SHAPE = /^mcp-oauth:[0-9a-f]{16}$/;

/** True for a well-formed token account name (`mcp-oauth:` + 16 lower-case hex). */
export function isMcpOAuthTokenAccount(account: string): boolean {
  return ACCOUNT_SHAPE.test(account);
}

/** The client item's account for a TOKEN account -- the prefix swap. Refuses anything that is not a token account. */
export function clientAccountForTokenAccount(account: string): string {
  if (!isMcpOAuthTokenAccount(account)) {
    throw new McpOAuthError("invalid_account", `"${account}" is not an MCP sign-in account (expected mcp-oauth:<16 hex>)`);
  }
  return `${MCP_OAUTH_CLIENT_ACCOUNT_PREFIX}${account.slice(MCP_OAUTH_TOKEN_ACCOUNT_PREFIX.length)}`;
}
