import { describe, expect, test } from "bun:test";
import { assertRuntimeExecutionPosture, GuestExecutionUnavailableError, RUNTIME_EXECUTION_POSTURE_CAPABILITIES } from "./execution-posture.ts";
import { runEngine } from "../engine.ts";
import { runEmbeddedSession } from "../embedded.ts";

describe("mandatory guest posture", () => {
  test("default/local behavior is unchanged, unknown posture refuses", () => {
    expect(() => assertRuntimeExecutionPosture({})).not.toThrow();
    expect(() => assertRuntimeExecutionPosture({ executionPosture: "local" })).not.toThrow();
    expect(() => assertRuntimeExecutionPosture({ executionPosture: "other" })).toThrow("unknown runtime execution posture");
    expect(RUNTIME_EXECUTION_POSTURE_CAPABILITIES.supportsConfinedGuestExecution).toBe(false);
  });
  test("direct engine refuses before provider, input, output or bypass tool execution", async () => {
    const touched: string[] = [];
    await expect(runEngine({
      config: { sessionId: "guest", cwd: "/workspace/source", model: "winter-test/echo", executionPosture: "confined-guest", permissionMode: "bypassPermissions", sandbox: { enabled: false } },
      input: { async *[Symbol.asyncIterator]() { touched.push("input"); } },
      output: { write() { touched.push("output"); }, end() { touched.push("end"); } },
      provider: { async generate() { touched.push("provider"); return { kind: "text", text: "unsafe" }; } },
      tools: { async execute() { touched.push("tools"); return { output: "unsafe" }; } },
    })).rejects.toBeInstanceOf(GuestExecutionUnavailableError);
    expect(touched).toEqual([]);
  });
  test("production embedded entry refuses before resolving a nonexistent home or provider", async () => {
    const diagnostics: string[] = [];
    const frames: string[] = [];
    const exit = await runEmbeddedSession({
      argv: ["--run", "--config-json", JSON.stringify({ sessionId: "guest", cwd: "/no-such-source", model: "no-provider", executionPosture: "confined-guest", winterHome: "/no-such-protected-home" })],
      env: {}, input: { async *[Symbol.asyncIterator]() {} },
      write: (chunk) => frames.push(chunk), writeErr: (chunk) => diagnostics.push(chunk),
    });
    expect(exit).toBe(1);
    expect(frames).toEqual([]);
    expect(diagnostics.join("")).toContain("no local execution fallback");
  });
});
