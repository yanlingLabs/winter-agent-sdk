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
  | {
      type: "result";
      subtype: "success" | "error_max_turns" | "error_during_execution" | "error_max_budget_usd" | "error_max_structured_output_retries" | string;
      is_error?: boolean;
      result?: string;
      structured_output?: unknown;
      terminal_reason?: "structured_output_retry_exhausted" | string;
      permission_denials: SDKPermissionDenial[];
      [k: string]: unknown;
    }
  | { type: string; [k: string]: unknown };
