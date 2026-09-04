# P5 derived shapes — workflows, skills, plugins, context, compaction (pinned 0.3.250)

Authority for every Phase-5 (WS-11) task's field-level shapes: T1 of the 2026-09-04 plan. Mirrors
`derived-shapes-p2.md`/`derived-shapes-p3.md`/`derived-shapes-p3-task8.md`/`derived-shapes-p4.md`'s
own method and citation discipline in this same directory. Nothing here re-derives a prior file's
own finding; where a P2 shape is load-bearing for a P5 item (the `PreCompact`/`PostCompact`/
`Notification` hook rows), P2's own citation is repeated by reference rather than re-derived, exactly
as P4 did for its item (f).

This file additionally carries six **hermetic runtime captures** the plan's Task 1 brief names —
the first time a `derived-shapes-*` file in this directory reports *executed* behaviour of the pinned
runtime alongside its declaration. Every capture is report-only: no golden was written, no fixture
was committed, nothing from the artifact persists past this document's names, numbers and the two
error strings item (2)/(6) exist to pin.

## Method

The pinned `@anthropic-ai/claude-agent-sdk@0.3.250` tarball was fetched via `scripts/fetch-upstream.ts`'s
`fetchAndVerifyUpstream()` (sha256 + npm registry sha512 integrity, both checked against the committed
`checksums.json` in this directory — both matched, unchanged from P2/P3/P4's own verification since
this is the same pinned tarball). Like P4, this task passed an explicit `cacheDir` under its own
scratchpad, outside the repository; `fetchAndVerifyUpstream` reports `ownedDir: false` in that mode,
so this task — not the helper — deleted every cache and extraction directory itself once every
citation below had been captured.

**Two independent fetch→extract→read→delete cycles were run**, as P4 established: one for research
and drafting, and a second, dedicated verification pass. The verification pass was mechanical rather
than by eye: every `sdk.d.ts`/`sdk-tools.d.ts` line citation in this document was written into a
`file<TAB>line<TAB>expected-substring` table and checked programmatically against the *second*
extraction — 204 citations, 204 anchored to the line they claim (the single reported diff was a
missing pair of backticks in the checker's own expectation string for `sdk.d.ts:2050`, not a line
error). Both cycles independently verified the identical checksum.

Files examined: `sdk.d.ts` (8447 lines, matching P4's own count) and `sdk-tools.d.ts` (4125 lines,
`json-schema-to-typescript`-generated per `derived-shapes-p3-task8.md`). `bridge.d.ts` (361),
`browser-sdk.d.ts` (107), `extractFromBunfs.d.ts` (1) and `agentSdkTypes.d.ts` (1) were swept for
every P5 symbol this task searched for and had **zero** independent hits.

**Prompt-text prohibition (WS-11 §6.2, phase Global Constraints).** No grep in either cycle ran over
`cli.js` or any bundle file — only the six `.d.ts` files. The pinned runtime's system prompt was
never fetched, read, printed, quoted, summarized or described, and no capture below prints a request
body's `system` field or any tool description. The runtime captures log request *method + path* and
tool *names* only.

**Naming discipline**: identical to P2/P3/P4's — the pinned identifier and field NAMES quoted below
are Winter's own naming (WS-03's compatibility posture, WS-07 §4). Every sentence of description,
every table, and this document's structure are original. **Four vendor strings appear verbatim, all of
them runtime *error* text, none of them authored prose**: the checkpointing/`SessionStore` rejection
message and the `persistSession` rejection message that pre-empts it (item (2)), the structured-output
exhaustion message (item (6)), and the `query()` throw wrapper that embeds it. Each is the exact
artifact WS-11 OQ3 or R5-10 exists to pin, and a paraphrase of any of them would defeat the capture's
whole purpose. Every other vendor sentence in this document — tool result text, permission-denial
text, validation-error text, and every JSDoc claim — is restated in this document's own words.

**Claim provenance**: as P4 — each item distinguishes a *type-level fact* (a field exists, its type,
its optionality — evident from the declaration's code) from a *doc-asserted behavior* (a claim resting
on the artifact's own JSDoc) from a *runtime-captured fact* (observed by executing the pinned runtime
hermetically). All three carry their source; the second and third say so explicitly.

**Hermeticity of the runtime captures.** Every probe ran the pinned runtime with `env` set to exactly
`{ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, CLAUDE_CONFIG_DIR, HOME}` and NO `process.env` spread — the
`env` option replaces the child's environment wholesale, so `CLAUDE_CONFIG_DIR` **and** `HOME` were
each a fresh `mkdtemp`, closing both the config-dir path and the `os.homedir()` fallback path that
`CLAUDE_CONFIG_DIR` alone does not cover (the hardening `capture-official-golden.ts`'s own header
records). `cwd` was a third fresh `mkdtemp`; every settings file a probe needed was written into that
throwaway cwd. `ANTHROPIC_BASE_URL` pointed at a per-scenario `127.0.0.1` loopback returning canned
public-Messages-API-shaped responses, and every request it received was logged: **the loopback saw one
`HEAD /api/hello` preflight plus N `POST /v1/messages`, and nothing else, in every scenario** — direct
evidence it was the only endpoint contacted. The real `~/.claude`, `~/.winter`, `~/.norma` and the
Keychain were never read or written; no real username appears anywhere in this file, and every captured
path below is rendered as a template with `<CLAUDE_CONFIG_DIR>`/`<CWD>` placeholders.

**A recurring shape in this task's own findings.** Five of the nine lettered items turn up a name the
plan or WS-11 assumed which the pinned declaration spells differently or does not have at all
(`autoMode`, `rewindFiles(userMessageUuid)`, the two-member `systemPrompt` union, `{type:"local",path}`
as the whole plugin config, a `Skill` tool schema). Two more turn up a pinned surface WS-11 and the
plan did **not** know exists and which changes a ruling (`resolveSettings`/`filterEscalatingDefaultMode`
in item (a); `WorkflowOutput` in item (g)). Each is written up as a divergence with its citation, and
carried into Open Questions.

---

## (a) `SettingSource`, `settingSources` semantics, the settings surface, and the pinned settings API

### The union — exactly as WS-11 §5 assumes

**Source**: `sdk.d.ts:7917`.

```ts
export declare type SettingSource = 'user' | 'project' | 'local';
```

Three members, in that order. WS-11 §5's three-scope table and R5-8's precedence chain both name the
same three; **no divergence**. This is the SDK-caller-facing union and is distinct from the runtime's
own `RuleSource` (a P2 concept): a *settings file tier*, not a *rule origin*.

Two adjacent unions widen it for reporting, not for selection:

| Type | Line | Members |
| --- | --- | --- |
| `ResolvedSettingSource` | `2783` | `SettingSource \| 'managed' \| 'flag'` |
| `PolicySettingsOrigin` | `2310` | `'helper' \| 'remote' \| 'plist' \| 'hklm' \| 'file' \| 'parent' \| 'hkcu'` |
| `PermissionUpdateDestination` | `2304` | `'userSettings' \| 'projectSettings' \| 'localSettings' \| 'session' \| 'cliArg'` |

`ResolvedSettingSource` is the answer to "which tier supplied this value" — it adds `'managed'` (the
policy tier, itself sub-classified by `PolicySettingsOrigin`) and `'flag'` (the `--settings` tier).
This is exactly R5-8's `managed → inline/sdk → local → project → user` chain named as a type, with
`'flag'` occupying the position R5-8 calls "inline/sdk". Note the third union: permission *updates*
are addressed by a fourth, differently-spelled set (`userSettings`/`projectSettings`/`localSettings`
plus two non-file destinations) — three spellings of the same tiers in one file, which Winter must
not collapse into one enum by accident.

### `settingSources` — the option, and the CLAUDE.md coupling

**Source**: `sdk.d.ts:2052` (`settingSources?: SettingSource[]`), doc `2042-2051`.

Doc-asserted semantics, all four confirmed by capture (1) below:

- omitted ⇒ all three sources load (CLI defaults);
- `[]` ⇒ filesystem settings disabled — the SDK-isolation mode WS-01 §2.4 calls the hermetic-host mode;
- each member names one file tier (`~/.claude/settings.json`, `.claude/settings.json`,
  `.claude/settings.local.json`);
- **`'project'` must be included for CLAUDE.md files to load at all** (`sdk.d.ts:2050`).

That last line is load-bearing for **R5-9** and WS-11 §6.4 and was not in either document: on the
pinned branch, `WINTER.md`-equivalent context discovery is *gated on the project settings source*, not
unconditional. R5-9's "`WINTER.md` … is ALWAYS injected as user-context" is therefore a **deliberate
Winter divergence**, not parity, unless T6 gates it the same way. Recorded as OQ-P5-1.

`Options.managedSettings?: Settings` (`2041`) is the programmatic policy tier and, per its own doc
(`2018-2040`), is filtered **restrictive-only**: permissive arrays that would widen an existing admin
lock are dropped. That matches R5-8's "managed" position and adds a rule R5-8 does not state.

