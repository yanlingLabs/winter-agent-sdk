// Task 3 (WS-07 §3.3): the sdk-side pinned-types home for the permissions surface. This file is
// TYPES ONLY (no runtime logic, no fs, no Bun globals) so it stays trivially Node-safe under the
// sdk-fence typecheck (tsconfig.sdk-fence.json) — the fence only matters for files that could
// reference a Bun-only API; a pure `.d.ts`-shaped module can never trip it, but the file still
// lives under packages/sdk/src so the same tsc pass covers it.
//
// SECTIONING: this file grows across three tasks — each section below is a hard boundary future
// tasks extend, never restructure:
//   Task 3  (this task) -- PermissionMode / PermissionBehavior / PermissionRuleValue (WS-07 §3.3
//           / §4, verbatim). Grammar-adjacent types the runtime's pure grammar.ts consumes.
//   Task 5  -- PermissionUpdate (the six-variant union) + PermissionUpdateDestination, verbatim
//           WS-07 §3.3.
//   Task 8  -- CanUseTool + PermissionResult + PermissionDecisionClassification, verbatim WS-07
//           §7.1/§7.2.
// Each addition is its own `// Task N (WS-07 §X):` banner immediately below this comment block —
// do not interleave unrelated fields into an earlier task's banner.

// --- Task 3 (WS-07 §4; derived-shapes-p2.md item (e), the frozen pin-time 0.3.250 declaration) ---
//
// Six-value public union, ARTIFACT ORDER preserved verbatim (derived-shapes-p2.md item (e) quotes
// the pinned declaration's own member order at sdk.d.ts:2234 — WS-07 §4's prose lists the same six
// members in a different order, which is irrelevant for a union type but this file follows the
// artifact's literal spelling+order per this task's shape-authority instruction). `"manual"` is
// deliberately NOT a member: derived-shapes item (e) shows it is a settings/CLI-layer alias that
// resolves to `"default"` before a typed PermissionMode value ever exists — never a seventh value
// here (WS-07 §4).
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";

// --- Task 3 (WS-07 §3.3, verbatim) ---
//
// `PermissionRuleValue.ruleContent` is the exact `Tool(specifier)` rule-content grammar this
// package's runtime-side `grammar.ts` (packages/runtime/src/permissions/grammar.ts — deliberately
// NOT in this sdk package; see that file's own header) parses via `parseRule`. `toolName` here is
// the SETTINGS-LEVEL field name and is NOT always identical to a parsed rule's own `toolName`: for
// an MCP rule the settings `toolName` IS the (possibly globbed) `mcp__server__tool` string with no
// separate `ruleContent` at all (WS-07 §3's MCP bullet) — `ruleContent` is only ever present for
// tools that use the parenthetical-specifier grammar.
export type PermissionBehavior = "allow" | "deny" | "ask";
export type PermissionRuleValue = { toolName: string; ruleContent?: string };

// --- Task 5 (WS-07 §3.3, verbatim) ---
//
// The six-variant PermissionUpdate union + its destination enum, quoted verbatim from WS-07 §3.3
// (itself citing report §28.3). `canUseTool` (Task 8) receives these as ready-made `suggestions`
// and may echo selected entries back as `updatedPermissions` — Winter's engine (Task 6) is the only
// intended PRODUCER of a `suggestions` array; this file only pins the shape. Every member's
// `destination` is a `PermissionUpdateDestination` — note there is no "managed" member: managed
// policy is never a live-update destination (it is provisioned wholesale, out of band, and re-fed
// into a `SourcedRuleSet` only as an INJECTED source per ruling 1 below) — this is load-bearing for
// packages/runtime/src/permissions/ruleset.ts's authority-validation design (see that file's own
// header for the consequence).
export type PermissionUpdate =
  | { type: "addRules"; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: "replaceRules"; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: "removeRules"; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: "setMode"; mode: PermissionMode; destination: PermissionUpdateDestination }
  | { type: "addDirectories"; directories: string[]; destination: PermissionUpdateDestination }
  | { type: "removeDirectories"; directories: string[]; destination: PermissionUpdateDestination };

