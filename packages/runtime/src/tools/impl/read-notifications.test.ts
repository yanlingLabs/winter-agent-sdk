import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createSessionReadState } from "../read-state.ts";
import { getRegisteredTool, type ToolExecutionContext } from "../registry.ts";
import { READ_NOTIFICATIONS_TOOL_NAME, readNotificationsExecutor } from "./read-notifications.ts";
import { registerMessagingRuntime, resetMessagingRuntimeForTest } from "../../messaging/router.ts";
import { createDefaultMessagingRuntime } from "../../messaging/reference-adapter.ts";

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    cwd: "/work",
    home: "/home/test",
    sessionId: "test-session",
    readState: createSessionReadState(),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: "/tmp/winter-test",
    sandboxSettings: {},
    session: { setCwd() {}, addBoundedRoot() {}, removeBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default", getSessionRoot: () => "/work", setSessionRoot() {} },
    ...overrides,
  };
}

beforeEach(() => resetMessagingRuntimeForTest());
afterEach(() => resetMessagingRuntimeForTest());

describe("ReadNotifications (Task 7, WS-06 §3.6 / WS-10 §14)", () => {
  test("module load installs a real executor over the WS-06 stub", () => {
    const registered = getRegisteredTool(READ_NOTIFICATIONS_TOOL_NAME);
    expect(registered?.executor).toBeDefined();
  });

  test("no messaging runtime configured -> a legible host-configuration error, not a crash", async () => {
    const result = await readNotificationsExecutor.execute({}, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.output).toContain("messaging runtime");
  });

  test("an empty queue drains to {notifications: [], remaining: 0}", async () => {
    registerMessagingRuntime(createDefaultMessagingRuntime({ now: () => 0 }));
    const result = await readNotificationsExecutor.execute({}, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.output)).toEqual({ notifications: [], remaining: 0 });
  });

  test("drains exactly this session's own queued notifications, matching the pinned {notification_id, origin, queued_at, content} shape", async () => {
    const runtime = createDefaultMessagingRuntime({ now: () => 0 });
    runtime.notifications.push("test-session", { origin: "session:s_x", content: "session:s_x is now idle", queuedAtMs: 0 });
    registerMessagingRuntime(runtime);

    const result = await readNotificationsExecutor.execute({}, makeCtx());
    const parsed = JSON.parse(result.output);
    expect(parsed.remaining).toBe(0);
    expect(parsed.notifications).toHaveLength(1);
    expect(parsed.notifications[0]).toEqual({
      notification_id: expect.any(String),
      origin: "session:s_x",
      queued_at: expect.any(String),
      content: "session:s_x is now idle",
    });
  });

  test("draining never touches a DIFFERENT session's own queue", async () => {
    const runtime = createDefaultMessagingRuntime({ now: () => 0 });
    runtime.notifications.push("some-other-session", { origin: "a", content: "not for you", queuedAtMs: 0 });
    registerMessagingRuntime(runtime);

    const result = await readNotificationsExecutor.execute({}, makeCtx());
    expect(JSON.parse(result.output)).toEqual({ notifications: [], remaining: 0 });
  });

  test("draining empties the queue -- a second call in a row sees nothing left", async () => {
    const runtime = createDefaultMessagingRuntime({ now: () => 0 });
    runtime.notifications.push("test-session", { origin: "a", content: "x", queuedAtMs: 0 });
    registerMessagingRuntime(runtime);

    await readNotificationsExecutor.execute({}, makeCtx());
    const second = await readNotificationsExecutor.execute({}, makeCtx());
    expect(JSON.parse(second.output)).toEqual({ notifications: [], remaining: 0 });
  });

  test("stray extra input fields are harmless (never rejected)", async () => {
    registerMessagingRuntime(createDefaultMessagingRuntime({ now: () => 0 }));
    const result = await readNotificationsExecutor.execute({ somethingUnexpected: true }, makeCtx());
    expect(result.isError).toBeUndefined();
  });
});
