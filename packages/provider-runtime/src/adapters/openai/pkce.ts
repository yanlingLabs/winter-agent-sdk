// PKCE + the loopback authorization-code flow, ported from Norma's
// `packages/core/src/providers/pkce.ts`.
//
// Three changes the Winter port needed, each stated because the alternative looks equivalent:
//
//   WEBCRYPTO, NOT `node:crypto`. Global Constraints forbid new runtime dependencies and prefer
//     WebCrypto/Bun built-ins; `crypto.getRandomValues` + a hand-rolled base64url is the whole of
//     what `randomBytes(...).toString("base64url")` was doing.
//
//   THE CALLBACK PORT IS FIXED, WITH ONE DECLARED FALLBACK. The authorize request's `redirect_uri`
//     has to match what the OAuth application registered, so an ephemeral port is not a valid
//     production choice — 1455 with 1457 as the fallback is codex-rs's own allow-list. A test may
//     pass `callbackPort: 0` to get an ephemeral one, which is exactly what makes this file
//     testable without touching a privileged port or a real endpoint.
//
//   PROGRESS IS OBSERVABLE. R6-B/R6-F make `auth_status` a LOGIN-FLOW progress channel (never the
//     credential-failure frame), so the flow reports its steps through `onAuthStatus` and the
//     adapter turns those into events. Nothing it reports contains credential material.
//
// NOTHING HERE LOGS A TOKEN. The `output` strings are step names; the only place material exists is
// the returned `OAuthTokens`, which goes straight into the `CredentialStore`.

import { ProviderRequestError, boundedFetch } from "../../http.ts";
import { createEndpointPolicy } from "../../endpoint-policy.ts";

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  accountId?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface LoginConfig {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** 1455 in production (codex-rs parity); `0` gives an ephemeral port, which is what a fixture uses. */
  callbackPort: number;
  /** Tried when `callbackPort` is already taken. Omitted for an ephemeral port. */
  fallbackCallbackPort?: number;
  scope: string;
  timeoutMs?: number;
  /** Opens the browser. HOST-supplied: the SDK never shells out to a browser itself. */
  openUrl: (url: string) => Promise<void>;
  onAuthStatus?: (status: { isAuthenticating: boolean; output?: string[]; error?: string }) => void;
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url over raw bytes, no padding. Hand-rolled because `btoa` needs a binary string and the padding has to go. */
export function base64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += BASE64URL_ALPHABET[a >> 2];
    out += BASE64URL_ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += BASE64URL_ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += BASE64URL_ALPHABET[c & 0x3f];
  }
  return out;
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

/** A PKCE verifier/challenge pair. 48 random bytes is 64 base64url characters — inside RFC 7636's 43-128 range. */
export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBase64Url(48);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

/**
 * Reads the ChatGPT account id out of an id token WITHOUT verifying it.
 *
 * That is safe for exactly one reason, and only that one: the value is used as a LOCATOR — the
 * Keychain account name and a request header — never as an authorization decision. The token came
 * from a TLS-authenticated token endpoint over a PKCE-bound exchange; nothing here treats a claim
 * in it as a permission.
 */
export function decodeAccountId(idToken: string): string | undefined {
  try {
    const payloadSegment = idToken.split(".")[1];
    if (payloadSegment === undefined) return undefined;
    const normalized = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"];
    if (auth === null || typeof auth !== "object") return undefined;
    const accountId = (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Posts to the token endpoint.
 *
 * Through `boundedFetch` rather than bare `fetch`, which is not a formality here: the token
 * endpoint is where a redirect would be most valuable to an attacker, and `redirect: "manual"` plus
 * the origin re-validation is exactly what stops a `Location` header from replaying the PKCE
 * verifier to another host.
 */
async function exchange(tokenUrl: string, params: Record<string, string>): Promise<OAuthTokens> {
  const built = createEndpointPolicy(new URL(tokenUrl).origin, { generated: true });
  if (!built.ok) throw new ProviderRequestError({ code: "capability", message: built.reason, retryable: false });
  const response = await boundedFetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params).toString(),
    policy: built.policy,
    maxBodyBytes: 512 * 1024,
    timeoutMs: 30_000,
  });
  if (!response.ok) {
    // The body is NOT echoed: a token-endpoint failure body routinely quotes the grant it rejected.
    await response.text().catch(() => "");
    throw new ProviderRequestError({ code: response.status === 400 || response.status === 401 ? "auth" : "server", message: `codex token exchange failed: HTTP ${response.status}`, status: response.status, retryable: response.status >= 500 });
  }
  const payload = (await response.json()) as { access_token?: unknown; refresh_token?: unknown; id_token?: unknown; expires_in?: unknown };
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    throw new ProviderRequestError({ code: "auth", message: "codex token exchange returned no access token", retryable: false });
  }
  const idToken = typeof payload.id_token === "string" ? payload.id_token : undefined;
  const accountId = idToken !== undefined ? decodeAccountId(idToken) : undefined;
  return {
    accessToken: payload.access_token,
    ...(typeof payload.refresh_token === "string" ? { refreshToken: payload.refresh_token } : {}),
    ...(idToken !== undefined ? { idToken } : {}),
    ...(accountId !== undefined ? { accountId } : {}),
    expiresAt: Date.now() + (typeof payload.expires_in === "number" ? payload.expires_in : 3600) * 1000,
  };
}

