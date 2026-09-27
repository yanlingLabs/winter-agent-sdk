// WS-25 (MCP OAuth): the runtime's MCP sign-in, as a public subpath --
// `@yanlinglabs/winter-agent-runtime/mcp-auth`.
//
// WHO USES IT. The HOST -- Winter's daemon and CLI: `startMcpOAuthLogin` on `mcp.login` / `winter mcp
// login`, `refreshMcpOAuthToken` when a session asks (`mcp_oauth_refresh`), `revokeMcpOAuth` on logout,
// and `mcpOAuthAccountId` to find a server's Keychain items from its config alone. Sessions reach the
// same records through the runtime's own MCP client; they only ever READ the token item.
//
// LIGHT ON PURPOSE, like `./mcp-client`: this entry reaches the `mcp-auth` module, the keychain store and
// the MCP client package's auth functions -- never the engine, the tool registry or anything with
// module-level session state -- so a host can import it on its main thread.
export {
  canonicalMcpServerUrl,
  clientAccountForTokenAccount,
  isMcpOAuthTokenAccount,
  mcpOAuthAccountId,
  mcpOAuthClientAccount,
  mcpOAuthClientSecretAccount,
  mcpOAuthTokenAccount,
  MCP_OAUTH_CLIENT_ACCOUNT_PREFIX,
  MCP_OAUTH_TOKEN_ACCOUNT_PREFIX,
} from "./mcp-auth/account.ts";
export { McpOAuthError, type McpOAuthErrorCode } from "./mcp-auth/errors.ts";
export { validateMcpOAuthConfig } from "./mcp-auth/config.ts";
export { evaluateMcpAuthUrl } from "./mcp-auth/fetch-policy.ts";
export {
  decodeMcpOAuthClientRecord,
  decodeMcpOAuthTokenRecord,
  encodeMcpOAuthClientRecord,
  encodeMcpOAuthTokenRecord,
  type McpOAuthClientRecord,
  type McpOAuthTokenRecord,
} from "./mcp-auth/records.ts";
export { createKeychainMcpOAuthStore, createMemoryMcpOAuthStore, MCP_OAUTH_HOST_HELD_REFRESH_TOKEN, toSessionMcpTokenRecord, type McpOAuthStore } from "./mcp-auth/store.ts";
export {
  MCP_OAUTH_CALLBACK_PATH,
  MCP_OAUTH_EXPIRY_SKEW_MS,
  MCP_OAUTH_LOGIN_TIMEOUT_MS,
  MCP_OAUTH_SESSION_CACHE_MS,
  WINTER_MCP_CLIENT_METADATA_URL,
} from "./mcp-auth/constants.ts";
export { startMcpOAuthLogin, type McpOAuthLogin, type McpOAuthLoginOutcome, type StartMcpOAuthLoginOptions } from "./mcp-auth/login.ts";
export { refreshMcpOAuthToken, type RefreshMcpOAuthTokenOptions, type RefreshMcpOAuthTokenResult } from "./mcp-auth/refresh.ts";
export { revokeMcpOAuth, type RevokeMcpOAuthOptions } from "./mcp-auth/revoke.ts";
// The wire half, declared in the SDK package (a host that never imports the runtime still types it).
export { CREDENTIAL_RESOLVE_SUBTYPE, type CredentialResolveAnswer, type CredentialResolveRequest, MCP_OAUTH_REFRESH_SUBTYPE, type McpOAuthConfig, type McpOAuthRefreshAnswer, type McpOAuthRefreshRequest, type McpOAuthSecretRef } from "@yanlinglabs/winter-agent-sdk";

/** The status string `mcp_status` / `system/init.mcp_servers` report for a server that needs sign-in. */
export const MCP_STATUS_NEEDS_AUTH = "needs-auth";
