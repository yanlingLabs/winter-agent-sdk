// D20: the Anthropic Console OAuth login, and the constants it runs on.
//
// This is a CREDENTIAL LIFECYCLE, not a second adapter. Unlike `codex-oauth.ts` — which is its own
// adapter because its rate limit is a subscription state and its backend path differs — an Anthropic
// Console token speaks the ordinary Messages dialect to the ordinary endpoint. So the `anthropic`
// row simply gains a second `authKind` and `messages.ts` gains an arm; nothing here duplicates a
// wire mapping.
//
// EVERY CONSTANT BELOW WAS DERIVED, NOT REMEMBERED. `packages/conformance/compat/anthropic/0.3.250/
// derived-shapes-p6b.md` records the two-artifact checksum chain, the byte offset each value came
// from, and — as importantly — everything in that artifact's OAuth surface that Winter refuses.
// `console-oauth.test.ts` asserts `CONSOLE_OAUTH` against that capture's typed table, so a value
// edited here without re-deriving it fails a test rather than shipping.
//
// FOUR RULES THIS FILE OBEYS, each one a decision rather than an implementation detail:
//
//   THE CONSOLE HOST, NEVER THE CONSUMER ONE. The pinned artifact carries two authorize hosts. D20
//     is the Console (developer platform) one; the claude.ai subscription login is not a Winter
//     provider at all (D13/D14) and its host appears in no constant here.
//
//   THE SCOPE IS THE ADMISSIBLE SUBSET. The artifact's default request is the union of two larger
//     lists, carrying the vendor application's own entitlements and an API-key-minting scope whose
//     only consumer is a `claude_cli`-scoped endpoint. D21 excludes both classes, so Winter asks for
//     `user:inference user:profile` and nothing else — the minimum that can run a turn and name its
//     own record.
//
//   THE LOGIN IS HOST-INVOKED. `startAnthropicConsoleLogin(store, { openUrl })` is called by a host,
//     never by a turn. A turn that finds no credential refuses and says what to run; a library that
//     opened a browser on its own initiative would be taking a UI action.
//
//   TOKENS LIVE UNDER `anthropic:<accountId>` (R6-10), written through the injected
//     `CredentialStore`. This file never touches `Bun.secrets` and cannot: the Keychain-backed store
//     is deliberately a runtime-side deliverable.

import type { CredentialMaterial, CredentialRef, CredentialStore } from "../../types.ts";
import { createEndpointPolicy } from "../../endpoint-policy.ts";
import { ProviderRequestError, boundedFetch } from "../../http.ts";
import { winterUserAgent } from "../../identity.ts";
import { runLoginFlow, type OAuthTokens } from "../openai/pkce.ts";

/**
 * The Console OAuth constants, derived from `@anthropic-ai/claude-agent-sdk@0.3.250`.
 *
 * Pinned field-by-field against `compat/anthropic/0.3.250/derived-p6b.ts`. Note what is NOT here:
 * the consumer authorize host, the consumer origin, the two `claude_cli`-scoped endpoints, and the
 * vendor's own product beta. A constant that exists is a constant something can come to use, so the
 * excluded ones live only in the capture document, as a record of the exclusion.
 */
export const CONSOLE_OAUTH = {
  /** A PUBLIC PKCE client id from a public npm artifact — there is no client secret, and none is sent. */
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://platform.claude.com/oauth/authorize",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  /** The account id is NOT in the token response; it is read from here, as `account.uuid`. */
  profileUrl: "https://api.anthropic.com/api/oauth/profile",
  scope: "user:inference user:profile",
  /**
   * `0` — an ephemeral port, and the DERIVED value rather than a test convenience. This client's
   * registration accepts a loopback URI on any port; codex's fixed 1455/1457 pair is the opposite
   * case, and copying that shape here would bind a port for no reason and fight a concurrent login.
   */
  callbackPort: 0,
  callbackPath: "/callback",
  /** The `anthropic-beta` value that accompanies an OAuth bearer on every request. */
  betaHeader: "oauth-2025-04-20",
} as const;

/** How long before expiry a token is renewed rather than used. One minute of slack over a turn that may take seconds to start. */
export const OAUTH_REFRESH_WINDOW_MS = 60_000;

/**
 * The ONE provider id whose `oauth` credential is an Anthropic Console one.
 *
 * NOT A FORMALITY, and the reason it is a named constant rather than a string literal in a
 * condition: R6b-5 makes this adapter MULTI-PROVIDER — a third party that speaks the Anthropic
 * Messages dialect ships as its own `<id>-anthropic` row on this same `adapterId`, with its own
 * `defaultEndpoints.api`. Nothing upstream of the adapter checks that a stored credential's KIND
 * matches its row's `authKinds`, so without this gate an `oauth` credential stored against a sibling
 * row would have its REFRESH TOKEN posted to `platform.claude.com` — a third party's credential sent
 * to Anthropic — and would stamp Anthropic's beta on that third party's request. Both are the same
 * mistake the `bearer` arm already refuses to make, with a considerably worse failure.
 */
export const ANTHROPIC_CONSOLE_PROVIDER_ID = "anthropic";

/**
 * The ONE spelling of an Anthropic OAuth record's name (R6-10).
 *
 * Exported and used by both the login and the adapter, because a host that assembles
 * `anthropic:<id>` by hand will eventually assemble it differently from whatever reads it — a
 * credential written to a key nothing looks up, failing as "no credential configured" with the
 * record sitting right there.
 */
