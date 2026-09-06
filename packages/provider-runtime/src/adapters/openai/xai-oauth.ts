// `xai-oauth` — Grok on a SuperGrok / X Premium subscription, via Winter's OWN device login against
// xAI's public OAuth client.
//
// WHY THIS ROW EXISTS AT ALL, stated here because it is the only row in the catalog admitted on
// vendor CONDUCT rather than vendor documentation. D21 admits a vendor's public product client used
// with an honest originator — the codex shape, which the user accepted as sufficient. xAI publishes
// that client (Apache-2.0, secret-less, PKCE + device grant), announced third-party agents on this
// exact flow, and gates nothing that anyone has found. That is prong 2 of the admission rule (audit
// §2.5), and the residual risk it carries is why this row, alone, ships behind a setting.
//
// WHAT WINTER DOES NOT DO. It does not read `~/.grok/auth.json`. That file is a session the user
// granted to the vendor's product, on a consent screen Winter never showed, with no identity of ours
// anywhere in the exchange — the audit excludes it by name (the `grok-cli` id), and D21 forbids it.
// Winter performs its own device login, so the user sees a consent screen and approves THIS
// installation.
//
// THE CONSTANTS ARE DERIVED, NOT REMEMBERED. Every value below was read out of the pinned artifact
// by the capture step and is recorded, line by line, in
// `packages/conformance/compat/xai/grok-build/derived-shapes-p6b-xai.md`. `xai-derived-shapes.ts`
// transcribes that document, and `xai-oauth.test.ts` asserts the two agree. Do not edit one alone.
//
// THE ENDPOINT IS THE PROXY, NOT THE METERED API. See `XAI_OAUTH.apiBaseUrl` — this is the single
// most load-bearing correction the capture made to the plan.

import type { CredentialMaterial, CredentialRef, CredentialStore, ProviderAdapter } from "../../types.ts";
import { ProviderRequestError } from "../../http.ts";
import { runDeviceCodeFlow } from "../oauth/device-code.ts";
import type { OAuthTokens } from "./pkce.ts";
import { createChatCompletionsAdapter, type ChatTurnOptions } from "./chat-completions.ts";
import { capabilityRefusal } from "./shared.ts";

/** The registered adapter id. One provider, so it is a constant rather than an option. */
export const XAI_OAUTH_ADAPTER_ID = "winter.xai-oauth";

/**
 * The flow's constants, as SHIPPED.
 *
 * Stated as independent literals rather than read out of `DERIVED_XAI`, so that the constants test
 * compares two things instead of one thing with itself. If you change a value here, re-run the
 * capture and change `xai-derived-shapes.ts` too — the test is there to make that unavoidable.
 */
export const XAI_OAUTH = {
  /** xAI's public client. Secret-less: the authorization server advertises `none` among its token-endpoint auth methods. */
  clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  /** The vendor client's own frozen ten-scope set, unchanged (capture §5.3 records why it is not narrowed, and what the live gate should try). */
  scope: "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write",
  /** The form field this flow carries a client identity in. */
  identityField: "referrer",
  /**
   * WINTER'S OWN NAME, and the whole of what makes this row admissible rather than impersonation.
   *
   * The bare product name, not `winterUserAgent()`'s versioned token: this is an originator field
   * that a vendor's analytics buckets, the same shape as codex's `originator: "winter"`. It is never
   * the vendor's value, and it is never omitted — see the reversion condition below for what it
   * means if that turns out not to be allowed.
   */
  identityValue: "winter-agent-sdk",
  deviceCodeUrl: "https://auth.x.ai/oauth2/device/code",
  tokenUrl: "https://auth.x.ai/oauth2/token",
  /**
   * Where a subscription bearer is actually spent.
   *
   * NOT `https://api.x.ai/v1`. That is xAI's METERED, api-key surface and it belongs to the separate
   * token-priced `xai` row. This one is the proxy the vendor's own installers default to, the host
   * its 401s report `auth_kind=bearer` from, and the one the `grok-cli:access` scope is described as
   * authorizing. Pointing a subscription token at the metered endpoint either fails to authenticate
   * or bills the user for traffic their subscription already covers.
   */
  apiBaseUrl: "https://cli-chat-proxy.grok.com/v1",
} as const;

/**
 * What a host must tell the user on the connect screen, before the browser opens.
 *
 * Audit §2.5's disclosure note. Because the flow rides xAI's shared public client, the consent page
 * may name the vendor's own product rather than Winter. That is structurally identical to Codex
 * OAuth and is not impersonation by Winter — Winter names itself in the flow and on every request —
 * but it IS a user-facing misattribution, and a user who is not told will reasonably read it as one.
 * Exported rather than hard-coded into a UI so every host says the same thing.
 */
export const XAI_CONSENT_DISCLOSURE =
  "xAI's consent page may name Grok Build — the flow uses xAI's own public OAuth client, which is what xAI publishes for third-party agents. " +
  "Winter identifies itself as winter-agent-sdk in the login request and on every request it makes afterwards, and never as another product.";

/** How an xAI credential is stored: one `oauth` material under `xai-oauth:<accountId>` (R6-10, one record per provider/account). */
export function xaiCredentialRef(accountId: string, service?: string): Extract<CredentialRef, { kind: "keychain" }> {
  return { kind: "keychain", account: `xai-oauth:${accountId}`, ...(service !== undefined ? { service } : {}) };
}

export interface XaiLoginOptions {
  /** Overridden by a fixture; production uses `XAI_OAUTH`'s own values. */
  deviceCodeUrl?: string;
  tokenUrl?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** The Keychain service the record lands in — `config.keychainService` from the host. */
  service?: string;
  onAuthStatus?: (status: { isAuthenticating: boolean; output?: string[]; error?: string }) => void;
}