### DIVERGENCE: `resolveSettings` is a PINNED export, not a Winter extension

**Source**: `sdk.d.ts:2809` (`resolveSettings`), `2815-2843` (`ResolveSettingsOptions`),
`2759-2774` (`ResolvedSettings`), `2413-2419` (`ProvenanceEntry`), `694` (`filterEscalatingDefaultMode`).

R5-8 introduces `resolveSettings(cwd, sources, managed, opts) → { effective, provenance, sources }` as
"a disclosed Winter extension over the pinned surface". **It is not an extension.** The pinned SDK
exports it, with the same three result fields:

```ts
export declare type ResolvedSettings = {
    effective: Settings;
    provenance: Partial<Record<keyof Settings, ProvenanceEntry>>;
    sources: Array<{ source: ResolvedSettingSource; settings: Settings; path?: string; policyOrigin?: PolicySettingsOrigin }>;
};
export declare type ProvenanceEntry = { source: ResolvedSettingSource; path?: string; policyOrigin?: PolicySettingsOrigin };
export declare function resolveSettings(_opts?: ResolveSettingsOptions): Promise<ResolvedSettings>;
export declare function filterEscalatingDefaultMode(_resolved: ResolvedSettings): Settings;
```

Three shape facts R5-8 must absorb:

1. **Arity.** One options object (`{ cwd?, settingSources?, managedSettings?, serverManagedSettings? }`,
   `2815-2843`), not four positional parameters. `serverManagedSettings` is a fourth input R5-8 does
   not have: a remote policy payload feeding the `'remote'` sub-source, explicitly **unfiltered**
   (`2838-2839`) where `managedSettings` is filtered.
