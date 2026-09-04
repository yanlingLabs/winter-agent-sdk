import { describe, test, expect } from "bun:test";
import {
  createReferenceMessagingAdapter,
  createInMemoryPeerDirectory,
  createDefaultMessagingRuntime,
  type PeerSessionHandle,
  type ReferenceAdapterDeps,
} from "./reference-adapter.ts";
import { createNotificationQueue } from "./idle.ts";
import { createSubscriberDirectory } from "./router.ts";
import type { RuntimeAddress, GlobalAgentMessage, DeliveryOutcome } from "./adapter.ts";
import { createFakeChildHandle } from "../subagents/seam-contracts-p4.test.ts";
import { HELD_INBOX_CAP, ACCEPTED_QUEUE_CAP, DEFAULT_HOLD_EXPIRY_MS } from "./outcomes.ts";
import type { CrossSessionInbound } from "./inbound.ts";
import type { PermissionMode } from "@yanlinglabs/winter-agent-sdk";
import { sendMessage, type CallerContext } from "./router.ts";

function fakePeer(overrides: {
  winterSessionId?: string;
  name?: string;
  status?: "starting" | "running" | "idle" | "exited" | "unavailable" | "archived";
  mode?: PermissionMode;
  bypassAvailable?: boolean;
  crossSessionInbound?: CrossSessionInbound;
  hasReliableIdleSignal?: boolean;
  deliver?: (msg: GlobalAgentMessage) => Promise<void>;
} = {}): { peer: PeerSessionHandle; delivered: GlobalAgentMessage[]; setStatus: (s: "starting" | "running" | "idle" | "exited" | "unavailable" | "archived") => void } {
  let status = overrides.status ?? "running";
  const delivered: GlobalAgentMessage[] = [];
  const peer: PeerSessionHandle = {
    address: { objectKind: "session", runtimeKind: "winter-agent", winterSessionId: overrides.winterSessionId ?? "s_peer" },
    ...(overrides.name !== undefined ? { name: overrides.name } : {}),
    status: () => status,
    mode: () => overrides.mode ?? "default",
    bypassAvailable: () => overrides.bypassAvailable ?? false,
    ...(overrides.crossSessionInbound !== undefined ? { crossSessionInbound: () => overrides.crossSessionInbound } : {}),
    hasReliableIdleSignal: () => overrides.hasReliableIdleSignal ?? true,
    deliver: overrides.deliver ?? (async (msg) => void delivered.push(msg)),
  };
  return { peer, delivered, setStatus: (s) => (status = s) };
}

function envelope(overrides: Partial<GlobalAgentMessage> = {}): GlobalAgentMessage {
  return {
    messageId: "m1",
    from: { objectKind: "session", runtimeKind: "winter-agent", winterSessionId: "s_sender" },
    fromGeneration: 0,
    to: { objectKind: "session", runtimeKind: "winter-agent", winterSessionId: "s_peer" },
    toGeneration: 0,
    body: "hello",
    notifyWhenIdle: false,
    createdAt: 0,
    expiresAt: 1000,
    hopCount: 0,
    senderPermissionClass: "prompts",
    ...overrides,
  };
}

function makeAdapterDeps(getChildren: () => readonly ReturnType<typeof createFakeChildHandle>[] = () => []) {
  const peers = createInMemoryPeerDirectory();
  const notifications = createNotificationQueue();
  const subscribers = createSubscriberDirectory();
  let now = 0;
  const deps: ReferenceAdapterDeps = { getChildren, peers, notifications, subscribers, now: () => now };
  return { deps, peers, notifications, subscribers, setNow: (n: number) => (now = n) };
}

