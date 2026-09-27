// WS-25 (MCP OAuth) §2: the interactive sign-in -- discovery, registration, PKCE, the loopback listener,
// `state` validation and the code exchange. The HOST drives it (Winter's daemon, on `mcp.login`; the CLI
// with no daemon); a session never opens a browser and never signs in, and the model is never handed an
// "authenticate" tool (spec §1.3: server-supplied metadata must not steer the model into handing the user
// a URL).
//
// THE PROTOCOL IS THE MCP CLIENT'S. Leg 1 is `auth()` (`@modelcontextprotocol/client` 2.1.0): RFC 9728 and
// RFC 8414 / OIDC discovery with the legacy metadata-less fallback, the issuer checks (SEP-2352), the
// RFC 8707 `resource`, PKCE S256, and the registration order CIMD-when-advertised > DCR, through the
// `OAuthClientProvider` below, which holds the code verifier and the discovery state in MEMORY for the
// flow's lifetime. `tokens()` answers nothing during a sign-in, so `auth()` never takes its refresh branch.
//
// LEG 2 IS NOT `auth()` (fix round 1): on `invalid_client`/`invalid_grant` it `console.warn`s the
// authorization server's `error_description`, invalidates the stored registration and RETRIES -- with the
// SAME single-use code (a DCR client re-registers and posts the code twice). The callback leg calls the
// exported `exchangeAuthorization` directly with the discovery state, client and verifier leg 1 left,
// which still validates RFC 9207 `iss` against the recorded metadata, and reports OAuth error CODES only.
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
import { auth, computeScopeUnion, exchangeAuthorization, OAuthError, OAuthErrorCode, type OAuthClientInformationContext, type OAuthClientMetadata, type OAuthDiscoveryState, type OAuthClientProvider, type StoredOAuthClientInformation } from "@modelcontextprotocol/client";
import type { McpOAuthConfig } from "@yanlinglabs/winter-agent-sdk";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mcpOAuthClientAccount, mcpOAuthClientSecretAccount, mcpOAuthTokenAccount } from "./account.ts";
import { MCP_OAUTH_CALLBACK_PATH, MCP_OAUTH_LOGIN_TIMEOUT_MS, MCP_OAUTH_STATE_BYTES, WINTER_MCP_CLIENT_METADATA_URL } from "./constants.ts";
import { fetchAuthorizationServerMetadataDocument } from "./discovery.ts";
import { boundedReason, McpOAuthError } from "./errors.ts";
import { createMcpAuthFetch, evaluateMcpAuthUrl, isLoopbackMcpServer } from "./fetch-policy.ts";
import { decodeMcpOAuthClientSecretItem, encodeMcpOAuthClientSecretItem, sameIssuer, type McpOAuthClientRecord, type McpOAuthClientSecretItem } from "./records.ts";
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
   * WS-25, additive: reads a pre-registered client's secret when the config marks one
   * (`oauth.clientSecretRef: { kind: "keychain" }`). It is called with the ONE account the secret may live
   * at -- `mcpOAuthClientSecretAccount(serverUrl)`, derived, never config-named (fix round 1) -- and a
   * host passes it only to read that account from somewhere other than `store`. Absent: `store` is read
   * at that account.
   */
  readClientSecret?: (account: string) => Promise<string | null>;
  /** WS-25, additive: the whole sign-in's budget in ms (default `MCP_OAUTH_LOGIN_TIMEOUT_MS`, 5 minutes). */
  timeoutMs?: number;
}

export type McpOAuthLoginOutcome = { ok: true } | { ok: false; reason: string };

