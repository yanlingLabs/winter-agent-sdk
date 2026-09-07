import type { SpawnClaudeCodeProcess } from "./transport.ts";
import type { PermissionMode, CanUseTool, HookEvent, HookCallbackMatcher } from "./permissions/types.ts";
import type {
  SandboxSettingsConfig,
  McpServerToolPolicy,
  McpStdioServerConfig,
  McpHttpServerConfig,
  McpSSEServerConfig,
  McpSdkServerConfig,
  RuntimeAgentDefinition,
  SdkPluginConfig,
  SystemPromptOption,
  OutputFormat,
  SkillsOption,
  ProviderSelection,
  ThinkingConfig,
  EffortLevel,
  AutoClassifierConfig,
  AdvisorConfig,
} from "./protocol/config.ts";
import type { SettingSource } from "./settings/types.ts";
import type { SessionStore } from "./store/session-store.ts";
// P7a (D19): the brand profile. `Options.brand` is a PARTIAL of it; the two exported defaults below
// (`DEFAULT_PLANS_DIRECTORY`, `DEFAULT_KEYCHAIN_SERVICE`) DERIVE from `WINTER_BRAND` rather than
// re-spelling `.winter` / `com.winter.core` -- brand.ts is the one module allowed to carry those
// literals, and the sweep gate (packages/runtime/src/brand-gate.test.ts) enforces it.
import { WINTER_BRAND, type BrandProfile } from "./brand.ts";
export type { BrandProfile, BrandValidation } from "./brand.ts";
export type { SdkPluginConfig, SystemPromptOption, OutputFormat, JsonSchemaOutputFormat, SkillsOption } from "./protocol/config.ts";
// Phase 6 Task 2: the provider-layer option shapes re-exported from the same module a host imports
// `Options` from — one import site for "the Options-facing provider surface" (the same convention
// the MCP config union already follows below).
export type { ProviderSelection, ProviderConnectionConfig, CredentialRef, ThinkingConfig, EffortLevel, AutoClassifierConfig, AdvisorConfig } from "./protocol/config.ts";

// --- Phase 5 Task 2 (derived-shapes-p5.md item (c)): the pinned block-array sentinel --------------
//
// `sdk.d.ts:8157`, value verbatim; runtime-confirmed as a live export in Task 1's symbol sweep.
// Placed as a STANDALONE element of `systemPrompt`'s `string[]` arm, it splits the globally-cacheable
// static prefix (blocks before it) from the session-specific suffix (blocks after it).
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";

// --- Phase 5 Task 2: session defaults, as CONSTANTS rather than wire values ------------------------
//
// R5-3/R5-4/R5-9/R5-14 name defaults for four P5 options. They are exported here and applied
// RUNTIME-side when the corresponding field is absent, never baked into `--config-json` by query.ts:
// the established convention for every optional field on this surface is a conditional spread (an
// unset option is an ABSENT key), and baking a default in would change the wire for every session
// that never asked for one. `contextWindowTokens`/`compactionThreshold` are disclosed WINTER session
// options (the pin's own analogue for the latter is the `autoCompactWindow` SETTING, `sdk.d.ts:7599`,
// a different shape); `plansDirectory` mirrors the pinned settings key (`7693`) at the option layer;
// `DEFAULT_OUTPUT_STYLE` is the value `system/init.output_style` (a REQUIRED pinned field, `4879`)
// carries when no output style is configured.
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200000;
export const DEFAULT_COMPACTION_THRESHOLD = 0.92;
// P7a (D19): DERIVED, not spelled. `WINTER_BRAND.projectDirName` is `.winter`, so this constant's
// VALUE is byte-identical to the literal it replaces -- but a host running under its own brand gets
// `<their dir>/plans` from `resolveBrand`, and this module-level constant stays the Winter default
// for the un-branded path (a session's real value comes from its own resolved profile).
export const DEFAULT_PLANS_DIRECTORY = `${WINTER_BRAND.projectDirName}/plans`;
export const DEFAULT_OUTPUT_STYLE = "default";

// --- Phase 6 Task 2 (WS-13, rulings R6-6/R6-10): two more of the same kind ------------------------
//
// Same posture as the four above: exported CONSTANTS applied runtime-side when the option is
// absent, never baked into `--config-json` (an unset option stays an ABSENT wire key, so a session
// that configures neither is byte-identical to every session before they existed).
//
// `providerStallTimeoutMs` is a DISCLOSED WINTER option with no pinned counterpart: R6-6 makes a
// stream with no bytes for this long a typed `ProviderStallError` rather than an indefinite hang.
// `keychainService` mirrors WS-01 §3's service naming; the dev profile's `com.winter.core.dev` is
// selected by the host passing it explicitly, never inferred here.
export const DEFAULT_PROVIDER_STALL_TIMEOUT_MS = 120000;
// P7a (D19): DERIVED from the brand profile (same value, `com.winter.core`). A host that supplies a
// `brand` gets ITS service through `RuntimeConfig.brand.keychainService`; this constant remains what
// the runtime falls back to when neither the deprecated option nor a brand reached it.
export const DEFAULT_KEYCHAIN_SERVICE = WINTER_BRAND.keychainService;

