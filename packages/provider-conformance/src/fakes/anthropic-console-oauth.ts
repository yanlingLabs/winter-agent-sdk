// Lane A2's Anthropic Console OAuth fake: the token endpoint both grants use, and the profile
// endpoint that names the credential record.
//
// THE SHAPES ARE THE CAPTURE'S, not invented. `packages/conformance/compat/anthropic/0.3.250/
// derived-shapes-p6b.md` records where each one was read out of the pinned artifact:
//
//   - the token response carries `access_token`, `refresh_token`, `expires_in` and `scope`, and
//     NO account of any kind (§2.3). A fake that returned an account here would let the login pass
//     while the production flow — which has to go and ask — silently failed;
//   - the account id comes from a SEPARATE authenticated `GET /api/oauth/profile`, as
//     `account.uuid` (§2.4);
//   - the authorize request is PKCE/S256 with the callback path `/callback` (§2.2);
//   - BOTH grants are `application/json` (§2.3), which this fake enforces rather than tolerates.
//
// THE TOKEN ROUTE FAILS CLOSED ON THE ENCODING, and that is a review finding rather than a
// nicety. It first read the body with `URLSearchParams`, which does not throw on JSON — it produces
// one meaningless key, so `grant_type` came back null, the `authorization_code` branch was SKIPPED
// ENTIRELY, and the fake answered 200 having validated no PKCE at all. A fake that accepts every
// encoding cannot prove the adapter sends the right one, and silently skipping the one check it
// exists to perform is worse than not having it.
//
// WHY THE VERIFIER IS ACTUALLY CHECKED. A fake that accepts any `code_verifier` cannot tell a
// PKCE-bound exchange from two unrelated random strings, which is the entire security property of a
// loopback flow. `completeAuthorization` records the challenge it saw in the browser-visible URL and
// the token route recomputes S256 over the verifier it was sent, so the binding is proved on the
// wire rather than asserted about the implementation.
//
// EVERY TOKEN HERE IS FAKE AND LOOKS IT (`test-token-…`), and no real account id appears anywhere.

import { jsonResponse, startFake, type FakeServer, type RecordedRequest } from "./server.ts";

export const FAKE_CONSOLE_ACCOUNT_ID = "acct-test-console-0001";
export const FAKE_CONSOLE_ACCESS_TOKEN = "test-token-anthropic-console-access";
export const FAKE_CONSOLE_REFRESHED_ACCESS_TOKEN = "test-token-anthropic-console-access-refreshed";
export const FAKE_CONSOLE_REFRESH_TOKEN = "test-token-anthropic-console-refresh";

/** base64url over raw bytes, no padding — the PKCE challenge encoding (RFC 7636 §4.2). */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface AnthropicConsoleOauthFakeOptions {
  /** Answer every grant with this status instead of 200. */
  failTokenWith?: number;
  /** The profile answers 200 with no account — the shape that must REFUSE the login, not name a record `anthropic:undefined`. */
  omitAccount?: boolean;
  /** A refresh grant that does not rotate the refresh token, which is the common case. */
  omitRefreshToken?: boolean;
  accountId?: string;
  expiresIn?: number;
}

export interface AnthropicConsoleOauthFake extends FakeServer {
  /** Handed to the login as its authorize endpoint. Never fetched — the browser half is `completeAuthorization`. */
  authorizeUrl: string;
  tokenUrl: string;
  profileUrl: string;
  /** The grants the token endpoint actually received, in order. Headers are redacted by the base fake. */
  tokenRequests: RecordedRequest[];
  profileRequests: RecordedRequest[];
  /**
   * The browser half: reads the authorize URL the flow produced, records its PKCE challenge, and
   * calls the flow's own loopback callback.
   *
   * `state` overrides the value the flow minted (a planted-callback fixture); `code: null` omits the
   * authorization code entirely.
   */
  completeAuthorization(url: string, overrides?: { state?: string; code?: string | null }): Promise<void>;
}