describe("listReachable", () => {
  test("combines this parent's own children with every registered peer", async () => {
    const child = createFakeChildHandle({ id: "c1", parentSessionId: "s_parent" });
    const { deps, peers } = makeAdapterDeps(() => [child]);
    const { peer } = fakePeer({ winterSessionId: "s_peer", name: "friend" });
    peers.register(peer);
    const adapter = createReferenceMessagingAdapter(deps);
    const rows = await adapter.listReachable({ parent: { objectKind: "session", runtimeKind: "winter-agent", winterSessionId: "s_parent" } });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.objectKind === "agent")?.address).toBe("agent:s_parent:c1");
    expect(rows.find((r) => r.objectKind === "session")?.name).toBe("friend");
  });
  test("children of a DIFFERENT parent are excluded", async () => {
    const child = createFakeChildHandle({ id: "c1", parentSessionId: "s_other" });
    const { deps } = makeAdapterDeps(() => [child]);
    const adapter = createReferenceMessagingAdapter(deps);
    const rows = await adapter.listReachable({ parent: { objectKind: "session", runtimeKind: "winter-agent", winterSessionId: "s_parent" } });
    expect(rows).toHaveLength(0);
  });
  test("with no `parent` scope, only peers are returned (no child roster to scope to)", async () => {
    const child = createFakeChildHandle({ id: "c1", parentSessionId: "s_parent" });
    const { deps, peers } = makeAdapterDeps(() => [child]);
    peers.register(fakePeer({ winterSessionId: "s_peer" }).peer);
    const adapter = createReferenceMessagingAdapter(deps);
    const rows = await adapter.listReachable({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.objectKind).toBe("session");
  });
});

describe("steerChild / resumeChild", () => {
  test("steerChild delegates to a running child's own steer()", async () => {
    const child = createFakeChildHandle({ id: "c1", parentSessionId: "s_parent" });
    const { deps } = makeAdapterDeps(() => [child]);
    const adapter = createReferenceMessagingAdapter(deps);
    const outcome = await adapter.steerChild({ objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: "s_parent", childId: "c1" }, envelope());
    expect(outcome.status).toBe("delivered");
  });
  test("steerChild on a non-running child is not_found (steer targets a RUNNING child only)", async () => {
    const child = createFakeChildHandle({ id: "c1", parentSessionId: "s_parent" });
    child.simulateCompletion("done");
    const { deps } = makeAdapterDeps(() => [child]);
    const adapter = createReferenceMessagingAdapter(deps);
    const outcome = await adapter.steerChild({ objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: "s_parent", childId: "c1" }, envelope());
    expect(outcome.status).toBe("not_found");
  });
  test("steerChild/resumeChild on an unknown child id is not_found", async () => {
    const { deps } = makeAdapterDeps(() => []);
    const adapter = createReferenceMessagingAdapter(deps);
    const addr: RuntimeAddress = { objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: "s_parent", childId: "ghost" };
    expect((await adapter.steerChild(addr, envelope())).status).toBe("not_found");
    expect((await adapter.resumeChild(addr, envelope())).status).toBe("not_found");
  });
  test("resumeChild delegates to a terminal child's own resume()", async () => {
    const child = createFakeChildHandle({ id: "c1", parentSessionId: "s_parent" });
    child.simulateCompletion("done");
    const { deps } = makeAdapterDeps(() => [child]);
    const adapter = createReferenceMessagingAdapter(deps);
    const outcome = await adapter.resumeChild({ objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: "s_parent", childId: "c1" }, envelope());
    expect(outcome.status).toBe("resumed_and_delivered");
  });
});

describe("deliverToSession: reachability short-circuit BEFORE inbound policy (WS-10 §10.3)", () => {
  test("an EXITED peer is unavailable, never silently cold-resumed -- resumed_and_delivered/delivered MUST NOT be claimed for this", async () => {
    const { deps, peers } = makeAdapterDeps();
    const { peer, delivered } = fakePeer({ status: "exited" });
    peers.register(peer);
    const adapter = createReferenceMessagingAdapter(deps);
    const outcome = await adapter.deliverToSession(peer.address, envelope({ senderPermissionClass: "prompts" }));
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") expect(outcome.retryable).toBe(false);
    expect(delivered).toHaveLength(0);
  });
  test("an ARCHIVED peer is refused (a policy decision), not merely unavailable", async () => {
    const { deps, peers } = makeAdapterDeps();
    const { peer, delivered } = fakePeer({ status: "archived" });
    peers.register(peer);
    const adapter = createReferenceMessagingAdapter(deps);
    const outcome = await adapter.deliverToSession(peer.address, envelope({ senderPermissionClass: "prompts" }));
    expect(outcome.status).toBe("refused");
    expect(delivered).toHaveLength(0);
  });
  test("a STARTING peer is unavailable but retryable", async () => {
    const { deps, peers } = makeAdapterDeps();
    const { peer } = fakePeer({ status: "starting" });
    peers.register(peer);
    const adapter = createReferenceMessagingAdapter(deps);
    const outcome = await adapter.deliverToSession(peer.address, envelope({ senderPermissionClass: "prompts" }));
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") expect(outcome.retryable).toBe(true);
  });
  test("a peer reporting its own status as UNAVAILABLE is retryable", async () => {
    const { deps, peers } = makeAdapterDeps();
    const { peer } = fakePeer({ status: "unavailable" });
    peers.register(peer);
    const adapter = createReferenceMessagingAdapter(deps);
    const outcome = await adapter.deliverToSession(peer.address, envelope({ senderPermissionClass: "prompts" }));
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") expect(outcome.retryable).toBe(true);
  });
});

