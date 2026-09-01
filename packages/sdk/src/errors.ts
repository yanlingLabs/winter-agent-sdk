import type { SdkMessage } from "./protocol/frames.ts";

export class WinterSDKError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WinterSDKError";
  }
}
export class CLIConnectionError extends WinterSDKError {
  constructor(message: string) {
    super(message);
    this.name = "CLIConnectionError";
  }
}
export class ProcessError extends WinterSDKError {
  constructor(message: string, public code?: number | null, public signal?: string | null) {
    super(message);
    this.name = "ProcessError";
  }
}
export class ResultError extends ProcessError {
  constructor(public result: Extract<SdkMessage, { type: "result" }>) {
    super(`result error: ${result.subtype}`);
    this.name = "ResultError";
  }
}
export class ProtocolDecodeError extends WinterSDKError {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolDecodeError";
  }
}