export async function startAnthropicConsoleOauthFake(opts: AnthropicConsoleOauthFakeOptions = {}): Promise<AnthropicConsoleOauthFake> {
  const tokenRequests: RecordedRequest[] = [];
  const profileRequests: RecordedRequest[] = [];
  const accountId = opts.accountId ?? FAKE_CONSOLE_ACCOUNT_ID;
  /** The challenges seen on authorize URLs, so the token route can prove the exchange is bound to one. */
  const challenges = new Set<string>();

  const fake = await startFake({
    routes: [
      {
        // The artifact's own token path (`TOKEN_URL`), so a fixture URL differs from production only
        // in its origin.
        path: "/v1/oauth/token",
        method: "POST",
        handler: async (_req, recorded) => {
          tokenRequests.push(recorded);
          if (opts.failTokenWith !== undefined) {
            // A rejected-grant body routinely quotes the grant it rejected — which is exactly why
            // the caller must not echo it, and why this fake puts a marker in one.
            return jsonResponse({ error: "invalid_grant", error_description: "the fake refused this grant" }, opts.failTokenWith);
          }
          // EXACTLY JSON. The content type is checked first so a form-encoded body is refused as
          // what it is, rather than as "unparseable".
          const contentType = (recorded.headers["content-type"] ?? "").split(";")[0]!.trim();
          if (contentType !== "application/json") {
            return jsonResponse({ error: "invalid_request", error_description: `this endpoint accepts application/json only, not ${JSON.stringify(contentType)}` }, 400);
          }
          let body: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(recorded.body);
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
            body = parsed as Record<string, unknown>;
          } catch {
            return jsonResponse({ error: "invalid_request", error_description: "the grant body is not a JSON object" }, 400);
          }
          const grant = body["grant_type"];
          if (grant === "authorization_code") {
            const verifier = typeof body["code_verifier"] === "string" ? body["code_verifier"] : "";
            const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
            if (!challenges.has(base64Url(new Uint8Array(digest)))) {
              return jsonResponse({ error: "invalid_grant", error_description: "PKCE verifier does not match any challenge this fake saw" }, 400);
            }
          }
          return jsonResponse({
            access_token: grant === "refresh_token" ? FAKE_CONSOLE_REFRESHED_ACCESS_TOKEN : FAKE_CONSOLE_ACCESS_TOKEN,
            ...(opts.omitRefreshToken === true ? {} : { refresh_token: FAKE_CONSOLE_REFRESH_TOKEN }),
            expires_in: opts.expiresIn ?? 3600,
            scope: "user:inference user:profile",
            token_type: "Bearer",
          });
        },
      },
      {
        path: "/api/oauth/profile",
        method: "GET",
        handler: (req, recorded) => {
          profileRequests.push(recorded);
          // The profile is an AUTHENTICATED read: a fake that served it unauthenticated would let a
          // caller that forgot the bearer pass here and fail in production.
          if ((req.headers.get("authorization") ?? "") === "") return jsonResponse({ error: "unauthorized" }, 401);
          return jsonResponse({
            ...(opts.omitAccount === true ? {} : { account: { uuid: accountId, email: "person@example.test" } }),
            organization: { uuid: "org-test-console-0001" },
          });
        },
      },
    ],
  });

  return Object.assign(fake, {
    authorizeUrl: `${fake.url}/oauth/authorize`,
    tokenUrl: `${fake.url}/v1/oauth/token`,
    profileUrl: `${fake.url}/api/oauth/profile`,
    tokenRequests,
    profileRequests,
    async completeAuthorization(url: string, overrides: { state?: string; code?: string | null } = {}): Promise<void> {
      const authorize = new URL(url);
      const challenge = authorize.searchParams.get("code_challenge");
      if (challenge !== null) challenges.add(challenge);
      const redirectUri = authorize.searchParams.get("redirect_uri");
      if (redirectUri === null) throw new Error("the authorize URL carried no redirect_uri");
      const callback = new URL(redirectUri);
      callback.searchParams.set("state", overrides.state ?? authorize.searchParams.get("state") ?? "");
      if (overrides.code !== null) callback.searchParams.set("code", overrides.code ?? "test-code-anthropic-console");
      // The callback server answers and then stops; a connection error here is the flow having
      // already torn it down, which is not this helper's failure to report.
      await fetch(callback.toString()).catch(() => undefined);
    },
  });
}
