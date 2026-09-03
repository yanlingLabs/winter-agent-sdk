import { describe, test, expect } from "bun:test";
import { createSessionReadState } from "../read-state.ts";
import { getRegisteredTool, type ToolExecutionContext } from "../registry.ts";
import { EXIT_PLAN_MODE_TOOL_NAME, exitPlanModeExecutor } from "./exit-plan-mode.ts";

function makeCtx(overrides?: { setPermissionMode?: ToolExecutionContext["session"]["setPermissionMode"] }): {
  ctx: ToolExecutionContext;
  calls: { setCwd: string[]; addBoundedRoot: string[]; setPermissionMode: string[] };
} {
  const calls = { setCwd: [] as string[], addBoundedRoot: [] as string[], setPermissionMode: [] as string[] };
  const ctx: ToolExecutionContext = {
    cwd: "/work",
    home: "/home/test",
    sessionId: "test-session",
    readState: createSessionReadState(),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: "/tmp/winter-test",
    sandboxSettings: {},
    session: {
      setCwd(p: string) {
        calls.setCwd.push(p);
      },
      addBoundedRoot(p: string) {
        calls.addBoundedRoot.push(p);
      },
      setPermissionMode(mode) {
        calls.setPermissionMode.push(mode);
        overrides?.setPermissionMode?.(mode);
      },
      getBoundedRoots: () => [],
    },
  };
  return { ctx, calls };
}

describe("ExitPlanMode (task-7 brief)", () => {
  test("module load installs a real executor over the WS-06 stub", () => {
    const registered = getRegisteredTool(EXIT_PLAN_MODE_TOOL_NAME);
    expect(registered?.executor).toBeDefined();
  });

  test("assumes approval already happened and flips the mode to default via the session seam", async () => {
    const { ctx, calls } = makeCtx();
    const result = await exitPlanModeExecutor.execute({}, ctx);
    expect(calls.setPermissionMode).toEqual(["default"]);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output);
    expect(parsed.previousMode).toBe("plan");
    expect(parsed.newMode).toBe("default");
  });

  test("echoes a `plan` field when the model supplied one via input", async () => {
    const { ctx } = makeCtx();
    const result = await exitPlanModeExecutor.execute({ plan: "1. Do the thing\n2. Ship it" }, ctx);
    const parsed = JSON.parse(result.output);
    expect(parsed.plan).toBe("1. Do the thing\n2. Ship it");
  });

  test("omits `plan` entirely when input carries none (never echoes an empty/undefined placeholder)", async () => {
    const { ctx } = makeCtx();
    const result = await exitPlanModeExecutor.execute({}, ctx);
    const parsed = JSON.parse(result.output);
    expect("plan" in parsed).toBe(false);
  });

  test("echoes `planFilePath` when supplied, omits it otherwise", async () => {
    const { ctx: ctx1 } = makeCtx();
    const withPath = await exitPlanModeExecutor.execute({ planFilePath: "/tmp/plan.md" }, ctx1);
    expect(JSON.parse(withPath.output).planFilePath).toBe("/tmp/plan.md");

    const { ctx: ctx2 } = makeCtx();
    const withoutPath = await exitPlanModeExecutor.execute({}, ctx2);
    expect("planFilePath" in JSON.parse(withoutPath.output)).toBe(false);
  });

  test("ignores the deprecated allowedPrompts field entirely (never echoed, never validated)", async () => {
    const { ctx } = makeCtx();
    const result = await exitPlanModeExecutor.execute({ allowedPrompts: [{ tool: "Bash", prompt: "anything" }] }, ctx);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.output).allowedPrompts).toBeUndefined();
  });

  test("tolerates non-object input (undefined/null/primitives/arrays) without throwing", async () => {
    for (const bad of [undefined, null, "not-an-object", 42, []]) {
      const { ctx } = makeCtx();
      await expect(exitPlanModeExecutor.execute(bad, ctx)).resolves.toBeDefined();
    }
  });

  test("never re-implements gating -- runs unconditionally regardless of input shape (the standing evaluator already approved this call)", async () => {
    const { ctx, calls } = makeCtx();
    await exitPlanModeExecutor.execute({ anything: "goes", extra: 1 }, ctx);
    expect(calls.setPermissionMode).toEqual(["default"]);
  });

  test("KNOWN FLAG: a setPermissionMode throw is caught and surfaces as a legible tool error, never an uncaught rejection", async () => {
    const { ctx } = makeCtx({
      setPermissionMode: () => {
        throw new Error("bypassPermissions requires allowDangerouslySkipPermissions: true");
      },
    });
    const result = await exitPlanModeExecutor.execute({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("ExitPlanMode failed to restore");
  });
});
