# P6.5 derived shapes — the Anthropic Console OAuth constants (D20), pinned 0.3.250

Authority for lane A2 of the 2026-09-06 provider-widening plan. Same method and citation discipline
as `derived-shapes-p2.md` … `-p6.md` in this directory: every value below was READ OUT OF the pinned,
checksum-verified public artifact during an ephemeral capture and is reproduced here as a name, a
number or a field shape. Nothing from the artifact persists past this document and its typed twin
`derived-p6b.ts`. **No constant in `console-oauth.ts` was typed from memory** — the test
`the constants are the artifact's, not typed from memory` asserts `CONSOLE_OAUTH` field-by-field
against `derived-p6b.ts`, whose values are the table in §3.

## 0. What is different about this capture, stated first

The five prior files in this directory derive from the wrapper's `.d.ts` declarations. **The OAuth
configuration is not declared anywhere in the `.d.ts` set** — it lives in the wrapper's bundled
`sdk.mjs` and, for the login flow itself, in the platform package's native `claude` executable. So:

* **Citations are BYTE OFFSETS into two named binaries, not `sdk.d.ts` line numbers.** §1 records the
  provenance chain and the grep recipe, so every row is re-derivable by anyone who repeats it.
* **Nothing below reproduces vendor IMPLEMENTATION SOURCE.** Prior captures in this directory quote
  `.d.ts` declarations, which are an interface; a bundle's function bodies are not, and the phase rule
  admits only names and the derived table under `compat/`. So every value here is recorded as
  `identifier = "literal"`, as a parameter/field table, or as prose describing a shape — never as
  reproduced control flow. Round 1 of the review found the first draft of §2.1–§2.5 in breach and it
  was rewritten; nothing in `derived-p6b.ts`, `CONSOLE_OAUTH` or any test ever depended on the code
  that came out.
* **`scripts/check-derived-shapes.ts` DOES NOT VERIFY THIS FILE and must not be pointed at it.** That
  script reads the six `.d.ts` files only; its check (b) would report every identifier below as
  "appears NOWHERE in the pinned artifact", because it never opens the file the identifier is in.
  This is a bound of that tool, not a defect in either it or this document. It was not edited, and no
  gate in this lane claims its output.

## 1. Provenance — the chain of trust, and how to repeat the capture

Two artifacts. The first is the one this repository already verifies; the second is verified *by* the
first, which is what keeps the capture hermetic rather than merely reproducible.

| # | artifact | sha256 | verified against |
|---|---|---|---|
| A | `@anthropic-ai/claude-agent-sdk@0.3.250` wrapper tarball | `207b771f94aab6ffd025b039d6f911e20ad0634c50c09206c0ca7c3601b40d95` | `checksums.json` in this directory, through `scripts/fetch-upstream.ts` (`fetchAndVerifyUpstream`) — sha256 AND the registry sha512 integrity, both re-checked at capture time |
| B | the `claude` executable inside `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.250` | `506d7362a9c625306044879a9d91d8f33bd2eef963681b56be3295db5fe3e34b` | TWO independent in-repo sources that agree: `checksums.json`'s `darwinArm64NativeSha256`, and artifact A's own `manifest.json` (`platforms.darwin-arm64.checksum`, with `size` 206479552 also matching byte for byte) |

Artifact B's hash is asserted by the artifact A that `fetch-upstream.ts` verified, so the second fetch
inherits the first's trust rather than adding a new root. Both extracts were `mkdtemp` directories,
both were deleted, and nothing from either was written into the repository.

Recipe (ephemeral; run from a scratch directory, never in-tree):

```sh
# A — through the repository's own verified path
bun run scripts/fetch-upstream.ts                      # or fetchAndVerifyUpstream({ cacheDir })
tar -xzf claude-agent-sdk-0.3.250.tgz -C "$EXTRACT"    # package/sdk.mjs is the wrapper bundle

# B — verified against checksums.json AND package/manifest.json from A
curl -sSL -o native.tgz \
  https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-arm64/-/claude-agent-sdk-darwin-arm64-0.3.250.tgz
tar -xzf native.tgz -C "$D" && shasum -a 256 "$D/package/claude"   # must equal the row above

# reading it: offsets are absolute byte positions; the executable is not UTF-8, so filter for print
grep -a -ob -F 'function RUt({codeChallenge' "$D/package/claude"
dd if="$D/package/claude" bs=1 skip=155590290 count=900 2>/dev/null | LC_ALL=C tr -c '\11\12\40-\176' '.'
```

