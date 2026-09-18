# Changelog

All notable changes to the Winter Agent SDK are recorded here. Versions follow the repo's own
`VERSION` file (bumped via `bun run version:bump`, synced via `bun run version:sync`); each entry
corresponds to one `chore(release): vX.Y.Z` commit.

## 0.0.17

Two new built-in tools, `WebFetch` and `WebSearch`, copied from the pinned `claude` 0.3.250 — its
descriptions, its input schemas, its inner-call prompts, its output assembly and its refusal texts,
measured byte-for-byte against the binary where a loopback can drive it. Both are **on by default**.
Session cost now covers the whole agent tree, and an interrupt really stops a running foreground Bash.

### BREAKING

- **`modelUsage` rows are keyed by the qualified `provider/model` catalog key**, not by the raw model
  string the host passed. A host that matched its own `options.model` against a row key now misses on
  every session: match on `system/init`'s `winter_provider.modelKey` (it always equals the row key),
  fall back to the row whose key ends with `/${init.model}`, and never sum the rows.
- **The root session's `total_cost_usd` and `modelUsage` now cover the whole agent tree** — every
  subagent at every depth, plus the web tools' own inner model passes. Each level folds once and
  reports upward once, so a host must NOT add `task_notification.usage` on top. `error_max_budget_usd`
  therefore fires earlier, descendants stop on the root's ceiling too (and now say so in their own
  failure text), and a parent on an unpriced (subscription) row can carry cost fields for the first
  time. Exa key-tier spend is **not** in `total_cost_usd`: the search backend is billed outside the
  model ledger and the runtime has no price for it.
- **An interrupt now kills a running foreground Bash command** rather than abandoning it. The
  executor wrapper forwards its abort signal, so the process dies; expect a
  `task_notification{status:"stopped"}` **after** the interrupted `result` (the previous shape
  delivered a late "completed" notification instead, so hosts already tolerate a trailing frame).
- **`WebFetch` and `WebSearch` are in every default `init.tools`.** `WebSearch` reaches its backend
  (Exa) anonymously with no credential; opt out with `disallowedTools` or `web.search.enabled: false`
  (any defined value other than boolean `true` reads as off).
- **`Options.allowedTools`/`disallowedTools` containing `WebSearch(<anything but *>)` throws at
  startup**: the tool has no specifier grammar, so a scoped rule could only ever be a silent no-op.
  A settings file drops such a rule and warns instead of failing the session.
- **`WebFetch(domain:…)` rules now match real calls.** The grammar was live before the tool was, so a
  rule that had been inert starts taking effect. An allow rule naming an EXACT host is standing
  consent for that host **wherever it resolves**: the DNS-rebinding / private-address check is off for
  that fetch, deliberately, because the user named the address. A glob (`domain:*`, `domain:*.corp`)
  never qualifies.

### Added

- `WebFetch`: fetches from this machine (http upgraded to https, its own redirect walk, 10 MiB body
  cap, 60 s per hop), converts HTML to markdown, and answers the caller's `prompt` over it with a
  small fast model; a 15-minute per-session cache, claude's 92 preapproved documentation hosts (auto
  allow after deny and ask rules, permissive guidelines, verbatim markdown passthrough), and claude's
  REDIRECT DETECTED / non-2xx / `Invalid URL` texts. Never relays a server-supplied status phrase.
- `WebSearch`: one inner pass on the session's model over a search backend, assembled into claude's
  own `tool_result` string (titles and urls only — no snippet, no page age, no encrypted content), a
  200-call-per-session budget shared with every descendant, and per-call bounds.
