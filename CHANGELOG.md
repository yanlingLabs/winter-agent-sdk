# Changelog

All notable changes to the Winter Agent SDK are recorded here. Versions follow the repo's own
`VERSION` file (bumped via `bun run version:bump`, synced via `bun run version:sync`); each entry
corresponds to one `chore(release): vX.Y.Z` commit.

## 0.0.33

### MCP (WS-27)

#### Fixes

- A turn that starts while an MCP server is reconnecting now waits for the reconnect, so it gets that
  server's tools. This closes the consequence 0.0.32 accepted. The connecting control subtypes
  (`mcp_reconnect`, `mcp_toggle`, `mcp_set_servers`) are recorded, with the server names they touch,
  when the pump dispatches them. At turn start the turn waits for the outstanding ones, then for any
  of those servers still `pending` (`mcp_set_servers` starts its connects without waiting for them).
  The wait has the first-turn wait's scope (only the engine's own MCP lifecycle, never a host-owned
  stack) and its bound (`firstTurnMcpWaitMs()`: 2 s, or `MCP_TIMEOUT` for an explicit host server), so
  a reconnect that never finishes delays the turn only up to that bound. `mcp_status` never holds a
  turn. The wait runs inside the ACTIVE turn -- after the session reports `running` and the interrupt
  is installed -- and never in the input pump:
  - a brokered reconnect's `credential_resolve` is still answered while the turn waits;
  - an interrupt ends the wait at once, and the turn ends interrupted with no generation -- skipping
    command resolution and the UserPromptSubmit hook as well;
  - a built-in command (`/compact`) skips the wait altogether: it never becomes a provider turn;
  - a `compact` arriving meanwhile is answered `busy`;
  - `end_input` right behind the held turn is clean.

  Pinned by `mcp-auth/brokered-reconnect.test.ts`, where the host answers the reconnect's sign-in read
  late, and `engine.test.ts`, where a hung reconnect holds the turn for the 2 s bound, not the 20 s
  `MCP_TIMEOUT`.
- An elicitation that stops mattering is now cancelled all the way to the host. `Options.onElicitation`'s
  `options.signal` now aborts when:
  - the MCP server cancels its `elicitation/create`;
  - the originating call is cancelled, for a 2026-07-28 `input_required` elicitation;
  - the tool call that raised it ends, including on a turn interrupt;
  - the query is aborted.

  The runtime sends a `control_cancel_request` and answers the server `cancel`. A host answer that
  arrives afterwards is dropped and never written. MCP tool calls now carry the tool execution's abort,
  which sends `notifications/cancelled`. A 2025-era server-to-client request does not say which call
  raised it, so the elicitation is cancelled once every tool call that was in flight on that connection
  when it arrived has ended. With one call in flight that is exact; with several, it is never early.
  Before this, the host's prompt stayed up until the host's own timeout.

#### Added

- **The exact MCP server identity on tool calls** (Winter-only, optional; absent on older runtimes):
  - `winter_mcp_server: { name, config_name, read_only_hint? }` on the PreToolUse, PostToolUse and
    PostToolUseFailure hook input. Both input builders carry it: the SDK callback's and a command
    hook's stdin. The type is `WinterMcpServerHookField`.
  - `mcpServer: { name, configName, readOnlyHint? }` on `canUseTool`'s options. The type is
    `McpServerIdentity`.

  The fields mean:
  - `name` is the server as it appears in the called tool's name, after any rename. A subagent
    definition's inline server that collides is connected as `srv_2`, and `name` is then `srv_2`.
  - `config_name`/`configName` is the key before the rename. For a plugin server, it is the raw name
    its `.mcp.json` declares.
  - `read_only_hint`/`readOnlyHint` is the tool's own `annotations.readOnlyHint`, only when the server
    states it.

  The engine computes the identity once per call from the name the model called, and the hook runner
  carries only what the engine computed -- it never derives one from the hook's subject. A renamed
  server's gating hook can run under its declared spelling, which the registry resolves to a different
  server. The identity covers the in-process `sdk` servers too. A server served from the discovery
  cache (`cached`, no live connection yet) states no `readOnlyHint` until it is connected again.

### Workflows

- A workflow worker that exits 77 -- a host's worker refusing to run outside a sandbox that denies
  Keychain access -- now fails the run with "workflow sandbox not in effect — the workflow worker
  refused to run (exit 77)", followed by the worker's last non-empty stderr line when there is one. Any
  other exit keeps the crash text. The real spawner now reads (and so drains) the worker's stderr through
  a streaming UTF-8 decoder, keeping only a bounded tail: an unterminated line holds at most its last
  4096 characters, the reported line is capped at 500, and control and bidi characters (U+202A-202E,
  U+2066-2069, U+200E/200F) are stripped from it.
- The package entry exports `buildWorkflowWorkerSeatbeltProfile` (with its `SandboxBrand` type), so a
  host that spawns the runtime's worker can pin its own profile against it, and
  `WORKFLOW_SANDBOX_REFUSED_EXIT_CODE`.

### Provider catalog (WS-27)

- **Tool-calling evidence, NVIDIA.** 25 rows are now `native` and 16 are `none`.
  - Where the model page's structured capability record (`modelCapability.functionCalling`) states it,
    the row is `declared`.
  - It is `inferred` where the build page is gone or silent and the evidence is the model reference or
    NIM guide instead. That covers kimi-k2.6, the two llama-3.2 vision rows, llama-3.2-3b and
    devstral-2.
  - The two nemotron content-safety classifiers are `none` at `inferred`: their pages' capability
    record says `functionCalling: true`, and the ruling overrides that on the model's purpose.
  - `stockmark-2-100b-instruct` and `llama-4-maverick-17b-128e-instruct` stay `unknown`. Maverick is
    absent from NVIDIA's live model list, so a guide covering the model is not evidence for this
    endpoint.
- **Tool-calling evidence, Anthropic-dialect endpoints.** An official vendor page telling users to point
  Claude Code at the endpoint counts as tool-use evidence, at `inferred`. These rows are now `native`:
  Tencent Token Plan (12), Tencent Coding Plan (2), Qianfan Coding Plan (8), Z.AI (6) and AgentRouter's
  two Claude Opus rows. `wafer/DeepSeek-V4-Pro` is `native` at `declared`: Wafer's unauthenticated public
  model list (`https://pass.wafer.ai/v1/models`) states `capabilities.messages.supported: true` and
  `messages.tools: true` for it, so the provider's Anthropic Messages binding is right. These stay
  `unknown`:
  - Wafer's GLM-5.1, MiniMax-M2.7 and Qwen3.5-397B-A17B: absent from that live list, which the rows'
    citations say.
  - AgentRouter's `gpt-5.6-sol`: the guide routes only the Opus models over Anthropic.
  - `qianfan-anthropic`'s ERNIE rows, the two `hy-role` rows and tabitoken.
- **Space Bunny** (a stealth model with an undisclosed maker; no family is stated, so both rows stamp
  `other`):
  - `opencode/space-bunny-free` and `openrouter/stealth/space-bunny-alpha`.
  - Both are free for a limited time. The zero price is recorded with its observation date,
    2026-09-27.
  - The data-handling terms are on the provider rows' risk reasons. Zen's vendor claims zero retention;
    under OpenRouter's stealth terms, prompts and completions may be collected for training.
  - The OpenRouter row carries OpenRouter's own entry: 1M context, 524,288 output tokens,
    text/image/video input, `native` tools, and mandatory reasoning with efforts `max`…`low` (default
    `max`).
  - The Zen row is `native` at `inferred`, on the same ruling as a vendor's Claude Code guide: OpenCode
    Zen is the model gateway of the OpenCode coding agent, and https://opencode.ai/docs/zen/ lists
    `space-bunny-free` for use in that agent. Otherwise it states only what Zen's docs state: there is
    no context, modality or effort data, because the only other source is a third-party mirror.
- **`opencode/big-pickle`** is `native` at `inferred` on the same coding-agent-gateway ruling, with the
  same citation shape as Space Bunny on Zen -- the ruling applied consistently to Zen's rows.

## 0.0.32

### MCP reconnect (host-brokered sign-ins)

#### Fixes

