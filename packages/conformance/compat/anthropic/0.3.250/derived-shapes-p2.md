# P2 derived shapes — permissions & hooks (pinned 0.3.250)

Authority for every Phase-2 (permissions & hooks) brief's field-level shapes. The committed
`exports.json`/`declaration-digests.json` in this directory are names-and-digests only; this
document adds the field-level detail P2 needs, derived directly from the pinned declaration.

## Method

The pinned `@anthropic-ai/claude-agent-sdk@0.3.250` tarball was fetched via
`scripts/fetch-upstream.ts`'s `fetchAndVerifyUpstream()` (sha256 + npm registry sha512
integrity, both checked against the committed `checksums.json` in this directory — both
matched), extracted with `tar` into a second, independent `mkdtemp` directory, read in place,
and both directories were deleted in a `finally` block. No tarball, extracted file, or verbatim
excerpt was written to any persistent location; this task's own residue check is reported
alongside the commit. `bun run conformance:snapshot -- --check` (one of this task's required
gates) independently re-fetches and re-hashes the same package and confirms zero drift against
the committed symbol inventory, corroborating that the content examined below is exactly what
that snapshot already pins by digest.

Files examined: `sdk.d.ts` (8448 lines), `sdk-tools.d.ts` (4126 lines, tool-input shapes only —
spot-checked for a `permissionMode`-adjacent field), `bridge.d.ts`, `browser-sdk.d.ts`,
`agentSdkTypes.d.ts`, `extractFromBunfs.d.ts` (the latter two are trivial re-export shims with no
independent permissions/hooks surface). All line numbers below are **as published in the pinned
tarball**, not any file in this repository.

**Naming discipline**: per WS-03's compatibility posture and WS-07 §4 ("Current Norma policy
names adopt the public names at cutover"), the pinned identifier and field NAMES quoted below
*are* Winter's own naming — Winter is not renaming these public-contract types. Every sentence of
description, every table, and the document's structure are original; nothing beyond individual
pinned type/field names and literal union members is quoted from the artifact.

