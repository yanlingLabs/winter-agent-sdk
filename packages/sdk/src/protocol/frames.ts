// Phase 5 Task 2: `system/init.plugins`' own entry shape (`sdk.d.ts:4881-4889`), declared alongside
// every other wire-crossing P5 shape in protocol/config.ts.
import type { InitPluginInfo } from "./config.ts";

export type ProtocolVersion = `${number}.${number}`;
export const PROTOCOL_VERSION = "1.0" as const;

// Phase 4 Task 3 (WS-09 §2.1/§3, item (b) of derived-shapes-p4.md): a server's connection state,
// wire-mapped from the internal seven-state McpServerStateKind (mcp/state.ts) to the string this
// frame carries. T1's own Open Question 5 pins the one spelling that must NOT match its internal
// name verbatim: the internal kind `needsAuth` (camelCase) maps to the wire string `'needs-auth'`
// (hyphenated) -- the exact spelling the pinned official `McpServerStatus.status` enum uses for the
// identical concept (item (b): "'connected'|'failed'|'needs-auth'|'pending'|'disabled'", 5 members).
// Every other one of Winter's seven internal kinds (`pending`/`connected`/`cached`/`failed`/
// `disabled`/`unconfigured`) already spells identically either way; `cached`/`unconfigured` are
// Winter-only additions beyond the pinned 5-member enum, which this field's own bare-`string` type
// (never a closed literal union, matching item (b)'s own finding: "a BARE, UNTYPED string status,
// not the richer 5-member literal union") accommodates without contradiction.
export interface WireMcpServerStatus { name: string; status: string; }

export interface InitFrame { type: "init"; protocolVersion: ProtocolVersion; sessionId: string; cwd: string;
  model: string; permissionMode: string; tools: string[];
  // Phase 4 Task 3 (WS-09 §2.1's own consequence clause: "the next turn's system/init.tools
  // reflects the mutation" -- generalized here to the whole snapshot, mirrored onto the paired
  // system/init SdkMessage variant below by the SAME single computation, never two independent
  // ones). Absent whenever no MCP server state source is configured for this run (every
  // pre-existing session before this field existed) -- conditional presence, not an unconditional
  // `[]`, so every committed differential golden stays byte-identical by construction.
  mcp_servers?: WireMcpServerStatus[];
  [k: string]: unknown; }
export interface UserFrame { type: "user"; text: string; [k: string]: unknown; }
export interface DataFrame { type: "data"; message: SdkMessage; [k: string]: unknown; }
export interface ControlRequestFrame { type: "control_request"; requestId: string; subtype: string; payload: unknown; }
export interface ControlResponseFrame { type: "control_response"; requestId: string; ok: boolean;
  payload?: unknown; error?: { code: string; message: string }; }
export interface UnknownFrame { type: string; [k: string]: unknown; }
export type WinterFrame = InitFrame | UserFrame | DataFrame | ControlRequestFrame | ControlResponseFrame | UnknownFrame;

// Task 10 (WS-08 §9; derived-shapes-p2.md item (d), the frozen pin-time 0.3.250 declaration; Ruling
// P2-A): the public hook-lifecycle trio + PermissionDenied — Ruling-9 PUBLIC UNION GROWTH. Each is
// its own "system" subtype (not a widening of "init"'s own shape) so `Extract<SdkMessage,
// {type:"system"}>` on the query.ts side correctly discriminates all five by `subtype`, rather than
// silently mistyping a lifecycle message as carrying "init"'s own fields (cwd/model/tools/etc.).
//
// hook_started/hook_progress/hook_response carry ONLY the P2-A-pinned public field set — hook_id,
// hook_name, hook_event, session_id, uuid, plus the coarse `outcome` on hook_response — never
// toolUseID/requestId/fine-grained outcome/duration, which stay audit-stream-only (WS-08 §9 Amended
// text). `hook_name` is pinned non-optional in the real declaration; engine.ts falls back to ""
// for an unnamed hook rather than widening this type to optional (prompt-stage.ts's own toolUseID
// precedent). `hook_progress` is typed for completeness (the closed union WS-08 §9 describes) but
// has NO producer at P2 — an SDK-callback hook has no stdout/stderr streaming concept; only
// filesystem command-hooks (P5) would ever have "progress" to report.
export interface SDKHookStartedMessage {
  type: "system";
  subtype: "hook_started";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  session_id: string;
  uuid: string;
}
export interface SDKHookProgressMessage {
  type: "system";
  subtype: "hook_progress";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  stdout: string;
  stderr: string;
  output: string;
  session_id: string;
  uuid: string;
}
export interface SDKHookResponseMessage {
  type: "system";
  subtype: "hook_response";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  output: string;
  stdout: string;
  stderr: string;
  exit_code?: number;
  outcome: "success" | "error" | "cancelled";
  session_id: string;
  uuid: string;
}
// SDKPermissionDeniedMessage (derived-shapes item (d)): observational, fires on ANY-stage denial —
// UNCONDITIONAL, never gated by includeHookEvents (that doc-asserted item's own "Correction to this
// task's own brief framing" note: only the hook_started/hook_progress/hook_response trio is gated).
// `decision_reason_type`/`decision_reason` are Winter's own mapping of PermissionDecisionRecord's
// `mechanism`/`ruleRef` — the pinned declaration names the fields but not their exact semantics
// beyond "advisory/UI-facing" (that same item's own load-bearing finding: this message is
// best-effort, not authoritative — a future task's durable-approval reconciliation anchors on
// `result.permission_denials`, not on having observed every one of these).
export interface SDKPermissionDeniedMessage {
  type: "system";
  subtype: "permission_denied";
  tool_name: string;
  tool_use_id: string;
  agent_id?: string;
  decision_reason_type?: string;
  decision_reason?: string;
  message: string;
  uuid: string;
  session_id: string;
}