2. **Provenance granularity is per TOP-LEVEL key only** (`2762`, and the `sources` field's own doc at
   `2764-2767` says so and offers the raw per-source array as the escape hatch). Runtime-confirmed in
   capture (1): with `permissions.allow` from `project` and `permissions.defaultMode` from `local`, the
   merged `effective.permissions` carried both, and `provenance.permissions.source` reported `local`
   alone. **A per-value provenance API (R5-8's phrasing) is finer than the pinned one.** Winter may
   ship finer, but must not claim the pinned surface is what it mirrors.
3. **The trust filter is a SEPARATE, EXPLICIT function, not folded into resolution.** `resolveSettings`
   reports the raw cascade including project-tier `permissions.defaultMode`; `filterEscalatingDefaultMode`
   (`686-694`) drops `defaultMode` from the returned `effective` iff it is escalating
   (`bypassPermissions`/`auto`/`acceptEdits`) **and** was set by the `project` tier. Its own doc calls
   `project` the "repo-committed tier". This is the pinned trust concept in declaration form — see
   capture (1) for what the running engine does with it.

### The settings keys the declaration names

`Settings` is an `export declare interface` spanning `sdk.d.ts:5426-7912`, header-marked as generated
from a settings JSON schema (`5418-5425`). The keys the plan's item (a) asks about:

| Plan's assumed key | Pinned spelling | Line | Verdict |
| --- | --- | --- | --- |
| `autoMode` | **`disableAutoMode?: 'disable'`** | `7755` | **DIVERGENCE — no `autoMode` key exists.** A one-member string literal, negative sense |
| `outputStyle` | `outputStyle?: string` | `7270` | present as assumed |
| `autoMemoryEnabled` | `autoMemoryEnabled?: boolean` | `7734` | present as assumed |
| `autoMemoryDirectory` | `autoMemoryDirectory?: string` | `7738` | present, **with a per-key source restriction** (below) |
| `plansDirectory` | `plansDirectory?: string` | `7693` | present as assumed |
| `enabledPlugins` | `enabledPlugins?: { [k: string]: string[] \| boolean \| {…} }` | `6047` | present; value type is a 3-way union, not a boolean map |
| `env` | `env?: { [k: string]: string }` | `5511` | present as assumed |
| `apiKeyHelper` | `apiKeyHelper?: string` | `5434` | present as assumed |
| hooks block | `hooks?: {…}` | `5699` (through `5887`) | present as assumed |
| — | `permissions?: {…}` | `5543` (through `5569`) | the permission-rule block |

**The `autoMode` divergence matters to R5-8 and WS-07 §3.2.** Both state the rule as "`autoMode` is
never taken from project/local". No such key exists to restrict. The pinned analogue of that rule is
`autoMemoryDirectory`, whose own doc (`sdk.d.ts:7736`) says it is ignored when set in project settings,
for security — a per-key project-source restriction, on a *different* key. Winter's rule is not
wrong, but it is Winter-defined and must be disclosed as such; the pinned per-key restriction it can
actually mirror is the auto-memory directory one. Recorded as OQ-P5-2.

Keys the plan did not ask about but which land directly on P5 lanes, all newly pinned here:

| Key | Line | Lane it binds |
| --- | --- | --- |
| `disableWorkflows?: boolean` | `5928` | W — a kill switch WS-11 §1 has no analogue for |
| `enableWorkflows?: boolean` | `5940` | W — separate positive gate; unset means plan-dependent |
| `workflowSizeGuideline?: 'unrestricted'\|'small'\|'medium'\|'large'` | `5944` | W — advisory agent-count guidance |
| `workflowKeywordTriggerEnabled?: boolean` | `5948` | W — the `/ultracode`-equivalent keyword opt-in |
| `disableBundledSkills?: boolean` | `5657` | S — removes builtin skills AND workflows |
| `skillOverrides?: {[k]: 'on'\|'name-only'\|'user-invocable-only'\|'off'}` | `5651` | S — per-skill listing visibility, 4 states |
| `skillListingMaxDescChars?: number` | `5499` | S/C — per-skill description cap in the listing |
| `skillListingBudgetFraction?: number` | `5503` | S/C — context fraction reserved for the listing |
| `disableSkillShellExecution?: boolean` | `5952` | S — inline shell in skills/commands |
| `strictPluginOnlyCustomization?: boolean \| ('skills'\|'agents'\|'hooks'\|'mcp')[]` | `5988` | S |
| `claudeMd?: string` / `claudeMdExcludes?: string[]` | `7788` / `7792` | C — managed-tier injected instructions; exclusion globs |
| `pluginTrustMessage?: string` | `7796` | S — policy-tier-only plugin trust copy |
| `autoCompactEnabled?: boolean` | `7826` | K |
| `autoCompactWindow?: number` | `7599` | K — the pinned analogue of R5-4's `compactionThreshold` |
| `precomputeCompactionEnabled?: boolean` | `7830` | K |
| `fileCheckpointingEnabled?: boolean` | `7850` | K — the settings twin of `Options.enableFileCheckpointing` |
| `autoDreamEnabled?: boolean` | `7742` | C — background memory consolidation |
| `syncClaudeAiSkills` / `syncClaudeAiPlugins` | `5491` / `5495` | S — account-synced tiers; **not read from project settings** per their own docs |

`SlashCommand` (`sdk.d.ts:7932-7949`) is `{ name, description, argumentHint, aliases? }` — the shape
`system/init.slash_commands` and `reloadSkills()` traffic in, and the shape R5-14's command registry
must produce. Note `aliases` is declared: one command may answer to several names.

---

## (b) `SdkPluginConfig`, `system/init`'s plugin/skill/command/output-style fields, `AgentDefinition.memory`

### DIVERGENCE: `SdkPluginConfig` has three fields, not two

**Source**: `sdk.d.ts:4597-4610`.

```ts
export declare type SdkPluginConfig = {
    type: 'local';
    path: string;
    skipMcpDiscovery?: boolean;
};
```

WS-11 §4 and the plan both name `{ type: "local", path }`. `type: 'local'` as the sole member and
`path` as required are confirmed; **`skipMcpDiscovery?: boolean` (`4609`) is a third, undocumented-in-
WS-11 field.** Its own doc says that when true the engine loads the plugin's skills/hooks/agents/
commands but does **not** read its `.mcp.json` or manifest `mcpServers` — for hosts that own the
plugin's MCP connections themselves. That is precisely the Winter daemon's posture (WS-01 §6,
[WS-09]), so Lane S should implement it rather than treat it as out of scope. Recorded as OQ-P5-3.

`Options.plugins?: SdkPluginConfig[]` is `sdk.d.ts:1856`; its doc (`1846`) confirms local is currently
the only supported type, matching WS-11 §4's "remote/marketplace plugins must first exist locally".

### `system/init` — the loaded-surface fields

**Source**: `sdk.d.ts:4853-4913` (`SDKSystemMessage`).

| Field | Line | Type |
| --- | --- | --- |
| `agents?` | `4856` | `string[]` |
| `tools` | `4864` | `string[]` |
| `slash_commands` | `4874` | `string[]` |
| `terminal_slash_commands?` | `4878` | `string[]` — the subset bound to a local terminal |
| `output_style` | `4879` | `string` (required, not optional) |
| `skills` | `4880` | `string[]` (required) |
| `plugins` | `4881-4889` | `{ name: string; path: string; version?: string }[]` |

So WS-11 §4's "`system/init` exposes loaded plugin info with resolved paths" is confirmed at the
declaration: `path` is a required string per entry, `version` optional and doc-marked as
plugin-author-controlled and to be validated before trusting. `skills` and `output_style` are
**required** fields — a Winter init frame that omits them diverges. Capture (4) below reports the
values all seven carry in a default SDK session, and finds four further init fields the declaration
does not list.

`SDKControlInitializeResponse` (`3794-3799`) carries a parallel pair — `output_style: string` and
`available_output_styles: string[]` — the latter having no `system/init` twin; a host that wants the
list of installed output styles reads it from the control channel, not from init. Relevant to WS-11
§6.5 / Lane C.

The reload path is real and typed: `SDKControlReloadPluginsResponse` (`4046-4058`, returning refreshed
commands/agents/plugins/MCP status) and `SDKControlReloadSkillsResponse` (`4074-4076`, returning
`skills: SlashCommand[]`), plus `Query.reloadSkills()` (`2626`) and the add-directory request's
`reload_skills?`/`reload_plugins?` booleans (`4035`, `4034`). Winter's "no watchers inside the SDK"
rule (phase Global Constraints) is consistent with this: the pinned branch reloads on an explicit
control request, never on a watcher.

### `AgentDefinition.memory` — a different tree than WS-11 §3's

**Source**: `sdk.d.ts:83`, doc `80-82`.

```ts
memory?: 'user' | 'project' | 'local';
```

A three-member scope selector — the same three words as `SettingSource`, a different concept. Its doc
names the directories it scopes: `~/.claude/agent-memory/<agentType>/` (user),
`.claude/agent-memory/<agentType>/` (project), `.claude/agent-memory-local/<agentType>/` (local).

**DIVERGENCE.** WS-11 §3 says "Children participate via `AgentDefinition.memory`", in a section whose
subject is auto-memory at `~/.winter/projects/<memory-key>/memory/`. The pinned field does not point
there: it selects a **per-agent-type memory tree keyed by agent type**, in a third location, with a
`-local` directory-name suffix rather than a filename suffix. Winter must either mirror the three
`agent-memory` trees or disclose a divergence; conflating the two is a silent behaviour change.
Recorded as OQ-P5-4.

Neighbouring fields on the same type that P5 lanes touch: `skills?: string[]` (`67`) — its doc says
subagent skill resolution additionally resolves display names and aliases, unlike the main session's
(`3773`); and `tools?` (`46`) whose doc marks passing `'Skill'` there **deprecated** in favour of the
`skills` field, the same note `Options.allowedTools`' doc carries at `1438`. WS-11 §2.2's rule ("that
list MUST include `\"Skill\"` or skills are uninvocable") is therefore describing a *deprecated* path
on the pinned branch. Recorded as OQ-P5-5.

---

## (c) The `systemPrompt` union and `excludeDynamicSections`

### DIVERGENCE: the union has THREE arms, and the preset object has FOUR fields

**Source**: `sdk.d.ts:2159-2164`.

```ts
systemPrompt?: string | string[] | {
    type: 'preset';
    preset: 'claude_code';
    append?: string;
    excludeDynamicSections?: boolean;
};
```

Against WS-11 §6.2/§6.3 and R5-9's `string | { type: "preset", preset: "claude_code", append? }`:

1. **`string[]` is a third arm neither document has.** Its doc (`2105-2109`) explains it: an array of
   prompt blocks, with the exported sentinel `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` (`sdk.d.ts:8157`,
   value `"__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"`, runtime-confirmed as an exported string in capture
   (1)'s symbol sweep) placed as a standalone element to split the globally-cacheable static prefix
   from the session-specific suffix. Blocks before the marker are cacheable cross-session; blocks
   after are not.
2. **`excludeDynamicSections` lives INSIDE the preset object** (`2163`), not as a sibling option.
   R5-9 and WS-11 §6.3 both discuss it as though it were independent. Its doc (`2124`) states
   explicitly that it has **no effect when `systemPrompt` is a string** — so on the pinned branch it
   is a preset-only knob, and Winter's "MUST implement both renderings" applies to the preset path
   only.
3. `preset: 'claude_code'` is a one-member literal (`2161`). WS-01 §6's `"winter_code"` native
   spelling plus `"claude_code"` alias is a Winter widening of a closed literal — correct as a
   compatibility posture, but a caller passing `"winter_code"` to the pinned SDK would not typecheck.

The dynamic sections' own content is named in two docs: `2113-2114` says working directory,
auto-memory and git status; `3764` (the wire twin, below) says working directory and auto-memory path.
R5-9's list (cwd, platform, shell, OS version, date, git summary, memory paths) is a superset —
a Winter-defined rendering, disclosed.

### The wire twin — a second, differently-shaped rendering

**Source**: `sdk.d.ts:3738-3789` (`SDKControlInitializeRequest`).

The control-channel initialize request re-spells the same concepts as four flat fields:

| Field | Line | Note |
| --- | --- | --- |
| `systemPrompt?: string[]` | `3752` | array form only — the `string`/preset arms do not cross this boundary |
| `appendSystemPrompt?: string` | `3753` | the preset object's `append` as a sibling |
| `excludeDynamicSections?: boolean` | `3766` | flat, not nested |
| `planModeInstructions?: string` | `3757` | **new to WS-11** |
| `skills?: string[]` | `3775` | main-session skill filter; doc-contrasted with `AgentDefinition.skills` |

`planModeInstructions` (`3757`) is the pinned name for WS-11 §6.6's host-customizable plan-mode body,
and its doc confirms §6.6's architecture exactly: it replaces the default workflow body while the
runtime still wraps it with the read-only enforcement preamble and the ExitPlanMode protocol footer.
Lane C should use this spelling.

---

## (d) `outputFormat`, `result.structured_output`, the error subtype spelling, the `StructuredOutput` tool

### The option and the result fields

| Shape | Line | Declaration |
| --- | --- | --- |
| `Options.outputFormat` | `1811` | `outputFormat?: OutputFormat` |
| `OutputFormat` | `2207` | `= JsonSchemaOutputFormat` (a one-member alias) |
| `OutputFormatType` | `2209` | `= 'json_schema'` |
| `JsonSchemaOutputFormat` | `963-966` | `{ type: 'json_schema'; schema: Record<string, unknown> }` |
| `SDKResultSuccess.structured_output` | `4751` | `structured_output?: unknown` |
| `SDKResultError.subtype` | `4673` | includes `'error_max_structured_output_retries'` |
| `TerminalReason` | `8203` | includes `'structured_output_retry_exhausted'` |

**The subtype spelling R5-10 asks T1 to derive is `error_max_structured_output_retries`** — exactly as
WS-11 §8 and R5-10 already spell it, on the `SDKResultError.subtype` union at `sdk.d.ts:4673`. **No
divergence.**

**A second spelling exists and is NOT the same field.** `TerminalReason` (`8203`) carries
`'structured_output_retry_exhausted'` — no `error_` prefix, `retry` singular, different word order —
and reaches the host through the optional `terminal_reason` field present on **both** result variants
(`4702` on the error variant, `4753` on the success variant). Capture (6) confirms an exhausted run
emits both, one on each field. A Winter implementation that emits one spelling on both fields, or the
`TerminalReason` spelling as the subtype, is wrong in a way no type-checker catches.

`structured_output` is declared on the **success** variant only (`4751`), typed `unknown`, optional.
The exhaustion path therefore has no `structured_output` at all rather than a null one — confirmed in
capture (6).

### The `StructuredOutput` tool has NO static schema — confirmed, twice

Independently re-verified in this task's own fresh extraction: `StructuredOutput` appears **nowhere**
in `sdk.d.ts`, and `sdk-tools.d.ts`'s `ToolInputSchemas`/`ToolOutputSchemas` unions
(`sdk-tools.d.ts:11-57` / `58-102`) contain **no `StructuredOutputInput`/`Output` member**. This is
the same class of finding `derived-shapes-p3-task8.md` established and P4 re-verified for
`ToolSearch`/`WaitForMcpServers` — and here it is a **confirmation of WS-11 §8's own rule** (which
cites report §40.46 for it) that
the tool "MUST NOT be represented as one static input interface", not a gap: a host-generated schema
*cannot* have a static declaration. Capture (6) proves the generated schema is the caller's schema,
byte-for-byte.

There is one further doc-asserted behaviour worth carrying to Lane K, from `sdk.d.ts:1923-1934`: a
completed `outputFormat` turn ends on a successful tool-result carrier with **no trailing assistant
message**, followed by a `structured_output` attachment holding the turn's actual output — the
carrier's own data is described as a placeholder, and the attachment is the sole persisted copy. That
is a transcript-dialect obligation ([WS-05]) R5-10 does not currently state.

---

## (e) `enableFileCheckpointing`, `rewindFiles`, `file-history` entries

### DIVERGENCE: the parameter is `userMessageId`, and there is a second parameter and a typed result

**Source**: `sdk.d.ts:2641-2643` (method), `2848-2858` (`RewindFilesResult`), `4146-4150` (wire).

```ts
rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<RewindFilesResult>;

export declare type RewindFilesResult = {
    canRewind: boolean;
    error?: string;
    filesChanged?: string[];
    insertions?: number;
    deletions?: number;
    skippedLinks?: number;
};
```

WS-11 §9 and the plan both write `rewindFiles(userMessageUuid)`. The pinned parameter is
**`userMessageId`** (`2641`); its own JSDoc `@param` line (`2637`) does describe it as a UUID, so the
*value* is a UUID and the *name* is not. Beyond the name: an `options?: { dryRun?: boolean }` second
parameter and a six-field typed result, neither of which WS-11 §9's table has. R5-11 must adopt all
three. Recorded as OQ-P5-6.

The wire form is snake_case and drops the result: `SDKControlRewindFilesRequest`
(`4146-4150`) = `{ subtype: 'rewind_files'; user_message_id: string; dry_run?: boolean }`.

`skippedLinks` (`2857`) is a link-safety counter whose doc (`2855`) states a real behavioural
rule R5-11 should mirror: tracked paths that resolve to a symlink/hard link/non-regular file, or whose
parent directory no longer resolves where it did at checkpoint time, or whose backup cannot be safely
read, are **refused rather than restored**, and the counter is populated on real rewinds only — never
on a `dryRun`, whose preview counts therefore do not reflect refusals.

`Options.enableFileCheckpointing?: boolean` is `sdk.d.ts:1549` (doc `1541-1548`, confirming
backup-before-modify as the mechanism class, matching WS-11 §9's "interception + backups"), with the
settings twin `fileCheckpointingEnabled?: boolean` at `7850`.

### `file-history-*` dialect entries: NOT DECLARED

Neither `file-history`, `file_history` nor `fileHistory` occurs as any type, field or literal in any
of the six `.d.ts` files. The **only** occurrence of the concept is prose in `forkSession`'s doc
(`sdk.d.ts:726`), which states that forked sessions start without undo history because file-history
snapshots are not copied.

Two consequences. First, R5-11's "transcript `file-history-snapshot`/`file-history-delta` entries carry
Winter-defined fields when the pinned ones are uncaptured (disclosed)" is confirmed as the right
posture — **the pinned entry names themselves are also uncaptured**, so both the names and the fields
are Winter-defined and both need disclosing. Second, `SessionStoreEntry` (`5372-5377`) is declared as
a deliberately minimal structural supertype — `{ type: string; uuid?: string; timestamp?: string;
[k: string]: unknown }` — whose doc (`5362-5369`) states outright that the concrete entry union is
CLI-internal and not part of the SDK API surface. The transcript dialect is therefore *by design* not
derivable from the declaration; capture-or-define is the only route, for every P5 dialect entry.
Fork's rule is itself a carry: **rewind history does not survive a fork.**

---

## (f) `compact_boundary`, `compact_metadata`, `PreCompact`/`PostCompact`, and the compaction status shape

### `SDKCompactBoundaryMessage`

**Source**: `sdk.d.ts:3205-3238`.

```ts
export declare type SDKCompactBoundaryMessage = {
    type: 'system';
    subtype: 'compact_boundary';
    compact_metadata: {
        trigger: 'manual' | 'auto';
        pre_tokens: number;
        post_tokens?: number;
        duration_ms?: number;
        preserved_segment?: { head_uuid: UUID; anchor_uuid: UUID; tail_uuid: UUID };
        preserved_messages?: { anchor_uuid: UUID; uuids: UUID[] };
    };
    uuid: UUID;
    session_id: string;
};
```

Six `compact_metadata` fields. `trigger` and `pre_tokens` are required; the other four optional.
`preserved_messages` (`3229`) is doc-marked as **superseding** `preserved_segment` (`3221`): readers
look each UUID up directly and relink `uuids[i]` to `uuids[i-1]` (and `uuids[0]` to `anchor_uuid`)
rather than walking the `parentUuid` chain. Both are unset when compaction summarizes everything, i.e.
when nothing is kept.

R5-4 specifies "the summary and boundary persist as a `compact_boundary` system entry + summary in the
dialect" without naming the metadata. **This is the field set to persist**, and the
`preserved_messages`-supersedes-`preserved_segment` relationship is a resume-correctness requirement,
not a nicety: a Winter loader that reads only `preserved_segment` silently loses the kept segment on
any boundary written with the newer field.

### `PreCompact` / `PostCompact` — cited, not re-derived

Both rows are already pinned in `derived-shapes-p2.md`'s hook table. Per this task's brief, cited:

- **`PreCompact`** — `derived-shapes-p2.md:150`; input `sdk.d.ts:2388-2392` = `trigger: 'manual' |
  'auto'; custom_instructions: string | null`; **no hook-specific output type exists** (generic
  envelope only).
- **`PostCompact`** — `derived-shapes-p2.md:151`; input `sdk.d.ts:2312-2319` = `trigger: 'manual' |
  'auto'; compact_summary: string`; likewise **no hook-specific output type**.

Both re-verified against this task's own extraction at those lines. The absence of a `PreCompact`
output type is the declaration-level basis for WS-08 OQ4's resolution and R5-4's "**no veto
invented**": there is no output shape in which a veto could be expressed. `PostCompact` receiving the
summary as a required `string` means the summary must exist before the hook fires — an ordering
constraint on T3's firing points.

`trigger`'s two members (`'manual' | 'auto'`) are the same two on `compact_metadata`, `PreCompact` and
`PostCompact` — one vocabulary, three sites. R5-4's two triggers (threshold-crossing and `/compact`)
map onto `auto` and `manual` respectively.

### The compaction status/warning shape — it exists, and it is a distinct message

**Source**: `sdk.d.ts:4836` (`SDKStatus`), `4838-4848` (`SDKStatusMessage`).

```ts
export declare type SDKStatus = 'compacting' | 'requesting' | null;

export declare type SDKStatusMessage = {
    type: 'system';
    subtype: 'status';
    status: SDKStatus;
    permissionMode?: PermissionMode;
    compact_result?: 'success' | 'failed';
    compact_error?: string;
    uuid: UUID;
    session_id: string;
};
```

This answers item (f)'s open half. There is **no threshold-warning event**: the pinned surface carries
an in-progress marker (`status: 'compacting'`) and a terminal outcome pair (`compact_result` +
`compact_error`) on one status message, and nothing that fires *before* compaction to warn of
approach. R5-4's "threshold/warning events on the host stream" is therefore a Winter addition, not
parity, and should be disclosed as one. Recorded as OQ-P5-7.

`derived-shapes-p4.md`'s item (b) already established that `SDKStatusMessage` is not an MCP-status
message; this document adds what it *is* — the compaction status channel, plus a permission-mode echo.
The two findings are complementary, not in tension.

Adjacent, for Lane K's context accounting: `autoCompactWindow?: number` (`7599`) is the pinned
settings key nearest R5-4's `compactionThreshold`; `autoCompactEnabled?: boolean` (`7826`) is the
on/off; `precomputeCompactionEnabled?: boolean` (`7830`) implies the pinned runtime can prepare a
compaction ahead of need. None of the three is a fraction-vs-token-count disambiguation, so R5-4's
`0.92` default stays capture-pending as the plan already says.

---

## (g) `WorkflowInput`'s seven fields, and the `WorkflowOutput` the spec did not know was declared

### `WorkflowInput` — seven fields, exactly as WS-11 §1.1

**Source**: `sdk-tools.d.ts:2758-2789`; union membership `sdk-tools.d.ts:42`.

| Field | Line | Type | WS-11 §1.1 says |
| --- | --- | --- | --- |
| `script?` | `2762` | `string` | matches |
| `name?` | `2766` | `string` | matches |
| `description?` | `2770` | `string` | matches (doc-marked ignored, `2768`) |
| `title?` | `2774` | `string` | matches (doc-marked ignored, `2772`) |
| `args?` | `2778` | `{ [k: string]: unknown }` | WS-11 writes `Record<string, unknown>` — same shape |
| `scriptPath?` | `2784` | `string` | matches, incl. precedence (`2782`) |
| `resumeFromRunId?` | `2788` | `string` | matches |

**All seven confirmed, all optional, no eighth.** Three doc-asserted rules WS-11 §1 already states are
confirmed verbatim at the declaration: the `meta` block must be a **pure literal with no computed
values** (`2760`); `scriptPath` **takes precedence over `script` and `name`** (`2782`); and
`resumeFromRunId` is **same-session only, with the prior run stopped first via TaskStop** (`2786`).

Two further doc-asserted facts:

- **`name` resolves from `.claude/workflows/`** (`2764`) — confirming WS-11 §1.3 and R5-5's
  `.winter/workflows/<name>.js`, and confirming that Norma's save-on-completion inversion is a real
  retirement, not a misreading.
- **Every invocation persists its script under the session directory and returns the path**
  (`2782`) — the declaration-level half of WS-11 OQ4. Capture (3) supplies the exact directory.

The `@minItems`/`@maxItems`-style caps WS-11 §1.6 lists (`min(16, CPUs−2)`, 1000, 4096) do **not**
appear in the declaration; WS-11 §11 OQ1 already sources them from the live harness reference rather
than the pin, and this task confirms the pin is silent — so OQ1's framing is correct and unchanged.
Beyond the input schema there is no script-surface evidence in any `.d.ts`: no `agent`/`parallel`/
`pipeline`/`phase`/`budget` symbol exists.

### NEW: `WorkflowOutput` is fully declared — WS-11 §1.4 can stop being prose

**Source**: `sdk-tools.d.ts:4053-4089`; union membership `sdk-tools.d.ts:96`.

```ts
export interface WorkflowOutput {
    status: "async_launched" | "remote_launched";
    taskId: string;
    taskType?: "local_workflow" | "remote_agent";
    workflowName?: string;
    runId?: string;
    summary?: string;
    transcriptDir?: string;
    scriptPath?: string;
    sessionUrl?: string;
    warning?: string;
    error?: string;
}
```

WS-11 §1.4 describes this field set in prose sourced from the report ("async/remote launch status,
`taskId`/type, workflow/run IDs, transcript/script paths, and optional session URL/warning/error").
It is a **declared interface**, and Lane W should code against it directly. Field-level notes:

- `status` and `taskId` are the only required fields; every other field is optional, several
  doc-marked as absent only on transcripts predating them (`4057`, `4061`, `4065`).
- `taskType` couples the Workflow tool to the P3 background-task surface with a **pinned task-kind
  literal, `"local_workflow"`** (`4059`) — R5-5's "the `workflow` task kind" now has a spelling, and
  it is not `workflow`. Capture (3) confirms the running engine emits exactly this literal on
  `task_started.task_type`.
- `workflowName` is doc-asserted (`4061`) to be `meta.name` and to equal `task_started.workflow_name`
  — a cross-surface identity Lane W must preserve.
- `runId` is the `resumeFromRunId` handle and is doc-asserted absent for `remote_launched` (`4065`).
- `error` is doc-asserted (`4086`) to be set specifically when the **syntax check** fails — so a
  script that fails validation still returns a `WorkflowOutput`, it does not throw.

One asymmetry worth flagging: `taskType`'s doc mentions a `remote:true` input dispatching to a remote
runner, but **`WorkflowInput` declares no `remote` field**. Winter should implement the local half
only, as WS-11 §1 already scopes it.

---

## (h) `NotificationHookInput` and the `notification_type` values

**Source**: `sdk.d.ts:1329-1334`, already pinned at `derived-shapes-p2.md:141` and cited rather than
re-derived; re-verified at those lines in this task's own extraction.

```ts
export declare type NotificationHookInput = BaseHookInput & {
    hook_event_name: 'Notification';
    message: string;
    title?: string;
    notification_type: string;
};
```

Three fields beyond the base envelope: `message` required, `title` optional, `notification_type`
required. Output type `NotificationHookSpecificOutput` (`1336-1339`) carries `additionalContext?` only.

**`notification_type` is an OPEN `string` — the declaration enumerates NO values** (`1333`). R5-13
records the spellings as capture-pending; this confirms the declaration will never supply them, so the
only routes are a runtime capture of the pinned CLI's own emissions (out of reach of this task's
hermetic single-turn probes — none of the three R5-13 emission points, a permission prompt shown /
idle-waiting / task completion, fires a `Notification` hook in a canned single-shot run) or a
Winter-defined vocabulary, disclosed. R5-13's "observational only" posture makes the latter safe.
Recorded as OQ-P5-8.

Do not confuse this with `SDKNotificationMessage` (`sdk.d.ts:4529-4539`), a different shape on a
different channel: `{ type: 'system', subtype: 'notification', key, text, priority: 'low' | 'medium' |
'high' | 'immediate', color?, timeout_ms? }`. It has a **closed four-member `priority` union** and no
`notification_type` at all. A Winter implementation that reuses one vocabulary across both surfaces
would be inventing a coupling the pin does not have.

---

## (i) The `Skill` tool input and the `invoked_skills`/`skill_listing` attachments

### DIVERGENCE: there is NO `Skill` tool schema in the declaration

Exhaustively verified in both extraction cycles: `sdk-tools.d.ts`'s `ToolInputSchemas` union
(`sdk-tools.d.ts:11-57`) has **no `SkillInput` member**, `ToolOutputSchemas` (`58-102`) has no
`SkillOutput`, and no `Skill`-prefixed interface is declared anywhere in `sdk-tools.d.ts`. The only
skill-adjacent tool schemas are `ProposeSkillsInput` (`sdk-tools.d.ts:51`, declared at `2885`) and
`ProposeSkillsOutput` (`92`, at `3966`) — the WS-06 `ProposeSkills` row, a *different* tool.

The bare string `Skill` does occur in `sdk.d.ts` — four times, none of them a schema: two deprecation
notes steering callers from `allowedTools`/`AgentDefinition.tools` to the `skills` option (`44`,
`1438`), and two in the `skills` option's own doc (`2055`, `2065`, the latter stating that unlisted
skills are rejected by the Skill tool).

This is the same finding class P3-T8 and P4 established for `ToolSearch`/`WaitForMcpServers`/
`StructuredOutput`, and — as there — it is a **confirmation that WS-11 §2.3's own sourcing was
correct**: §2.3 cites report §40.32 (a runtime capture), never a `.d.ts` line, for `{ skill: string;
args?: string }`. Capture (4) confirms `Skill` **is** advertised by the running engine, so the tool is
real and only its schema is undeclared. Winter's own `{ skill, args? }` shape therefore rests on the
report, exactly as the spec says, and this task adds no independent confirmation of the field names.

### `invoked_skills` / `skill_listing`: NOT DECLARED

Neither string occurs in any of the six `.d.ts` files. Per item (e)'s finding that the transcript
entry union is CLI-internal by design (`sdk.d.ts:5362-5369`), this is expected rather than surprising:
attachment entry names are simply not on the SDK API surface. **R5-14's "the dialect `invoked_skills`
attachment" is therefore a Winter-defined entry name**, and the same disclosure R5-11 makes for
`file-history-*` applies here. Recorded as OQ-P5-9.

Skill *listing* does have a declared surface, just not that one: `Settings.skillListingMaxDescChars`
(`5499`, per-skill description cap, doc-stated default 1536) and `Settings.skillListingBudgetFraction`
(`5503`, fraction of the context window reserved for the listing, doc-stated default 0.01), plus
`skillOverrides`' four-state per-skill visibility (`5651`). Together these pin the *shape* of WS-11
§2.1's "name+description metadata index, bodies loaded lazily": the listing is budgeted and truncated,
not merely enumerated. `SDKCommandsChangedMessage` (`3197-3203`) is the mid-session push that follows
dynamic skill discovery, carrying the full `SlashCommand[]` for wholesale client replacement.

---

## Hermetic captures

All six ran against the checksum-verified pinned runtime under the hermeticity contract in Method.
Verdicts: **all six captured**; none recorded as not-capturable.

| # | Subject | Verdict |
| --- | --- | --- |
| 1 | Trust semantics under `settingSources` (R5-6) | **captured** — discriminating |
| 2 | `enableFileCheckpointing` + external `SessionStore` (WS-11 OQ3) | **captured verbatim** |
| 3 | Persisted Workflow script location (WS-11 OQ4) | **captured** |
| 4 | `Workflow`/`Skill`/`StructuredOutput` in the default advertised set | **captured** |
| 5 | AskUserQuestion answers keying (P3 carry) | **captured** — discriminating |
| 6 | `MAX_STRUCTURED_OUTPUT_RETRIES` default behaviour | **captured** |

### Capture (1) — trust is REAL, SOURCE-TIERED, and asymmetric between allow and deny

**Design.** The tool driven is `Write` to a path inside the throwaway cwd, chosen after ruling out
`Read` (auto-allowed, so it cannot discriminate). A `canUseTool` callback that always allows records
whether a permission decision was *asked for*; **zero invocations means a settings rule silenced the
prompt**, one invocation means it did not. A no-rule control establishes that `Write` prompts at all.
`allowedTools` was deliberately NOT used: the runtime emits a `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`
warning explaining that bare `allowedTools` entries auto-approve *before* the callback, which would
have destroyed the discriminator. 13 cells, each its own fresh cwd/config/home:

| Cell | Rule and file | `settingSources` | `canUseTool` fired | Tool outcome |
| --- | --- | --- | --- | --- |
| A | *(none — control)* | `["project"]` | **yes** | written |
| B | `allow:["Write"]` in `.claude/settings.json` | `["project"]` | **yes** | written |
| C | same file present | `[]` | yes | written |
| D | `allow:["Write"]` in `.claude/settings.local.json` | `["local"]` | **NO** | written |
| H | `allow` in `settings.local.json` | `["project"]` | yes | written |
| I | `allow` in `settings.json` | `["project","local"]` | **yes** | written |
| J | `allow` in **both** files | `["project","local"]` | **NO** | written |
| K | `deny:["Write"]` project + `allow` local | `["project","local"]` | NO | **DENIED** |
| L | `deny:["Write"]` in `settings.json` | `["project"]` | NO | **DENIED** |
| M | `ask:["Write"]` in `settings.json` | `["project"]` | yes | written |
| N | `allow:["Write"]` in `<CLAUDE_CONFIG_DIR>/settings.json` | `["user"]` | **NO** | written |
| O | `allow:["Write(*)"]` in `settings.json` | `["project"]` | yes | written |
| P | `allow:["Write(*)"]` in `settings.local.json` | `["local"]` | **NO** | written |

**Finding, decisive for R5-6.** Selecting `'project'` as a settings source is **not** trust, and the
pinned SDK does **not** lack a trust concept either. It has one, and it is a *per-tier filter on
permissive rules*:

- an `allow` rule from the **project** tier (repo-committed `.claude/settings.json`) is loaded but does
  **not** widen — the prompt still fires (B, I, O). Adding `'local'` to the source list does not rescue
  it (I); only an allow rule that is *itself* in the local file silences (J vs I is the same source
  list, and the only variable is which file carries the rule);
- an `allow` rule from the **local** tier (gitignored `.claude/settings.local.json`) **is** honored (D,
  J, P);
- an `allow` rule from the **user** tier is honored (N);
- a `deny` rule from the **project** tier **is** honored, and beats a local `allow` (K, L) — the tool
  is refused outright with a not-available-this-session tool error, not merely re-prompted;
- rule *form* is not the variable: the bare name and the `Write(*)` glob behave identically within a
  tier (B vs O, D vs P);
- source gating itself works independently of all this: a rule in a file whose tier is not selected has
  no effect (H, C).

This is precisely **"a project may tighten but never widen"** — WS-11 §5's carried trust rule and
WS-07 §3.2's.

**The rival reading, and the cell that splits it.** Those 13 cells are *individually* also consistent
with a second mechanism: project-tier `allow` widening only inside a **trusted directory**, with every
probe cwd being a fresh `mkdtemp` that has never been trusted — under which reading
`filterEscalatingDefaultMode`'s own doc phrases ("trust filter", "repo-committed tier") would describe
one per-*directory* bit rather than a per-*tier* rule, and R5-6's `trustedWorkspace` fallback would be
the parity branch rather than a divergence. The two readings produce identical observables on all 13
cells, so a fourteenth was run: capture (2) had shown the runtime writes `<CLAUDE_CONFIG_DIR>/.claude.json`,
which is where the interactive CLI keeps per-project state. Reading that file's **keys only** after a
control run:

- its top-level key set contains **no trust-, onboarding-, accept- or approve-named key**;
- its `projects` map is **empty — zero entries** — i.e. the SDK path never records per-project state at
  all for the cwd it just ran in;
- pre-seeding a fresh config dir with a `projects` entry for the cwd carrying the interactive CLI's
  known trust flags all set true, then re-running the project-`allow` cell and the project-escalating-
  `defaultMode` cell, changed **nothing**: both still prompted, both still reported
  `permissionMode: "default"`.

Together with `filterEscalatingDefaultMode`'s documented condition being purely tier-based (it names
`project`, and no directory), that is three independent strikes against the per-directory reading, and
the per-tier reading is the one this document adopts. **Residual limit, stated rather than papered
over:** the seeded flag names were the interactive CLI's, guessed rather than read from the artifact —
a differently-named marker consulted only in SDK mode would not have been exercised. The empty
`projects` map is the strongest single piece of evidence against that possibility, but it is evidence,
not proof.

**Second, independent confirmation via the declared API.** `resolveSettings` + `filterEscalatingDefaultMode`
were driven directly (in-process, with `CLAUDE_CONFIG_DIR`/`HOME` redirected to mkdtemps and
`settingSources` always explicit — never omitted, which would read the real user home):

| Escalating `defaultMode` set in | `provenance.permissions.source` | `filterEscalatingDefaultMode` result |
| --- | --- | --- |
| `acceptEdits` in project (alongside `allow`+`deny`) | `project` | `defaultMode` **dropped**; `allow`/`deny` retained |
| `bypassPermissions` in project | `project` | `defaultMode` **dropped** |
| `plan` in project (non-escalating) | `project` | **retained** |
| `acceptEdits` in local | `local` | **retained** |

Exactly the documented contract at `sdk.d.ts:686-694`, and it surgically removes one key rather than
discarding the tier.

**What this means for R5-6/R5-8.** The capture discriminates, so R5-6's fallback (a disclosed
`trustedWorkspace?: boolean`, default false, with no inference from `settingSources`) is not the branch
to take for the *rule-filtering* half. `WorkspaceTrustSource` should implement the captured semantics:
project-tier `allow` and escalating `defaultMode` are dropped; project-tier `deny` (and, on the evidence
of cell M being indistinguishable from the control, at minimum not-widened `ask`) applies regardless;
`local` and `user` tiers are honored in full. R5-8's "project/local overlays are ignored when
untrusted EXCEPT deny/ask rule lists" is the right shape but mis-scoped on one axis: the pinned filter
distinguishes **project from local**, not "trusted directory from untrusted". Recorded as OQ-P5-10.