- `Query.reconnectMcpServer` (the runtime's `mcp_reconnect`) on a host-brokered session no longer
  deadlocks against its own sign-in read. The engine's input pump awaited the MCP control subtypes
  (`mcp_reconnect`, `mcp_toggle`, `mcp_set_servers`) inline, and a reconnect of an OAuth `http`/`sse`
  server reads the sign-in over `credential_resolve` -- whose answer only that same pump routes back.
  So a reconnect after a sign-in (or a sign-out) failed with "the sign-in check exceeded <MCP_TIMEOUT>ms"
  (the slot `failed`, never `connected`/`needs-auth`), and every later control request queued behind it.
  The four MCP control subtypes now run beside the pump on one serial chain (arrival order among
  themselves kept) and answer when they settle, like `compact`. Pinned by
  `mcp-auth/brokered-reconnect.test.ts` (sign-out -> needs-auth, sign-in -> connected, the tool runs again).
  Teardown waits for the chain before the MCP lifecycle is disposed, so a reconnect still in flight never
  commits a client or registers tools after the run ends, and every queued request is answered once.
  Accepted consequence: a turn that starts while a reconnect is still connecting no longer waits for it,
  so that turn does not see the server's tools (the next one does).

## 0.0.31

### Init order (credential before init)

#### Fixes

- A host-brokered session (`Options.onCredentialResolve`, i.e. `hostCredentials: true`) with a signed-in
  OAuth `http`/`sse` MCP server no longer dies at start with `query()`'s `protocol violation: expected
  'init' as the first frame, got 'control_request'`. The runtime launched its MCP connects before writing
  the `type:"init"` handshake, and the connect's token read went out as a `credential_resolve` ahead of
  it. The engine now builds its control bridge HOLDING (`createRpcBridge(output, { holdUntilOpen: true })`)
  and opens it right after the handshake, so no runtime->host request -- `credential_resolve`,
  `mcp_oauth_refresh`, elicitation, the wiring's credential-presence probes, a read parked on the host
  channel -- can precede it; one that settles while held (timeout, abort, cancel) is never written, and no
  `control_cancel_request` is sent for it. Both topologies (a spawned `winter`, an embedded Worker).
- An `alwaysLoad` MCP server (or the whole batch under `MCP_CONNECTION_NONBLOCKING=0`) whose connect needs a
  host answer no longer waits out `MCP_CONNECT_TIMEOUT_MS` and comes up pending: startup awaited it before
  the input pump that routes the answer existed. The lifecycle's new `launch()` starts the connects and
  hands the startup wait back; the engine awaits it after the pump, before `system/init` (which still
  reports the server `connected`). The internal `type:"init"` handshake now reflects such a server as
  launched; `query()` reads only its protocol version.
- `query()` stays strict about the first frame (a request before `init` is a runtime bug); its refusal now
  names a `control_request`'s subtype.
- `verify:mcp-oauth` asserts the handshake is every leg's first frame and adds a brokered `alwaysLoad` leg
  with an expired sign-in.

## 0.0.30

### MCP OAuth (WS-25)

- New public subpath `@yanlinglabs/winter-agent-runtime/mcp-auth` (main-thread safe) for the HOST that
  owns MCP sign-ins: `startMcpOAuthLogin` (discovery incl. RFC 9728 and the legacy metadata-less
  fallback, registration pre-registered > CIMD (when advertised) > DCR, PKCE S256, a loopback listener
  bound and registered as the same `http://127.0.0.1:<port>/callback`, a 32-byte `state` checked before
  the code is redeemed, one flow per server, a 5-minute bound), `refreshMcpOAuthToken` (single-flight per
  account, a generation re-read before posting, `invalid_grant` clears the sign-in, `invalid_client`
  clears the registration), `revokeMcpOAuth` (best-effort RFC 7009, then the local sign-out; the client
  registration is kept unless `forgetClient`), `mcpOAuthAccountId` (the Keychain key: sha256 of the
  canonical server URL), the two record types and their codec (an unknown `v` is refused typed), the
  `McpOAuthStore` seam, `validateMcpOAuthConfig`, and `WINTER_MCP_CLIENT_METADATA_URL`
  (`https://yanlinglabs.com/winter/oauth-client.json`).
- Every auth request goes through one policy: HTTPS except a literal loopback address, literal
  private/link-local addresses refused, no cross-origin redirects, size caps (over `boundedFetch`).
- Remote (`http`/`sse`) MCP servers without a static `Authorization` header connect with a READ-ONLY
  bearer provider reading the session's Keychain. At connect a usable token is used as is (never
  refreshed), an expired one with a refresh token is refreshed by asking the host over the new
  `mcp_oauth_refresh` control request (names only; `Options.onMcpOAuthRefresh` answers it; a host with no
  handler leaves the session to refresh in-process), and an expired one without a refresh token is
  `needs-auth` with no request sent. A `needs-auth` server's tools are not registered; a call that finds
  the sign-in gone withdraws them and answers with the door (`winter mcp login <server>`); a `403
  insufficient_scope` fails only that call and the host records the scope for the next sign-in. The
  model is told which servers need sign-in through a persisted `mcp_needs_auth` attachment. Authenticated
  MCP traffic refuses redirects. New `McpConnectErrorCode` `auth_refresh_failed` (a refresh that could not
  run now).
- `validateServerConfig` accepts `oauth` on http/sse servers (`clientId`, `clientSecretRef`, `callbackPort`,
  `authServerMetadataUrl`, `scopes`) and refuses it elsewhere. `clientSecretRef` is `{ kind: "keychain" }`
  only -- a marker that a pre-registered secret exists: its Keychain account is always DERIVED from the
  server URL (`mcp-oauth-client-secret:<id>`, `mcpOAuthClientSecretAccount`); a config naming an account or
  a service is refused.
- The sign-in's code exchange is posted exactly once (never retried) and reports OAuth error codes only;
  concurrent sign-ins for one server leave one listener; a sign-in that ends during its exchange writes
  nothing; `startMcpOAuthLogin` also returns `authorizeOrigin`. Auth requests reach a loopback address
  only when the MCP server itself is on loopback, and the whole exchange (body included) is time-bounded.
- `Query.reconnectMcpServer(serverName)` (over `mcp_reconnect`); `/mcp-client`'s `connectMcpServer` takes an
  optional `oauthStore`.
- `bun run verify:mcp-oauth`: a compiled host signs in against a fixture authorization server, a compiled
  session connects on the stored token, refreshes through a fake host, and is `needs-auth` without a
  refresh token. Sessions read the `WINTER_TEST_MCP_OAUTH_STORE_FILE` test store instead of the Keychain
  only when it is in the ORIGINAL process environment (every settings tier refuses the name) and the
  session names a non-default Keychain service (the gates only).
- Cross-lane fix (daemon origin-only comparison): `StartMcpOAuthLogin`'s result now carries `issuer`, the
  full verified issuer string alongside `issuerOrigin`/`authorizeOrigin` -- a host that compared servers by
  ORIGIN alone could not tell two tenants apart behind one reverse-proxy origin
  (`https://host/tenant/a` vs `https://host/tenant/b`). New `discoverMcpOAuthIssuer({ serverUrl, oauth?,
  fetch? })`: a side-effect-free discovery (PRM -> AS metadata, or the configured
  `oauth.authServerMetadataUrl` under the same RFC 8414 issuer-location check `startMcpOAuthLogin` uses) --
  no registration, no code exchange, no store read or write, no listener -- for a caller that must know a
  server's issuer before, or without, an interactive sign-in. `records.ts`'s `sameIssuer` (exact, or
  differing only by one trailing slash) is now re-exported from `/mcp-auth` as THE comparison every caller
  uses to tell servers apart; `loadAuthorizationServer`'s own issuer check was folded into it so there is
  only one implementation.

### Prompt-free credentials (WS-25 §7)

- A host that sets `Options.onCredentialResolve` resolves every Keychain credential its session reads:
  `query()` puts `hostCredentials: true` on the wire (a flag only), and the runtime sends
  `{ subtype: "credential_resolve", ref, minGeneration? }` -> `{ ok: true, material, expiresAt?, generation }
  | { ok: false, reason: "not_found" | "not_allowed" | "stale" | "unavailable" }` instead of reading the
  Keychain -- provider auth, advisor/web/cross-provider refs, tool keys (Exa) and MCP sign-ins alike. No
  Keychain store is built in such a session, so a child binary never raises a macOS consent prompt.
- Such a session never persists a credential and holds no refresh token: `set`/`delete` refuse typed;
  `CredentialStore.refresh` (new, optional, provider-runtime) makes `refreshOauthMaterial` ASK the host for
  a newer generation (`minGeneration`) instead of posting a grant; MCP sessions read their token records
  through the host (`toSessionMcpTokenRecord` masks the refresh token with
  `MCP_OAUTH_HOST_HELD_REFRESH_TOKEN`), and never refresh in-process.
- The material travels only in the control_response frame; it reaches no frame the host iterates, no
  stderr line and no file under the session's home (tested end to end). Standalone SDK users (no
  handler) keep the Keychain store.

## 0.0.29

### Security (no-autoload)

- The compiled `winter` runtime no longer reads a `bunfig.toml` or `.env` file from the directory it
  is started in. It runs with the session's working directory, so previously a repository's own
  files could change how the runtime started. `verify:compiled` now proves this on the built binary.

## 0.0.28

### Engine (WS-24)

- A subagent with its own object-form MCP servers waits for them (bounded, 2 s) before its first
  request, as the session does, so a server that connects within that is offered on it.