describe("deliverToSession: inbound policy (WS-10 §13)", () => {
  test("unavailable when the target peer isn't registered", async () => {
    const { deps } = makeAdapterDeps();
    const adapter = createReferenceMessagingAdapter(deps);
    const outcome = await adapter.deliverToSession({ objectKind: "session", runtimeKind: "winter-agent", winterSessionId: "s_ghost" }, envelope());
    expect(outcome.status).toBe("unavailable");
  });
  test("prompts receiver + prompts sender -> accept -> delivered when the peer is idle, delivered to peer.deliver", async () => {
    const { deps, peers } = makeAdapterDeps();
    const { peer, delivered } = fakePeer({ mode: "default", status: "idle" });
    peers.register(peer);
    const adapter = createReferenceMessagingAdapter(deps);
    const outcome = await adapter.deliverToSession(peer.address, envelope({ senderPermissionClass: "prompts" }));
    expect(outcome.status).toBe("delivered");
    expect(delivered).toHaveLength(1);
  });
  test("prompts receiver + prompts sender -> accept -> queued when the peer is running", async () => {
    const { deps, peers } = makeAdapterDeps();
    const { peer } = fakePeer({ mode: "default", status: "running" });
    peers.register(peer);
    const adapter = createReferenceMessagingAdapter(deps);
    const outcome = await adapter.deliverToSession(peer.address, envelope({ senderPermissionClass: "prompts" }));
    expect(outcome.status).toBe("queued");
  });
  test("prompts receiver + bypasses sender -> hold", async () => {
    const { deps, peers } = makeAdapterDeps();
    const { peer, delivered } = fakePeer({ mode: "default" });
    peers.register(peer);
    const adapter = createReferenceMessagingAdapter(deps);
    const outcome = await adapter.deliverToSession(peer.address, envelope({ senderPermissionClass: "bypasses" }));
    expect(outcome.status).toBe("held");
    expect(delivered).toHaveLength(0);
  });
  test("bypasses receiver + prompts sender -> hold; bypasses receiver + bypasses sender -> accept", async () => {
    const { deps, peers } = makeAdapterDeps();
    const { peer: bypassPeer } = fakePeer({ winterSessionId: "s_bypass", mode: "bypassPermissions", status: "idle" });
    peers.register(bypassPeer);
    const adapter = createReferenceMessagingAdapter(deps);
    expect((await adapter.deliverToSession(bypassPeer.address, envelope({ senderPermissionClass: "prompts" }))).status).toBe("held");
    expect((await adapter.deliverToSession(bypassPeer.address, envelope({ messageId: "m2", senderPermissionClass: "bypasses" }))).status).toBe("delivered");
  });
  test("plan receiver classifies as bypasses only when bypassAvailable() is true", async () => {
    const { deps, peers } = makeAdapterDeps();
    const { peer: planNoBypass } = fakePeer({ winterSessionId: "s_plan1", mode: "plan", bypassAvailable: false });
    const { peer: planWithBypass } = fakePeer({ winterSessionId: "s_plan2", mode: "plan", bypassAvailable: true, status: "idle" });
    peers.register(planNoBypass);
    peers.register(planWithBypass);
    const adapter = createReferenceMessagingAdapter(deps);
    // plan w/o bypass classifies as "prompts": a bypasses sender is held.
    expect((await adapter.deliverToSession(planNoBypass.address, envelope({ senderPermissionClass: "bypasses" }))).status).toBe("held");
    // plan w/ bypass classifies as "bypasses": a bypasses sender is accepted.
    expect((await adapter.deliverToSession(planWithBypass.address, envelope({ messageId: "m2", senderPermissionClass: "bypasses" }))).status).toBe("delivered");
  });
  test("an explicit crossSessionInbound: 'refuse' always wins over the default matrix", async () => {
    const { deps, peers } = makeAdapterDeps();
    const { peer } = fakePeer({ mode: "default", crossSessionInbound: "refuse" });
    peers.register(peer);
    const adapter = createReferenceMessagingAdapter(deps);
    const outcome = await adapter.deliverToSession(peer.address, envelope({ senderPermissionClass: "prompts" }));
    expect(outcome.status).toBe("refused");
  });
  test("an explicit crossSessionInbound: 'accept' always wins, even for a bypasses sender against a prompts receiver", async () => {
    const { deps, peers } = makeAdapterDeps();
    const { peer } = fakePeer({ mode: "default", crossSessionInbound: "accept", status: "idle" });
    peers.register(peer);
    const adapter = createReferenceMessagingAdapter(deps);
    const outcome = await adapter.deliverToSession(peer.address, envelope({ senderPermissionClass: "bypasses" }));
    expect(outcome.status).toBe("delivered");
  });
  test("held-inbox cap (100): the 101st hold is refused visibly", async () => {
    const { deps, peers } = makeAdapterDeps();
    const { peer } = fakePeer({ mode: "default" });
    peers.register(peer);
    const adapter = createReferenceMessagingAdapter(deps);
    for (let i = 0; i < HELD_INBOX_CAP; i++) {
      const outcome = await adapter.deliverToSession(peer.address, envelope({ messageId: `m${i}`, senderPermissionClass: "bypasses" }));
      expect(outcome.status).toBe("held");
    }
    const overflow = await adapter.deliverToSession(peer.address, envelope({ messageId: "overflow", senderPermissionClass: "bypasses" }));
    expect(overflow.status).toBe("refused");
  });
  test("accepted-queue cap (50) is enforced when the receiver is slow to actually consume deliveries", async () => {
    const { deps, peers } = makeAdapterDeps();
    const releases: Array<() => void> = [];
    const { peer } = fakePeer({
      deliver: () => new Promise<void>((resolve) => releases.push(resolve)),
    });
    peers.register(peer);
    const adapter = createReferenceMessagingAdapter(deps);
    // Each call executes synchronously up to its own `await peer.deliver(...)` before the next one
    // starts (JS's own single-threaded run-to-first-await semantics) -- so by the time this loop
    // finishes, calls 0..49 have each already incremented the accepted count and are pending on
    // `peer.deliver`, and call 50 has already observed the cap and resolved to `refused` WITHOUT
    // ever calling `peer.deliver` at all.
    const calls: Promise<DeliveryOutcome>[] = [];
    for (let i = 0; i <= ACCEPTED_QUEUE_CAP; i++) {
      calls.push(adapter.deliverToSession(peer.address, envelope({ messageId: `m${i}`, senderPermissionClass: "prompts" })));
    }
    expect(releases).toHaveLength(ACCEPTED_QUEUE_CAP);
    const overflowOutcome = await calls[ACCEPTED_QUEUE_CAP];
    expect(overflowOutcome?.status).toBe("refused");
    releases[0]?.();
    const firstOutcome = await calls[0];
    expect(firstOutcome?.status).toBe("queued");
  });
});

