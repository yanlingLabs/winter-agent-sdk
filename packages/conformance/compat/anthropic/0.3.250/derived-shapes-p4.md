# P4 derived shapes — MCP, Tool Search & subagents (pinned 0.3.250)

Authority for every Phase-4 (MCP/Tool-Search/subagents) task's field-level shapes: T1 of the
2026-09-04 plan. Mirrors `derived-shapes-p2.md`/`derived-shapes-p3.md`/`derived-shapes-p3-task8.md`'s
own method and citation discipline in this same directory; nothing here duplicates those files' own
findings except where a P2 shape must be distinguished from a newly-pinned sibling shape on a
different surface (item (f) below), in which case P2's own citation is repeated rather than
re-derived, and the distinction is the point.

## Method

The pinned `@anthropic-ai/claude-agent-sdk@0.3.250` tarball was fetched via
`scripts/fetch-upstream.ts`'s `fetchAndVerifyUpstream()` (sha256 + npm registry sha512 integrity,
both checked against the committed `checksums.json` in this directory — both matched, unchanged
from P2/P3's own verification since this is the same pinned tarball). Unlike P2/P3's own runs, this
task passed an explicit `cacheDir` (a subdirectory under this task's own scratchpad, outside the
repository) rather than relying on the default owned `mkdtemp`; `fetchAndVerifyUpstream` reports
`ownedDir: false` in that mode, so this task — not the helper — deleted the cache and extracted
directories itself in a final step, once every citation below had been captured. A follow-up sweep
of the real OS tmpdir (`/tmp`, `/var/folders`) for any stray `winter-upstream-*` directory (the
default owned-mkdtemp prefix, not used by this run but swept anyway for parity with P2/P3's own
practice) found none. No tarball, extracted file, or verbatim excerpt was written to any persistent
location or committed.

This whole fetch→extract→read→delete cycle was run **twice**: once for the initial research and
drafting pass (items (a)-(g) below), and a second time, independently, as a dedicated verification
pass over the drafted document's own citations before this file was finalized — every `sdk.d.ts`/
`sdk-tools.d.ts` line-number citation below was re-checked against the second extraction rather than
trusted from the first pass's own working notes. That verification pass caught and corrected eight
citation errors (line-range off-by-ones and two field-line misattributions) with no change to any
finding, verdict, or Open Question. Both cycles independently verified the identical checksum.

Files examined: `sdk.d.ts` (8447 lines by `wc -l`/`awk 'END{print NR}'`, cross-checked two ways;
one less than P2's own stated "8448" for the identical, checksum-identical file — an immaterial
counting-method difference, not a content difference, left unresolved since the exact total isn't
load-bearing for any citation below, all of which are anchored to specific line numbers re-verified
against this extraction directly) and `sdk-tools.d.ts` (4125 lines, `json-schema-to-typescript`-generated
per `derived-shapes-p3-task8.md`'s own already-established finding, not re-verified here beyond
noting its header comment says the same thing in this copy). `bridge.d.ts`, `browser-sdk.d.ts`,
`agentSdkTypes.d.ts`, and `extractFromBunfs.d.ts` were spot-checked for every symbol this task
searched for in the two main files and had no independent hits. All line numbers below are **as
published in the pinned tarball**, not any file in this repository.

**Naming discipline**: identical to P2/P3's own — the pinned identifier and field NAMES quoted below
are Winter's own naming (WS-03's compatibility posture, WS-07 §4). Every sentence of description,
every table, and this document's structure are original; nothing is quoted from the artifact beyond individual
pinned type/field names, literal union members, and the explicitly quoted, line-cited passages
marked as such in the body.