Note that a Winter `trustedWorkspace` bit and this per-tier filter are **not** alternatives at the same
layer — Winter may keep a directory-trust concept as a product extension *above* the tier filter, and
should, since the daemon has a trust notion the SDK does not. What the capture forbids is deriving the
tier filter *from* such a bit, which would make an untrusted-but-project-`deny` repo silently unenforced.

**Two cells are non-discriminating and must not be over-read.** M (project `ask`) produced the same
observable as the control, because the control already prompts — this capture cannot tell whether
project-tier `ask` was honored or ignored. And every cell's `system/init.permissionMode` read
`"default"`, including E/F/G from the first probe round (escalating `defaultMode` in project and in
local): in SDK mode the init frame's `permissionMode` reflects the SDK option, and no settings-file
`defaultMode` reached it from any tier. Whether local-tier `defaultMode` can drive SDK-mode
permission behaviour at all is untested here.

### Capture (2) — the rejection is a plain `Error` at construction. VERBATIM

**Design.** Four option combinations, each constructed and iterated; the probe records separately
whether the throw happened *synchronously inside `query()`* or later during iteration.

| Combination | Result |
| --- | --- |
| `enableFileCheckpointing: true` + `sessionStore` | **throws synchronously at `query()` construction** |
| `enableFileCheckpointing: true` alone | no throw; run completes; `<CLAUDE_CONFIG_DIR>` gains `backups/` |
| `sessionStore` alone | no throw; run completes |
| `enableFileCheckpointing: true` + `sessionStore` + `persistSession: false` | throws at construction — with the **`persistSession` message**, not this one |