describe("subscribeIdle (WS-10 §14)", () => {
  test("refuses a non-session (agent) target", async () => {
    const { deps } = makeAdapterDeps();
    const adapter = createReferenceMessagingAdapter(deps);
    const outcome = await adapter.subscribeIdle({ objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: "s1", childId: "c1" }, { messageId: "m1" });
    expect(outcome.status).toBe("refused");
  });
  test("refuses an unregistered peer", async () => {
    const { deps } = makeAdapterDeps();
    const adapter = createReferenceMessagingAdapter(deps);
    const outcome = await adapter.subscribeIdle({ objectKind: "session", runtimeKind: "winter-agent", winterSessionId: "s_ghost" }, { messageId: "m1" });
    expect(outcome.status).toBe("refused");
  });
  test("refuses a peer with no reliable idle signal", async () => {
    const { deps, peers } = makeAdapterDeps();
    const { peer } = fakePeer({ hasReliableIdleSignal: false });
    peers.register(peer);
    const adapter = createReferenceMessagingAdapter(deps);
    expect((await adapter.subscribeIdle(peer.address, { messageId: "m1" })).status).toBe("refused");
  });
  test("an already-idle target fires the notice immediately", async () => {
    const { deps, peers, subscribers, notifications } = makeAdapterDeps();
    const { peer } = fakePeer({ status: "idle" });
    peers.register(peer);
    subscribers.remember("m1", "s_subscriber");
    const adapter = createReferenceMessagingAdapter(deps);
    const outcome = await adapter.subscribeIdle(peer.address, { messageId: "m1" });
    expect(outcome.status).toBe("subscribed");
    expect(notifications.pendingCount("s_subscriber")).toBe(1);
  });
  test("a running target does not fire immediately; firePeerIdleTransition fires it later, exactly once", async () => {
    const { deps, peers, subscribers, notifications } = makeAdapterDeps();
    const { peer, setStatus } = fakePeer({ status: "running" });
    peers.register(peer);
    subscribers.remember("m1", "s_subscriber");
    const adapter = createReferenceMessagingAdapter(deps);
    await adapter.subscribeIdle(peer.address, { messageId: "m1" });
    expect(notifications.pendingCount("s_subscriber")).toBe(0);
    setStatus("idle");
    adapter.firePeerIdleTransition(peer.address);
    expect(notifications.pendingCount("s_subscriber")).toBe(1);
    adapter.firePeerIdleTransition(peer.address); // a second transition never re-fires the same (already-consumed) subscription
    expect(notifications.pendingCount("s_subscriber")).toBe(1);
  });
  test("a reduced-status notice is produced when the subscriber (also a registered peer) would hold the idling target's class", async () => {
    const { deps, peers, subscribers, notifications } = makeAdapterDeps();
    const { peer: target, setStatus } = fakePeer({ winterSessionId: "s_target", mode: "bypassPermissions", status: "running" });
    const { peer: subscriberPeer } = fakePeer({ winterSessionId: "s_subscriber", mode: "default" }); // prompts receiver + bypasses sender -> hold
    peers.register(target);
    peers.register(subscriberPeer);
    subscribers.remember("m1", "s_subscriber");
    const adapter = createReferenceMessagingAdapter(deps);
    await adapter.subscribeIdle(target.address, { messageId: "m1" });
    setStatus("idle");
    adapter.firePeerIdleTransition(target.address);
    const { notifications: drained } = notifications.drain("s_subscriber");
    expect(drained[0]?.content).toContain("reduced-status");
  });
});

