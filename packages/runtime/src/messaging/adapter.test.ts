// Phase 4 Task 3 (MUST 8, WS-10 §11/§12/§15): serializeRuntimeAddress + createFakeMessagingRouterSeam.
// The full adapter/router SEAM semantics (allocateMessageId-before-resolution idempotency,
// recordOutcome/lookupOutcome, children() reflecting the roster) are the dedicated
// subagents/seam-contracts-p4.test.ts file's own job; this file covers what's local to this module.
import { describe, test, expect } from "bun:test";
import { serializeRuntimeAddress, createFakeMessagingRouterSeam, type RuntimeAddress } from "./adapter.ts";
import type { ChildHandle } from "../subagents/child-handle.ts";

describe("serializeRuntimeAddress (WS-10 §11's own opaque serialization)", () => {
  test("a session address serializes to session:<winterSessionId>", () => {
    const addr: RuntimeAddress = { objectKind: "session", runtimeKind: "winter-agent", winterSessionId: "s_abc" };
    expect(serializeRuntimeAddress(addr)).toBe("session:s_abc");
  });

  test("an agent address serializes to agent:<parentWinterSessionId>:<childId>", () => {
    const addr: RuntimeAddress = { objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: "s_abc", parentWinterSessionId: "s_abc", childId: "child-1" };
    expect(serializeRuntimeAddress(addr)).toBe("agent:s_abc:child-1");
  });

  test("an agent address without an explicit parentWinterSessionId falls back to winterSessionId itself", () => {
    const addr: RuntimeAddress = { objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: "s_abc", childId: "child-1" };
    expect(serializeRuntimeAddress(addr)).toBe("agent:s_abc:child-1");
  });

  test("an agent address with no childId throws -- a malformed address is a programmer error, never silently mis-serialized", () => {
    const addr: RuntimeAddress = { objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: "s_abc" };
    expect(() => serializeRuntimeAddress(addr)).toThrow();
  });
});

function fakeChild(id: string): ChildHandle {
  return {
    record: {
      id,
      parentSessionId: "p1",
      parentToolUseId: "t1",
      transcript: `subagents/agent-${id}.jsonl`,
      status: "running",
      runtime: "winter-agent",
      model: { effectiveModel: "sonnet", effectiveEffort: "medium" },
      permission: { effectiveMode: "default", parentPolicyHash: "h", parentPolicyVersion: 1 },
    },
    status: () => "running",
    steer: async () => ({ status: "queued", messageId: "m1" }),
    resume: async () => ({ status: "resumed_and_delivered", messageId: "m1" }),
    result: async () => ({ status: "completed", content: "done" }),
    stop: async () => {},
  };
}

describe("createFakeMessagingRouterSeam", () => {
  test("allocateMessageId is stable for the identical (senderSessionId, toolUseId) pair -- a retry returns the SAME id (WS-10 §12)", () => {
    const seam = createFakeMessagingRouterSeam();
    const a = seam.allocateMessageId("s1", "tool-1");
    const b = seam.allocateMessageId("s1", "tool-1");
    expect(a).toBe(b);
    const c = seam.allocateMessageId("s1", "tool-2");
    expect(c).not.toBe(a); // a different tool-call id allocates a different message id
  });

  test("recordOutcome / lookupOutcome round-trip; an unknown id looks up as undefined", () => {
    const seam = createFakeMessagingRouterSeam();
    const id = seam.allocateMessageId("s1", "tool-1");
    expect(seam.lookupOutcome(id)).toBeUndefined();
    seam.recordOutcome(id, { status: "delivered", messageId: id });
    expect(seam.lookupOutcome(id)).toEqual({ status: "delivered", messageId: id });
  });

  test("recordOutcome is idempotent -- recording twice for the same id keeps the LATEST value, never throws", () => {
    const seam = createFakeMessagingRouterSeam();
    const id = seam.allocateMessageId("s1", "tool-1");
    seam.recordOutcome(id, { status: "queued", messageId: id });
    seam.recordOutcome(id, { status: "delivered", messageId: id });
    expect(seam.lookupOutcome(id)).toEqual({ status: "delivered", messageId: id });
  });

  test("children() reflects whatever roster was set, empty by default", () => {
    const seam = createFakeMessagingRouterSeam();
    expect(seam.children()).toEqual([]);
    const child = fakeChild("a1");
    seam.setChildren([child]);
    expect(seam.children()).toEqual([child]);
  });
});