**Claim provenance**: each item below distinguishes a *type-level fact* (a field exists, its
type, its optionality — directly evident from the declaration's code) from a *doc-asserted
behavior* (a claim that rests on the artifact's own JSDoc comment, e.g. a `@default` tag or a
prose sentence describing gating). Both kinds carry a file:line citation; doc-asserted claims say
so explicitly.

**Scope note**: this task's prescribed check-set is WS-07 §3.3 + §7 and WS-08 §1 + §6 only. Items
(a), (b), (d), (f) and (g) surface facts that touch WS-08 §9 and §13 (which are *not* in the
check-set); those tensions are named as such and recorded as Open Questions rather than folded
silently into a "matches/diverges" verdict against sections nobody asked me to audit.

---

## (a) `Options.hooks` — exact config schema

**Source**: `sdk.d.ts:1586` (the `Options.hooks` field; JSDoc `1573`-`1585`); `sdk.d.ts:861`-`866`
(`HookCallbackMatcher`); `sdk.d.ts:854`-`857` (`HookCallback`); `sdk.d.ts:868` (`HookEvent`, full
31-member union — see item (b)).

```ts
// Options field
hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;

interface HookCallbackMatcher {
  matcher?: string;      // tool-identity matcher (WS-08 §2.1 grammar); absent = matches every occurrence of the event
  hooks: HookCallback[];
  timeout?: number;      // doc-asserted: unit is seconds, scope is every hook in this matcher (sdk.d.ts:864-865) — see item (f)
}

type HookCallback = (
  input: HookInput,                 // full discriminated union, item (b)
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<HookJSONOutput>;       // AsyncHookJSONOutput | SyncHookJSONOutput, item (b)
```

A companion runtime constant, `HOOK_EVENTS` (`sdk.d.ts:849`), holds the identical 31-string tuple
as a JS-checkable array — useful if a Winter implementation wants a runtime membership check
rather than relying on the type alone.

**Structural notes** (type-level facts):
- The container is keyed by the **closed** 31-member `HookEvent` union (`Partial<Record<...>>`),
  each key holding an *array* of matcher objects. This differs from the filesystem
  `settings.json` hooks schema, which uses an **open** string index (`[k: string]: ...`) — see
  the Supplementary section.
- The callback signature is **uniform across every event** — there is no per-event generic
  narrowing at the type level. `HookCallback` always takes the full `HookInput` union; the
  implementer narrows at runtime on `input.hook_event_name`, and the array's placement under a
  specific `HookEvent` key is the only compile-time signal of which event it's for.

**Verdict**: WS-08 §2's registration sketch is explicitly "illustrative" prose
(`hooks: { [eventName]: Array<{ matcher?: string; hooks: HookHandler[] }> }`), not a verbatim
block — so there is nothing to diverge from. The pinned shape matches that sketch's structure
exactly (event-keyed arrays of matcher+hooks) and additionally pins a per-matcher `timeout` field
the sketch didn't show. No divergence.

---

## (b) Per-event hook input/output payload shapes — full WS-08 §1 inventory

**Source (shared envelope)**: `sdk.d.ts:167`-`193` (`BaseHookInput`); `sdk.d.ts:129`-`132`
(`AsyncHookJSONOutput`); `sdk.d.ts:8133`-`8147` (`SyncHookJSONOutput`); `sdk.d.ts:870`
(`HookInput` union); `sdk.d.ts:872` (`HookJSONOutput`).

Every `HookInput` member is `BaseHookInput & {...}`:

```ts
type BaseHookInput = {
  session_id: string;
  transcript_path: string;
  cwd: string;
  prompt_id?: string;
  permission_mode?: string;   // type-level fact: a bare string, NOT the PermissionMode literal union (sdk.d.ts:175)
  agent_id?: string;
  agent_type?: string;
  effort?: { level: string };
};
```

Every `HookJSONOutput` is one of:

```ts
type AsyncHookJSONOutput = { async: true; asyncTimeout?: number };   // see Open Question 3

type SyncHookJSONOutput = {
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: 'approve' | 'block';
  systemMessage?: string;
  terminalSequence?: string;
  reason?: string;
  hookSpecificOutput?: /* union of exactly the 20 XHookSpecificOutput types that exist — table below */;
};
```

20 of the 31 events have a dedicated `XHookSpecificOutput` type folded into that union; the other
11 can only use the generic `SyncHookJSONOutput` fields above (no event-specific structured
output exists for them in the pinned declaration).

Per-event table — columns are the fields **beyond** `BaseHookInput` / beyond the generic
`SyncHookJSONOutput` envelope:

| Event | Input file:line | Extra input fields | Output file:line | Extra output fields |
| --- | --- | --- | --- | --- |
| PreToolUse | 2394-2399 | `tool_name; tool_input: unknown; tool_use_id` | 2401-2407 | `permissionDecision?: HookPermissionDecision; permissionDecisionReason?; updatedInput?; additionalContext?` |
| PostToolUse | 2359-2369 | `tool_name; tool_input; tool_response: unknown; tool_use_id; duration_ms?` | 2371-2386 | `additionalContext?; classifierContext?: string; updatedToolOutput?; updatedMCPToolOutput?` |
| PostToolUseFailure | 2341-2352 | `tool_name; tool_input; tool_use_id; error: string; is_interrupt?; duration_ms?` | 2354-2357 | `additionalContext?` |
| PostToolBatch | 2324-2327 | `tool_calls: PostToolBatchToolCall[]` (each `{tool_name, tool_input, tool_use_id, tool_response?}`, 2334-2339) | 2329-2332 | `additionalContext?` |
| Notification | 1329-1334 | `message: string; title?; notification_type: string` | 1336-1339 | `additionalContext?` |
| UserPromptSubmit | 8390-8398 | `prompt: string; source?: 'user'\|'sdk'\|'system'\|'loop_wakeup'\|'schedule_wakeup'\|'poll_event'; session_title?` | 8400-8408 | `additionalContext?; sessionTitle?; suppressOriginalPrompt?` |
| UserPromptExpansion | 8372-8379 | `expansion_type: 'slash_command'\|'mcp_prompt'; command_name; command_args: string; command_source?; prompt: string` | 8381-8388 | `additionalContext?; suppressOriginalPrompt?` |
| SessionStart | 5246-5252 | `source: 'startup'\|'resume'\|'clear'\|'compact'\|'fork'; agent_type?; model?; session_title?` | 5254-5264 | `additionalContext?; initialUserMessage?; sessionTitle?; watchPaths?: string[]; reloadSkills?` |
| SessionEnd | 5185-5188 | `reason: ExitReason` | — none — | generic envelope only |
| Stop | 8065-8082 | `stop_hook_active: boolean; last_assistant_message?; background_tasks?: BackgroundTaskSummary[]; session_crons?: SessionCronSummary[]` | 8087-8090 | `additionalContext?` |
| StopFailure | 8058-8063 | `error: SDKAssistantMessageError; error_details?; last_assistant_message?` | — none — | generic envelope only |
| SubagentStart | 8092-8096 | `agent_id: string; agent_type: string` | 8098-8101 | `additionalContext?` |
| SubagentStop | 8103-8123 | `stop_hook_active; agent_id; agent_transcript_path: string; agent_type; last_assistant_message?; background_tasks?; session_crons?` | 8128-8131 | `additionalContext?` |
| PreCompact | 2388-2392 | `trigger: 'manual'\|'auto'; custom_instructions: string \| null` | — none — | generic envelope only |
| PostCompact | 2312-2319 | `trigger: 'manual'\|'auto'; compact_summary: string` | — none — | generic envelope only |
| PermissionRequest | 2236-2241 | `tool_name; tool_input: unknown; permission_suggestions?: PermissionUpdate[]` | 2243-2254 | `decision: {behavior:'allow', updatedInput?, updatedPermissions?} \| {behavior:'deny', message?, interrupt?}` |
| PermissionDenied | 2218-2224 | `tool_name; tool_input: unknown; tool_use_id: string; reason: string` | 2226-2229 | `retry?: boolean` |
| Setup | 7919-7922 | `trigger: 'init'\|'maintenance'` | 7924-7927 | `additionalContext?` |
| TeammateIdle | 8191-8198 | `teammate_name: string; team_name: string` (`team_name` doc-marked `@deprecated`) | — none — | generic envelope only |
| TaskCreated | 8179-8189 | `task_id; task_subject: string; task_description?; teammate_name?; team_name?` (deprecated) | — none — | generic envelope only |
| TaskCompleted | 8167-8177 | same shape as TaskCreated | — none — | generic envelope only |
| Elicitation | 591-599 | `mcp_server_name; message: string; mode?: 'form'\|'url'; url?; elicitation_id?; requested_schema?: Record<string,unknown>` | 604-608 | `action?: 'accept'\|'decline'\|'cancel'; content?: Record<string,unknown>` |
| ElicitationResult | 643-650 | `mcp_server_name; elicitation_id?; mode?; action: 'accept'\|'decline'\|'cancel'; content?` | 655-659 | `action?; content?` |
| ConfigChange | 271-275 | `source: 'user_settings'\|'project_settings'\|'local_settings'\|'policy_settings'\|'skills'; file_path?` | — none — | generic envelope only |
| WorktreeCreate | 8429-8432 | `name: string` | 8437-8440 | `worktreePath: string` |
| WorktreeRemove | 8442-8445 | `worktree_path: string` | — none — | generic envelope only |
| InstructionsLoaded | 953-961 | `file_path; memory_type: 'User'\|'Project'\|'Local'\|'Managed'; load_reason: 'session_start'\|'nested_traversal'\|'path_glob_match'\|'include'\|'compact'; globs?; trigger_file_path?; parent_file_path?` | — none — | generic envelope only |
| CwdChanged | 538-542 | `old_cwd: string; new_cwd: string` | 544-547 | `watchPaths?: string[]` |
| FileChanged | 675-679 | `file_path: string; event: 'change'\|'add'\|'unlink'` | 681-684 | `watchPaths?: string[]` |
| DirectoryAdded | 565-575 | `directory: string; source: 'slash_command'\|'register_repo_root'` | — none — | generic envelope only |
| MessageDisplay | 1223-1245 | `turn_id; message_id: string; index: number; final: boolean; delta: string` | 1250-1256 | `displayContent?: string` |

**Event-name inventory verdict**: the pinned `HookEvent` union / `HOOK_EVENTS` const (31 members)
match WS-08 §1.1 + §1.2's combined inventory **exactly, 31/31**, member for member. No addition,
omission, or spelling difference in either direction.

**Per-event shape verdict**: WS-08 §1.3 explicitly assigns exact per-event payloads to "the
pinned declaration snapshot... captured at pin time" rather than stating them itself — so there
is no verbatim block to diverge from here; this table is that capture. Two behavioral tensions
against WS-08 §9's *generic* lifecycle description (outside this task's §1/§6 check-set) are
recorded as Open Questions 1-2 rather than resolved here. Separately, the shapes now visible for
`UserPromptSubmit` (`decision:'block'` + `suppressOriginalPrompt`) and `Stop`
(`StopHookSpecificOutput` + the `SyncHookJSONOutput.decision` field) bear on WS-08 §13 Open
Question 4 ("turn-lifecycle gating semantics... not pinned... this spec is then amended"); this
document surfaces the shapes and explicitly leaves the §13.4 amendment itself to the controller
(Open Question 4 below).

