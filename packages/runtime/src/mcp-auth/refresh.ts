// WS-25 (MCP OAuth) §1.1 / §2: the refresh the HOST runs (Winter's daemon, answering `mcp_oauth_refresh`)
// -- and a standalone SDK session runs in-process when its host registers no handler.
//
// ONE REFRESHER. A rotating refresh token may be posted exactly once: an authorization server that
// detects a replayed one revokes the whole token family (RFC 9700 §4.14, and the fixture AS does), so N
// sessions each refreshing the same sign-in would sign the user out. Two guards make one refresh out of
// many asks:
//   1. SINGLE-FLIGHT per (store, account) in this process: a second ask while one is posting JOINS it.
//   2. GENERATION: an ask carries the generation its session last read; a stored record that has already
//      moved past it means someone refreshed first -- answer ok, post nothing. And the record is RE-READ
//      right before posting, so a refresh another process (the CLI) finished while this one was
//      discovering is not replayed either.
//
// NOT `auth()`. The MCP client's orchestrator falls back to a fresh browser authorization when a refresh
// fails, `console.warn`s the failure's message, and embeds a non-JSON error body in it ("Raw body: ...")
// -- a token endpoint that echoes its request would put the refresh token in a log line. This file calls
// `refreshAuthorization` directly and reports a REASON only: the account and an OAuth error code, never a
// message or a body.
import { computeScopeUnion, InsecureTokenEndpointError, OAuthError, OAuthErrorCode, refreshAuthorization } from "@modelcontextprotocol/client";
import { clientAccountForTokenAccount } from "./account.ts";
import { loadAuthorizationServer, resolveResourceIndicator } from "./discovery.ts";
import { McpOAuthError } from "./errors.ts";
import { createMcpAuthFetch, isLoopbackMcpServer } from "./fetch-policy.ts";
import type { McpOAuthTokenRecord } from "./records.ts";
import { MCP_OAUTH_HOST_HELD_REFRESH_TOKEN, readClientRecord, readTokenRecordLenient, writeClientRecord, writeTokenRecord, type McpOAuthStore } from "./store.ts";

export interface RefreshMcpOAuthTokenOptions {
  /** The token item's FULL account name, `mcp-oauth:<id>`. The client item is its prefix swap. */
  account: string;
  store: McpOAuthStore;
  /** The network under the auth-HTTP policy (tests). The policy is applied on top, always. */
  fetch?: typeof fetch;
  /** The clock (tests). Epoch ms. */
  now?: () => number;
  /**
   * WS-25, additive: the generation the ASKING session last read (`McpOAuthRefreshRequest.generation`).
   * When the stored record has already moved past it, another caller refreshed first: the answer is
   * `{ ok: true }` with the stored generation, and nothing is posted.
   */
  generation?: number;
  /**
   * WS-25, additive: a scope a `403 insufficient_scope` asked for (`McpOAuthRefreshRequest.stepUpScope`).
   * A refresh cannot widen a grant (RFC 6749 §6), so it is recorded on the client registration for the
   * next sign-in and the answer is `needs_auth`.
   */
  stepUpScope?: string;
}

export type RefreshMcpOAuthTokenResult = { ok: true; generation: number } | { ok: false; reason: "needs_auth" | "transient" };

/**
 * Per store, per account: the refresh in flight. A WeakMap so a store (a test's, a host's) never outlives
 * its own use. KEYED ON THE STORE OBJECT: a host must pass ONE store instance per process for every
 * refresh -- building a fresh `createKeychainMcpOAuthStore()` per request would give every request its
 * own single-flight map, i.e. none at all (the generation re-read still guards, but only after discovery).
 */
const inflight = new WeakMap<McpOAuthStore, Map<string, Promise<RefreshMcpOAuthTokenResult>>>();

/** The OAuth errors after which only a new sign-in helps. Everything else (5xx, 429, the network) is `transient`. */
const SIGN_IN_AGAIN: ReadonlySet<string> = new Set<string>([OAuthErrorCode.InvalidGrant, OAuthErrorCode.InvalidClient, OAuthErrorCode.UnauthorizedClient, OAuthErrorCode.InvalidScope, OAuthErrorCode.UnsupportedGrantType]);

function log(account: string, what: string): void {
  // One line, names only: the account and a code or status. Never a token, a body or a message.
  console.error(`winter: mcp-auth: refresh for ${account}: ${what}`);
}

/**
 * Refreshes ONE sign-in (see this file's header). Pass the SAME `store` instance on every call in a process:
 * the single-flight is per store object.
 */
export async function refreshMcpOAuthToken(opts: RefreshMcpOAuthTokenOptions): Promise<RefreshMcpOAuthTokenResult> {
  // Validated first, outside the single-flight: a malformed account is the caller's bug, thrown typed.
  const clientAccount = clientAccountForTokenAccount(opts.account);
  let perStore = inflight.get(opts.store);
  if (perStore === undefined) {
    perStore = new Map();
    inflight.set(opts.store, perStore);
  }
  const running = perStore.get(opts.account);
  // A joiner with a generation the running refresh already superseded gets that refresh's answer, which
  // is exactly right: the run re-reads and writes a generation past it.
  if (running !== undefined) return running;
  const run = refreshOnce(opts, clientAccount).finally(() => {
    perStore.delete(opts.account);
  });
  perStore.set(opts.account, run);
  return run;
}