**Claim provenance**: each item distinguishes a *type-level fact* (a field exists, its type, its
optionality — directly evident from the declaration's code) from a *doc-asserted behavior* (a claim
that rests on the artifact's own JSDoc comment). Both kinds carry a file:line citation; doc-asserted
claims say so explicitly. Every doc-asserted claim below is a restatement in this document's own
words, never an UNQUOTED verbatim passage; a passage shown inside quotation marks with a line
citation is a deliberate, cited quote, used only where a paraphrase would lose precision.

**A recurring shape in this task's own findings**: three of the seven lettered items below turned
up a symbol name from this task's own brief, or from WS-09/WS-10's prose, that **does not exist as a
schema/type** anywhere in the pinned declaration (`ToolSearch`/`WaitForMcpServers`/`tool_reference`
in item (c); `SendMessage`/`ListAgents` in item (e) — though the bare string `SendMessage` itself
does occur, four times, never as a schema name, see item (e)'s own addendum; a dedicated MCP-status
`SDKMessage` variant in item (b)).
In every one of these cases WS-09/WS-10's own prose already cites the *report* (a runtime capture),
never a `.d.ts` line, for that exact shape — so each absence below is presented as a **confirmation**
that the spec's own report-only sourcing was correct, not as a new divergence. This is the same
class of finding `derived-shapes-p3-task8.md`'s own closing note already established for
`ToolSearch`/`WaitForMcpServers`/`StructuredOutput`; this document re-verifies it independently
(fresh grep, this task's own extraction) rather than assuming that prior finding still holds, and
extends the same check to `SendMessage`/`ListAgents` and the MCP-status-message question, which no
prior task in this series had reason to check.

---

## (a) `McpServerConfig` per-variant field sets, `createSdkMcpServer`/`tool()`, Claude-AI-proxy

### The public union vs. the process-transport union

**Source**: `sdk.d.ts:1105` (`McpServerConfig`), `1107` (`McpServerConfigForProcessTransport`).

```ts
export declare type McpServerConfig = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig | McpSdkServerConfigWithInstance;
export declare type McpServerConfigForProcessTransport = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig | McpSdkServerConfig;
```

**Finding**: the model-visible/host-constructible union's fourth member is
`McpSdkServerConfigWithInstance` (which carries a live, non-serializable `McpServer` instance), not
the bare `McpSdkServerConfig` WS-09 §1.1's illustrative sketch writes generically as
`McpSdkServerConfig`. A **second, sibling union** (`McpServerConfigForProcessTransport`) exists
specifically to swap in the bare, serializable `McpSdkServerConfig` wherever a config must cross a
process/wire boundary (confirmed at its one live use site: `SDKControlMcpSetServersRequest.servers:
Record<string, coreTypes.McpServerConfigForProcessTransport>`, item (b) below). WS-09 §1.2's own
"Exact field lists" row already declines to re-type this surface verbatim, so this is not a
contradiction of anything written — it is the missing precision the spec explicitly deferred here.

### Per-variant field sets

**Source**: `McpStdioServerConfig` `sdk.d.ts:1204-1218`; `McpHttpServerConfig` `1068-1083`;
`McpSSEServerConfig` `1187-1202`; `McpSdkServerConfig` `1085-1092`; `McpSdkServerConfigWithInstance`
`1098-1100`.

```ts
type McpStdioServerConfig = {
  type?: 'stdio';                    // OPTIONAL discriminant — see note below
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeout?: number;                  // ms — see "timeout unit and boundary" below
  alwaysLoad?: boolean;
};

type McpHttpServerConfig = {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  tools?: McpServerToolPolicy[];     // present on http/sse only — see below
  timeout?: number;
  alwaysLoad?: boolean;
};

type McpSSEServerConfig = {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
  tools?: McpServerToolPolicy[];
  timeout?: number;
  alwaysLoad?: boolean;
};

type McpSdkServerConfig = {
  type: 'sdk';
  name: string;
  timeout?: number;                  // no alwaysLoad, no tools[] field — see below
};

type McpSdkServerConfigWithInstance = McpSdkServerConfig & { instance: McpServer };
```

**Notable field-presence facts** (type-level):
- `McpStdioServerConfig.type` is the only **optional** discriminant of the four (`type?: 'stdio'`,
  `sdk.d.ts:1205`) — a config object with no `type` field at all is structurally a stdio config.
  `http`/`sse`/`sdk` all require their literal `type` field.
- `tools?: McpServerToolPolicy[]` (a per-tool remote permission policy, see below) exists on
  `McpHttpServerConfig` (`1072`) and `McpSSEServerConfig` (`1191`) only — **absent from
  `McpStdioServerConfig`** entirely. Consistent with the type's own doc comment ("carried on
  `mcp_set_servers` for remote servers", `1158`) — a local stdio child process has no equivalent
  remote-admin-policy surface.
- `alwaysLoad?: boolean` exists on `McpStdioServerConfig`/`McpHttpServerConfig`/`McpSSEServerConfig`
  but is **absent from `McpSdkServerConfig` itself**. This is not an oversight: WS-09 §1.1's own
  text already states an in-process SDK server "has no external process/network connection to
  await" — the per-tool/`_meta` mechanism below is how an SDK server's own tools opt into
  always-loaded instead, at a different layer than the transport-config `alwaysLoad` flag.

### `timeout` — unit, boundary, and the 3-site match WS-09 §1.1 claims

**Source**: doc comment repeated verbatim-in-shape (not in prose) on all four variants above, plus
`CreateSdkMcpServerOptions.timeout` (`sdk.d.ts:527-535`) and the wire `initialize`-frame twin
`sdkMcpServerConfigs[name].timeout` (`3745-3749`).

Doc-asserted (restated): the unit is **milliseconds**, not seconds (contrast the per-matcher hook
`timeout` P2 pinned, which *is* doc-asserted in seconds — two different timeout fields in this same
package use two different units). Doc-asserted boundary: **values below 1000ms are ignored**,
falling through to `MCP_TOOL_TIMEOUT` or the default — a concrete answer to part of WS-09 §12 Open
Question 4 ("boundary semantics... fixed by capture at pin time"): the low-end boundary (sub-1000ms)
is pinned in the declaration's own prose, not merely observable at runtime. The high end and the
`MCP_TOOL_TIMEOUT`-absent case are not addressed by this same comment and remain open under WS-09
§12 Q4; not restated as a new question here.

**WS-09 §1.1 claims** per-server `timeout` is "present on `CreateSdkMcpServerOptions`,
`McpSdkServerConfig`, and the initialize control frame — Winter mirrors all three." Confirmed
exactly, 3/3: `CreateSdkMcpServerOptions.timeout` (`535`), `McpSdkServerConfig.timeout` (`1091`,
plus the identical field on the other three transport configs), and the initialize frame's
`sdkMcpServerConfigs[name].timeout` (`3749`). **Verdict: matches.**

### Per-tool `alwaysLoad` for SDK servers — a different mechanism than the transport-config flag

**Source**: `CreateSdkMcpServerOptions.alwaysLoad` (`sdk.d.ts:519-526`); `tool()`'s `_extras.alwaysLoad`
(`8237`).

Doc-asserted (restated): `createSdkMcpServer({ alwaysLoad: true })` applies via
`_meta['anthropic/alwaysLoad']` on every tool the server registers; a per-tool `tool({ alwaysLoad })`
still works independently and is OR'd with the server-level flag. So an in-process SDK server's
"always load" knob is a **server-options field that fans out to a per-tool `_meta` tag**, never a
field on the `McpServerConfig`/`McpSdkServerConfig` shape itself — consistent with, and the
explanatory mechanism behind, the field's absence noted above. WS-09 §9's "per-server/per-tool
`alwaysLoad: true`" row should carry this footnote for the SDK-server case specifically.

### `McpServerToolPolicy`

**Source**: `sdk.d.ts:1160-1167` (doc comment `1157-1159`).

```ts
type McpServerToolPolicy = {
  name: string;
  permission_policy?: 'always_allow' | 'always_ask' | 'always_deny';
  org_max_permission?: 'allow' | 'ask' | 'blocked';  // doc-asserted: feeds the isOrgAskCeiling check auto-mode consults
};
```

Not named anywhere in WS-09; this is org-admin permission policy riding on the MCP server-config
surface (http/sse `tools[]` field above), adjacent to WS-07's territory. Pinned here for the record
since it is part of the same config shapes item (a) must capture; no verdict rendered against WS-07,
which is out of this task's two cross-referenced specs.

### `createSdkMcpServer` / `CreateSdkMcpServerOptions`

**Source**: `sdk.d.ts:506` (the function); `508-536` (the options type, **`declare type` — no
`export`**).

```ts
export declare function createSdkMcpServer(_options: CreateSdkMcpServerOptions): McpSdkServerConfigWithInstance;

declare type CreateSdkMcpServerOptions = {   // NOT exported — see finding below
  name: string;
  version?: string;
  instructions?: string;
  tools?: Array<SdkMcpToolDefinition<any>>;
  alwaysLoad?: boolean;
  timeout?: number;
};
```

**Finding**: `CreateSdkMcpServerOptions` carries no `export` keyword — it is a **file-local ambient
type**, reachable only structurally (as `Parameters<typeof createSdkMcpServer>[0]`), never
importable by name from outside `sdk.d.ts`. Independently confirmed not re-exported through the
`coreTypes` namespace block either (see item (b)'s finding on that block, `sdk.d.ts:328-496`) — this
is not merely "unexported at top level," it is unreachable by any import path this package exposes.
A Winter equivalent that wants callers to name this shape (e.g. for a typed factory function
signature) cannot mirror "import the options type," only "match the function's own parameter
shape."

### `tool()` and `SdkMcpToolDefinition`

**Source**: `sdk.d.ts:8234-8238` (`tool()`); `4362-4369` (`SdkMcpToolDefinition`); `122`
(`AnyZodRawShape`); `915-919` (`InferShape`).

```ts
export declare function tool<Schema extends AnyZodRawShape>(
  _name: string,
  _description: string,
  _inputSchema: Schema,
  _handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
  _extras?: { annotations?: ToolAnnotations; searchHint?: string; alwaysLoad?: boolean },
): SdkMcpToolDefinition<Schema>;

type SdkMcpToolDefinition<Schema extends AnyZodRawShape = AnyZodRawShape> = {
  name: string;
  description: string;
  inputSchema: Schema;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
  handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>;
};
```

**Finding**: `tool()`'s fifth parameter carries `searchHint?: string` at the per-tool level — the
exact field name WS-09 §8.3 requires Winter to populate on `ToolDescriptor.searchHint` ([WS-06] §1.1)
so "discovery quality is a data property." This confirms the field name is shared, by the pinned
declaration itself, between the official SDK's own tool-definition surface and the WS-06 registry
field WS-09 names — not a coincidence of independent naming. `SdkMcpToolDefinition` itself
additionally carries `_meta?: Record<string, unknown>` at the tool level (distinct from the
per-invocation `extra: unknown` handler parameter) — the mechanism `_meta['anthropic/alwaysLoad']`
above actually writes into.

### Claude-AI-proxy — declaration-only, confirmed excluded from the ordinary union

**Source**: `sdk.d.ts:1058-1066` (`McpClaudeAIProxyServerConfig`); `1155`
(`McpServerStatusConfig`).

```ts
type McpClaudeAIProxyServerConfig = { type: 'claudeai-proxy'; url: string; id: string; timeout?: number };
type McpServerStatusConfig = McpServerConfigForProcessTransport | McpClaudeAIProxyServerConfig;
```

**Verdict**: **MATCHES WS-09 §1.1 exactly**. `McpClaudeAIProxyServerConfig` is a real, fully-shaped
pinned type — but it is a member of `McpServerStatusConfig` (a server's own **status-report**
carries its config back, `McpServerStatus.config?`, item (b)) only, never of the ordinary
`McpServerConfig` union a caller constructs (`1105`, confirmed above). A caller cannot pass
`{type:'claudeai-proxy', ...}` through `Options.mcpServers`/`setMcpServers`/`AgentDefinition.mcpServers`
and have it type-check — exactly WS-09 §1.1's claim that "the ordinary `McpServerConfig` union does
not accept that backend-private variant." Recorded here, as the brief requests, so WS-09 §1.1's
runtime-rejection language can name the exact type it is describing.

---

## (b) MCP status/control API families and the MCP-status message question

### The `Query` interface's four public methods

**Source**: `sdk.d.ts:2425` (`export declare interface Query extends AsyncGenerator<SDKMessage, void>`);
`2578` (`mcpServerStatus`); `2668` (`reconnectMcpServer`); `2676` (`toggleMcpServer`); `2705`
(`setMcpServers`).

```ts
interface Query extends AsyncGenerator<SDKMessage, void> {
  mcpServerStatus(): Promise<McpServerStatus[]>;
  reconnectMcpServer(serverName: string): Promise<void>;               // throws on failure
  toggleMcpServer(serverName: string, enabled: boolean): Promise<void>; // throws on failure
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>;
  // ...many unrelated methods elided (accountInfo, rewindFiles, streamInput, stopTask, etc.)
}
```

`McpServerStatus` (`sdk.d.ts:1112-1153`):

```ts
type McpServerStatus = {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';  // 5 members, hyphenated
  serverInfo?: { name: string; version: string };
  error?: string;
  config?: McpServerStatusConfig;       // includes the Claude-AI-proxy variant, item (a)
  scope?: string;                       // doc-asserted: e.g. project/user/local/claudeai/managed
  tools?: { name: string; description?: string; annotations?: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean } }[];
};
```

`McpSetServersResult` (`1172-1185`): `{ added: string[]; removed: string[]; errors: Record<string,string> }`.

**Field-name note**: `McpServerStatus.tools[].annotations` uses `readOnly`/`destructive`/`openWorld`
— **no `Hint` suffix** — a distinct, ad hoc summary shape, not a re-export of the `ToolAnnotations`
type ([WS-09] §4's `readOnlyHint`/`destructiveHint`/`openWorldHint` naming; `ToolAnnotations` itself
is imported from `@modelcontextprotocol/sdk/types.js`, `sdk.d.ts:10`, a package this task did not
independently fetch — see item (g)). Do not assume these are the same field set under two names;
they are two different types that happen to describe similar concepts.

**`reconnectMcpServer`/`toggleMcpServer` field-naming note**: both take `serverName` (camelCase),
matching their own wire counterparts' field name exactly (`SDKControlMcpReconnectRequest.serverName`,
`SDKControlMcpToggleRequest.serverName`, below) — unlike the elicitation and permission wire frames,
which use snake_case at the wire layer while their public callback/method counterparts use
camelCase. The wire layer is not uniformly snake_case; it mixes conventions per subtype.

**`setMcpServers`'s doc-asserted scope boundary** (`sdk.d.ts`, doc comment directly above line
`2705`): the method's replace-semantics reach only the servers that arrived through this same
method or through the SDK's own dynamic-server options in the first place. Two categories sit
outside that reach entirely — a settings-file-configured server is untouched by any call, and a
plugin-supplied server survives an omission (the plugin system owns it, so dropping it from the
payload is not read as a removal request; it simply will not appear in the result's `removed`
list, and stays alive after the call; only an enterprise-level denial can stop it). The practical consequence: calling
with an empty object no longer zeroes out a session's dynamic MCP surface once any plugin server
is present. The one way to actually displace a plugin's own server is to reference it by name in a
call's own payload — that overrides the plugin's ownership for that one entry only. **This is a
real refinement of WS-09 §3's blanket "`setMcpServers` replaces the configured set live"** — the
replace-semantics apply only to the dynamically-added-via-this-method-or-SDK-options subset, not
the full advertised set (Open Question 3).

### DEVIATION: `SDKStatusMessage` is not an MCP-status message

This task's own brief phrase — "every MCP-status / `SDKStatusMessage` SDK message variant" — reads
as if `SDKStatusMessage` were part of the MCP-status family. It is not.

**Source**: `sdk.d.ts:4836` (`SDKStatus`); `4838-4848` (`SDKStatusMessage`).

```ts
type SDKStatus = 'compacting' | 'requesting' | null;
type SDKStatusMessage = {
  type: 'system'; subtype: 'status';
  status: SDKStatus;
  permissionMode?: PermissionMode;
  compact_result?: 'success' | 'failed';
  compact_error?: string;
  uuid: UUID; session_id: string;
};
```

`SDKStatus`'s three members are about **compaction and API-request lifecycle**, nothing MCP-related
at all. An exhaustive search of the full, independently-recounted 39-member `SDKMessage` union
(`sdk.d.ts:4399`, see the Notes section for the recount itself) for any member whose name contains
"Mcp" or "MCP" found **zero** top-level streamed message variants — no `SDKMcpStatusMessage` or
equivalent exists. **Resolution** (per this document's own precedent's practice of following the
declaration and flagging the mismatch): MCP connection-state changes reach a client through exactly
two channels, neither of which is a dedicated streamed message:

1. The polling `Query.mcpServerStatus()` method above (rich 5-member status enum, per-server).
2. `SDKSystemMessage`'s (`subtype: 'init'`) `mcp_servers: { name: string; status: string }[]` field
   (`sdk.d.ts:4865-4868`, within the full type at `4853-4913`) — a **bare, untyped `string`** status,
   not the richer 5-member literal union `McpServerStatus.status` has. This is the exact mechanism
   behind WS-09 §3's own consequence clause ("`system/init.tools` on the next turn reflects the
   mutation") — confirmed here at the field level, and the asymmetry (rich enum on the polled method,
   bare string on the streamed snapshot) is worth Winter's own registry preserving deliberately
   rather than accidentally narrowing one to match the other.