**Captured verbatim** — class, `name`, and message:

- class: `Error` (the plain built-in — **not** a named subclass), `err.name === "Error"`
- message: `enableFileCheckpointing is not yet supported with sessionStore (backup blobs are not mirrored, so rewindFiles() fails after a store-backed resume).`

Thrown **synchronously from `query()` itself**, before any request reaches the loopback (request count
0, zero messages yielded).

**This settles WS-11 OQ3 and confirms R5-11's construction-time timing.** Three refinements R5-11
should absorb: (i) there is **no typed error class** — a `WinterUnsupportedCombinationError` would be
*stricter* than the pin, which is defensible but is a divergence to disclose rather than parity;
(ii) the *reason* is specific and narrow (backup blobs are not mirrored, so `rewindFiles()` fails after
a store-backed resume), which supports WS-11 §9's "stays correctly unavailable until a supported
full-filesystem implementation is proven" as the right long-term framing; (iii) **validation order is
observable** — the `persistSession: false` conflict is checked first and wins, so Winter's own
constructor must check in the same order or a triple-conflicting call reports a different message than
the pin does. The `persistSession` message is likewise captured: `sessionStore cannot be used with
persistSession: false -- the storage adapter requires local writes to mirror from. Use
CLAUDE_CONFIG_DIR=/tmp for ephemeral local writes with external mirroring.`