export type PermissionUpdateDestination = "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg";

// --- Task 5 (WS-07 §3.2 — Winter-original; NOT part of the pinned upstream type surface) ---
//
// Models WS-07 §3.2's prose source list ("managed policy, SDK-managed settings, CLI arguments,
// user settings, project settings, local settings, session updates") as a discriminated string
// union. Deliberately kept in its own block, separate from the verbatim §3.3 shapes just above, so
// a future conformance sweep that treats this file as "everything here is a pinned upstream type"
// never mistakes a Winter-only modeling choice for a divergence from the artifact. Every
// `SourcedRuleSet` entry (packages/runtime/src/permissions/ruleset.ts) carries exactly one of
// these; `PermissionUpdateDestination` above maps onto the five of these it can reach live
// (userSettings->user, projectSettings->project, localSettings->local, session->session,
// cliArg->cliArg) — "managed" and "sdk" are only ever produced by injection (ruling 1: P2 rule
// sources are injected, source-tagged inputs; P5's file loader and Options.allowedTools/
// disallowedTools/permissions respectively feed those two), never by applying a live
// PermissionUpdate.
export type RuleSource = "managed" | "user" | "project" | "local" | "cliArg" | "session" | "sdk";

// --- Task 8 (WS-07 §7.1/§7.2, verbatim; derived-shapes-p2.md item (c) cross-checked field-for-field) ---
//
// `CanUseTool`'s `options` object matches the pinned 0.3.250 declaration EXACTLY: all 11 fields,
// identical names/types/optionality, including the nested `matchedAskRule` shape (derived-shapes
// item (c)'s own verdict: "MATCHES WS-07 §7.1's verbatim block exactly"). Note `matchedAskRule.source`
// is a bare `string` here — NOT `RuleSource` — matching the pinned declaration precisely; the
// runtime's own internal seam (evaluator.ts's PromptStageMeta) is free to be more specific
// (RuleSource narrows to string, so assigning a RuleSource value into this field is always valid).
export type CanUseTool = (
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

// The `null` escape (WS-07 §7.2): valid ONLY after the consumer already sent the matching control
// response out of band (query.__internal.respondPermission, sdk/src/query.ts) echoing `requestId` —
// the SDK then suppresses its own response write. An unaccompanied `null` fails closed (a pending
// permission RPC has no park timeout, WS-04 §3 — an accidental `null` could otherwise block the
// tool indefinitely) rather than hanging.
export type PermissionDecisionClassification = "user_temporary" | "user_permanent" | "user_reject";

export type PermissionResult =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[];
      toolUseID?: string;
      decisionClassification?: PermissionDecisionClassification;
    }
  | {
      behavior: "deny";
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
      decisionClassification?: PermissionDecisionClassification;
    };

// --- Task 8 (WS-04 §3's "permission" control-request row; Winter-owned WIRE shape — NOT part of
// the pinned upstream surface, unlike everything above this banner) ---
//
// The full canUseTool argument set, flattened into one JSON-safe control_request payload: every
// CanUseTool `options` field MINUS `signal` (a wrapper-local AbortSignal — never serializable; the
// wrapper mints its own per-request AbortController instead, see query.ts) PLUS `policyVersion`
// (Winter's own addition, WS-07 §2's stale-policy-rejection contract: a permission answer computed
// against a mode/rule snapshot that has since moved on must be discardable and re-evaluated under
// the current policy — every pending decision carries the version it was computed under).
export interface PermissionRequestPayload {
  toolName: string;
  input: Record<string, unknown>;
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
  policyVersion: number;
}