Also worth note: `mcpServerStatus()`'s own doc comment (doc-asserted, directly above `2578`) lists
only 4 of its own type's 5 status values in prose ("connected, failed, needs-auth, pending") —
omitting `disabled`. A minor doc/type undercount, not a divergence from anything in WS-09/WS-10.

### The unexported wire control-request family

**Source**: `sdk.d.ts:3862-3907` (`SDKControlMcpCallRequest`, subtype `'mcp_call'`); `3912-3919`
(`SDKControlMcpMessageRequest`, subtype `'mcp_message'`); `3924-3927`
(`SDKControlMcpReconnectRequest`, subtype `'mcp_reconnect'`); `3932-3935`
(`SDKControlMcpSetServersRequest`, subtype `'mcp_set_servers'`); `3940-3942`
(`SDKControlMcpStatusRequest`, subtype `'mcp_status'`); `3947-3951`
(`SDKControlMcpToggleRequest`, subtype `'mcp_toggle'`); `3362-3382`
(`SDKControlElicitationRequest`, subtype `'elicitation'` — item (f)); `4098`
(`SDKControlRequestInner`, the union of all of these plus every other control-request shape);
`4138-4141` (`SDKControlResponse`, the generic response envelope).

All six MCP-prefixed control-request types, plus `SDKControlElicitationRequest`, are declared with
**`declare type` — no `export`** (mirroring the already-established `SDKControlPermissionRequest`
finding in `derived-shapes-p2.md` item (c)'s note). This task additionally checked the
`declare namespace coreTypes { export { ... } }` re-export block (`sdk.d.ts:328-496`, ~150 members,
the mechanism by which e.g. `AgentDefinition`/`McpServerConfigForProcessTransport`/`HookEvent` become
reachable as `coreTypes.X` at other wire-type sites) for all seven names — **none appear there
either**. These seven types are not merely "unexported at the top level"; they are unreachable by
any import path this package exposes. The wire-frame shapes below are recorded for traceability (and
because `SDKControlMcpSetServersRequest.servers` is the one live-use confirmation of
`McpServerConfigForProcessTransport`, item (a)), not because Winter can or should import them.

```ts
type SDKControlMcpCallRequest = {           // invokes an MCP tool via the subprocess client, no model turn
  subtype: 'mcp_call';
  tool: string;                             // fully-qualified mcp__server__tool
  arguments?: Record<string, unknown>;
  expires_at?: string;
  timeout_ms?: number;                      // doc-asserted: clamped [1000, 600000], default 120000
  input_files?: { name: string; lane_path: string }[];
  output_files?: { name: string; lane_path: string; if_match?: string }[];
  // doc-asserted: SDK-type servers (config.type === "sdk") are rejected here — caller invokes directly instead
};
type SDKControlMcpMessageRequest = { subtype: 'mcp_message'; server_name: string; message: JSONRPCMessage };
type SDKControlMcpReconnectRequest = { subtype: 'mcp_reconnect'; serverName: string };
type SDKControlMcpSetServersRequest = { subtype: 'mcp_set_servers'; servers: Record<string, coreTypes.McpServerConfigForProcessTransport> };
type SDKControlMcpStatusRequest = { subtype: 'mcp_status' };
type SDKControlMcpToggleRequest = { subtype: 'mcp_toggle'; serverName: string; enabled: boolean };
type SDKControlResponse = { type: 'control_response'; response: ControlResponse | ControlErrorResponse };
```

No dedicated `SDKControlMcp*Response` type exists for any of these six subtypes — the wire response
is the generic `ControlResponse | ControlErrorResponse` envelope; the only place these operations'
*return shapes* are independently and richly typed is the public `Query` method level above.

**Note for WS-04, not an Open Question against WS-09/WS-10** (WS-04 owns Winter's own wire protocol
and is not one of this task's two cross-referenced specs, but the 2026-09-04 plan's own "Tech Stack"
line names these exact subtype strings as WS-04 §3.1 context): of the six subtype spellings the plan
names (`mcp_elicitation`, `sdk_mcp_call`, `mcp_status`, `mcp_reconnect`, `mcp_toggle`,
`mcp_set_servers`), only the last four match the pinned declaration exactly. The pinned artifact has
no `mcp_elicitation` subtype at all — elicitation's two subtypes are `'elicitation'` and
`'elicitation_complete'`, neither `mcp_`-prefixed (item (f)) — and no `sdk_mcp_call` subtype either;
the closest pinned concepts are two *different* subtypes for two *different* transports: `'mcp_call'`
(subprocess-mediated, explicitly rejects SDK-type servers) and `'mcp_message'` (the actual
SDK-hosted-server bridge, carrying a raw `JSONRPCMessage`). Whether WS-04 intended byte-parity with
these six spellings or was using them as illustrative shorthand is for that spec's own author/the
controller to resolve; this document only pins what the artifact actually contains.

**Verdict**: item (b) has no verbatim block in WS-09/WS-10 to diverge from at the wire-frame level
(WS-09 §3 cites "report §57" for the API-family names, not `.d.ts` lines) — these shapes are newly
pinned here. The public `Query`-method surface **matches** WS-09 §3's named family exactly
(`mcpServerStatus`/`reconnectMcpServer`/`toggleMcpServer`/`setMcpServers`, all four present as
camelCase methods on the handle). WS-09 §3's own `get_mcp_status` alias appears nowhere in this
artifact under any spelling (an exhaustive `mcp_status`-substring search finds only the
`subtype: 'mcp_status'` wire literal, item (b) above, never a `get_mcp_status` name) — only the
camelCase `mcpServerStatus` method name is pinned. The plugin-exemption nuance (Open Question 3) and
the `SDKStatusMessage` mismatch (DEVIATION above) are the two substantive findings.

---

## (c) `ToolSearch`/`WaitForMcpServers`/`tool_reference`/`toolAliases`

### Exhaustive, independently-reproduced absence

An exhaustive case-insensitive search of all six `.d.ts` files (`sdk.d.ts`, `sdk-tools.d.ts`,
`bridge.d.ts`, `browser-sdk.d.ts`, `agentSdkTypes.d.ts`, `extractFromBunfs.d.ts`) for `toolsearch`,
`waitformcp`, and `tool_reference`/`toolreference` found **zero matches** in any file. This
independently reproduces `derived-shapes-p3-task8.md`'s own already-recorded finding for the same
three strings (that task checked while investigating a different, adjacent tool family) — re-verified
here as this phase's own primary, on-topic finding for the workstream that actually owns Tool Search.

Because WS-09 §8.2/§8.4 already cite these shapes exclusively from "report §40.40"/"report §40.41"
(a runtime capture from a live CLI, never a `.d.ts` line), this absence is a **confirmation** of the
spec's own sourcing, not a divergence: these shapes genuinely do not exist as named symbols in the
`@anthropic-ai/claude-agent-sdk@0.3.250` npm package's own type declarations, at any file. A pin-time
declaration fetch — this task's own method — has nothing further to add to WS-09 §8's already-correct
report-only citations.

`tool_reference` as a *content-block* type is additionally out of this pin's reach for a structural
reason, not just an absent-name one: this package's own `.d.ts` files do not locally define content-
block discriminant unions at all — `SDKAssistantMessage`'s own doc comment (`sdk.d.ts:3103`) says
outright "See the Messages API reference for the block types," and the actual block types come from
`@anthropic-ai/sdk`'s own `BetaMessage`/`MessageParam` exports (imported, `sdk.d.ts:1-3, 8`), a
separate package this task's checksum chain does not independently pin (see item (g)'s scope note).
Whether `tool_reference` is a real member of that external union cannot be confirmed or denied from
the artifact this task fetched.

