// `messagingToolPortFromRuntimeDeps` (ruling P-3): the adapter that lets a host holding the shared
// core's `MessagingRuntimeDeps` satisfy `MessagingToolPort` without writing one.
//
// The router package's own `GlobalMessagingHandle` already satisfies the port structurally, so this
// is the OTHER host's half -- and the one place the address-centric shape has to be inverted back
// into the core's caller-centric one.
import { describe, expect, test } from "bun:test";

import {
  createLoopGuard,
  createMessagingRouterSeam,
  createNotificationQueue,
  createSubscriberDirectory,
  serializeRuntimeAddress,
  type ListedRuntimeObject,
  type MessagingRuntimeDeps,
  type RuntimeAddress,
  type RuntimeMessagingAdapter,
} from "../messaging/index.ts";
import { messagingToolPortFromRuntimeDeps } from "./index.ts";

function fakeAdapter(rows: ListedRuntimeObject[] = []): { adapter: RuntimeMessagingAdapter; delivered: Array<{ addr: RuntimeAddress; body: string; messageId: string }>; listCalls: Array<{ parent?: RuntimeAddress }> } {
  const delivered: Array<{ addr: RuntimeAddress; body: string; messageId: string }> = [];
  const listCalls: Array<{ parent?: RuntimeAddress }> = [];
  const adapter: RuntimeMessagingAdapter = {
    async listReachable(scope) {
      listCalls.push(scope);
      return rows;
    },
    async steerChild(_addr, msg) {
      return { status: "delivered", messageId: msg.messageId };
    },
    async resumeChild(_addr, msg) {
      return { status: "resumed_and_delivered", messageId: msg.messageId };
    },
    async deliverToSession(addr, msg) {
      delivered.push({ addr, body: msg.body, messageId: msg.messageId });
      return { status: "delivered", messageId: msg.messageId };
    },
    async subscribeIdle(_addr, req) {
      return { status: "subscribed", messageId: req.messageId };
    },
    async senderPermissionClass() {
      return "unknown";
    },
  };
  return { adapter, delivered, listCalls };
}

function makeDeps(adapter: RuntimeMessagingAdapter): MessagingRuntimeDeps {
  return {
    seam: createMessagingRouterSeam(),
    adapter,
    notifications: createNotificationQueue(),
    loopGuard: createLoopGuard(),
    subscribers: createSubscriberDirectory(),
    now: () => 0,
  };
}

function peerRow(winterSessionId: string, overrides: Partial<ListedRuntimeObject> = {}): ListedRuntimeObject {
  return {
    address: serializeRuntimeAddress({ objectKind: "session", runtimeKind: "winter-agent", winterSessionId }),
    objectKind: "session",
    runtimeKind: "winter-agent",
    status: "running",
    mode: "default",
    capabilities: { message: true, resume: false, notifyWhenIdle: true, reply: true },
    ...overrides,
  };
}

const SELF: RuntimeAddress = { objectKind: "session", runtimeKind: "winter-agent", winterSessionId: "s_caller" };