// --- Phase 4 Task 2 (WS-09 derived-shapes item (a)): the HOST-facing MCP config union -------------
//
// Re-exports the four shared, structurally-identical-at-both-layers variants from protocol/config.ts
// unchanged (mirroring that file's own SandboxSettingsConfig precedent: one declaration, reused
// as-is) and adds the ONE variant the wire-safe `McpServerConfigForProcessTransport` union
// deliberately excludes: an in-process SDK server carrying a LIVE, non-serializable instance.
//
// `instance` is typed `unknown`, NOT the real `@modelcontextprotocol/sdk` `McpServer` type: nothing
// in this package constructs one -- Winter has no `createSdkMcpServer()`-equivalent public factory
// yet (out of this task's scope; the standing Winter server, packages/runtime/src/mcp/
// winter-server.ts, builds one directly runtime-side instead, never through this Options surface).
// Adding `@modelcontextprotocol/sdk` as a dependency of this Node-fenced, portable sdk package for
// one field nothing produces or reads would be a needless footprint increase; a host that already
// depends on that package directly can still build this shape by hand (TypeScript structurally
// accepts any value under `unknown`), and query.ts's own serialization (see its own
// `toWireMcpServers`) strips `instance` before it ever reaches the wire regardless of its declared
// type -- matching the pinned OFFICIAL SDK's own wire behavior, not working around it: derived-
// shapes-p4.md item (a) shows the `initialize` frame's own `sdkMcpServerConfigs` carries only
// `{name, timeout}` for this variant, never a live object, in the pinned artifact too.
//
// A NOTED PLAN GAP (task-2-report.md): the bridging that would make an SDK-type entry's `instance`
// actually reachable/callable from the spawned runtime process (an `mcp_message`-style
// control-request bridge, derived-shapes-p4.md item (b)) is unbuilt on EITHER side of this boundary
// in this phase -- no Phase 4 task's file list names query.ts for a host-side "mcp_message" handler
// (Task 3 owns rpc/*, Lane A owns mcp/*).
export interface McpSdkServerConfigWithInstance extends McpSdkServerConfig {
  instance: unknown;
}
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSSEServerConfig | McpSdkServerConfigWithInstance;
export type { McpServerToolPolicy, McpStdioServerConfig, McpHttpServerConfig, McpSSEServerConfig, McpSdkServerConfig };

// Phase 4 Task 3 (WS-04 addendum, "sdk_mcp_call host-side bridge"): `instance` stays `unknown` above
// (T2's deviation 9's own reasoning holds unchanged -- no dependency added, no field retyped, the
// existing query.test.ts stripping fixture's `{ notJsonSafe: () => {} }` still type-checks as
// `instance` exactly as before). This is Winter's OWN, ADDITIONAL structural contract a caller's
// `instance` MAY implement to make its tools actually reachable end-to-end (not merely wire-safe) --
// query.ts's own sdk_mcp_call responder and toWireMcpServers duck-type-check for this shape at
// runtime (isWinterMcpServerInstance) rather than the field's own declared type ever requiring it, so
// a host that only cares about the (already-shipped) wire-safety guarantee pays no new type
// obligation. `content`/`isError` loosely mirror the real MCP `CallToolResult` shape closely enough
// for a host-authored adapter to wrap a real `@modelcontextprotocol/sdk` `McpServer` around this
// interface (e.g. via an in-memory Client/Transport pair, exactly how T2's own winter-server.test.ts
// already proves the real SDK's shape) without this package taking on that dependency itself.
export interface WinterMcpServerInstance {
  listTools(): Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean; title?: string; idempotentHint?: boolean };
    _meta?: Record<string, unknown>;
  }>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown[]; isError?: boolean }>;
}

// Exported so query.ts's own two call sites (toWireMcpServers, makeSdkMcpCallHandler) and this
// package's tests share the identical runtime check -- never two independently-written duck-type
// guards that could silently drift apart on which methods are required.
export function isWinterMcpServerInstance(value: unknown): value is WinterMcpServerInstance {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { listTools?: unknown; callTool?: unknown };
  return typeof candidate.listTools === "function" && typeof candidate.callTool === "function";
}

// --- Phase 4 Task 2 (WS-09 derived-shapes item (d)): the HOST-facing AgentDefinition ---------------
//
// Identical to protocol/config.ts's own wire-shaped `RuntimeAgentDefinition` on every field except
// `permissionMode`, tightened here to the closed `PermissionMode` union -- see that file's own
// comment on `RuntimeAgentDefinition` for the full "wire stays open, host-facing tightens" rationale
// (Ruling 8's own precedent, applied to this nested field for the identical reason). A host
// application authoring `Options.agents` in TypeScript gets the same compile-time checking on this
// field that the top-level `Options.permissionMode` already has.
export type AgentDefinition = Omit<RuntimeAgentDefinition, "permissionMode"> & { permissionMode?: PermissionMode };