export function anthropicCredentialRef(accountId: string, service?: string): Extract<CredentialRef, { kind: "keychain" }> {
  return { kind: "keychain", account: `anthropic:${accountId}`, ...(service !== undefined ? { service } : {}) };
}

export interface AnthropicConsoleLoginOptions {
  /** Opens the browser. HOST-supplied: the SDK never shells out to one itself. */
  openUrl: (url: string) => Promise<void>;
  /** Overridden by a fixture; production uses `CONSOLE_OAUTH`'s own values. */
  authorizeUrl?: string;
  tokenUrl?: string;
  profileUrl?: string;
  callbackPort?: number;
  timeoutMs?: number;
  /** The Keychain service the record lands in — `config.keychainService` from the host. */
  service?: string;
  onAuthStatus?: (status: { isAuthenticating: boolean; output?: string[]; error?: string }) => void;
}

export interface AnthropicConsoleLoginResult {
  ref: Extract<CredentialRef, { kind: "keychain" }>;
  accountId: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/**
 * The host-invoked Console login. Runs the PKCE loopback flow, asks who signed in, and PERSISTS the
 * result through the credential store — returning the ref a session should then be configured with.
 *
 * WHY THERE IS A SECOND REQUEST. The token response carries no account of any kind (the capture's
 * §2.3), so unlike codex — where the id token's own claim names the record — the account id has to
 * be fetched. `GET /api/oauth/profile` under the new bearer is what the pinned artifact itself does,
 * and `user:profile` is in the scope precisely to authorise it.
 *
 * A LOGIN THAT CANNOT NAME ITS RECORD IS A REFUSAL, not a fallback to some default slot: R6-10 is
 * explicit that a credential occupies one record per provider/account, and `anthropic:undefined`
 * would be a shared global slot wearing a per-account name.
 */
export async function startAnthropicConsoleLogin(store: CredentialStore, options: AnthropicConsoleLoginOptions): Promise<AnthropicConsoleLoginResult> {
  const tokens = await runLoginFlow({
    clientId: CONSOLE_OAUTH.clientId,
    authorizeUrl: options.authorizeUrl ?? CONSOLE_OAUTH.authorizeUrl,
    tokenUrl: options.tokenUrl ?? CONSOLE_OAUTH.tokenUrl,
    callbackPort: options.callbackPort ?? CONSOLE_OAUTH.callbackPort,
    callbackPath: CONSOLE_OAUTH.callbackPath,
    label: "Anthropic Console",
    scope: CONSOLE_OAUTH.scope,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    openUrl: options.openUrl,
    ...(options.onAuthStatus !== undefined ? { onAuthStatus: options.onAuthStatus } : {}),
  });

  const accountId = await fetchAccountId(options.profileUrl ?? CONSOLE_OAUTH.profileUrl, tokens.accessToken);
  if (accountId === undefined) {
    throw new ProviderRequestError({
      code: "capability",
      message: "the Anthropic Console sign-in completed but the profile lookup reported no account id, so the credential has no per-account record to occupy (R6-10)",
      retryable: false,
    });
  }

  const ref = anthropicCredentialRef(accountId, options.service);
  await store.set(ref, materialFor(tokens, accountId));
  return { ref, accountId, expiresAt: tokens.expiresAt };
}

/**
 * Reads `account.uuid` from the profile endpoint.
 *
 * Through `boundedFetch` under an endpoint policy built from the profile URL's own origin, for the
 * same reason the token exchange is: `redirect: "manual"` plus origin re-validation is what stops a
 * `Location` header from replaying a freshly minted bearer to another host.
 *
 * Returns `undefined` rather than throwing for a well-formed response with no account, so the caller
 * produces ONE refusal message about the record it cannot name. A transport or status failure IS a
 * throw — those are different problems and deserve to read differently.
 */
async function fetchAccountId(profileUrl: string, accessToken: string): Promise<string | undefined> {
  const built = createEndpointPolicy(new URL(profileUrl).origin, { generated: true });
  if (!built.ok) throw new ProviderRequestError({ code: "capability", message: built.reason, retryable: false });
  const response = await boundedFetch(profileUrl, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      // NO `anthropic-beta` HERE, deliberately. The artifact's own profile fetch sends only an
      // `Authorization`, a content type and a cache directive (the capture's §2.4) -- adding the
      // beta because "it is an OAuth request too" would be exactly the remembering this lane's
      // constants rule exists to prevent. The beta is derived for the API request, and it is sent
      // there and nowhere else.
      // WS-13b: Winter names itself on every vendor request, this one included.
      "user-agent": winterUserAgent(),
    },
    policy: built.policy,
    maxBodyBytes: 512 * 1024,
    timeoutMs: 30_000,
  });
  if (!response.ok) {
    // Drained, never echoed — same rule as the token endpoint: a failure body may quote the bearer
    // it rejected.
    await response.text().catch(() => "");
    throw new ProviderRequestError({
      code: response.status === 401 || response.status === 403 ? "auth" : "server",
      message: `the Anthropic Console profile lookup failed: HTTP ${response.status}`,
      status: response.status,
      retryable: response.status >= 500,
    });
  }
  let payload: { account?: { uuid?: unknown } };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    throw new ProviderRequestError({ code: "server", message: "the Anthropic Console profile lookup returned a body that is not JSON", retryable: false });
  }
  const uuid = payload.account?.uuid;
  return typeof uuid === "string" && uuid.length > 0 ? uuid : undefined;
}

function materialFor(tokens: OAuthTokens, accountId: string): Extract<CredentialMaterial, { kind: "oauth" }> {
  return {
    kind: "oauth",
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
    accountId,
    expiresAt: tokens.expiresAt,
  };
}
