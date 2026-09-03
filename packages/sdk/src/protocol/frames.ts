export type ProtocolVersion = `${number}.${number}`;
export const PROTOCOL_VERSION = "1.0" as const;

export interface InitFrame { type: "init"; protocolVersion: ProtocolVersion; sessionId: string; cwd: string;
  model: string; permissionMode: string; tools: string[]; [k: string]: unknown; }
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

export type SdkMessage =
  | { type: "system"; subtype: "init"; session_id: string; cwd: string; model: string; permissionMode: string; tools: string[]; [k: string]: unknown }
  | SDKHookStartedMessage
  | SDKHookProgressMessage
  | SDKHookResponseMessage
  | SDKPermissionDeniedMessage
  | BackgroundTaskMessage
  | { type: "assistant"; message: { content: Array<{ type: "text"; text: string } | { type: string; [k: string]: unknown }> }; [k: string]: unknown }
  // Finding 3: `permission_denials` is ALWAYS present (pin-verified) — every result the engine
  // constructs carries it, `[]` when this turn denied nothing.
  | { type: "result"; subtype: "success" | "error_max_turns" | "error_during_execution" | "error_max_budget_usd" | "error_max_structured_output_retries" | string; is_error?: boolean; result?: string; permission_denials: SDKPermissionDenial[]; [k: string]: unknown }
  | { type: string; [k: string]: unknown };
