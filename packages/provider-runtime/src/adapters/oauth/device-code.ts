// RFC 8628, the OAuth 2.0 Device Authorization Grant — the second login shape Winter needs.
//
// The loopback authorization-code flow (`openai/pkce.ts` `runLoginFlow`) is the first, and it is not
// interchangeable with this one: it requires a `redirect_uri` the vendor's OAuth application has
// registered, which a client Winter did not register cannot supply. A device flow needs no redirect
// at all — the user carries a short code to a page the vendor names — which is exactly why vendors
// publish it as the third-party route (WS-13b §4).
//
// THE IDENTITY FIELD RIDES EVERY REQUEST, and that is a rule, not a convenience. D21 admits a
// vendor's public product client only when it is used with an HONEST originator, so a flow that
// named Winter on the device request and went quiet on the polls would be honest exactly once. It is
// a caller-supplied `{ field, value }` rather than a hard-coded name because vendors spell it
// differently (`referrer` in the captured xAI authorization URLs, `originator` on the codex
// backend); what is NOT negotiable is that it is sent, and that its value is Winter's.
//
// NOTHING HERE LOGS A TOKEN. `onAuthStatus` carries step names, the verification URL and the USER
// CODE — the code is meant to be read aloud by the person signing in, and it authorizes nothing on
// its own. The only place material exists is the returned `OAuthTokens`, which the caller puts
// straight into a `CredentialStore`.

import { createEndpointPolicy } from "../../endpoint-policy.ts";
import { ProviderRequestError, boundedFetch } from "../../http.ts";
import type { LoginConfig, OAuthTokens } from "../openai/pkce.ts";

export interface DeviceCodeConfig {
  clientId: string;
  /** Where the device/user code pair is minted (RFC 8628 §3.1). */
  deviceCodeUrl: string;
  tokenUrl: string;
  scope: string;
  /**
   * WINTER'S OWN NAME, and the form field the vendor's flow carries it in. Sent on the device
   * request AND on every poll. Never omitted, never another product's name (WS-13 §5, D21).
   */
  identity: { field: string; value: string };
  /** Floor for the poll interval. The vendor's own `interval` wins when it is larger (RFC 8628 §3.5). */
  pollIntervalMs?: number;
  /** How much `slow_down` widens the interval. RFC 8628 §3.5's own increment is 5 seconds. */
  slowDownStepMs?: number;
  /** Default 15 minutes — longer than any vendor's device code lives, so the code expires before this does. */
  timeoutMs?: number;
  onAuthStatus?: LoginConfig["onAuthStatus"];
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_SLOW_DOWN_STEP_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

interface DeviceCodeResponse {
  device_code?: unknown;
  user_code?: unknown;
  verification_uri?: unknown;
  verification_uri_complete?: unknown;
  interval?: unknown;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POSTs a form to an OAuth endpoint through `boundedFetch`.
 *
 * Through `boundedFetch` under a policy built from the URL's OWN origin, not bare `fetch`: a device
 * or token endpoint is where a redirect would be most valuable to an attacker, and `redirect:
 * "manual"` plus origin re-validation is what stops a `Location` header from replaying the grant
 * elsewhere. Returns the parsed body AND the status, because RFC 8628 puts `authorization_pending`
 * and `slow_down` in a 400 body — a status-only reading cannot tell "still waiting" from "denied".
 */
async function postForm(url: string, fields: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const built = createEndpointPolicy(new URL(url).origin, { generated: true });
  if (!built.ok) throw new ProviderRequestError({ code: "capability", message: built.reason, retryable: false });
  const response = await boundedFetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
    policy: built.policy,
    maxBodyBytes: 512 * 1024,
    timeoutMs: 30_000,
  });
  const text = await response.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: response.status, body };
}

