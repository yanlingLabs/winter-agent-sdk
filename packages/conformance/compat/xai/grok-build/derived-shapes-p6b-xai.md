# Derived shapes — xAI OAuth device grant (P6.5 lane O, WS-13b §4)

**What this file is.** The record of a capture step. Every constant Winter's `xai-oauth` adapter
ships was READ OUT OF a pinned public artifact and written down here, with the file and line it came
from, so a reviewer can re-derive it without trusting anyone's memory. WS-13b's rule is that these
values are never typed from recollection; this document is what makes that rule checkable.

**Constants and request shapes only.** No source code is copied from the artifact, and no vendor
prose is quoted. Every description below is a restatement in Winter's own words.

---

## 1. The pinned artifacts

| # | artifact | pin |
|---|---|---|
| A1 | `github.com/xai-org/grok-build` — xAI's own coding-agent client, open-sourced under Apache-2.0 | commit **`72a61251fcffb464bcc687aeb5a998e5a98ec0c9`** (`main` at capture time; committed 2026-09-01T22:20:33Z) |
| A2 | `https://auth.x.ai/.well-known/openid-configuration` — the authorization server's own discovery document | fetched 2026-09-06, HTTP 200, unauthenticated |
| A3 | `https://docs.x.ai/docs/models` — xAI's published model/pricing page | fetched 2026-09-06, HTTP 200 |

A1's licence is Apache-2.0 (`LICENSE`, 204 lines, "Copyright 2023-2026 SpaceXAI"); the repository
also ships `THIRD-PARTY-NOTICES`. The attribution required by Apache-2.0 §4 is recorded in the
repository-root `NOTICE`. **Winter copies no code from A1** — only the constants and request shapes
below, which are facts about a wire protocol rather than expression.

The audit (`docs/research/Provider-third-party-access-audit.md` §2.5) cites A1 by its `main` blob
URL and states no sha; resolving `main` to `72a6125…` at capture time IS the pin, and that sha is
what this document and the `NOTICE` record.

---

## 2. Client constants