- `Options.web` (`RuntimeConfig.web`): `search.enabled` / `search.authRef` / `search.maxSearchesPerCall`
  / `search.anonymousMaxSearchesPerCall`, `fetch.digestModel` / `fetch.authRef` /
  `fetch.privateAddressPolicy`, and one `blockedDomains` floor both tools honour (suffix match on a
  label boundary). `resolveWebToolsConfig` + `WEB_TOOLS_DEFAULTS` are exported for a host that needs
  to read the resolved shape. **An unattended host should set `fetch.privateAddressPolicy: "deny"`**:
  the default `"ask"` raises a real permission prompt for a private or loopback target, and a session
  that cannot prompt refuses.
- `Options.autoMemory` (`RuntimeConfig.autoMemory`): `enabled` and `directory` for the auto-memory
  section, for a host that turns settings files off. A relocated directory under the home's
  `projects/` tree stays write-denied.
- Subagents inherit `web` and `autoMemory`.
- On Anthropic's own API (an API key **or** a Console profile), `claude-opus-4-8` and `claude-opus-5`
  are advertised the lean Agent-listing and web-tool texts, and both web tools carry claude's own
  schema bytes (`$schema`, `additionalProperties: false`, `format: "uri"`); every other provider gets
  the portable schema and the full texts.

### Fixed

- A `console/*` (Anthropic Console) session was treated as third-party: it got the full tool texts,
  the portable schemas, no Explore model cap and no `apiProvider` in its usage rows.
- Two fail-open edges in the `blockedDomains` floor: a search hit whose URL named no host passed the
  local filter, and a cache hit re-checked only the input host, not the URL actually fetched.
- The web tools' per-session state (search budget, fetch cache, saved-binary budget, search client) is
  released when the root run ends, so an in-process `query()` host no longer accumulates it and a
  resumed session starts with a fresh budget and a cold cache.
- A wrong-typed `allowed_domains`/`blocked_domains` searched **unfiltered**; it is refused now, as is
  a list past 1,000 entries. A megabyte-long query can no longer defeat the 100,000-character result
  cap.

### New environment variables

`WINTER_MAX_WEB_SEARCHES_PER_SESSION` (default `200`) — the per-session `WebSearch` call budget, the
analogue of `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`.

### Known differences from claude

- This runtime has **no schema-validation step in front of its executors**, so an input claude's
  schema refuses (a 1-character or empty `query`, an unparseable `url`) reaches the tool and is
  refused by its own text (`Error: Missing query`, `Error: Invalid URL "…". …`) rather than by an
  `InputValidationError`. A query is never trimmed on either side: a whitespace-only one that clears
  the 2-character minimum is accepted and searched raw, as in claude.
- An empty digest answer returns `No response from model`, where claude returns the empty string and
  lets its main loop render a placeholder.
- `WebSearch` is backed by Exa rather than Anthropic's server-side search: hit titles and urls are
  identical in shape, and the anonymous-vs-keyed per-call bounds have no claude analogue. A search
  backend failure adds one actionable sentence (e.g. "add an Exa API key") claude never needs.
- `WebFetch`'s domain floor is the host's own `blockedDomains`; Winter never calls Anthropic's
  `domain_info` preflight.
- The private-address policy is Winter's own; claude has no equivalent. Under the default `"ask"` a
  lexically private or loopback `WebFetch` target prompts even in `bypassPermissions`, under a broad
  allow rule, and after a PreToolUse hook's pre-approval; only an allow rule naming that exact host, or
  `privateAddressPolicy: "allow"`, is consent.
- A `WebFetch` url the executor is certain to refuse as written (a single-label host such as
  `localhost`, an IPv6 literal) is never prompted for: a hook's `ask`/`defer` and a user's ask rule are
  skipped for it, deny rules and a hook's deny still apply, and the call answers `Invalid URL` without
  touching the network.
- The 1,000-entry bound on `allowed_domains` / `blocked_domains` is Winter's own.
- `modelUsage.webSearchRequests` is always `0`: Winter's searches are the tool's own, and the count is
  not available where a generation is priced.

## 0.0.16

