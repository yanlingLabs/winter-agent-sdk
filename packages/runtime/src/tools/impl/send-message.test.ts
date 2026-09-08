import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createSessionReadState } from "../read-state.ts";
import { getRegisteredTool, type ToolExecutionContext } from "../registry.ts";
import { SEND_MESSAGE_TOOL_NAME, sendMessageExecutor } from "./send-message.ts";
import { registerMessagingRuntime, resetMessagingRuntimeForTest } from "../../messaging/router.ts";
import { createDefaultMessagingRuntime, type PeerSessionHandle } from "../../messaging/reference-adapter.ts";
import type { GlobalAgentMessage } from "@yanlinglabs/winter-agent-sdk/messaging";
import { MAX_GLOBAL_MESSAGE_SIZE } from "@yanlinglabs/winter-agent-sdk/messaging";

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

function fakePeer(winterSessionId: string): { peer: PeerSessionHandle; delivered: GlobalAgentMessage[] } {
  const delivered: GlobalAgentMessage[] = [];
  return {
    peer: {
      address: { objectKind: "session", runtimeKind: "winter-agent", winterSessionId },
      status: () => "idle",
      mode: () => "default",
      bypassAvailable: () => false,
      hasReliableIdleSignal: () => true,
      deliver: async (msg) => void delivered.push(msg),
    },
    delivered,
  };
}

beforeEach(() => resetMessagingRuntimeForTest());
afterEach(() => resetMessagingRuntimeForTest());

