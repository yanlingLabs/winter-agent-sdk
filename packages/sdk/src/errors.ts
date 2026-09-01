import type { SdkMessage } from "winter-agent-runtime";
export class WinterSDKError extends Error {}
export class CLIConnectionError extends WinterSDKError {}
export class ProcessError extends WinterSDKError {
  constructor(message: string, public code?: number | null, public signal?: string | null) { super(message); }
}
export class ResultError extends ProcessError {
  constructor(public result: Extract<SdkMessage, { type: "result" }>) { super(`result error: ${result.subtype}`); }
}
export class ProtocolDecodeError extends WinterSDKError {}
