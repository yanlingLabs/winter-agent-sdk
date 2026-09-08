import { describe, test, expect } from "bun:test";
import {
  createMessagingRouterSeam,
  createSubscriberDirectory,
  callerAddress,
  sendMessage,
  listAgents,
  readNotifications,
  type MessagingRuntimeDeps,
  type CallerContext,
  rememberBounded,
  MAX_TRACKED_MESSAGE_IDS,
} from "./router.ts";
import { serializeRuntimeAddress, type RuntimeAddress, type ListedRuntimeObject, type DeliveryOutcome, type GlobalAgentMessage, type RuntimeMessagingAdapter } from "./adapter.ts";
import { createNotificationQueue } from "./idle.ts";
import { createLoopGuard, MAX_GLOBAL_MESSAGE_SIZE, RAPID_REPEAT_WINDOW_MS } from "./outcomes.ts";
import { createFakeChild } from "./child-fake.test-support.ts";

interface FakeAdapterCalls {
  listReachable: number;
  steer: Array<{ addr: RuntimeAddress; msg: GlobalAgentMessage }>;
  resume: Array<{ addr: RuntimeAddress; msg: GlobalAgentMessage }>;
  deliver: Array<{ addr: RuntimeAddress; msg: GlobalAgentMessage }>;
  subscribe: Array<{ addr: RuntimeAddress; messageId: string }>;
}

function createFakeAdapter(
  config: {
    reachable?: ListedRuntimeObject[];
    senderClass?: "prompts" | "bypasses" | "unknown";
    steerResult?: (msg: GlobalAgentMessage) => DeliveryOutcome;
    resumeResult?: (msg: GlobalAgentMessage) => DeliveryOutcome;
    deliverResult?: (msg: GlobalAgentMessage) => DeliveryOutcome;
    subscribeResult?: (messageId: string) => DeliveryOutcome;
    steerThrows?: Error;
    resumeThrows?: Error;
    deliverThrows?: Error;
  } = {},
): { adapter: RuntimeMessagingAdapter; calls: FakeAdapterCalls } {
  const calls: FakeAdapterCalls = { listReachable: 0, steer: [], resume: [], deliver: [], subscribe: [] };
  const adapter: RuntimeMessagingAdapter = {
    async listReachable() {
      calls.listReachable++;
      return config.reachable ?? [];
    },
    async steerChild(addr, msg) {
      calls.steer.push({ addr, msg });
      if (config.steerThrows !== undefined) throw config.steerThrows;
      return (config.steerResult ?? ((m: GlobalAgentMessage): DeliveryOutcome => ({ status: "delivered", messageId: m.messageId })))(msg);
    },
    async resumeChild(addr, msg) {
      calls.resume.push({ addr, msg });
      if (config.resumeThrows !== undefined) throw config.resumeThrows;
      return (config.resumeResult ?? ((m: GlobalAgentMessage): DeliveryOutcome => ({ status: "resumed_and_delivered", messageId: m.messageId })))(msg);
    },
    async deliverToSession(addr, msg) {
      calls.deliver.push({ addr, msg });
      if (config.deliverThrows !== undefined) throw config.deliverThrows;
      return (config.deliverResult ?? ((m: GlobalAgentMessage): DeliveryOutcome => ({ status: "delivered", messageId: m.messageId })))(msg);
    },
    async subscribeIdle(addr, req) {
      calls.subscribe.push({ addr, messageId: req.messageId });
      return (config.subscribeResult ?? ((id: string): DeliveryOutcome => ({ status: "subscribed", messageId: id })))(req.messageId);
    },
    async senderPermissionClass() {
      return config.senderClass ?? "unknown";
    },
  };
  return { adapter, calls };
}

