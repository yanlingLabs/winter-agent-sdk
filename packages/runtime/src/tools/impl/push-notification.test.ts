// push-notification.ts tests -- Phase 3, Lane D, Task 6. `import "./push-notification.ts"` triggers
// the module's own replaceExecutor("PushNotification", ...) side effect (registry.test.ts's "Fix
// round 1" precedent: never use "PushNotification" as a throwaway fixture name elsewhere). Never
// attempts a real OS-level notification anywhere in this file (task-6 brief, verbatim) -- every test
// either leaves the default no-op notifier in place or injects its own spy.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import "./push-notification.ts";
import { configurePushNotifier, resetPushNotifierForTest } from "./push-notification.ts";
import { getRegisteredTool, type ToolExecutionContext, type ToolResultPayload } from "../registry.ts";
import { createSessionReadState } from "../read-state.ts";

function makeCtx(): ToolExecutionContext {
  return {
    cwd: "/work",
    home: "/home/test",
    sessionId: "push-test-session",
    readState: createSessionReadState(),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: "/work/.tmp",
    sandboxSettings: {},
    session: { setCwd() {}, addBoundedRoot() {}, removeBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default", getSessionRoot: () => "/work", setSessionRoot() {} },
  };
}

async function run(input: unknown): Promise<ToolResultPayload> {
  const tool = getRegisteredTool("PushNotification");
  if (!tool?.executor) throw new Error("PushNotification executor is not registered");
  return tool.executor.execute(input, makeCtx());
}

beforeEach(() => {
  resetPushNotifierForTest();
});
afterEach(() => {
  resetPushNotifierForTest();
});

describe("PushNotification", () => {
  test("valid input: the pinned local-half result shape, exactly", async () => {
    const result = await run({ message: "build finished", status: "proactive" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output);
    expect(Object.keys(parsed).sort()).toEqual(["disabledReason", "localSent", "message", "pushSent", "sentAt"]);
    expect(parsed.message).toBe("build finished");
    expect(parsed.localSent).toBe(true);
    expect(parsed.pushSent).toBe(false);
    expect(parsed.disabledReason).toBe("winter transport unconfigured");
    expect(new Date(parsed.sentAt).toISOString()).toBe(parsed.sentAt);
  });

  test("the default notifier is a no-op and never throws", async () => {
    await expect(run({ message: "m", status: "proactive" })).resolves.toBeDefined();
  });

  test("an injected notifier spy receives the message", async () => {
    const calls: string[] = [];
    configurePushNotifier((message) => calls.push(message));
    await run({ message: "hello there", status: "proactive" });
    expect(calls).toEqual(["hello there"]);
  });

  test("a throwing injected notifier does not fail the tool call -- the pinned shape still comes back", async () => {
    configurePushNotifier(() => {
      throw new Error("simulated notifier failure");
    });
    const result = await run({ message: "m", status: "proactive" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.output).localSent).toBe(true);
  });

  test("resetPushNotifierForTest restores the no-op default", async () => {
    let called = false;
    configurePushNotifier(() => {
      called = true;
    });
    resetPushNotifierForTest();
    await run({ message: "m", status: "proactive" });
    expect(called).toBe(false);
  });

  test("accepts a message right at the 199-char boundary", async () => {
    const message = "a".repeat(199);
    const result = await run({ message, status: "proactive" });
    expect(result.isError).toBeUndefined();
  });

  test("rejects a message at 200 chars (the spec's own <200 bound)", async () => {
    const message = "a".repeat(200);
    const result = await run({ message, status: "proactive" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("200");
  });

  test("rejects an empty message", async () => {
    const result = await run({ message: "", status: "proactive" });
    expect(result.isError).toBe(true);
  });

  test("rejects a missing status", async () => {
    const result = await run({ message: "m" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("proactive");
  });

  test('rejects a status other than "proactive"', async () => {
    const result = await run({ message: "m", status: "normal" });
    expect(result.isError).toBe(true);
  });

  test("rejects a non-object input", async () => {
    const result = await run("nope");
    expect(result.isError).toBe(true);
  });
});