### `toolAliases`

**Source**: `Options.toolAliases` — doc comment `sdk.d.ts:1461-1485`, field `1486`; wire twin
(the `initialize` control request's own options) `3759-3762`.

```ts
toolAliases?: Record<string, string>;
```

Doc-asserted: the map is consulted exactly once, at the moment a model-emitted `tool_use` name is
being resolved to an actual tool — never re-consulted on whatever the first lookup produced, which
is precisely what keeps a two-entry loop (`{A:'B', B:'A'}`) from being a problem: the resolved name
is treated as a destination, not as a further key to look up. This is also why the mechanism cannot
substitute for a deny list: it only intercepts the model-emitted, name-based path into a tool,
never a harness-internal caller that already holds a reference to the tool object and invokes it
directly without going through a name at all — `disallowedTools` remains the thing actually closing
that second door. **Verdict: matches WS-09 §10 exactly** — single-hop (confirmed), no
chain-following (confirmed), aliasing is not itself a security boundary and `disallowedTools`
remains the enforcement floor (confirmed by the same doc comment's own framing).

**Verdict for the whole item (c)**: declaration-absent for `ToolSearch`/`WaitForMcpServers`/
`tool_reference` — the spec's existing report-only citations stand; nothing to compare a
declaration against. `toolAliases` matches WS-09 §10 exactly.

---

## (d) `AgentInput`, `AgentDefinition`, the subagent-progress Options fields, correlation fields, Agent result shape

### `AgentInput` — the compile-time-authority rendering only

**Source**: `sdk-tools.d.ts:654-691`.

```ts
interface AgentInput {
  description: string;
  prompt: string;
  subagent_type?: string;
  model?: "sonnet" | "opus" | "haiku" | "fable";
  run_in_background?: boolean;
  name?: string;
  team_name?: string;                 // doc-asserted deprecated, accepted-ignored
  mode?: "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan";  // doc-asserted deprecated, accepted-ignored
  isolation?: "worktree" | "remote";
}
```

**Verdict: MATCHES WS-10 §1.2's table exactly, field-for-field** — all 9 fields present, identical
names, identical types (including the exact 4-member `model` alias union and the exact 6-member
`mode` union), identical optionality/required split. No addition, omission, or spelling difference.

**Scope note, per this task's own brief instruction not to collapse the three renderings**: WS-10
§1.1 names three inconsistent renderings of the Agent tool — "the published 0.3.250 `sdk-tools.d.ts`
declaration" (exactly what is pinned above), "the model-visible JSON schema captured from
2.1.250/2.1.251" (a **live-CLI runtime capture**, a different CLI version line than this npm
package's own `0.3.250`/`2.1.250` pairing per `checksums.json`'s own `claudeCode` field, and in any
case not obtainable by fetching a package tarball), and "the generated web reference" (external
documentation, explicitly called non-authoritative by WS-10 itself). **This document pins only the
first rendering.** The second and third remain the responsibility of whatever task runs a live
capture against a running CLI — not this ephemeral, declaration-only fetch.

### `AgentDefinition` — full field list

**Source**: `sdk.d.ts:38-100`.

| Field | Type | Optional |
| --- | --- | --- |
| `description` | `string` | no |
| `tools` | `string[]` | yes |
| `disallowedTools` | `string[]` | yes |
| `prompt` | `string` | no |
| `model` | `string` | yes — **bare string, no literal union at all** (see note) |
| `mcpServers` | `AgentMcpServerSpec[]` | yes (see below — not `Record<string,McpServerConfig>`) |
| `criticalSystemReminder_EXPERIMENTAL` | `string` | yes |
| `skills` | `string[]` | yes — **not `"all" \| string[]`** (see note) |
| `initialPrompt` | `string` | yes |
| `maxTurns` | `number` | yes |
| `background` | `boolean` | yes |
| `memory` | `'user' \| 'project' \| 'local'` | yes |
| `effort` | `('low'\|'medium'\|'high'\|'xhigh'\|'max') \| number` | yes (see note) |
| `permissionMode` | `PermissionMode` (P2-pinned 6-member union, `sdk.d.ts:2234`) | yes |
| `observer` | `string` | yes |
| `observerMessage` | `string` | yes |

16 fields total (2 required, 14 optional) — **matches WS-10 §2's own table 1:1, member for member**,
with three type-level nuances worth recording precisely:

- **`model` is typed as a bare `string`** (`sdk.d.ts:58`) — no compile-time restriction to the
  4 aliases + `"inherit"` + "a full model identifier" WS-10 §2's table renders as if it were a
  literal union. WS-10's own "or a full model identifier" phrasing already signals this is a
  semantic description of valid values rather than a TypeScript union; the pinned type confirms
  there is, in fact, no union here at all — any string type-checks. Not a divergence (WS-10 never
  claimed otherwise in table-literal form), but worth pinning precisely since it's materially looser
  than `AgentInput.model`'s exact 4-member union.
- **`skills` is typed as `string[]` only** (`sdk.d.ts:67`) — there is no `"all"` bare-string
  alternative at the type level. WS-10 §2's table renders this field's "Type / union" column as
  `"all" | string[]`. Read as literal TypeScript, a bare scalar `"all"` (not wrapped in an array)
  does not conform to `string[]` and would not type-check against this pinned declaration; read as
  informal shorthand for "an array, which may contain the sentinel element `'all'`," there is no
  conflict at all, since `["all"]` is a valid `string[]` value. The pinned declaration cannot itself
  resolve which reading WS-10 intended, and this field's own doc comment ("Array of skill names to
  preload into the agent context") does not mention any `"all"` sentinel either way. **Open Question 2.**
- **`effort`'s numeric-form union member is already present in this 0.3.250 declaration**
  (`sdk.d.ts:87`: `('low'|'medium'|'high'|'xhigh'|'max') | number`). WS-10 §2's own footnote sources
  this from "a published 0.3.251 declaration detail, unchanged in 0.3.252" — naming the *report's own
  evidence version*, not asserting the form was absent at 0.3.250. Finding this exact shape already
  present at the pin this phase actually targets is a **confirmation that there is no version gap
  between the pin and the report's evidence**, not a contradiction of WS-10's claim. Recorded in the
  Notes section, not as an Open Question.

### `AgentMcpServerSpec` — the per-agent MCP config shape (distinct from `Options.mcpServers`)

**Source**: `sdk.d.ts:120`.

```ts
type AgentMcpServerSpec = string | Record<string, McpServerConfigForProcessTransport>;
```

**Finding**: `AgentDefinition.mcpServers` is an **array** of items, each either a bare `string`
(presumably a reference to an already-configured session-level server by name) or an inline
`Record<string, McpServerConfigForProcessTransport>` — the process-transport-only union (item (a)),
never the SDK-instance-carrying variant, consistent with a filesystem/frontmatter-defined agent
being unable to embed a live JS object. This is a **materially different shape** from the
session-level `Options.mcpServers?: Record<string, McpServerConfig>` (item (a)) — not a flat
name-keyed record at all, but a heterogeneous array. WS-10 §2's table only says "per-agent MCP
config | [WS-09]" without committing to a shape; this pins it precisely for the plan's own A×C
coupling (Lane C validates this field's shape and hands per-agent configs to Lane A's registration
seam).

### Options fields: `agents`, `mcpServers`, `strictMcpConfig`, `forwardSubagentText`, plus `agentProgressSummaries`

**Source**: `agents` `sdk.d.ts:1417-1432`; `mcpServers` (Options) `1793` (doc `1779-1792`;
`1779` immediately follows the unrelated preceding `taskBudget` field's own closing `*/` at
`1775` — not to be confused with it); `strictMcpConfig` `2094-2101`; `forwardSubagentText`
`1717-1723`; `agentProgressSummaries` `1878-1887`.

```ts
agents?: Record<string, AgentDefinition>;
mcpServers?: Record<string, McpServerConfig>;
strictMcpConfig?: boolean;
forwardSubagentText?: boolean;
agentProgressSummaries?: boolean;
```

`forwardSubagentText`'s doc comment (restated): by default only `tool_use`/`tool_result` blocks from
subagents are emitted (a heartbeat counter's worth); when `true`, subagent text and thinking blocks
are additionally forwarded as assistant/user messages with `parent_tool_use_id` set, for a nested
transcript. **Verdict: matches WS-10 §4 exactly**, including the "only `tool_use`/`tool_result`
without it" default behavior.

`strictMcpConfig`'s doc comment is more precise than WS-09 §1.1/§1.2's own framing: strict mode's
own allowed-server surface draws from two sources at once, not one — whatever `mcpServers` supplies,
plus whatever MCP configuration rides along inside any agent definition passed through `agents` in
that same call. Every other source (a project-level `.mcp.json`, user settings, plugin-contributed
servers, or on-disk agent frontmatter, subagent frontmatter included) is excluded once strict mode
is on. WS-09 §1.2's precedence table names only "explicit SDK `mcpServers`" at the top of its
precedence order; it does not mention that strict mode's allowlist also includes
`agents[*].mcpServers`. **Open Question 4.**

`agentProgressSummaries` (new find, not named in this task's brief but directly in-family with
`forwardSubagentText`): doc-asserted — the mechanism is a periodic fork: roughly every 30 seconds,
the running child's own conversation is branched off just long enough for the model to write one
brief, present-tense status line, and that line is what lands in `task_progress`'s `summary` field.
Because the fork reuses the child's own model and prompt-cache state rather than starting fresh,
the doc comment characterizes the added cost as small. The toggle covers both foreground and
background children and is off unless set. This is the **producer** of the field
`derived-shapes-p3.md` item (e) already pinned on the wire side
(`SDKTaskProgressMessage.summary?: string`) without knowing what populated it — this document
closes that loop. Recorded here since it is squarely a subagent-progress-family Options field,
adjacent to `forwardSubagentText`, and cheap to capture in the same pass.

### Subagent-progress correlation fields — `parent_tool_use_id` is on SDK messages; `agentID` is not

**Source**: `parent_tool_use_id` on `SDKAssistantMessage` (`3106`, within `3100-3157`),
`SDKPartialAssistantMessage` (`4550`), `SDKToolProgressMessage` (`5030`, within `5026-5045`),
`SDKUserMessage` (`5065`), `SDKUserMessageReplay` (`5116`), and `SessionMessage` (`5218`, within
`5213-5226`, a **non**-`SDKMessage`-union historical-read type — see below). `agentID` at
`sdk.d.ts:250` (within the already-P2-pinned `CanUseTool` options object, `209-269`); its wire
counterpart `agent_id?: string` at `3993` (within the already-P2-pinned, unexported
`SDKControlPermissionRequest`, `3956-3999` — P2's own note on this type lists only the fields *beyond*
`CanUseTool`'s own surface, so `agent_id` not appearing in that note is consistent with P2's own
scoping, not an omission on P2's part).

**Finding, correcting this task's own brief framing**: `parent_tool_use_id: string | null` is a
genuine SDK-message-level correlator, present on 6 variants of the (independently recounted, see
Notes) 39-member `SDKMessage` union plus the separate `SessionMessage` read-type. `agentID`, by
contrast, **is not a field on any `SDKMessage` variant at all** — the single occurrence of that exact
camelCase spelling in the entire pinned artifact is on `CanUseTool`'s callback options object
(already pinned by P2), a function-call-time permission correlator, not a stream field. Its
snake_case wire counterpart `agent_id?: string` lives on the unexported `SDKControlPermissionRequest`
wire frame (item (f) territory), likewise not a `SDKMessage` variant. Treat `parent_tool_use_id`
(message-stream correlator) and `agentID`/`agent_id` (permission-callback correlator) as two
different mechanisms serving two different call sites, not two members of one "subagent-progress
correlation fields on SDK messages" family as the brief's own phrasing suggested.

**Two further, more specific correlators found in the same pass** (not named in the brief, in-family
and cheap to record):

- `SDKToolProgressMessage.subagent_retry?: { agent_id: string; attempt: number; max_retries: number;
  retry_delay_ms: number; error_status: number | null; error_category: string }` (`5037-5044`) — a
  richer, retry-specific correlator scoped to one subagent's own retried tool call, distinct from the
  message-level `parent_tool_use_id` on the same type.
- `SessionMessage.parent_agent_id: string | null` (`5225`, doc-asserted) — a lineage pointer to
  whichever subagent spawned the one this record belongs to, landing on `null` at exactly two
  boundaries (a subagent one level below the main loop, and the main session's own entries) plus a
  third case the field's own comment calls out separately: an older record whose stored metadata
  never captured this field also reads back as `null`. A lineage/nesting-depth correlator, present
  only on `SessionMessage` (the type returned by the
  exported `getSessionMessages()`/`getSubagentMessages()` functions, `792`/`829` — a **historical
  transcript read**, confirmed absent from the live-streamed `SDKMessage` union by the same
  independent recount used for the DEVIATION in item (b)). Not the same surface as the live stream;
  do not conflate a lineage field only reachable by a historical read with a field reachable during a
  live turn.

### The Agent tool's result shape — a 3-branch discriminated union, not a single shape

**Source**: `sdk-tools.d.ts:103-207` (`AgentOutput`).

```ts
type AgentOutput =
  | {  // status: "completed" — synchronous / foreground result
      agentId: string; agentType?: string;
      content: { type: "text"; text: string; citations?: unknown[] | null }[];
      resolvedModel?: string; modelsUsed?: string[];
      totalToolUseCount: number; totalDurationMs: number; totalTokens: number;
      usage: { /* full Messages-API-shaped usage object, input_tokens/output_tokens/cache fields/service_tier/etc. */ };
      toolStats?: { readCount: number; searchCount: number; bashCount: number; editFileCount: number;
                     linesAdded: number; linesRemoved: number; otherToolCount: number; frameCount?: number };
      status: "completed";
      prompt: string;
      worktreePath?: string; worktreeBranch?: string;
    }
  | {  // status: "async_launched" — the immediate result of a backgrounded invocation
      status: "async_launched"; isAsync?: true;
      agentId: string; description: string;
      resolvedModel?: string; modelsUsed?: string[];
      prompt: string;
      outputFile: string; canReadOutputFile?: boolean;
    }
  | {  // status: "remote_launched" — isolation:"remote", no agentId at all
      status: "remote_launched";
      taskId: string; sessionUrl: string;
      description: string; prompt: string; outputFile: string;
    };
```

**Finding**: WS-10 §1.4's own description ("Result data MAY include `agentId`, `agentType`, text
content, `resolvedModel`/`modelsUsed`, tool-use count, duration, and usage") loosely describes only
the `"completed"` branch, and even there omits `toolStats` and `worktreePath`/`worktreeBranch`
entirely. WS-10 §1.4's parenthetical "(background children notify later)" is now precisely explained
by this union's own shape: a backgrounded invocation's **immediate** tool result is the
`"async_launched"` branch (`outputFile` + `canReadOutputFile` — directly confirming the [WS-12] §7.2
`.output`-symlink-or-stub rule this phase's plan text names as consumed context: `canReadOutputFile`
is the exact gate for whether the caller has Read/Bash to poll `outputFile`), while the eventual
completion arrives through a separate channel (the `task_notification`/`task_progress` family,
`derived-shapes-p3.md`). The `"remote_launched"` branch (isolation:`"remote"`, WS-10 §8) has no
`agentId` field at all — it identifies the spawned work by `taskId`/`sessionUrl` instead, consistent
with WS-10 §8's framing that `isolation:"remote"` is a capability-gated, structurally different path
from an ordinary local child.

**Verdict**: newly pinned in full; no verbatim block in WS-10 to diverge from (§1.4 is explicitly
loose, "MAY include"). This resolves that looseness into an exact, 3-branch discriminated union.

---

## (e) `SendMessage`/`ListAgents`

### Exhaustive absence

An exhaustive search of all six `.d.ts` files for `SendMessageInput`, `SendMessageOutput`,
`ListAgentsInput`, `ListAgentsOutput`, and any interface/type literally named `SendMessage` or
`ListAgents` found **zero matches** — as a *schema* name, neither tool exists anywhere in the pinned
declaration. That is a narrower claim than "occurs once": a plain-text search for the string
`SendMessage` itself (not a schema-name search) finds it **four** times, none of them a schema:
`sdk-tools.d.ts:676` (a prose mention inside `AgentInput.name`'s own doc comment — "Makes it
addressable via `SendMessage({to: name})` while running"); `sdk.d.ts:4440` (a doc comment on
`SDKResultMessage`'s delivery-provenance field, naming a `'peer-send-message'` literal — see the
addendum below); and `sdk.d.ts:7876`/`7884` (two `Settings` doc comments, also covered below). By
contrast, `ReadNotificationsInput`/`ReadNotificationsOutput` (`sdk-tools.d.ts:2859`, `3906-3929`)
**do** exist as real, fully-shaped interfaces in the same file — confirming the absence of a
`SendMessage`/`ListAgents` *schema* is not a blind spot in this search method, since a sibling
messaging-family tool in the very same file *is* found by the identical method.

This is consistent with, and a confirmation of, WS-10 §10.1/§10.2's own citation practice: both
schemas are already sourced there as "report §40.29, §125" / "report §40.16" — a runtime behavioral
capture — never as a `.d.ts` line. It is also the direct, mechanical consequence of WS-10 §15's own
architectural point: the Agent SDK offers no supported API to register a foreign runtime as a peer,
so `SendMessage`/`ListAgents` are CLI-product built-ins with no reason to appear in this npm
package's own tool-schema catalog (`sdk-tools.d.ts`'s `ToolInputSchemas`/`ToolOutputSchemas` unions,
which do include `AgentInput`/`AgentOutput` and every core built-in, but not these two).

### Addendum: the schema is absent, but the settings/wire surface around it is not

The tool-schema absence above is real and unaffected by what follows — but `SendMessage` is not a
name this pinned declaration is silent about everywhere. Three real, citable, comparable shapes sit
immediately adjacent to it, none of them a tool schema, and all three bear directly on WS-10's own
messaging contracts.

**(a) `Settings.crossSessionInbound?: 'accept' | 'hold' | 'refuse'`** (`sdk.d.ts:7886`, doc
`7883-7885`). Its own doc comment states outright that `'accept'`/`'hold'`/`'refuse'` behave exactly
as their names suggest, that an explicit value always wins, and then gives the unset (default)
behavior in three clauses: "a message auto-delivers only when the sending session's permission-mode
class matches yours (bypass↔bypass or prompting↔prompting)"; "a mismatched sender's message is held
for your approval"; "a sender that asserts no class is held only while this session bypasses
permission prompts." Read against WS-10 §13's five-row class matrix (`prompts×prompts`→accept,
`prompts×unknown`→accept, `prompts×bypasses`→hold, `bypasses×bypasses`→accept,
`bypasses×{prompts,unknown}`→hold): the first clause covers the two match rows
(`prompts×prompts`/`bypasses×bypasses`→accept); the second clause covers the two
sender-declared-but-mismatched hold rows (`prompts×bypasses`/`bypasses×prompts`→hold); the third
clause covers both remaining `unknown`-sender rows by stating the negative space directly — held
only when the *receiver* bypasses (`bypasses×unknown`→hold) and, by the same statement, *not* held
when the receiver does not (`prompts×unknown`→accept). **Verdict: this doc comment confirms all
five rows of WS-10 §13's table**, not merely the ones a looser reading might catch — a genuine,
citable match rather than an assumption the two are compatible.

**(b) `Settings.isolatePeerMachines?: boolean`** (`sdk.d.ts:7878`, doc `7875-7877`). Its own doc
comment: "Require explicit approval before SendMessage can reach a peer session on another machine
via Remote Control." WS-10 §13's own closing invariant names this only in the abstract
("cross-machine/phone delivery requires an authenticated Winter transport and its own policy gate")
— this field is a real, pinned instance of that gate: a single boolean opt-in covering *all*
cross-machine peer delivery at once, not a per-message decision. "Remote Control" is the pinned
artifact's own transport name, not a claim about Winter's; Winter's equivalent gate is [WS-04]'s/
[WS-15]'s own design, this only pins the shape of the mechanism it is answering to.

**(c) `SDKMessageOrigin`** (`sdk.d.ts:4404-4455`, a 9-member discriminated union on `kind`:
`human`, `channel`, `peer`, `task-notification`, `coordinator`, `unclassified`, `observer`,
`auto-continuation`, `observer-activity`) — carried as `origin?: SDKMessageOrigin` on four sites:
`SDKResultError` (`4705`), `SDKResultSuccess` (`4756`), `SDKUserMessage` (`5072`), and
`SDKUserMessageReplay` (`5123`). The `kind:'peer'` branch (`4410-4436`) is the one WS-10's own
addressing/permission-class contracts are directly comparable to:

```ts
{
  kind: 'peer';
  from: string;                              // sender-authored, reply-routing only — never authority
  fromMode?: 'bypass' | 'prompting';         // sender's own declared permission class
  name?: string;                             // normalized display name, sender-asserted
  fromSession?: string;                      // sender's host-openable session id, sender-asserted
  senderTaskId?: string;                     // in-process background-subagent sender only
  body?: string;                             // envelope-stripped body, byte-exact with model view
  verifiedPeerPid?: number;                  // kernel-verified via SO_PEERCRED/LOCAL_PEERPID, not payload
}
```

This is the pinned artifact's own analog of two WS-10 concepts at once: `from`/`name`/`fromSession`
parallel WS-10 §11's `RuntimeAddress`/`ListedRuntimeObject` addressing fields (a different shape by
design — WS-10 §11 is Winter's own addressing scheme, not required to mirror this one), and
`fromMode` parallels WS-10 §15's `RuntimeMessagingAdapter.senderPermissionClass(): Promise<"prompts"
| "bypasses" | "unknown">` exactly in *purpose* — both exist to answer "what permission class did
the sender declare" for the §13 inbound matrix above. **Open Question 7** records where the two
diverge in *shape*.

**Verdict**: the tool schemas remain declaration-absent — WS-10 §10.1/§10.2's own report-only
citations stand unmodified there. The settings/wire layer *around* messaging is a different matter:
`crossSessionInbound` and `isolatePeerMachines` both newly pin and confirm mechanisms WS-10 §13
already specifies at the policy level, and `SDKMessageOrigin`'s `peer` branch newly pins a real,
comparable analog of WS-10 §11/§15's addressing and sender-class concepts (Open Question 7).

---

## (f) `Elicitation`/`ElicitationResult` — three renderings, not one

### Rendering 1 — the hook shapes (already pinned by P2; re-verified unchanged here)

**Source**: `sdk.d.ts:591-599` (`ElicitationHookInput`), `604-608` (`ElicitationHookSpecificOutput`),
`643-650` (`ElicitationResultHookInput`), `655-659` (`ElicitationResultHookSpecificOutput`) —
identical line ranges and field sets to `derived-shapes-p2.md` item (b)'s own table rows for
`Elicitation`/`ElicitationResult`, re-read and confirmed byte-for-byte unchanged at this pin (same
tarball, same checksum). Not re-derived in full here; see P2's own document for the complete field
tables.

### Rendering 2 — the wire control-request/message shapes (newly pinned here)

**Source**: `SDKControlElicitationRequest` `sdk.d.ts:3362-3382` (unexported — see item (b)'s finding
on this whole family); `SDKElicitationCompleteMessage` `4229-4236` (exported, a real `SDKMessage`
union member).

```ts
type SDKControlElicitationRequest = {   // the wire request that actually reaches an SDK consumer
  subtype: 'elicitation';
  mcp_server_name: string; message: string;
  mode?: 'form' | 'url'; url?: string; elicitation_id?: string;
  requested_schema?: Record<string, unknown>;
  title?: string;            // doc-asserted: mirrors can_use_tool.title
  display_name?: string;     // doc-asserted: mirrors can_use_tool.display_name
  description?: string;      // doc-asserted: mirrors can_use_tool.description
};

type SDKElicitationCompleteMessage = {   // emitted only for URL-mode elicitations
  type: 'system'; subtype: 'elicitation_complete';
  mcp_server_name: string; elicitation_id: string;   // both REQUIRED, unlike the hook's optional elicitation_id
  uuid: UUID; session_id: string;
};
```

**Finding**: the wire request carries **3 fields beyond** what P2 already pinned for the hook input
shape — `title`/`display_name`/`description`, doc-asserted as mirroring the same three fields on
`can_use_tool`'s own wire request (`derived-shapes-p2.md` item (c)'s `CanUseTool.title`/
`displayName`/`description`). This is the same "different surface, same field-mirroring pattern" P2
already established for `canUseTool` vs. `SDKControlPermissionRequest`; WS-09 §5's own prose does not
mention these three fields at all. `SDKElicitationCompleteMessage` is a **different, smaller, and
differently-optional shape** than the hook's `ElicitationResultHookInput` — it fires only for
`mode:'url'` completions, has no `action`/`content` fields at all, and its `elicitation_id` is
**required** where the hook input's is optional. Do not conflate the two despite the shared subject.

### Rendering 3 — the exported callback types (newly pinned here)

**Source**: `ElicitationRequest` `sdk.d.ts:613-632`; `ElicitationResult` `638`; `OnElicitation`
`1351-1359`; `Options.onElicitation` `1607`.

```ts
type ElicitationRequest = {   // camelCase — the actual callback parameter shape, NOT the hook's snake_case
  serverName: string; message: string;
  mode?: 'form' | 'url'; url?: string;
  elicitationId?: string; requestedSchema?: Record<string, unknown>;
  title?: string; displayName?: string; description?: string;
};
type ElicitationResult = ElicitResult;   // a direct alias to @modelcontextprotocol/sdk's own type — see item (g) scope note

type OnElicitation = (
  request: ElicitationRequest,
  options: { signal: AbortSignal; requestId: string },
) => Promise<ElicitationResult | null>;

// Options field:
onElicitation?: OnElicitation;
```

**Finding**: this is the actual host-side elicitation callback WS-09 §5 refers to ("Winter exposes
the host-side elicitation callback"). Its own doc comment (doc-asserted, restated) states it is
"called when an MCP server requests user input **and no hook handles it**" — i.e. the `Elicitation`
hook event (rendering 1) takes precedence; `onElicitation` is the fallback, not a parallel path.

**Open Question 1 — the null-return contract is a hang trap, not a decline, unless answered
out-of-band.** The same doc comment draws a hard line around when a bare `null` return is even
legitimate: only once the consumer's own code has already delivered the `control_response` through
some side channel of its own (its own illustration: a caller that has already POSTed a signed reply
out-of-band, carrying back the `requestId` the SDK originally handed it) does a `null` return mean
"already handled, skip your own write" — and only then is the runtime's own reply suppressed, so
the two paths do not race. It explicitly calls out the failure mode: "Fail-closed: an accidental
null means no response is sent and the elicitation stays pending until the server times it out." This means "no callback returns a decline" and "the callback exists
but returns `null`" are **not the same outcome** under this pinned contract — the latter is a hang
(bounded only by the server's own timeout), not a decline. WS-09 §5's own requirement ("When no
appropriate callback is supplied, elicitation MUST be declined deterministically") is written about
the *absent-callback* case, which this finding does not contradict — but it leaves unaddressed
exactly the case this pinned contract calls out as dangerous: a callback that *is* supplied but
returns `null` without having answered out-of-band. Winter's own `onElicitation`-equivalent needs to
decide whether to reproduce this exact hang-on-accidental-null behavior for source/behavioral
compatibility, or to treat any non-out-of-band `null` as an automatic decline (a deliberate,
safety-motivated deviation, analogous to WS-10 §10.4's inert-`@`-mentions waiver) — this pinned fact
is what makes that a real decision rather than a non-issue.

**Verdict for item (f)**: rendering 1 matches P2's own already-verified pin exactly (re-confirmed, no
drift). Renderings 2 and 3 are newly pinned here, are genuinely different shapes from rendering 1 and
from each other (field-name casing, optionality, and field-set differences all confirmed above), and
per this task's brief instruction are recorded distinctly rather than collapsed into one "Elicitation
shape."

---

## (g) The `@modelcontextprotocol/sdk` version range — pins R4-3

**Source**: the pinned tarball's own `package.json`.

```json
{
  "peerDependencies": {
    "@anthropic-ai/sdk": ">=0.93.0",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^4.0.0"
  }
}
```

**The value R4-3 pins: `^1.29.0`.**

**Finding — declared as a `peerDependency`, not an ordinary `dependency`**: the brief anticipated
either ("its package.json `dependencies`/`peerDependencies`"); the pinned package uses
`peerDependencies` exclusively for all three of its cross-package type-sharing needs
(`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `zod`) — there is no `dependencies` block in this
`package.json` at all. A peer dependency means the official package expects its own **consumers**
to already carry a compatible `@modelcontextprotocol/sdk` in their tree, rather than bundling/pinning
one itself. R4-3's own text ("`@modelcontextprotocol/sdk` becomes a runtime dependency" for Winter)
is a statement about *Winter's* package.json, not a claim about how the upstream package declares it
— this finding does not conflict with R4-3, it is the precise upstream fact R4-3 is building on: since
Winter is an independent implementation (not a wrapper re-exporting the official package), Winter
most plausibly wants this as an ordinary `dependency` at the same `^1.29.0` range, but that choice
belongs to whichever task edits Winter's own `package.json` (T2), not to this pinning task.

**Load-bearing confirmation this dependency is real, not incidental**: `sdk.d.ts` imports five
distinct symbols from `@modelcontextprotocol/sdk` across two subpaths — `McpServer` (from
`server/mcp.js`, line `7`) and `ToolAnnotations`/`CallToolResult`/`ElicitResult`/`JSONRPCMessage`
(from `types.js`, lines `10`, `4`, `5`, `6`). All five are used in publicly-exported pinned shapes
this document already pins above: `McpServer` in `McpSdkServerConfigWithInstance.instance` (item
(a)); `ToolAnnotations` in `SdkMcpToolDefinition.annotations`/`tool()`'s extras (item (a));
`CallToolResult` in every tool handler's return type (item (a)); `ElicitResult` as the sole body of
the exported `ElicitationResult` alias (item (f)); `JSONRPCMessage` in
`SDKControlMcpMessageRequest.message` (item (b)). This confirms the plan's own "Tech Stack" framing
— "a drop-in requirement because `createSdkMcpServer`'s pinned shape references its types" — is
accurate and, per the five call sites above, understates the surface: it's not only
`createSdkMcpServer`'s shape that references this package's types.

**Scope boundary**: `@modelcontextprotocol/sdk` itself was **not** independently fetched or
checksum-verified by this task — only `@anthropic-ai/claude-agent-sdk@0.3.250` is covered by this
repository's `checksums.json` chain. `ElicitResult`'s own field shape (item (f)) and
`ToolAnnotations`'s own field names (item (b)'s note) are therefore cited by name and import path
only; their internal structure is out of this task's verified scope, and any future task that needs
those shapes pinned should extend `checksums.json` with `@modelcontextprotocol/sdk`'s own tarball
hash first, following this same `fetchAndVerifyUpstream` discipline, rather than trusting an
un-pinned fetch.