export interface McpOAuthLogin {
  /** The authorization server's authorize URL, for the HOST to open in a browser. HTTPS (or literal loopback). */
  authUrl: string;
  /**
   * The FULL verified issuer string this sign-in used -- RFC 8414 `issuer` when the server published
   * metadata, else the authorization server URL discovery landed on (the legacy variant). Two tenants
   * behind one reverse proxy (`https://host/tenant/a`, `https://host/tenant/b`) share an ORIGIN but never
   * this string: a caller that must tell them apart (the daemon's own authorization-server bookkeeping)
   * compares THIS, with `sameIssuer` (`records.ts`), never `issuerOrigin`.
   */
  issuer: string;
  /** The authorization server's issuer ORIGIN, to show the user before the browser opens. */
  issuerOrigin: string;
  /**
   * WS-25 fix round 1, additive: the ORIGIN of `authUrl` itself -- the page the browser will actually load.
   * Usually the issuer's; a host shows both when they differ (metadata may place the authorize endpoint on
   * another host).
   */
  authorizeOrigin: string;
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

/** Reads the pre-registered client's secret from its DERIVED account -- the only account ever read for it. */
async function readSecret(opts: StartMcpOAuthLoginOptions, account: string): Promise<string> {
  let secret: string | null;
  try {
    secret = opts.readClientSecret !== undefined ? await opts.readClientSecret(account) : await opts.store.read(account);
  } catch {
    throw new McpOAuthError("client_secret_unavailable", `the client secret at Keychain account "${account}" could not be read`);
  }
  if (secret === null || secret === "") throw new McpOAuthError("client_secret_unavailable", `no client secret is stored at Keychain account "${account}"`);
  return secret;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "an unparseable issuer";
  }
}

/** Binds the loopback listener; `port` 0 is ephemeral. Throws when a FIXED port is taken. */
function bindListener(port: number, handler: (req: Request) => Promise<Response> | Response): ReturnType<typeof Bun.serve> {
  return Bun.serve({ hostname: "127.0.0.1", port, fetch: handler });
}