Request/response parity with the pinned `claude` 0.3.250 for everything that is on by default in a headless
session: the request layout, the agent listing, background completions reaching the model, byte-exact forks,
and per-agent-type permission rules.

### BREAKING

- **Subagents now run in the background by default.** `Agent` without `run_in_background` launches
  asynchronously and returns a task id; the child's completion reaches the model later as a
  `<task-notification>` document — folded into the next tool round, or as its own turn. Pass
  `run_in_background: false` for the previous behaviour, `Options.backgroundByDefault: false` (or
  `WINTER_BACKGROUND_BY_DEFAULT=0`) to keep the foreground default for a whole session, or
  `WINTER_DISABLE_BACKGROUND_TASKS=1` to disable background tasks entirely (this also withholds
  `run_in_background` from the advertised schema).
- **A session can start a turn nobody asked for.** When a background task completes while the session is
  idle, the runtime opens an *unsolicited turn*: a second `system/init`, the assistant stream, and its own
  `result`. There is **no `user` frame** — that second `init` is the only signal a turn started. Hosts that
  count turns, arm idle timers, or treat `init` as session identity must be updated before upgrading.
- **The Anthropic-dialect adapter sends `system` as an array of cache-marked text blocks** (plus a
  prompt-cache breakpoint on the last message block) for providers that declare prompt caching. A request
  without the 0.0.16 layout, or a provider that does not declare caching, keeps the plain string `system`.
- **Instruction files are read once per session** (and again after compaction), as in the pinned runtime,
  instead of on every turn.

### Added

- Request layout parity: the system prompt as cache-scoped blocks with the git status appended last; the
  per-session context (instruction files, memory index, current date) as one `isMeta` user message at index 0
  of every request, byte-stable across turns.
- Persisted `attachment` transcript entries, replayed on resume: the agent-type listing (announced once,
  deltas on change, re-announced after compaction), the skill listing, a date-change notice, and task
  notifications. The agent and skill listings are no longer part of the system prompt.
- Background completions reach the model: a per-session notification queue, `<task-notification>` documents
  per task kind inside an anti-injection preamble, and, for `-p`-style hosts, the input-closed hold (held
  `result`, wait loop with a ceiling, grace period, sweep).
- `system/session_state_changed`, emitted only under `WINTER_EMIT_SESSION_STATE_EVENTS`.
- Byte-exact forks: a fork replays the parent's system blocks, tool specs and context verbatim; its history is
  the parent's minus unanswered `tool_use`, plus a clone carrying only its own `tool_use`, a placeholder
  `tool_result` and the fork directive. `permissionMode: "bubble"`, forced background, `maxTurns: 200`, and a
  worktree note when isolated.
- `Agent(<type>)` permission rules (deny is enforced at the spawn with the pinned refusal wording),
  `Options.allowedAgentTypes` — also derived from a definition's `Agent(a, b)` tool entries — agent-listing
  filters, the Explore first-party model cap (`WINTER_DISABLE_EXPLORE_INHERIT_CAP` opts out), and
  `RuntimeAgentDefinition.whenToUseLean`.
- `Settings.includeGitInstructions` (default `true`) and `WINTER_DISABLE_GIT_INSTRUCTIONS`.

### Fixed

- The OpenAI Chat Completions adapter dropped any text that followed tool results in one user turn; it now
  becomes a follow-on `user` message.
- An interrupt no longer disables the input-closed wait for the rest of the session.
- A fork's own listing/skill/date attachments could fold into the inherited placeholder tool result and
  corrupt it.
- `/compact` could leave a turn claim held, which would stall a closed-input wind-down indefinitely; an
  interrupt arriving during that wind-down was a silent no-op.

### New environment variables

`WINTER_BACKGROUND_BY_DEFAULT`, `WINTER_PRINT_BG_WAIT_CEILING_MS` (default 600000; `0` waits indefinitely),
`WINTER_EMIT_SESSION_STATE_EVENTS`, `WINTER_DISABLE_GIT_INSTRUCTIONS`, `WINTER_DISABLE_EXPLORE_INHERIT_CAP`.
`WINTER_DISABLE_BACKGROUND_TASKS` also restores the foreground spawn default. All of them, and the new
options and settings, are documented in `packages/sdk/README.md`.