describe("senderPermissionClass", () => {
  test("classifies a child address from its own effectiveMode", async () => {
    const child = createFakeChildHandle({ id: "c1", parentSessionId: "s_parent", permission: { effectiveMode: "bypassPermissions", parentPolicyHash: "h", parentPolicyVersion: 1 } });
    const { deps } = makeAdapterDeps(() => [child]);
    const adapter = createReferenceMessagingAdapter(deps);
    const cls = await adapter.senderPermissionClass({ objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: "s_parent", childId: "c1" });
    expect(cls).toBe("bypasses");
  });
  test("classifies a peer address from its own mode + bypassAvailable", async () => {
    const { deps, peers } = makeAdapterDeps();
    const { peer } = fakePeer({ mode: "plan", bypassAvailable: true });
    peers.register(peer);
    const adapter = createReferenceMessagingAdapter(deps);
    expect(await adapter.senderPermissionClass(peer.address)).toBe("bypasses");
  });
  test("an unrecognized address is 'unknown'", async () => {
    const { deps } = makeAdapterDeps();
    const adapter = createReferenceMessagingAdapter(deps);
    expect(await adapter.senderPermissionClass({ objectKind: "session", runtimeKind: "winter-agent", winterSessionId: "s_ghost" })).toBe("unknown");
  });
});