**Notable per-row findings** (type-level facts worth flagging on their own):
- `PermissionDenied`'s output carries a bare `retry?: boolean` (2226-2229) — not discussed
  anywhere in WS-08.
- `PostToolUse`'s `classifierContext?: string` (2377) is the exact field WS-07 §10.4 and WS-08
  §5 name as the auto-mode-classifier contribution channel — confirms that contract's field name.
- 11 of 31 events (`SessionEnd`, `StopFailure`, `PreCompact`, `PostCompact`, `TeammateIdle`,
  `TaskCreated`, `TaskCompleted`, `ConfigChange`, `WorktreeRemove`, `InstructionsLoaded`,
  `DirectoryAdded`) have no dedicated specific-output type — only the shared envelope fields
  (`continue`/`decision`/`reason`/`systemMessage`/etc.) are available to a hook on those events.

---

## (c) `canUseTool` option-object fields

**Source**: `sdk.d.ts:209`-`269` (JSDoc `199`-`208`).

```ts
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];
    blockedPath?: string;
    decisionReason?: string;
    title?: string;
    displayName?: string;
    description?: string;
    toolUseID: string;
    agentID?: string;
    requestId: string;
    matchedAskRule?: { source: string; toolName: string; ruleContent?: string };
  },
) => Promise<PermissionResult | null>;
```