export interface Options {
  model?: string;
  // Ruling 8 (phase plan): tightened to the six-value union — the wire (RuntimeConfig.permissionMode,
  // protocol/config.ts) stays an open string; the runtime is what turns an unknown value into a
  // typed startup error (packages/runtime/src/permissions/policy-state.ts's assertKnownPermissionMode).
  permissionMode?: PermissionMode;
  maxTurns?: number;
  cwd?: string;
  env?: Record<string, string>;     // REPLACES the child env (WS-03 §5); flows into SpawnRuntimeOptions.env
  pathToClaudeCodeExecutable?: string;   // WS-04 §8 resolution seam: explicit path wins over the platform package
  // WS-04 §8 seam; default is a real child (transport.ts's defaultSpawn). Sign-off 2 rider
  // (whole-branch review): when this hook IS supplied, executable resolution is skipped entirely
  // (the hook owns process creation — see query.ts's own comment on that ternary) — the
  // SpawnRuntimeOptions.command it receives is then simply `pathToClaudeCodeExecutable` if also
  // set, or else the literal string "winter" as an inert placeholder the hook is free to ignore
  // (it never resolves to a real path or gets spawned by anything in this package).
  spawnClaudeCodeProcess?: SpawnClaudeCodeProcess;
  stderr?: (chunk: string) => void; // diagnostics callback; stdout frames never route here (WS-04 §6)
  maxBufferSize?: number;           // bounds an unterminated protocol line (WS-04 §2); default is provisional, see transport.ts
  // DEVIATION beyond the brief's literal Options-additions list (pathToClaudeCodeExecutable /
  // spawnClaudeCodeProcess / stderr / maxBufferSize): WS-04 §6 says "the consumer's AbortSignal
  // propagates: wrapper → control-level cancel, then kill on non-compliance", which presupposes a
  // consumer-facing cancellation input — Query.interrupt() is a control request, not kill/abort
  // (WS-04 §5), and stays a stub until Task 3's state machine. Recorded here as an Open
  // question/deviation in the Task 2 report: unverified against the pinned 0.3.250 declaration
  // (fetching it to check was ruled out of this task's scope) — a future snapshot pass may need to
  // rename or reshape this field.
  abortController?: AbortController;

  // --- Task 9 (WS-05 §7): continue / resume / fork / resume-at. Pure passthrough into
  // RuntimeConfig's already-declared fields (packages/sdk/src/protocol/config.ts — pre-declared
  // since Task 2) via query.ts's --config-json serialization; the actual resolution against the
  // transcript store happens runtime-side (packages/runtime/src/store/resume.ts +
  // dialect.ts's resolveEngineSession), never in this package (WS-02 §3: the sdk never imports the
  // runtime).
  sessionId?: string; // pre-allocate this run's session id instead of an auto-generated uuid; round-trips into the init frame's sessionId and the transcript filename.
  continue?: boolean; // resume the newest session in the current directory (WS-05 §7).
  resume?: string; // resume this session id — current project first, then every other project; an ambiguous foreign match is a typed refusal, never an arbitrary pick.
  forkSession?: boolean; // combined with continue/resume: copy the resolved target into a fresh session id FIRST, then resume the copy — the original transcript is left untouched.
  resumeSessionAt?: string; // load only through this message uuid (the transcript is a graph, not a linear buffer — the tail is never deleted, just not part of this run's context).
  resumeDropsTurn?: boolean; // confirms resumeSessionAt is intentionally discarding entries after the target uuid; validated runtime-side, never a blind trust flag.
  persistSession?: boolean; // false suppresses transcript persistence entirely; excluded from every resume surface (WS-05 §7).

  // --- Task 5 (WS-07 §3.3 / phase ruling 1): declarative authorization inputs, serialized through
  // --config-json exactly like every field above (conditional spreads in query.ts; RuntimeConfig
  // mirrors these fields verbatim — protocol/config.ts). These are raw `Tool`/`Tool(specifier)`
  // grammar strings (WS-07 §3), NOT PermissionUpdate's `PermissionRuleValue` object shape. query.ts
  // never interprets them — they are pure passthrough; a future runtime-side consumer
  // (packages/runtime/src/permissions/ruleset.ts's buildSdkSourcedEntries, wired into the engine by
  // a later task) turns them into `source: "sdk"` entries of a `SourcedRuleSet`, applying the same
  // add-time grammar validation every other rule source gets.
  allowedTools?: string[]; // allow rules, source "sdk". Advertisement-layer note (WS-07 §1): this pre-approves, it does not by itself hide other tools.
  disallowedTools?: string[]; // deny rules, source "sdk". Bare vs scoped both flow through parseRule unchanged (WS-07 §3's schema-removal-as-deny distinction, carried via ParsedRule.isBareEquivalent).
  // Task 6 (WS-07 §6.4): `disableBypassPermissionsMode` nests INSIDE `permissions` rather than sitting
  // top-level — WS-07 §6.4's own prose spells it `permissions.disableBypassPermissionsMode` verbatim
  // (managed policy's veto over the mode), so this mirrors the spec's own naming rather than
  // inventing a flatter shape. A plain boolean for now — source-tagged managed-only enforcement
  // arrives with real managed settings at P5 (phase-boundary ruling 1); nothing here validates WHO
  // set it. Judgment call, flagged in the report. query.ts's existing `permissions` passthrough
  // spread carries this field automatically — no serialization code changes needed for it.
  permissions?: { allow?: string[]; ask?: string[]; deny?: string[]; disableBypassPermissionsMode?: boolean };
  // Which settings-FILE tiers this session loads at all (WS-07 §3.2 / WS-11 §5).
  //
  // Phase 5 Task 2 NARROWING: this was typed `RuleSource[]` at P2 (a rule ORIGIN union, which
  // additionally carries `managed`/`cliArg`/`session`/`sdk`). Task 1 item (a) pinned the real type:
  // `SettingSource = 'user' | 'project' | 'local'` (`sdk.d.ts:7917`) — three FILE tiers, and the
  // only three a host can select. Omitted means all three (the CLI default); `[]` means filesystem
  // settings are disabled entirely (WS-01 §2.4's hermetic-host mode). No in-repo caller passed a
  // value outside the narrowed union.
  //
  // Pinned coupling worth knowing (`sdk.d.ts:2050`, recorded as OQ-P5-1 for Lane C): on the pinned
  // branch, project-context files load ONLY when `'project'` is selected — so context discovery is
  // source-gated there, which R5-9's unconditional `WINTER.md` injection does not mirror.
  settingSources?: SettingSource[];
  /**
   * Phase 5 fix wave, C1: the MANAGED policy tiers, threaded to the runtime's own settings
   * resolution. `managedSettings` is filtered restrictive-only there; `serverManagedSettings` is
   * deliberately not (`sdk.d.ts:2838-2839`). Before this existed the pinned `managed` rule source had
   * no producer in a live session at all.
   */
  managedSettings?: Record<string, unknown>;
  serverManagedSettings?: Record<string, unknown>;

