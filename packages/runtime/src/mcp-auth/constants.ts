// WS-25 (MCP OAuth): the numbers and the one URL the sign-in doors share. Each is spelled ONCE.

/**
 * Winter's Client ID Metadata Document (CIMD, draft-ietf-oauth-client-id-metadata-document; MCP spec
 * 2025-11-25's preferred registration): an authorization server that advertises
 * `client_id_metadata_document_supported` fetches THIS URL as Winter's client id, and no per-server
 * registration exists at all.
 *
 * PROVISIONAL (spec §1.5): the user's Cloudflare domain is `yanlinglabs.com`; the exact permanent URL is
 * pending the user's one-line confirmation, and publishing the document there is a separate controller
 * step. So it is ONE constant, and every door that uses it takes a `clientMetadataUrl` override (tests
 * pass their own).
 *
 * THE DOCUMENT'S REDIRECT URIS (spec §4.2, settled): `["http://127.0.0.1/callback"]` -- a loopback IP
 * literal with NO port. A CIMD document is global, so it cannot name the port one machine's listener
 * got; RFC 8252 §7.3 obliges an authorization server to "allow any port to be specified at the time of
 * the request for loopback IP redirect URIs", which is exactly how a native client with an ephemeral
 * port registers once. Winter binds `127.0.0.1` (never `localhost`, RFC 8252 §8.3) on the config's
 * `callbackPort` or an ephemeral port, and sends that exact URI. An authorization server that ignores
 * §7.3 fails at its own consent page; the fallback is a pre-registered client (`oauth.clientId`) with a
 * fixed `oauth.callbackPort`.
 */
export const WINTER_MCP_CLIENT_METADATA_URL = "https://yanlinglabs.com/winter/oauth-client.json";

/** The loopback redirect's path. The CIMD document registers `http://127.0.0.1/callback` with it. */
export const MCP_OAUTH_CALLBACK_PATH = "/callback";

/** A token within this many ms of `expiresAt` counts as expired: it is refreshed before a request can fail with it (spec §1.2). */
export const MCP_OAUTH_EXPIRY_SKEW_MS = 60_000;

/** How long a session trusts its last Keychain read of a token before re-reading it (spec §3, "~30 s"). */
export const MCP_OAUTH_SESSION_CACHE_MS = 30_000;

/** An interactive sign-in's whole budget: the listener closes and `done` settles `login_timeout` after it. */
export const MCP_OAUTH_LOGIN_TIMEOUT_MS = 5 * 60_000;

/** The `state` parameter's entropy: 32 random bytes, base64url. */
export const MCP_OAUTH_STATE_BYTES = 32;