// Finding 3 (P2 fix-wave, IMPORTANT): the array-element shape carried on `SDKResultMessage.
// permission_denials` (derived-shapes-p2.md item (d), sdk.d.ts:4560-4564) — a DIFFERENT, SMALLER
// shape than `SDKPermissionDeniedMessage` above despite being cited from the same source line (see
// that type's own comment: the two must not be conflated, they overlap only on tool_name/
// tool_use_id). Pinned ALWAYS-PRESENT — never optional, on EITHER `SDKResultMessage` member
// (`SDKResultSuccess`/`SDKResultError`) — verified directly against the pinned 0.3.250 release's own
// declaration (ephemeral, checksum-verified read of the already-installed package for this fix
// wave's own capture check; see the fix-wave report). `tool_input` is the one field the stream
// message deliberately lacks.
export interface SDKPermissionDenial {
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
}

// Phase 3 Task 2 (WS-06 §3.5, Ruling-9 public union growth): the background-task message family +
// the local-command-output message — six CLOSED named SdkMessage variants, pinned by an ephemeral,
// checksum-verified read of the pinned @anthropic-ai/claude-agent-sdk@0.3.250 declaration (this
// task's own fetchAndVerifyUpstream pass; see task-2-report.md for the full derived-shapes writeup
// with citations). All six share the same envelope shape as the hook trio above (`type: "system"`, a
// literal `subtype`, always-present `uuid`/`session_id`) — sdk.d.ts:4399's own top-level `SDKMessage`
// union lists every one of them as its own direct member (never nested under another variant),
// confirming each is independently discriminable on `.subtype` exactly like the hook trio.
//
// DEVIATION (flagged per this task's own brief — "follow the declaration, flag it in your report"):
// the brief's own shape list names "ambient" as if it were a seventh sibling frame alongside
// task_started/task_notification/task_updated/task_progress/background_tasks_changed. The pinned
// declaration has no such type — no `subtype: 'ambient'` literal and no `SDKAmbientMessage` exist
// anywhere in any of the six .d.ts files. `ambient` is a plain `ambient?: boolean` FIELD, present on
// exactly three shapes below (SDKTaskStartedMessage sdk.d.ts:4990, SDKTaskNotificationMessage
// sdk.d.ts:4932, and each element of SDKBackgroundTasksChangedMessage.tasks sdk.d.ts:3186) — absent
// from SDKTaskUpdatedMessage's patch and from SDKTaskProgressMessage entirely. This file therefore
// ships SIX named variants below, not seven; "ambient" is threaded through as a field, never a variant.
//
// NEAR-MISS (recorded so a future reader never conflates the two — same class as this file's own
// SDKPermissionDenial/SDKPermissionDeniedMessage note above): SDKBackgroundTasksChangedMessage's
// `tasks` array element (sdk.d.ts:3179-3187: task_id/task_type/description/ambient?) is a DIFFERENT,
// narrower shape than the pinned standalone `BackgroundTaskSummary` type (sdk.d.ts:134-159:
// id/type/status/description/command?/agent_type?/server?/...) that WS-08's own Stop/SubagentStop
// hook-input tables cite (derived-shapes-p2.md item (b)). Different field names for the id/type pair
// (`task_id`/`task_type` vs `id`/`type`), no `status`/`command`/`agent_type` on this narrower shape —
// the two must never be conflated despite both describing "a background task."
//
// `uuid`'s pinned type is `import type { UUID } from 'crypto'` (sdk.d.ts:11 — Node's own template-
// literal string type), matching the hook trio's own established `uuid: string` precedent above
// (Task 10, P2) rather than re-litigating a new representation here.
export interface SDKTaskStartedMessage {
  type: "system";
  subtype: "task_started";
  task_id: string;
  tool_use_id?: string;
  description: string;
  subagent_type?: string;
  is_backgrounded?: boolean;
  spawn_depth?: number;
  task_type?: string;
  workflow_name?: string;
  prompt?: string;
  skip_transcript?: boolean;
  ambient?: boolean;
  uuid: string;
  session_id: string;
}