Offsets below are written `A@<offset>` for `package/sdk.mjs` and `B@<offset>` for `package/claude`.

**Prompt-text prohibition (WS-11 §6.2, phase Global Constraints).** Unlike the `.d.ts`-only captures
beside it, this one necessarily read bundles and an executable — so the prohibition is stated as what
was actually done rather than as a scope that made it impossible. Every grep was targeted at OAuth
CONFIGURATION: URL and scope literals, a client id, a beta header value, the callback path, and the
identifiers immediately around them. **The pinned runtime's system prompt was never fetched, searched
for, read, printed, quoted, summarized or described**, and no tool description, tool instruction text
or request `system` field appears anywhere in this document or in `derived-p6b.ts`. Nothing was
executed: both artifacts were read as bytes and deleted.

## 2. What the artifact contains — the whole OAuth surface, including what Winter refuses

Recorded in full so that the exclusions are on the record beside the admissions. The configuration
object appears identically in both artifacts (`A@805496`, `B@74074572` and `B@153685480`), which is
the cross-check that the wrapper's copy is the one the executable actually runs.

| field | value | Winter's use |
|---|---|---|
| `CONSOLE_AUTHORIZE_URL` | `https://platform.claude.com/oauth/authorize` | **D20's authorize endpoint.** `A@805541`, `B@153685555` |
| `TOKEN_URL` | `https://platform.claude.com/v1/oauth/token` | **D20's token endpoint.** `A@805711` |
| `CLIENT_ID` | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` | **D20's client id.** `A@806175`, `B@74075076`. A PUBLIC client id shipped in a public npm artifact, used with PKCE and no client secret — admitted by D21's "the vendor's public product client with an honest Winter originator", the same basis as `codex-oauth` |
| `BASE_API_URL` | `https://api.anthropic.com` | already `ANTHROPIC_DEFAULT_BASE_URL` |
| `CLAUDE_AI_AUTHORIZE_URL` | `https://claude.com/cai/oauth/authorize` | **NEVER USED (D13/D14).** `A@805609`. The consumer subscription login is not a Winter provider |
| `CLAUDE_AI_ORIGIN` | `https://claude.ai` | **NEVER USED (D13/D14).** `A@805674` |
| `API_KEY_URL` | `https://api.anthropic.com/api/oauth/claude_cli/create_api_key` | **NEVER CALLED.** `A@805766`. A `claude_cli`-scoped path: calling it presents as the vendor's own CLI, which D21 excludes |
| `ROLES_URL` | `https://api.anthropic.com/api/oauth/claude_cli/roles` | **NEVER CALLED**, same reason. `A@805842` |
| `MANUAL_REDIRECT_URL` | `https://platform.claude.com/oauth/code/callback` | not used; Winter runs the loopback arm (§3, `callbackPath`) |
| `CONSOLE_SUCCESS_URL`, `CLAUDEAI_SUCCESS_URL` | vendor pages carrying `app=claude-code` | **NEVER USED** — they name the vendor's product |
| `DESIGN_CLIENT_ID` | `59637612-477b-4836-a601-b0589eda7704` | not used |
| `MCP_PROXY_URL` / `MCP_PROXY_PATH` | `https://mcp-proxy.anthropic.com`, `/v1/mcp/{server_id}` | out of scope for D20 |

### 2.1 The scope vocabulary, and why Winter requests a SUBSET

Six scope strings, one beta value and three lists sit in one declaration
(`A@805308-805496`, `B@153685086-153685255`). As name-and-literal pairs:

| minified name | literal |
|---|---|
| `Xg` | `user:inference` |
| `E1` | `user:profile` |
| `s` | `org:create_api_key` |
| `Lu` | `oauth-2025-04-20` |
| `Q7` | `user:design:read`, `user:design:write` |
| `yfr` | `user:projects:read`, `user:projects:write`, `user:plugins` |

and three lists built from them: `r` = (`org:create_api_key`, `user:profile`); `Tq` =
(`user:profile`, `user:inference`, `user:sessions:claude_code`, `user:mcp_servers`,
`user:file_upload`); `Ovn` = the deduplicated union of `r` and `Tq`.

The authorize builder (§2.2) selects among three: a caller-supplied client's own list, the
single-element list (`user:inference`) when its `inferenceOnly` argument is set, or `Ovn` by default.

**`Ovn` is not available to Winter.** It carries `user:sessions:claude_code`, `user:mcp_servers` and
`user:file_upload`, which are entitlements of the vendor's own application, and `org:create_api_key`,
whose only consumer in the artifact is the `claude_cli`-scoped `API_KEY_URL` above. D21 excludes both
classes by name.

