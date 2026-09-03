import { describe, test, expect } from "bun:test";
import { createSessionReadState } from "../read-state.ts";
import { getRegisteredTool, type ToolExecutionContext } from "../registry.ts";
import { ENTER_PLAN_MODE_TOOL_NAME, enterPlanModeExecutor } from "./enter-plan-mode.ts";

// Spy-recording ToolExecutionContext builder shared in spirit with registry.test.ts's own `deps()`
// helper, adapted to the CONTEXT shape (not the registry-adapter DEPS shape) since these tests call
// `executor.execute(input, ctx)` directly rather than going through buildRegistryToolExecutor.
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
      getPermissionMode: () => "default",
      getSessionRoot: () => "/work",
      setSessionRoot() {},
    },
  };
  return { ctx, calls };
}

describe("EnterPlanMode (task-7 brief)", () => {
  test("module load installs a real executor over the WS-06 stub", () => {
    const registered = getRegisteredTool(ENTER_PLAN_MODE_TOOL_NAME);
    expect(registered?.executor).toBeDefined();
  });

  test("switches the session's permission mode to plan via the session seam, never engine.ts directly", async () => {
    const { ctx, calls } = makeCtx();
    const result = await enterPlanModeExecutor.execute({}, ctx);
    expect(calls.setPermissionMode).toEqual(["plan"]);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.output)).toEqual({ mode: "plan", message: "Permission mode switched to plan." });
  });

  test("ignores unknown/extra input fields (lenient by design -- schema is `{}`)", async () => {
    const { ctx, calls } = makeCtx();
    const result = await enterPlanModeExecutor.execute({ unexpected: true, another: 1 }, ctx);
    expect(calls.setPermissionMode).toEqual(["plan"]);
    expect(result.isError).toBeUndefined();
  });

  test("tolerates non-object input (undefined/null/primitives) without throwing", async () => {
    const { ctx: ctx1 } = makeCtx();
    await expect(enterPlanModeExecutor.execute(undefined, ctx1)).resolves.toBeDefined();
    const { ctx: ctx2 } = makeCtx();
    await expect(enterPlanModeExecutor.execute(null, ctx2)).resolves.toBeDefined();
    const { ctx: ctx3 } = makeCtx();
    await expect(enterPlanModeExecutor.execute("not-an-object", ctx3)).resolves.toBeDefined();
  });

  test("KNOWN FLAG: a setPermissionMode throw is caught and surfaces as a legible tool error, never an uncaught rejection", async () => {
    const { ctx } = makeCtx({
      setPermissionMode: () => {
        // Simulates the bypass-gate rejection path (policy-state.ts's WinterPermissionError) --
        // unreachable in practice for EnterPlanMode (it never requests bypassPermissions), but the
        // defensive wrap must still behave correctly if some future caller ever triggers it.
        throw new Error("bypassPermissions is disabled by managed configuration");
      },
    });
    const result = await enterPlanModeExecutor.execute({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("EnterPlanMode failed to switch");
    expect(result.output).toContain("bypassPermissions is disabled by managed configuration");
  });
});