// sdk.d.ts:4915-4935.
export interface SDKTaskNotificationMessage {
  type: "system";
  subtype: "task_notification";
  task_id: string;
  tool_use_id?: string;
  status: "completed" | "failed" | "stopped";
  output_file: string;
  summary: string;
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
  skip_transcript?: boolean;
  ambient?: boolean;
  uuid: string;
  session_id: string;
}

// sdk.d.ts:4995-5012. `patch` never carries `ambient` -- see this section's own DEVIATION note above.
export interface SDKTaskUpdatedMessage {
  type: "system";
  subtype: "task_updated";
  task_id: string;
  patch: {
    status?: "pending" | "running" | "completed" | "failed" | "killed" | "paused";
    description?: string;
    end_time?: number;
    total_paused_ms?: number;
    error?: string;
    is_backgrounded?: boolean;
  };
  uuid: string;
  session_id: string;
}

// sdk.d.ts:4937-4957. `usage` is REQUIRED here, unlike SDKTaskNotificationMessage's optional `usage?`
// above -- a real field-presence difference between the two shapes, not a typo.
export interface SDKTaskProgressMessage {
  type: "system";
  subtype: "task_progress";
  task_id: string;
  tool_use_id?: string;
  description: string;
  subagent_type?: string;
  usage: { total_tokens: number; tool_uses: number; duration_ms: number };
  last_tool_name?: string;
  summary?: string;
  uuid: string;
  session_id: string;
}

// sdk.d.ts:3173-3190. See this section's own NEAR-MISS note above: `tasks[]`'s element shape is NOT
// BackgroundTaskSummary.
export interface SDKBackgroundTasksChangedMessage {
  type: "system";
  subtype: "background_tasks_changed";
  tasks: Array<{ task_id: string; task_type: string; description: string; ambient?: boolean }>;
  uuid: string;
  session_id: string;
}

// sdk.d.ts:4349-4355. Unrelated to the other five in subject matter (local slash-command output
// display, not a background task) but pinned by this same task's brief alongside them -- grouped
// into the same closed ctx.emitFrame union below since nothing in WS-06 §3.5 or the pinned
// declaration restricts emitFrame to task-shaped messages specifically.
export interface SDKLocalCommandOutputMessage {
  type: "system";
  subtype: "local_command_output";
  content: string;
  uuid: string;
  session_id: string;
}

// The closed union ToolExecutionContext.emitFrame (packages/runtime/src/tools/registry.ts) accepts --
// narrowed from Task 1's placeholder `unknown` now that these six real shapes exist (see that file's
// own comment on the two fields this task narrows, and engine.ts's own emitFrame closure).
export type BackgroundTaskMessage =
  | SDKTaskStartedMessage
  | SDKTaskNotificationMessage
  | SDKTaskUpdatedMessage
  | SDKTaskProgressMessage
  | SDKBackgroundTasksChangedMessage
  | SDKLocalCommandOutputMessage;