Context from item (e)/the declaration that explains the narrowness: the pinned `sessionStore` is a
**dual-write mirror**, not a replacement store (`sdk.d.ts:1672-1683`) — local writes always happen.
The rejection is thus about *backup blobs specifically*, not about external storage in general.

Incidental but load-bearing for R5-11: with checkpointing on, the config dir contained
`["projects","sessions",".claude.json","backups"]` — a `backups/` sibling of `projects/`, **not** the
`~/.claude/file-history/<uuid>/` path WS-11 §9's mechanism row and R5-11 assume. Recorded as OQ-P5-11.

### Capture (3) — the persisted Workflow script lives in the DURABLE session area

**Design.** A canned `Workflow` tool_use carrying a two-line script (a pure-literal `meta` and a
`return`, no `agent()` calls) so the run completes in milliseconds without a model. The tool result and
the task lifecycle messages were read, then all three temp roots were walked for the file.

**Captured.** The run reached `completed`, and the persisted script path is (mkdtemp roots redacted):

```
<CLAUDE_CONFIG_DIR>/projects/<sanitized-cwd>/<session-uuid>/workflows/scripts/<meta.name>-<runId>.js
```

with the sibling subagent transcript directory:

```
<CLAUDE_CONFIG_DIR>/projects/<sanitized-cwd>/<session-uuid>/subagents/workflows/<runId>
```

