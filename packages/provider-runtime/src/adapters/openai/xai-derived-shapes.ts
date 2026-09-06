// THE CAPTURE, TRANSCRIBED. Not the adapter's configuration — see `xai-oauth.ts` for that.
//
// Every value here was read out of a pinned public artifact by the P6.5 lane O capture step and is
// recorded, with per-value line citations, in:
//
//     packages/conformance/compat/xai/grok-build/derived-shapes-p6b-xai.md
//
// THAT DOCUMENT IS THE AUTHORITY; this file is its machine-readable transcription, and it exists so
// a test can assert that what the adapter SHIPS still equals what the artifact SAID. The two are
// separate files on purpose: a constants test that reads one object and asserts it against itself
// proves nothing at all, and the failure it is meant to catch — someone editing the client id, the
// scope set or the identity field without re-deriving them — would sail straight through it.
//
// WS-13b's rule is that these are never typed from memory. If one of them is wrong, the fix is to
// re-run the capture against the pinned commit and correct BOTH files, in that order.

/** `github.com/xai-org/grok-build`, Apache-2.0, at the commit the capture pinned. Recorded in the repository-root `NOTICE`. */
export const DERIVED_XAI_COMMIT = "72a61251fcffb464bcc687aeb5a998e5a98ec0c9";

/**
 * The xAI OAuth constants as the vendor's own public client states them.
 *
 * Cross-checked, where possible, against a SECOND independent artifact: the authorization server's
 * own discovery document at `https://auth.x.ai/.well-known/openid-configuration`, which names the
 * same device-authorization and token endpoints and lists `none` among its supported token-endpoint
 * auth methods — i.e. confirms the client is public and secret-less.
 */
export const DERIVED_XAI = {
  /** capture §2 — `auth/config.rs:250`. Published in Apache-2.0 source; `obfstr!`-wrapped in the shipped binary, which is binary hardening, not a secret. */
  clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  /** capture §2 — `auth/config.rs:122`. */
  issuer: "https://auth.x.ai",
  /** capture §2 — `auth/config.rs:14-27`, frozen by the vendor client's own contract test at `config.rs:426-446`. All ten, unchanged: see capture §5.3 for why Winter does not narrow them. */
  scope: "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write",
  /** capture §2/§3.1 — `auth/config.rs:118-120,150` and `auth/device_code.rs:145`. The form field the flow carries a client identity in. */
  identityField: "referrer",
  /** capture §2 — the value the VENDOR's client sends in that field. Winter sends its own name instead (capture §5.2); this is here so a reader can see the difference the codex shape turns on. */
  vendorIdentityValue: "grok-build",
  /** capture §2/§3.1 — `auth/device_code.rs:132`, confirmed by the discovery document's `device_authorization_endpoint`. */
  deviceCodeUrl: "https://auth.x.ai/oauth2/device/code",
  /** capture §2/§3.2 — `auth/device_code.rs:199`, confirmed by the discovery document's `token_endpoint`. */
  tokenUrl: "https://auth.x.ai/oauth2/token",
  /**
   * capture §4 — where an OAuth/subscription bearer is actually spent.
   *
   * NOT `https://api.x.ai/v1`, which the task brief and WS-13b §2 both name: that is the METERED,
   * api-key surface (lane X2's separate `xai` row). This one is the proxy the vendor's own
   * installers default to and the host whose 401s report `auth_kind=bearer`. Pointing a
   * subscription token at the metered endpoint either fails to authenticate or bills a user for
   * traffic their subscription already covers.
   */
  apiBaseUrl: "https://cli-chat-proxy.grok.com/v1",
  /**
   * capture §3.4 — the vendor client's OWN identity and telemetry headers.
   *
   * Recorded so they can be asserted ABSENT. WS-13 §5: client-identity headers are never imported;
   * Winter adapters author their own. This list is a denylist for Winter's requests, never a
   * template for them.
   */
  vendorOnlyHeaders: ["x-grok-client-version", "x-grok-client-surface"],
} as const;

/**
 * The models the vendor's subscription client offers, from its own catalogue
 * (`xai-grok-models/default_models.json`) — capture §6.
 *
 * Deliberately unpriced: this row is subscription-priced, and a per-token price on it would
 * misreport cost for traffic that is not metered.
 */
export const DERIVED_XAI_MODELS = [
  { id: "grok-4.6", contextWindow: 500_000, isDefault: true },
  { id: "grok-4.5", contextWindow: 500_000, isDefault: false },
] as const;