// Phase 4 Task 3 (derived-shapes-p4.md item (b), sdk.d.ts:4836-4848): `compacting`/`requesting`
// lifecycle status, UNRELATED to MCP despite this task's own brief phrasing implying otherwise --
// T1's own DEVIATION note in item (b) already corrected that reading; recorded here so a future
// reader of this file sees the same correction at the type's own definition site. Closed
// three-member union incl. `null` (the pinned artifact's own "no status" resting value) --
// `compact_result`/`compact_error` are present only on a `'compacting'` status update, per the
// pinned declaration's own optionality (never enforced structurally here, matching this file's
// established "optional, producer decides which fields it actually sets" convention throughout).
export type SDKStatus = "compacting" | "requesting" | null;
export interface SDKStatusMessage {
  type: "system";
  subtype: "status";
  status: SDKStatus;
  permissionMode?: string;
  compact_result?: "success" | "failed";
  compact_error?: string;
  uuid: string;
  session_id: string;
}

// Phase 5 Task 3 (derived-shapes-p5.md item (f), `sdk.d.ts:3205-3238`): the compaction boundary.
// Six `compact_metadata` fields; `trigger`/`pre_tokens` required, the other four optional.
//
// `preserved_messages` SUPERSEDES `preserved_segment` (doc-marked on the pin): a reader looks each
// uuid up directly and relinks `uuids[i]` to `uuids[i-1]` (and `uuids[0]` to `anchor_uuid`) rather
// than walking the parentUuid chain. That is a RESUME-CORRECTNESS requirement, not a nicety -- a
// loader reading only `preserved_segment` silently loses the kept segment on any boundary written
// with the newer field. Winter writes `preserved_messages` and store/resume.ts reads it; the older
// `preserved_segment` is typed for inbound compatibility and never produced.
//
// Both are unset when compaction summarizes everything, i.e. when nothing is kept.
export interface SDKCompactBoundaryMessage {
  type: "system";
  subtype: "compact_boundary";
  compact_metadata: {
    trigger: "manual" | "auto";
    pre_tokens: number;
    post_tokens?: number;
    duration_ms?: number;
    preserved_segment?: { head_uuid: string; anchor_uuid: string; tail_uuid: string };
    preserved_messages?: { anchor_uuid: string; uuids: string[] };
  };
  uuid: string;
  session_id: string;
}

// --- Phase 6 Task 3 (R6-D): the wire content-block and stream-event vocabularies -------------------
//
// WINTER-DECLARED, deliberately, and this is the phase's own headline finding acted on rather than
// worked around. The pinned artifact declares NO wire content-block or stream-event shape at all:
// every one is a type import from a floating `@anthropic-ai/sdk >= 0.93.0` peer (derived-shapes-p6.md's
// headline finding). Re-exporting a floating peer's types would inherit its drift into a package whose
// whole value is being dependency-free and fence-resident, so these shapes are declared here from
// capture (F)'s observed behaviour and the pin's own prose about its own tools.
//
// WHAT IS CAPTURED AND WHAT IS WINTER'S OWN, stated separately so a reader never mistakes one for the
// other:
//   - CAPTURED (capture (F)): the six `event.type` names, the four `delta.type` names, the three
//     `content_block.type` names seen on `content_block_start`, and that `ping` NEVER reaches a
//     consumer (the runtime filters it) -- which is why `ping` is not a member below.
//   - CAPTURED (item (f), from the pin's own prose about its own Read tool): `tool_result.content`
//     admits BLOCKS, not only a string.
//   - WINTER'S OWN: the payload FIELD names on each member. Capture (F) recorded the type names and
//     the frame's own key set, not each delta's payload keys. Winter is the producer of these frames,
//     so the fields below are what Winter's own emitter sets; every member also carries an index
//     signature, so a richer real payload round-trips through the codec untouched.
export type WireContentBlock =
  | { type: "text"; text: string; [k: string]: unknown }
  /** `signature` is a plain string that MAY be `""`: capture (F) shows the pinned runtime normalising a signatureless thinking block to exactly that and REPLAYING it. Optional would let a producer omit it and break the signature chain silently. */
  | { type: "thinking"; thinking: string; signature: string; [k: string]: unknown }
  /** `data` is OPAQUE provider state. It rides in-dialect (the dialect defines it) and NOWHERE else -- never a log, never an error message, never the advisor transcript (Global Constraints). */
  | { type: "redacted_thinking"; data: string; [k: string]: unknown }
  | { type: "tool_use"; id: string; name: string; input: unknown; [k: string]: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string | WireContentBlock[]; [k: string]: unknown }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string }; [k: string]: unknown };

