import { test, expect } from "bun:test";
import { WinterSDKError, CLIConnectionError, ProcessError, ResultError, ProtocolDecodeError, AbortError } from "./errors.ts";
import { ProtocolError } from "./protocol/codec.ts";

test("every error class carries its own name", () => {
  expect(new WinterSDKError("x").name).toBe("WinterSDKError");
  expect(new CLIConnectionError("x").name).toBe("CLIConnectionError");
  expect(new ProcessError("x").name).toBe("ProcessError");
  expect(new ResultError({ type: "result", subtype: "error_during_execution", is_error: true }).name).toBe("ResultError");
  expect(new ProtocolDecodeError("x").name).toBe("ProtocolDecodeError");
  expect(new ProtocolError("x").name).toBe("ProtocolError");
  expect(new AbortError("x").name).toBe("AbortError");
});