`<sanitized-cwd>` is the absolute cwd with path separators and dots replaced by `-`; `<runId>` matched
`wf_` + a short hex-ish token. A filesystem walk of all three roots found the `.js` file at exactly
that path and **nowhere else** — no copy in the OS temp dir, none under `HOME`, none in the cwd.

**This settles WS-11 OQ4 for [WS-05]'s layout table: durable, not session-temp**, under the per-session
transcript directory rather than under a scratch area, and therefore surviving process exit — which is
what makes the documented iterate-then-re-invoke-with-`scriptPath` loop work at all. Winter's
equivalent is `~/.winter/projects/<memory-key>/<session-uuid>/workflows/scripts/`.

Three further runtime facts, all matching the declaration derived in item (g):

- `task_started` carried `task_type: "local_workflow"` and `workflow_name` equal to `meta.name`,
  confirming both pinned literals;
- the tool result is the `async_launched` shape: task id, summary, transcript dir, script path, run id
  — the `WorkflowOutput` field set, rendered as text lines for the model;
- `task_updated` carried `patch: { status: "completed", end_time }` and a `task_notification` followed
  with `status: "completed"` and an `output_file`, confirming WS-11 §1.4's background-task integration
  and §1.8's `running → completed` lifecycle.

### Capture (4) — the default advertised set: 24 tools, `Workflow` and `Skill` both in it

**Design.** Scenario-C-shaped: minimal options, zero tool/permission/hook configuration, so the only
variable is which branch produced the list.

**Captured.** `system/init.tools`, 24 entries:

`Task`, `Bash`, `CronCreate`, `CronDelete`, `CronList`, `DesignSync`, `Edit`, `EnterWorktree`,
`ExitWorktree`, `ListAgents`, `Monitor`, `NotebookEdit`, `PushNotification`, `Read`, `ReportFindings`,
`ScheduleWakeup`, `SendMessage`, `Skill`, `TaskOutput`, `TaskStop`, `WebFetch`, `WebSearch`,
`Workflow`, `Write`

Answering item (4) directly:

- **`Workflow` — advertised by default.** No settings file was present and no `enableWorkflows` value
  was set, so its unset default (doc-described at `5938` as plan-dependent) resolved to *on* in this
  configuration — a positive gate that happened to be open, not proof that the gate is inert.
  `disableWorkflows` is the kill switch of the pair.
- **`Skill` — advertised by default**, and advertised even though `Options.skills` was omitted, which
  confirms that option's own doc-asserted rule (`sdk.d.ts:2058-2059`) that omitting it means no SDK
  auto-configuration rather than skills-off: 16 builtin skills were listed with `skills` unset, and
  passing `skills: 'all'` changed neither the tool list nor the skill list.
- **`StructuredOutput` — NOT advertised by default**, and *is* advertised once `outputFormat` is set
  (capture (6)). Exactly the host-generated behaviour WS-11 §8 describes.

**Cross-check against the P4 goldens.** Winter's own goldens carry 28-29 tools
(`goldens/advertised-set-round.trace.json`: 28; `goldens/plain-query.trace.json`: 29). The set
difference is substantive, not cosmetic, and belongs in a WS-06 reconciliation rather than this file:

