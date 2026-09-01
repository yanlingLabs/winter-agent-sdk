import { test, expect } from "bun:test";
import { WinterSDKError, CLIConnectionError, ProcessError, ResultError, ProtocolDecodeError, AbortError, SessionNotFoundError } from "./errors.ts";
import { ProtocolError } from "./protocol/codec.ts";

test("every error class carries its own name", () => {
  expect(new WinterSDKError("x").name).toBe("WinterSDKError");
  expect(new CLIConnectionError("x").name).toBe("CLIConnectionError");
  expect(new ProcessError("x").name).toBe("ProcessError");
  expect(new ResultError({ type: "result", subtype: "error_during_execution", is_error: true }).name).toBe("ResultError");
  expect(new ProtocolDecodeError("x").name).toBe("ProtocolDecodeError");
  expect(new ProtocolError("x").name).toBe("ProtocolError");
  expect(new AbortError("x").name).toBe("AbortError");
  expect(new SessionNotFoundError("not_found", "x").name).toBe("SessionNotFoundError");
});

// Task 10 (WS-03 §3.1 / T9's findResumeTarget precedent): the standalone session-management API's
// typed not-found/ambiguous error carries a `reason`, same shape as resume.ts's ResumeTargetError.
test("SessionNotFoundError carries its reason", () => {
  expect(new SessionNotFoundError("not_found", "x").reason).toBe("not_found");
  expect(new SessionNotFoundError("ambiguous", "x").reason).toBe("ambiguous");
});
