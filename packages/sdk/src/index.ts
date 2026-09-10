export { query } from "./query.ts";
export type { Query, SdkMessage, SessionMessagingFacet } from "./query.ts";
// Task 2 (WS-04 §3.1): the wrapper's control-request handler registry types — QueryInternal is the
// shape behind the Winter-only `Query.__internal` extension (never part of the WS-03 pinned
// surface; T8 adds `respondPermission` to it for the canUseTool `null` escape).
export type { QueryInternal, ControlRequestHandler, ControlRequestHandlerResult } from "./query.ts";
export type { Options } from "./options.ts";
// Phase 5 Task 2 (derived-shapes-p5.md items (b)/(c)/(d)/(e)): the P5 option shapes + the pinned
// block-array sentinel + the four session defaults that are resolved runtime-side rather than baked
// into the wire (see options.ts's own header for why they are constants and not wire values).
export { SYSTEM_PROMPT_DYNAMIC_BOUNDARY, DEFAULT_CONTEXT_WINDOW_TOKENS, DEFAULT_COMPACTION_THRESHOLD, DEFAULT_PLANS_DIRECTORY, DEFAULT_OUTPUT_STYLE } from "./options.ts";
// Phase 6 Task 2 (WS-13): the provider-layer option shapes + their two runtime-side defaults. Note
// `CredentialRef` in particular — it is declared ONCE, here in the dependency-free sdk, and
// re-exported by @yanlinglabs/winter-provider-runtime, so a lane importing it from either package
// gets the identical type rather than two structurally-similar twins that can drift.
export { DEFAULT_PROVIDER_STALL_TIMEOUT_MS, DEFAULT_KEYCHAIN_SERVICE } from "./options.ts";
export type { ProviderSelection, ProviderConnectionConfig, CredentialRef, ThinkingConfig, EffortLevel, AutoClassifierConfig, AdvisorConfig, ModelInfo, AccountInfo } from "./protocol/config.ts";
// WS-13c §7 (P6.6): the model-family / slot public shapes. `Query.listModelFamilies()` returns
// `ModelFamilyListing`; `ModelSlotSetting` is what `settings.modelSlots` holds.
export type { SlotView, ActiveSlotSet, ModelFamilyListing, ModelSlotSetting, ModelRowServable } from "./protocol/config.ts";
export type { SdkPluginConfig, SystemPromptOption, SystemPromptPreset, OutputFormat, JsonSchemaOutputFormat, SkillsOption, RewindFilesResult, RewindFilesRequest, InitPluginInfo } from "./protocol/config.ts";
// Phase 4 Task 2 (WS-09 derived-shapes item (a)/(d)): the HOST-facing MCP config union + subagent
// definition shape a program writing `Options.mcpServers`/`Options.agents` types against — see
// options.ts's own header comments for the full rationale (why `McpSdkServerConfigWithInstance`
// exists, why `AgentDefinition` here differs from `RuntimeAgentDefinition` below by exactly one
// field). The plain per-transport variants (McpStdioServerConfig et al.) are ALSO re-exported from
// this same module (options.ts re-exports them unchanged from protocol/config.ts) rather than from
// protocol/config.ts's own barrel entry below, to keep "the Options-facing MCP surface" one import
// site for a host program.
export type { McpServerConfig, McpSdkServerConfigWithInstance, McpServerToolPolicy, McpStdioServerConfig, McpHttpServerConfig, McpSSEServerConfig, McpSdkServerConfig, AgentDefinition } from "./options.ts";
// Phase 4 Task 3 (WS-04 addendum, "sdk_mcp_call host-side bridge"): the structural contract an
// in-process SDK server's `instance` MAY implement to be actually callable end-to-end (not merely
// wire-safe) -- see options.ts's own header for why `instance` itself stays `unknown`.
export { isWinterMcpServerInstance } from "./options.ts";
export type { WinterMcpServerInstance } from "./options.ts";
export type { WireMcpToolDefinition } from "./protocol/config.ts";
// P7a (D19): THE BRAND PROFILE. Exported from the package index that owns it, values and types
// together — a host writing `Options.brand` needs `BrandProfile` to type its own profile,
// `WINTER_BRAND` to read a default it is not overriding, `resolveBrand` to validate one before
// constructing a query, and the three derivation helpers to spell the names its own integration
// code needs (an env var, an mcp tool name, a User-Agent) exactly the way Winter spells them.
export { WINTER_BRAND, BRAND_TOKEN_RE, FIRST_PARTY_ORIGINATORS, resolveBrand, envName, mcpToolName, userAgent } from "./brand.ts";
export type { BrandProfile, BrandValidation } from "./brand.ts";
export {
  WinterSDKError,
  CLIConnectionError,
  ProcessError,
  ResultError,
  ProtocolDecodeError,
  AbortError,
  SessionNotFoundError,
  WinterRpcError,
  WinterRpcTimeoutError,
  InvalidBrandError,
} from "./errors.ts";

