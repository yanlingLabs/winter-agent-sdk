# Derived shapes — Qoder (P6.5 lane O)

**Verdict: there is no Qoder OAuth flow to implement, and no documented inference endpoint to point
a provider row at. The `qoder` row is CARRIED, not shipped.**

This file is the evidence for that refusal. It is written to the same standard as a positive capture:
what was fetched, when, and what it said — so the next person to look does not repeat the search, and
so re-ruling the row is a matter of producing one named missing document rather than re-auditing.

---

## 1. What the task assumed

Task 4 is titled "the two documented third-party OAuth flows (Qoder and xAI)" and asks for
`startQoderLogin` via `runLoginFlow` or `runDeviceCodeFlow` "per the capture", a `winter.qoder-oauth`
adapter, and an overlay row with `admission.basis: "oauth-documented"`. WS-13b §2 describes the row
as "OAuth provider row (OpenAI dialect, `https://api.qoder.com/v1`)".

The capture step is what that instruction is contingent on, and the capture came back negative.

## 2. What was actually fetched (all 2026-09-06, unauthenticated)

| # | source | result |
|---|---|---|
| Q1 | `https://docs.qoder.com/llms.txt` | HTTP 200 (gzip). The vendor's own complete documentation index — **753 lines, every page in the product's docs** |
| Q2 | `https://docs.qoder.com/cli/authentication` | HTTP 200 |
| Q3 | `https://docs.qoder.com/cli/sdk/authentication` | HTTP 200 |
| Q4 | `https://docs.qoder.com/cloud-agents/api/conventions/authentication.md` | HTTP 200 |
| Q5 | `https://docs.qoder.com/account/teams/openapi/conventions.md` | HTTP 200 |
| Q6 | `https://docs.qoder.com/cli/network.md` | HTTP 200 |
| Q7 | `https://docs.qoder.com/account/integrations` | **HTTP 404** (the path the audit's OQ-5 search extract pointed at; it is a console URL under `qoder.com`, not a docs page) |
| Q8 | `https://docs.qoder.com/account/teams/openapi/get-api-key`, `…/openapi` | HTTP 200 |

## 3. Finding 1 — no OAuth grant is documented for third-party clients

Q1 is the decisive artifact, because it enumerates the entire documentation set rather than a page
someone guessed at. Searching all 753 entries for `oauth`, `device`, `pkce`, `client_id`, `authorize`
returns **exactly two hits, and both point the other way**:

* `cloud-agents/api/vaults/start-oauth` — starting an OAuth flow so Qoder can authenticate **to a
  third-party MCP server**;
* `cloud-agents/api/vaults/validate-credential` — validating such a stored MCP credential.

Both are Qoder acting as an OAuth **client toward someone else**. Neither is an authorization server
Winter could log in to. There is no authorize endpoint, no device-code endpoint, no client id, no
scope vocabulary, and no registration path anywhere in Qoder's documentation.

Q2 describes the interactive route as the vendor's own proprietary sign-in, reached through the
Qoder CLI's own `/login` command. It names no protocol, no endpoint and no third-party client. That
is the same posture Zed has, and the opposite of xAI's — no published client, no published endpoint,
no invitation.

**Consequence:** `startQoderLogin` cannot be written. There are no constants to derive, and WS-13b's
rule is that constants are never typed from memory. Inventing an authorize URL and a client id would
be exactly the failure this whole phase's admission rule exists to prevent.

## 4. Finding 2 — what Qoder DOES document for third parties is a bearer token

Not an OAuth flow, and worth recording precisely because it is a real, documented path:

| mechanism | how it travels | source |
|---|---|---|
| **Personal Access Token (PAT)** — a user identity, created in the Qoder console with chosen scopes and expiry | `QODER_PERSONAL_ACCESS_TOKEN` env var; `Authorization` bearer on API calls | Q2, Q3, Q4 |
| **Service Account Key → Service Account Token (SAT)** — an organization workload identity; the long-lived key is exchanged for a short-lived JWT, and the key itself must never call business APIs directly | `Authorization` bearer | Q3, Q4 |
| **Team OpenAPI key** — organization management | `Authorization` | Q5, Q8 |

Base URLs, from Q4 and Q5: `https://api.qoder.com` (business API; example path
`/v1/organizations/{organization_id}/members`) and `https://openapi.qoder.sh` (the SAT exchange).
Q6 documents only standard `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` handling and names no outbound
model endpoint.

If this row is ever re-ruled, the honest shape is an **api-key/bearer** row — `admission.basis:
"api-key"`, citation `https://docs.qoder.com/cli/authentication` — not an OAuth one.

## 5. Finding 3 — the blocker even for a bearer row: no documented inference endpoint

This is audit OQ-5, and this capture could not close it either.

Everything Qoder documents under `api.qoder.com/v1` is **management**: organizations, members,
groups, billing groups, usage, AI-code metrics, and the Cloud Agents session API. Nothing in the
753-entry index documents an OpenAI-dialect chat-completions or Responses route, a model list, or any
"send this provider a prompt" endpoint for a third-party client. Qoder's programmatic model access is
shaped as *run the Qoder agent* (CLI / Agent SDK / Cloud Agents), not as *call this model endpoint*.

**And that shape is itself excluded, independently of the missing endpoint.** Qoder's documented
third-party route is its **Agent SDK / Cloud Agents** — a harness that plans, calls tools and talks
to the model on the caller's behalf (`/cli/sdk/overview` describes the SDK as the application-facing
API over `qodercli`, which "plans the task, communicates with the model, and executes tools"). That
is the **agent-transport class**, which WS-13 §8.2 excludes from the provider layer: a provider row
promises Winter's own agent loop reaches a model, and delegating to another vendor's agent runtime is
a different thing wearing the same name. So even if an inference endpoint were found tomorrow, the
SDK/Cloud-Agents route would not be the thing that admits a provider row — only a documented model
endpoint would.

**So WS-13b §2's `https://api.qoder.com/v1` as an OpenAI-dialect provider endpoint is unsupported by
any Qoder document reachable on 2026-09-06.** It appears to be an inference from the base URL rather
than a fetched fact. A provider row is a promise that a Winter session can reach a model there;
Winter has no evidence that it can, and R6b-3 makes a row's citation carry exactly that weight —
a citation must admit *what the row does*, and none of the pages above admits third-party inference.

## 6. Decision

**Carried.** No `qoder` provider row, no `qoder-oauth.ts`, no `winter.qoder-oauth` adapter, no fake,
no corpus case. Lane A2's `startProviderLogin` stub for `qoder` is left exactly as A2 wrote it.

The user's standing ruling that Qoder is *allowed* is not being second-guessed here, and this is not
a re-audit of that ruling: permission to ship is not the same as knowing where to send the request.
What is missing is a wire fact, and lane O will not invent one.

**To un-block, exactly one document is needed:** a Qoder-published page naming a base URL and auth
scheme for sending a model a prompt from a third-party client. With it, the row ships as a PAT bearer
row in a follow-up (`admission.basis: "api-key"`, `pricingBasis: "token"`) — a much smaller change
than this task assumed, and one that needs no OAuth code at all.