**Verdict**: **MATCHES WS-07 §7.1's verbatim block exactly** — all 11 option-object fields
present, identical names, identical types, identical optionality, including the nested
`matchedAskRule` shape. No divergence.

**Note (not a divergence — a different surface)**: the wire-level control request this callback
sits behind, `SDKControlPermissionRequest` (internal/unexported, `sdk.d.ts:3956`-`3999`), carries
several *additional* snake_case fields never surfaced to the `CanUseTool` callback:
`decision_reason_type`, `classifier_approvable`, `suppress_always_allow_rule`, `default_to_no`,
`requires_user_interaction`. WS-07 §7.1 scopes itself to the callback signature, not the wire
frame, so this is not a conflict — but it's relevant to whoever implements Winter's host-bridge
wire layer (WS-04) and decides whether Winter's own bridge should expose any of these to a host
that wants richer UI than the public callback contract offers.

---

## (d) Hook-lifecycle + permission-denied SDK message shapes

**Source**: `sdk.d.ts:4278`-`4289` (`SDKHookProgressMessage`); `4291`-`4304`
(`SDKHookResponseMessage`); `4306`-`4314` (`SDKHookStartedMessage`); `4569`-`4592`
(`SDKPermissionDeniedMessage`); `4560`-`4564` (`SDKPermissionDenial`, the array-element shape
carried on `result.permission_denials`); gating doc: `Options.includeHookEvents`,
`sdk.d.ts:1702`-`1711`.

