// WS-25 (MCP OAuth) §2: the interactive sign-in -- discovery, registration, PKCE, the loopback listener,
// `state` validation and the code exchange. The HOST drives it (Winter's daemon, on `mcp.login`); a session
// never opens a browser and never signs in.
import type { McpOAuthConfig, McpOAuthSecretRef } from "@yanlinglabs/winter-agent-sdk";
import { McpOAuthError } from "./errors.ts";
import type { McpOAuthStore } from "./store.ts";

export interface StartMcpOAuthLoginOptions {
  /** The MCP server's URL (the protected resource). Its canonical form keys the Keychain items. */
  serverUrl: string;
  /** The server config's `oauth` block, when it has one. */
  oauth?: McpOAuthConfig;
  /** Where the sign-in lands: the token item and the client registration. */
  store: McpOAuthStore;
  /** Overrides `WINTER_MCP_CLIENT_METADATA_URL` (tests; a host that publishes its own CIMD document). */
  clientMetadataUrl?: string;
  /** The network under the auth-HTTP policy (tests pass the fixture's). The policy is applied on top, always. */
  fetch?: typeof fetch;
  /** The clock (tests). Epoch ms. */
  now?: () => number;
  /**
   * WS-25, additive: reads a pre-registered client's secret from its `oauth.clientSecretRef`. Absent: the
   * `store` is read at `ref.account` when the ref names no `service` (the host's own), and a ref naming
   * another service is refused typed (`client_secret_unavailable`).
   */
  readClientSecret?: (ref: McpOAuthSecretRef) => Promise<string | null>;
  /** WS-25, additive: the whole sign-in's budget in ms (default `MCP_OAUTH_LOGIN_TIMEOUT_MS`, 5 minutes). */
  timeoutMs?: number;
}

export type McpOAuthLoginOutcome = { ok: true } | { ok: false; reason: string };

export interface McpOAuthLogin {
  /** The authorization server's authorize URL, for the HOST to open in a browser. HTTPS (or literal loopback). */
  authUrl: string;
  /** The authorization server's issuer ORIGIN, to show the user before the browser opens. */
  issuerOrigin: string;
  /** Settles once: the callback arrived and the tokens are stored, or the sign-in ended without them. */
  done: Promise<McpOAuthLoginOutcome>;
  /** Ends the sign-in now (closes the listener); `done` settles `{ ok: false }`. Idempotent. */
  cancel(): void;
}

export async function startMcpOAuthLogin(_opts: StartMcpOAuthLoginOptions): Promise<McpOAuthLogin> {
  throw new McpOAuthError("not_implemented", "startMcpOAuthLogin is not implemented yet");
}
