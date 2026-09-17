# Changelog

All notable changes to the Winter Agent SDK are recorded here. Versions follow the repo's own
`VERSION` file (bumped via `bun run version:bump`, synced via `bun run version:sync`); each entry
corresponds to one `chore(release): vX.Y.Z` commit.

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
