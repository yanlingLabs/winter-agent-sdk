// schedule-wakeup.ts tests -- Phase 3, Lane D, Task 6. `import "./schedule-wakeup.ts"` triggers the
// module's own replaceExecutor("ScheduleWakeup", ...) side effect (registry.test.ts's "Fix round 1"
// precedent: never use "ScheduleWakeup" as a throwaway fixture name elsewhere).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import "./schedule-wakeup.ts";
import { resetScheduleWakeupStoreForTest } from "./schedule-wakeup.ts";
import { getRegisteredTool, type ToolExecutionContext, type ToolResultPayload } from "../registry.ts";
import { createSessionReadState } from "../read-state.ts";

function makeCtx(sessionId: string): ToolExecutionContext {
  return {
    cwd: "/work",
    home: "/home/test",
    sessionId,
    readState: createSessionReadState(),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: "/work/.tmp",
    sandboxSettings: {},
    session: { setCwd() {}, addBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default", getSessionRoot: () => "/work", setSessionRoot() {} },
  };
}

async function run(input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  const tool = getRegisteredTool("ScheduleWakeup");
  if (!tool?.executor) throw new Error("ScheduleWakeup executor is not registered");
  return tool.executor.execute(input, ctx);
}

const SID = "wakeup-test-session";
const VALID = { delaySeconds: 120, reason: "check on the build", prompt: "check the build status", noop: false };

beforeEach(() => {
  resetScheduleWakeupStoreForTest();
});
afterEach(() => {
  resetScheduleWakeupStoreForTest();
});

describe("scheduling branch", () => {
  // T8 envelope-reconciliation fix: the pinned ScheduleWakeupOutput.scheduledFor is an epoch-ms
  // NUMBER ("Epoch ms timestamp when the next wakeup will fire"), not an ISO string -- confirmed via
  // ephemeral capture, derived-shapes-p3-task8.md.
  test("success shape has exactly scheduledFor/clampedDelaySeconds/wasClamped -- no stopped/cancelledWakeups", async () => {
    const before = Date.now();
    const result = await run(VALID, makeCtx(SID));
    const after = Date.now();
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output);
    expect(Object.keys(parsed).sort()).toEqual(["clampedDelaySeconds", "scheduledFor", "wasClamped"]);
    expect(parsed.clampedDelaySeconds).toBe(120);
    expect(parsed.wasClamped).toBe(false);
    expect(typeof parsed.scheduledFor).toBe("number");
    expect(parsed.scheduledFor).toBeGreaterThanOrEqual(before + 120 * 1000);
    expect(parsed.scheduledFor).toBeLessThanOrEqual(after + 120 * 1000);
  });

  test("clamps a delay below the 60s floor and reports wasClamped: true", async () => {
    const result = await run({ ...VALID, delaySeconds: 5 }, makeCtx(SID));
    const parsed = JSON.parse(result.output);
    expect(parsed.clampedDelaySeconds).toBe(60);
    expect(parsed.wasClamped).toBe(true);
  });

  test("clamps a delay above the 3600s ceiling and reports wasClamped: true", async () => {
    const result = await run({ ...VALID, delaySeconds: 999999 }, makeCtx(SID));
    const parsed = JSON.parse(result.output);
    expect(parsed.clampedDelaySeconds).toBe(3600);
    expect(parsed.wasClamped).toBe(true);
  });

  test("a delay already within bounds is NOT reported as clamped", async () => {
    const result = await run({ ...VALID, delaySeconds: 60 }, makeCtx(SID));
    expect(JSON.parse(result.output).wasClamped).toBe(false);
    const resultHigh = await run({ ...VALID, delaySeconds: 3600 }, makeCtx(SID));
    expect(JSON.parse(resultHigh.output).wasClamped).toBe(false);
  });

  test("noop: true is accepted (presence, not value, is what's required)", async () => {
    const result = await run({ ...VALID, noop: true }, makeCtx(SID));
    expect(result.isError).toBeUndefined();
  });

  test("rejects a missing delaySeconds", async () => {
    const { delaySeconds: _omit, ...rest } = VALID;
    const result = await run(rest, makeCtx(SID));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("delaySeconds");
  });

  test("rejects a missing reason", async () => {
    const { reason: _omit, ...rest } = VALID;
    const result = await run(rest, makeCtx(SID));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("reason");
  });

  test("rejects a missing prompt", async () => {
    const { prompt: _omit, ...rest } = VALID;
    const result = await run(rest, makeCtx(SID));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("prompt");
  });

  test("rejects a missing noop", async () => {
    const { noop: _omit, ...rest } = VALID;
    const result = await run(rest, makeCtx(SID));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("noop");
  });

  test("rejects a non-finite delaySeconds", async () => {
    const result = await run({ ...VALID, delaySeconds: Number.POSITIVE_INFINITY }, makeCtx(SID));
    expect(result.isError).toBe(true);
  });

  test("rejects a non-object input", async () => {
    const result = await run("nope", makeCtx(SID));
    expect(result.isError).toBe(true);
  });
});

