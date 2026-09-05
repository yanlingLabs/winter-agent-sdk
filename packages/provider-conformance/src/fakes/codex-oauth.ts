// Lane A's codex-oauth fake: the ChatGPT Codex backend's `/responses`, plus the OAuth token
// endpoint the refresh and login flows talk to.
//
// The Responses wire is the family's own, so the SSE scripting is `openai-responses.ts`'s. What is
// codex-specific and therefore lives here: the backend path shape, a token endpoint that can be
// scripted to succeed or fail, an id token whose payload carries a ChatGPT account id, and a 401
// that flips to 200 once a REFRESHED bearer arrives.
//
// WHY THIS FAKE READS THE RAW REQUEST. The base's request log redacts credential headers by design
// (`Bearer ***`), which is right for evidence a failing assertion prints — and useless for the one
// assertion that matters here. A fixture that only counts requests cannot tell a token refresh from
// a plain retry; the difference is that the second request carries a DIFFERENT bearer. So the routes
// below read `req.headers` directly and record the observed tokens in their own array, which is the
// only place in this package a credential value is retained, deliberately, for exactly that proof.
//
// EVERY TOKEN HERE IS FAKE AND LOOKS IT (`test-token-…`).

import { jsonResponse, startFake, type FakeRoute, type FakeServer, type RecordedRequest, type ScenarioResponder } from "./server.ts";
import { responsesModelOf } from "./openai-responses.ts";

export const FAKE_ACCOUNT_ID = "acct-test-0001";
export const FAKE_ACCESS_TOKEN = "test-token-codex-access";
export const FAKE_REFRESHED_ACCESS_TOKEN = "test-token-codex-access-refreshed";
export const FAKE_REFRESH_TOKEN = "test-token-codex-refresh";

/** base64url without padding — the JWT segment encoding. */
function b64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * An id token carrying a ChatGPT account id.
 *
 * UNSIGNED (`alg: "none"`), and that is honest rather than lazy: the adapter reads this claim as a
 * LOCATOR — a Keychain account name and a request header — never as an authorization decision, and
 * a fake that signed it would imply a verification step that does not exist.
 */
export function fakeIdToken(accountId: string = FAKE_ACCOUNT_ID): string {
  const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ sub: "user-test", "https://api.openai.com/auth": { chatgpt_account_id: accountId } }));
  return `${header}.${payload}.`;
}

export interface CodexTokenEndpointOptions {
  /** Answer every exchange with this status instead of 200. */
  failWith?: number;
  accountId?: string;
  accessToken?: string;
  /** Omit the id token, which is what a real REFRESH grant usually does. */
  omitIdToken?: boolean;
  /** Omit the refresh token — a refresh grant that does not rotate it. */
  omitRefreshToken?: boolean;
  expiresIn?: number;
}

/** The `/oauth/token` route, serving both the authorization-code exchange and the refresh grant. */
export function codexTokenRoute(opts: CodexTokenEndpointOptions = {}): FakeRoute {
  return {
    path: "/oauth/token",
    method: "POST",
    handler: (_req, recorded) => {
      if (opts.failWith !== undefined) return jsonResponse({ error: "invalid_grant", error_description: "the fake refused this grant" }, opts.failWith);
      const form = new URLSearchParams(recorded.body);
      const isRefresh = form.get("grant_type") === "refresh_token";
      return jsonResponse({
        access_token: opts.accessToken ?? (isRefresh ? FAKE_REFRESHED_ACCESS_TOKEN : FAKE_ACCESS_TOKEN),
        ...(opts.omitRefreshToken === true ? {} : { refresh_token: FAKE_REFRESH_TOKEN }),
        ...(opts.omitIdToken === true ? {} : { id_token: fakeIdToken(opts.accountId ?? FAKE_ACCOUNT_ID) }),
        expires_in: opts.expiresIn ?? 3600,
        token_type: "Bearer",
      });
    },
  };
}

/** A codex fake, plus the bearers its `/responses` route actually saw — in order. */
export interface CodexFakeServer extends FakeServer {
  bearers: string[];
}

export interface CodexFakeOptions {
  /** modelId -> scripted answer, keyed exactly as the shared `scenarioTable` would. */
  scenarios: Record<string, ScenarioResponder | Response[]>;
  /** Model ids whose FIRST request must be answered 401 — the refresh probe. A later request carrying a different bearer is served the scenario. */
  requireRefreshFor?: string[];
  token?: CodexTokenEndpointOptions;
  routes?: FakeRoute[];
  unknownModel?: ScenarioResponder;
}

/**
 * Starts a codex backend fake.
 *
 * Both path spellings are served: `/responses` (a base URL pointing straight at the fake) and
 * `/backend-api/codex/responses` (a base URL mirroring the real backend's own path).
 */
export async function startCodexFake(opts: CodexFakeOptions): Promise<CodexFakeServer> {
  const bearers: string[] = [];
  const attempts = new Map<string, number>();
  const needsRefresh = new Set(opts.requireRefreshFor ?? []);

  const handler = (req: Request, recorded: RecordedRequest): Response | Promise<Response> => {
    const authorization = req.headers.get("authorization") ?? "";
    bearers.push(authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : authorization);
    const model = responsesModelOf(recorded);
    const key = model ?? "";
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    if (model !== undefined && needsRefresh.has(model) && attempt === 1) {
      return jsonResponse({ error: { message: "your credential is no longer valid", type: "invalid_request_error", code: "invalid_api_key" } }, 401);
    }
    const entry = model !== undefined ? opts.scenarios[model] : undefined;
    if (entry === undefined) {
      if (opts.unknownModel !== undefined) return opts.unknownModel(recorded, attempt);
      return jsonResponse({ error: { message: `fake: no scenario for model ${JSON.stringify(model)}` } }, 400);
    }
    if (Array.isArray(entry)) {
      // A Response is single-use, so the list is indexed by the ATTEMPT that will actually be served
      // (the refused 401 does not consume one), and the last entry repeats.
      const served = needsRefresh.has(key) ? attempt - 2 : attempt - 1;
      return entry[Math.min(Math.max(0, served), entry.length - 1)]!;
    }
    return entry(recorded, attempt);
  };

  const fake = await startFake({
    routes: [
      { path: "/responses", method: "POST", handler },
      { path: "/backend-api/codex/responses", method: "POST", handler },
      codexTokenRoute(opts.token ?? {}),
      ...(opts.routes ?? []),
    ],
  });
  return Object.assign(fake, { bearers });
}
