// WS-25 (MCP OAuth) §2: the interactive sign-in -- discovery, registration, PKCE, the loopback listener,
// `state` validation and the code exchange. The HOST drives it (Winter's daemon, on `mcp.login`; the CLI
// with no daemon); a session never opens a browser and never signs in, and the model is never handed an
// "authenticate" tool (spec §1.3: server-supplied metadata must not steer the model into handing the user
// a URL).
//
// THE PROTOCOL IS THE MCP CLIENT'S. `auth()` (`@modelcontextprotocol/client` 2.1.0) runs RFC 9728 and
// RFC 8414 / OIDC discovery with the legacy metadata-less fallback, the issuer checks (SEP-2352, RFC 9207
// `iss`), the RFC 8707 `resource`, PKCE S256, and the registration order CIMD-when-advertised > DCR. It
// is called TWICE with the `OAuthClientProvider` below -- once to reach the authorize URL, once on the
// callback with the code -- and the provider holds, in MEMORY for the flow's lifetime, what the second
// call must find again: the code verifier and the discovery state (the callback leg refuses to redeem a
// code when the recorded discovery state is missing, `AuthorizationServerMismatchError`). `tokens()`
// answers nothing during a sign-in, so `auth()` never takes its refresh branch here.
//
// WHAT WINTER ADDS, because the client package leaves it to the host:
//   - the LOOPBACK LISTENER, bound on `127.0.0.1` and registered as the SAME literal
//     `http://127.0.0.1:<port>/callback` (Claude Code binds one host and registers another);
//   - `state`: 32 random bytes, compared in constant time BEFORE the code is redeemed. A callback with a
//     wrong or missing `state` is answered 400 and the flow keeps waiting -- a stray or forged request
//     must not end the user's real sign-in;
//   - ONE FLOW PER SERVER: a new sign-in for the same server supersedes (cancels) the one in flight;
//   - the 5-minute bound, and the listener closed in `finally` on every path;
//   - a PRE-REGISTERED client (config `oauth.clientId`, its secret read through a Keychain locator) ahead
//     of CIMD and DCR, and the DCR registration PERSISTED with its port, reused on the next sign-in
//     (a busy port re-registers rather than failing);
//   - every request through the auth-HTTP policy (`fetch-policy.ts`), and the authorize URL itself held to
//     it (HTTPS, or literal loopback) before a host opens it in a browser.
//
// SECRETS. `done` reports a REASON -- an error code, an OAuth error code -- never a message from the code
// exchange (an authorization server's error text is its own, and may echo the request). Nothing here logs.
import { auth, computeScopeUnion, OAuthError, type OAuthClientInformationContext, type OAuthClientMetadata, type OAuthDiscoveryState, type OAuthClientProvider, type StoredOAuthClientInformation, type StoredOAuthTokens } from "@modelcontextprotocol/client";
import type { McpOAuthConfig, McpOAuthSecretRef } from "@yanlinglabs/winter-agent-sdk";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mcpOAuthClientAccount, mcpOAuthTokenAccount } from "./account.ts";
import { MCP_OAUTH_CALLBACK_PATH, MCP_OAUTH_LOGIN_TIMEOUT_MS, MCP_OAUTH_STATE_BYTES, WINTER_MCP_CLIENT_METADATA_URL } from "./constants.ts";
import { fetchAuthorizationServerMetadataDocument } from "./discovery.ts";
import { McpOAuthError } from "./errors.ts";
import { createMcpAuthFetch, evaluateMcpAuthUrl } from "./fetch-policy.ts";
import type { McpOAuthClientRecord } from "./records.ts";
import { readClientRecord, readTokenRecordLenient, writeClientRecord, writeTokenRecord, type McpOAuthStore } from "./store.ts";

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

/** One flow per server, keyed by the token account: a new sign-in supersedes the one in flight. */
const activeFlows = new Map<string, (reason: "login_superseded") => void>();

const CLIENT_NAME = "Winter";