---

## Open Questions

1. **`OnElicitation`'s null-return hang trap vs. WS-09 §5's deterministic-decline requirement.**
   (item (f)) The pinned contract treats an "accidental" `null` (returned without an out-of-band
   `control_response`) as a hang, not a decline — WS-09 §5's "MUST be declined deterministically"
   requirement is written about the *no-callback-supplied* case and is not directly contradicted, but
   it does not address whether a *supplied* callback's bare `null` return should hang (byte-parity)
   or auto-decline (a deliberate, named safety waiver) in Winter's own implementation.
2. **`AgentDefinition.skills: string[]` vs. WS-10 §2's `"all" | string[]` framing.** (item (d)) The
   pinned type admits no bare-scalar `"all"`; whether WS-10's notation means a literal TS union
   (in tension with the pin) or informal shorthand for `["all"]` (no tension) cannot be resolved from
   the declaration alone.
3. **`setMcpServers`'s plugin-owned-server exemption vs. WS-09 §3's "replaces the configured set
   live."** (item (b)) The pinned doc comment scopes replace-semantics to the dynamically-added
   subset only; plugin- and settings-configured servers survive an omission from the payload,
   including `setMcpServers({})`.
4. **`strictMcpConfig`'s allowlist includes `agents[*].mcpServers`, not just the `mcpServers`
   option.** (item (d)) WS-09 §1.2's precedence table names only the `mcpServers` option at the top
   of strict mode's allowed surface; the pinned doc comment is broader.