async function refreshOnce(opts: RefreshMcpOAuthTokenOptions, clientAccount: string): Promise<RefreshMcpOAuthTokenResult> {
  const { account, store } = opts;
  const now = opts.now ?? Date.now;
  let record: McpOAuthTokenRecord | null;
  try {
    record = await readTokenRecordLenient(store, account);
  } catch (err) {
    // A NEWER record version: not ours to refresh, and "sign in again" would overwrite it.
    log(account, err instanceof McpOAuthError ? err.code : "unreadable");
    return { ok: false, reason: "transient" };
  }
  if (record === null) return { ok: false, reason: "needs_auth" };
  if (opts.generation !== undefined && record.generation !== opts.generation) return { ok: true, generation: record.generation };

  if (opts.stepUpScope !== undefined && opts.stepUpScope.trim() !== "") {
    await recordStepUp(store, clientAccount, opts.stepUpScope);
    return { ok: false, reason: "needs_auth" };
  }
  if (record.refreshToken === undefined) return { ok: false, reason: "needs_auth" };
  // Fix round 2 (M-a): the session-side MARKER is not a refresh token. A store holding it is a session's
  // view, not the host's record -- never posted to a token endpoint.
  if (record.refreshToken === MCP_OAUTH_HOST_HELD_REFRESH_TOKEN) {
    log(account, "the record holds the host-held marker, not a refresh token (a session's view, not the host's store)");
    return { ok: false, reason: "needs_auth" };
  }

  let client;
  try {
    client = await readClientRecord(store, clientAccount);
  } catch {
    client = null;
  }
  if (client === null || client.issuer !== record.issuer) {
    // No registration to refresh with (or one for another issuer, SEP-2352): only a sign-in helps.
    log(account, "no client registration for this sign-in's issuer");
    return { ok: false, reason: "needs_auth" };
  }

  const fetchFn = createMcpAuthFetch({ ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}), allowLoopback: isLoopbackMcpServer(record.serverUrl) });
  try {
    const server = await loadAuthorizationServer({ authorizationServerUrl: client.authorizationServerUrl ?? record.issuer, expectedIssuer: record.issuer, fetchFn });
    const resource = await resolveResourceIndicator({ serverUrl: record.serverUrl, ...(client.resourceMetadataUrl !== undefined ? { resourceMetadataUrl: client.resourceMetadataUrl } : {}), fetchFn });

    // THE RE-READ: discovery took network round trips; a refresh that finished elsewhere meanwhile has
    // already rotated the token this run holds, and posting it now would be exactly the replay.
    const fresh = await readTokenRecordLenient(store, account);
    if (fresh === null) return { ok: false, reason: "needs_auth" };
    if (fresh.generation !== record.generation) return { ok: true, generation: fresh.generation };

    const tokens = await refreshAuthorization(server.authorizationServerUrl, {
      ...(server.metadata !== undefined ? { metadata: server.metadata } : {}),
      clientInformation: { client_id: client.clientId, ...(client.clientSecret !== undefined ? { client_secret: client.clientSecret } : {}) },
      refreshToken: record.refreshToken,
      // The PRM string VERBATIM, exactly as the sign-in's `auth()` sent it: a `URL` would turn a pathless
      // `https://mcp.example.com` into `https://mcp.example.com/`, a different indicator (`invalid_target`).
      ...(resource !== undefined ? { resource } : {}),
      fetchFn,
    });
    const generation = record.generation + 1;
    const refreshToken = tokens.refresh_token ?? record.refreshToken; // RFC 6749 §6: an omitted one is kept
    const scope = tokens.scope ?? record.scope;
    await writeTokenRecord(store, account, {
      v: 1,
      kind: "mcp-oauth",
      serverUrl: record.serverUrl,
      issuer: record.issuer,
      accessToken: tokens.access_token,
      ...(refreshToken !== undefined ? { refreshToken } : {}),
      ...(typeof tokens.expires_in === "number" ? { expiresAt: now() + tokens.expires_in * 1000 } : {}),
      ...(scope !== undefined ? { scope } : {}),
      generation,
    });
    return { ok: true, generation };
  } catch (err) {
    if (err instanceof OAuthError) {
      if (err.code === OAuthErrorCode.InvalidGrant) {
        // The refresh token is dead (expired, revoked, or a reuse the AS detected): the sign-in is gone.
        log(account, `${err.code}; the sign-in is cleared`);
        await store.remove(account).catch(() => {});
        return { ok: false, reason: "needs_auth" };
      }
      if (err.code === OAuthErrorCode.InvalidClient || err.code === OAuthErrorCode.UnauthorizedClient) {
        // The REGISTRATION is gone (a DCR client the AS expired): the next sign-in registers afresh.
        log(account, `${err.code}; the client registration is cleared`);
        await store.remove(clientAccount).catch(() => {});
        return { ok: false, reason: "needs_auth" };
      }
      log(account, err.code);
      return { ok: false, reason: SIGN_IN_AGAIN.has(err.code) ? "needs_auth" : "transient" };
    }
    if (err instanceof InsecureTokenEndpointError || (err instanceof McpOAuthError && err.code === "policy_refused")) {
      // A token endpoint the policy will never reach: retrying cannot help, and neither can a silent loop.
      log(account, "the token endpoint is refused by the auth-HTTP policy");
      return { ok: false, reason: "needs_auth" };
    }
    log(account, err instanceof McpOAuthError ? err.code : "transient failure");
    return { ok: false, reason: "transient" };
  }
}

/** Records a step-up scope on the client registration (unioned with any earlier one) for the next sign-in. */
async function recordStepUp(store: McpOAuthStore, clientAccount: string, scope: string): Promise<void> {
  let client;
  try {
    client = await readClientRecord(store, clientAccount);
  } catch {
    return;
  }
  if (client === null) return;
  const stepUpScope = computeScopeUnion(client.stepUpScope, scope);
  if (stepUpScope === undefined || stepUpScope === client.stepUpScope) return;
  await writeClientRecord(store, clientAccount, { ...client, stepUpScope });
}