| constant | value | provenance in A1 |
|---|---|---|
| client id | `b1a00492-073a-47ea-816f-4c329264a828` | `crates/codegen/xai-grok-shell/src/auth/config.rs:250` |
| issuer | `https://auth.x.ai` | `config.rs:122` (`XAI_OAUTH2_ISSUER`) |
| identity field name | **`referrer`** | `config.rs:118-120` (the field on the client's OAuth2 config), `config.rs:150` (its default value) |
| identity value the vendor's own client sends | `grok-build` | `config.rs:150`; also hard-coded at `auth/device_code.rs:145` |
| scope set (10, space-joined) | `openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write` | `config.rs:14-27`, frozen by the client's own contract test at `config.rs:426-446` |
| device authorization endpoint | `https://auth.x.ai/oauth2/device/code` | built as `{issuer}/oauth2/device/code` at `auth/device_code.rs:132`; **independently confirmed** by A2's `device_authorization_endpoint` |
| token endpoint | `https://auth.x.ai/oauth2/token` | built as `{issuer}/oauth2/token` at `auth/device_code.rs:199`; **independently confirmed** by A2's `token_endpoint` |
| device grant type | `urn:ietf:params:oauth:grant-type:device_code` | `auth/device_code.rs:18`; confirmed in A2's `grant_types_supported` |

**The client is public / secret-less.** A2 lists `token_endpoint_auth_methods_supported` including
`none`, and A1 carries no client secret anywhere in the flow. This is the fact D21's prong 2 turns
on: a secret-less public client can be used by a third party without holding anything the vendor
issued privately.

**The client id is obfuscated in the compiled binary but published in source.** A1 wraps it in an
`obfstr!` macro at `config.rs:250`. That is a binary-hardening measure, not a secret: the literal is
in the Apache-2.0-licensed source. Recorded because it is the sort of detail a later reader would
otherwise re-litigate — Winter took the value from the published source, not from a binary.

---

## 3. Request shapes

### 3.1 Device authorization request — `POST {issuer}/oauth2/device/code`

`auth/device_code.rs:125-152`. Body is `application/x-www-form-urlencoded`:

| form field | value the vendor's client sends |
|---|---|
| `client_id` | the client id above |
| `scope` | the 10 scopes, space-joined |
| `referrer` | `grok-build` |

Response fields the client reads (`device_code.rs:74-122, 178-190`): `device_code`, `user_code`,
`verification_uri`, `verification_uri_complete` (optional), `interval` (optional, seconds, default
5), `expires_in`. Plain RFC 8628 §3.2.

### 3.2 Token poll — `POST {issuer}/oauth2/token`

`auth/device_code.rs:197-260`. Body is `application/x-www-form-urlencoded`:

| form field |
|---|
| `grant_type` = `urn:ietf:params:oauth:grant-type:device_code` |
| `device_code` |
| `client_id` |

**`referrer` is NOT sent on the poll by the vendor's client** — only on the device request (§3.1) and
on the authorization-code URL (§3.3). See §5.1 for what Winter does instead and why.

Error codes the client branches on (`device_code.rs:236-259`): `authorization_pending` (continue),
`slow_down` (widen the interval by 5 s), `access_denied` (terminal), `expired_token` (terminal),
anything else (terminal). Exactly RFC 8628 §3.5.

### 3.3 Authorization-code URL (the browser/PKCE path — recorded, NOT the path Winter takes)

`auth/oidc/protocol.rs:340-379`. Query parameters: `response_type=code`, `client_id`,
`redirect_uri`, `scope`, `code_challenge`, `code_challenge_method=S256`, `state`, `nonce`, optional
`audience`/`principal_type`/`principal_id`, and **`referrer`** (defaulting to `grok-build`, exactly
one occurrence — pinned by the client's own tests at `protocol.rs:799-806, 846-851, 888-893`).

Winter uses the **device** grant, not this one: the loopback redirect this path needs must be
registered on the OAuth application, which a client Winter did not register cannot supply.

### 3.4 Headers the vendor's client sends that **Winter must NOT send**

`device_code.rs:136-142` sets, on both the device request and every poll:

* `x-grok-client-version: <the client's own version>`
* `x-grok-client-surface: <which of the vendor's UIs is signing in>`

and `crates/codegen/xai-grok-pager/src/client_identity.rs:8-18` builds a `User-Agent` of the shape
`grok-shell/<version> (<os>; <arch>)`.

All three are the vendor product's own identity and telemetry. **WS-13 §5: client-identity headers
are never imported; Winter adapters author their own.** Winter sends
`User-Agent: winter-agent-sdk/<version>` (`provider-runtime/src/identity.ts`) and neither
`x-grok-*` header. Recorded here so the omission reads as a decision rather than an oversight.

### 3.5 `plan` — searched for, and it is not there

The audit (§2.5(2), OQ-10) reports a captured authorization URL carrying `plan=generic` alongside
`referrer=hermes-agent`. **`plan` does not appear as an OAuth parameter anywhere in A1**: an
exhaustive grep of the pinned tree finds `"plan"` only in the client's own plan-MODE UI (agent view,
slash commands, session modes). It is therefore a third-party addition, not part of the vendor
client's contract, and **Winter does not send it**.

---

## 4. The API surface an OAuth bearer is spent against

This is the constant the brief and WS-13b §2 get wrong, and A1 is unambiguous.

| endpoint | what it is | evidence in A1 |
|---|---|---|
| `https://cli-chat-proxy.grok.com/v1` | **where an OAuth/subscription bearer goes.** The default `GROK_PROXY_URL` in all four of the client's own installers | `crates/codegen/xai-grok-pager/scripts/install.sh:354`, `install-enterprise.sh:296`, `install.ps1:290`, `install-enterprise.ps1:284`; classified as an xAI API URL alongside `api.x.ai` at `crates/codegen/xai-grok-shell-base/src/util/mod.rs:351,376`; a 401 from `…/v1/responses` on this host reports `auth_kind=bearer` (`xai-grok-pager/src/app/error_display.rs:769`) |
| `https://api.x.ai/v1` | the **metered, API-key** surface. A1 reaches it directly only for voice STT, and describes it as the API-key path | `client_identity.rs:6` |

The scope `grok-cli:access` is described in A1 (`config.rs:13`) as the one that authorizes a token
for API-proxy requests — consistent with the proxy, not with the metered API.

**Decision: the `xai-oauth` row's `defaultEndpoints.api` is `https://cli-chat-proxy.grok.com/v1`.**
The task brief and WS-13b §2 both name `https://api.x.ai/v1`; the context amendment ("the capture
step may correct constants named below … `derived-shapes-p6b*.md` is the authority") governs, and
this is exactly the kind of correction it anticipated. It is not cosmetic in either direction: a
subscription bearer pointed at the metered endpoint either fails to authenticate or bills the user's
metered account for traffic their subscription already covers. The audit reached the same place
independently (§2.5(4): "Session traffic in at least one implementation goes to
`cli-chat-proxy.grok.com/v1` rather than the metered `api.x.ai/v1`"). `api.x.ai/v1` remains correct
for the SEPARATE api-key `xai` row (lane X2's), which is token-priced.

**Dialect.** The proxy serves both OpenAI-compatible routes: `/v1/chat/completions`
(`shell-base/src/util/mod.rs:351,376`) and `/v1/responses` (`error_display.rs:769`); the client's own
model catalogue selects `api_backend: "responses"` for both models (§6). Winter ships the
**chat-completions** dialect per the brief, which the proxy demonstrably serves. That the vendor's
own client prefers Responses on the same host is recorded as a live-gate question, not a defect.

---

## 5. Winter's deliberate deviations from the vendor client

Each is a deviation FROM the pinned artifact, taken on purpose, recorded so it is reviewable.

### 5.1 The identity field rides every request, not just the first

The vendor's client sends `referrer` on the device request and on the authorize URL, but not on the
token poll (§3.2). Winter's shared `runDeviceCodeFlow` sends it on the device request **and every
poll**, and Winter also passes it as an `extraFields` entry on token **refresh**.

This is a strict superset, and it is deliberate: D21 admits a vendor's public client only when it is
used with an honest originator, so a flow that named Winter once and then went quiet would be honest
exactly once. RFC 6749 §3.1/§3.2 requires servers to ignore unrecognised parameters, so the extra
occurrences cannot break a conforming endpoint. `adapters/oauth/device-code.ts`'s own header states
this rule.

### 5.2 The identity VALUE is Winter's own

`referrer=winter-agent-sdk`, never `grok-build`. This is the whole of the codex shape: the vendor's
public client id, plus an honest statement of who is actually calling. Winter never sends the
vendor's product name in this field, and never omits the field.

### 5.3 The scope set is the vendor client's, unchanged (10 scopes)

Winter requests all ten, matching A1's frozen contract test exactly, rather than the 6-scope subset
the audit quotes from a third-party implementation.

Reasoning, since this cuts against least privilege: the admission basis for this row is "the
vendor's own public product client, used as published, with an honest originator". Narrowing the
scope set is a change to that client's published contract, and A1's own frozen-scope test asserts
that the server must keep accepting exactly this set — which is a strong hint that the subscription
entitlement is bound to it. Winter cannot test a narrower set without live credentials.

**Follow-up worth running at the live gate:** Winter uses none of `conversations:read`,
`conversations:write`, `workspaces:read`, `workspaces:write` — those are the vendor client's own
server-side conversation and workspace storage, and Winter stores sessions locally. If a 6-scope
request still yields a subscription-backed token, the narrower set is strictly better for the user
and should replace this one. Recorded as a question the live gate can answer, not as a claim.

---

## 6. Models

From A1's own catalogue, `crates/codegen/xai-grok-models/default_models.json` — the model list the
subscription client actually offers:

| model | context window | default? | backend the client selects |
|---|---|---|---|
| `grok-4.6` | 500 000 | yes (`default`, and for web search / image description / session summary) | `responses` |
| `grok-4.5` | 500 000 | no | `responses` |

Both declare `supports_reasoning_effort: true`. `grok-4.6` offers four effort levels
(`xhigh`/`high`/`medium`/`low`, default `high`); `grok-4.5` offers three (`high`/`medium`/`low`,
default `high`).

A3 independently documents `grok-4.6` at a 500 000-token context window and names it the model to
use for code and chat.

**Prices are deliberately NOT recorded on these rows.** A3 lists per-token prices for the metered
API, but this row is `pricingBasis: "subscription"` — the tokens are paid for by the user's SuperGrok
or X Premium subscription, and attaching a metered price would misreport `total_cost_usd` for
traffic that is not metered (WS-13b §1; the spine's `priceUsage` returns `undefined` for a
non-`token` basis). The metered prices belong on lane X2's api-key `xai` row.

Both model rows ship `status: "candidate"`. Only the live gate promotes.

---

## 7. What this capture does NOT establish

Carried forward from audit §2.5 so the row's residual risk stays visible:

1. **xAI documents no third-party permission for this flow.** Every vendor-published artifact is a
   news post or source code. This is prong 2, not prong 1 (audit §2.5 residual 1). Unchanged by this
   capture.
2. **The identity field is now LOCATED, but its server-side treatment is still unknown.** Audit
   residual 2 said `referrer` was seen only in a captured authorization URL and not in the
   device-code path. **This capture closes half of that**: `referrer` IS on the device-code path, at
   `device_code.rs:145`, as a form field. What remains open is whether xAI *validates* it — testable
   only against the live endpoint.
3. **Server-side allowlisting is untested** (audit residual 3, OQ-10(c)). This is precisely what the
   reversion condition exists for.

> **REVERSION CONDITION (WS-13b §4).** If xAI's device or authorize endpoint rejects an honest,
> unregistered identity — i.e. `referrer=winter-agent-sdk` is refused where `referrer=grok-build`
> would be accepted — that is a partner allowlist operating in fact, and `xai-oauth` reverts to
> `impersonation-required` regardless of the announcement. Equally, if a token can only be obtained
> by omitting or falsifying the identity, the row reverts. The row therefore ships behind
> `settings.providers["xai-oauth"].enabled` (default true, restrictive-only across tiers per ruling
> R6b-9, so an operator's `false` cannot be re-enabled by a project or local tier), and the
> condition is pinned by a test named for it.

**Consent-screen disclosure.** Because the flow uses xAI's own shared client, the consent page may
name the vendor's product rather than Winter. That is structurally identical to Codex OAuth and is
not impersonation by Winter — but it is a user-facing misattribution, so hosts must say so on the
connect screen. Exported as `XAI_CONSENT_DISCLOSURE`.

---

## 8. Where these values are transcribed in code

* `packages/provider-runtime/src/adapters/openai/xai-derived-shapes.ts` — `DERIVED_XAI`, this
  document's values, one per line with its §-reference. **This file is a transcription; THIS
  DOCUMENT is the authority.**
* `packages/provider-runtime/src/adapters/openai/xai-oauth.ts` — `XAI_OAUTH`, what the adapter
  actually ships, stated as independent literals.
* The two are asserted equal by
  `packages/provider-runtime/src/adapters/openai/xai-oauth.test.ts › constants are the pinned public
  client's`. They are separate files on purpose: a constants test that reads one object and asserts
  it against itself proves nothing.