// --- Task 9 (WS-08 §1/§2/§4/§6; derived-shapes-p2.md items (a)/(b), the frozen pin-time 0.3.250
// declaration) ---
//
// SECTIONING NOTE (extends this file's own header): this file's opening banner says "TYPES ONLY (no
// runtime logic, no fs, no Bun globals)" for the sdk-fence typecheck's sake. `HOOK_EVENTS` below is a
// plain 31-string array literal — it generates real JS at import time, but touches no fs/Bun-only
// API, so it cannot trip that fence; it lives here (rather than as a runtime-package export) for the
// same reason PermissionMode/RuleSource live here: the type and its one authoritative runtime list
// must never drift apart, and deriving the type FROM the const (not hand-declaring both) is what
// makes that structurally impossible rather than merely documented.
//
// NAMING: the pinned declaration's own name is `HookEvent` (sdk.d.ts:868), not `HookEventName` — the
// naming-discipline rule at the top of this file ("Winter is not renaming these public-contract
// types") means the pinned name is exported verbatim; `HookEventName` (the name WS-08 §10 prose and
// this phase's task briefs use) is kept as an alias so both spellings resolve to the identical type.
export const HOOK_EVENTS = [
  // §1.1 shared/current major families (WS-08)
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PermissionRequest",
  "Notification",
  // §1.2 TypeScript-surface additional events (WS-08)
  "PostToolBatch",
  "UserPromptExpansion",
  "MessageDisplay",
  "StopFailure",
  "PostCompact",
  "PermissionDenied",
  "SessionStart",
  "SessionEnd",
  "Setup",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
  "Elicitation",
  "ElicitationResult",
  "ConfigChange",
  "InstructionsLoaded",
  "WorktreeCreate",
  "WorktreeRemove",
  "CwdChanged",
  "FileChanged",
  "DirectoryAdded",
] as const;
// Verdict (derived-shapes-p2.md item (b)): "the pinned HookEvent union / HOOK_EVENTS const (31
// members) match WS-08 §1.1 + §1.2's combined inventory exactly, 31/31" — this array is that
// 31-member list, spelled verbatim; a fixture (hooks/registry.test.ts) pins the count and every
// member name against WS-08 §1 directly, so a future spec/pin drift fails loudly here.
export type HookEvent = (typeof HOOK_EVENTS)[number];
export type HookEventName = HookEvent; // WS-08 §10 / task-brief spelling — identical type, see NAMING above.

// Winter-original (WS-08 §2's two-source-family table, narrowed the way RuleSource narrows WS-07
// §3.2's prose source list): no "cliArg"/"session" members — unlike permission rules, WS-08 has no
// canUseTool-style live "PermissionUpdate" analogue that lets a running session register a NEW hook
// (unauthorized ADDITIONAL sources, not modeled). "managed"/"user"/"project"/"local" are the
// filesystem-settings family (WS-08 §2's table, `.winter/hooks` / `~/.winter/hooks`, project-sourced
// entries trust-gated exactly like project rules per WS-07 §3.2 — ruling 1: absorbed by P5's
// settings loader, typed and inert until then); "sdk" is the `Options.hooks` family. Merge order
// (WS-08 §2, verbatim): managed -> user -> project -> local -> sdk, registration order within one
// source. ("project" before "local": WS-08 §2's own prose names them together as "project/local
// filesystem sources" without stating a sub-order; this file resolves the ambiguity by following
// RuleSource's own literal declaration order (project before local) for consistency with the
// sibling permission-rule precedent — a documented judgment call, not a spec-pinned fact — see
// hooks/registry.ts's own header for where this order is actually applied.)
export type HookSource = "managed" | "user" | "project" | "local" | "sdk";

// The shared input envelope every one of the 31 HookInput members carries beyond its own
// `hook_event_name` discriminant (derived-shapes item (b), `BaseHookInput`, verbatim field set).
export interface BaseHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  prompt_id?: string;
  permission_mode?: string; // type-level fact (item (b)): a bare string, NOT the PermissionMode union.
  agent_id?: string;
  agent_type?: string;
  effort?: { level: string };
}

// WS-08 §3's 4-value PreToolUse decision grammar, verbatim; also PermissionRequest's own decision
// vocabulary per WS-08 §6 prose (though derived-shapes item (b)'s PINNED PermissionRequest output
// shape below has no "defer" arm at all — see that type's own comment for this tension).
export type HookPermissionDecision = "allow" | "ask" | "deny" | "defer";