describe("sendDetailed: the `from` ADDRESS is inverted back into the core's caller", () => {
  test("a session address delivers as that session", async () => {
    const { adapter, delivered } = fakeAdapter([peerRow("s_peer")]);
    const port = messagingToolPortFromRuntimeDeps(makeDeps(adapter));
    const result = await port.sendDetailed({ from: SELF, to: "session:s_peer", body: "hello", originToolCallId: "toolu_1" });
    expect(result.outcome.status).toBe("delivered");
    expect(delivered[0]?.body).toBe("hello");
  });

  test("a CHILD address inverts to (owning session, agentId) -- never `agent:<id>:<id>`", async () => {
    const { adapter } = fakeAdapter([peerRow("s_peer")]);
    const deps = makeDeps(adapter);
    const port = messagingToolPortFromRuntimeDeps(deps);
    const child: RuntimeAddress = { objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: "s_parent", parentWinterSessionId: "s_parent", childId: "c1" };
    // A child sender is refused for a notify_when_idle call BY THE CORE (WS-10 §14) -- which is only
    // reachable if the inversion produced a genuine child caller, so this is the observation that
    // the agentId survived rather than being flattened into the session id.
    const result = await port.sendDetailed({ from: child, to: "session:s_peer", body: "hi", notifyWhenIdle: true });
    expect(result.outcome.status).toBe("refused");
  });

  test("WS-10 §12: the same originToolCallId is one retry -- the second call returns the stored outcome", async () => {
    const { adapter, delivered } = fakeAdapter([peerRow("s_peer")]);
    const port = messagingToolPortFromRuntimeDeps(makeDeps(adapter));
    const request = { from: SELF, to: "session:s_peer", body: "hello", originToolCallId: "toolu_same" };
    const first = await port.sendDetailed(request);
    const second = await port.sendDetailed(request);
    expect(second).toEqual(first);
    expect(delivered).toHaveLength(1);
  });

  test("RULING P-3: with NO originToolCallId the id is UNIQUE per call -- never a stable-looking fabrication", async () => {
    const { adapter, delivered } = fakeAdapter([peerRow("s_peer")]);
    const port = messagingToolPortFromRuntimeDeps(makeDeps(adapter));
    // Two distinct model calls must never be mistaken for one retry of each other. With no tool-call
    // id both calls land here identically shaped, and the ONLY thing that keeps them apart is that
    // the fallback allocates a fresh id per call: a stable-looking fabrication would make the second
    // one a retry of the first and drop it, returning the first one's stored outcome. (The bodies
    // differ so the core's own rapid-repeat duplicate guard — a separate rule, keyed on content —
    // is not what is being observed here.)
    await port.sendDetailed({ from: SELF, to: "session:s_peer", body: "first" });
    await port.sendDetailed({ from: SELF, to: "session:s_peer", body: "second" });
    expect(delivered).toHaveLength(2);
    expect(delivered[0]?.messageId).not.toBe(delivered[1]?.messageId);
  });
});

describe("listReachable and readNotifications", () => {
  test("listReachable asks the adapter about the caller's own scope and returns its rows", async () => {
    const { adapter, listCalls } = fakeAdapter([peerRow("s_peer", { name: "reviewer" })]);
    const port = messagingToolPortFromRuntimeDeps(makeDeps(adapter));
    const rows = await port.listReachable({ from: SELF });
    expect(rows.map((r) => r.address)).toEqual(["session:s_peer"]);
    expect(listCalls[0]?.parent).toEqual(SELF);
  });

  test("a TOP-LEVEL caller's own row is excluded -- the port is where that rule already lives", async () => {
    const { adapter } = fakeAdapter([peerRow("s_caller"), peerRow("s_peer")]);
    const port = messagingToolPortFromRuntimeDeps(makeDeps(adapter));
    expect((await port.listReachable({ from: SELF })).map((r) => r.address)).toEqual(["session:s_peer"]);
  });

  test("...but the exclusion is by OWNING SESSION, so a CHILD caller can still see its own row", async () => {
    // Recorded, not asserted as desirable (whole-branch fix wave): `listReachable` resolves an
    // `agent:<parent>:<child>` address to `session:<parent>` before scoping, so the row the child
    // itself occupies is not the row that gets dropped. Pre-existing on both branches and unchanged
    // this round -- this test exists so the behaviour is written down where the next reader of
    // port.ts will find it, and so the 0.0.4 fix has a test to invert rather than one to write.
    const child: RuntimeAddress = { objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: "s_caller", parentWinterSessionId: "s_caller", childId: "c1" };
    const childRow = peerRow("s_caller", { address: "agent:s_caller:c1", objectKind: "agent" });
    const { adapter } = fakeAdapter([childRow, peerRow("s_caller"), peerRow("s_peer")]);
    const port = messagingToolPortFromRuntimeDeps(makeDeps(adapter));
    const rows = (await port.listReachable({ from: child })).map((r) => r.address);
    expect(rows).toContain("agent:s_caller:c1"); // the caller's own row, still there
    expect(rows).not.toContain("session:s_caller"); // the OWNING SESSION's row is what was dropped
  });

  test("readNotifications DRAINS: the second read of the same session is empty", () => {
    const { adapter } = fakeAdapter();
    const deps = makeDeps(adapter);
    deps.notifications.push("s_caller", { origin: "session:s_peer", content: "went idle", queuedAtMs: 0 });
    const port = messagingToolPortFromRuntimeDeps(deps);
    const first = port.readNotifications("s_caller");
    expect(first.notifications).toHaveLength(1);
    expect(first.remaining).toBe(0);
    expect(port.readNotifications("s_caller").notifications).toHaveLength(0);
  });
});