**What Winter requests is `user:inference user:profile`** — a subset, every member of which is a
derived string from the table above:

* `user:inference` is the artifact's OWN inference scope. Its own predicate for "may this token run a
  turn" (`G0`, `B@155590151`) tests membership of exactly that one string, and it is the sole member
  of the `inferenceOnly` list — so "Console host + inference only" is a combination the artifact's own
  builder produces, because the host argument (`loginWithClaudeAi`) and the scope argument
  (`inferenceOnly`) are independent parameters of the same function.
* `user:profile` appears in BOTH lists and is what authorises the account lookup in §2.4 that names
  the credential record. Neither scope is specific to the vendor's application.

`org:create_api_key` is deliberately absent: Winter never mints an API key through this flow.

### 2.2 The authorize request (`RUt`, `B@155590290`)

The query parameters it appends, in order, with the literal each carries:

| parameter | value |
|---|---|
| `code` | `true` |
| `client_id` | the caller's client id, else `CLIENT_ID` |
| `response_type` | `code` |
| `redirect_uri` | `MANUAL_REDIRECT_URL` in the manual arm; otherwise the loopback template below |
| `scope` | the selected list, SPACE-joined |
| `code_challenge` | the PKCE challenge |
| `code_challenge_method` | `S256` (`B@155590894`) |
| `state` | the flow's nonce |
| `orgUUID`, `login_hint`, `login_method` | optional, omitted when absent |

The host is `CONSOLE_AUTHORIZE_URL`, or `CLAUDE_AI_AUTHORIZE_URL` when its `loginWithClaudeAi`
argument is set — the consumer arm, which Winter never takes (D13/D14).

Three findings that shape the implementation, each different from what the plan assumed:

1. **The loopback port is a RUNTIME VARIABLE, not a registered constant.** The non-manual
   `redirect_uri` is the template `http://localhost:<port>/callback`, its port interpolated from an
   argument (`B@155590680`). Unlike codex — whose fixed 1455/1457 pair exists because the registered
   redirect must match — this client's registration accepts a loopback URI on any port, which is RFC
   8252 §7.3's recommended shape. So Winter's production `callbackPort` is **`0`**, an ephemeral
   port, and no port is a constant to get wrong.
2. **The callback PATH is `/callback`**, not `pkce.ts`'s built-in `/auth/callback`.
3. `code=true` is a query parameter of the authorize request, and `scope` is SPACE-joined.

### 2.3 The two grants (`Hmn`, `B@155591103`; `KN`, `B@155591837`)

Both POST to `TOKEN_URL` under the single request header `Content-Type: application/json`, with a
30 000 ms timeout. Their body fields:

| grant | body fields |
|---|---|
| authorization code (`Hmn`) | `grant_type` = `authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier`, `state`, and `expires_in` when the caller supplies one |
| refresh (`KN`) | `grant_type` = `refresh_token`, `refresh_token`, `client_id`, `scope` (space-joined), and `expires_in` when supplied |

The refresh response is read for `access_token`, `refresh_token`, `expires_in`,
`refresh_token_expires_in` and `scope`.

**Both grants are JSON-bodied, and NEITHER sends an `anthropic-beta` header.** Stated explicitly
because the wrapper contains a second, unrelated OAuth implementation that DOES — the bundled
`@anthropic-ai/sdk`'s own `userOAuthProvider` and `oidcFederationProvider` paths (`A@29321`, `A@27334`),
which identify themselves as `anthropic-sdk-typescript/…`. That is a different flow from a different
library, and reading its headers as this flow's is the easiest mistake this section can cause. **The
flow D20 mirrors — the CLI's own `Hmn`/`KN` — sends a content type and nothing else.**

Winter matches all of it: ruling R-A2-1 added `bodyEncoding` to the shared OAuth helpers so both
grants go out as JSON, `state` rides the authorization-code body, and `scope` rides the refresh body
through `extraFields`. What remains unverifiable offline is only whether the endpoint would ALSO have
accepted the form encoding RFC 6749 §4.1.3 requires it to — a question Winter no longer needs
answered, since it now sends the observed encoding.

### 2.4 Where the account id comes from — NOT the token response (`Ice`, `B@155589253`)

A GET to `BASE_API_URL` + `/api/oauth/profile` (`B@155589296`) carrying exactly three request
headers — `Authorization` (a bearer), `Content-Type` and `Cache-Control: no-cache` — with a 10 000 ms
timeout. **No `anthropic-beta`**, which is why Winter's own profile lookup sends none either.

