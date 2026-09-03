import { describe, test, expect } from "bun:test";
import type { PermissionMode } from "@yanlinglabs/winter-agent-sdk";
import { createSessionReadState } from "../read-state.ts";
import { getRegisteredTool, type ToolExecutionContext } from "../registry.ts";
import { EXIT_PLAN_MODE_TOOL_NAME, exitPlanModeExecutor } from "./exit-plan-mode.ts";

// RULING P3-H: `getPermissionMode` now reads LIVE state -- `liveMode` mirrors engine.ts's own real
// PolicyStateStore, mutated by the SAME `setPermissionMode` call the getter reflects, never a
// separate snapshot. `initialMode` defaults to "plan" (every pre-existing test in this file assumes
// the call arrives while still genuinely in plan mode, matching EnterPlanMode having just run); a
// test proving the OTHER branch (mode already moved before this executor runs) overrides it.
function makeCtx(overrides?: { initialMode?: PermissionMode; setPermissionMode?: ToolExecutionContext["session"]["setPermissionMode"] }): {
  ctx: ToolExecutionContext;
  calls: { setCwd: string[]; addBoundedRoot: string[]; setPermissionMode: string[] };
} {
  const calls = { setCwd: [] as string[], addBoundedRoot: [] as string[], setPermissionMode: [] as string[] };
  let liveMode: PermissionMode = overrides?.initialMode ?? "plan";
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
        // A throwing override (the "KNOWN FLAG" bypass-gate-rejection fixture below) mirrors the
        // real gate: it fires BEFORE any state actually changes, so `calls`/`liveMode` stay
        // untouched on rejection, exactly like the real PolicyStateStore#setMode.
        overrides?.setPermissionMode?.(mode);
        calls.setPermissionMode.push(mode);
        liveMode = mode;
      },
      getBoundedRoots: () => [],
      getPermissionMode: () => liveMode,
      getSessionRoot: () => "/work",
      setSessionRoot() {},
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

  describe("RULING P3-H: reads the live mode via the getter instead of hardcoding 'plan'", () => {
    test("still in plan (the ordinary case): flips to default and reports previousMode:'plan' from the getter, not a hardcoded literal", async () => {
      const { ctx, calls } = makeCtx({ initialMode: "plan" });
      const result = await exitPlanModeExecutor.execute({}, ctx);
      expect(calls.setPermissionMode).toEqual(["default"]);
      const parsed = JSON.parse(result.output);
      expect(parsed.previousMode).toBe("plan");
      expect(parsed.newMode).toBe("default");
    });

    test("mode already moved by a canUseTool/hook updatedPermissions suggestion BEFORE this executor ran: does NOT clobber it back to default, and reports the ACTUAL observed mode as previousMode", async () => {
      const { ctx, calls } = makeCtx({ initialMode: "acceptEdits" });
      const result = await exitPlanModeExecutor.execute({}, ctx);
      // The whole point of the ruling: setPermissionMode must NEVER be called when the live mode is
      // already something other than "plan" -- calling it with "default" here would be the exact
      // clobber the reviewer's finding named.
      expect(calls.setPermissionMode).toEqual([]);
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.output);
      expect(parsed.previousMode).toBe("acceptEdits");
      expect(parsed.newMode).toBe("acceptEdits");
      expect(parsed.message).toContain("acceptEdits");
    });

    test("mode already moved to 'auto': same non-clobbering behavior, proving this isn't special-cased to just one alternate mode", async () => {
      const { ctx, calls } = makeCtx({ initialMode: "auto" });
      const result = await exitPlanModeExecutor.execute({}, ctx);
      expect(calls.setPermissionMode).toEqual([]);
      const parsed = JSON.parse(result.output);
      expect(parsed.previousMode).toBe("auto");
      expect(parsed.newMode).toBe("auto");
    });

    test("the KNOWN-FLAG bypass-gate throw is genuinely unreachable when the mode already moved away from plan -- setPermissionMode is never even called, so a throwing override never fires", async () => {
      const { ctx } = makeCtx({
        initialMode: "acceptEdits",
        setPermissionMode: () => {
          throw new Error("should never be called");
        },
      });
      const result = await exitPlanModeExecutor.execute({}, ctx);
      expect(result.isError).toBeUndefined();
    });
  });
});