- A subagent's inline MCP server whose name the session (or a live sibling) already uses no longer
  replaces and then unregisters the session's tools: it is connected under a fresh name (`srv_2`, ...)
  for that subagent, which is told so on its first turn. Its definition's `disallowedTools`, and every
  rule and hook matcher written against the declared name, keep governing it. A colliding in-process
  (`sdk`) server is not connected (the note says whether the session's own is used instead).
- Control requests (interrupt, `set_model`, `set_permission_mode`, `mcp_status`, ...) are answered while
  the first-turn MCP wait runs; a user message still waits for the servers. The `type:"init"` handshake
  now reflects the servers as they stood before that wait; `system/init` still reflects them after it.
- A fork can run a tool it loads itself through ToolSearch; its `tools` (the parent's exact layout)
  never moves. A tool the frozen list does not declare is callable only where the definition travels by
  a documented mechanism (OpenAI's client `tool_search`) or on a row with the new live-probe-proven
  catalog key `model.undeclaredToolCalls` (gathered by `scripts/probe-fork-undeclared-tool.ts`; set, from
  its 2026-09-26 run, on `anthropic/claude-opus-5-5`, `anthropic/claude-sonnet-5` and
  `deepseek/deepseek-flash`), where it rides the ToolSearch result as text. Elsewhere such a call keeps its
  "No such tool available".
- The one-time request-feature fallbacks (per-message effort, mid-conversation tool changes, OpenAI
  client `tool_search`, `tool_choice: allowed_tools`) are kept per provider+model and persisted as a
  `feature-rejected` provider-state record, so a resume skips the doomed request and another model
  still gets the feature.
- A subagent's own system frames (hook notices, continuity warnings, model switches, compaction,
  hook lifecycle, permission outcomes, session state) carry the spawning call's `parent_tool_use_id`,
  so a host threading by it keeps them on the subagent's thread; the task-registry frames are unchanged.
- approvals: re-check the target at execution.

### MCP and hooks (WS-24)

- **Async hooks.** A settings/plugin command handler with `async: true`, or a command hook whose first stdout
  line is `{"async": true, "asyncTimeout"?: <ms>}`, runs in the background: the event never waits for it,
  and it can never allow, deny, rewrite or stop anything (every decision field it returns is ignored). What
  it prints when it finishes -- `systemMessage` and `additionalContext` only (plain text for
  `UserPromptSubmit`/`SessionStart`/`SubagentStart`) -- reaches the model at the next point the engine
  appends hook context (after a tool round, with the next prompt, after a compaction) as an
  `async_hook_response` `<system-reminder>`, never mid-request; a `systemMessage` is also the host's
  `system/informational` notice. Bounded: its timeout is `asyncTimeout` when announced, else the handler's `timeout`, else
  10 minutes; at most 16 run at once per engine (a 17th is refused and killed; a subagent's engine has its own
  queue, so a session with N live subagents can hold (N + 1) x 16); at most 16 finished outputs wait for
  delivery (the oldest is dropped, and the model is told how many); texts are capped like every hook's; an
  engine's end kills its own. `async` is refused at registration -- the hook is kept and runs synchronously,
  and the refusal is reported -- on a fail-closed `PreToolUse`/`PermissionRequest` hook (a floor must gate the
  call) and on `SessionEnd` (the session's teardown would kill it at once); a fail-closed gating hook announcing
  `{"async": true}` is malformed output (a deny), as before.
- **MCP provenance on hook inputs.** For a tool a connected MCP server registered, `PreToolUse`, `PostToolUse`,
  `PostToolUseFailure`, `PermissionRequest` and `PermissionDenied` inputs carry `mcp_server_name` and
  `mcp_tool_name` beside `tool_name`, on the callback (`HookInput`) and the command-hook stdin alike.
  `mcp_server_name` is the server's name AS REGISTERED -- the name in `tool_name`, which for a subagent's own
  server can differ from the name it was declared under -- read from the registry's owner index, never by
  splitting `tool_name` (server names may contain `__`).
  Additive: `HookInvocationPayload` gains `mcpServerName`/`mcpToolName`; the new `McpToolProvenance` type is
  exported.
- **A timed-out callback hook is cancelled on the host.** When the runner gives up on a hook callback, the
  runtime now writes `control_cancel_request` for it and the wrapper aborts the callback's `signal` (as it
  already did for a permission prompt) -- a timed-out reviewer no longer keeps working for an answer nobody
  reads. (A "direct" hook invoker for embedded sessions was assessed and not built: the host's callbacks live
  on its main thread, so an embedded call crosses the Worker boundary as one message either way.)
- **MCP connect failures are classified by cause.** New `McpConnectErrorCode`s: `version_mismatch` (a `{pin}`
  the server did not offer, or a server that named its versions and none is ours -- was `handshake_failed`)
  and `transport_closed` (a stdio server that exited by itself during the attempt -- was `handshake_failed`
  on the probe, `unknown` during `initialize`). `McpConnectErrorCode` is an open set that may grow again: a
  host switching on it exhaustively needs a default branch. The `auto` legacy retry never spends a second connection on a
  version mismatch, and announces a fallback once per server and cause.
- **stdio `auto` is safe on every legacy server**, and stays opt-in. A server that answers the
  `server/discover` probe, or ignores it (the transport now reads as stdio to the v2 client, so silence
  settles the legacy era on the same pipe), keeps its one process; one that exits on it is respawned once in
  `legacy`. `stdio` and `sse` still default to `legacy`: a server that ignores the probe would pay its bound
  (up to 5 s) on every connect, past the 5 s first-turn batch deadline, and one that exits on it would start
  twice, for no 2026-07-28 feature a stdio server needs today.
- **A discovery-cached MCP server becomes `connected` at its first live call.** It used to stay `cached` with a
  live connection behind it, so a tool-list change it announced was parked forever and `RefreshMcpTools` and
  the resource tools refused it.
- **New public subpath `@yanlinglabs/winter-agent-runtime/mcp-client`**: `connectMcpServer`,
  `ConnectedMcpClient`, `McpConnectError` (+ its codes, the tool/resource shapes, `resolveVersionNegotiation`)
  and `createElicitationAsker` -- the runtime's own MCP client, for a host that talks to MCP servers itself.
  Its `ConnectMcpServerOptions` is the host-shaped subset (`name`, a stdio/http/sse `config`,
  `connectTimeoutMs`, `elicitationAsk`, `cwd`).
  It loads no engine state, so a host may import it on its main thread.
- `verify:mcp-compiled` gains two legs: stdio `auto` against a server that exits on the probe, and a
  2026-07-28 Streamable HTTP endpoint (the modern era, compiled).
- **Embedded sessions mirror their process groups to the host.** Every `detached` spawn in a session's realm
  -- Bash/Monitor commands (foreground and background), stdio MCP servers, command hooks, the workflow
  worker -- is recorded while its group lives (`process-groups.ts`), and an embedded Worker posts each change
  (`EmbeddedProcessGroupMessage`). `EmbeddedWorkerProcess.processGroups()` lists what is still live, readable
  after `exited` settles: a host SIGKILLs those when a Worker was terminated or crashed (a healthy close
  leaves it empty: a finished session's `exit` waits up to 250 ms for its teardown's kills to be reported,
  and the list never names the host's own pid). A spawned `winter` child that is SIGKILLed still orphans its groups; there is no cheap
  equivalent (the ledger would have to ride the frame stream).
- **Test network guard: children really inherit the block.** On Bun 1.3 the proxy variables are
  non-enumerable, so every `{ ...process.env }` -- the guard's own injected environment included -- dropped
  them and no child saw the recording proxy. They are now enumerable accessors that keep Bun's write-through,
  and `exec`/`execSync` (shell children, e.g. a test shelling out to `curl`) are wrapped too (a `null` options
  argument is replaced, never shifted, and `util.promisify(exec)` keeps its shape). CI's Bun (1.4)
  already enumerated them, so this aligns a local run with CI; `withNpmRegistryAccess` is unchanged.

### Providers (WS-24)

- `reasoning_tokens` joins the normalized `usage` event (`reasoningTokens`, additive) and threads through the Responses adapter (openai, codex-oauth and xai's API-key row, which all share it), the bridge's fold, and the result's `output_tokens_details.thinking_tokens` (previously hard-coded to 0). Anthropic reports no separate count and stays absent.
- Chat Completions no longer falls back to `api.openai.com` for a provider with no resolved endpoint, on either of two layers: a HAND-WIRED adapter (no `generatedBaseUrls` option) now refuses every provider but `openai` typed, via the new `vendorFallbackFor` (mirroring the Responses adapter's WS-23 fix); the SHIPPED wiring (`createShippedAdapters`) gained the per-provider `generatedBaseUrls` lookup the Responses adapter already had, which TAKES PRECEDENCE over `vendorFallbackFor` once set (`resolveEndpoint`'s own rule) -- so in the shipped path `openai` is ALSO refused (it has no row on this adapter at all; its models run on Responses), a deliberate deviation from the brief's literal "except `openai`" that the tests assert directly. Either way nothing is ever silently routed to OpenAI's host for a provider that isn't openai.
- Verified (no code change): a parallel tool batch renders as one assistant message on chat-completions dialects. Fix round 24 (2026-09-24, pre-dating this batch) already merges any run of consecutive assistant tool-call entries by adjacency alone, regardless of origin; added the brief's exact acceptance tests to `chat-completions.test.ts`.
- `createEndpointResolver`'s cache no longer echoes a stale `family`/`continuationDomain` fallback: only the registry-derived half of a `ContinuityEndpoint` is memoized per (`providerId`, `modelKey`); the caller's own `origin.family` and its domain fallback are recombined on every call. A second message for the same model under a different stamped family (or a different fallback domain) used to get the first caller's values silently, which could raise a spurious lossy-switch prompt (or suppress a real one). The catalog's `modelFamily: "claude"` lineage label and the adapter's own `family: "anthropic"` wire-protocol label remain two deliberately separate taxonomies (`registry.ts`'s `ProviderAdapter.family` vs. the catalog's `WinterModelDescriptor.modelFamily`) -- not unified in this batch; see the report.
- `reviewModelSwitch` accepts an optional `midTurnAbort` (default `false`) and threads it into its own `classifySwitch` call -- the pre-flight switch review had no way to learn that a switch follows an interrupt (`switchFactsFor`'s own `midTurnAbort` stays hard-coded `false`, honestly, since it reads a snapshot). No caller in this repo passes it yet -- the router's `reviewSwitch` (out of scope for this lane) is the one caller that could, and CLAUDE.md's own text says the daemon DEFERS a switch during a running turn rather than aborting it, so today's callers likely always pass `false`; the field is correct and inert until a caller actually aborts mid-turn. The engine's OWN `classifySwitch` call site (`announceLossyTransfer`) already threads the identical fact post-hoc, unaffected by this change.
- The bash-safety classifier now works on a row whose forced `tool_choice` the Anthropic adapter must downgrade to an ordinary one (Opus 5.5 / Fable 5.1's documented 400 on a forced choice): the system prompt tells such a model to answer with exactly one JSON object in the tool's own shape when it cannot call the tool, and `collapseTurn` recovers that answer through the SAME schema and namespacing the tool-call path uses. Strict, never lenient -- no bracket-scanning inside prose, no markdown-fence stripping; an unparseable or schema-invalid reply still escalates to `no_verdict`, same as before.
- CLOSED AS MOOT (assessed, no code change): `renderer.ts`'s official-leg structural fallback (assuming `providerId: "anthropic"` from a bare `message.model` when no origin exists) does not affect a Winter-native `console/*` session -- `engine.ts`'s `recordAssistant` stamps a real `origin.providerId: "console"` on every entry such a session writes, so the fallback (only reached when `message.origin` AND the sidecar chain are BOTH absent) is never consulted for one. Added `renderer.test.ts` coverage proving a console-origin entry decorates/replays using the console row's own catalog facts, and that the fallback only ever activates for entries shaped like the RETIRED official leg's own (no origin at all) -- disposable legacy sessions per the user's own ruling.
- Chat Completions reads `completion_tokens_details.reasoning_tokens` (I-2) -- this dialect's own name for the same fact the Responses adapter's `output_tokens_details.reasoning_tokens` reports, so DeepSeek's `deepseek-reasoner` and any other row that documents it over this wire now folds into `reasoningTokens` too. Gemini's `thoughtsTokenCount` stays a follow-up, not fixed here.
- The bash-safety classifier's text-JSON fallback (WS-24 follow-up 6) is now gated (M-1): only a row whose descriptor lists `tool_choice.tool` in `unsupportedParameters` (today: the anthropic/console Opus 5.5 and Fable 5.1 rows -- the SAME evidence `resolveToolChoice` gates its forced-choice downgrade on) gets a text reply parsed as a JSON verdict. Everywhere else a text reply is unambiguously a misbehaving model and stays `no_tool_call`, never given a chance to recover -- which would otherwise let any model's ordinary refusal-to-call-the-tool quietly become a verdict. `createModelClassifier`'s new `forcedToolChoiceUnsupported` option carries the fact; `session-provider.ts`'s two construction sites read it off the resolved descriptor.
- Added a new `allowed-tools-cache` probe phase (fix round 1, M-3) to `scripts/probe-openai-midconv.ts`: isolates `tool_choice: allowed_tools` narrowing (once a tool is loaded via ToolSearch) from I-1's own plan-mode-block fix, to check whether the restriction itself is a SECOND, independent cache-busting cause `instructions_length` staying stable won't catch.
- CONFIRMED LIVE (the controller's `plan-cache` probe run) and FIXED (I-1): the request right after a plan-mode switch reading `cached=0` on OpenAI (and the equivalent cache-write-priced miss on Anthropic) was the plan-mode block sitting in the system prompt's dynamic half, ahead of the whole conversation history -- a toggle shifted every downstream token and busted the prefix for that one request, on every provider. Plan mode moved OUT of the system prompt entirely and into a persisted attachment at the TAIL of the conversation (`context/attachments.ts`'s `plan_mode`, produced by `engine.ts`'s own fold against the live permission mode): `system`/`tools` are now byte-identical across a toggle, and a toggle costs exactly one cache miss on the turn it happens rather than on every request while the mode holds steady. Added an `instructions_length`-reporting `plan-cache` probe phase to `scripts/probe-openai-midconv.ts` for the controller's re-run, and a hermetic engine-level proof (`context/request-layout.engine.test.ts`'s `plan_mode (WS-24 I-1)` describe block) that `system`/`tools` stay identical across the toggle now.

## 0.0.27

(0.0.25 and 0.0.26 were tagged but never published: their release workflows stopped at the test step. 0.0.26 fixed the release smoke's registry access; 0.0.27 fixes one test that deleted the release job's own `NODE_AUTH_TOKEN`/`NPM_CONFIG_USERCONFIG` during cleanup.)

WS-23: every model, Claude included, now runs on this SDK (the official `claude` leg is retired
from Winter). xAI moves to the Responses API; MCP moves to the TypeScript SDK v2; the hook system is
completed and can fail closed; the Anthropic path is hardened for code mode (stream-order content,
context-overflow recovery, Console bearer auth); prompt caching holds across effort switches (per-message
effort on Opus 5/5.5, Fable 5.1 and GPT-6), tool changes (Anthropic tool additions/removals/redefinitions,
OpenAI `tool_search`/`additional_tools`/`allowed_tools`) and model switches; every model's reasoning state
moves into the provider-state sidecar (the transcript becomes provider-neutral); the runtime ships as a
publishable package, `@yanlinglabs/winter-agent-runtime`, with an embedded (in-process Worker) entry.

### Release CI

- The release smoke reaches registry.npmjs.org through a narrow, credential-free opt-in (`withNpmRegistryAccess`); every other test stays network-blocked.
- Linux-host fixes for the embedded-Worker Bash test and the reasoning golden; the publish-routing dry runs are offline.

### Embedded runtime (WS-23)

- The runtime is published as `@yanlinglabs/winter-agent-runtime`. `runEmbeddedSession` (and its Bun
  Worker entry, `./embedded-host`) runs one session in-process with no process globals: argv, env,
  stdio and exit are parameters, and `main.ts` is a thin wrapper over the same function.
- Every child spawn (stdio MCP servers, the workflow worker, Bash, Monitor, hooks) takes the session cwd
  explicitly; a Worker has no cwd of its own. `process.chdir`/`process.umask(mask)` throw inside an
  embedded session.
- The workflow-worker command is injectable (a host embedding the runtime supplies its own).
- The wrapper, runtime and platform packages are pinned to one exact version.

### xAI on the Responses API

- The api-key `xai` provider (`https://api.x.ai/v1`) now runs on `winter.openai-responses` instead of
  `winter.openai-chat-completions`. xAI calls Responses its preferred API and Chat Completions "a legacy
  endpoint"; only Responses returns reasoning as a replayable encrypted item. Winter stays stateless on it:
  `store: false`, full history replayed each turn, never `previous_response_id`. `xai-oauth` is unchanged
  (still Chat Completions): its proxy's `/v1/responses` has never been probed.
- Every reasoning-capable `xai` row now records `continuation: "opaque-provider-state"`: reasoning carries
  across turns and tool loops as the encrypted item. `grok-4.7` alone also records a readable summary
  (`reasoning.summary`, sent as `detailed`). `grok-4.20-0309-reasoning` and `grok-build-0.1` keep an empty
  effort vocabulary because xAI documents no effort knob for them.
- New row `xai/grok-4.20-multi-agent-0309` (alias `grok-4.20-multi-agent`), Responses-only. Its effort picks
  the agent count (low/medium = 4, high/xhigh = 16). A `tools` array or an output cap is refused before
  the request, since xAI supports neither on this model.

### Responses adapter

- Each provider on the adapter now gets its own endpoint from its catalog row. A connection with no
  `baseUrl` for any provider other than `openai` used to fall back to `api.openai.com`, which would have
  sent an xAI key to OpenAI. It now reaches that provider's own host, or is refused with a typed
  `capability` error when the catalog names no host for it. Sessions built by the runtime are
  unaffected: they already copy each multi-provider row's endpoint into the connection.
- A row whose continuation is the encrypted reasoning item (`opaque-provider-state`) now asks for it
  (`include: ["reasoning.encrypted_content"]`) on every turn that does not switch reasoning off, even
  when no effort is named. Before, an effortless turn on such a model kept no reasoning for the next
  turn. This also applies to the opaque `openai/*` and `codex-oauth/*` rows (include only; no
  `reasoning` object is added).
- `response.reasoning_text.delta` now reaches the readable-reasoning channel as well as
  `response.reasoning_summary_text.delta`. It is treated as a summary unless the row records full
  exposed reasoning.
- A request with no tools no longer sends `tools`, `tool_choice` or `parallel_tool_calls`. The codex
  backend is the exception: it rejects a request missing them, so it still gets all three.
- `OpenAI-Organization` / `OpenAI-Project` are sent only on `openai` turns, never on another provider
  sharing the adapter.

### Errors

- `normalizeHttpError` also reads xAI's flat error body (`{"code": "<status text>", "error": "<message>"}`),
  alongside the structured `{error: {…}}` envelopes, whose handling is unchanged. Only a body whose keys
  are exactly `{error}` or `{error, code}` counts. The flat body's `code` becomes `providerCode`, and
  its message becomes the snippet. A wrong key, which xAI answers with HTTP 400 and a message starting
  "Incorrect API key provided", is now classified `auth`, so credential validation reports an invalid
  key instead of an unreachable endpoint.

### MCP: TypeScript SDK v2 and the 2026-07-28 protocol

- The runtime's MCP client moves from `@modelcontextprotocol/sdk` 1.30 to `@modelcontextprotocol/client` 2.1.0
  (`@modelcontextprotocol/server` 2.1.0 is a dev dependency for test fixtures only). v1 is gone from the lockfile,
  along with the Express/Hono server stack it brought in; the workspace's zod (4.5.4) already meets v2's `^4.2`.
  Every existing server keeps working: stdio, Streamable HTTP, legacy SSE and in-process servers all connect as
  before, and Winter keeps its own stdio transport (process-group kill, explicit env allowlist).
- New per-server `versionNegotiation` (`"legacy"` | `"auto"` | `{ pin: "<revision>" }`) on stdio, http and sse
  configs. Defaults: `"auto"` for `http` (probe `server/discover`, fall back to `initialize`), `"legacy"` for
  `stdio` (a probe on a live pipe can kill a legacy server) and `sse`. A malformed value is refused at config
  resolution; a pin the server does not offer fails the connect (`handshake_failed`), never falls back. The
  negotiated revision is reported per server as `protocolVersion` on `system/init.mcp_servers` and `mcp_status`.
- 2026-07-28 `input_required` results are fulfilled through the existing elicitation path: the host's
  `onElicitation` sees the same request shape whichever era a server negotiated, and with no callback the server
  still gets a deterministic decline. URL-mode elicitation is now declared and reaches `onElicitation` with
  `mode: "url"`, `url` and `elicitationId`. Accepted content that the protocol cannot carry (a nested value)
  declines instead of reaching the server.
- A server that advertises `tools.listChanged` gets its tools re-registered when it announces a change (on either
  era). A change announced while the server is disabled is applied when it is re-enabled.
- `type: "sdk"` MCP servers from settings, project `mcp.json` or plugin files are refused (`sdk_type_from_file_config`);
  only the host's `Options.mcpServers` can declare one. Every MCP config rejection now carries a `code`.
- HTTP 401 still maps to `needs-auth` under the v2 error classes (Streamable HTTP on both negotiation modes, and SSE).
  Web search (Exa) connects with `versionNegotiation: "legacy"` and classifies rate limits by HTTP status on v2's
  `SdkHttpError`.
- New gate `bun run verify:mcp-compiled`: the compiled `winter` binary connects to a stdio MCP server (legacy and
  `auto`) and completes a model-issued `tools/call`.

### Hooks (WS-23)

- **Fail-closed hooks.** `HookCallbackMatcher.failClosed` (and `failClosed: true` on a settings/plugin command
  handler or its matcher group) makes an error, timeout, throw or malformed output from a `PreToolUse` /
  `PermissionRequest` hook a DENY naming the hook and a failure code (never the error text or command line). Such a
  hook answering `async`, with another event's `hookSpecificOutput`, or with non-JSON stdout is malformed too; `{}`
  stays an allow. Default off: other hooks' failures stay non-blocking.
- **Matchers** follow claude's semantics: a pattern of only letters, digits, `_`, `|`, `,`, `-` and spaces is a
  list of exact names split on `|`/`,` and trimmed (`Edit|Write`, `Edit, Write`),
  anything else an unanchored regular-expression test (`mcp__.*`, `.*`); `""` and `*` match all. Winter's existing
  `mcp__srv__*` / `Tool(*)` globs keep their glob reading. A pattern that will not compile warns once and matches
  nothing -- or everything, for a fail-closed hook. `SessionStart`, `SubagentStart`/`SubagentStop`, `PreCompact`/`PostCompact` and `Notification`
  matchers filter on the event's subject (`source`, `agent_type`, `trigger`, `notification_type`).
- **Command hooks speak claude's wire:** snake_case stdin (`session_id`, `transcript_path`, `cwd`,
  `hook_event_name`, `permission_mode`, `tool_name`, `tool_input`, `tool_response`, `prompt`, ...); exit 2 blocks
  with stderr as the reason; other non-zero exits are non-blocking errors; plain-text stdout is context for
  `UserPromptSubmit`/`SessionStart`/`SubagentStart`. `CLAUDE_PROJECT_DIR` and `WINTER_PROJECT_DIR` are exported
  for every hook; a plugin hook gets `CLAUDE_PLUGIN_ROOT` / `WINTER_PLUGIN_ROOT` exported (the shell expands
  `${CLAUDE_PLUGIN_ROOT}` in the command). Project/local hooks still need a trusted workspace.
- **Every hook contribution is bounded,** with a visible truncation marker: 10,000 characters for context,
  feedback, reasons and notices; 100,000 for `updatedToolOutput`; 1 MiB of captured stdout.
- **`additionalContext` reaches the model** for `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
  `UserPromptSubmit`, `SessionStart` and `SubagentStart`, as a `<system-reminder>` at the conversation tail (inside
  the call's tool result, or with the prompt / first user turn), never in the system prompt.
- **Decisions that used to be ignored:** `Stop`/`SubagentStop` `decision: "block"` continues the turn with the
  reason fed to the model (`stop_hook_active` on the re-fire, capped at 8 continuations per turn);
  `UserPromptSubmit` `decision: "block"` drops the prompt and ends the turn with the reason; `continue: false`
  ends the turn (`terminal_reason: "hook_stopped"`); `systemMessage` is a new `system/informational` frame;
  `suppressOutput` hides a command hook's stdout from `hook_response`, which now carries command hooks'
  stdout/stderr/exit code; `PostToolUse` `updatedToolOutput` / `updatedMCPToolOutput` replaces the tool result.
- **`updatedInput` is validated** against the tool's input schema; an invalid one DENIES the call, whatever the
  model's original input was (previously the original input ran).
- **New events fire:** `SubagentStart` / `SubagentStop` from a subagent's engine (in place of `SessionStart` /
  `Stop`), and `SessionStart` with `source: "compact"` after a compaction.
- `UserPromptSubmit` now fires before the prompt is recorded (so a blocked prompt never enters the transcript).

### Claude in code mode (WS-23 Anthropic hardening)

- **Block order is kept end to end.** A response's thinking, text and tool calls are persisted and replayed in
  the order the model streamed them (`ProviderTurn.content`, additive); a `[thinking, text, thinking, tool_use]`
  turn used to come back as `[thinking, thinking, text, tool_use]`. WebSearch's inner tool loop now replays a
  round's thinking blocks too (it dropped them, a 400 on always-on-thinking models). Anthropic family only:
  other families keep the joined-text assembly (Gemini's text signatures are positional).
- **Context overflow recovers.** `model_context_window_exceeded` and the 400 "prompt is too long" (typed as
  `ProviderError.contextOverflow`) trigger the engine's own compaction and one retry of the round; a second
  overflow ends the turn with `terminal_reason: "prompt_too_long"`. The overflowed partial output is discarded.
- **`pause_turn`** continues the turn (bounded at 5 resends) instead of ending it.
- **Refusals are typed.** A `refusal` ends the turn with `is_error: true` and `terminal_reason: "refusal"`,
  is not persisted, never executes a half-streamed tool call, and the refusal frame carries
  `api_refusal_category` / `api_refusal_explanation` from the response's `stop_details`.
- **`max_tokens`** defaults to 64000 capped at the row's maximum, not the row's full 128K. A thinking budget
  grows it by a full 64000 of answer room (capped at the row). New disclosed option `Options.maxOutputTokens`
  (-> `TurnRequest.maxOutputTokens`) overrides it; above the row's maximum it is refused typed.
- **A tool call cut off by `max_tokens` never runs.** Every call of that turn gets an error result saying it
  was truncated, and the model re-issues it.
- **Mid-stream `overloaded_error`** arriving before any content is retried under the adapter's existing retry
  policy; after content it stays a final, typed error. Only that error replays: a torn connection is still
  final. The stream log counts only the committed attempt's bytes.
- **`ResultError`** now reads `<terminal_reason>: <result>` for an `is_error` result that names a reason
  (`refusal`, `prompt_too_long`, `pause_turn_limit`, `structured_output_retry_exhausted`); `api_error` keeps
  `provider request failed: ...`.
- **Interleaved thinking** on the budget-only 4.5 rows (Opus 4.5, Sonnet 4.5): `interleaved-thinking-2025-05-14`
  rides a request that carries a thinking budget and tools.
- **WebSearch works on Opus 5.5 / Fable 5.1.** The runtime runs the search for the tool's own input before any
  model call and hands the results to the inner model; nothing is forced any more (a forced `tool_choice` is a
  400 on those models). The output shape is unchanged. Behaviour change: when the inner model then fails
  (not wired, provider or auth error, over budget mid-pass), the result keeps the search's links plus a
  trailing note and is no longer `isError`; the search itself has been spent.
- **Console bearer auth.** The `console` provider gets the same bearer treatment as `anthropic`: the
  `oauth-2025-04-20` beta and the `anthropic:console` account guard. Winter still identifies as Winter. A
  cross-provider Console target (advisor reviewer, stated auxiliary model, subagent) resolves to the broker's
  `anthropic:console` record rather than a `console:default` nothing writes, and the Claude reviewer gate
  admits the `console-profile` auth kind.
- **Opus 5 disabled-at-xhigh/max** rewrites are logged once per session.

### Catalog data

- Dashed aliases (`claude-opus-4-6`, `-4-7`, `-4-8`, `claude-sonnet-4-6`) on the Opus 4.6/4.7/4.8 and Sonnet 4.6
  rows (anthropic + console), so transcripts the claude binary wrote resolve to their rows.
- Opus 5 records that disabled thinking is rejected at xhigh/max
  (`thinking.type.disabled+output_config.effort.{xhigh,max}`, a conjunction token); the adapter sends adaptive
  thinking for that combination instead of a request it knows will 400.

### Tooling

- `scripts/probe-anthropic-code.ts`: an opt-in live probe (`WINTER_ANTHROPIC_PROBE=1`) for the above.

### Prompt caching and per-message effort (WS-23)

- Effort can change while a session runs: `Query.setEffort(level)` (Winter's own `set_effort` control
  request), validated against the model's vocabulary and applied at the next turn boundary. On Claude Fable
  5.1, Opus 5.5 and Opus 5 the top-level `output_config.effort` stays fixed and the change rides a
  per-message `system` marker (`mid-conversation-output-config-2026-07-01`), so the cached prefix survives;
  if the API refuses the beta the session falls back, once and visibly, to changing the top-level value.
  Elsewhere a change is a new top-level value.
- Transcripts record claude's own `effort` / `perTurnEffort` on assistant entries, and a resumed session
  rebuilds its effort markers at the same positions. Old transcripts replay unchanged.
- The tool list sent to every provider is sorted by name. On Claude models that support tool search,
  deferred tools are declared up front with `defer_loading` and ToolSearch surfaces them with
  `tool_reference` blocks, so loading a tool no longer changes `tools` or invalidates the cache.
- Compaction reuses the session's own request prefix (system blocks, tools, history), so the summary reads
  from the cache instead of being the one uncached request of the session.
- A fourth cache breakpoint lands on the previous request's write when a single request appends more than
  the API's lookback window.
- `promptCacheTtl: "1h"` (a new session option; default `"5m"`) caches the system prompt for an hour.
  1-hour cache writes are counted separately and priced at 2x input; the result's `cache_creation` splits
  writes by lifetime.
- Claude API requests opt into cache diagnostics (`previous_message_id`); a reported cache miss or dropped
  thinking block is logged once and appears on the result as the Winter-only `usage.cache_misses`.
- Winter-authored reminders (the date change) ride as mid-conversation `system` messages on models that
  document them; listings and notifications stay user text.
- OpenAI Responses and Codex requests carry `prompt_cache_key` (the session id, plus the agent id for a
  subagent).

### Catalog data (prompt caching)

- New optional evidence fields: `reasoning.perMessageEffort` (Fable 5.1, Opus 5.5, Opus 5),
  `deferredToolLoading` (the Claude models in Anthropic's tool-search compatibility table),
  `midConversationSystem` (Fable 5.1, Fable 5, Opus 5.5, Opus 5, Opus 4.8) and `promptCacheKey` (OpenAI
  and Codex rows).

### Mid-session changes that keep the prompt cache (WS-23 midconv)

- **Effort on GPT-6.** On `openai/gpt-6-astra`, `-sol` and `-luna`, a `set_effort` rides OpenAI's
  `{"type": "configuration_update", "reasoning": {"effort": …}}` input item, placed before the user message
  it applies to (the docs; Codex places it after, and the live probe decides), while the top-level
  `reasoning.effort` stays fixed. Like the Anthropic markers, one update opens every request, so every
  GPT-6 session sends the item from turn one; two updates are never sent side by side. The transcript
  records the level the update set. A 400 naming the item falls back once, for the rest of the session,
  to changing the top-level value. `codex-oauth` rows and Azure do not use the item yet.
- **A frozen tool list.** On rows that document a way to change tools mid-conversation, `tools` is fixed
  for a cache epoch (session start, each compaction, each model switch) and written to the transcript as
  a `tool_epoch` attachment. Each later change is a `tool_changes` attachment, placed after the user or
  tool-result turn it follows and replayed at that position, so every request is a byte prefix of the
  next. A resumed session rebuilds both from its transcript. Everywhere else `tools` is rebuilt per
  request, as before.
  - **Anthropic, by reference** (Fable 5/5.1, Opus 4.8/5/5.5 on `anthropic` and `console`): a late eager
    tool is declared `defer_loading` after the frozen list and announced with a `tool_addition` reference;
    a late DEFERRED tool is only declared there and stays deferred until ToolSearch loads it; a withdrawn
    tool gets a `tool_removal`. The `role: "system"` message follows a user turn and precedes the reply
    (after a failed or interrupted generation it moves past the next prompt), never follows a paused
    assistant turn, and never carries the cache breakpoint. The beta rides every request.
  - **Anthropic, by value** (the same rows, Claude API only): a late tool is a `tool_definition`
    addition, and a changed description or schema is a new definition under the same name. Only the
    `inline-tools-2026-09-15` beta is sent.
  - **OpenAI** (`openai` gpt-5.4 and later): a late tool is an `additional_tools` developer item. A
    withdrawn tool, or one the live permission mode excludes, leaves the callable set through
    `tool_choice: {"type": "allowed_tools", …}` (function entries only), so a mode switch changes only
    `tool_choice`. A forced choice still wins; a refused `allowed_tools` turns off only itself.
  - A change the row cannot express (a new definition on a reference-only row) starts a new epoch, and
    is logged once. A refused change (the beta, a block, `tool_name_conflict`,
    `tool_reference_unresolved`, `available_tools_limit_exceeded`, …) falls back once, for the rest of the
    session, to rebuilding `tools`.
- **OpenAI client tool search** (`openai` gpt-5.4 and later, and every `codex-oauth` row): ToolSearch is sent
  as `{"type": "tool_search", "execution": "client"}`. Deferred tools are not declared in `tools`; a
  search's tools come back in `tool_search_output` (with `defer_loading`), and MCP tools are grouped in an
  `mcp__<server>` namespace. The loaded definitions are stored on the ToolSearch result, and the history
  replays them from there, so a server that disconnects or a tool that changes never rewrites an earlier
  output. A `tool_search_call` is accepted, and no longer fails the turn. A namespaced call maps back to
  Winter's full name. A refused search falls back once to today's shape.
- **Codex caching.** Codex requests now send `session-id`, `thread-id` and `x-client-request-id` (the
  conversation's cache key): codex-rs says the ChatGPT backend "derives cache affinity from the Responses
  session-id header", and without it the live probe read no cached tokens on any codex request.
- New seam fields, all additive and optional: `ProviderMessageLike.toolChanges`,
  `TurnRequest.tools[].namespace` / `.toolSearch`, `TurnRequest.allowedTools` / `.toolChanges` /
  `.resumesPausedTurn`; on the engine side, `tool_result.loadedToolDefinitions`.

### Fixes from the Anthropic live gate (claude-opus-5-5)

- A `tool_result` that carries `tool_reference` blocks now holds only those blocks. Its text (the
  ToolSearch listing, a hook's reminder) follows as sibling text in the same user message. Mixing them
  was a 400, "Tool definitions/code execution functions cannot be mixed with other content", which bricked
  the session. Sessions already saved in the mixed shape are fixed when sent. A reference to a tool
  that no longer exists is dropped; a result left empty reads "[Tool references removed - tools no
  longer available]".
- The no-prefix compaction fallback sends its instruction once, as the final user turn, and never starts
  on an assistant turn. It had ended on an assistant reply, which newer models refuse as a prefill. New
  evidence `assistantPrefill: false` (Opus 4.6 and later, Sonnet 5, Fable 5/5.1) makes the Anthropic
  adapter refuse such a request, typed, except for a `pause_turn` resend.
- `scripts/probe-anthropic-cache.ts` now names its credential (every request had been a 401) and prints
  error bodies.

### Catalog data (midconv)

- `reasoning.perMessageEffort` names its mechanism: `{beta}` (Anthropic) or `{item: "configuration_update"}`
  (OpenAI). New evidence fields: `midConversationToolChanges`, `inlineToolDefinitions`,
  `clientToolSearch`, `additionalToolsItem`, `allowedToolsChoice` and `assistantPrefill`.

### Tooling

- `scripts/probe-openai-midconv.ts` (`WINTER_OPENAI_MIDCONV_PROBE=1`, dry run available) probes
  `configuration_update` placement and errors, the codex backend, a `tool_search` round trip, and
  `additional_tools` / `allowed_tools`. `scripts/probe-anthropic-cache.ts` gains the tool-change phases
  and per-message effort on Opus 5.

### Reasoning state in the sidecar, and switching models (WS-23 reasoning-state)

- **A provider-neutral transcript.** An assistant entry now holds text and `tool_use` only. A Claude
  turn's `thinking` / `redacted_thinking` blocks (signatures and opaque data intact) are stored in the
  provider-state sidecar as a new `reasoning-blocks` record, each block with its position in the turn.
  The Anthropic adapter puts them back in place on every request, so the wire is unchanged byte for
  byte (a golden captured before the move pins it, live and resumed). A transcript written before the
  move is read as it stands; its inline blocks win over any record. A session with no sidecar keeps
  them inline.
- **Per-model cache quirks move to the sidecar too.** An entry's `effort`/`perTurnEffort` and the tool
  epoch's bookkeeping become `effort`, `tool-epoch` and `tool-changes` records, keyed by provider and
  model. Effort markers, the frozen top-level effort and the tool epoch now read only the target
  model's own records. Returning to a model within its prompt-cache lifetime (5 minutes, or an hour
  when configured) resumes its tool epoch, with changes since recorded as change entries; past it, a
  fresh epoch starts. (The transcript fields and attachments from dev builds are still read.)
- **The switch fit check.** The first request after a model switch, in-runtime or at resume, is
  estimated against the target's window × compaction threshold − max output (about 3.5 characters per
  token, plus 10%). When the conversation does not fit, the model being left compacts it first. If
  that model is out of reach, the target compacts, with its summarizer bounded to what it can read.
  The context accountant's limit follows every switch. `describeModel` carries the row's window and
  output ceiling.
- **`Query.compact()`** (Winter-only): compacts now, on the live model, and resolves once done. A host
  calls it before switching to another provider whose model cannot hold the conversation.
- **What a switch loses** is only what the target cannot represent: images or documents for a model
  that reads none (each becomes a note), another vendor's server-tool steps (flattened to text), a
  compaction the fit check will run, and an interrupted turn. Reasoning stays with its model and
  replays on a switch back, so a plain cross-family switch no longer warns. `reviewModelSwitch`
  reports `{fits, estimatedTokens, window}`. The warning code is now `model_switch_lossy`, and the
  `handoff` record is no longer written.
- **Cross-family reasoning decorations are capped**: 4,000 characters each and 24,000 per request,
  newest first.
- **No frame carries a thinking signature or redacted data** (the host never needs them).
- **A failed reasoning write** (`native-state`, `reasoning-blocks`, `summary`) is retried once. If it
  still fails, the turn completes with a `reasoning_state_unsaved` continuity warning.
- **Sidecar fixes.** A Responses turn keeps its reasoning items' places among its messages and calls,
  and replays them interleaved. A replay refused with "could not decrypt/verify the encrypted content"
  is retried once without the replayed reasoning. A sidecar past 64 MiB keeps its newest records
  instead of dropping every turn. Summary parts are joined with a blank line. A row with no certified
  domain uses its model key as its continuation domain, not the family string.
- **OpenAI-family context overflow** (`context_length_exceeded`, xAI's maximum-prompt-length 400) is
  typed `contextOverflow`, so reactive compaction recovers from it as it does on Anthropic.
- `scripts/probe-switch-return.ts` (`WINTER_SWITCH_PROBE=1`, dry run available) drives Claude → GPT →
  Claude live. `scripts/probe-xai-responses.ts` gains the multi-agent replay-order step
  (`WINTER_XAI_PROBE_STEPS=order`).

## 0.0.24

Fixes to the 0.0.23 catalog refresh from an independent audit (53 rows fact-checked against vendor pages), plus
where Claude takes its effort on the wire.

### Anthropic Messages adapter

- Claude models whose catalog id is dotted (`claude-opus-4.5` … `4.8`, `claude-sonnet-4.5`/`4.6`,
  `claude-haiku-4.5`) now reach the API under Anthropic's dashed model id (`claude-opus-4-8`); Winter's own leg
  previously sent the dotted id and got a 404. Catalog keys and stored tags are unchanged.
- Effort reaches current Claude models the way Anthropic documents it: a row with `reasoning.effortRequest` sends
  `output_config.effort` plus `thinking: {type: "adaptive"}` (previously every effort became
  `thinking.budget_tokens`, which Claude 4.7 and later reject with a 400); Opus 4.5 keeps its budget and adds
  `output_config.effort`, which Anthropic documents as composing; rows without the field are unchanged.
- An explicit thinking request never sends a type the row's `unsupportedParameters` names: `enabled` becomes
  `adaptive` where `enabled` is rejected; `disabled` on an always-on model is omitted (or sent as adaptive where
  the row needs the block-binding opt-in); `adaptive` on a budget-only model is refused before the request.
- A forced `tool_choice` (`any` / `tool`) becomes `auto` on rows that reject it (Opus 5.5, Fable 5.1); Winter's
  inner web-tool pass no longer guarantees a first tool call there, and the classifier still fails closed.
- On always-on models, a summary-requesting turn sends `display: "summarized"`, so the model's progress notes
  between tool calls stay visible.
- Rows with `reasoning.blockBinding` (Opus 5.5, Fable 5.1) opt into `thinking-binding-controls-2026-08-01` with
  `prefix_mismatch_behavior: "drop_block"`, so a conversation whose tools change mid-session (MCP servers
  connecting, deferred tools loading) keeps working instead of failing "bound to a different conversation".

### Catalog data

- `reasoning.effortRequest` (new optional evidence field, `{ field: "output_config.effort" }`) on the ten Claude
  models Anthropic's effort documentation lists (Fable 5.1/5, Opus 5.5/5/4.8/4.7/4.6/4.5, Sonnet 5/4.6), on both
  `anthropic` and `console`. Anthropic-dialect rows now name the request shapes Anthropic rejects with a 400 in
  `unsupportedParameters` (`thinking.type.enabled|disabled|adaptive`, `tool_choice.any|tool`), per model.
- `reasoning.blockBinding` (new optional evidence field, `{ beta: "thinking-binding-controls-2026-08-01" }`) on
  Opus 5.5 and Fable 5.1: their API binds a replayed thinking block to the conversation prefix, and the documented
  escape is that beta with `thinking.block_binding.prefix_mismatch_behavior: "drop_block"`.
- Restored curated defaults a re-map had dropped or changed without evidence: `openai/o4-mini` (`medium`),
  `openai/gpt-6-astra` (`medium`). Xiaomi MiMo V2.5 rows stay `candidate` until their announced 2026-10-21
  retirement (0.0.23 marked them `deprecated` early).
- One CNY→USD rate for every CNY-derived price (0.1490, the 2026-09-25 reference rate); Alibaba China rows
  re-derived from the CNY list. Tencent TokenHub international priced from its own USD list.
- Documented values filled: Z.ai GLM context windows, Tencent Token Plan context/output limits.
- DeepSeek's OpenAI-dialect rows drop an undocumented literal `none` effort (`low`/`high`/`max`); Amazon Nova
  input modalities follow the AWS model cards (no `pdf`); xAI and MiniMax pricing citations corrected.

## 0.0.23

The 2026-09-25 first-party provider/model catalog refresh: 213 providers (was 171), 1000 models (was
691), 22 model families (was 17). Every refreshed row carries per-field evidence (vendor URL, what the
page says, the retrieval instant); per-model values were mapped from the vendors' own docs and reviewed
row by row.

### Providers

- **New first-party surfaces, one provider per (vendor × billing surface × wire dialect × region):**
  Google Gemini API OpenAI-compatibility (`google-openai`); Moonshot Anthropic dialect and Moonshot
  China (both dialects); Kimi Code overseas pair (`kimi-coding-intl`, `-openai`); Zhipu BigModel China
  (metered + GLM Coding Plan, both dialects); MiniMax Token Plan Anthropic dialect and MiniMax China
  (Anthropic + Token Plan pair); Alibaba Model Studio Anthropic dialect (intl + China), Token Plan
  Anthropic dialect, Alibaba Coding Plan (intl + China, both dialects); Xiaomi MiMo (PAYG both dialects,
  Token Plan in its Singapore/China/Europe clusters, both dialects); Baidu Qianfan Anthropic dialect and
  Coding Plan pair; Tencent TokenHub (China + Singapore, both dialects), Tencent Coding Plan and Token
  Plan pairs; the Meta Model API (`meta`, `meta-anthropic`).
- **Corrected rows:** `qwen-cloud-token-plan` is `subscription`, not `token`; `minimax-cn` moves to the
  documented `api.minimax.cn` host; `cohere` uses the documented `api.cohere.ai/compatibility/v1`;
  `kimi-coding`/`kimi-coding-openai` are relabelled as the China plan (their host, `api.kimi.com`, is
  documented as China); `meta-llama` is `blocked` (the Llama API was retired 2026-07-06); the legacy
  Tencent Hunyuan platform (`tencent`, shutting down 2026-09-30) is relabelled with TokenHub as its
  successor. Upstream rows re-read against fetched documents keep the `pinned-upstream` tier (R-FW-3:
  leaving it takes a live-gate pass too); the fetched evidence is recorded as the first key.

### Models

- Added across GPT (GPT-6 Sol/Luna on `openai` and `codex-oauth`), Claude (Opus 5.5), Gemini (3.5/3.6
  Flash, Gemma 4 on the Gemini API), Grok (4.7, 4.5), GLM, MiniMax, Qwen (3.8 Flash, coder models),
  MiMo, ERNIE, Hunyuan (Hy4 preview, Hy3), Mistral (pinned ids, Ministral 3), Muse Spark (standard and
  the cheaper Contributor tier, on which Meta may train on your data — named so in the row), Nemotron,
  Command A+ and Amazon Nova.
- `deprecated` (vendor-retired; listings and slots drop the row, the registry still resolves the key):
  `zai/glm-5-turbo`, `zai-anthropic/glm-5-turbo`, `mistral/devstral-latest`, and the Hunyuan ids retired
  2026-06-22 (`tencent/hunyuan-turbos-latest`, `-t1-latest`, `-pro`, `-lite`). A retirement announced for
  a FUTURE date keeps the row `candidate` with the date in its evidence.
- Effort vocabularies now state exactly what each adapter sends: literal `reasoning_effort` values on
  OpenAI-dialect rows, the `low`..`max` thinking-budget ladder on Anthropic-dialect and native Google rows.

### Families and slots

- New families: `muse`, `mimo`, `command`, `hunyuan`, `nova`, each with a curated slot lineup.
- User ruling: the `gpt` family's `sol`/`luna` slots move to `gpt-6-sol`/`gpt-6-luna`; the `claude`
  family's `opus` slot (and the pinned `opus` alias) move to Opus 5.5. The retired `devstral` slot is
  removed from `mistral`.

## 0.0.22

0.0.21 was tagged but never published either: its release job's `publish` job failed in the
`bun test` step on `ubuntu-latest`, so nothing reached npm. Four causes, one sentence each:
`canonicalizeTrustedSymlinkPath`'s three macOS-alias test cases assumed the `/private/tmp`↔`/tmp`
and `/private/var`↔`/var` real-symlink pairs that only exist on macOS, and the same root cause broke
an evaluator deny-rule control that resolves through the same alias; the packaging test's raw-text
`.ts`-specifier scan flagged the provider catalog's own bundled `generated/*.json` diagnostic strings
(shaped like `from "./x.ts"` but pure data) as if they were unresolved module specifiers; and
`winter-provider-catalog` turned out to be a genuine, previously undetected carrier of the
`xai-org/grok-build` Apache-2.0 derivation (`generated/catalog.json` cites the same pinned commit the
root `NOTICE` already attributes, for a set of xAI model-catalogue rows) but shipped a differently-
purposed `NOTICE` of its own instead of the root one. 0.0.22 is 0.0.21 plus those four fixes.

## 0.0.21

WS-21: permission and sandbox parity ported from the pinned claude 2.1.250 dump, the shared
`~/.winter/sdk` store home, plugins in claude's own on-disk format, and several MCP/tool-call
correctness fixes. Includes the 2026-09-19 provider-catalog refresh.

### BREAKING

- **Permission and sandbox parity ported from the pinned claude 2.1.250 build**: the file-rule
  grammar now matches claude's gitignore-style matcher; claude's default write-protected entries
  (shell/git/mcp config files, editor/agent dot-dirs, `.git/hooks` and `.git/config`) are added to
  every write-deny set with no opt-out, anchored at cwd — `allowGitConfig` (wired from settings)
  narrows that floor to `.git/config` alone; a trailing-whitespace or otherwise suspicious path now
  fails the same safety check claude runs before a protected-file write; a symlinked candidate is
  checked through claude's full readlink chain (closing a dangling-symlink bypass of that check) and
  against claude's six real-directory/trusted-alias pairs (`/private/tmp`↔`/tmp`, `/private/var`↔
  `/var`, `/private/etc`↔`/etc`, `/usr/bin`↔`/bin`, `/usr/lib`↔`/lib`, `/usr/sbin`↔`/sbin`) for the
  allow-rule retry. The SDK's own home write-floor now covers both `winterHome` and `storeHome`, and
  the ancestor-rename-bypass fence (renaming a protected directory's ancestor to write through it) is
  anchored on the same paths.
- **`.winter/skills`, `.winter/rules` and `.winter/output-styles` are write-protected by default**
  (claude's default-protection block, ported verbatim), alongside the existing control-plane and
  agent-definition floors.
- **A tool call naming a tool the model was not offered is refused, never executed** (claude parity);
  Winter's own pinned refusal channels are kept.
- **The `deepseek/deepseek-reasoner` and `deepseek-anthropic/deepseek-reasoner` catalog rows are
  gone** (2026-09-19 refresh) and are not renamed to anything: a stored tag now resolves to a typed
  `unknown-model` refusal instead of a silently-stale row. `deepseek-v4-flash`'s deepseek-owned key
  also moved to `deepseek/deepseek-flash`.

### Other changes

- **Default home is now `~/.winter/sdk`**, with `WINTER_STORE_HOME` overriding it independently of
  `WINTER_HOME`; every durable path, floor and sandbox rule (checkpoints, provider state, plugin
  cache) is anchored on the store home rather than the per-run folder.
- **Plugins follow claude's own on-disk format**: `hooks/hooks.json` (wrapped, additive with manifest
  hooks), directory marketplaces, and `resolvesWithinPluginRoot` closes a symlink escape a plugin's
  own component path could previously take outside its root.
- **MCP**: the tool list is rebuilt per request rather than once at startup; the first turn waits up
  to claude's 2 s deadline (or `MCP_TIMEOUT`) for a pending server before building `system/init`; a
  subagent's own MCP server scope recurses to every descendant, and ToolSearch's pool honours it.
- **Parallel tool-call batches are rebuilt claude-style**: every call in the batch is paired with its
  result and merged before replay, fixing store/resume and the lossy-switch warning count for a
  claude-shaped parallel batch.
- **chat-completions providers**: consecutive assistant messages are folded into one outgoing message
  instead of being sent as separate turns.

## 0.0.20

0.0.19 was tagged but never published either: its release job stopped at the differential gate,
whose goldens held `result` token counts that the fixture providers compute from this machine's
temp-dir paths (Linux runner vs a macOS developer). The gate now masks those counts, keeping the keys.
0.0.20 is 0.0.19 plus that gate fix; every change under 0.0.18 ships first in 0.0.20.

## 0.0.19

0.0.18 was tagged but never published: its release job stopped on a test that needs the macOS
sandbox, which the Linux release runner does not have. 0.0.19 is 0.0.18 plus that test's darwin gate;
every change below under 0.0.18 ships first in 0.0.19.

## 0.0.18

Parity fixes from the Winter dist-session investigation. `dangerouslyDisableSandbox` now follows the
pinned `claude` 0.3.250 Bash rule instead of always prompting, behind claude's own write-target
checks; every result carries claude's per-turn `usage`; a model's own reasoning is replayed natively
instead of being quoted back to it; and model descriptors are always looked up under the request's
own provider.

### BREAKING

- **`dangerouslyDisableSandbox` is no longer mandatory interaction** (RULING P3-J is superseded by
  the pinned claude 0.3.250 Bash `checkPermissions`): deny/ask rules, hooks and the path floors
  decide as for any Bash call; a matching allow rule runs the escape; `bypassPermissions` runs it;
  `dontAsk` denies it; an escape nothing sanctioned is asked with "Run outside of the sandbox"
  through the PermissionRequest hook and the host's `canUseTool` in every other mode — auto and plan
  included, never the classifier. Under auto, the broad-allow suspension still applies, so a bare
  `Bash(*)` asks where claude would allow. A PreToolUse hook's own ask reason is no longer
  overwritten. An escape that is also a protected write or a critical removal goes to the host,
  never the classifier.
- **Shell write targets are checked the way claude's `checkPathConstraints` checks them**, before
  any allow rule or mode allow (after the sandbox auto-allow): a target with `$`, `%`, a backtick or
  a leading `=`, a `~user` form or a glob, a process substitution, an unparseable command, and
  `cp`/`mv` with any flag are asked (claude's reasons; not bypass-immune). `~`/`~/` targets are the
  home directory for the protected floor, deny rules and the working-directory check alike. New
  write forms: `>|`, `>&file`, `&>>`, `<>`, fd-prefixed; backslash-newline is joined; `tee` operands
  and `cp`/`mv --target-directory`/`-t` are write targets. Protected targets in these forms are
  asked under bypass.
- **Every command a string runs is checked** — subshells, brace groups, `$(…)`, backticks,
  `<(…)`/`>(…)`, if/for bodies, function bodies, unquoted here-documents — by the critical-removal
  breaker, the write floor, read-only recognition and Bash rule matching (an allow rule must cover
  the substituted command; a deny rule sees it). `$(cat <<'EOF' … EOF)` adds no command.
- **Every path and command name read from a shell word is read after bash's quote removal**
  (single/double quotes, backslashes, ANSI-C `$'…'` decoded, `$"…"`): `'.git'/config`,
  `.g"i"t/config` and `.\git/…` are `.git`; `'rm'`/`r\m` is `rm` for the critical-removal breaker
  and for deny/ask rules; quoted flags count for read-only recognition. `$'…'`/`$"…"` targets still
  ask as an expansion. A quoted `"~/x"` is no longer the home directory (bash does not expand it).
- **A shell write to a protected path is asked even under `bypassPermissions`** (it was allowed).
  The resolved winter home is protected wholesale for all tools (the memory, workflow-script and
  outputs carve-outs stay writable); the three control-plane filenames are protected for shell
  writes at any depth; protected paths match case-insensitively, and `.gitconfig`, `.gitmodules`
  and `.ripgreprc` are protected. A rule-allowed shell write outside the working directories, or in
  a command that changes directory first, asks. A host's Edit/Write/Read deny rule denies a shell
  write target, and a deny/ask Bash rule binds an unparseable command through its naively split
  pieces.
- **Read-only recognition refuses** `find -exec/-execdir/-ok/-okdir/-fprint*/-fls`, `rg --pre`,
  `git diff/log --output`, and a command whose substituted command is not itself read-only.
- **`sandbox.allowUnsandboxedCommands: false` ignores the override**: the command runs sandboxed
  and the result records the request; the Bash text says the parameter is disabled by policy.
- **Every `result` carries `usage`** — claude's full shape (`WireResultUsage`) with THIS turn's
  main-loop token counts; never diff it across results. `modelUsage` (session-cumulative) includes
  unpriced generations at `costUSD: 0` with no `costBasis`; `total_cost_usd` still appears only once
  something was priced, so an unpriced session's results carry `modelUsage` without it.
- **New runtime→host frame `control_cancel_request {requestId}`** (`ControlCancelRequestFrame`),
  sent when a turn is interrupted while a permission prompt is open; `query()` aborts that
  `canUseTool`'s `signal` and sends no response. `ControlRequestHandler` takes an optional
  `{ signal }`.
- **Descriptor lookups take a REQUIRED `providerId`** (`descriptorLookupForAdapter`'s lookup and
  the OpenAI-family and Bedrock `DescriptorLookup` types). A one-argument implementation still
  type-checks; a one-argument call does not.
- **The Skill tool's result begins `Base directory for this skill: <dir>`** and a blank line
  (claude's header), `<dir>` being the directory the SKILL.md was loaded from.
- **`recognizeEditOperation`**: an unparseable command naming a write target returns kind "other".
- **A memory key's git root must own the cwd**: a forged `.git` file no longer borrows another
  project's; a submodule's key is its own checkout (was `<outer>/.git/modules`).

### Fixed

- A model's own previous turn is replayed natively — in-dialect thinking blocks with the signature
  the endpoint sent, and native state — and never quoted back as `<recovered_reasoning>` text, even
  when the catalog gives its row no continuation domain (587 rows). On the wire the 6
  Anthropic-dialect reasoning rows (deepseek-anthropic 3, kimi-coding 3) now send their own thinking
  back; no row gains a `reasoning_content` replay; every row stops receiving a tag about its own
  reasoning. A different model is still labelled prior-model data.
- A bare wire model id is validated against the request's own provider's catalog row, not whichever
  provider sorts first (139 rows on `winter.openai-chat-completions`; e.g. `deepseek-v4-flash` was
  refused against `alibaba-cn`'s row). The `# Environment` model line is named the same way.
- The Bash tool tells a sandboxed session what claude's does: no network
  (`Network: {"allowedHosts":[]}`), when to request `dangerouslyDisableSandbox`, and `$TMPDIR`.
- `autoAllowBashIfSandboxed` no longer clears an allowed `excludedCommands` entry (it runs
  unsandboxed).
- An interrupt cancels an open permission prompt at its source; a policy-change retry of an
  abandoned evaluation stays bound to its own turn; a cancelled request's handler entry is released
  at once.
- A later generation no longer rewrites an earlier result's `modelUsage` rows for an in-process host.
- `Options.outputsDir` inside the winter home is writable for the Bash sandbox and outside the
  protected floor's winter-home part (the floors below it still hold).

### Docs

- `AdvisorConfig.model`: a provider-qualified tag is the advisor's provider identity; with
  `authRef` the advisor runs on another provider than the session's. No new field.

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