  // Finding 6 (P2 fix-wave, IMPORTANT): pinned upstream Options member (derived-shapes item (g),
  // sdk.d.ts:1841) — omitting it is a drop-in Options-parity break under strict object-literal
  // checking, even though nothing in-repo referenced the gap. Phase ruling 7: "assigned to P4 (it
  // names an MCP permission-prompt tool — meaningless before MCP exists). Typed on Options ...
  // plumbed, ignored with a documented no-op." Serialized (query.ts) and read by NOTHING — no MCP
  // surface exists yet at P2 for a "which tool answers permission prompts" selector to mean
  // anything against.
  permissionPromptToolName?: string;

  // Finding 6 (P2 fix-wave, IMPORTANT) / T7 plan text ("new config field additionalDirectories?:
  // string[]"): the §6.2 bounding input the official Options carries, quietly landed as a ctx-only
  // evaluator field with no SDK-facing wire member at all — the orphaned-carry shape this fix wave
  // closes. Unlike permissionPromptToolName above, this ONE has real behavior waiting for it:
  // engine.ts threads it into evaluator.ts's `EvaluationContext.additionalDirectories`, which
  // `boundedRoots()` already unions with cwd + rule-derived grants for acceptEdits/auto edit
  // bounding, critical-removal input, AND (Finding 7, same fix wave) ordinary Reads.
  additionalDirectories?: string[];

  // Task 8 (P3 close-out, "Settings threading" MUST; WS-12 §2): the CC-shaped sandbox configuration
  // surface (RuntimeConfig.sandbox's own SandboxSettingsConfig, protocol/config.ts) — same pure-
  // passthrough convention as `additionalDirectories` above. Absent means "no sandbox config
  // supplied," which resolves runtime-side to the pre-existing DEFAULT_SANDBOX_SETTINGS every lane
  // already shipped against (sandbox on, network denied, no exclusions) — byte-identical to every
  // session before this field existed.
  sandbox?: SandboxSettingsConfig;
  // Task 8 (P3 close-out, "Settings threading" MUST; WS-12 §5.3): a Winter product extension (the
  // `$OUTDIR` export + extra writable root), not a CC-pinned field. Pure passthrough; this package
  // never creates or validates the directory. Absent means no OUTDIR export and no extra writable
  // root, exactly as before this field existed.
  outputsDir?: string;

  // Part B item 1 (fix wave, P3 close-out): registry.ts's own `buildAdvertisedSet` (WS-06 §1.5) has
  // carried `capabilities`/`toolSearchEnabled`/`insideSubagent`/`familyMetadata` input fields since
  // T1 -- every capability-gated descriptor (WebSearch/LSP/advisor, and now I4's twelve
  // executorless implement-now tools) checks `cfg.capabilities` against its own
  // `capabilityRequirements` -- but engine.ts's one production call site never had a wire field to
  // read a real value FROM, so `cfg.capabilities` was always `undefined` and every one of those
  // descriptors was unconditionally excluded regardless of what a host might actually want to
  // supply. This is that missing wire field: resolved runtime capability tokens (e.g.
  // "winter.search-backend", "winter.subagents", "mcp:<server>"), matched 1:1 against a
  // descriptor's own `capabilityRequirements`. Absent means "no capabilities supplied" -- the SAME
  // exclude-everything-gated behavior every session had before this field existed (byte-identical
  // default). Populating this from a real catalog-derived source (the provider catalog, MCP-server
  // connection state) is a LATER phase's own job (P6-ish, WS-13/WS-09) -- this is only the wire
  // field + the plumbing into buildAdvertisedSet, mirroring `additionalDirectories`'s own
  // "orphaned carry, closed" precedent above.
  capabilities?: string[];
  // Same posture as `capabilities` above -- registry.ts's own AvailabilityPredicate fields
  // (`requiresToolSearchDisabled`/`insideSubagent`) already consult these; absent means "tool search
  // is not known-disabled" / "not known to be inside a subagent," the pre-existing default every
  // descriptor's own comments already document for an absent value.
  toolSearchEnabled?: boolean;
  insideSubagent?: boolean;
  // Registry.ts's own `AvailabilityPredicate.hiddenWhenFamilyTaskNative` consumer -- absent reads as
  // "not task-native" (shown), exactly as every existing descriptor comment already documents.
  familyMetadata?: { taskNative?: boolean };