export function refreshTokens(tokenUrl: string, clientId: string, refreshToken: string): Promise<OAuthTokens> {
  return exchange(tokenUrl, { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
}

/**
 * Runs the loopback authorization-code flow.
 *
 * The callback server binds `127.0.0.1` ONLY: an authorization code is a single-use credential, and
 * a server on `0.0.0.0` would make it reachable from the LAN for as long as the login is open.
 * `state` is compared before the code is accepted, which is what makes a CSRF-planted callback fail
 * instead of completing someone else's login into this process.
 */
export async function runLoginFlow(cfg: LoginConfig): Promise<OAuthTokens> {
  const { verifier, challenge } = await generatePkce();
  const state = randomBase64Url(16);
  const report = (output: string): void => cfg.onAuthStatus?.({ isAuthenticating: true, output: [output] });

  let resolveCode!: (code: string) => void;
  let rejectFlow!: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectFlow = reject;
  });
  // Attached immediately so a rejection that fires before the `await` below is still "handled".
  codePromise.catch(() => {});

  const ports = cfg.callbackPort === 0 ? [0] : [cfg.callbackPort, ...(cfg.fallbackCallbackPort !== undefined ? [cfg.fallbackCallbackPort] : [])];
  let server: ReturnType<typeof Bun.serve> | undefined;
  let lastError: unknown;
  for (const port of ports) {
    try {
      server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname !== "/auth/callback") return new Response("not found", { status: 404 });
          if (url.searchParams.get("state") !== state) {
            rejectFlow(new Error("OAuth state mismatch — refusing to complete a login this process did not start"));
            return new Response("state mismatch", { status: 400 });
          }
          const code = url.searchParams.get("code");
          if (code === null || code.length === 0) {
            rejectFlow(new Error("the OAuth callback carried no authorization code"));
            return new Response("missing code", { status: 400 });
          }
          resolveCode(code);
          return new Response("Signed in — you can close this tab.", { headers: { "content-type": "text/plain" } });
        },
      });
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (server === undefined) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new ProviderRequestError({ code: "capability", message: `could not open the codex login callback on port ${ports.join(" or ")} — is another login in progress? (${detail})`, retryable: false });
  }

  const redirectUri = `http://localhost:${server.port}/auth/callback`;
  const authUrl = new URL(cfg.authorizeUrl);
  authUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    scope: cfg.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  const timeout = setTimeout(() => rejectFlow(new Error("the codex login timed out")), cfg.timeoutMs ?? 5 * 60_000);
  try {
    report("opening the browser for sign-in");
    cfg.openUrl(authUrl.toString()).catch((err: unknown) => rejectFlow(new Error(`could not open the browser: ${err instanceof Error ? err.message : String(err)}`)));
    const code = await codePromise;
    report("exchanging the authorization code");
    const tokens = await exchange(cfg.tokenUrl, { grant_type: "authorization_code", client_id: cfg.clientId, code, redirect_uri: redirectUri, code_verifier: verifier });
    cfg.onAuthStatus?.({ isAuthenticating: false, output: ["signed in"] });
    return tokens;
  } catch (err) {
    cfg.onAuthStatus?.({ isAuthenticating: false, error: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    clearTimeout(timeout);
    server.stop(true);
  }
}

/** The authorize URL a login would open, for a fixture that wants to drive the callback without a browser. */
export function buildAuthorizeUrl(cfg: { authorizeUrl: string; clientId: string; redirectUri: string; scope: string; state: string; challenge: string }): string {
  const url = new URL(cfg.authorizeUrl);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scope,
    state: cfg.state,
    code_challenge: cfg.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}
