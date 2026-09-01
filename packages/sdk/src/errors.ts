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
// Task 10 (WS-03 §3.1, §11): the "session-not-found" taxonomy member for the standalone
// session-management API (packages/sdk/src/sessions.ts) — an unknown sessionId, or one that
// exists in more than one project when no `directory` was supplied to disambiguate. Shape mirrors
// resume.ts's ResumeTargetError (Task 9's identical ambiguity-refusal precedent: "not_found" for
// zero matches, "ambiguous" for more than one, never an arbitrary pick) rather than errors.ts's
// other, field-less classes, since that precedent is what this error's own semantics come from.
// The relocated store-level forkSession primitive (store/fork-session.ts) also throws this for its
// own source-not-found case, rather than ResumeTargetError, since it now lives in this package.
export class SessionNotFoundError extends WinterSDKError {
  readonly reason: "not_found" | "ambiguous";
  constructor(reason: "not_found" | "ambiguous", message: string) {
    super(message);
    this.name = "SessionNotFoundError";
    this.reason = reason;
  }
}