describe("SendMessage (Task 7, WS-10 §10.1)", () => {
  test("module load installs a real executor over the WS-06 stub", () => {
    const registered = getRegisteredTool(SEND_MESSAGE_TOOL_NAME);
    expect(registered?.executor).toBeDefined();
  });

  describe("input validation (no messageId ever allocated -- an invalid call never enters the messaging system)", () => {
    test("to missing is a validation error", async () => {
      const result = await sendMessageExecutor.execute({ message: "hi" }, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.output).toContain("to must be");
    });
    test("to over 300 chars is a validation error", async () => {
      const result = await sendMessageExecutor.execute({ to: "a".repeat(301), message: "hi" }, makeCtx());
      expect(result.isError).toBe(true);
    });
    test('to containing "*" is a validation error', async () => {
      const result = await sendMessageExecutor.execute({ to: "team-*", message: "hi" }, makeCtx());
      expect(result.isError).toBe(true);
    });
    test("to containing a newline is a validation error", async () => {
      const result = await sendMessageExecutor.execute({ to: "a\nb", message: "hi" }, makeCtx());
      expect(result.isError).toBe(true);
    });
    test("message missing (not a string) is a validation error", async () => {
      const result = await sendMessageExecutor.execute({ to: "someone" }, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.output).toContain("message must be a string");
    });
    test("an empty message without notify_when_idle is a validation error", async () => {
      const result = await sendMessageExecutor.execute({ to: "someone", message: "" }, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.output).toContain("notify_when_idle");
    });
    test("an empty message WITH notify_when_idle: true is NOT a validation error (a pure idle subscription)", async () => {
      registerMessagingRuntime(createDefaultMessagingRuntime({ now: () => 0 }));
      const result = await sendMessageExecutor.execute({ to: "session:s_peer", message: "", notify_when_idle: true }, makeCtx());
      expect(result.isError).toBeUndefined();
    });
    test("notify_when_idle of the wrong type is a validation error", async () => {
      const result = await sendMessageExecutor.execute({ to: "someone", message: "hi", notify_when_idle: "yes" }, makeCtx());
      expect(result.isError).toBe(true);
    });
    test("summary of the wrong type is a validation error", async () => {
      const result = await sendMessageExecutor.execute({ to: "someone", message: "hi", summary: 42 }, makeCtx());
      expect(result.isError).toBe(true);
    });
  });

  test("no messaging runtime configured -> a legible host-configuration error, not a crash", async () => {
    const result = await sendMessageExecutor.execute({ to: "someone", message: "hi" }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.output).toContain("messaging runtime");
  });

  describe("a successful send against a registered runtime", () => {
    test("delivers to a registered peer and echoes the DeliveryOutcome as JSON", async () => {
      let now = 0;
      const runtime = createDefaultMessagingRuntime({ now: () => now });
      const { peer, delivered } = fakePeer("s_peer");
      runtime.peers.register(peer);
      registerMessagingRuntime(runtime);

      const result = await sendMessageExecutor.execute({ to: "session:s_peer", message: "hello there" }, makeCtx());
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.output);
      expect(parsed.outcome.status).toBe("delivered");
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.body).toBe("hello there");
    });

    test("summary is derived from the first line of message when absent", async () => {
      const runtime = createDefaultMessagingRuntime({ now: () => 0 });
      const { peer, delivered } = fakePeer("s_peer");
      runtime.peers.register(peer);
      registerMessagingRuntime(runtime);

      await sendMessageExecutor.execute({ to: "session:s_peer", message: "first line\nsecond line" }, makeCtx());
      expect(delivered[0]?.summary).toBe("first line");
    });

    test("an explicit summary is used as-is when within the 200-char limit", async () => {
      const runtime = createDefaultMessagingRuntime({ now: () => 0 });
      const { peer, delivered } = fakePeer("s_peer");
      runtime.peers.register(peer);
      registerMessagingRuntime(runtime);

      await sendMessageExecutor.execute({ to: "session:s_peer", message: "body text", summary: "custom summary" }, makeCtx());
      expect(delivered[0]?.summary).toBe("custom summary");
    });

    test("an overlong explicit summary is truncated to 200 chars, never rejected", async () => {
      const runtime = createDefaultMessagingRuntime({ now: () => 0 });
      const { peer, delivered } = fakePeer("s_peer");
      runtime.peers.register(peer);
      registerMessagingRuntime(runtime);

      const longSummary = "s".repeat(250);
      const result = await sendMessageExecutor.execute({ to: "session:s_peer", message: "body", summary: longSummary }, makeCtx());
      expect(result.isError).toBeUndefined();
      expect(delivered[0]?.summary).toHaveLength(200);
    });

    test("a message right at MAX_GLOBAL_MESSAGE_SIZE is accepted; one character over is refused (not a validation error -- it still gets a messageId)", async () => {
      const runtime = createDefaultMessagingRuntime({ now: () => 0 });
      const { peer } = fakePeer("s_peer");
      runtime.peers.register(peer);
      registerMessagingRuntime(runtime);

      const tooLong = await sendMessageExecutor.execute({ to: "session:s_peer", message: "a".repeat(MAX_GLOBAL_MESSAGE_SIZE + 1) }, makeCtx());
      expect(tooLong.isError).toBeUndefined(); // NOT a tool-input validation error...
      const parsed = JSON.parse(tooLong.output);
      expect(parsed.outcome.status).toBe("refused"); // ...it's a messaging-system bounds outcome instead
      expect(typeof parsed.outcome.messageId).toBe("string");
    });
  });

  describe("caller identity threading (ctx.agentId -> CallerContext.agentId)", () => {
    test("a child's own call (ctx.agentId set) is refused for notify_when_idle (WS-10 §14 sender-side eligibility)", async () => {
      registerMessagingRuntime(createDefaultMessagingRuntime({ now: () => 0 }));
      const result = await sendMessageExecutor.execute(
        { to: "session:s_peer", message: "hi", notify_when_idle: true },
        makeCtx({ agentId: "child-1" }),
      );
      const parsed = JSON.parse(result.output);
      expect(parsed.outcome.status).toBe("refused");
    });
    test("a top-level call (no ctx.agentId) is NOT refused merely for requesting notify_when_idle against an eligible target", async () => {
      let now = 0;
      const runtime = createDefaultMessagingRuntime({ now: () => now });
      const { peer } = fakePeer("s_peer");
      runtime.peers.register(peer);
      registerMessagingRuntime(runtime);
      const result = await sendMessageExecutor.execute({ to: "session:s_peer", message: "", notify_when_idle: true }, makeCtx());
      const parsed = JSON.parse(result.output);
      expect(parsed.outcome.status).toBe("subscribed");
    });
  });

  describe("fallback tool-use id (NEEDS_CONTEXT: no real per-call id exists on ToolExecutionContext yet)", () => {
    test("two DIFFERENT calls are never conflated as the same retry -- both actually deliver", async () => {
      const runtime = createDefaultMessagingRuntime({ now: () => 0 });
      const { peer, delivered } = fakePeer("s_peer");
      runtime.peers.register(peer);
      registerMessagingRuntime(runtime);

      const ctx = makeCtx();
      await sendMessageExecutor.execute({ to: "session:s_peer", message: "message A" }, ctx);
      await sendMessageExecutor.execute({ to: "session:s_peer", message: "message B" }, ctx);
      expect(delivered.map((m) => m.body)).toEqual(["message A", "message B"]);
    });
    test("two IDENTICAL calls in immediate succession are caught by the content-based rapid-repeat guard, never silently duplicated", async () => {
      const runtime = createDefaultMessagingRuntime({ now: () => 0 });
      const { peer, delivered } = fakePeer("s_peer");
      runtime.peers.register(peer);
      registerMessagingRuntime(runtime);

      const ctx = makeCtx();
      const first = await sendMessageExecutor.execute({ to: "session:s_peer", message: "same content" }, ctx);
      const second = await sendMessageExecutor.execute({ to: "session:s_peer", message: "same content" }, ctx);
      expect(JSON.parse(first.output).outcome.status).toBe("delivered");
      expect(JSON.parse(second.output).outcome.status).toBe("refused");
      expect(delivered).toHaveLength(1);
    });
  });
});