// The pinned process seam (WS-04 §8) — byte-level SpawnedRuntimeProcess handle, shared by the real
// child transport and winter-agent-runtime/testing's in-memory transport (Task 2).
export { resolveRuntimeExecutable, defaultSpawn } from "./transport.ts";
export type { SpawnedRuntimeProcess, SpawnRuntimeOptions, SpawnClaudeCodeProcess } from "./transport.ts";
export type { RuntimeConfig, RuntimeHooksConfig, RuntimeHookMatcherGroup, SandboxSettingsConfig } from "./protocol/config.ts";
// Phase 4 Task 2: the WIRE-shaped twins (RuntimeConfig.mcpServers/.agents's own value types) --
// what packages/runtime code actually imports (engine.ts et al. already consume RuntimeConfig
// itself from this exact barrel; Lane A/Lane C are this phase's own new consumers of these two).
// `RuntimeAgentDefinition` is intentionally NOT re-exported under the bare name `AgentDefinition`
// (options.ts's own export above owns that name) -- see protocol/config.ts's own header for why the
// two differ by exactly one field (`permissionMode`).
export type { McpServerConfigForProcessTransport, AgentMcpServerSpec, RuntimeAgentDefinition } from "./protocol/config.ts";

// Wire protocol (WS-02 §3: owned by the sdk, the runtime depends on it — never the reverse).
// Previously reachable only via the runtime; now the sdk's own public surface.
export { encodeFrame, decodeFrame, splitFrames, ProtocolError } from "./protocol/codec.ts";
export { PROTOCOL_VERSION } from "./protocol/frames.ts";
export { SDK_VERSION } from "./version.ts";

// --- the per-session MESSAGING FACET on the wire (R-7b-4) -----------------------------------------
//
// The six control subtypes, their payload shapes and the guards both sides run. Exported from the
// MAIN barrel rather than from `./messaging` because these are WIRE frames -- the contract and rules
// a host implements against live on the subpath; this is how one particular transport carries them.
export { MESSAGING_CONTROL_SUBTYPES, MESSAGING_CONTROL_SUBTYPE_LIST, MESSAGING_HOST_REQUEST_SUBTYPES, MESSAGING_RUNTIME_REQUEST_SUBTYPES, resolveFacetTarget } from "./protocol/messaging.ts";
export {
  isRuntimeAddress,
  isGlobalAgentMessage,
  isDeliveryOutcome,
  isListedRuntimeObjectArray,
  isPermissionClassLabel,
  isMessagingDeliverRequest,
  isMessagingChildRequest,
  isMessagingSubscribeIdleRequest,
  isMessagingReadNotificationsRequest,
  isMessagingNotificationsPage,
  isMessagingIdleNoticePayload,
  isNotificationRecord,
} from "./protocol/messaging.ts";
export type {
  MessagingControlSubtype,
  MessagingDeliverRequest,
  MessagingChildRequest,
  MessagingSubscribeIdleRequest,
  MessagingSenderClassResponse,
  MessagingReadNotificationsRequest,
  MessagingNotificationsPage,
  MessagingIdleNoticePayload,
} from "./protocol/messaging.ts";
// Aliased: `SdkMessage` above is query()'s CLOSED result union (WS-03 §8). This is the wire-level
// OPEN union frames carry (system/assistant/result + a lossless unknown-kind catch-all) — the two
// can't share a name in one barrel.
export type {
  ProtocolVersion,
  WinterFrame,
  SdkMessage as ProtocolSdkMessage,
  InitFrame,
  UserFrame,
  DataFrame,
  ControlRequestFrame,
  ControlResponseFrame,
  UnknownFrame,
  // Task 10 (WS-08 §9 / Ruling P2-A; Ruling-9 public union growth): the hook-lifecycle trio +
  // PermissionDenied — new named SdkMessage variants a host can discriminate on `.subtype`.
  SDKHookStartedMessage,
  SDKHookProgressMessage,
  SDKHookResponseMessage,
  SDKPermissionDeniedMessage,
  // Finding 3 (P2 fix-wave): the array-element shape of SDKResultMessage.permission_denials.
  SDKPermissionDenial,
  // Phase 3 Task 2 (WS-06 §3.5; Ruling-9 public union growth): the background-task message family +
  // local-command-output — new named SdkMessage variants a host can discriminate on `.subtype`, plus
  // the closed union alias ToolExecutionContext.emitFrame (packages/runtime) accepts.
  SDKTaskStartedMessage,
  SDKTaskNotificationMessage,
  SDKTaskUpdatedMessage,
  SDKTaskProgressMessage,
  SDKBackgroundTasksChangedMessage,
  SDKLocalCommandOutputMessage,
  BackgroundTaskMessage,
  // Phase 5 Task 3 (derived-shapes-p5.md item (f)): the compaction boundary a host discriminates on
  // `.subtype === "compact_boundary"` -- named on the barrel because a host that renders a transcript
  // needs the metadata shape to relink a preserved segment, not merely to skip the frame.
  SDKCompactBoundaryMessage,
  // Phase 6 Task 3 (R6-5/R6-D, derived-shapes-p6.md items (a)/(b)): the provider-facing frame family
  // plus the Winter-DECLARED wire vocabularies it carries. Named on the barrel because a host that
  // renders live tokens must be able to discriminate `stream_event` and reach inside `event`, and
  // because the runtime's own provider seam imports these rather than re-declaring them (one
  // declaration home for a wire shape, R6-D).
  WireContentBlock,
  WireStreamEvent,
  WireStreamEventDelta,
  SDKPartialAssistantMessage,
  SDKAssistantMessageError,
  SDKAPIRetryMessage,
  SDKRateLimitEvent,
  SDKRateLimitInfo,
  SDKAuthStatusMessage,
  SDKThinkingTokensMessage,
  SDKModelRefusalFallbackMessage,
  SDKModelRefusalNoFallbackMessage,
  // Winter-only, disclosed as extensions (R6-8 / R6-C / R6-7).
  SDKReasoningSummaryMessage,
  SDKModelSwitchMessage,
  SDKContinuityWarningMessage,
} from "./protocol/frames.ts";

