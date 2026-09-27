// WS-25 (MCP OAuth): the ONE error class every `mcp-auth` door throws or reports with.
//
// A CODE a caller branches on, plus a message for a human. Messages name an ACCOUNT, a server URL's
// origin, an HTTP status or an OAuth error CODE -- never a token, a code, a `state`, a code verifier, a
// client secret, or an authorization server's response body (an `error_description` is the server's
// text, and a token endpoint that echoes its request would put the refresh token in it). WS-25 spec §5's
// security review checks exactly this.

/**
 * - `malformed_record` / `unsupported_record_version` -- a Keychain item that is not a record this SDK
 *   wrote (bad JSON, a missing field, the wrong `kind`), or one from a NEWER record version (`v`), which
 *   is refused rather than guessed at.
 * - `invalid_server_url` -- not an absolute http(s) URL, or one carrying userinfo.
 * - `invalid_account` -- not an `mcp-oauth:<16 hex>` token account name.
 * - `policy_refused` -- the auth-HTTP policy refused a URL (plain http off loopback, a literal private or
 *   link-local address, a cross-origin redirect, an oversized answer).
 * - `network` -- an auth request never got an answer (a refused connection, a timeout): retry later.
 * - `login_superseded` / `login_cancelled` / `login_timeout` -- the interactive sign-in ended without a
 *   callback (a newer sign-in for the same server, `cancel()`, the 5-minute bound).
 * - `state_mismatch` -- the loopback callback carried a `state` this flow never issued.
 * - `authorization_denied` -- the authorization server redirected back with `error=...`.
 * - `client_secret_unavailable` -- a pre-registered client's `clientSecretRef` could not be read.
 * - `callback_port_unavailable` -- the configured `oauth.callbackPort` is taken.
 * - `metadata_issuer_mismatch` -- a configured authorization server metadata document names an issuer it
 *   was not published under (RFC 8414 §3.3).
 * - `client_secret_issuer_mismatch` -- a pre-registered client secret would go to an authorization server
 *   other than the one it is bound to (its stamped/expected issuer, or an existing registration's).
 * - `login_failed` -- discovery, registration or the code exchange failed (the message says which step,
 *   and on the exchange never quotes the authorization server).
 * - `not_implemented` -- a contract stub (WS-25 lands its types first).
 */
export type McpOAuthErrorCode =
  | "malformed_record"
  | "unsupported_record_version"
  | "invalid_server_url"
  | "invalid_account"
  | "policy_refused"
  | "network"
  | "login_superseded"
  | "login_cancelled"
  | "login_timeout"
  | "state_mismatch"
  | "authorization_denied"
  | "client_secret_unavailable"
  | "callback_port_unavailable"
  | "client_secret_issuer_mismatch"
  | "metadata_issuer_mismatch"
  | "login_failed"
  | "not_implemented";

export class McpOAuthError extends Error {
  readonly code: McpOAuthErrorCode;
  constructor(code: McpOAuthErrorCode, message: string) {
    super(message);
    this.name = "McpOAuthError";
    this.code = code;
  }
}