Its response is consumed at `B@155597893` (the account-stamping path, `Lmn`), which reads
`account.uuid`, `account.email`, `account.display_name`, `account.full_name`, `account.created_at`,
`organization.uuid`, `organization.has_extra_usage_enabled` and `organization.billing_type`.

So **`account.uuid` is the account id** — reached by a separate authenticated GET, not by a claim in
the token response and not by any JWT decode. `/api/oauth/profile` is a generic OAuth path, unlike the
`claude_cli` paths in §2; a sibling `POST /api/oauth/validate` exists (`B@73612236`) and Winter does
not use it.

### 2.5 The beta header rides the API request, not only the token endpoint (`B@155111842`)

The artifact keeps a table of named betas, each a `{ name, header }` pair. Two of its entries:

| entry | name | header literal |
|---|---|---|
| `LSe` | `oauth_auth` | `oauth-2025-04-20` |
| `Wn` | `claude_code` | `claude-code-20250219` (`B@155111815`) |

The pairing with a bearer is unconditional across the executable: **all 13 occurrences of the
`anthropic-beta` key set to that beta constant**
(`B@155126313, 155438304, 155510884, 155588956, 155672232, 155672759, 161851990, 165602323, 165816197, 165816819, 166249276, 170459732, 171847000`)
occur in an object literal that also sets `Authorization` to a bearer. The clearest discriminator is a
two-armed conditional at `B@155126313`/`B@155126336`, whose arms are exactly
`{ Authorization, anthropic-beta }` and `{ x-api-key }`; the API-request auth builder itself (`Az`,
`B@155672461`) has the same two arms. **An OAuth bearer and the `oauth-2025-04-20` beta travel
together, and `x-api-key` is never sent alongside them** — which is exactly the arm `messages.ts`
implements.

**`claude-code-20250219` is a first-party product identity and Winter never sends it.** It is recorded
here only so that its exclusion is deliberate and provable; `corpus/anthropic.test.ts` sweeps every
header NAME and value of every request for a `claude` string.


## 3. THE DERIVED TABLE — what `CONSOLE_OAUTH` must equal

`derived-p6b.ts` in this directory is this table as typed data, and `console-oauth.test.ts` asserts
`CONSOLE_OAUTH` equals it. A drift in either file fails that test.

| key | value | derivation |
|---|---|---|
| `clientId` | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` | `CLIENT_ID`, §2 — verbatim |
| `authorizeUrl` | `https://platform.claude.com/oauth/authorize` | `CONSOLE_AUTHORIZE_URL`, §2 — verbatim. The Console host; the consumer host is excluded (D13/D14) |
| `tokenUrl` | `https://platform.claude.com/v1/oauth/token` | `TOKEN_URL`, §2 — verbatim |
| `profileUrl` | `https://api.anthropic.com/api/oauth/profile` | §2.4 — verbatim |
| `scope` | `user:inference user:profile` | §2.1 — a Winter-authored SUBSET; both members verbatim, space-joined as the builder joins them |
| `callbackPort` | `0` | §2.2 — the artifact's port is a runtime variable, so an ephemeral port is the derived behaviour, not a guess |
| `callbackPath` | `/callback` | §2.2 — verbatim |
| `betaHeader` | `oauth-2025-04-20` | `Lu` / the `oauth_auth` beta, §2.1 and §2.5 — verbatim |
| `accountIdPath` | `account.uuid` | §2.4 — the profile response field that names the record |

## 4. Open questions this capture could NOT answer (a live gate must)

**Closed since the first draft (ruling R-A2-1):** the grant BODY ENCODING is no longer a question.
Winter sends JSON on both grants, which is the encoding the artifact is observed sending, so the
remaining unknown is only whether the endpoint would also have accepted form — which Winter no longer
needs to know.

1. **Whether the authorization server grants the `user:inference user:profile` subset** at the Console
   host. The artifact's builder can construct exactly that request; only a real authorization proves
   the server honours a subset. A wrong guess fails LOUDLY and early — at login, as an R6-10 refusal
   or a scope error — rather than silently.
2. **Whether a token carrying only those two scopes is accepted by `/v1/messages`.** §2.5 proves the
   header shape, never the entitlement.
3. **Whether the profile lookup's response shape holds for every account type.** §2.4 records the
   fields the artifact reads; an account whose profile omits `account.uuid` is refused by design, but
   only a live run says whether such an account exists.