export type WireStreamEventDelta =
  | { type: "text_delta"; text: string; [k: string]: unknown }
  /** `estimated_tokens` is the one delta payload field the pin names at all -- second-hand, in `SDKThinkingTokensMessage`'s own JSDoc (`sdk.d.ts:5015`) -- so it is optional here beside the text Winter's emitter sets. */
  | { type: "thinking_delta"; thinking: string; estimated_tokens?: number; [k: string]: unknown }
  | { type: "signature_delta"; signature: string; [k: string]: unknown }
  | { type: "input_json_delta"; partial_json: string; [k: string]: unknown };

export type WireStreamEvent =
  | { type: "message_start"; message?: { id?: string; model?: string; role?: "assistant"; content?: WireContentBlock[]; [k: string]: unknown }; [k: string]: unknown }
  | { type: "content_block_start"; index: number; content_block: WireContentBlock; [k: string]: unknown }
  | { type: "content_block_delta"; index: number; delta: WireStreamEventDelta; [k: string]: unknown }
  | { type: "content_block_stop"; index: number; [k: string]: unknown }
  | { type: "message_delta"; delta: { stop_reason?: string | null; stop_sequence?: string | null; [k: string]: unknown }; usage?: { output_tokens?: number; [k: string]: unknown }; [k: string]: unknown }
  | { type: "message_stop"; [k: string]: unknown };

/**
 * Phase 6 Task 3 (derived-shapes-p6.md item (a), `sdk.d.ts:4544-4558`): the live-token-streaming frame.
 *
 * SIX FIELDS PLUS THE DISCRIMINANT, and two of them are easy to miss: `ttft_ms?` (`4553`) and
 * `user_message_uuid?` (`4557`). `parent_tool_use_id` is `string | null` and NOT optional -- a
 * main-thread frame emits the key explicitly with `null`, matching `SDKAssistantMessage`'s own
 * convention.
 *
 * GATED on `includePartialMessages` (`1712-1716`), and ADDITIVE: the pin's own JSDoc (`4542`) says
 * the complete `assistant` message still follows as its own message, which is what lets a host ignore
 * `stream_event` entirely and still see every completed block. R6-G: auxiliary provider calls
 * (compaction summariser, classifier, advisor, countTokens) emit NONE of these -- capture (F) observed
 * the pinned runtime suppressing exactly that call's stream events -- and `ttft_ms` rides the FIRST
 * `stream_event` of each forwarded generation.
 */
export interface SDKPartialAssistantMessage {
  type: "stream_event";
  event: WireStreamEvent;
  parent_tool_use_id: string | null;
  uuid: string;
  session_id: string;
  ttft_ms?: number;
  user_message_uuid?: string;
}

/**
 * The pinned provider-error taxonomy, `sdk.d.ts:3159` -- the closed 11-member union carried on
 * `api_retry.error`, `SDKAssistantMessage.error?` and `StopFailureHookInput.error`.
 *
 * These eleven buckets are all a Winter adapter has to map into for parity; anything finer is a
 * Winter extension to disclose (provider-runtime's `ProviderError.providerCode` is exactly that).
 * DECLARED HERE as well as in provider-runtime's `types.ts` on purpose: this package is
 * dependency-free and fence-resident and cannot import the Bun-only one, and the frame that carries
 * the union must declare what it carries.
 */
export type SDKAssistantMessageError =
  | "authentication_failed"
  | "oauth_org_not_allowed"
  | "account_on_hold"
  | "billing_error"
  | "rate_limit"
  | "overloaded"
  | "invalid_request"
  | "model_not_found"
  | "server_error"
  | "unknown"
  | "max_output_tokens";

/**
 * `sdk.d.ts:3085-3095` (JSDoc `3083`). Nine keys, ALL REQUIRED -- none optional.
 *
 * `error_status: number | null`: the null case is a connection error (e.g. a timeout) that had no
 * HTTP response, which is why provider-runtime's `ProviderError.status` is ABSENT rather than `null`
 * for that case and this frame's producer maps absence to `null` at the boundary.
 *
 * R6-6/R6-C: one frame per retry attempt, announced BEFORE the delay is taken; `max_retries` is 10
 * (capture (G) pinned it on every frame of all three runs).
 */
export interface SDKAPIRetryMessage {
  type: "system";
  subtype: "api_retry";
  attempt: number;
  max_retries: number;
  retry_delay_ms: number;
  error_status: number | null;
  error: SDKAssistantMessageError;
  uuid: string;
  session_id: string;
}

/**
 * `sdk.d.ts:4651-4669`. Every field except `status` is optional, and the vocabulary is
 * consumer-SUBSCRIPTION-shaped throughout -- which is the whole point of R6-B.
 */