function portOf(redirectUri: string): number | undefined {
  try {
    const url = new URL(redirectUri);
    return url.hostname === "127.0.0.1" && url.port !== "" ? Number(url.port) : undefined;
  } catch {
    return undefined;
  }
}

function sameState(a: string | null, b: string): boolean {
  if (a === null) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A reason string safe to hand a host: codes only. */
function reasonOf(err: unknown): string {
  if (err instanceof McpOAuthError) return err.code;
  if (err instanceof OAuthError) return `oauth_error:${err.code}`;
  return err instanceof Error ? err.name : "failed";
}

/**
 * `connection: close` on EVERY answer the listener gives: a browser (and `fetch`) keeps connections alive,
 * and a kept-alive connection outlives the listening socket -- the NEXT sign-in, binding the same persisted
 * port, would have its callback delivered over the old connection to the FINISHED flow's handler.
 */
const LISTENER_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", connection: "close" };

function page(title: string, status: number): Response {
  const body = `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:-apple-system,sans-serif;padding:3em"><h2>${title}</h2><p>You can close this window.</p></body>`;
  return new Response(body, { status, headers: LISTENER_HEADERS });
}

async function readSecret(opts: StartMcpOAuthLoginOptions, ref: McpOAuthSecretRef): Promise<string> {
  let secret: string | null;
  try {
    if (opts.readClientSecret !== undefined) secret = await opts.readClientSecret(ref);
    else if (ref.service === undefined) secret = await opts.store.read(ref.account);
    else throw new McpOAuthError("client_secret_unavailable", `the client secret's locator names Keychain service "${ref.service}"; pass readClientSecret to read another service`);
  } catch (err) {
    if (err instanceof McpOAuthError) throw err;
    throw new McpOAuthError("client_secret_unavailable", `the client secret at Keychain account "${ref.account}" could not be read`);
  }
  if (secret === null || secret === "") throw new McpOAuthError("client_secret_unavailable", `no client secret is stored at Keychain account "${ref.account}"`);
  return secret;
}

/** Binds the loopback listener; `port` 0 is ephemeral. Throws when a FIXED port is taken. */
function bindListener(port: number, handler: (req: Request) => Promise<Response> | Response): ReturnType<typeof Bun.serve> {
  return Bun.serve({ hostname: "127.0.0.1", port, fetch: handler });
}

export async function startMcpOAuthLogin(opts: StartMcpOAuthLoginOptions): Promise<McpOAuthLogin> {
  const serverVerdict = evaluateMcpAuthUrl(opts.serverUrl);
  if (!serverVerdict.ok) throw new McpOAuthError("policy_refused", `the MCP server URL is refused: ${serverVerdict.reason}`);
  const account = mcpOAuthTokenAccount(opts.serverUrl);
  const clientAccount = mcpOAuthClientAccount(opts.serverUrl);
  const now = opts.now ?? Date.now;
  const oauth = opts.oauth ?? {};
  const clientMetadataUrl = opts.clientMetadataUrl ?? WINTER_MCP_CLIENT_METADATA_URL;
  const fetchFn = createMcpAuthFetch(opts.fetch !== undefined ? { fetch: opts.fetch } : {});

  // A newer sign-in for the same server ends the one in flight BEFORE this one binds anything.
  activeFlows.get(account)?.("login_superseded");

  const preSecret = oauth.clientId !== undefined && oauth.clientSecretRef !== undefined ? await readSecret(opts, oauth.clientSecretRef) : undefined;
  // A malformed registration is treated as none (a fresh one is made); it is overwritten on success.
  const existingClient: McpOAuthClientRecord | null = await readClientRecord(opts.store, clientAccount).catch(() => null);

  // --- The listener: its port decides the redirect URI every registration and request names. ---------
  let onCallback: (req: Request) => Promise<Response> = async () => page("Not ready", 503);
  const handler = (req: Request): Promise<Response> | Response => {
    const url = new URL(req.url);
    if (req.method !== "GET" || url.pathname !== MCP_OAUTH_CALLBACK_PATH) return new Response("not found", { status: 404, headers: { connection: "close" } });
    return onCallback(req);
  };
  let reuseRegistration = false;
  let bound: ReturnType<typeof Bun.serve> | undefined;
  if (oauth.callbackPort !== undefined) {
    try {
      bound = bindListener(oauth.callbackPort, handler);
    } catch {
      throw new McpOAuthError("callback_port_unavailable", `the sign-in callback port ${oauth.callbackPort} (oauth.callbackPort) is in use`);
    }
  } else {
    // A persisted DCR registration names its port: reuse it, so the registration stays valid. Taken -> an
    // ephemeral port and a FRESH registration (spec §1.6), never a failure.
    const persistedPort = existingClient?.registeredVia === "dcr" && oauth.clientId === undefined ? portOf(existingClient.redirectUri) : undefined;
    if (persistedPort !== undefined) {
      try {
        bound = bindListener(persistedPort, handler);
        reuseRegistration = true;
      } catch {
        /* busy: fall through to an ephemeral port */
      }
    }
    bound ??= bindListener(0, handler);
  }
  const server = bound;
  const redirectUri = `http://127.0.0.1:${server.port}${MCP_OAUTH_CALLBACK_PATH}`;
  const state = randomBytes(MCP_OAUTH_STATE_BYTES).toString("base64url");

  // --- Flow state, in memory for the flow's lifetime (see the header). ---------------------------------
  let codeVerifier: string | undefined;
  let discovery: OAuthDiscoveryState | undefined;
  let authUrl: URL | undefined;
  let clientDecision: StoredOAuthClientInformation | undefined;
  let forgetExisting = false;

  // `oauth.authServerMetadataUrl`: the out-of-band discovery seed `discoveryState` exists for. The MCP
  // client then skips RFC 8414 discovery and uses this document (its issuer is still what the tokens and
  // the client are stamped with).
  if (oauth.authServerMetadataUrl !== undefined) {
    try {
      const metadata = await fetchAuthorizationServerMetadataDocument(oauth.authServerMetadataUrl, fetchFn);
      discovery = { authorizationServerUrl: metadata.issuer, authorizationServerMetadata: metadata };
    } catch (err) {
      server.stop(true);
      throw new McpOAuthError("login_failed", `the configured authorization server metadata (oauth.authServerMetadataUrl) could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const requestedScope = computeScopeUnion(oauth.scopes !== undefined && oauth.scopes.length > 0 ? oauth.scopes.join(" ") : undefined, existingClient?.stepUpScope);

  const clientRecordFor = (info: StoredOAuthClientInformation, issuer: string): McpOAuthClientRecord => {
    const via: McpOAuthClientRecord["registeredVia"] = oauth.clientId !== undefined && info.client_id === oauth.clientId ? "preregistered" : info.client_id === clientMetadataUrl ? "cimd" : "dcr";
    const secret = via === "preregistered" ? preSecret : (info as { client_secret?: string }).client_secret;
    const stepUpScope = existingClient !== null && existingClient.issuer === issuer ? existingClient.stepUpScope : undefined;
    return {
      v: 1,
      kind: "mcp-oauth-client",
      serverUrl: opts.serverUrl,
      issuer,
      clientId: info.client_id,
      ...(secret !== undefined ? { clientSecret: secret } : {}),
      registeredVia: via,
      redirectUri,
      ...(discovery?.resourceMetadataUrl !== undefined ? { resourceMetadataUrl: discovery.resourceMetadataUrl } : {}),
      // The seeded metadata DOCUMENT's URL when the config named one (a refresh re-reads it there, since
      // it need not live at the issuer's well-known path), else the authorization server discovery found.
      ...(oauth.authServerMetadataUrl !== undefined ? { authorizationServerUrl: oauth.authServerMetadataUrl } : discovery?.authorizationServerUrl !== undefined ? { authorizationServerUrl: String(discovery.authorizationServerUrl) } : {}),
      ...(stepUpScope !== undefined ? { stepUpScope } : {}),
    };
  };

  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return redirectUri;
    },
    // Offered only when no pre-registered client exists; the MCP client uses it only when the
    // authorization server advertises `client_id_metadata_document_supported`.
    ...(oauth.clientId === undefined ? { clientMetadataUrl } : {}),
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        // A native app is a PUBLIC client (RFC 8252 §8.4): no secret to protect on the user's machine.
        token_endpoint_auth_method: "none",
        ...(requestedScope !== undefined ? { scope: requestedScope } : {}),
      };
    },
    state: () => state,
    clientInformation(ctx?: OAuthClientInformationContext): StoredOAuthClientInformation | undefined {
      if (clientDecision !== undefined) return clientDecision;
      if (oauth.clientId !== undefined) {
        // Pre-registered first (spec §1.4): the MCP client stamps the issuer and saves it back.
        return { client_id: oauth.clientId, ...(preSecret !== undefined ? { client_secret: preSecret } : {}) };
      }
      if (forgetExisting || existingClient === null || ctx === undefined || existingClient.issuer !== ctx.issuer) return undefined;
      if (existingClient.registeredVia === "dcr" && reuseRegistration && existingClient.redirectUri === redirectUri) {
        return { client_id: existingClient.clientId, ...(existingClient.clientSecret !== undefined ? { client_secret: existingClient.clientSecret } : {}), issuer: existingClient.issuer };
      }
      if (existingClient.registeredVia === "cimd" && existingClient.clientId === clientMetadataUrl) {
        return { client_id: existingClient.clientId, issuer: existingClient.issuer };
      }
      return undefined;
    },
    async saveClientInformation(info: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext) {
      clientDecision = info;
      const issuer = info.issuer ?? ctx?.issuer;
      if (issuer === undefined) return;
      const record = clientRecordFor(info, issuer);
      // PERSISTED NOW, not on success: a DCR registration the user then abandons is still the one to reuse.
      await writeClientRecord(opts.store, clientAccount, record);
    },
    tokens: () => undefined,
    async saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext) {
      const issuer = tokens.issuer ?? ctx?.issuer;
      if (issuer === undefined) throw new McpOAuthError("login_failed", "the token answer carries no issuer binding");
      const previous = await readTokenRecordLenient(opts.store, account).catch(() => null);
      await writeTokenRecord(opts.store, account, {
        v: 1,
        kind: "mcp-oauth",
        serverUrl: opts.serverUrl,
        issuer,
        accessToken: tokens.access_token,
        ...(tokens.refresh_token !== undefined ? { refreshToken: tokens.refresh_token } : {}),
        ...(typeof tokens.expires_in === "number" ? { expiresAt: now() + tokens.expires_in * 1000 } : {}),
        ...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
        generation: (previous?.generation ?? 0) + 1,
      });
    },
    redirectToAuthorization(url: URL) {
      authUrl = url;
    },
    saveCodeVerifier(verifier: string) {
      codeVerifier = verifier;
    },
    codeVerifier() {
      if (codeVerifier === undefined) throw new McpOAuthError("login_failed", "no code verifier was recorded for this sign-in");
      return codeVerifier;
    },
    saveDiscoveryState(next: OAuthDiscoveryState) {
      discovery = next;
    },
    discoveryState: () => discovery,
    async invalidateCredentials(scope) {
      if (scope === "all" || scope === "client") {
        clientDecision = undefined;
        forgetExisting = true;
        await opts.store.remove(clientAccount).catch(() => {});
      }
      if (scope === "all" || scope === "discovery") discovery = oauth.authServerMetadataUrl !== undefined ? discovery : undefined;
      if (scope === "all" || scope === "verifier") codeVerifier = undefined;
    },
  };

  // --- Leg 1: discovery, registration, the authorize URL. ----------------------------------------------
  try {
    const result = await auth(provider, { serverUrl: opts.serverUrl, ...(requestedScope !== undefined ? { scope: requestedScope } : {}), fetchFn });
    if (result !== "REDIRECT" || authUrl === undefined) throw new McpOAuthError("login_failed", "the authorization server did not produce an authorization URL");
    const verdict = evaluateMcpAuthUrl(authUrl);
    if (!verdict.ok) throw new McpOAuthError("policy_refused", `the authorization URL is refused: ${verdict.reason}`);
  } catch (err) {
    server.stop(true);
    if (err instanceof McpOAuthError) throw err;
    // The START leg's messages are discovery and registration text (URLs, HTTP statuses, an OAuth error
    // code): no token exists yet, so none can be in them.
    throw new McpOAuthError("login_failed", `the sign-in could not start: ${err instanceof OAuthError ? `${err.code}` : err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  }
  const issuer = discovery?.authorizationServerMetadata?.issuer ?? (discovery?.authorizationServerUrl !== undefined ? String(discovery.authorizationServerUrl) : new URL(authUrl!).origin);
  const issuerOrigin = new URL(issuer).origin;

  // --- Leg 2: the callback. -------------------------------------------------------------------------
  let settle!: (outcome: McpOAuthLoginOutcome) => void;
  const done = new Promise<McpOAuthLoginOutcome>((resolve) => {
    settle = resolve;
  });
  let finished = false;
  let redeeming = false;
  const timeoutMs = opts.timeoutMs ?? MCP_OAUTH_LOGIN_TIMEOUT_MS;
  const finish = (outcome: McpOAuthLoginOutcome): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (activeFlows.get(account) === supersede) activeFlows.delete(account);
    // The listener's lifetime is the flow's. A GRACEFUL stop: the listening socket closes now (a
    // superseding sign-in can bind the same port at once), while the response that ended the flow --
    // this may be running inside the callback's own handler -- is still delivered to the browser.
    void server.stop();
    settle(outcome);
  };
  const timer = setTimeout(() => finish({ ok: false, reason: "login_timeout" }), timeoutMs);
  timer.unref?.();
  const supersede = (reason: "login_superseded"): void => finish({ ok: false, reason });
  activeFlows.set(account, supersede);

  onCallback = async (req) => {
    if (finished || redeeming) return page("This sign-in has already finished", 410);
    const params = new URL(req.url).searchParams;
    // `state` FIRST: nothing in a request that fails it is read, let alone redeemed.
    if (!sameState(params.get("state"), state)) return page("Sign-in failed: the request did not come from this sign-in", 400);
    const error = params.get("error");
    if (error !== null) {
      const code = /^[a-z_]{1,64}$/.test(error) ? error : "unknown";
      finish({ ok: false, reason: `authorization_denied:${code}` });
      return page("Sign-in was not approved", 400);
    }
    const code = params.get("code");
    if (code === null || code === "") return page("Sign-in failed: no authorization code", 400);
    redeeming = true;
    try {
      const iss = params.get("iss");
      const result = await auth(provider, { serverUrl: opts.serverUrl, authorizationCode: code, ...(iss !== null ? { iss } : {}), fetchFn });
      if (result !== "AUTHORIZED") throw new McpOAuthError("login_failed", "the code exchange did not authorize");
      finish({ ok: true });
      return page("Signed in to the MCP server", 200);
    } catch (err) {
      finish({ ok: false, reason: `token_exchange_failed:${reasonOf(err)}` });
      return page("Sign-in failed", 400);
    }
  };

  return {
    authUrl: authUrl!.toString(),
    issuerOrigin,
    done,
    cancel: () => finish({ ok: false, reason: "login_cancelled" }),
  };
}

/** Test seam: how many sign-in flows are waiting for a callback. */
export function activeMcpOAuthLoginCount(): number {
  return activeFlows.size;
}