  // Task 6 (WS-07 §6.4): explicit, top-level, and named to be impossible to set by accident — the
  // ONLY thing that lets a session SELECT bypassPermissions (at startup, or via a later
  // setPermissionMode into it): both paths are gated identically
  // (packages/runtime/src/permissions/policy-state.ts's checkBypassGate). Absent/false is the
  // default; `permissions.disableBypassPermissionsMode` above overrides even an explicit `true`.
  allowDangerouslySkipPermissions?: boolean;

  // Task 8 (WS-07 §7.1): the product-facing prompt handler. Never serialized into RuntimeConfig
  // (--config-json) — it's a JS function, not wire-safe data; the runtime knows nothing about
  // whether one exists, only that a "permission" control_request either gets an answer or the
  // wrapper's own generic "no handler registered" fallback fires (query.ts registers a "permission"
  // handler ONLY when this is set — see that file's own comment on why the two are equivalent from
  // the runtime's point of view: no callback and "no handler answered it" collapse to the identical
  // wire outcome). §7.3: paired with a static shadow-warning check at query() construction time.
  canUseTool?: CanUseTool;

  // --- Task 9 (WS-08 §1/§2; derived-shapes-p2.md item (a), verbatim): the SDK-callback hooks
  // registration surface. Like `canUseTool` immediately above, this is NEVER serialized wholesale
  // into RuntimeConfig (--config-json) — `HookCallback` values are JS functions, not wire-safe data.
  // What DOES cross the wire (WS-08 §2's "the config carries the source-tagged registration list" /
  // phase ruling 1) is a STRUCTURE-ONLY shape with the functions stripped out — see
  // protocol/config.ts's `RuntimeConfig.hooks` for that wire shape and its own header for why it is
  // deliberately NOT keyed by the closed `HookEvent` union this field uses. Wiring the actual
  // Options.hooks -> RuntimeConfig.hooks conversion (and the reverse: dispatching an inbound `hook`
  // control_request back to the matching callback here) is query.ts's job, owned by a later task —
  // this field only pins the verbatim public shape a host program writes against.
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;

  // Task 10 (WS-08 §9; derived-shapes item (d), doc-asserted `@default false`): gates the public
  // hook-lifecycle message trio (hook_started/hook_progress/hook_response) — suppressed from the
  // public stream when false/absent, but ALWAYS recorded to Winter's audit stream regardless (§9
  // Amended text). Two events are exempt from the gate per that same doc comment (SessionStart's and
  // Setup's own lifecycle messages emit unconditionally) — see engine.ts's own lifecycle-sink
  // comment for where that exception actually lives.
  includeHookEvents?: boolean;

  // --- Phase 4 Task 2 (WS-09 derived-shapes item (a)/(c)/(d)): MCP config, Tool Search aliases, and
  // subagent definitions. Pure passthrough into RuntimeConfig, same conditional-spread convention as
  // every field above — query.ts never interprets these itself.
  //
  // Source precedence / trust-gating / strictMcpConfig's own allowlist semantics ([WS-09] §1.2) are
  // ALL runtime behavior, not an sdk-layer concern — this field only carries the explicit SDK-level
  // configuration WS-09 §1.2's precedence table calls "explicit SDK `mcpServers`," the top of that
  // order.
  mcpServers?: Record<string, McpServerConfig>;
  // WS-09 §1.1/§1.2: when set, only explicitly supplied servers exist for this session (ambient
  // project/user discovery is skipped). Doc-asserted upstream nuance (derived-shapes item (b)):
  // strict mode's own allowlist also includes servers declared by `agents[*].mcpServers`, not just
  // this field alone — recorded as an Open Question for whichever task implements the actual gate
  // (Lane A), not resolved here.
  strictMcpConfig?: boolean;
  // WS-09 §10: redirects a model-emitted BUILT-IN tool name to another implementation before
  // name-based `tool_use` lookup (e.g. `SendMessage -> mcp__winter__send_message`) — single-hop,
  // never a security boundary (`disallowedTools` remains the enforcement floor). [WS-14] is the
  // primary consumer on the official branch; the Winter branch applies it at the registry's own
  // name-lookup boundary (a later task's own wiring, not this field's own concern).
  toolAliases?: Record<string, string>;
  // WS-10 §1–§2: named subagent definitions a host supplies programmatically, keyed by
  // `subagent_type`. Merges with (and, per WS-10 §1's own precedence, is overridden by) filesystem
  // `.winter/agents/*.md`/`~/.winter/agents/*.md` definitions — Lane C (Task 6) owns that resolution;
  // this field only carries the programmatic half across the wire.
  agents?: Record<string, AgentDefinition>;
  // WS-10 §4: by default only `tool_use`/`tool_result` blocks from a subagent are forwarded to the
  // host stream (a heartbeat counter's worth); `true` additionally forwards the subagent's own
  // text/thinking blocks as assistant/user messages carrying `parent_tool_use_id`, for a full nested
  // transcript. Absent/false preserves the pre-existing, already-shipped default behavior exactly.
  forwardSubagentText?: boolean;