// Paths (Task 6, moved here Task 10 -- WS-05 §6): WINTER_HOME resolution, the exact CC-compatible
// project-key algorithm, and the git-aware compatibility-key triple. dialect.ts/temp.ts/
// project-dir-name.ts stay runtime-private; the runtime imports resolveWinterHome/
// compatibilityKeys/isUnset back from here (packages/runtime/src/index.ts re-exports them
// unchanged for its own existing consumers).
export { resolveWinterHome, resolveKeychainServiceForProfile, isUnset } from "./paths/home.ts";
export { transcriptProjectKey } from "./paths/project-key.ts";
export { compatibilityKeys } from "./paths/keys.ts";
export type { CompatibilityKeys } from "./paths/keys.ts";

// The filesystem SessionStore (Task 7, moved here Task 10 -- WS-05 §6: the store is
// public-adjacent, published-package code, not engine logic -- WS-14 needs it from this package
// for the official branch's own `sessionStore` option). Pinned WS-03 §10 SessionStore/SessionKey/
// SessionStoreEntry/SessionSummaryEntry type family plus the concrete filesystem-backed store and
// its typed errors (leases.ts).
export {
  WinterCompatibilitySessionStore,
  WinterStoreError,
  WinterStoreLeaseError,
  DIALECT_RECORD_ENTRY_TYPE,
  // P6 R6-7: the provider-state sidecar's filename suffix. Declared with the store because the
  // store's own `delete()` must name the file to remove it; the runtime re-exports it so the read
  // deny, the path builder and the deletion transaction cannot drift.
  PROVIDER_STATE_FILE_SUFFIX,
} from "./store/session-store.ts";
export type { SessionKey, SessionStoreEntry, SessionSummaryEntry, SessionStore } from "./store/session-store.ts";

// Task 10: the store-level fork primitive (WS-05 §7's forkSession-on-resume half) relocated
// alongside the store. Named forkSessionByKey here to avoid colliding with the public
// `forkSession(sessionId, opts)` standalone function below, which wraps it after resolving a bare
// sessionId; the runtime's dialect.ts imports this directly for its own resume orchestration.
export { forkSessionByKey } from "./store/fork-session.ts";

// Task 10 (WS-03 §3.1): the standalone session-management API.
export {
  listSessions,
  getSessionInfo,
  getSessionMessages,
  renameSession,
  tagSession,
  deleteSession,
  forkSession,
  listSubagents,
  getSubagentMessages,
} from "./sessions.ts";