```ts
type SDKHookStartedMessage = {
  type: 'system'; subtype: 'hook_started';
  hook_id: string; hook_name: string; hook_event: string;
  uuid: UUID; session_id: string;
};

type SDKHookProgressMessage = {
  type: 'system'; subtype: 'hook_progress';
  hook_id: string; hook_name: string; hook_event: string;
  stdout: string; stderr: string; output: string;
  uuid: UUID; session_id: string;
};

type SDKHookResponseMessage = {
  type: 'system'; subtype: 'hook_response';
  hook_id: string; hook_name: string; hook_event: string;
  output: string; stdout: string; stderr: string; exit_code?: number;
  outcome: 'success' | 'error' | 'cancelled';
  uuid: UUID; session_id: string;
};

type SDKPermissionDeniedMessage = {
  type: 'system'; subtype: 'permission_denied';
  tool_name: string; tool_use_id: string; agent_id?: string;
  decision_reason_type?: string; decision_reason?: string;
  message: string; uuid: UUID; session_id: string;
};
```

**Verdict**: item (d) has no verbatim block in this task's prescribed check-set (WS-07 §3.3/§7,
WS-08 §1/§6) — these shapes are newly pinned here. Two tensions against WS-08 §9's *generic*
description (outside the check-set) are Open Questions 1 and 2 below, named rather than folded
silently into "matches."

**Correction to this task's own brief framing** (a note, not a spec divergence — nothing in
WS-07/WS-08 claims otherwise): the brief's item (d) groups "hook-lifecycle + permission-denied...
under `includeHookEvents`" as one gated family. The pinned declaration shows only the
`hook_started`/`hook_progress`/`hook_response` trio is gated — `Options.includeHookEvents`'s own
doc comment (doc-asserted, `1702`-`1710`) names exactly those three subtypes and states
`@default false`. `SDKPermissionDeniedMessage`'s doc comment (doc-asserted, `4566`-`4568`)
mentions no such gate — it appears to be part of the unconditional message stream.

**Additional doc-asserted finding**: the same `includeHookEvents` comment carves out an exception
for two specific events — SessionStart's and Setup's `hook_started`/`hook_progress`/
`hook_response` messages are emitted unconditionally. Every other event's lifecycle messages are
suppressed unless `includeHookEvents` is `true`; SessionStart's and Setup's are not.

---

## (e) `PermissionMode` union literal

**Source**: `sdk.d.ts:2234`.

```ts
type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
```

**Verdict**: **MATCHES WS-07 §4's public union exactly** — same 6 members (listed in a different
order in the artifact; irrelevant for a union type, not a divergence). The identical 6-member
union recurs verbatim everywhere `PermissionMode` is referenced in the artifact — echoed inline
at `Settings.permissions.defaultMode` (`sdk.d.ts:5559`, plus `'manual'` NOT present, see below)
and at `SDKControlSetPermissionModeRequest.mode` (`sdk.d.ts:4193`-`4198`, via the internal
`coreTypes.PermissionMode` alias) — consistent everywhere it appears, no drift between sites.

`'manual'` does not appear anywhere in the pinned type surface (as a `PermissionMode` member or
otherwise) — consistent with WS-07 §4's "`manual` is a CLI/UI alias for `default`, not a seventh
value": an alias implemented at the CLI/UI layer would not need a type-level member.

---

## (f) Pinned defaults visible in types