/**
 * Runs the device authorization grant to completion and returns the tokens.
 *
 * Ends in exactly one of four ways: tokens; a vendor error code (`access_denied`,
 * `expired_token`, …) as a typed `ProviderRequestError` naming ONLY the code — never the
 * `error_description`, which routinely quotes the request; the timeout; or a malformed response.
 * There is no fifth path where it keeps polling.
 */
export async function runDeviceCodeFlow(cfg: DeviceCodeConfig): Promise<OAuthTokens> {
  const report = (...output: string[]): void => cfg.onAuthStatus?.({ isAuthenticating: true, output });
  const identityField = { [cfg.identity.field]: cfg.identity.value };

  report("requesting a device code");
  const device = await postForm(cfg.deviceCodeUrl, { client_id: cfg.clientId, scope: cfg.scope, ...identityField });
  const payload = device.body as DeviceCodeResponse;
  const deviceCode = typeof payload.device_code === "string" ? payload.device_code : undefined;
  const userCode = typeof payload.user_code === "string" ? payload.user_code : undefined;
  const verificationUri = typeof payload.verification_uri === "string" ? payload.verification_uri : undefined;
  const verificationUriComplete = typeof payload.verification_uri_complete === "string" ? payload.verification_uri_complete : undefined;
  if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
    cfg.onAuthStatus?.({ isAuthenticating: false, error: `the device authorization request returned HTTP ${device.status} without a device code, user code and verification URI` });
    throw new ProviderRequestError({ code: device.status >= 500 ? "server" : "auth", message: `the device authorization request failed: HTTP ${device.status}`, status: device.status, retryable: device.status >= 500 });
  }

  // The user code and the URL, together, are the whole of what the person signing in needs. The
  // `_complete` form is the one they can actually click, so it is reported when the vendor sends it.
  report(`open ${verificationUriComplete ?? verificationUri} and enter the code ${userCode}`);

  // RFC 8628 §3.5: the vendor's `interval` is a MINIMUM in seconds; the caller's floor applies when
  // the vendor states none. Polling faster than the vendor asked is what earns a `slow_down`.
  const vendorIntervalMs = typeof payload.interval === "number" && payload.interval >= 0 ? payload.interval * 1000 : undefined;
  let intervalMs = Math.max(vendorIntervalMs ?? 0, cfg.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const slowDownStepMs = cfg.slowDownStepMs ?? DEFAULT_SLOW_DOWN_STEP_MS;
  const deadline = Date.now() + (cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  for (;;) {
    if (Date.now() >= deadline) {
      cfg.onAuthStatus?.({ isAuthenticating: false, error: "the device login timed out" });
      throw new ProviderRequestError({ code: "auth", message: "the device login timed out before the code was approved", retryable: false });
    }
    await sleep(intervalMs);

    const poll = await postForm(cfg.tokenUrl, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: cfg.clientId,
      ...identityField,
    });
    const body = poll.body as TokenResponse;

    if (typeof body.access_token === "string" && body.access_token.length > 0) {
      cfg.onAuthStatus?.({ isAuthenticating: false, output: ["signed in"] });
      return {
        accessToken: body.access_token,
        ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
        ...(typeof body.id_token === "string" ? { idToken: body.id_token } : {}),
        expiresAt: Date.now() + (typeof body.expires_in === "number" ? body.expires_in : DEFAULT_EXPIRES_IN_SECONDS) * 1000,
      };
    }

    const error = typeof body.error === "string" ? body.error : undefined;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      intervalMs += slowDownStepMs;
      report("the vendor asked us to poll more slowly");
      continue;
    }
    // Anything else is TERMINAL. The `error_description` is deliberately not carried into the
    // message: it routinely quotes the request, and a login failure is the moment a message is most
    // likely to be pasted somewhere.
    const detail = error ?? `HTTP ${poll.status}`;
    cfg.onAuthStatus?.({ isAuthenticating: false, error: `the device login failed: ${detail}` });
    throw new ProviderRequestError({ code: poll.status >= 500 ? "server" : "auth", message: `the device login failed: ${detail}`, status: poll.status, retryable: false });
  }
}
