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
// Pinned class per the 0.3.250 exports.json inventory (kind: class) — the cancellation/interrupt
// taxonomy member of WS-03 §11. Shape/inheritance beyond the name is unverified against the real
// upstream declaration (fetching it was ruled out of this task's scope); reconciling the full
// hierarchy against exports.json is parked for a dedicated WS-03 §11 snapshot-mirror pass
// (plan Task 1 self-review carry note) — this is the in-scope baseline that note presupposes.
export class AbortError extends WinterSDKError {
  constructor(message: string) {
    super(message);
    this.name = "AbortError";
  }
}