| Field | file:line | Pinned? |
| --- | --- | --- |
| `Options.includeHookEvents?: boolean` | 1711 (doc `1702`-`1710`) | **Pinned**: doc-asserted `@default false` |
| `HookCallbackMatcher.timeout?: number` | 864-865 | Unit pinned as seconds (doc-asserted); **numeric default NOT pinned in types** |
| Filesystem `settings.json` hook-entry `timeout?: number` — `command`/`prompt`/`http`/`mcp_tool` handlers | 5732, 5768, 5830, 5876 | **Not pinned in types** (unit doc-asserted as seconds each time; no default number) |
| Filesystem `settings.json` hook-entry `timeout?: number` — `agent` handler specifically | 5801 | **Pinned**: doc-asserted default of 60 seconds for this handler's own execution — scoped to this one filesystem hook-handler type only, not to `HookCallbackMatcher.timeout` or the other four handler kinds |
| `Options.permissionMode?: PermissionMode` | 1824 | **Not pinned in types** (no `@default` tag; WS-07 §4's "starts in `default`" is a report-sourced behavioral claim about the runtime, not visible in this declaration) |
| `Options.allowDangerouslySkipPermissions?: boolean` | 1836 | **Not pinned in types** (no `@default` tag; implicit falsy/undefined) |
| `Options.permissionPromptToolName?: string` | 1841 | **Not pinned in types** (no default of any kind) |
| auto-mode policy config (`environment`/`allow`/`soft_deny`/`hard_deny`/`classifyAllShell`, per WS-07 §10.2) | — | **Does not exist anywhere in the pinned public type surface** (checked across all 6 `.d.ts` files) — only a boolean kill-switch `Settings.disableAutoMode?: 'disable'` (7755) and an unrelated `ModelInfo.supportsAutoMode?: boolean` capability flag (1297) are pinned. This is confirming evidence for WS-07 §10.2/§10.3's own framing that auto-mode's policy configuration is undocumented at the public-API level — not a divergence, a corroboration. |

This confirms — rather than contradicts — WS-08 §13 Open Question 2's premise ("No public
default is pinned in the evidence" for per-event hook timeout): the type declaration itself pins
the *unit* (seconds) wherever a hook timeout field exists, but pins a *numeric default* in
exactly one narrow case (the filesystem `agent`-type hook handler, 60s) and nowhere else.

---

## (g) `permissionPromptToolName`'s type

**Source**: `sdk.d.ts:1837`-`1841`.

```ts
permissionPromptToolName?: string;
```

**Verdict**: a simple optional string, no further structure (an MCP tool name, per its doc
comment — doc-asserted, not independently checked against MCP-side behavior in this task). Not
addressed by WS-07 or WS-08 text at all — out of both specs' scope; pinned here for P2's
reference since it participates in the same `Options` surface as `canUseTool` and `hooks`.

---

## Supplementary: filesystem `settings.json` hooks schema

Context for WS-08 §2's Open Question 3 (filesystem hook script format is absorbed by WS-11, not
this spec) — not one of items (a)-(g), included because it was necessarily read alongside them.

**Source**: `Settings.hooks`, `sdk.d.ts:5699`-`5887`.

Structurally: `hooks?: { [k: string]: { matcher?: string; hooks: (CommandHook | PromptHook |
AgentHook | HttpHook | McpToolHook)[] }[] }` — an **open** string index (any key), unlike
`Options.hooks`'s closed `HookEvent`-keyed record (item (a)). Five handler `type` discriminants
exist: `'command'` (shell, with `args?` for exec-form/no-shell, `shell?: 'bash'|'powershell'`,
`once?`, `async?`, `asyncRewake?`), `'prompt'` (LLM-evaluated, `continueOnBlock?`), `'agent'`
(agentic verifier, default timeout 60s per item (f)), `'http'` (POST with `headers?` +
`allowedEnvVars?` allowlist for interpolation), and `'mcp_tool'` (invokes an already-configured
MCP server/tool). All five share `if?: string` (a permission-rule-syntax filter on when the hook
runs) and `statusMessage?`/`once?`. Adjacent managed-settings controls in the same interface:
`disableAllHooks?: boolean` (5916), `allowManagedHooksOnly?: boolean` (5964),
`allowedHttpHookUrls?: string[]` (5968), `httpHookAllowedEnvVars?: string[]` (5972),
`allowManagedPermissionRulesOnly?: boolean` (5976).

---

## Open Questions

These are genuine tensions between the pinned declaration and spec *text* — none is silently
resolved here, per this task's instructions. 1-2 are against WS-08 §9, which is outside this
task's prescribed §1/§6 check-set; they are recorded because item (d) required pinning these
exact shapes and the tension is directly visible in doing so.

