import { expect, test } from "bun:test";
import { hostCodeExecutionLimitsFor, resolveBashTimeout, BASH_DEFAULT_TIMEOUT_MS, BASH_CEILING_TIMEOUT_MS, MONITOR_PERSISTENT_TIMEOUT_MS, DEFAULT_MAX_STREAMED_BYTES } from "./execution-limits.ts";
import { resolveTimeout } from "../tools/impl/bash.ts";
test("host contract uses the identical timeout function as the actual Bash executor", () => {
  expect(resolveTimeout).toBe(resolveBashTimeout);
  for (const value of [undefined, Infinity, -Infinity, NaN, -1, 0, 0.5, 20_000, 900_000]) {
    const input = value === undefined ? {} : { timeout: value };
    expect(hostCodeExecutionLimitsFor("Bash", input)).toEqual({ timeoutMs: resolveTimeout(value), maxStreamedBytes: DEFAULT_MAX_STREAMED_BYTES });
  }
  expect(resolveTimeout(Infinity)).toBe(BASH_DEFAULT_TIMEOUT_MS);
  expect(resolveTimeout(900_000)).toBe(BASH_CEILING_TIMEOUT_MS);
});
test("Monitor persistent and Workflow requests share their actual process limits", () => {
  expect(hostCodeExecutionLimitsFor("Monitor", { persistent: true })).toEqual({timeoutMs: MONITOR_PERSISTENT_TIMEOUT_MS, maxStreamedBytes: DEFAULT_MAX_STREAMED_BYTES});
  expect(hostCodeExecutionLimitsFor("Monitor", { timeout_ms: 1200.5 }).timeoutMs).toBe(1200.5);
  expect(hostCodeExecutionLimitsFor("Workflow", {}).timeoutMs).toBe(0);
  expect(() => hostCodeExecutionLimitsFor("Monitor", { timeout_ms: Infinity })).toThrow("not admitted");
  expect(() => hostCodeExecutionLimitsFor("unknown", {})).toThrow("unsupported");
});
