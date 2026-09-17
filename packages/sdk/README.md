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
