export type ProtocolVersion = `${number}.${number}`;

export interface InitFrame { type: "init"; protocolVersion: ProtocolVersion; sessionId: string; cwd: string;
  model: string; permissionMode: string; tools: string[]; [k: string]: unknown; }
export interface UserFrame { type: "user"; text: string; [k: string]: unknown; }
export interface DataFrame { type: "data"; message: SdkMessage; [k: string]: unknown; }
export interface ControlRequestFrame { type: "control_request"; requestId: string; subtype: string; payload: unknown; }
export interface ControlResponseFrame { type: "control_response"; requestId: string; ok: boolean;
  payload?: unknown; error?: { code: string; message: string }; }
export interface UnknownFrame { type: string; [k: string]: unknown; }
export type WinterFrame = InitFrame | UserFrame | DataFrame | ControlRequestFrame | ControlResponseFrame | UnknownFrame;

export type SdkMessage =
  | { type: "system"; subtype: "init"; session_id: string; cwd: string; model: string; permissionMode: string; tools: string[]; [k: string]: unknown }
  | { type: "assistant"; message: { content: Array<{ type: "text"; text: string } | { type: string; [k: string]: unknown }> }; [k: string]: unknown }
  | { type: "result"; subtype: "success" | "error_max_turns" | "error_during_execution" | "error_max_budget_usd" | "error_max_structured_output_retries" | string; is_error?: boolean; result?: string; [k: string]: unknown }
  | { type: string; [k: string]: unknown };