1. **No `toolUseID` correlation on hook-lifecycle messages.** WS-08 §9's minimum-fields table
   requires `started`/`progress`/`completed` lifecycle messages to carry `toolUseID?` "for
   tool-scoped events" so a host can correlate a lifecycle row to the triggering tool call. The
   pinned `SDKHookStartedMessage`/`SDKHookProgressMessage`/`SDKHookResponseMessage`
   (`sdk.d.ts:4278`-`4314`) carry no `toolUseID`/`tool_use_id` field at all — only `hook_id`,
   `hook_name`, `hook_event`, `session_id`, `uuid` (confirmed by a second, independent targeted
   search across all 6 `.d.ts` files: no such field exists on any of the three types). Winter's
   engine has the real `toolUseID` available internally (it's part of the §10 hook RPC request
   payload), but the *public* SDK message a host receives does not carry it. Does Winter's own
   public hook-lifecycle message shape deliberately add a `toolUseID` field (a hardening beyond
   exact parity, consistent with WS-07 §9's durable-approval-record precedent of adding official
   `requestId`/`toolUseID`/`agentID` beyond what a bare port would have), or does Winter match the
   pinned shape as-is and let a host correlate only via `hook_id` + ordering? This is load-bearing
   for WS-15's host projector and for [WS-08] §9's own correlation table.

2. **`outcome` enum is coarser than WS-08 §9's taxonomy.** WS-08 §9 describes lifecycle-message
   outcome as `decision`/`none`, `error`, `timeout`, `skipped`. The pinned
   `SDKHookResponseMessage.outcome` (`sdk.d.ts:4301`) is the 3-member
   `'success' | 'error' | 'cancelled'` — no `timeout` member (presumably folded into `'error'`?),
   no `skipped` member (how does a short-circuited hook, per WS-08 §4 rule 2, report itself on
   this wire type?), no way to distinguish "produced a decision" from "no opinion" from this field
   alone, and a `'cancelled'` member WS-08 §9 doesn't mention at all. Does Winter reproduce this
   3-value wire enum as-is (exact parity) and carry its own richer classification only in the
   audit stream (per WS-08 §9's own audit/public-stream split), or does §9 need amending to match
   what's actually pinned?

3. **A second, unmodeled async-hook mechanism.** `HookJSONOutput = AsyncHookJSONOutput |
   SyncHookJSONOutput`, where `AsyncHookJSONOutput = { async: true; asyncTimeout?: number }`
   (`sdk.d.ts:129`-`132`), is a top-level alternative to every synchronous hook output — distinct
   from `HookPermissionDecision`'s `'defer'` value (WS-08 §7's durable, process-exit-surviving
   defer). Nothing in WS-08 mentions this second mechanism. Is it in scope for Winter's P2 hook
   engine at all (T9's reducer needs to know whether an async-signaling hook counts as
   "no-decision-yet-pending" vs. something the reducer must actively wait on up to
   `asyncTimeout`), or is it a callback-runtime convenience Winter can defer past P2 without
   affecting the reducer's decision semantics?

4. **WS-08 §13 Open Question 4 (turn-lifecycle gating) — shapes now visible, amendment not made
   here.** Item (b)'s table pins `UserPromptSubmitHookSpecificOutput.suppressOriginalPrompt` +
   the shared `SyncHookJSONOutput.decision: 'approve' | 'block'` field, and
   `StopHookSpecificOutput` (only `additionalContext?`, no gating field of its own — gating for
   Stop appears to ride the same shared `decision` field). This is exactly the class of evidence
   WS-08 §13.4 says should trigger an amendment to WS-08 itself ("the pin-time declaration/
   behavior capture fixes their output shapes and gating power, and this spec is then amended —
   never extended by assumption"). This document supplies the shapes; per that same open
   question's instruction, the actual WS-08 amendment is left to the controller rather than made
   unilaterally here.

---

## Notes recorded but not treated as Open Questions

No spec text is contradicted by any of these; recorded for completeness since they surfaced
during (a)-(g) derivation.

- `BaseHookInput.permission_mode` (`sdk.d.ts:175`) is typed as a bare `string`, not the
  `PermissionMode` literal union — the declaration does not statically guarantee a hook payload's
  mode field is one of the 6 known values.
- `PermissionDeniedHookSpecificOutput.retry?: boolean` (`sdk.d.ts:2228`) exists with no discussion
  anywhere in WS-08.
- The wire-only `SDKControlPermissionRequest` extra fields (see item (c)'s note) do not conflict
  with WS-07 §7.1 — different surface (wire frame vs. public callback).
- Filesystem-hooks' open string-keyed schema vs. `Options.hooks`'s closed `HookEvent`-keyed
  schema (Supplementary section) is a real structural difference between the two hook
  registration families WS-08 §2's table already treats as distinct sources.