5. **`McpServerStatus.status`'s pinned spelling is `'needs-auth'` (hyphenated), not `needsAuth`.**
   (item (b)) This is narrower than a "7 states vs. 5 states" tension — WS-09 §2.1's 7-state model is
   sourced from a different surface (the report's `WaitForMcpServers` union plus the discovery cache,
   neither pinned by this artifact, item (c)), and WS-09 §8.4's `needsAuth` is itself a **field name**
   on that different result shape, not an enum value, so three different things share one concept
   name across three surfaces. The narrow, real question: Task 2's own `McpServerStateKind` already
   commits to camelCase `"needsAuth"` (task-2-brief.md) as Winter's *internal* state name — if a
   future task wants `Query.mcpServerStatus()` to be byte-compatible with the official method's own
   return shape, the internal `needsAuth` state must be rendered as the string `'needs-auth'` at that
   one serialization boundary, not assumed to already match.
6. **WS-09 §6's exact `_meta["anthropic/requiresUserInteraction"]` literal is declaration-silent.**
   (item (a)/(b)) An exhaustive search of all six `.d.ts` files found no occurrence of this literal
   key anywhere. Two **sibling** `_meta` keys under the same `anthropic/` namespace convention *are*
   declared — `anthropic/alwaysLoad` (`sdk.d.ts:522`) and `anthropic/permissionDisplay`
   (`626-631`, `3371-3379`) — confirming the naming convention is real and pinned, but not this
   specific key. The one *type-level* field that shares this concept,
   `SDKControlPermissionRequest.requires_user_interaction?: boolean` (`3998`), is doc-asserted
   (`3996-3997`) to be driven by an internal `Tool.requiresUserInteraction()` predicate and/or
   `localDisplayOnly` — built-in-tool-shaped language, with no mention of MCP `_meta` at all in that
   comment. WS-09 §6 itself cites "report §55," never a `.d.ts` line, so this silence is consistent
   with (not contrary to) the spec's own sourcing — recorded as an Open Question rather than a
   Note only because WS-09 §6 additionally imposes a MUST ("preserved... verbatim including the
   `anthropic/` key literal") that this pin cannot itself confirm the runtime honors.
7. **`SDKMessageOrigin`'s `fromMode?: 'bypass' | 'prompting'` vs. WS-10 §15's
   `senderPermissionClass(): Promise<"prompts" | "bypasses" | "unknown">` — a spelling gap and an
   arity gap, not the same shape.** (item (e)) Spelling: the pinned field uses the singular forms
   `'bypass'`/`'prompting'`; WS-10's own adapter method uses the plural forms `'bypasses'`/`'prompts'`.
   Arity: the pinned field is a 2-member *optional* field — absence is the implicit third state,
   never a literal value — while WS-10's method returns one of 3 *explicit* string members including
   a real `"unknown"` literal. `Settings.crossSessionInbound`'s own doc comment (item (e) addendum)
   treats "no declared `fromMode`" as functionally equivalent to WS-10's `"unknown"` ("a sender that
   asserts no class is held only while this session bypasses"), which is evidence the two concepts
   line up semantically — but semantic equivalence is not shape equivalence, and Winter's own
   `senderPermissionClass` implementation needs to decide explicitly whether "field absent" maps to
   `"unknown"` by convention or whether some other pinned signal should drive that mapping instead of
   an absence check.

---

## Notes recorded but not treated as Open Questions

No spec text is contradicted by any of these; recorded for completeness since they surfaced during
(a)-(g) derivation.

- **Correction to `derived-shapes-p3.md` item (a)'s own citation**: this document's independent count
  of the `SDKMessage` union at `sdk.d.ts:4399` — verified three ways (manual enumeration, a
  programmatic dedup count, and a pipe-character count) — is **39** members, not the **41** P3's own
  item (a) states for the identical citation (same pinned tarball, same checksum, same line; the
  union cannot have changed between tasks). P3's own substantive point there (that its six named
  shapes are direct top-level members) is unaffected by the count itself and remains correct; this is
  a citation correction only, recorded here rather than silently propagated, and P3's own file is
  left unedited since this task's scope is limited to the new file it produces.
