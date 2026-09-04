import { describe, test, expect } from "bun:test";
import {
  isIdleSubscribeSenderAllowed,
  isIdleSubscribeTargetAllowed,
  createNotificationQueue,
  createIdleSubscriptionStore,
} from "./idle.ts";
import { NOTIFY_IDLE_EXPIRY_MS } from "./outcomes.ts";

describe("isIdleSubscribeSenderAllowed (WS-10 §14: only a main conversation may subscribe)", () => {
  test("a top-level (non-child) sender is allowed", () => expect(isIdleSubscribeSenderAllowed({ isChild: false })).toBe(true));
  test("a child/subagent sender is refused", () => expect(isIdleSubscribeSenderAllowed({ isChild: true })).toBe(false));
});

describe("isIdleSubscribeTargetAllowed", () => {
  test("a session target with a reliable idle signal is allowed", () => {
    expect(isIdleSubscribeTargetAllowed({ objectKind: "session", hasReliableIdleSignal: true })).toBe(true);
  });
  test("a session target with NO reliable idle signal is refused", () => {
    expect(isIdleSubscribeTargetAllowed({ objectKind: "session", hasReliableIdleSignal: false })).toBe(false);
  });
  test("an agent (child/subagent) target is always refused, even with a reliable signal", () => {
    expect(isIdleSubscribeTargetAllowed({ objectKind: "agent", hasReliableIdleSignal: true })).toBe(false);
  });
});

describe("NotificationQueue (ReadNotifications drain shape: notification_id/origin/queued_at/content + remaining)", () => {
  test("push then drain returns the pushed record with a generated id and ISO timestamp", () => {
    const queue = createNotificationQueue();
    queue.push("owner-1", { origin: "session:s_abc", content: "session:s_abc is now idle", queuedAtMs: 0 });
    const { notifications, remaining } = queue.drain("owner-1");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.origin).toBe("session:s_abc");
    expect(notifications[0]?.content).toBe("session:s_abc is now idle");
    expect(notifications[0]?.queued_at).toBe(new Date(0).toISOString());
    expect(typeof notifications[0]?.notification_id).toBe("string");
    expect(remaining).toBe(0);
  });
  test("draining an empty/unknown owner returns an empty array and zero remaining", () => {
    const queue = createNotificationQueue();
    expect(queue.drain("nobody")).toEqual({ notifications: [], remaining: 0 });
  });
  test("drain with a max leaves the rest queued, oldest first, and reports the correct remaining count", () => {
    const queue = createNotificationQueue();
    queue.push("owner-1", { origin: "a", content: "first", queuedAtMs: 0 });
    queue.push("owner-1", { origin: "b", content: "second", queuedAtMs: 1 });
    queue.push("owner-1", { origin: "c", content: "third", queuedAtMs: 2 });
    const first = queue.drain("owner-1", 1);
    expect(first.notifications.map((n) => n.content)).toEqual(["first"]);
    expect(first.remaining).toBe(2);
    const rest = queue.drain("owner-1");
    expect(rest.notifications.map((n) => n.content)).toEqual(["second", "third"]);
    expect(rest.remaining).toBe(0);
  });
  test("draining fully empties the queue (a second drain call is empty)", () => {
    const queue = createNotificationQueue();
    queue.push("owner-1", { origin: "a", content: "x", queuedAtMs: 0 });
    queue.drain("owner-1");
    expect(queue.drain("owner-1")).toEqual({ notifications: [], remaining: 0 });
  });
  test("notification ids are unique across pushes", () => {
    const queue = createNotificationQueue();
    queue.push("owner-1", { origin: "a", content: "x", queuedAtMs: 0 });
    queue.push("owner-1", { origin: "a", content: "y", queuedAtMs: 0 });
    const { notifications } = queue.drain("owner-1");
    expect(notifications[0]?.notification_id).not.toBe(notifications[1]?.notification_id);
  });
  test("different owners have independent queues", () => {
    const queue = createNotificationQueue();
    queue.push("owner-1", { origin: "a", content: "x", queuedAtMs: 0 });
    expect(queue.pendingCount("owner-2")).toBe(0);
    expect(queue.pendingCount("owner-1")).toBe(1);
  });
});

