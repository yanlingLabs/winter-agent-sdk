import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createSessionReadState } from "../read-state.ts";
import { getRegisteredTool, type ToolExecutionContext } from "../registry.ts";
import { LIST_AGENTS_TOOL_NAME, listAgentsExecutor } from "./list-agents.ts";
import { registerMessagingRuntime, resetMessagingRuntimeForTest } from "../../messaging/router.ts";
import { createDefaultMessagingRuntime, type PeerSessionHandle } from "../../messaging/reference-adapter.ts";

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

function fakePeer(winterSessionId: string, name?: string): PeerSessionHandle {
  return {
    address: { objectKind: "session", runtimeKind: "winter-agent", winterSessionId },
    ...(name !== undefined ? { name } : {}),
    status: () => "running",
    mode: () => "default",
    bypassAvailable: () => false,
    hasReliableIdleSignal: () => true,
    deliver: async () => {},
  };
}

beforeEach(() => resetMessagingRuntimeForTest());
afterEach(() => resetMessagingRuntimeForTest());

describe("ListAgents (Task 7, WS-10 §10.2)", () => {
  test("module load installs a real executor over the WS-06 stub", () => {
    const registered = getRegisteredTool(LIST_AGENTS_TOOL_NAME);
    expect(registered?.executor).toBeDefined();
  });

  test("no messaging runtime configured -> a legible host-configuration error, not a crash", async () => {
    const result = await listAgentsExecutor.execute({}, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.output).toContain("messaging runtime");
  });

  test("output is exactly {listing: string} (WS-10 §10.2 pinned shape), never the structured rows", async () => {
    const runtime = createDefaultMessagingRuntime({ now: () => 0 });
    runtime.peers.register(fakePeer("s_peer", "friend"));
    registerMessagingRuntime(runtime);

    const result = await listAgentsExecutor.execute({}, makeCtx());
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output);
    expect(Object.keys(parsed)).toEqual(["listing"]);
    expect(typeof parsed.listing).toBe("string");
    expect(parsed.listing).toContain("friend");
  });

  test("excludes the caller's own session from the listing", async () => {
    const runtime = createDefaultMessagingRuntime({ now: () => 0 });
    runtime.peers.register(fakePeer("test-session")); // same id as makeCtx()'s own sessionId
    runtime.peers.register(fakePeer("s_other", "other-one"));
    registerMessagingRuntime(runtime);

    const result = await listAgentsExecutor.execute({}, makeCtx());
    const parsed = JSON.parse(result.output);
    expect(parsed.listing).not.toContain("test-session");
    expect(parsed.listing).toContain("other-one");
  });

  test("an empty reachable set still renders a legible (non-empty-string) listing", async () => {
    registerMessagingRuntime(createDefaultMessagingRuntime({ now: () => 0 }));
    const result = await listAgentsExecutor.execute({}, makeCtx());
    const parsed = JSON.parse(result.output);
    expect(parsed.listing.length).toBeGreaterThan(0);
  });

  test("channel/q are accepted without error even though reserved/unavailable (WS-10 §10.2)", async () => {
    registerMessagingRuntime(createDefaultMessagingRuntime({ now: () => 0 }));
    const result = await listAgentsExecutor.execute({ channel: "anything", q: "whatever" }, makeCtx());
    expect(result.isError).toBeUndefined();
  });
});