export interface SDKRateLimitInfo {
  status: "allowed" | "allowed_warning" | "rejected";
  rateLimitType?: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "seven_day_overage_included" | "overage";
  resetsAt?: number;
  utilization?: number;
  [k: string]: unknown;
}

/**
 * `sdk.d.ts:4638-4646`. A TOP-LEVEL `type`, not a `system` subtype -- unlike `api_retry`/`status`/
 * `thinking_tokens`/the refusal pair. `auth_status` and `tool_progress` share this convention.
 *
 * **R6-B: an HTTP 429 is NOT this frame.** Capture (G) proved the pinned runtime emits ZERO
 * `rate_limit_event` frames for a 429 carrying a full `anthropic-ratelimit-*` header set with a
 * `rejected` unified status; the pinned 429 path is `api_retry` with `error_status: 429` and
 * `error: "rate_limit"`. Winter emits this ONLY for subscription-shaped quota states (the codex-oauth
 * quota manager's limited/`resumeAt`), and header-derived limits never become frames at all.
 */
export interface SDKRateLimitEvent {
  type: "rate_limit_event";
  rate_limit_info: SDKRateLimitInfo;
  uuid: string;
  session_id: string;
}

/**
 * `sdk.d.ts:3161-3168`. Top-level `type`, four payload fields, and NO JSDoc at all on the pin.
 *
 * R6-F: this is a LOGIN-FLOW PROGRESS channel (codex-oauth login/refresh), never the
 * credential-failure frame -- a bad key is a provider error that lands on the result shape.
 * `isAuthenticating: boolean` + `output: string[]` is a running transcript of an interactive auth
 * attempt, which is what that shape reads as.
 */
export interface SDKAuthStatusMessage {
  type: "auth_status";
  isAuthenticating: boolean;
  output: string[];
  error?: string;
  uuid: string;
  session_id: string;
}

/**
 * `sdk.d.ts:5017-5024` (JSDoc `5015`). NOT gated on `includePartialMessages`: a host that never opts
 * into `stream_event` still gets thinking progress. `estimated_tokens` is the running total for the
 * CURRENT thinking block and `estimated_tokens_delta` this frame's increment; both are approximate
 * progress for a spinner, explicitly not the billed `output_tokens`.
 */
export interface SDKThinkingTokensMessage {
  type: "system";
  subtype: "thinking_tokens";
  estimated_tokens: number;
  estimated_tokens_delta: number;
  uuid: string;
  session_id: string;
}

/**
 * `sdk.d.ts:4476-4508` (JSDoc `4474`). `trigger` is the literal `'refusal'` and NOTHING ELSE, and
 * the JSDoc scopes emission to "the primary model ends the stream with `stop_reason` 'refusal' and
 * the turn is retried once on a fallback model".
 *
 * **A MODEL-REFUSAL FALLBACK IS NOT AN OVERLOAD FALLBACK** (R6-C). Capture (G) confirmed the overload
 * swap is FRAME-INVISIBLE on the pin; Winter emits its own `system/model_switch` for that and this
 * pinned pair only on `stopReason: "refusal"`.
 *
 * `direction`'s `'revert'`/`'sticky'` are doc-marked as retained for consumer compat and no longer
 * emitted. `api_refusal_explanation` is doc-marked unstable human prose, display-only, NEVER to be
 * parsed -- a rule Winter carries verbatim.
 */
export interface SDKModelRefusalFallbackMessage {
  type: "system";
  subtype: "model_refusal_fallback";
  trigger: "refusal";
  direction: "retry" | "revert" | "sticky";
  scope?: "session" | "local";
  original_model: string;
  fallback_model: string;
  request_id: string | null;
  api_refusal_category?: string | null;
  api_refusal_explanation?: string | null;
  retracted_message_uuids?: string[];
  refused_user_message_uuid?: string | null;
  content: string;
  uuid: string;
  session_id: string;
}

/** `sdk.d.ts:4513-4523` (JSDoc `4511`): the refusal produced NO retry. Nine fields -- no `direction`/`scope`/`fallback_model`, because there is no fallback to name. */
export interface SDKModelRefusalNoFallbackMessage {
  type: "system";
  subtype: "model_refusal_no_fallback";
  trigger: "refusal";
  original_model: string;
  request_id: string | null;
  api_refusal_category?: string | null;
  api_refusal_explanation?: string | null;
  retracted_message_uuids?: string[];
  refused_user_message_uuid?: string | null;
  content: string;
  uuid: string;
  session_id: string;
}

