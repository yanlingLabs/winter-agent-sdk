import { test, expect } from "bun:test";
import {
  WinterSDKError,
  CLIConnectionError,
  ProcessError,
  ResultError,
  ProtocolDecodeError,
  AbortError,
  SessionNotFoundError,
  WinterRpcError,
  WinterRpcTimeoutError,
} from "./errors.ts";
import { ProtocolError } from "./protocol/codec.ts";

test("every error class carries its own name", () => {
  expect(new WinterSDKError("x").name).toBe("WinterSDKError");
  expect(new CLIConnectionError("x").name).toBe("CLIConnectionError");
  expect(new ProcessError("x").name).toBe("ProcessError");
  expect(new ResultError({ type: "result", subtype: "error_during_execution", is_error: true, permission_denials: [] }).name).toBe("ResultError");
  expect(new ProtocolDecodeError("x").name).toBe("ProtocolDecodeError");
  expect(new ProtocolError("x").name).toBe("ProtocolError");
  expect(new AbortError("x").name).toBe("AbortError");
  expect(new SessionNotFoundError("not_found", "x").name).toBe("SessionNotFoundError");
  expect(new WinterRpcError("denied", "x").name).toBe("WinterRpcError");
  expect(new WinterRpcTimeoutError("hook", 500).name).toBe("WinterRpcTimeoutError");
});

// Task 2 (WS-04 §3.1): the control-RPC bridge's typed errors — a bare code+message rejection, and
// the timeout specialization (only ever constructed when a caller opts into opts.timeoutMs).
test("WinterRpcError carries its code; WinterRpcTimeoutError IS a WinterRpcError with code 'timeout'", () => {
  const e = new WinterRpcError("denied", "nope");
  expect(e.code).toBe("denied");
  expect(e.message).toBe("nope");

  const t = new WinterRpcTimeoutError("hook", 500);
  expect(t).toBeInstanceOf(WinterRpcError);
  expect(t.code).toBe("timeout");
  expect(t.message).toContain("hook");
  expect(t.message).toContain("500");
});

// Task 10 (WS-03 §3.1 / T9's findResumeTarget precedent): the standalone session-management API's
// typed not-found/ambiguous error carries a `reason`, same shape as resume.ts's ResumeTargetError.
test("SessionNotFoundError carries its reason", () => {
  expect(new SessionNotFoundError("not_found", "x").reason).toBe("not_found");
  expect(new SessionNotFoundError("ambiguous", "x").reason).toBe("ambiguous");
});

test("WS-23 (M-1): an is_error result naming a terminal_reason throws `<terminal_reason>: <result>`, never `result error: success`", () => {
  const base = { type: "result" as const, subtype: "success", is_error: true, permission_denials: [] };
  expect(new ResultError({ ...base, terminal_reason: "refusal", result: "I can't help with that." }).message).toBe("refusal: I can't help with that.");
  expect(new ResultError({ ...base, terminal_reason: "prompt_too_long", result: "The conversation no longer fits." }).message).toBe("prompt_too_long: The conversation no longer fits.");
  expect(new ResultError({ ...base, terminal_reason: "pause_turn_limit", result: "still going" }).message).toBe("pause_turn_limit: still going");
  // The two pre-existing spellings are unchanged.
  expect(new ResultError({ ...base, terminal_reason: "api_error", result: "HTTP 529" }).message).toBe("provider request failed: HTTP 529");
  expect(new ResultError({ ...base, subtype: "error_during_execution" }).message).toBe("result error: error_during_execution");
});