describe("IdleSubscriptionStore (WS-10 §14 one-shot subscription + notice firing)", () => {
  test("firing an idle target with a pending subscription pushes exactly one notice, full text when not reduced", () => {
    const store = createIdleSubscriptionStore();
    const queue = createNotificationQueue();
    store.subscribe({ messageId: "m1", subscriberKey: "sub-1", targetKey: "session:target" }, 0);
    const fired = store.fireIdle("session:target", 1000, () => false, queue, "session:target");
    expect(fired).toBe(1);
    const { notifications } = queue.drain("sub-1");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.content).toBe("session:target is now idle");
  });
  test("a held subscription fires a reduced-status notice, not ordinary delivered text", () => {
    const store = createIdleSubscriptionStore();
    const queue = createNotificationQueue();
    store.subscribe({ messageId: "m1", subscriberKey: "sub-1", targetKey: "session:target" }, 0);
    store.fireIdle("session:target", 1000, () => true, queue, "session:target");
    const { notifications } = queue.drain("sub-1");
    expect(notifications[0]?.content).toContain("reduced-status");
    expect(notifications[0]?.content).not.toBe("session:target is now idle");
  });
  test("a fired subscription never fires again (at most one notice, WS-10 §14)", () => {
    const store = createIdleSubscriptionStore();
    const queue = createNotificationQueue();
    store.subscribe({ messageId: "m1", subscriberKey: "sub-1", targetKey: "session:target" }, 0);
    store.fireIdle("session:target", 1000, () => false, queue, "session:target");
    const secondFire = store.fireIdle("session:target", 2000, () => false, queue, "session:target");
    expect(secondFire).toBe(0);
    expect(queue.pendingCount("sub-1")).toBe(1); // only the first notice ever arrived
  });
  test("firing a target with no pending subscriptions is a harmless no-op", () => {
    const store = createIdleSubscriptionStore();
    const queue = createNotificationQueue();
    expect(store.fireIdle("session:nobody-watching", 0, () => false, queue, "session:nobody-watching")).toBe(0);
  });
  test("multiple subscribers to the same target each get their own notice", () => {
    const store = createIdleSubscriptionStore();
    const queue = createNotificationQueue();
    store.subscribe({ messageId: "m1", subscriberKey: "sub-1", targetKey: "session:target" }, 0);
    store.subscribe({ messageId: "m2", subscriberKey: "sub-2", targetKey: "session:target" }, 0);
    const fired = store.fireIdle("session:target", 1000, () => false, queue, "session:target");
    expect(fired).toBe(2);
    expect(queue.pendingCount("sub-1")).toBe(1);
    expect(queue.pendingCount("sub-2")).toBe(1);
  });
  test("computeReducedStatus is evaluated PER SUBSCRIBER -- two subscribers of the same target can get different notice kinds", () => {
    const store = createIdleSubscriptionStore();
    const queue = createNotificationQueue();
    store.subscribe({ messageId: "m1", subscriberKey: "sub-full", targetKey: "session:target" }, 0);
    store.subscribe({ messageId: "m2", subscriberKey: "sub-reduced", targetKey: "session:target" }, 0);
    store.fireIdle("session:target", 1000, (subscriberKey) => subscriberKey === "sub-reduced", queue, "session:target");
    expect(queue.drain("sub-full").notifications[0]?.content).toBe("session:target is now idle");
    expect(queue.drain("sub-reduced").notifications[0]?.content).toContain("reduced-status");
  });
  test("an expired subscription (12h, WS-10 §14) never fires, and sweepExpired removes it", () => {
    const store = createIdleSubscriptionStore();
    const queue = createNotificationQueue();
    store.subscribe({ messageId: "m1", subscriberKey: "sub-1", targetKey: "session:target" }, 0);
    expect(store.pendingCount("session:target")).toBe(1);
    store.sweepExpired(NOTIFY_IDLE_EXPIRY_MS + 1);
    expect(store.pendingCount("session:target")).toBe(0);
    const fired = store.fireIdle("session:target", NOTIFY_IDLE_EXPIRY_MS + 2, () => false, queue, "session:target");
    expect(fired).toBe(0);
  });
  test("a subscription exactly at its expiry boundary (not yet past) still fires", () => {
    const store = createIdleSubscriptionStore();
    const queue = createNotificationQueue();
    store.subscribe({ messageId: "m1", subscriberKey: "sub-1", targetKey: "session:target" }, 0);
    // expiresAt = NOTIFY_IDLE_EXPIRY_MS exactly; fireIdle at a time strictly before that must still match.
    const fired = store.fireIdle("session:target", NOTIFY_IDLE_EXPIRY_MS - 1, () => false, queue, "session:target");
    expect(fired).toBe(1);
  });
});