- **in the pin, absent from Winter's default**: `DesignSync`, `WebFetch`, `WebSearch`, `Workflow`,
  `Skill` (the last two being P5's own deliverables, expected);
- **in Winter's default, absent from the pin**: `AskUserQuestion`, `Glob`, `Grep`, `EnterPlanMode`,
  `ExitPlanMode`, `ReadNotifications`, `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`;
- **named differently**: the pin's `system/init` says `Task` where Winter says `Agent` — and the pin's
  own **API request** says `Agent` (capture (6)'s request-body tool list), so the pinned runtime
  advertises one name to the host and a different one to the model. Any Winter conformance assertion
  that compares an init tool list to a request tool list will disagree with the pin unless it models
  this alias.

Recorded as OQ-P5-12. Note the brief's "24-tool" figure is confirmed exactly.

The init frame carried four fields the declaration does not list: `analytics_disabled`,
`product_feedback_disabled`, `memory_paths`, `messaging_socket_path`. **`memory_paths`** is directly
relevant to WS-11 §3/§6.3 (the auto-memory paths that `excludeDynamicSections` relocates) and to Lane
C; its presence on the wire but not in `SDKSystemMessage` means a declaration-driven Winter init frame
would omit it silently. Recorded as OQ-P5-13.

### Capture (5) — answers are keyed by QUESTION TEXT, not by header

**Design.** Two runs, identical but for the key used. Two questions with distinct `question` and
`header` values; `canUseTool` returns `{ behavior: "allow", updatedInput: { ...input, answers } }` with
`answers` keyed by question text in run A and by header in run B; the resulting `tool_result` is read.

**Captured, discriminating.**

| Run | `answers` keyed by | Tool result |
| --- | --- | --- |
| A | **question text** | both questions reported answered, each answer echoed against its question |
| B | **header** | reported as unanswered |

**The pinned keying is the question text.** The declaration agrees independently, and this is the
first time the two have been cross-checked: `AskUserQuestionOutput.answers` (`sdk-tools.d.ts:3816-3818`)
is documented at `3814` as mapping question text to answer string, with multi-select answers
comma-separated, and `annotations` (`3826`) is documented at `3824` as keyed by question text.

**This falsifies Winter's current convention.** `packages/runtime/src/tools/impl/ask-user-question.ts:41`
exports `ASK_USER_QUESTION_ANSWER_KEY_FIELD = "header"`, and its own header comment records that the
declaration never pinned the key so Lane E chose `header` by convention — with `ask-user-question.test.ts:185`
asserting that choice. The declaration *does* pin it, on the Output side, and the runtime confirms it:
the key is `question`. The single exported constant Lane E created is exactly the right seam for the
fix — flipping its value plus its M7 test is a one-line semantic change, and the file's duplicate-key
validation (currently "duplicate header across questions") must move to duplicate *question text*,
which is also the more natural uniqueness constraint. Recorded as OQ-P5-14; the P3 carry is discharged.

### Capture (6) — default 5 attempts, env override honored, generated schema is the caller's schema

**Design.** `outputFormat: { type: 'json_schema', schema }` where `schema` requires a numeric `x`; the
loopback returns a `StructuredOutput` tool_use carrying `{ x: "not-a-number" }` on every turn, so the
run can only end by exhaustion. Run twice: once with the env untouched, once with
`MAX_STRUCTURED_OUTPUT_RETRIES: "2"` added to the replaced `env` object (the only channel by which an
env var reaches the pinned runtime under this harness).

**Captured.**

| Run | validation-failure tool results | `/v1/messages` requests | Terminal message |
| --- | --- | --- | --- |
| env unset | **5** | 10 (+1 preflight) | `Failed to provide valid structured output after 5 attempts` |
| `MAX_STRUCTURED_OUTPUT_RETRIES=2` | **2** | 4 (+1 preflight) | `Failed to provide valid structured output after 2 attempts` |

Both runs ended identically in shape:

- `result.subtype` = `error_max_structured_output_retries` — the item (d) spelling, confirmed on the wire;
- `result.terminal_reason` = `structured_output_retry_exhausted` — the *other* spelling, on its own
  field, in the same message, confirming item (d)'s two-spelling warning empirically;
- `result.is_error` = `true`, `result.structured_output` absent;
- `query()` additionally **threw** to the caller, wrapping the terminal text: `Error: Claude Code
  returned an error result: Failed to provide valid structured output after N attempts`. A Winter
  implementation that only emits the result message and does not reject the iterator diverges.

**Default is 5 and `MAX_STRUCTURED_OUTPUT_RETRIES` overrides it** — WS-11 §8 and R5-10 confirmed on
both counts, including the unbranded env spelling (WS-01 §2.5). The counter counts **attempts**, and
the terminal text says "attempts", so `MAX_STRUCTURED_OUTPUT_RETRIES=2` yields two total attempts, not
one attempt plus two retries.

**Bonus — R5-10's central claim, proven directly.** The loopback captured the advertised tool list as
it reached the API. `StructuredOutput` appeared in it (25 tools, the 24 of capture (4) with `Task`
rendered as `Agent`, plus `StructuredOutput`), and its `input_schema` was the caller's schema
**verbatim, byte-for-byte** — same `type`, `properties`, `required` and `additionalProperties`, no
wrapper object, no envelope field. R5-10's "a host-generated `StructuredOutput` descriptor whose
`input_schema` IS the caller's schema" is exact.

Each failed attempt returned an error tool result whose text names the JSON-Pointer path and the
expected type — the shape `ajv`'s own error rendering produces, which is a useful corroboration for
R5-7's choice of `ajv` and a concrete target for Lane K's error text.

---

## Open questions / divergences

Each is a place the pinned artifact and WS-11 or the plan's rulings do not line up. None blocks T2/T3;
all need a decision before the owning lane's brief is written.

1. **OQ-P5-1 — `WINTER.md` discovery is gated on the project settings source in the pin.**
   `sdk.d.ts:2050` states `'project'` must be in `settingSources` for CLAUDE.md files to load at all.
   R5-9 says `WINTER.md` is ALWAYS injected. Decide: mirror the gate (parity), or keep the
   unconditional injection as a disclosed Winter divergence. **Lane C.**
2. **OQ-P5-2 — `autoMode` does not exist.** The pinned key is `disableAutoMode?: 'disable'`
   (`7755`), and the per-key project-source restriction R5-8/WS-07 §3.2 attach to `autoMode` actually
   exists on `autoMemoryDirectory` (`7736`). Winter's rule is defensible but Winter-defined; the
   mirrorable pinned restriction is the auto-memory one. **T2 + WS-07.**
3. **OQ-P5-3 — `SdkPluginConfig.skipMcpDiscovery` is undocumented in WS-11 §4** (`4609`) and is
   exactly the daemon-host posture Winter wants. Adopt or explicitly defer. **Lane S.**
4. **OQ-P5-4 — `AgentDefinition.memory` points at `agent-memory/<agentType>/`, not auto-memory**
   (`83`, doc `80-82`). WS-11 §3 conflates the two. Decide whether Winter ships the three per-agent-type
   trees. **Lane C + [WS-10].**
5. **OQ-P5-5 — putting `'Skill'` in `allowedTools`/`AgentDefinition.tools` is doc-marked deprecated**
   (`44`, `1438`) in favour of the `skills` option. WS-11 §2.2 states the include-`"Skill"` rule as
   current. Restate it as the deprecated path. **Lane S.**
6. **OQ-P5-6 — `rewindFiles` signature.** Pinned: `rewindFiles(userMessageId: string, options?:
   { dryRun?: boolean }): Promise<RewindFilesResult>` (`2641-2643`), wire `{ user_message_id, dry_run? }`
   (`4146-4150`), result six fields (`2848-2858`). WS-11 §9/R5-11 have `rewindFiles(userMessageUuid)`
   and no result type. Adopt the pinned name, the `dryRun` option, and `RewindFilesResult`. **Lane K.**
7. **OQ-P5-7 — there is no compaction *warning* event in the pin.** `SDKStatusMessage` (`4838-4848`)
   carries an in-progress `status: 'compacting'` and a terminal `compact_result`/`compact_error`, and
   nothing fires before compaction. R5-4's "threshold/warning events" is a Winter addition — disclose
   it, and adopt the pinned status shape for the two events that do exist. **Lane K.**
8. **OQ-P5-8 — `notification_type` is an open `string` with no declared values** (`1333`) and no
   R5-13 emission point fires in a single-shot canned run. The vocabulary will be Winter-defined;
   confirm that is acceptable given R5-13's observational-only posture, and do not reuse
   `SDKNotificationMessage.priority`'s closed four-member union for it. **P2 carry / T8.**
9. **OQ-P5-9 — `invoked_skills`/`skill_listing` are not declared**, and per `5362-5369` the transcript
   entry union is CLI-internal by design, so they never will be. R5-14's attachment name is
   Winter-defined; disclose alongside R5-11's `file-history-*` disclosure. **Lane S/K.**
10. **OQ-P5-10 — R5-6's trust seam must implement a per-TIER filter, not a per-directory bit.**
    Capture (1): project-tier `allow` and escalating `defaultMode` are dropped; project-tier `deny` is
    honored and beats a local `allow`; `local` and `user` tiers are honored in full. R5-8's
    "project/local overlays are ignored when untrusted" is mis-scoped — the pin distinguishes project
    from local, not trusted-directory from untrusted. The rival per-directory reading was separately
    tested and struck out three ways (empty `projects` map in `.claude.json`, no trust-named key,
    seeded trust flags inert) — see capture (1)'s own "rival reading" paragraph for the residual limit.
    A Winter directory-trust bit may still exist as a product extension *above* this filter; what is
    forbidden is deriving the filter from it. Whether project-tier `ask` is honored is **untested**
    (capture (1) cell M is non-discriminating) and stays capture-pending. **T2.**
11. **OQ-P5-11 — the checkpoint backup directory is `<CLAUDE_CONFIG_DIR>/backups/`**, a sibling of
    `projects/`, not `~/.claude/file-history/<uuid>/`. WS-11 §9's mechanism row and R5-11's
    `~/.winter/file-history/<session-uuid>/...` both assume the latter. The internal layout under
    `backups/` was not opened (no rewind was driven), so the per-file naming and R5-11's path-hash
    fallback stay capture-pending. **Lane K + [WS-05].**
12. **OQ-P5-12 — the default advertised sets differ by 15 names and one alias.** Capture (4) lists
    both sides. The `Task`(init)/`Agent`(request) alias in particular will break any conformance
    assertion that compares an init tool list against a request tool list. **WS-06 reconciliation, T8.**
13. **OQ-P5-13 — four `system/init` fields are on the wire but not in `SDKSystemMessage`**:
    `analytics_disabled`, `product_feedback_disabled`, `memory_paths`, `messaging_socket_path`.
    `memory_paths` is load-bearing for §3/§6.3. A declaration-driven Winter init frame omits them
    silently. **T3 + Lane C.**
14. **OQ-P5-14 — Winter's AskUserQuestion answer key is wrong.**
    `ASK_USER_QUESTION_ANSWER_KEY_FIELD = "header"` contradicts both the declaration
    (`sdk-tools.d.ts:3814`, `3824`) and the runtime (capture (5)). The key is the question text. The
    exported constant plus its M7 test plus the duplicate-key validation are the whole fix. Discharges
    the P3 carry. **P3 carry / Lane E surface, scheduled into P5.**

---

## Notes recorded but not treated as Open Questions

No spec text is contradicted by any of these; recorded because they surfaced during (a)-(i) derivation
and the captures.

- **`WorkflowInput`'s seven fields, the `meta` pure-literal rule, `scriptPath` precedence and
  `resumeFromRunId`'s same-session/stopped-run precondition are confirmed exactly as WS-11 §1 states
  them** — a clean parity result, and the largest single block of the spec this task validates without
  amendment.
- **`error_max_structured_output_retries` is spelled exactly as WS-11 §8 and R5-10 already have it.**
  The only care needed is not confusing it with `TerminalReason`'s `structured_output_retry_exhausted`.
- **`SettingSource` is exactly `'user' | 'project' | 'local'`**, as assumed. The three *other* tier
  vocabularies in the same file (`ResolvedSettingSource`, `PolicySettingsOrigin`,
  `PermissionUpdateDestination`) are the thing to keep straight, not the base union.
- **`sessionStore` is a mirror, not a store.** `sdk.d.ts:1672-1683`: the subprocess still writes to
  `CLAUDE_CONFIG_DIR` and dual-writes to the adapter; `append()` fires after the local write succeeds
  (`5281-5282`), rejections retry three times with backoff and 60s timeouts do not retry, after which
  the batch is dropped and a mirror-error message is emitted. This is why capture (2)'s rejection is
  narrow (backup blobs) rather than general.
- **`SessionStoreEntry` is deliberately a minimal structural supertype** (`5372-5377`, doc
  `5362-5369`) — the concrete transcript union is CLI-internal and explicitly out of the SDK API
  surface. Every P5 dialect-entry name Winter needs is therefore capture-or-define by construction,
  not by omission. This single fact explains items (e) and (i)'s "not declared" findings at once.
- **Rewind history does not survive a fork** (`726`): forked sessions start without undo history
  because file-history snapshots are not copied. A `forkSession` carry for Lane K.
- **`ProposeSkills` is the only skill-adjacent tool with a declared schema**
  (`sdk-tools.d.ts:2885`, `3966`) — worth knowing when Lane S implements the WS-06 `ProposeSkills` row,
  since it is the one place a declaration can be mirrored rather than a report followed.
- **`preserved_messages` supersedes `preserved_segment`** on `compact_metadata` (`3227-3231`). A
  Winter transcript loader that reads only the older field loses the preserved segment on any boundary
  written with the newer one — a resume-correctness trap, not a style note.
- **The `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning is a real pinned behaviour** and was a live hazard
  for this task's own capture design: bare `allowedTools` entries auto-approve a tool before
  `canUseTool` is consulted, and the runtime says so on stderr with that error code. It also states
  that settings-file allow rules shadow the callback without being visible there — which is the very
  mechanism capture (1) turned into a discriminator. Winter's own permission engine should emit an
  equivalent warning; a host that gates on `canUseTool` while also listing bare names in `allowedTools`
  is silently ungated on the pin.
- **`skills: 'all'` changed nothing** in capture (4) relative to the default. Consistent with the
  option's own doc that omission is not "skills off", but worth knowing before writing a conformance
  assertion that expects the two configurations to differ.