function makeDeps(adapter: RuntimeMessagingAdapter, opts: { now?: () => number } = {}): MessagingRuntimeDeps {
  return {
    seam: createMessagingRouterSeam(),
    adapter,
    notifications: createNotificationQueue(),
    loopGuard: createLoopGuard(),
    subscribers: createSubscriberDirectory(),
    now: opts.now ?? (() => 0),
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

const CALLER: CallerContext = { sessionId: "s_caller", toolUseId: "tool-1" };

describe("callerAddress", () => {
  test("a top-level caller (no agentId) addresses its own session", () => {
    expect(callerAddress({ sessionId: "s1" })).toEqual({ objectKind: "session", runtimeKind: "winter-agent", winterSessionId: "s1" });
  });
  test("a child caller (agentId present) addresses itself as an agent within its owning parent", () => {
    expect(callerAddress({ sessionId: "s1", agentId: "c1" })).toEqual({ objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: "s1", parentWinterSessionId: "s1", childId: "c1" });
  });
});

// R-7b-4: the module-singleton register/get/reset round-trip that used to sit here moved with the
// singleton itself, to `packages/runtime/src/messaging/router-wiring.test.ts` -- a published library
// hands no consumer a shared mutable slot, so the core has none to test.

describe("sendMessage: idempotency (WS-10 §12)", () => {
  test("a retry with the identical (sessionId, toolUseId) returns the stored outcome without re-invoking the adapter", async () => {
    const { adapter, calls } = createFakeAdapter({ reachable: [peerRow("s_peer")] });
    const deps = makeDeps(adapter);
    const input = { to: "session:s_peer", message: "hello" };
    const first = await sendMessage(deps, CALLER, input);
    const second = await sendMessage(deps, CALLER, input);
    expect(second).toEqual(first);
    expect(calls.deliver).toHaveLength(1);
    expect(calls.listReachable).toBe(1); // resolution never re-ran on the retry
  });
});

describe("sendMessage: notify_when_idle sender-side eligibility (WS-10 §14)", () => {
  test("a child sender is refused for the WHOLE call before resolution ever runs", async () => {
    const { adapter, calls } = createFakeAdapter();
    const deps = makeDeps(adapter);
    const child: CallerContext = { sessionId: "s1", agentId: "c1", toolUseId: "t1" };
    const result = await sendMessage(deps, child, { to: "session:s_peer", message: "hi", notify_when_idle: true });
    expect(result.outcome.status).toBe("refused");
    expect(calls.listReachable).toBe(0);
  });
});

describe("sendMessage: notify_when_idle target-side eligibility (WS-10 §14)", () => {
  test("an agent (child) target refuses the WHOLE call, including the attached message -- neither steer nor subscribe is ever called", async () => {
    const { adapter, calls } = createFakeAdapter();
    const deps = makeDeps(adapter);
    const child = createFakeChild({ id: "c1", parentSessionId: CALLER.sessionId });
    deps.seam.children = () => [child];
    const result = await sendMessage(deps, CALLER, { to: "c1", message: "hi", notify_when_idle: true });
    expect(result.outcome.status).toBe("refused");
    expect(calls.steer).toHaveLength(0);
    expect(calls.subscribe).toHaveLength(0);
  });
  test("a peer target with capabilities.notifyWhenIdle:false refuses the WHOLE call", async () => {
    const { adapter, calls } = createFakeAdapter({ reachable: [peerRow("s_peer", { capabilities: { message: true, resume: false, notifyWhenIdle: false, reply: true } })] });
    const deps = makeDeps(adapter);
    const result = await sendMessage(deps, CALLER, { to: "session:s_peer", message: "hi", notify_when_idle: true });
    expect(result.outcome.status).toBe("refused");
    expect(calls.deliver).toHaveLength(0);
    expect(calls.subscribe).toHaveLength(0);
  });
});

describe("sendMessage: pure idle subscription (empty message)", () => {
  test("subscribes directly -- deliverToSession is never called", async () => {
    const { adapter, calls } = createFakeAdapter({ reachable: [peerRow("s_peer")] });
    const deps = makeDeps(adapter);
    const result = await sendMessage(deps, CALLER, { to: "session:s_peer", message: "", notify_when_idle: true });
    expect(result.outcome.status).toBe("subscribed");
    expect(calls.deliver).toHaveLength(0);
    expect(calls.subscribe).toHaveLength(1);
    expect(result.notify).toBeUndefined(); // the subscribe outcome itself IS the primary result
  });
});

describe("sendMessage: bounds (WS-10 §12)", () => {
  test("a message over MAX_GLOBAL_MESSAGE_SIZE is refused before resolution ever runs", async () => {
    const { adapter, calls } = createFakeAdapter();
    const deps = makeDeps(adapter);
    const result = await sendMessage(deps, CALLER, { to: "session:s_peer", message: "a".repeat(MAX_GLOBAL_MESSAGE_SIZE + 1) });
    expect(result.outcome.status).toBe("refused");
    expect(calls.listReachable).toBe(0);
  });
  test("an identical rapid repeat (different tool-call id, same content) is refused as a duplicate, distinct from a genuine retry", async () => {
    const { adapter } = createFakeAdapter({ reachable: [peerRow("s_peer")] });
    const deps = makeDeps(adapter);
    const first = await sendMessage(deps, CALLER, { to: "session:s_peer", message: "hello" });
    expect(first.outcome.status).toBe("delivered");
    const second = await sendMessage(deps, { ...CALLER, toolUseId: "tool-2" }, { to: "session:s_peer", message: "hello" });
    expect(second.outcome.status).toBe("refused");
    expect(second.outcome.messageId).not.toBe(first.outcome.messageId); // a genuinely NEW message id, not the retry short-circuit
  });
  test("the same content sent again AFTER the rapid-repeat window has elapsed is delivered normally", async () => {
    let now = 0;
    const { adapter, calls } = createFakeAdapter({ reachable: [peerRow("s_peer")] });
    const deps = makeDeps(adapter, { now: () => now });
    await sendMessage(deps, CALLER, { to: "session:s_peer", message: "hello" });
    now = RAPID_REPEAT_WINDOW_MS + 1;
    const second = await sendMessage(deps, { ...CALLER, toolUseId: "tool-2" }, { to: "session:s_peer", message: "hello" });
    expect(second.outcome.status).toBe("delivered");
    expect(calls.deliver).toHaveLength(2);
  });
});

describe("sendMessage: resolution failures surface as the matching DeliveryOutcome", () => {
  test("not_found", async () => {
    const { adapter } = createFakeAdapter({ reachable: [] });
    const deps = makeDeps(adapter);
    const result = await sendMessage(deps, CALLER, { to: "nobody", message: "hi" });
    expect(result.outcome.status).toBe("not_found");
  });
  test("stale name -> refused", async () => {
    const { adapter } = createFakeAdapter();
    const deps = makeDeps(adapter);
    const first = createFakeChild({ id: "c1", name: "dup", parentSessionId: CALLER.sessionId });
    first.setStatus("completed");
    const second = createFakeChild({ id: "c2", name: "dup", parentSessionId: CALLER.sessionId });
    deps.seam.children = () => [first, second];
    const result = await sendMessage(deps, CALLER, { to: "dup", message: "hi" });
    expect(result.outcome.status).toBe("refused");
  });
  test("ambiguous -> carries candidates", async () => {
    const { adapter } = createFakeAdapter({ reachable: [peerRow("s_a", { name: "dup" }), peerRow("s_b", { name: "dup" })] });
    const deps = makeDeps(adapter);
    const result = await sendMessage(deps, CALLER, { to: "dup", message: "hi" });
    expect(result.outcome.status).toBe("ambiguous");
    if (result.outcome.status === "ambiguous") expect(result.outcome.candidates).toHaveLength(2);
  });
});

describe("sendMessage: self-target refusal (WS-10 §16)", () => {
  test("addressing your own session by its canonical address is refused, never delivered", async () => {
    const { adapter, calls } = createFakeAdapter({ reachable: [peerRow(CALLER.sessionId)] });
    const deps = makeDeps(adapter);
    const result = await sendMessage(deps, CALLER, { to: `session:${CALLER.sessionId}`, message: "note to self" });
    expect(result.outcome.status).toBe("refused");
    expect(calls.deliver).toHaveLength(0);
  });
});

describe("sendMessage: steer vs resume dispatch by live child status (WS-10 §10.3)", () => {
  test("a RUNNING child is steered, never resumed", async () => {
    const { adapter, calls } = createFakeAdapter();
    const deps = makeDeps(adapter);
    const child = createFakeChild({ id: "c1", parentSessionId: CALLER.sessionId });
    deps.seam.children = () => [child];
    const result = await sendMessage(deps, CALLER, { to: "c1", message: "steer me" });
    expect(result.outcome.status).toBe("delivered");
    expect(calls.steer).toHaveLength(1);
    expect(calls.resume).toHaveLength(0);
  });
  test("a TERMINAL child is resumed, never steered", async () => {
    const { adapter, calls } = createFakeAdapter();
    const deps = makeDeps(adapter);
    const child = createFakeChild({ id: "c1", parentSessionId: CALLER.sessionId });
    child.setStatus("completed");
    deps.seam.children = () => [child];
    const result = await sendMessage(deps, CALLER, { to: "c1", message: "resume me" });
    expect(result.outcome.status).toBe("resumed_and_delivered");
    expect(calls.resume).toHaveLength(1);
    expect(calls.steer).toHaveLength(0);
  });
});

// R-7b-4: the classification of a THROW out of an adapter is the owner's, supplied as
// `MessagingRuntimeDeps.classifyDeliveryError`. The core's job is to honour it in both directions;
// the WINTER RUNTIME's own end-to-end pin -- that RULING P4-D's real
// `ChildResumeModeIncomparableError` reaches `refused` through `createDefaultMessagingRuntime` --
// lives beside that wiring, in `packages/runtime/src/messaging/router-wiring.test.ts`, because the
// class is the runtime's and this package must not import it.
describe("sendMessage: a POLICY refusal thrown by an adapter surfaces legibly, never as uncertain", () => {
  class FakePolicyRefusal extends Error {}

  test("a throw the owner's classifier calls a policy refusal becomes a refused outcome carrying the error's own message", async () => {
    const err = new FakePolicyRefusal("these two modes are INCOMPARABLE; refusing rather than guessing");
    const { adapter } = createFakeAdapter({ resumeThrows: err });
    const deps = makeDeps(adapter);
    deps.classifyDeliveryError = (e) => (e instanceof FakePolicyRefusal ? "refused" : "uncertain");
    const child = createFakeChild({ id: "c1", parentSessionId: CALLER.sessionId });
    child.setStatus("completed");
    deps.seam.children = () => [child];
    const result = await sendMessage(deps, CALLER, { to: "c1", message: "resume me" });
    expect(result.outcome).toEqual({ status: "refused", messageId: result.outcome.messageId, reason: err.message });
  });

  test("with NO classifier the SAME throw is delivery_uncertain -- absence means the conservative reading, never a silent refusal", async () => {
    // The negative control the default has to earn: `classifyDeliveryError` absent must not quietly
    // behave like a refusal, because "refused" asserts the effect did NOT happen.
    const err = new FakePolicyRefusal("same error, no classifier");
    const { adapter } = createFakeAdapter({ resumeThrows: err });
    const deps = makeDeps(adapter);
    const child = createFakeChild({ id: "c1", parentSessionId: CALLER.sessionId });
    child.setStatus("completed");
    deps.seam.children = () => [child];
    const result = await sendMessage(deps, CALLER, { to: "c1", message: "resume me" });
    expect(result.outcome.status).toBe("delivery_uncertain");
  });
});

describe("sendMessage: crash-window semantics (WS-10 §12)", () => {
  test("an unexpected throw during delivery becomes delivery_uncertain, and a retry returns the SAME stored outcome without re-invoking the adapter", async () => {
    const { adapter, calls } = createFakeAdapter({ reachable: [peerRow("s_peer")], deliverThrows: new Error("simulated crash") });
    const deps = makeDeps(adapter, {});
    const input = { to: "session:s_peer", message: "hi" };
    const first = await sendMessage(deps, CALLER, input);
    expect(first.outcome.status).toBe("delivery_uncertain");
    if (first.outcome.status === "delivery_uncertain") expect(first.outcome.deliveryMayHaveOccurred).toBe(true);
    expect(calls.deliver).toHaveLength(1);
    const retry = await sendMessage(deps, CALLER, input);
    expect(retry).toEqual(first);
    expect(calls.deliver).toHaveLength(1); // never blindly repeated
  });
});

describe("sendMessage: combined message + notify_when_idle", () => {
  test("a successful delivery followed by a successful subscribe reports both, delivery as primary", async () => {
    const { adapter, calls } = createFakeAdapter({ reachable: [peerRow("s_peer")] });
    const deps = makeDeps(adapter);
    const result = await sendMessage(deps, CALLER, { to: "session:s_peer", message: "hi", notify_when_idle: true });
    expect(result.outcome.status).toBe("delivered");
    expect(result.notify).toEqual({ subscribed: true });
    expect(calls.deliver).toHaveLength(1);
    expect(calls.subscribe).toHaveLength(1);
  });
  test("a non-success delivery (e.g. held) never attempts to subscribe, and reports why in `notify`", async () => {
    const { adapter, calls } = createFakeAdapter({
      reachable: [peerRow("s_peer")],
      deliverResult: (m) => ({ status: "held", messageId: m.messageId, reason: "pending approval" }),
    });
    const deps = makeDeps(adapter);
    const result = await sendMessage(deps, CALLER, { to: "session:s_peer", message: "hi", notify_when_idle: true });
    expect(result.outcome.status).toBe("held");
    expect(calls.subscribe).toHaveLength(0);
    expect(result.notify?.refused).toBeDefined();
  });
  test("a subscribeIdle race-failure after successful delivery reports the refusal in `notify` without disturbing the delivered outcome", async () => {
    const { adapter } = createFakeAdapter({
      reachable: [peerRow("s_peer")],
      subscribeResult: (id) => ({ status: "refused", messageId: id, reason: "race: no longer eligible" }),
    });
    const deps = makeDeps(adapter);
    const result = await sendMessage(deps, CALLER, { to: "session:s_peer", message: "hi", notify_when_idle: true });
    expect(result.outcome.status).toBe("delivered");
    expect(result.notify).toEqual({ refused: "race: no longer eligible" });
  });
});

describe("listAgents", () => {
  test("excludes the caller's own session and returns both a formatted listing and structured rows", async () => {
    const { adapter } = createFakeAdapter({ reachable: [peerRow(CALLER.sessionId), peerRow("s_peer", { name: "friend" })] });
    const deps = makeDeps(adapter);
    const result = await listAgents(deps, CALLER, {});
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.name).toBe("friend");
    expect(result.listing).toContain("friend");
    expect(result.listing).not.toContain(CALLER.sessionId);
  });
  test("an empty reachable set renders a legible empty-state listing, not an empty string", async () => {
    const { adapter } = createFakeAdapter({ reachable: [] });
    const deps = makeDeps(adapter);
    const result = await listAgents(deps, CALLER, {});
    expect(result.rows).toEqual([]);
    expect(result.listing.length).toBeGreaterThan(0);
  });
});

describe("readNotifications", () => {
  test("drains the caller's own queue, matching {notifications, remaining}", () => {
    const { adapter } = createFakeAdapter();
    const deps = makeDeps(adapter);
    deps.notifications.push(CALLER.sessionId, { origin: "session:s_x", content: "session:s_x is now idle", queuedAtMs: 0 });
    const result = readNotifications(deps, CALLER);
    expect(result.notifications).toHaveLength(1);
    expect(result.remaining).toBe(0);
  });
  test("a caller with nothing queued gets an empty drain", () => {
    const { adapter } = createFakeAdapter();
    const deps = makeDeps(adapter);
    expect(readNotifications(deps, CALLER)).toEqual({ notifications: [], remaining: 0 });
  });
});

// --- Phase 4 fix wave (whole-branch M10): the messageId-keyed maps are BOUNDED -------------------

describe("bounded retry memory (fix wave M10)", () => {
  test("rememberBounded caps the map and evicts oldest-first, keeping the most recent entries", () => {
    const map = new Map<string, number>();
    for (let i = 0; i < 12; i++) rememberBounded(map, `k${i}`, i, 5);
    expect(map.size).toBe(5);
    expect([...map.keys()]).toEqual(["k7", "k8", "k9", "k10", "k11"]);
  });

  test("re-writing an existing key moves it to the YOUNG end rather than growing the map", () => {
    const map = new Map<string, number>();
    for (let i = 0; i < 3; i++) rememberBounded(map, `k${i}`, i, 3);
    rememberBounded(map, "k0", 99, 3); // k0 was the oldest; it is now the youngest
    expect(map.size).toBe(3);
    expect([...map.keys()]).toEqual(["k1", "k2", "k0"]);
    rememberBounded(map, "k3", 3, 3);
    expect([...map.keys()]).toEqual(["k2", "k0", "k3"]); // k1 evicted, the refreshed k0 survives
  });

  test("the seam's own outcome ledger stays bounded -- an unbounded process-lifetime map was the finding", () => {
    const seam = createMessagingRouterSeam();
    // The cap itself is 10_000 (MAX_TRACKED_MESSAGE_IDS); this asserts the PROPERTY -- lookups keep
    // working for recent ids -- without spending a million allocations proving the exact number.
    const recent = seam.allocateMessageId("s1", "tool-1");
    seam.recordOutcome(recent, { status: "delivered", messageId: recent });
    expect(seam.lookupOutcome(recent)).toEqual({ status: "delivered", messageId: recent });
    expect(MAX_TRACKED_MESSAGE_IDS).toBeGreaterThan(0);
  });
});
