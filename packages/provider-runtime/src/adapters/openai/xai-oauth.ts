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

import type { CredentialMaterial, CredentialRef, CredentialStore, ProviderAdapter, ProviderContext, ProviderEvent, TurnRequest } from "../../types.ts";
import { ProviderRequestError } from "../../http.ts";
import { runDeviceCodeFlow } from "../oauth/device-code.ts";
import { refreshOauthMaterial } from "../oauth/refresh.ts";
import type { OAuthTokens } from "./pkce.ts";
import { createChatCompletionsAdapter, type ChatTurnOptions } from "./chat-completions.ts";
import { capabilityRefusal, errorEvent } from "./shared.ts";

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
 * THE FIELD FIRST, the text as a fallback. `runDeviceCodeFlow` now sets `providerCode` on BOTH of
 * its throws (fix-wave carry, Lane O review Important 3) — which is what makes a refusal at the
 * DEVICE step detectable at all: that throw used to report only an HTTP status, so an unregistered
 * client the vendor rejects at the door looked like a plain 4xx and never reached the reversion
 * arm. The regex stays as the fallback for a `ProviderRequestError` raised by an older path, and
 * because the message shape is the helper's documented contract; the reversion tests drive the REAL
 * helper through a fake that answers `access_denied`, so both readings are exercised.
 */
function deviceFlowErrorCode(err: unknown): string | undefined {
  if (!(err instanceof ProviderRequestError)) return undefined;
  if (err.providerCode !== undefined) return err.providerCode;
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

/** How close to expiry the stored token may get before a turn refreshes it. One minute — long enough to cover a slow turn setup, short enough not to churn. */
const REFRESH_WINDOW_MS = 60_000;

export interface XaiAdapterOptions extends Omit<ChatTurnOptions, "generatedBaseUrl" | "organization" | "project"> {
  generatedBaseUrl?: string;
  /** Overridden by a fixture; production uses `XAI_OAUTH.tokenUrl`. */
  tokenUrl?: string;
}

/**
 * Spends the refresh token BEFORE the turn, when the access token is about to expire.
 *
 * Without this the login would store a refresh token nothing ever uses and the user would be sent
 * back to a consent screen every hour — the credential would be, in practice, worse than an API key.
 * Proactive rather than codex's refresh-on-401 because that path lives inside the Responses turn
 * this adapter does not own; the shared helper does the exchange, the merge (a partial response
 * never clobbers a known-good refresh token) and the write-back.
 *
 * THE IDENTITY RIDES THE REFRESH TOO. `extraFields` puts Winter's name on the refresh form for the
 * same reason it rides every poll: an originator that is honest only at login is honest once.
 */
async function refreshIfExpiring(ctx: ProviderContext, tokenUrl: string): Promise<void> {
  // R6-10 puts tokens in one Keychain record; a non-keychain ref has nowhere durable to write back
  // to, so there is nothing useful to do here for one.
  if (ctx.authRef.kind !== "keychain") return;
  const material = await ctx.credentials.get(ctx.authRef);
  if (material === null || material.kind !== "oauth") return;
  if (material.refreshToken === undefined) return;
  if (material.expiresAt === undefined || material.expiresAt - Date.now() > REFRESH_WINDOW_MS) return;
  await refreshOauthMaterial({
    store: ctx.credentials,
    ref: ctx.authRef,
    tokenUrl,
    clientId: XAI_OAUTH.clientId,
    extraFields: { [XAI_OAUTH.identityField]: XAI_OAUTH.identityValue },
  });
}

/**
 * `winter.xai-oauth` — the chat adapter, at xAI's subscription proxy, on an oauth bearer.
 *
 * A composition rather than a copy, and deliberately so: everything about the TURN is
 * `openai-chat-completions@1`'s, and `resolveAuth` already turns `oauth` material into
 * `Authorization: Bearer <accessToken>`. What differs is the endpoint, the id the registry resolves
 * it by, and the refresh above — so only those are restated. Copying the turn would have given this
 * row its own drifting version of streaming, tool-call mapping and error classification for no gain.
 */
export function createXaiOauthAdapter(options: XaiAdapterOptions): ProviderAdapter {
  // BELT AND BRACES ON THE CROSS-VENDOR HEADER RULE (fix-wave R-FW-1 / whole-branch review I-1).
  //
  // The composed adapter's only remaining route to an `openai-*` request header is
  // `privilegedHeaders(options)`, which reads `organization`/`project` and emits
  // `OpenAI-Organization`/`OpenAI-Project`. Those are OpenAI's product headers and mean nothing at
  // xAI's proxy, so this row must not be able to send them however it is constructed. `Omit`ing them
  // from `XaiAdapterOptions` is the compile-time half; deleting them off the forwarded object is the
  // runtime half, because a caller reaching this function through a widened structural type (or from
  // untyped JS) would otherwise still get them through the spread.
  const { organization: _organization, project: _project, ...forwarded } = options as XaiAdapterOptions & { organization?: string; project?: string };
  const base = createChatCompletionsAdapter({ ...forwarded, generatedBaseUrl: options.generatedBaseUrl ?? XAI_OAUTH.apiBaseUrl });
  const tokenUrl = options.tokenUrl ?? XAI_OAUTH.tokenUrl;
  return {
    ...base,
    id: XAI_OAUTH_ADAPTER_ID,
    streamTurn(req: TurnRequest, ctx: ProviderContext): AsyncIterable<ProviderEvent> {
      return (async function* () {
        try {
          await refreshIfExpiring(ctx, tokenUrl);
        } catch (err) {
          // Surfaced as an error EVENT, the shape every other failure in this family takes — an
          // exception out of the iterator would be a second failure mode for callers to handle. The
          // helper's own error names the ref and a status, never the token.
          yield errorEvent(err);
          return;
        }
        yield* base.streamTurn(req, ctx);
      })();
    },
  };
}