// --- Winter-only continuity frames (R6-8 / R6-C / R6-7), disclosed as Winter extensions ------------
//
// None of these three exists on the pin. They are the observable half of rulings whose whole point is
// that the pinned surface has NOWHERE to put the information: a foreign reasoning summary must not be
// written into `assistant.message.content` (R6-8), an overload/manual model swap is frame-invisible on
// the pin (R6-C, capture (G)), and a degraded resume has no pinned channel at all (R6-7).

/**
 * R6-8: a foreign model's reasoning SUMMARY, surfaced live WITHOUT entering the transcript.
 *
 * Capture (F) settled why this frame has to exist: the pinned runtime never emits or replays a
 * thinking block without a `signature` key -- when the stream carries none it materialises `""` -- so
 * a foreign summary written into `assistant.message.content` as a `thinking` block would go on the
 * wire carrying an empty or fabricated signature. That is precisely the impersonation R6-8 forbids,
 * and the pin offers no mechanism to omit the field instead. The summary therefore lives in the
 * provider-state sidecar and rides this frame; Anthropic-family thinking/redacted blocks ride
 * in-dialect with their REAL signatures, exactly as before.
 */
export interface SDKReasoningSummaryMessage {
  type: "system";
  subtype: "reasoning_summary";
  text: string;
  provider: string;
  model: string;
  uuid: string;
  session_id: string;
}

/**
 * R6-C: the model this session is generating with CHANGED, and the pin has no frame that says so.
 *
 * `reason` distinguishes the three producers: `"fallback"` (the primary was abandoned per
 * `fallbackModel`), `"set_model"` (a host asked, applied at the quiescent boundary), and
 * `"interrupt"` (a pending switch applied immediately because the turn was interrupted). The swap is
 * additionally recorded in the dialect record's `providerHistory`, so a transcript reader can
 * reconstruct which model produced which entry after the fact.
 */
export interface SDKModelSwitchMessage {
  type: "system";
  subtype: "model_switch";
  reason: "fallback" | "set_model" | "interrupt";
  from_model: string;
  to_model: string;
  provider: string;
  uuid: string;
  session_id: string;
}

/**
 * R6-7: a resume found the provider-state chain incomplete, so some message was degraded.
 *
 * THE SIMPLEST OF THE TWO CHANNELS THE PLAN OFFERED, and the choice is recorded here rather than left
 * implicit: the alternative was a warning list threaded onto the history renderer's input, but the
 * renderer is Lane C's and the ledger pins `ContinuationChain` as the bare `Map` `buildContinuationChain`
 * returns -- a warning list would have had to ride a second, parallel return value through a frozen
 * signature. A frame reaches the host directly, needs no seam, and is where a user-visible degradation
 * belongs.
 *
 * `detail` is Winter-authored prose about COUNTS and IDENTITY only. It never names or contains opaque
 * provider state (Global Constraints).
 */
export interface SDKContinuityWarningMessage {
  type: "system";
  subtype: "continuity_warning";
  warning: "provider_state_missing" | "cross_domain_replay_dropped" | "sidecar_unreadable";
  detail: string;
  anchor_uuid?: string;
  uuid: string;
  session_id: string;
}