- **`effort`'s numeric form is a confirmation, not a contradiction, of WS-10 §2.** (item (d), see
  above) — restated here for visibility since it is easy to misread as tension at a glance.
- **`wc -l` line-count discrepancy for `sdk.d.ts`** (Method section) — 8447 here vs. P2's stated 8448
  for the checksum-identical file, cross-checked two ways (`wc -l` and `awk 'END{print NR}'` both
  independently agree at 8447 against this extraction). The file does use CRLF line endings and does
  end with a trailing CRLF after its final `export { }` — so a missing-final-newline explanation is
  ruled out, not confirmed; the exact cause of P2's differing count is not determinable from this
  extraction, and is not load-bearing for any citation in this document, all of which are anchored to
  specific re-verified line numbers rather than the file's total.
- A session-level `Options.agent?: string` field (singular, `sdk.d.ts:1416`) sits immediately before
  `Options.agents` (plural, `1432`) — "which agent type is the main session," distinct from the map
  of definitions. Not one of this task's named items; recorded since it was read in the same pass.
- `getSessionMessages()`/`getSubagentMessages()` (`sdk.d.ts:792`, `829`) are exported functions
  returning `SessionMessage[]` (item (d)'s `parent_agent_id` finding) — a historical-transcript-read
  API family adjacent to, but outside, this task's own named items; likely relevant to [WS-05]'s own
  transcript-store design, not claimed here.
- `EffortLevel` (`sdk.d.ts:586`, a standalone 5-member named union) exists as its own exported type,
  but neither `AgentDefinition.effort` nor `SDKSystemMessage.effort` references it by name — both
  re-spell the same 5 literals inline instead. Three separate inline spellings of one conceptual
  5-value set in one file; not a divergence, just an internal inconsistency worth knowing about if
  Winter ever wants a single named type to mirror.
