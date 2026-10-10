# `@yanlinglabs/winter-agent-sdk`

Winter's wrapper: `query()`, the `Options` surface, the session-management API, settings resolution,
the transcript store and the brand profile. This is the package a host installs by name; it spawns
the compiled `winter` runtime and speaks to it over the pinned protocol.

This is the DROP-IN surface Winter's conformance corpus measures against
`@anthropic-ai/claude-agent-sdk` — same option names, same message shapes, same ordering.

## Install

This package is published to **two registries**, and which one you want depends on who you are.

### From public npm (anyone)

```sh
npm install @yanlinglabs/winter-agent-sdk
```

Nothing else is needed: the `@yanlinglabs` scope is public on npm.

### From GitHub Packages (the `yanlingLabs` org)

GitHub Packages needs the scope pointed at it and an authenticated read, even for a public package.
In your project's `.npmrc`:

```
@yanlinglabs:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

…with `GITHUB_TOKEN` in the environment — a personal access token carrying `read:packages`, never a
literal in the file. Then `npm install @yanlinglabs/winter-agent-sdk` as usual.

**The published packages contain COMPILED OUTPUT ONLY.** Each tarball ships `dist/` — the bundled
JavaScript a consumer imports and the `.d.ts` declarations their type-checker reads — plus its data
files, `README.md` and `LICENSE`. It does **not** ship `src/`: the TypeScript sources live at
<https://github.com/yanlingLabs/winter-agent-sdk>, which is where to read them, file an issue, or send
a patch.

## Subpaths

The main entry is the wrapper surface above. Two subpaths ship beside it, for hosts that compose
Winter rather than only call it:

**`@yanlinglabs/winter-agent-sdk/messaging`** (since 0.0.2) — the cross-runtime messaging contract
and its router core: addresses, listings, delivery outcomes, the adapter interface, inbound policy,
the `notify_when_idle` subscription store, and the three orchestration functions a host drives them
with. It ships no adapter and no process-level singleton; those are host composition.

**`@yanlinglabs/winter-agent-sdk/tools`** (since 0.0.3) — Winter's default tools, declared and
implemented once:

- `WINTER_DEFAULT_TOOL_DEFINITIONS` — `send_message`, `list_agents`, `read_notifications` and
  `advisor`, each a `WinterToolDefinition` carrying a BARE `toolName`, the official built-in alias
  key in `builtinName`, the description, the schemas and a permission class. No registry policy
  fields: a host supplies its own.
- the native schemas and their bounds (`NATIVE_SEND_MESSAGE_SCHEMA`, `SEND_MESSAGE_TO_MAX` and the
  rest), plus strict acceptors — unknown arguments are refused, `summary` is truncated rather than
  rejected, and a refusal is returned as data the model can correct from, never thrown.
- `MessagingToolPort` + `messagingToolPortFromRuntimeDeps`, and `createMessagingToolHandlers`, which
  turn a messaging world into the three tool handlers over it.
- `createAdvisorToolHandler` and `transcriptSourceForSessionKey`, with the reviewer left to the host
  to resolve.

A host BINDS these under its own names: the Winter runtime registers them as its native built-ins
plus two canonical standing-server twins, and `@yanlinglabs/winter-runtime-sdk` binds the same
definitions under Claude's built-in names. Handlers return `{ text, isError? }` for each host to
wrap in its own result shape.

## Environment variables and settings

The runtime child reads a handful of environment variables at spawn/per-turn, plus a few
`Options`/`RuntimeConfig` fields. Every variable name below is `WINTER_`-prefixed for Winter's own
build (`BrandProfile.envPrefix`); a rebranded host reads the identical suffix under its own prefix.

| Variable | Default | Effect |
| --- | --- | --- |
| `WINTER_DISABLE_BACKGROUND_TASKS` | off | A hard kill switch with two effects together: it drops `run_in_background` from the Agent tool's own advertised schema entirely, and it forces every subagent spawn to the foreground unconditionally (outranking a definition's own `background: true`, a fork, and an explicit `run_in_background: true` alike). |
| `WINTER_BACKGROUND_BY_DEFAULT` | on (background) | A softer opt-out than the kill switch above: a falsy value (`0`/`false`/`no`/`off`, case-insensitive) restores the pre-0.0.16 default (an unflagged spawn runs in the FOREGROUND) without removing `run_in_background` from the schema — the model can still ask for either explicitly either way. `Options.backgroundByDefault` (see below) wins over this variable in either direction when both are set. |
| `WINTER_PRINT_BG_WAIT_CEILING_MS` | `600000` (10 minutes) | How long a closed-input session holds its result for a still-running background agent/workflow before sweeping it as stopped. `0` waits indefinitely. |
| `WINTER_EMIT_SESSION_STATE_EVENTS` | off | Truthy (`1`/`true`) emits `system/session_state_changed` frames (`running`/`idle`) as a turn starts and ends. Absent, the frame stream is unchanged from before this existed. |
| `WINTER_DISABLE_GIT_INSTRUCTIONS` | off | Truthy disables the git status/instructions section of the system prompt outright, overriding `Settings.includeGitInstructions` in either direction. A falsy value (`0`/`false`/`no`/`off`) explicitly re-enables it even when the setting says otherwise. |
| `WINTER_DISABLE_EXPLORE_INHERIT_CAP` | off | Truthy opts a first-party Anthropic session out of the Explore built-in's own model cap (which otherwise caps a Fable-tier session's Explore spawn down to Opus). |
| `WINTER_FORK_SUBAGENT` | off | Truthy enables `subagent_type: "fork"` for the session (mirrors `CLAUDE_CODE_FORK_SUBAGENT`). `Options.forkSubagent` (below) wins over this variable in either direction. |
| `WINTER_WEB_FETCH_AGENT` | off | Truthy makes the `web-fetch` built-in agent type available (off by default, like claude's own). |
| `WINTER_MAX_WEB_SEARCHES_PER_SESSION` | `200` | How many `WebSearch` calls one session may make, counted before each search and shared with every descendant subagent (the analogue of `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`). Past it, a call answers with a plain refusal result rather than an error. |
| `WINTER_AGENT_SDK_DISABLE_BUILTIN_AGENTS` | off | Truthy withholds every built-in `subagent_type` (gated or not) for the session. |
| `WINTER_DISABLE_EXPLORE_PLAN_AGENTS` | off | Truthy withholds the `Explore` and `Plan` built-ins together. |
| `WINTER_DISABLE_AGENT_VIEW` | off | Truthy withholds the `claude` catch-all built-in (mirrors `CLAUDE_CODE_DISABLE_AGENT_VIEW`). |
| `WINTER_MAX_SUBAGENT_SPAWN_DEPTH` | `3` | How many levels of subagent nesting are allowed beneath the top-level session before a spawn is refused. |
| `WINTER_MAX_CONCURRENT_SUBAGENTS` | `20` | How many subagents may run at once (across the whole nesting tree) before a spawn is refused. |

A handful of `Options`/settings fields carry the same weight as their env counterparts, and a
RuntimeConfig field always wins over its own env fallback in either direction when both are set:

- **`Settings.includeGitInstructions`** (default `true`) — the setting `WINTER_DISABLE_GIT_INSTRUCTIONS` overrides above.
- **`Options.forkSubagent`** (`boolean`, default unset → env fallback) — the RuntimeConfig field behind `WINTER_FORK_SUBAGENT`.
- **`Options.backgroundByDefault`** (`boolean`, default unset → env fallback) — the RuntimeConfig field behind `WINTER_BACKGROUND_BY_DEFAULT`, above.

`RuntimeConfig.allowedAgentTypes` (`string[]`) is a different shape of field, not a host-settable
one: there is no `Options.allowedAgentTypes` and no env fallback to win over. It exists only on the
wire `RuntimeConfig`, and the engine — never a host — populates it: when a running agent's own
definition restricts `tools` with an `Agent(a, b)` entry, `allowedAgentTypesFromTools` parses that
restriction and threads the resulting list onto the CHILD it spawns for that agent's own
`RuntimeConfig`, so the child's listing / `init.agents` / Agent-tool resolution sees only `[a, b]`,
never the full universe of types its parent session could otherwise reach. Absent (every top-level
session, and any child whose parent definition named no `Agent(...)` restriction) means
unrestricted, the behavior every session had before this field existed.

### The built-in web tools (since 0.0.17)

`WebFetch` and `WebSearch` ship in every default `init.tools`, as copies of the pinned `claude`
runtime's own — same descriptions, same input schemas, same inner-call prompts, same output assembly.

- **`WebFetch`** takes `{url, prompt}`, fetches the page from this machine (`http` is upgraded to
  `https` unconditionally, and a hostname with fewer than two dot-separated labels is refused — so
  `localhost` and IPv6 literals are not fetchable, exactly as in claude), converts HTML to markdown,
  and answers `prompt` over it with a small fast model. Responses are cached for 15 minutes per
  session. Rules are `WebFetch(domain:<host>)`; an allow rule naming an exact host is standing consent
  for that host wherever it resolves.
- **`WebSearch`** takes `{query, allowed_domains?, blocked_domains?}` and runs one inner pass over the
  search backend, returning titles and urls only. The budget is 200 calls per session
  (`WINTER_MAX_WEB_SEARCHES_PER_SESSION`), shared with every descendant. Its only rule form is the
  bare `WebSearch`; a scoped `WebSearch(...)` in `Options.allowedTools`/`disallowedTools` throws at
  startup (a settings file drops it and warns).

Withdraw either with `disallowedTools`. `WebSearch` can also be switched off at the backend with
`web.search.enabled: false`.

- **`Search`** (opt-in, unreleased) takes `{query}` and returns Exa's answer mode: a written answer
  and the pages it came from, in one call. It is offered only when `Options.tools` names it and
  `web.search.authRef` names a key (the answer endpoint has no anonymous tier). The cited urls pass
  the same `blockedDomains` floor, and a withheld source is counted in the result.

All three report the icon of each site they name to the HOST only, as `winter_site_icons:
[{url, icon_url}]` on the host-facing `tool_result` block. The model never sees it.

### Shaping the tool surface (0.0.38)

- **`Options.tools`** — claude's own option: the built-in tool set by name, or the `claude_code`
  preset (the same as leaving it out). A visibility list: a built-in left out is not advertised, not
  searchable, and refused at dispatch. MCP servers' tools are never filtered by it. Without `ToolSearch`
  in it, nothing is deferred.
- **`Options.deferTools`** — tools that start deferred while Tool Search is active (`toolSearchEnabled`),
  loaded through `ToolSearch` on first use. This is the only way a built-in defers.
- **`McpSdkServerConfig.toolNames`** — plain names for an in-process server's tools (`{ browser:
  "Browser" }`). The model, the transcript, hooks and `canUseTool` all see the plain name. The call still
  reaches the host as `sdk_mcp_call` with the server's own tool name, and the tool still defers like an
  MCP tool. The `mcp__<server>__<tool>` spelling stays an equivalent identity for permission rules,
  `disallowedTools` and hook matchers; when one of those names it, the call is evaluated under that
  spelling, as for an alias. A plain name that collides with another tool refuses the session. The old
  spelling also selects the tool in a model call, `ToolSearch`'s `select:` and an agent definition's
  `tools`.
- **`Options.legacyToolNames`** — `{ <old name>: <current tool name> }` for a host's own renamed tool:
  the old name keeps working in calls, `select:`, agent definitions, rules, `disallowedTools` and hook
  matchers.
- **`Options.reservedMcpServerNames`** — server names only the host's own `type: "sdk"` servers may
  take; any other server under one (settings, project, plugin, explicit non-sdk, `mcp_set_servers`) is
  refused, and an agent definition's inline server is renamed.

- **`Options.web`** — `search.enabled`, `search.authRef` (the backend key, used only once the
  anonymous tier is exhausted), `search.maxSearchesPerCall` / `search.anonymousMaxSearchesPerCall`,
  `fetch.digestModel` / `fetch.authRef` (the page-digest model and its own credential),
  `fetch.privateAddressPolicy` (`"ask"` by default, `"deny"` / `"allow"`), and one `blockedDomains`
  floor both tools honour (suffix match on a label boundary: `example.com` covers
  `docs.example.com`). Every field is optional; `resolveWebToolsConfig` + `WEB_TOOLS_DEFAULTS` are
  exported for a host that wants the resolved shape. **An unattended host should set
  `fetch.privateAddressPolicy: "deny"`** — under the default a private or loopback target raises a real
  permission prompt, and a session that cannot prompt refuses the call.
- **`Options.autoMemory`** — `enabled` and `directory` for the auto-memory section, for a host that
  runs with `settingSources: []` and therefore cannot reach `autoMemoryEnabled` /
  `autoMemoryDirectory` in a settings file. Precedence per field: this option, then the settings key,
  then the computed default (`<home>/projects/<memory-key>/memory`, enabled). A relocated directory
  under the home's own `projects/` tree stays write-denied.

Subagents inherit both.

### Resuming subagents after a runtime restart

With session persistence enabled, resume the parent against the same durable store and workspace.
Its saved children are listed under their original IDs and names. `SendMessage` can continue a
child created with a durable execution snapshot: a new engine generation reads its earlier
conversation and retained persona instead of rerunning the original task. Children are not started
automatically merely because the parent resumes.

This preserves agent history, not live shell processes or sockets. A child recorded as running
when its runtime exited is restored as stopped. Its saved tool and permission restrictions remain
constraints, and the current parent can narrow access further. Credentials and MCP transport
configuration are supplied by the current host; child-scoped MCP transports require the original
named agent definition to be available for reattachment.

Older child records without an execution snapshot remain readable/listable but cannot be safely
continued. Missing or corrupt history, a removed isolated worktree, or unavailable required
configuration produces a typed refusal rather than a fresh child with empty history. Forking the
parent does not inherit the original session's children.

### Messaging a host's other sessions (0.0.39)

**`Options.hostMessaging`** — `{ send, list }`, for a host that runs many sessions (one process or one
Worker each) and wants `SendMessage` and `ListAgents` to reach the others. With it set, `query()` puts
`hostMessaging: true` on the wire and answers two runtime → host control requests,
`host_message_send` and `host_message_list` (`HOST_MESSAGE_SEND_SUBTYPE` / `HOST_MESSAGE_LIST_SUBTYPE`),
the same way for a spawned `winter` process and an embedded Worker:

- `SendMessage` resolves `to` in-process first — the session's own subagents, then the in-process
  peers. Only a `not_found` there goes to `send`, with the model's raw `to`, the message, its summary,
  `notifyWhenIdle`, the runtime's message id and (for a subagent's call) `fromAgentId`. The host's
  answer (`delivered`, `queued`, `resumed_and_delivered`, `refused`, `not_found`, `unavailable`,
  `delivery_uncertain`, plus an optional `notify` fact and a one-sentence `note`) is the tool's
  result under the runtime's message id, so a retry of the same tool call is answered from the
  ledger and never asks the host twice. A throwing or malformed `send` is `delivery_uncertain`.
- `ListAgents` lists the subagents, then the sessions `list` returns as `session` rows, ending with
  a count of the ones the host left out (`omitted`) — a listing is never silently cut. A failing
  `list` lists nothing more.
- `TaskStop` with a `task_id` that names no task of this session goes to the optional `stop`
  (`host_session_stop`): the host interrupts that session's running turn and answers `stopped`,
  `not_running`, `refused`, `not_found` or `unavailable`.
- The calling tool's abort signal travels with the request: an interrupted call cancels it
  (`control_cancel_request`), and the handler's own `signal` aborts so the host can skip the delivery.

The handler is per session and never told who is sending: it knows its caller by construction. The
router core reaches the same seam through `MessagingRuntimeDeps.hostMessaging` (a `HostMessagingPort`
per owning session, on the `/messaging` subpath). Without the option, nothing changes.

### The 0.0.16 background-default change

Before 0.0.16, an Agent tool call with no `run_in_background` ran in the **foreground** (this call
does not return until the spawned agent finishes). From 0.0.16 on, matching claude, the same
unflagged call runs in the **background** by default: the call returns immediately with a task id,
and the model is told about the result later as a task notification (mid-turn, or as its own
unsolicited turn). `run_in_background: false` still asks for the old, synchronous behavior on any
one call. A host that wants the *default* itself to stay foreground — without losing the
`run_in_background` field or forcing every call to name it explicitly — sets
`Options.backgroundByDefault: false` (or `WINTER_BACKGROUND_BY_DEFAULT=false`); the kill switch,
`WINTER_DISABLE_BACKGROUND_TASKS`, is unrelated and unaffected by this knob in either direction.

## License

MIT — see [`LICENSE`](./LICENSE), which ships in the published tarball.
