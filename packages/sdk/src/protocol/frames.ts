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

export type SdkMessage =
  | { type: "system"; subtype: "init"; session_id: string; cwd: string; model: string; permissionMode: string; tools: string[]; [k: string]: unknown }
  | SDKHookStartedMessage
  | SDKHookProgressMessage
  | SDKHookResponseMessage
  | SDKPermissionDeniedMessage
  | { type: "assistant"; message: { content: Array<{ type: "text"; text: string } | { type: string; [k: string]: unknown }> }; [k: string]: unknown }
  // Finding 3: `permission_denials` is ALWAYS present (pin-verified) — every result the engine
  // constructs carries it, `[]` when this turn denied nothing.
  | { type: "result"; subtype: "success" | "error_max_turns" | "error_during_execution" | "error_max_budget_usd" | "error_max_structured_output_retries" | string; is_error?: boolean; result?: string; permission_denials: SDKPermissionDenial[]; [k: string]: unknown }
  | { type: string; [k: string]: unknown };