export async function startMcpOAuthLogin(opts: StartMcpOAuthLoginOptions): Promise<McpOAuthLogin> {
  const serverVerdict = evaluateMcpAuthUrl(opts.serverUrl, { allowLoopback: true });
  if (!serverVerdict.ok) throw new McpOAuthError("policy_refused", `the MCP server URL is refused: ${serverVerdict.reason}`);
  const account = mcpOAuthTokenAccount(opts.serverUrl);
  const clientAccount = mcpOAuthClientAccount(opts.serverUrl);
  const now = opts.now ?? Date.now;
  const oauth = opts.oauth ?? {};
  const clientMetadataUrl = opts.clientMetadataUrl ?? WINTER_MCP_CLIENT_METADATA_URL;
  // Loopback auth URLs only for a server that is itself on loopback (fetch-policy.ts, rule 1).
  const allowLoopback = isLoopbackMcpServer(opts.serverUrl);
  const fetchFn = createMcpAuthFetch({ ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}), allowLoopback });

  // ONE FLOW PER SERVER (fix round 1 I3): this flow claims the slot SYNCHRONOUSLY, before its first await,
  // superseding whatever held it. A flow superseded while it is still starting notices at the next
  // `checkpoint()` and unwinds (listener stopped, nothing registered as live); one superseded after it
  // started settles `login_superseded` through `finish`.
  let supersededEarly = false;
  let finishLive: ((outcome: McpOAuthLoginOutcome) => void) | undefined;
  const supersede = (reason: "login_superseded"): void => {
    if (finishLive !== undefined) finishLive({ ok: false, reason });
    else supersededEarly = true;
  };
  activeFlows.get(account)?.("login_superseded");
  activeFlows.set(account, supersede);
  const checkpoint = (): void => {
    if (supersededEarly) throw new McpOAuthError("login_superseded", "a newer sign-in for this server started");
  };
  const release = (): void => {
    if (activeFlows.get(account) === supersede) activeFlows.delete(account);
  };

  let server: ReturnType<typeof Bun.serve> | undefined;
  let onCallback: (req: Request) => Promise<Response> = async () => page("Not ready", 503);
  // Flow state, in memory for the flow's lifetime (see the header).
  let codeVerifier: string | undefined;
  let discovery: OAuthDiscoveryState | undefined;
  let authUrl: URL | undefined;
  let clientDecision: StoredOAuthClientInformation | undefined;
  let lastClientInfo: StoredOAuthClientInformation | undefined;
  let forgetExisting = false;
  let redirectUri = "";
  let existingClient: McpOAuthClientRecord | null = null;
  let requestedScope: string | undefined;
  let recordFor: ((info: StoredOAuthClientInformation, issuer: string) => McpOAuthClientRecord) | undefined;
  let preSecretItem: McpOAuthClientSecretItem | undefined;
  let preSecret: string | undefined;
  const state = randomBytes(MCP_OAUTH_STATE_BYTES).toString("base64url");

  try {
    // The secret is read ONLY from its derived account (fix round 1 C1): a config marks that a secret
    // exists, never where it lives.
    preSecretItem = oauth.clientId !== undefined && oauth.clientSecretRef !== undefined ? decodeMcpOAuthClientSecretItem(await readSecret(opts, mcpOAuthClientSecretAccount(opts.serverUrl))) : undefined;
    preSecret = preSecretItem?.secret;
    checkpoint();
    // A malformed registration is treated as none (a fresh one is made); it is overwritten on success.
    existingClient = await readClientRecord(opts.store, clientAccount).catch(() => null);
    checkpoint();

    // --- The listener: its port decides the redirect URI every registration and request names. -------
    const handler = (req: Request): Promise<Response> | Response => {
      const url = new URL(req.url);
      if (req.method !== "GET" || url.pathname !== MCP_OAUTH_CALLBACK_PATH) return new Response("not found", { status: 404, headers: { connection: "close" } });
      return onCallback(req);
    };
    let reuseRegistration = false;
    if (oauth.callbackPort !== undefined) {
      try {
        server = bindListener(oauth.callbackPort, handler);
      } catch {
        throw new McpOAuthError("callback_port_unavailable", `the sign-in callback port ${oauth.callbackPort} (oauth.callbackPort) is in use`);
      }
    } else {
      // A persisted DCR registration names its port: reuse it, so the registration stays valid. Taken -> an
      // ephemeral port and a FRESH registration (spec §1.6), never a failure.
      const persistedPort = existingClient?.registeredVia === "dcr" && oauth.clientId === undefined ? portOf(existingClient.redirectUri) : undefined;
      if (persistedPort !== undefined) {
        try {
          server = bindListener(persistedPort, handler);
          reuseRegistration = true;
        } catch {
          /* busy: fall through to an ephemeral port */
        }
      }
      server ??= bindListener(0, handler);
    }
    redirectUri = `http://127.0.0.1:${server.port}${MCP_OAUTH_CALLBACK_PATH}`;

    // `oauth.authServerMetadataUrl`: the out-of-band discovery seed `discoveryState` exists for. The MCP
    // client then skips RFC 8414 discovery and uses this document.
    if (oauth.authServerMetadataUrl !== undefined) {
      try {
        const metadata = await fetchAuthorizationServerMetadataDocument(oauth.authServerMetadataUrl, fetchFn);
        discovery = { authorizationServerUrl: metadata.issuer, authorizationServerMetadata: metadata };
      } catch (err) {
        if (err instanceof McpOAuthError && (err.code === "metadata_issuer_mismatch" || err.code === "policy_refused")) throw err;
        throw new McpOAuthError("login_failed", `the configured authorization server metadata (oauth.authServerMetadataUrl) could not be read: ${boundedReason(err)}`);
      }
      checkpoint();
    }

    requestedScope = computeScopeUnion(oauth.scopes !== undefined && oauth.scopes.length > 0 ? oauth.scopes.join(" ") : undefined, existingClient?.stepUpScope);
    const existing = existingClient;

    const clientRecordFor = (info: StoredOAuthClientInformation, issuer: string): McpOAuthClientRecord => {
      const via: McpOAuthClientRecord["registeredVia"] = oauth.clientId !== undefined && info.client_id === oauth.clientId ? "preregistered" : info.client_id === clientMetadataUrl ? "cimd" : "dcr";
      const secret = via === "preregistered" ? preSecret : (info as { client_secret?: string }).client_secret;
      const stepUpScope = existing !== null && existing.issuer === issuer ? existing.stepUpScope : undefined;
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

    recordFor = clientRecordFor;
    const clientInformation = (ctx?: OAuthClientInformationContext): StoredOAuthClientInformation | undefined => {
      if (clientDecision !== undefined) return clientDecision;
      if (oauth.clientId !== undefined) {
        // Fix round 2 (I-A): a secret goes ONLY to the issuer it is bound to -- its item's own (set by the
        // host, or stamped on the first successful sign-in), else an existing pre-registered
        // registration's. Checked HERE, where the MCP client asks with the discovered issuer and before
        // anything is saved or sent: a config source that redeclares the server with its own
        // `authServerMetadataUrl` must not get the user's secret posted to its token endpoint.
        if (preSecretItem !== undefined) {
          const bound = preSecretItem.issuer ?? (existing?.registeredVia === "preregistered" ? existing.issuer : undefined);
          if (ctx === undefined || (bound !== undefined && !sameIssuer(bound, ctx.issuer))) {
            throw new McpOAuthError(
              "client_secret_issuer_mismatch",
              `the pre-registered client secret for this server belongs to ${bound !== undefined ? originOf(bound) : "another authorization server"}, but this sign-in's authorization server is ${ctx !== undefined ? originOf(ctx.issuer) : "unknown"}; it is not sent`,
            );
          }
        }
        // Pre-registered first (spec §1.4), stamped with its issuer (SEP-2352) so the MCP client neither logs
        // a "no issuer stamp" line nor re-stamps it.
        const stamp = ctx?.issuer;
        return { client_id: oauth.clientId, ...(preSecret !== undefined ? { client_secret: preSecret } : {}), ...(stamp !== undefined ? { issuer: stamp } : {}) };
      }
      if (forgetExisting || existing === null || ctx === undefined || existing.issuer !== ctx.issuer) return undefined;
      if (existing.registeredVia === "dcr" && reuseRegistration && existing.redirectUri === redirectUri) {
        return { client_id: existing.clientId, ...(existing.clientSecret !== undefined ? { client_secret: existing.clientSecret } : {}), issuer: existing.issuer };
      }
      if (existing.registeredVia === "cimd" && existing.clientId === clientMetadataUrl) {
        return { client_id: existing.clientId, issuer: existing.issuer };
      }
      return undefined;
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
      clientInformation(ctx?: OAuthClientInformationContext) {
        const info = clientInformation(ctx);
        if (info !== undefined) lastClientInfo = info;
        return info;
      },
      async saveClientInformation(info: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext) {
        clientDecision = info;
        lastClientInfo = info;
        const issuer = info.issuer ?? ctx?.issuer;
        if (issuer === undefined) return;
        // PERSISTED NOW, not on success: a DCR registration the user then abandons is still the one to reuse.
        await writeClientRecord(opts.store, clientAccount, clientRecordFor(info, issuer));
      },
      tokens: () => undefined,
      // Leg 1 never redeems a code (the exchange is `exchangeAuthorization`, below), so nothing arrives here.
      saveTokens: () => {
        throw new McpOAuthError("login_failed", "the sign-in's first leg does not receive tokens");
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
        }
        if (scope === "all" || scope === "discovery") discovery = oauth.authServerMetadataUrl !== undefined ? discovery : undefined;
        if (scope === "all" || scope === "verifier") codeVerifier = undefined;
      },
    };

    // --- Leg 1: discovery, registration, the authorize URL. --------------------------------------------
    let result: string;
    try {
      result = await auth(provider, { serverUrl: opts.serverUrl, ...(requestedScope !== undefined ? { scope: requestedScope } : {}), fetchFn });
    } catch (err) {
      if (err instanceof McpOAuthError) throw err;
      // Codes, or a bounded, control-free message (fix round 1 M6): no token exists yet on this leg, but a
      // discovery or registration error may still quote a server's unbounded text.
      throw new McpOAuthError("login_failed", `the sign-in could not start: ${boundedReason(err)}`);
    }
    checkpoint();
    if (result !== "REDIRECT" || authUrl === undefined) throw new McpOAuthError("login_failed", "the authorization server did not produce an authorization URL");
    const verdict = evaluateMcpAuthUrl(authUrl, { allowLoopback });
    if (!verdict.ok) throw new McpOAuthError("policy_refused", `the authorization URL is refused: ${verdict.reason}`);
  } catch (err) {
    server?.stop(true);
    release();
    throw err;
  }

  const liveServer = server!;
  const authorizeUrl = authUrl!;
  const metadata = discovery?.authorizationServerMetadata;
  const authorizationServerUrl = discovery?.authorizationServerUrl !== undefined ? String(discovery.authorizationServerUrl) : new URL("/", opts.serverUrl).toString();
  const issuer = metadata?.issuer ?? authorizationServerUrl;
  const issuerOrigin = new URL(issuer).origin;
  // The RFC 8707 indicator leg 1 put on the authorize request: the protected-resource metadata's own
  // string, verbatim (auth() sends it that way), and the token request must name the same one.
  const resource = discovery?.resourceMetadata?.resource;
  const client = clientDecision ?? lastClientInfo;
  const usedDcrRegistration = client !== undefined && oauth.clientId === undefined && client.client_id !== clientMetadataUrl;

  // --- Leg 2: the callback. ---------------------------------------------------------------------------
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
    release();
    // The listener's lifetime is the flow's. A GRACEFUL stop: the listening socket closes now (a
    // superseding sign-in can bind the same port at once), while the response that ended the flow --
    // this may be running inside the callback's own handler -- is still delivered to the browser.
    void liveServer.stop();
    settle(outcome);
  };
  const timer = setTimeout(() => finish({ ok: false, reason: "login_timeout" }), timeoutMs);
  timer.unref?.();
  finishLive = finish;

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
    if (client === undefined || codeVerifier === undefined) {
      finish({ ok: false, reason: "token_exchange_failed:login_failed" });
      return page("Sign-in failed", 400);
    }
    redeeming = true;
    try {
      const iss = params.get("iss");
      // ONCE, never retried: the code is single-use (see the header).
      const tokens = await exchangeAuthorization(authorizationServerUrl, {
        ...(metadata !== undefined ? { metadata } : {}),
        clientInformation: client,
        authorizationCode: code,
        ...(iss !== null ? { iss } : {}),
        codeVerifier,
        redirectUri,
        ...(resource !== undefined ? { resource } : {}),
        fetchFn,
      });
      // Fix round 1 M2: a flow that ended meanwhile (timed out, cancelled, superseded) writes nothing.
      if (finished) return page("This sign-in has already finished", 410);
      const previous = await readTokenRecordLenient(opts.store, account).catch(() => null);
      if (finished) return page("This sign-in has already finished", 410);
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
      // The registration this sign-in actually used, persisted on success: a pre-registered client arrives
      // already issuer-stamped (above), so the MCP client never saves it itself -- and a refresh needs it.
      if (recordFor !== undefined) await writeClientRecord(opts.store, clientAccount, recordFor(client, issuer));
      if (finished) return page("This sign-in has already finished", 410);
      // TRUST ON FIRST USE (fix round 2, I-A): an unbound secret is bound now to the issuer that just
      // accepted it. Only in `store` -- a host that reads the secret elsewhere (`readClientSecret`) binds it
      // there itself (`encodeMcpOAuthClientSecretItem(secret, expectedIssuer)`); the client record written
      // above already binds this server's registration either way.
      if (preSecretItem !== undefined && preSecretItem.issuer === undefined && opts.readClientSecret === undefined) {
        await opts.store.write(mcpOAuthClientSecretAccount(opts.serverUrl), encodeMcpOAuthClientSecretItem(preSecretItem.secret, issuer)).catch(() => {});
      }
      finish({ ok: true });
      return page("Signed in to the MCP server", 200);
    } catch (err) {
      // A DCR registration the authorization server no longer knows is cleared, so the NEXT sign-in
      // registers afresh -- never re-registered and retried here with the same code.
      if (err instanceof OAuthError && (err.code === OAuthErrorCode.InvalidClient || err.code === OAuthErrorCode.UnauthorizedClient) && usedDcrRegistration) {
        await opts.store.remove(clientAccount).catch(() => {});
      }
      finish({ ok: false, reason: `token_exchange_failed:${reasonOf(err)}` });
      return page("Sign-in failed", 400);
    }
  };

  return {
    authUrl: authorizeUrl.toString(),
    issuer,
    issuerOrigin,
    authorizeOrigin: authorizeUrl.origin,
    done,
    cancel: () => finish({ ok: false, reason: "login_cancelled" }),
  };
}

/** Test seam: how many sign-in flows are waiting for a callback. */
export function activeMcpOAuthLoginCount(): number {
  return activeFlows.size;
}