export type SdkMessage =
  // Phase 5 Task 2 (derived-shapes-p5.md item (b), `sdk.d.ts:4853-4913`): the LOADED-SURFACE fields.
  // `output_style` and `skills` are REQUIRED on the pin -- Task 1's own finding is that a Winter
  // init frame omitting them diverges -- so they are declared required here and emitted with Winter
  // defaults (`"default"`, `[]`), which is what makes the frame pinned-SHAPED before Task 8 has
  // registries to populate it FROM. `terminal_slash_commands` is optional on the pin and stays
  // absent: it is the subset of commands bound to a local terminal, and Winter has no such surface.
  //
  // This is the ONE change in this task that moves committed differential goldens -- see the
  // accompanying golden commit for the exact four keys.
  | {
      type: "system";
      subtype: "init";
      session_id: string;
      cwd: string;
      model: string;
      permissionMode: string;
      tools: string[];
      slash_commands: string[];
      terminal_slash_commands?: string[];
      output_style: string;
      skills: string[];
      plugins: InitPluginInfo[];
      mcp_servers?: WireMcpServerStatus[];
      [k: string]: unknown;
    }
  | SDKHookStartedMessage
  | SDKHookProgressMessage
  | SDKHookResponseMessage
  | SDKPermissionDeniedMessage
  | SDKStatusMessage
  | SDKCompactBoundaryMessage
  | BackgroundTaskMessage
  // Phase 6 Task 3: the provider-facing family. Listed BEFORE the open catch-all at the end of this
  // union so each stays independently discriminable on `type`/`subtype`.
  | SDKPartialAssistantMessage
  | SDKAPIRetryMessage
  | SDKRateLimitEvent
  | SDKAuthStatusMessage
  | SDKThinkingTokensMessage
  | SDKModelRefusalFallbackMessage
  | SDKModelRefusalNoFallbackMessage
  | SDKReasoningSummaryMessage
  | SDKModelSwitchMessage
  | SDKContinuityWarningMessage
  // Phase 4 Task 3 (WS-10 §4; derived-shapes-p4.md item (d)): `parent_tool_use_id` is the
  // message-stream child-progress correlator ("present on 6 variants of the... SDKMessage union" --
  // T1's own item (d) finding). Added here on the two variants THIS engine actually produces that
  // the correlation applies to (assistant text/tool_use, and the "user" role tool-result carrier --
  // engine.ts's own `{type:"data", message:{type:"user", message:{content: resultBlocks}}}` shape,
  // previously reachable only through the generic catch-all below). `agentID` is DELIBERATELY NOT
  // added to either shape: T1's own item (d) correction is explicit that `agentID` is a
  // FUNCTION-CALL-TIME permission correlator (CanUseTool's options object / the already-shipped
  // `SDKPermissionDeniedMessage.agent_id` above), never a message-stream field on any SDKMessage
  // variant in the pinned declaration -- conflating the two was the brief's own framing error,
  // corrected by the shape authority this task was told to follow.
  | { type: "assistant"; message: { content: Array<{ type: "text"; text: string } | { type: string; [k: string]: unknown }> }; parent_tool_use_id?: string | null; [k: string]: unknown }
  | { type: "user"; message: { role: "user"; content: Array<{ type: string; [k: string]: unknown }> }; parent_tool_use_id?: string | null; [k: string]: unknown }
  // Finding 3: `permission_denials` is ALWAYS present (pin-verified) — every result the engine
  // constructs carries it, `[]` when this turn denied nothing.
  // Phase 5 Task 3 (derived-shapes-p5.md item (d)): `structured_output` and `terminal_reason`.
  //
  // TWO SPELLINGS, TWO FIELDS, and they are not interchangeable -- an exhausted structured-output run
  // emits `subtype: "error_max_structured_output_retries"` AND
  // `terminal_reason: "structured_output_retry_exhausted"`, one on each field, confirmed on the wire
  // by capture (6). Emitting one spelling on both fields, or the terminal_reason spelling as the
  // subtype, is wrong in a way no type-checker catches -- which is why both literals are named here.
  //
  // `structured_output` is declared on the SUCCESS variant only (`sdk.d.ts:4751`): the exhaustion path
  // has no `structured_output` at all rather than a null one. Winter's result variant is a single
  // shape (it carries `is_error` rather than splitting success/error into two types), so that
  // constraint is a PRODUCER obligation the engine keeps, stated here at the declaration.
  //
  // Phase 6 Task 3 (R6-F, capture (I)): a PROVIDER failure that ends a turn does NOT get its own
  // result subtype. Capture (I) observed the pinned runtime landing an API failure on
  // `subtype: "success"` with `is_error: true`, `terminal_reason: "api_error"` and
  // `api_error_status: <status | null>` -- and `query()` ADDITIONALLY throwing a plain `Error` after
  // yielding that result. `SDKResultError`'s own four-member subtype union (`sdk.d.ts:4673`) contains
  // nothing provider-specific, which is why the success arm carries `is_error`/`api_error_status`
  // (`4728-4729`) at all. `api_error_status` is null-able for a connection error with no HTTP response.
  | {
      type: "result";
      subtype: "success" | "error_max_turns" | "error_during_execution" | "error_max_budget_usd" | "error_max_structured_output_retries" | string;
      is_error?: boolean;
      result?: string;
      structured_output?: unknown;
      terminal_reason?: "structured_output_retry_exhausted" | "api_error" | string;
      api_error_status?: number | null;
      permission_denials: SDKPermissionDenial[];
      [k: string]: unknown;
    }
  | { type: string; [k: string]: unknown };
