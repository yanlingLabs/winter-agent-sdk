// WS-25 (MCP OAuth) §2 / §1.6: sign-out -- best-effort RFC 7009 revocation, then the token item is removed
// (and the client registration too, only when asked).
//
// BEST EFFORT, BY DESIGN: the local sign-out must always happen, whatever the authorization server says or
// fails to say. The refresh token is revoked first (on most servers that takes its access tokens with it),
// then the access token; a server that advertises no `revocation_endpoint` is simply not asked. No error
// escapes, and nothing is logged beyond the account and a status.
import { clientAccountForTokenAccount } from "./account.ts";
import { loadAuthorizationServer } from "./discovery.ts";
import { createMcpAuthFetch, type McpAuthFetch } from "./fetch-policy.ts";
import { readClientRecord, readTokenRecordLenient, type McpOAuthStore } from "./store.ts";

export interface RevokeMcpOAuthOptions {
  /** The token item's FULL account name, `mcp-oauth:<id>`. */
  account: string;
  store: McpOAuthStore;
  /** The network under the auth-HTTP policy (tests). The policy is applied on top, always. */
  fetch?: typeof fetch;
  /**
   * WS-25, additive (`winter mcp logout --forget-client`): also remove the client registration. Absent, it
   * is KEPT (spec §1.6) -- re-registering on every sign-in would be DCR spam, and a pre-registered or CIMD
   * client has nothing to re-register.
   */
  forgetClient?: boolean;
}

export async function revokeMcpOAuth(opts: RevokeMcpOAuthOptions): Promise<void> {
  const clientAccount = clientAccountForTokenAccount(opts.account);
  try {
    await revokeRemotely(opts, clientAccount);
  } catch {
    console.error(`winter: mcp-auth: revocation for ${opts.account} did not complete; the local sign-out proceeds`);
  }
  await opts.store.remove(opts.account);
  if (opts.forgetClient === true) await opts.store.remove(clientAccount);
}

async function revokeRemotely(opts: RevokeMcpOAuthOptions, clientAccount: string): Promise<void> {
  const record = await readTokenRecordLenient(opts.store, opts.account);
  if (record === null) return;
  const client = await readClientRecord(opts.store, clientAccount).catch(() => null);
  if (client === null || client.issuer !== record.issuer) return;
  const fetchFn = createMcpAuthFetch(opts.fetch !== undefined ? { fetch: opts.fetch } : {});
  const server = await loadAuthorizationServer({ authorizationServerUrl: client.authorizationServerUrl ?? record.issuer, expectedIssuer: record.issuer, fetchFn });
  const endpoint = (server.metadata as { revocation_endpoint?: unknown } | undefined)?.revocation_endpoint;
  if (typeof endpoint !== "string") return;
  const tokens: Array<[string, "refresh_token" | "access_token"]> = [];
  if (record.refreshToken !== undefined) tokens.push([record.refreshToken, "refresh_token"]);
  tokens.push([record.accessToken, "access_token"]);
  for (const [token, hint] of tokens) await revokeOne(fetchFn, endpoint, token, hint, client.clientId, client.clientSecret, opts.account);
}

async function revokeOne(fetchFn: McpAuthFetch, endpoint: string, token: string, hint: string, clientId: string, clientSecret: string | undefined, account: string): Promise<void> {
  const body = new URLSearchParams({ token, token_type_hint: hint });
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  // RFC 7009 §2.1: a confidential client authenticates (HTTP Basic, RFC 6749 §2.3.1); a public one names itself.
  if (clientSecret !== undefined) headers.set("authorization", `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`)}`);
  else body.set("client_id", clientId);
  const response = await fetchFn(endpoint, { method: "POST", headers, body });
  await response.text().catch(() => {});
  if (!response.ok) console.error(`winter: mcp-auth: revocation for ${account} (${hint}) answered HTTP ${response.status}`);
}