describe("reevaluateHeldFor / sweepExpiredHeld (WS-10 §13)", () => {
  test("reevaluateHeldFor promotes a now-acceptable hold to an actual delivery", async () => {
    const { deps, peers } = makeAdapterDeps();
    const { peer, delivered } = fakePeer({ mode: "default", status: "idle" });
    peers.register(peer);
    const adapter = createReferenceMessagingAdapter(deps);
    await adapter.deliverToSession(peer.address, envelope({ senderPermissionClass: "bypasses" })); // held
    // The receiver's mode changed to bypassPermissions -- now bypasses×bypasses -> accept.
    Object.assign(peer, { mode: () => "bypassPermissions" as PermissionMode });
    const results = await adapter.reevaluateHeldFor(peer.address);
    expect(results).toEqual([{ messageId: "m1", outcome: { status: "delivered", messageId: "m1" } }]);
    expect(delivered).toHaveLength(1);
  });
  test("reevaluateHeldFor on an unregistered peer is a harmless no-op", async () => {
    const { deps } = makeAdapterDeps();
    const adapter = createReferenceMessagingAdapter(deps);
    expect(await adapter.reevaluateHeldFor({ objectKind: "session", runtimeKind: "winter-agent", winterSessionId: "s_ghost" })).toEqual([]);
  });
  test("sweepExpiredHeld refuses a default-class hold past its 5-minute expiry", async () => {
    const { deps, peers, setNow } = makeAdapterDeps();
    const { peer } = fakePeer({ mode: "default" });
    peers.register(peer);
    const adapter = createReferenceMessagingAdapter(deps);
    await adapter.deliverToSession(peer.address, envelope({ senderPermissionClass: "bypasses" })); // held at now=0
    setNow(DEFAULT_HOLD_EXPIRY_MS + 1);
    const results = adapter.sweepExpiredHeld();
    expect(results).toHaveLength(1);
    expect(results[0]?.outcome.status).toBe("refused");
  });
  test("an EXPLICIT hold has no dialog-expiry sweep of its own, but is still bounded by the message's own TTL (WS-10 §12)", async () => {
    const { deps, peers, setNow } = makeAdapterDeps();
    const { peer } = fakePeer({ mode: "default", crossSessionInbound: "hold" }); // forces kind: "explicit"
    peers.register(peer);
    const adapter = createReferenceMessagingAdapter(deps);
    const held = await adapter.deliverToSession(peer.address, envelope({ senderPermissionClass: "prompts", expiresAt: 500 }));
    expect(held.status).toBe("held");
    // Well past the message's own TTL (500) but nowhere near the (irrelevant, explicit-hold-exempt)
    // 5-minute default dialog expiry.
    setNow(501);
    const results = adapter.sweepExpiredHeld();
    expect(results).toHaveLength(1);
    expect(results[0]?.outcome).toEqual({ status: "refused", messageId: "m1", reason: expect.stringContaining("TTL") });
  });
  test("an EXPLICIT hold is left alone before its message TTL elapses", async () => {
    const { deps, peers, setNow } = makeAdapterDeps();
    const { peer } = fakePeer({ mode: "default", crossSessionInbound: "hold" });
    peers.register(peer);
    const adapter = createReferenceMessagingAdapter(deps);
    await adapter.deliverToSession(peer.address, envelope({ senderPermissionClass: "prompts", expiresAt: 500 }));
    setNow(499);
    expect(adapter.sweepExpiredHeld()).toEqual([]);
  });
});

describe("createDefaultMessagingRuntime: end-to-end wiring smoke test", () => {
  test("a full sendMessage call against the default-wired runtime delivers to a registered peer", async () => {
    const runtime = createDefaultMessagingRuntime({ now: () => 0 });
    const { peer, delivered } = fakePeer({ winterSessionId: "s_peer" });
    runtime.peers.register(peer);
    const caller: CallerContext = { sessionId: "s_caller", toolUseId: "tool-1" };
    const result = await sendMessage(runtime, caller, { to: "session:s_peer", message: "hello from the default wiring" });
    expect(result.outcome.status).toBe("queued");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.body).toBe("hello from the default wiring");
  });
});