// --- Per-event HookInput members this phase's engine actually constructs/interprets (the 8 events
// T9 fires at P2 per its own task brief, plus PermissionRequest/PermissionDenied, typed now since
// derived-shapes item (b) pins their shape too, even though T10 is the one that fires them). Every
// OTHER event (21 of the 31) is typed but never constructed at P2 (WS-08 §1: "typed but inert") —
// GenericHookInput below covers them without hand-typing 21 payload shapes nothing produces yet. ---

export interface PreToolUseHookInput extends BaseHookInput {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
}
export interface PostToolUseHookInput extends BaseHookInput {
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: unknown;
  tool_response: unknown;
  tool_use_id: string;
  duration_ms?: number;
}
export interface PostToolUseFailureHookInput extends BaseHookInput {
  hook_event_name: "PostToolUseFailure";
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  error: string;
  is_interrupt?: boolean;
  duration_ms?: number;
}
export interface UserPromptSubmitHookInput extends BaseHookInput {
  hook_event_name: "UserPromptSubmit";
  prompt: string;
  source?: "user" | "sdk" | "system" | "loop_wakeup" | "schedule_wakeup" | "poll_event";
  session_title?: string;
}
export interface StopHookInput extends BaseHookInput {
  hook_event_name: "Stop";
  stop_hook_active: boolean;
  last_assistant_message?: unknown; // not independently pinned in this task's scope (derived-shapes item (b))
  background_tasks?: unknown[]; // BackgroundTaskSummary — shape not pinned in this task's scope
  session_crons?: unknown[]; // SessionCronSummary — shape not pinned in this task's scope
}
export interface SessionStartHookInput extends BaseHookInput {
  hook_event_name: "SessionStart";
  source: "startup" | "resume" | "clear" | "compact" | "fork";
  agent_type?: string;
  model?: string;
  session_title?: string;
}
export interface SessionEndHookInput extends BaseHookInput {
  hook_event_name: "SessionEnd";
  reason: string; // ExitReason — not independently pinned in this task's scope (derived-shapes item (b))
}
export interface NotificationHookInput extends BaseHookInput {
  hook_event_name: "Notification";
  message: string;
  title?: string;
  notification_type: string;
}
export interface PermissionRequestHookInput extends BaseHookInput {
  hook_event_name: "PermissionRequest";
  tool_name: string;
  tool_input: unknown;
  permission_suggestions?: PermissionUpdate[];
}
export interface PermissionDeniedHookInput extends BaseHookInput {
  hook_event_name: "PermissionDenied";
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  reason: string;
}
// Forward-compatible catch-all for the 21 HookEvent members not individually typed above — never
// constructed by this phase's engine (nothing fires them at P2), but a real value of this shape
// could still arrive over a future settings/config round-trip (WS-08 §1: unknown event names are
// "accepted, preserved, inert" — this is the typed-but-not-yet-interpreted sibling of that rule for
// KNOWN-but-unfired event names).
export interface GenericHookInput extends BaseHookInput {
  hook_event_name: string;
}
export type HookInput =
  | PreToolUseHookInput
  | PostToolUseHookInput
  | PostToolUseFailureHookInput
  | UserPromptSubmitHookInput
  | StopHookInput
  | SessionStartHookInput
  | SessionEndHookInput
  | NotificationHookInput
  | PermissionRequestHookInput
  | PermissionDeniedHookInput
  | GenericHookInput;

// --- HookJSONOutput — the callback's return value (derived-shapes item (b), verbatim envelope) ---

// A second, unmodeled async-signaling mechanism distinct from HookPermissionDecision's own "defer"
// value (derived-shapes item (b), Open Question 3) — Winter's P2 hook runner treats an
// async-signaling response as a "no decision yet" contribution (TODO: revisit once a task actually
// needs to wait up to `asyncTimeout`; see hooks/runner.ts's own header).
export interface AsyncHookJSONOutput {
  async: true;
  asyncTimeout?: number;
}