// --- Phase 5 Task 2 (R5-8 as amended; derived-shapes-p5.md item (a)): the settings surface --------
//
// `resolveSettings` and `filterEscalatingDefaultMode` are PINNED PUBLIC EXPORTS of the 0.3.250
// declaration (`sdk.d.ts:2809` / `694`), not Winter extensions -- Task 1's single biggest ruling
// amendment. They are exported here under their pinned names and pinned shapes (one options object;
// three result fields; per-TOP-LEVEL-key provenance). Everything else in this block is disclosed
// Winter-side detail over that surface: `resolveSettingsDetailed` (per-source raw values + load
// errors + the inline/`flag` tier + an explicit `winterHome`), `applyWorkspaceTrust` (RULING P5-A's
// per-tier permissive filter), and the two path/loader primitives a host or the runtime needs to
// locate a tier's file at all.
export {
  resolveSettings,
  filterEscalatingDefaultMode,
  resolveSettingsDetailed,
  applyWorkspaceTrust,
} from "./settings/resolve.ts";
export { settingsPathFor, loadSettingsFile } from "./settings/sources.ts";
// WS-13c §5: the custom-slot validator (Lane B fills the body; the runtime's wiring imports it from here).
export { validateModelSlots } from "./settings/model-slots.ts";
export type { ModelSlotsLookup, ModelSlotsValidation } from "./settings/model-slots.ts";
export type { SettingsPathOptions, LoadedSettingsFile } from "./settings/sources.ts";
export {
  SETTING_SOURCES,
  OVERLAY_NEVER_KEYS,
  ESCALATING_PERMISSION_MODES,
  PROJECT_PERMISSIVE_KEYS,
  // WS-13b R6b-7: the ONE narrowing of `Settings.providers`. Exported so a host that resolves
  // settings itself gets the same total reading production-wiring uses, rather than a second one.
  providerSettingsFrom,
} from "./settings/types.ts";
export type {
  SettingSource,
  ResolvedSettingSource,
  PolicySettingsOrigin,
  Settings,
  SettingsPermissionsBlock,
  SettingsHooksConfig,
  SettingsHookMatcherGroup,
  SettingsHookHandler,
  ProvenanceEntry,
  ResolvedSettings,
  ResolvedSettingsSourceEntry,
  ResolveSettingsOptions,
  DetailedResolvedSettings,
  DetailedSettingsSourceEntry,
  ResolveSettingsDetailedOptions,
} from "./settings/types.ts";
export type { WorkspaceTrustFilterOptions } from "./settings/resolve.ts";

// Task 3 (WS-07 §3.3/§4): permissions surface, pinned-types home. See permissions/types.ts's own
// header for the section boundaries later tasks (5, 8) extend.
export type { PermissionMode, PermissionBehavior, PermissionRuleValue } from "./permissions/types.ts";
// Task 5 (WS-07 §3.2/§3.3): PermissionUpdate/PermissionUpdateDestination (verbatim) + RuleSource
// (Winter-original) — packages/runtime/src/permissions/ruleset.ts imports all three from this
// barrel (WS-02 §3: the runtime imports sdk types, never the reverse; no deep subpath import exists
// — the sdk package's own package.json "exports" is closed to ".").
export type { PermissionUpdate, PermissionUpdateDestination, RuleSource } from "./permissions/types.ts";
// Task 8 (WS-07 §7.1/§7.2): canUseTool's verbatim callback/result contracts, plus Winter's own
// "permission" control-request wire payload shape (see permissions/types.ts's own Task 8 banners).
export type { CanUseTool, PermissionResult, PermissionDecisionClassification, PermissionRequestPayload } from "./permissions/types.ts";
// Task 9 (WS-08 §1/§2/§4/§6): the hooks pinned-types surface — HookEvent (31-member union, HookEventName
// alias) + HOOK_EVENTS (the runtime membership list the type is derived from), HookSource
// (Winter-original, mirrors RuleSource), the full HookInput/HookJSONOutput family, and the
// Options.hooks registration shapes (HookCallback/HookCallbackMatcher). The runtime's
// packages/runtime/src/hooks/* imports every one of these from this barrel (WS-02 §3: the runtime
// imports sdk types, never the reverse — no deep subpath import exists, matching every prior task's
// own precedent in this file).
export { HOOK_EVENTS } from "./permissions/types.ts";
export type {
  HookEvent,
  HookEventName,
  HookSource,
  HookPermissionDecision,
  BaseHookInput,
  PreToolUseHookInput,
  PostToolUseHookInput,
  PostToolUseFailureHookInput,
  UserPromptSubmitHookInput,
  StopHookInput,
  SessionStartHookInput,
  SessionEndHookInput,
  NotificationHookInput,
  PermissionRequestHookInput,
  PermissionDeniedHookInput,
  GenericHookInput,
  HookInput,
  AsyncHookJSONOutput,
  SyncHookJSONOutput,
  HookJSONOutput,
  PreToolUseHookSpecificOutput,
  PostToolUseHookSpecificOutput,
  PostToolUseFailureHookSpecificOutput,
  UserPromptSubmitHookSpecificOutput,
  StopHookSpecificOutput,
  SessionStartHookSpecificOutput,
  NotificationHookSpecificOutput,
  PermissionRequestHookSpecificOutput,
  PermissionDeniedHookSpecificOutput,
  GenericHookSpecificOutput,
  HookSpecificOutput,
  HookCallback,
  HookCallbackMatcher,
  HookInvocationPayload,
} from "./permissions/types.ts";