export interface XaiLoginResult {
  ref: Extract<CredentialRef, { kind: "keychain" }>;
  accountId: string;
  expiresAt: number;
}

/**
 * The message a human reads when the reversion condition may have fired.
 *
 * It deliberately states BOTH readings. On the wire, "the user pressed Deny" and "the vendor refuses
 * this client's identity" are the same `access_denied`, and an error that asserted only the second
 * would be lying two times out of three. What the message must guarantee is that the *possibility*
 * of an allowlist reaches a human, together with the switch that turns the row off.
 */
function reversionConditionMessage(): string {
  return (
    `the xAI device login was refused with access_denied. ` +
    `Either the person signing in declined the consent screen, or xAI rejected this client's identity (${XAI_OAUTH.identityField}=${XAI_OAUTH.identityValue}). ` +
    `If it is the second, that is the reversion condition (WS-13b §4): an honest unregistered agent identity that the vendor rejects is a partner allowlist in fact, ` +
    `and xai-oauth reverts to impersonation-required. Winter will not retry by omitting or falsifying its identity. ` +
    `Turn the row off without a release by setting providers["xai-oauth"].enabled to false in settings.`
  );
}

/**
 * The OAuth error code a device-flow failure carried, or `undefined`.
 *
 * `runDeviceCodeFlow` throws a `ProviderRequestError` whose message NAMES the vendor's error code
 * and nothing else — its own header states that contract ("a vendor error code (`access_denied`,
 * `expired_token`, …) … naming ONLY the code — never the `error_description`"). It does not put the
 * code in a field, so this reads it back off that documented shape.
 *
 * That makes this a text dependency on a spine file, which is worth naming: `adapters/oauth/**` is
 * on the phase's no-touch list, so adding a `providerCode` there was not this lane's to make. The
 * dependency is not silent, though — the reversion tests drive the REAL helper through a fake that
 * answers `access_denied`, so if that message shape ever changes, they fail rather than quietly
 * misclassifying. A `providerCode` on that throw would be strictly better and is recommended.
 */
function deviceFlowErrorCode(err: unknown): string | undefined {
  if (!(err instanceof ProviderRequestError)) return undefined;
  const match = /^the device login failed: ([a-z_]+)$/.exec(err.message);
  return match?.[1];
}

/** The standard OIDC `sub` claim from an id token — the account this login belongs to. The vendor's own client reads the same claim. */
function decodeSubject(idToken: string): string | undefined {
  try {
    const payloadSegment = idToken.split(".")[1];
    if (payloadSegment === undefined) return undefined;
    const normalized = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as Record<string, unknown>;
    const sub = payload["sub"];
    return typeof sub === "string" && sub.length > 0 ? sub : undefined;
  } catch {
    return undefined;
  }
}

function materialFor(tokens: OAuthTokens, accountId: string): Extract<CredentialMaterial, { kind: "oauth" }> {
  return {
    kind: "oauth",
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.idToken !== undefined ? { idToken: tokens.idToken } : {}),
    accountId,
    expiresAt: tokens.expiresAt,
  };
}

/**
 * The host-invoked login. Runs the device authorization grant and PERSISTS the result through the
 * credential store, returning the ref a session should be configured with.
 *
 * The identity field rides the device request and every poll (the shared helper's rule, and a
 * deliberate superset of what the vendor's own client does — capture §5.1). There is no code path
 * here that retries without it.
 */
export async function startXaiLogin(store: CredentialStore, options: XaiLoginOptions = {}): Promise<XaiLoginResult> {
  let tokens: OAuthTokens;
  try {
    tokens = await runDeviceCodeFlow({
      clientId: XAI_OAUTH.clientId,
      deviceCodeUrl: options.deviceCodeUrl ?? XAI_OAUTH.deviceCodeUrl,
      tokenUrl: options.tokenUrl ?? XAI_OAUTH.tokenUrl,
      scope: XAI_OAUTH.scope,
      identity: { field: XAI_OAUTH.identityField, value: XAI_OAUTH.identityValue },
      ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.onAuthStatus !== undefined ? { onAuthStatus: options.onAuthStatus } : {}),
    });
  } catch (err) {
    if (deviceFlowErrorCode(err) === "access_denied") {
      throw new ProviderRequestError({ code: "auth", message: reversionConditionMessage(), providerCode: "access_denied", retryable: false });
    }
    throw err;
  }

  const accountId = tokens.idToken !== undefined ? decodeSubject(tokens.idToken) : undefined;
  if (accountId === undefined) {
    throw capabilityRefusal("the xAI token exchange returned no account subject, so the credential has no per-account record to occupy (R6-10)");
  }
  const ref = xaiCredentialRef(accountId, options.service);
  await store.set(ref, materialFor(tokens, accountId));
  return { ref, accountId, expiresAt: tokens.expiresAt };
}

/**
 * `winter.xai-oauth` — the chat adapter, at xAI's subscription proxy, on an oauth bearer.
 *
 * A composition rather than a copy, and deliberately so: everything about the TURN is
 * `openai-chat-completions@1`'s, and `resolveAuth` already turns `oauth` material into
 * `Authorization: Bearer <accessToken>`. What differs is the endpoint and the id the registry
 * resolves it by, so only those two are restated. Copying the turn would have given this row its own
 * drifting version of streaming, tool-call mapping and error classification for no gain.
 */
export function createXaiOauthAdapter(options: Omit<ChatTurnOptions, "generatedBaseUrl"> & { generatedBaseUrl?: string }): ProviderAdapter {
  const base = createChatCompletionsAdapter({ ...options, generatedBaseUrl: options.generatedBaseUrl ?? XAI_OAUTH.apiBaseUrl });
  return { ...base, id: XAI_OAUTH_ADAPTER_ID };
}