## 0.0.15

- `runtime`: background-task frames now match the pinned Claude Agent SDK runtime for Bash, Agent, Monitor,
  Workflow and TaskStop. `task_updated` is emitted on every task state change (before the terminal
  `task_notification`); foreground agents and foreground Bash commands that run longer than 2 s emit
  `task_started` (`is_backgrounded: false`) and `task_notification`; agents emit `task_progress` after each
  tool call, with the tool's activity text (e.g. `Running …`, `Reading …`) and token/tool-use counts;
  `task_type` is now `local_bash` / `local_agent` / `monitor_ws` / `local_workflow`; notification summaries
  use the same wording (e.g. `Background command "…" failed with exit code 3`); foreground tasks are never
  listed in `background_tasks_changed`; `task_started` and `task_notification` always carry `tool_use_id`.
- `runtime`: built-in subagent types `general-purpose`, `Explore`, `Plan` and `claude`; `web-fetch` and
  `fork` are opt-in (`WINTER_WEB_FETCH_AGENT`, `WINTER_FORK_SUBAGENT` / `Options.forkSubagent`). Kill
  switches: `WINTER_AGENT_SDK_DISABLE_BUILTIN_AGENTS`, `WINTER_DISABLE_EXPLORE_PLAN_AGENTS`,
  `WINTER_DISABLE_AGENT_VIEW`. **The fork subagent is experimental in this release: keep it off.**
- `runtime`: the available agent types are listed to the model, and exposed as `system/init.agents` and the
  new `Query.supportedAgents()`. **Custom implementations of `Query` must add `supportedAgents`.**
- `runtime`: `subagent_type` handling — omitting it selects `general-purpose`; names match case- and
  separator-insensitively; an unknown or ambiguous name returns an error listing the available agents;
  `isolation: "remote"` falls back to a worktree (inside a git repository) or a local run instead of failing;
  worktree, nesting-depth and concurrency errors tell the model what to do next.
- `runtime`: subagent tool pools follow the Claude runtime — plan-mode, question, scheduling, notification and
  workflow tools are removed from subagents, `Agent` is only available below the nesting limit, and
  background subagents are limited to an allowlist (MCP tools always pass). `tools: ["*"]` in an agent
  definition now means all tools.
