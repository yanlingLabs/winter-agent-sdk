# P6.5 interface facts — the Anthropic Console OAuth constants (D20), pinned 0.3.250

A plain record of the public interface facts of the Anthropic Console OAuth login: scope strings,
beta header values, authorize/token request field names, endpoints, and which response carries the
account id. These are interface facts (strings, header values, field names), recorded as names,
literals and field tables. The typed twin of §3 is `derived-p6b.ts`; the test
`the constants are the artifact's, not typed from memory` in `console-oauth.test.ts` compares
Winter's constants against it.

`scripts/check-derived-shapes.ts` reads only the `.d.ts` files of the pinned package; it does not
read this file and must not be pointed at it.

## 1. Status

> **RETIRED as a login — host-brokered per the 2026-09-13 ruling (P10a-1).** The PKCE login these
> facts once backed (`startAnthropicConsoleLogin`, `CONSOLE_OAUTH`'s `clientId`/`authorizeUrl`/
> `tokenUrl`/`profileUrl`/`callbackPort`/`callbackPath`/`extraAuthorizeParams`/`accountIdPath`/`scope`)
> was deleted from `console-oauth.ts`: the platform refused its grant for every request shape tried,
> and the user ruled that Console OAuth goes only through Anthropic's own brokers, never a
> re-implementation of the protocol. The facts below stay as a record. Only `betaHeader` still ships,
> as `CONSOLE_BEARER.betaHeader`. The broker that replaced the login lives in this SDK
> (`console-broker.ts`); its sole door is `ant auth login --profile <p>`, since `claude auth login
> --console` writes no Anthropic profile for this org (it mints an API key into the login Keychain
> instead; see `console-broker.ts`'s own banner for that measured account).

## 2. The interface facts

| field | value | Winter's use |
|---|---|---|
| Console authorize endpoint | `https://platform.claude.com/oauth/authorize` | D20's authorize endpoint |
| Token endpoint | `https://platform.claude.com/v1/oauth/token` | D20's token endpoint; serves both the authorization-code and the refresh grant |
| Client id | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` | A public PKCE client id, no client secret; admitted by D21's "the vendor's public product client with an honest Winter originator", the same basis as `codex-oauth` |
| API base | `https://api.anthropic.com` | already `ANTHROPIC_DEFAULT_BASE_URL` |
| Consumer authorize endpoint | `https://claude.com/cai/oauth/authorize` | NEVER USED (D13/D14): the consumer subscription login is not a Winter provider |
| Consumer origin | `https://claude.ai` | NEVER USED (D13/D14) |
| API-key creation endpoint | `https://api.anthropic.com/api/oauth/claude_cli/create_api_key` | NEVER CALLED: a `claude_cli`-scoped path presents as the vendor's own CLI, which D21 excludes |
| Roles endpoint | `https://api.anthropic.com/api/oauth/claude_cli/roles` | NEVER CALLED, same reason |
| Manual redirect URL | `https://platform.claude.com/oauth/code/callback` | not used; Winter runs the loopback arm |
| Success pages | vendor pages carrying `app=claude-code` | NEVER USED: they name the vendor's product |
| MCP proxy | `https://mcp-proxy.anthropic.com`, path `/v1/mcp/{server_id}` | out of scope for D20 |

### 2.1 Scope strings

| scope | note |
|---|---|
| `user:inference` | the scope a token needs to run a turn |
| `user:profile` | authorises the account lookup in §2.4 |
| `org:create_api_key` | mints an API key; only the excluded `claude_cli` endpoint uses it |
| `user:sessions:claude_code`, `user:mcp_servers`, `user:file_upload` | entitlements of the vendor's own application |
| `user:design:read`, `user:design:write`, `user:projects:read`, `user:projects:write`, `user:plugins` | further vendor-application scopes |

The vendor's default request is the union of `org:create_api_key`, `user:profile`,
`user:sessions:claude_code`, `user:mcp_servers`, `user:file_upload` and `user:inference`. It is not
available to Winter: it carries the vendor application's own entitlements and the API-key-minting
scope, which D21 excludes by name.

**What Winter requests is `user:inference user:profile`**, space-joined: `user:inference` is the
scope a turn needs, and `user:profile` authorises the account lookup that names the credential
record. Neither is specific to the vendor's application. `org:create_api_key` is deliberately absent:
Winter never mints an API key through this flow.

### 2.2 The authorize request

Query parameters, in order:

| parameter | value |
|---|---|
| `code` | `true` |
| `client_id` | the client id above |
| `response_type` | `code` |
| `redirect_uri` | the manual redirect URL in the manual arm; otherwise `http://localhost:<port>/callback` |
| `scope` | the requested scopes, SPACE-joined |
| `code_challenge` | the PKCE challenge |
| `code_challenge_method` | `S256` |
| `state` | the flow's nonce |
| `orgUUID`, `login_hint`, `login_method` | optional, omitted when absent |

Findings that shape the implementation:

1. **The loopback port is a variable, not a registered constant.** The redirect is
   `http://localhost:<port>/callback` with the port chosen by the caller. This client's registration
   accepts a loopback URI on any port (RFC 8252 §7.3), so Winter's `callbackPort` is `0`, an
   ephemeral port. (Codex differs: its fixed 1455/1457 pair exists because its registration is fixed.)
2. **The callback path is `/callback`**, not `pkce.ts`'s built-in `/auth/callback`.
3. `code=true` is a query parameter of the authorize request.

### 2.3 The two grants

Both POST to the token endpoint with the single request header `Content-Type: application/json` and a
30 000 ms timeout. Body fields:

| grant | body fields |
|---|---|
| authorization code | `grant_type` = `authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier`, `state`, and `expires_in` when supplied |
| refresh | `grant_type` = `refresh_token`, `refresh_token`, `client_id`, `scope` (space-joined), and `expires_in` when supplied |

The refresh response carries `access_token`, `refresh_token`, `expires_in`, `refresh_token_expires_in`
and `scope`.

**Both grants are JSON-bodied and send no `anthropic-beta` header.** Winter matches this (ruling
R-A2-1 added `bodyEncoding` to the shared OAuth helpers so both grants go out as JSON, `state` rides
the authorization-code body, and `scope` rides the refresh body through `extraFields`).

### 2.4 Where the account id comes from

A GET to the API base + `/api/oauth/profile` with three request headers — `Authorization` (a bearer),
`Content-Type` and `Cache-Control: no-cache` — and a 10 000 ms timeout. **No `anthropic-beta`.**

The response carries `account.uuid`, `account.email`, `account.display_name`, `account.full_name`,
`account.created_at`, `organization.uuid`, `organization.has_extra_usage_enabled` and
`organization.billing_type`. **`account.uuid` is the account id** — reached by a separate
authenticated GET, not by a claim in the token response and not by any JWT decode. A sibling
`POST /api/oauth/validate` exists; Winter does not use it.

### 2.5 The beta header travels with the bearer

| beta name | header value |
|---|---|
| `oauth_auth` | `oauth-2025-04-20` |
| `claude_code` | `claude-code-20250219` |

An OAuth bearer request sets `Authorization: Bearer …` together with `anthropic-beta:
oauth-2025-04-20`, and never `x-api-key`; an API-key request sets `x-api-key` alone. That is the
shape `messages.ts` implements.

**`claude-code-20250219` is a first-party product identity and Winter never sends it.** It is listed
only so that its exclusion is deliberate; `corpus/anthropic.test.ts` sweeps every header name and
value of every request for a `claude` string.

## 3. THE TABLE — what `CONSOLE_OAUTH` must equal

`derived-p6b.ts` in this directory is this table as typed data.

| key | value | source |
|---|---|---|
| `clientId` | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` | §2 |
| `authorizeUrl` | `https://platform.claude.com/oauth/authorize` | §2; the Console host, the consumer host is excluded (D13/D14) |
| `tokenUrl` | `https://platform.claude.com/v1/oauth/token` | §2 |
| `profileUrl` | `https://api.anthropic.com/api/oauth/profile` | §2.4 |
| `scope` | `user:inference user:profile` | §2.1; a Winter-authored subset, space-joined |
| `callbackPort` | `0` | §2.2; ephemeral port |
| `callbackPath` | `/callback` | §2.2 |
| `betaHeader` | `oauth-2025-04-20` | §2.5 |
| `accountIdPath` | `account.uuid` | §2.4 |

## 4. Open questions only a live gate can answer

1. Whether the authorization server grants the `user:inference user:profile` subset at the Console
   host. A wrong guess fails loudly at login.
2. Whether a token carrying only those two scopes is accepted by `/v1/messages`. §2.5 gives the
   header shape, not the entitlement.
3. Whether the profile response carries `account.uuid` for every account type. An account whose
   profile omits it is refused by design.