  // Phase 4 Task 3 (WS-09 §5; derived-shapes-p4.md item (f) rendering 3): the host-side elicitation
  // callback -- "called when an MCP server requests user input and no [Elicitation] hook handles it."
  // Never serialized into RuntimeConfig, same posture as `canUseTool`/`Options.hooks` above: it is a
  // JS function, not wire-safe data. query.ts registers an `mcp_elicitation` control-request handler
  // ONLY when this is set; absent means the runtime's own `bridge.request("mcp_elicitation", ...)`
  // lands on the generic "no handler registered" fallback, which the runtime side maps to a
  // DETERMINISTIC DECLINE (WS-09 §5's own MUST) -- never a hang, never a fabricated answer.
  //
  // DELIBERATE, NAMED SAFETY DEVIATION from the pinned artifact's own documented behavior
  // (derived-shapes-p4.md item (f) Open Question 1): the pinned `OnElicitation` contract treats a
  // bare `null` return as a HANG unless the consumer already answered out of band -- "an accidental
  // null means no response is sent and the elicitation stays pending until the server times it out."
  // Winter's own `query.ts` responder instead treats ANY `null` return as an automatic decline
  // (mirrors the precedent WS-10 §10.4 already sets for inert `@`-mentions: an intentional,
  // security/liveness-motivated waiver against the 2.1.250 baseline, recorded rather than silently
  // reproduced) — this callback has no out-of-band response escape hatch at all, so "accidental null"
  // and "deliberate decline" are the same signal here by construction, and the safer reading (never
  // hang) is the one Winter ships.
  onElicitation?: (
    request: {
      serverName: string;
      message: string;
      mode?: "form" | "url";
      url?: string;
      elicitationId?: string;
      requestedSchema?: Record<string, unknown>;
      title?: string;
      displayName?: string;
      description?: string;
    },
    options: { signal: AbortSignal; requestId: string },
  ) => Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> } | null>;

  // --- Phase 5 Task 2 (WS-11; derived-shapes-p5.md items (b)/(c)/(d)/(e)) --------------------------
  //
  // Pure passthrough into RuntimeConfig, the same conditional-spread convention as every field
  // above: query.ts interprets none of them, and an unset option is an ABSENT wire key (defaults are
  // applied runtime-side from the constants at the top of this file, never baked into the wire).
  // Lanes W/S/C/K and Task 3 are the real consumers.

  // `sdk.d.ts:2159-2164`, THREE arms (R5-9 as amended): a plain string REPLACES the prompt; a
  // `string[]` is the block-array form split by SYSTEM_PROMPT_DYNAMIC_BOUNDARY (above); the preset
  // object selects the authored preset and appends. `excludeDynamicSections` lives INSIDE the preset
  // object (`2163`) and is doc-asserted inert for a string prompt (`2124`) — there is deliberately no
  // sibling option of that name, which is where R5-9 originally put it. Winter's own `"winter_code"`
  // preset spelling is Lane C's alias to resolve, not a widening made here: this union carries the
  // pinned one-member literal verbatim.
  systemPrompt?: SystemPromptOption;
  // `sdk.d.ts:1856` / `4597-4610`. THREE fields, not two — `skipMcpDiscovery` (`4609`) loads a
  // plugin's skills/hooks/agents/commands while leaving its MCP servers to the host, which is exactly
  // the Winter daemon's posture (OQ-P5-3, Lane S).
  plugins?: SdkPluginConfig[];
  // The main-session skill filter (the pinned wire twin is `SDKControlInitializeRequest.skills`,
  // `sdk.d.ts:3775`). DISCLOSED SHAPE NOTE: Task 1's artifact records the option's own doc lines
  // (`2055`, `2065` — unlisted skills are rejected by the Skill tool) but not its declared type, and
  // capture (4) shows the running engine accepts `'all'`; the union below is Winter's reading of
  // those two facts. Omission is NOT "skills off" (capture (4): 16 builtin skills listed with the
  // option unset, and `'all'` changed neither list).
  skills?: SkillsOption;
  // `sdk.d.ts:1811` / `963-966` (R5-10). Registers a host-generated `StructuredOutput` descriptor
  // whose `input_schema` IS this schema, byte-for-byte (capture (6) proved it verbatim).
  outputFormat?: OutputFormat;
  // `sdk.d.ts:1549` (R5-11). Backup-before-modify interception on Write/Edit/NotebookEdit; the
  // settings twin is `fileCheckpointingEnabled` (`7850`). Capture (2): combining this with an
  // external `sessionStore` is rejected at query() construction — that rejection is Lane K's, not
  // this field's.
  enableFileCheckpointing?: boolean;
  /**
   * `sdk.d.ts:1672-1683`: an external session store the runtime MIRRORS transcript writes to. A
   * DUAL-WRITE MIRROR, never a replacement -- local writes always still happen, which is exactly why
   * the checkpointing rejection below is about backup blobs specifically rather than about external
   * storage in general.
   *
   * A LIVE OBJECT, like `canUseTool`/`hooks`/`mcpServers[].instance`: it is never serialized into
   * `--config-json`, so a spawned-process transport reaches it only through the wrapper. Winter does
   * not yet mirror to it (Lane K / a later phase); it is declared here because two documented
   * combination REJECTIONS depend on its presence and capture (2) pins both of them at construction.
   */
  sessionStore?: SessionStore;
  // DISCLOSED WINTER session options (R5-3/R5-4). The pin has no per-session context-window option
  // at all (P6's model catalogue is where per-model values come from) and expresses its compaction
  // trigger as the `autoCompactWindow` SETTING (`sdk.d.ts:7599`), a different shape. Absent means
  // DEFAULT_CONTEXT_WINDOW_TOKENS / DEFAULT_COMPACTION_THRESHOLD, applied runtime-side.
  contextWindowTokens?: number;
  compactionThreshold?: number;
  // DISCLOSED WINTER option (RULING P5-A): host-declared workspace trust. Default false — a
  // repository must never self-trust (WS-07 §3.2), and nothing infers this from `settingSources`.
  // It sits ABOVE the pinned per-tier filter, never underneath it: capture (1) proved the pinned
  // trust concept is a filter on PROJECT-tier permissive rules, so deriving that filter from this
  // bit would leave an untrusted repo's project-tier `deny` silently unenforced.
  trustedWorkspace?: boolean;
  // Mirrors the pinned settings key (`sdk.d.ts:7693`) at the option layer. Absent means
  // DEFAULT_PLANS_DIRECTORY, applied runtime-side.
  plansDirectory?: string;
  // Mirrors the pinned settings key (`sdk.d.ts:7270`). The resolved value is what
  // `system/init.output_style` (a REQUIRED pinned field, `4879`) reports; absent means
  // DEFAULT_OUTPUT_STYLE.
  outputStyle?: string;

  // --- Phase 6 Task 2 (WS-13; derived-shapes-p6.md items (b)/(c)/(d)/(e)/(g)) ----------------------
  //
  // Pure passthrough into RuntimeConfig, the same conditional-spread convention as every field
  // above. See protocol/config.ts for each type's declaration and its pinned citation.

  /**
   * DISCLOSED WINTER option (R6-9). Which provider a BARE `model` id resolves against, plus that
   * provider's connection metadata and credential reference.
   *
   * `model` itself stays the pinned bare string and `system/init.model` keeps reporting what the
   * caller passed — the resolved identity rides Winter-only init extension fields instead. A
   * qualified `"<providerId>/<model>"` key needs no `provider` at all; the pinned Anthropic aliases
   * (`sonnet`/`opus`/`haiku`/`claude-*`) resolve to the `anthropic` provider when a credential ref
   * for it is configured. No model and no provider is a typed resolution error, never a silent
   * default (WS-13 §9: no routing, no substitution in the provider layer).
   */
  provider?: ProviderSelection;
  /**
   * `sdk.d.ts:1540` — a **single string carrying a COMMA-SEPARATED list**, tried in order. This is
   * the pin's own convention, not an oversight: the settings twin `Settings.fallbackModel` (`5577`)
   * is a `string[]`, and the two shapes coexist with a documented precedence. Typing this `string[]`
   * would be a parity divergence (derived-shapes-p6.md item (g), finding 1).
   *
   * Pinned semantics, AS IMPLEMENTED (P6 fix wave, Ruling E-3): the trigger is an R6-6
   * retryable-class provider failure -- 5xx/overloaded, 429 (non-billing), 408, network, timeout --
   * AFTER the adapter's own retries are exhausted (NOT a refusal: the `model_refusal_fallback`
   * frame's `trigger` is the literal `'refusal'`). The failed round is re-run on the next candidate,
   * candidates are tried in order, each once per turn, and the primary is re-tried at the START OF
   * EACH USER TURN, so a temporary outage never permanently demotes the session. The swap emits NO
   * pinned frame (capture (G): the only observable is the outgoing request's `model`); Winter
   * additionally emits its disclosed `system/model_switch{reason: "fallback"}` for the swap AND for
   * the restoration, and records both in the dialect record's `providerHistory`. A candidate is
   * honoured only inside the CURRENT model's continuation domain (R6-9) -- a cross-domain candidate
   * is a typed error at init and is skipped at engagement time if a `set_model` has since moved the
   * session. A `set_model` parked during a fallback turn supersedes the restoration.
   */
  fallbackModel?: string;
  /** `sdk.d.ts:1736`, three arms (`adaptive` | `enabled` | `disabled`). Takes precedence over `maxThinkingTokens`, stated twice in the pin (`1732`, `8215`). */
  thinking?: ThinkingConfig;
  /**
   * `sdk.d.ts:1749`. **No numeric form** — see `EffortLevel`'s own declaration comment (R6-E).
   *
   * Pinned adjacent rules a consumer must not fight: `'max'` is session-scoped and deliberately not
   * persistable (`Settings.effortLevel` excludes it), and the ACTIVE level is the one left after a
   * per-model silent downgrade — which is exactly what the catalog's `reasoning.efforts` evidence
   * exists to compute honestly rather than by guess.
   */
  effort?: EffortLevel;
  /**
   * @deprecated Use `thinking` instead.
   *
   * `sdk.d.ts:1758`. Kept and typed rather than dropped, because dropping a pinned Options member is
   * a drop-in parity break. Its semantics CHANGE BY MODEL and that is the trap: on a modern model it
   * is reinterpreted as on/off — `0` disables, any other value means *adaptive* — so forwarding
   * `maxThinkingTokens: 8000` is not "budget 8000" (R6-E maps it exactly that way).
   */
  maxThinkingTokens?: number;
  /**
   * `stream_event` frames (`SDKPartialAssistantMessage`) are emitted only under this gate (R6-5).
   * Absent/false keeps the stream byte-identical to every session before partial streaming existed.
   */
  includePartialMessages?: boolean;
  /**
   * A cumulative USD ceiling for this query's provider spend, LIVE since the P6 fix wave (Ruling
   * E-4, R6-H). Checked BEFORE every provider request: once the accrued `total_cost_usd` exceeds it,
   * the next request does not go out and the turn ends on the pinned `error_max_budget_usd` result
   * (`is_error: true`), which carries the cost that crossed it. The generation that crossed the
   * ceiling still delivers its own frames -- the cut is a request never sent, not an answer lost.
   *
   * The descriptor's `pricing` evidence is the ONLY price source: a priced row makes every result
   * frame carry `total_cost_usd` (accumulated over the whole run and repeated on each result) and a
   * `modelUsage` row keyed by the model string, with the catalog key as `canonicalModel` and
   * `costBasis: "list"`; an UNPRICED row emits NO cost field at all and leaves this ceiling inert
   * (disclosed). Winter deliberately does NOT do what the pin does here -- capture (K) shows the
   * pinned runtime reporting a non-zero cost for a model no price table contains -- and it does not
   * emit the main-loop-only `usage` block, which the pin's own JSDoc deprioritises (disclosed).
   */
  maxBudgetUsd?: number;
  /** DISCLOSED WINTER option (R6-6): a stream silent for this long aborts as a typed `ProviderStallError`. Absent means DEFAULT_PROVIDER_STALL_TIMEOUT_MS. */
  providerStallTimeoutMs?: number;
  /** DISCLOSED WINTER option (R6-10): the macOS Keychain service every `{ kind: "keychain" }` ref resolves under. Absent means DEFAULT_KEYCHAIN_SERVICE. */
  keychainService?: string;
  /** DISCLOSED WINTER option (R6-14): the permission classifier's own model/credential, resolved through the SAME selection path as the session model. With none configured the worker serves only a `classifierEligible` model, else Manual fallback — never a silent weakening. */
  autoClassifier?: AutoClassifierConfig;
  /**
   * DISCLOSED WINTER option (P2 carry, wired in T10): the advisor/reviewer backend's model, same
   * selection path. Its optional `authRef` (fix wave, Ruling E-1) is the advisor's OWN credential:
   * a target on another provider than the session's never inherits the session's -- it uses the
   * route's ref, else the target provider's own keychain record (`<providerId>:default`), else a
   * typed `no-credential-for-provider` refusal at its first generation.
   *
   * The MODEL may also come from `settings.advisor.model` (D30, hot); `Options.advisor.model` wins.
   */
  advisor?: AdvisorConfig;
  /**
   * DISCLOSED WINTER option (P7a, D19): THE BRAND PROFILE — every Winter-owned name this session
   * runs under, as a partial that folds onto Winter's own defaults (brand.ts's `WINTER_BRAND`).
   *
   * This is what makes the SDK genuinely reusable rather than merely open: a host consuming Winter
   * alone (D19's tier 1) gets its OWN home dir, project dir, instructions file, env prefix, keychain
   * service, MCP server name and codex originator, resolved once here and carried to the runtime on
   * `RuntimeConfig.brand` so a spawned or compiled child derives the same names the wrapper did.
   *
   * VALIDATED AT `query()` (brand.ts's grammar rules), and a refusal is a typed `InvalidBrandError`
   * thrown synchronously at construction, like the other option-combination rejections above --
   * never a silently-substituted default, because a session that quietly ran under the wrong home
   * dir or the wrong keychain service is the worst possible outcome of a typo here.
   *
   * `keychainService` above is the DEPRECATED standalone alias for `brand.keychainService`: when
   * both are set the standalone one WINS (it predates the profile and existing hosts pass it), and
   * `query()` warns when the two are set to DIFFERENT values so the losing one is never silent.
   *
   * Claude-mirroring literals are NOT in the profile and cannot be rebranded (WS-01 §5): the
   * official runtime's `CLAUDE_CONFIG_DIR`/`CLAUDE_CODE_TMPDIR`/`preset: "claude_code"`/
   * `.claude-plugin` are its names, not ours. Neither are this repository's own test-harness env
   * names.
   */
  brand?: Partial<BrandProfile>;
}