export interface PreToolUseHookSpecificOutput {
  hookEventName: "PreToolUse";
  permissionDecision?: HookPermissionDecision;
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
}
export interface PostToolUseHookSpecificOutput {
  hookEventName: "PostToolUse";
  additionalContext?: string;
  classifierContext?: string; // WS-07 §10.4 / WS-08 §5's auto-mode-classifier contribution channel.
  updatedToolOutput?: unknown;
  updatedMCPToolOutput?: unknown;
}
export interface PostToolUseFailureHookSpecificOutput {
  hookEventName: "PostToolUseFailure";
  additionalContext?: string;
}
export interface UserPromptSubmitHookSpecificOutput {
  hookEventName: "UserPromptSubmit";
  additionalContext?: string;
  sessionTitle?: string;
  suppressOriginalPrompt?: boolean;
}
export interface StopHookSpecificOutput {
  hookEventName: "Stop";
  additionalContext?: string;
}
export interface SessionStartHookSpecificOutput {
  hookEventName: "SessionStart";
  additionalContext?: string;
  initialUserMessage?: string;
  sessionTitle?: string;
  watchPaths?: string[];
  reloadSkills?: boolean;
}
export interface NotificationHookSpecificOutput {
  hookEventName: "Notification";
  additionalContext?: string;
}
// WS-08 §6, verbatim. NOTE (recorded, not resolved — out of scope for this task, which never fires
// PermissionRequest; flagged for T10): this PINNED shape has only "allow"/"deny" decision arms — no
// "defer" — even though WS-08 §7's prose says "Defer is valid for PreToolUse and PermissionRequest."
// derived-shapes-p2.md item (b) pins exactly this shape with no defer arm; T10 (the task that fires
// PermissionRequest) should reconcile this tension when it wires the real RPC.
export interface PermissionRequestHookSpecificOutput {
  hookEventName: "PermissionRequest";
  decision:
    | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
    | { behavior: "deny"; message?: string; interrupt?: boolean };
}
export interface PermissionDeniedHookSpecificOutput {
  hookEventName: "PermissionDenied";
  retry?: boolean;
}
// Forward-compatible catch-all mirroring GenericHookInput's own posture — covers the 20-9=11 pinned
// XHookSpecificOutput members not individually typed above (this task types the 9 tied to the
// events it actually fires or that T10 fires next) plus any future addition.
export interface GenericHookSpecificOutput {
  hookEventName: string;
  additionalContext?: string;
  [key: string]: unknown;
}
export type HookSpecificOutput =
  | PreToolUseHookSpecificOutput
  | PostToolUseHookSpecificOutput
  | PostToolUseFailureHookSpecificOutput
  | UserPromptSubmitHookSpecificOutput
  | StopHookSpecificOutput
  | SessionStartHookSpecificOutput
  | NotificationHookSpecificOutput
  | PermissionRequestHookSpecificOutput
  | PermissionDeniedHookSpecificOutput
  | GenericHookSpecificOutput;

// The generic envelope every synchronous hook response carries (derived-shapes item (b),
// `SyncHookJSONOutput`, verbatim field set) — `hookSpecificOutput` is this phase's own
// `HookSpecificOutput` union above, not the pinned declaration's inline 20-member union (which this
// task does not reproduce in full; see that type's own comment).
export interface SyncHookJSONOutput {
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: "approve" | "block";
  systemMessage?: string;
  terminalSequence?: string;
  reason?: string;
  hookSpecificOutput?: HookSpecificOutput;
}
export type HookJSONOutput = AsyncHookJSONOutput | SyncHookJSONOutput;

// --- Options.hooks — the SDK-callback registration shape (derived-shapes item (a), verbatim) ---

export type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<HookJSONOutput>;

export interface HookCallbackMatcher {
  matcher?: string; // tool-identity matcher (WS-08 §2.1 grammar); absent = matches every occurrence.
  hooks: HookCallback[];
  timeout?: number; // doc-asserted (item (a)/(f)): UNIT IS SECONDS, scope is every hook in this matcher.
}