describe("stop branch", () => {
  test("stop with no pending wakeups: stopped:true, cancelledWakeups:0", async () => {
    const result = await run({ stop: true }, makeCtx(SID));
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.output)).toEqual({ stopped: true, cancelledWakeups: 0 });
  });

  // T8 rider (Lane D review, "stop-short-circuit test-name mismatch"): the pre-existing body here
  // only ever omitted delaySeconds/reason/prompt/noop -- it never proved the title's actual claim
  // ("ignored entirely, EVEN IF [also] present"), the stronger and more interesting property. Fixed
  // to supply all four alongside `stop: true` and prove the result is still the STOP shape (never a
  // schedule shape, never an error) -- the short-circuit genuinely short-circuits, not merely
  // "happens to work when there's nothing to ignore."
  test("stop short-circuits: delaySeconds/reason/prompt/noop are ignored entirely, even when PRESENT alongside stop", async () => {
    const result = await run({ stop: true, delaySeconds: 60, reason: "should be ignored", prompt: "should be ignored", noop: true }, makeCtx(SID));
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.output)).toEqual({ stopped: true, cancelledWakeups: 0 });
  });

  test("stop result has exactly stopped/cancelledWakeups -- no scheduledFor/clampedDelaySeconds/wasClamped", async () => {
    const result = await run({ stop: true }, makeCtx(SID));
    expect(Object.keys(JSON.parse(result.output)).sort()).toEqual(["cancelledWakeups", "stopped"]);
  });

  test("stop cancels every pending wakeup scheduled by this session and reports the count", async () => {
    await run(VALID, makeCtx(SID));
    await run(VALID, makeCtx(SID));
    await run(VALID, makeCtx(SID));
    const result = await run({ stop: true }, makeCtx(SID));
    expect(JSON.parse(result.output)).toEqual({ stopped: true, cancelledWakeups: 3 });
  });

  test("stop is idempotent: a second consecutive stop reports zero cancelled", async () => {
    await run(VALID, makeCtx(SID));
    await run({ stop: true }, makeCtx(SID));
    const second = await run({ stop: true }, makeCtx(SID));
    expect(JSON.parse(second.output)).toEqual({ stopped: true, cancelledWakeups: 0 });
  });

  test("stop only cancels THIS session's own pending wakeups, never another session's", async () => {
    await run(VALID, makeCtx(SID));
    await run(VALID, makeCtx("other-session"));
    const result = await run({ stop: true }, makeCtx(SID));
    expect(JSON.parse(result.output)).toEqual({ stopped: true, cancelledWakeups: 1 });
    const otherStop = await run({ stop: true }, makeCtx("other-session"));
    expect(JSON.parse(otherStop.output)).toEqual({ stopped: true, cancelledWakeups: 1 });
  });

  test("rejects a non-boolean stop field", async () => {
    const result = await run({ stop: "yes" }, makeCtx(SID));
    expect(result.isError).toBe(true);
  });
});