- **BREAKING** `runtime`: filesystem and plugin agent files now require `name:` and `description:`
  frontmatter (the agent's name no longer comes from the file name). Files without them are skipped with one
  stderr line each. Migration: add both fields.
- `runtime`: tool errors carry `is_error: true` on the wire (Anthropic and Bedrock map it natively; other
  providers keep the error text), and a failed tool result fires `PostToolUseFailure` instead of
  `PostToolUse`.
- `runtime`: background Bash and Monitor commands survive a turn interrupt; they stop when they exit, when
  TaskStop stops them, or when the session (for a subagent: that subagent) ends — including on SIGTERM/SIGINT.
  Hosts that retire idle runtime processes will stop their background commands at that point.
- **BEHAVIOUR CHANGE** `provider-runtime`: `usage.inputTokens` is the non-cached prompt for every provider
  family (OpenAI Responses/Chat, DeepSeek and Google were normalised), with cache reads/writes reported
  separately. Token and cost totals for those families no longer double-count cached tokens.
- `runtime`: context accounting includes cache tokens, so sessions using prompt caching compact at their real
  context size.

## 0.0.14

- `provider-runtime`: a ChatGPT Codex `usage_limit_reached` (and `usage_limit_exceeded`) HTTP 429 is now
  TERMINAL -- a billing-class exhaustion like `insufficient_quota`, not a transient rate limit. It used to be
  retried ten times with backoff (~90 s of silence before the error surfaced). The typed error now reads
  `HTTP 429 -- usage limit reached (plan: plus) -- resets in N min`, and `resets_in_seconds` from the body
  feeds `retryAfterMs` when no `Retry-After` header is present (the header still wins). Measured on the live
  backend 2026-09-16.

## 0.0.13

- `provider-catalog`: added the `console` provider (WS-20 Task L1.1) -- the Anthropic Console
  login arm as its own provider row, `authKinds: ["console-profile"]`, mirroring `anthropic`'s
  adapter, endpoints, risk class and pricing basis. `console-profile` is a new `authKinds` schema
  enum member.
- `provider-catalog`: every `anthropic/<id>` Claude row now has a structural `console/<id>` twin
  (WS-20 Task L1.2), so a model served on the Console profile is a distinct catalog tag from its
  API-key twin. `claude` family `vendorProviders` gains `console` (informational only).
- `provider-catalog`: the seven `gpt-5.6` rows (`openai/gpt-5.6`, `-sol`, `-terra`, `-luna` and
  their `codex-oauth/*` siblings) now carry the five-tier effort vocabulary
  `["low","medium","high","xhigh","max"]` with `medium` as default (WS-20 Task L1.3). The
  `codex-oauth` rows were already measured live 2026-07-30; the `openai/*` rows were promoted to
  `declared` from a live WS-20 probe against `api.openai.com /v1/responses` on 2026-09-16, which
  accepted every tier on every model.

## 0.0.12

- Fixed `winter-agent-runtime`: `resume.ts`'s `toDialectEntries` discarded `message.model` from every
  loaded transcript entry -- the ONLY provenance an official-leg-written (real `claude` binary)
  assistant turn carries, since it has no Winter-written sidecar record at all. The renderer's own
  fallback for exactly this case (W18-17/G1) was built and tested against a hand-constructed message,
  but the reader that was supposed to attach `message.model` off a real transcript never did, so an
  official-leg Claude turn's `thinking` never carried to a different-family destination after a
  same-session model switch. `DialectEntry.message` now carries an optional `model`;
  `rebuildProviderMessages` spreads it, structurally, onto the rebuilt assistant message.
  `ProviderMessage` stays closed (no new field of its own). New end-to-end reader-to-renderer test
  (`resume-renderer.test.ts`) proves the whole path, through the real catalog, using
  `openai/gpt-5.6-sol` (the model from the reported symptom).
- Fixed `provider-runtime`'s history renderer: a message whose origin could not be resolved at all
  used to pass through completely untouched -- safe for the histories that branch was built for
  (none of which ever carried opaque provider state), but not a safe general default. It now fails
  CLOSED: opaque provider state (`nativeState`, in-dialect `thinking`/`redacted_thinking` blocks) is
  always stripped before reaching an adapter, exactly like a genuine cross-domain message. Visible
  thinking text is dropped rather than carried unlabeled or under a fabricated `provider`/`model`
  attribution; a handoff note on a non-assistant message is still preserved; object identity is kept
  for every message that had nothing opaque to strip, so no pre-existing behavior changes. New test
  proves an unresolved-origin message carrying a real-shaped `thinking` + signature +
  `redacted_thinking` renders, for an Anthropic-dialect destination, into a wire body (via
  `toWireMessages`, the one adapter that would otherwise pass such blocks through verbatim)
  containing neither.
- Review micro-round on the fail-closed fix above:
  - The fail-closed branch now sets `report.truncated = true` whenever it actually destroys real
    reasoning content (a `thinking` block's own text, a `redacted_thinking` block, or `nativeState`)
    -- previously it dropped the material but never flipped the ONE flag the engine's switch point
    reads to escalate a transfer to warned-lossy (§9.6). Left `false` for the identity case and for a
    stale-decoration-only removal. `RenderReport`'s own `truncated` doc updated to name this source.
  - `winter-agent-runtime`'s much simpler `createIdentityHistoryRenderer` (`bridge.ts`) had the exact
    same hole its own header used to name and accept: a no-origin message's `thinking`/
    `redacted_thinking` blocks rode through untouched. It now delegates to `provider-runtime`'s own
    `stripOpaque` (newly exported for this) rather than reimplementing the two-carrier rule, layered
    on top of its existing nativeState domain check rather than replacing it. Object identity
    preserved when nothing changes; all pre-existing tests on this function pass unmodified.
  - Added a test pinning the origin-resolution precedence (`message.origin` > sidecar chain origin >
    structural `message.model`) with all three sources present and naming different, contradicting
    catalog rows.
- No fixture family for "Winter resumes/renders an official-transcript" exists in `winter-conformance`
  today (the existing `resume-conformance.test.ts` family runs the opposite direction: a
  Winter-written transcript resumed by the real pinned binary) -- noted for a future, separately
  scoped addition rather than added here.

## 0.0.11

- Fixed `provider-catalog`: every `zai/*` GLM row (4.7, 4.7-flash, 5, 5-turbo, 5.1, 5.2, 5.3) shipped
  with `reasoning: null`, so the continuity layer treated GLM as a hidden-reasoning source and
  classified a GLM -> GPT switch `warned-lossy`/`prompt: true` -- violating R-10b-8 (open models
  that expose raw reasoning, like DeepSeek, move without a prompt). Added official-doc evidence
  (`supported`/`readableState: full-exposed`, `continuation: plaintext`, `replayScope: all-turns`,
  `toolLoopRequirement: silent-degradation`) sourced from docs.z.ai's Deep Thinking, Preserved
  Thinking and Interleaved Thinking documentation, for the OpenAI-dialect rows only --
  `zai-anthropic/*` is left untouched (no official Z.ai documentation of an Anthropic-dialect
  thinking contract exists). This also fixes same-domain carriage: the OpenAI chat-completions
  adapter's `captureExposedReasoning` flag is gated on catalog `readableState`, so GLM's own
  tool-loop reasoning replay was being silently dropped.
- Added `provider-runtime` tests resolving `reviewModelSwitch`/`classifySwitch` through a REAL
  catalog registry (mirroring `winter-runtime-sdk`'s `defaultEndpointResolver` construction) rather
  than hand-built fixtures, covering GLM's reasoning classification and cross-family carriage
  (`<recovered_reasoning kind="exposed">` for a GPT destination via the live renderer, and via
  `toClaudeReady`'s step (e) for a Claude destination). Documents a finding for follow-up: `zai`,
  `deepseek` and `openai` all share catalog `provider.family: "openai"` (a wire-dialect grouping,
  not a vendor one), so `reviewModelSwitch`'s own same-family skip fires for any pair among them
  before the loss matrix ever runs -- independent of reasoning evidence, and not addressed by this
  release.

## 0.0.10

Cross-family same-session parity (Phase 10b, S1-S9): `message.id` on every assistant entry;
Claude-native compaction (`compact_boundary`/`compactMetadata.preservedMessages`) written and read
on both legs; the `recovered_reasoning` tag with a `kind` attribute (summary vs. exposed) replacing
the old `recovered_reasoning_summary` name; `toClaudeReady`'s pure transform; `switchFactsFor`/
`reviewModelSwitch`; `releaseSessionLease`.

## 0.0.9

Console bearer moved off the `anthropic:default` account.

## 0.0.8

Console-broker `ant`-only rework.

## 0.0.7

Console bearer beta header, `expires_at` normalisation.

## 0.0.6

Host-brokered Anthropic Console login (`console-broker`), bearer `expiresAt`, live-gate driver
fixes.

## 0.0.2 - 0.0.5

Early workspace scaffolding and versioning; no changelog detail recorded prior to 0.0.6.
