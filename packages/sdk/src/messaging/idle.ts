// Phase 4 Task 7 (Lane D, WS-10 §14): `notify_when_idle` eligibility checks, the one-shot idle
// subscription store, and the notification queue `ReadNotifications` drains.
//
// T8 FLAG (scope judgment call): WS-10/the companion doc pin `notify_when_idle`'s own one-shot
// idle/exit notice in detail, but neither text says whether a delivered cross-session MESSAGE (as
// opposed to an idle notice) also surfaces through this same queue, and no other Phase-4 file
// produces a second kind of entry for it. This reference therefore treats the notification queue as
// carrying idle/exit notices ONLY -- the sole producer pinned by spec. A future phase that wants
// ReadNotifications to also surface e.g. background-task completions can push into the identical
// `NotificationQueue` this file exports without any shape change.
import type { RuntimeObjectKind } from "./adapter.ts";
import { NOTIFY_IDLE_EXPIRY_MS } from "./outcomes.ts";

// WS-10 §14: "Only a main conversation may subscribe" -- the SENDER-side eligibility half.
export function isIdleSubscribeSenderAllowed(sender: { isChild: boolean }): boolean {
  return !sender.isChild;
}

// WS-10 §14: "subagents, teammates, cloud/remote targets, and adapters without a reliable idle
// signal MUST refuse the entire call" -- the TARGET-side eligibility half. `objectKind !== "session"`
// covers subagents/children in this reference's own vocabulary; a "teammate"/remote peer is,
// structurally, ALSO a "session" address in WS-10 §11's scheme, so `hasReliableIdleSignal` is how
// THIS reference's own PeerSessionHandle (reference-adapter.ts) opts a peer out when it cannot
// reliably signal idleness -- the reference's stand-in for "teammate/remote/no reliable signal."
export function isIdleSubscribeTargetAllowed(target: { objectKind: RuntimeObjectKind; hasReliableIdleSignal: boolean }): boolean {
  return target.objectKind === "session" && target.hasReliableIdleSignal;
}

export interface NotificationRecord {
  notification_id: string;
  origin: string;
  queued_at: string;
  content: string;
}

export interface NotificationQueue {
  push(ownerKey: string, rec: { origin: string; content: string; queuedAtMs: number }): void;
  /**
   * PHASE 7B: observe every push, WITHOUT consuming it. Returns an unsubscribe.
   *
   * The queue is the DURABLE record a host drains; this is the live signal a host can act on
   * immediately. They are deliberately the same notice, correlated by `notification_id`: a listener
   * that never fires (a crashed host, a host that reconnects later) loses nothing, because the entry
   * is still queued for the drain -- which is what makes WS-15 §6.4's restart recovery possible at
   * all. A listener must therefore NOT drain in response; the host acknowledges by draining.
   *
   * OPTIONAL, so a host that supplies its own `NotificationQueue` implementation still satisfies this
   * interface. Its absence degrades to "drain only", never to a dropped notice.
   */
  subscribe?(listener: (ownerKey: string, rec: NotificationRecord) => void): () => void;
  // Drains up to `max` (default: all) queued notifications for `ownerKey`, oldest first, and reports
  // how many remain -- the exact `ReadNotificationsOutput` shape (WS-06 §3.6 pinned):
  // `{notifications, remaining}`.
  drain(ownerKey: string, max?: number): { notifications: NotificationRecord[]; remaining: number };
  pendingCount(ownerKey: string): number;
}

export function createNotificationQueue(): NotificationQueue {
  const byOwner = new Map<string, NotificationRecord[]>();
  let listeners: Array<(ownerKey: string, rec: NotificationRecord) => void> = [];
  let counter = 0;
  return {
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    },
    push(ownerKey, rec) {
      const list = byOwner.get(ownerKey) ?? [];
      const record: NotificationRecord = {
        notification_id: `note-${++counter}`,
        origin: rec.origin,
        queued_at: new Date(rec.queuedAtMs).toISOString(),
        content: rec.content,
      };
      list.push(record);
      byOwner.set(ownerKey, list);
      // AFTER the entry is queued, never before: a listener that throws must not be able to leave the
      // durable record unwritten, and a listener that (wrongly) drains must find the entry there.
      for (const listener of listeners) listener(ownerKey, record);
    },
    drain(ownerKey, max) {
      const list = byOwner.get(ownerKey) ?? [];
      const take = max === undefined ? list.length : Math.max(0, Math.min(max, list.length));
      const notifications = list.splice(0, take);
      const remaining = list.length;
      if (list.length === 0) byOwner.delete(ownerKey);
      else byOwner.set(ownerKey, list);
      return { notifications, remaining };
    },
    pendingCount(ownerKey) {
      return byOwner.get(ownerKey)?.length ?? 0;
    },
  };
}

export interface PendingIdleSubscription {
  messageId: string;
  subscriberKey: string; // whichever session's own ReadNotifications queue receives the eventual notice
  targetKey: string; // the address (serialized) being watched
  createdAt: number;
  expiresAt: number;
}

// WS-10 §14 + item (e) addendum's "apply inbound policy to the returning notice ... held
// subscriptions deliver a reduced-status notice, not treated as ordinary delivered text." The
// caller (reference-adapter.ts) computes each firing subscriber's own `computeReducedStatus` result
// (IdleSubscriptionStore.fireIdle, below) by running the SAME inbound-policy decision used for
// ordinary messages, treating the idling target as the "sender" of its own notice.

export interface IdleSubscriptionStore {
  subscribe(sub: Omit<PendingIdleSubscription, "createdAt" | "expiresAt">, now: number): void;
  // Called when `targetKey` transitions to idle/exited: fires (and removes) every still-unexpired
  // pending subscription for that target, pushing one notice each into `queue` for its own
  // subscriber. Returns how many notices were pushed. WS-10 §14: "emit AT MOST ONE notice" per
  // subscription -- guaranteed structurally here since a fired (or expired) subscription is removed
  // from `pending` and can never fire twice.
  //
  // `computeReducedStatus` is a FUNCTION of the firing subscriber, not a single shared flag: a
  // target with multiple simultaneous subscribers may owe a full notice to one and a reduced-status
  // notice to another (each subscriber's own inbound-policy decision against the SAME idling
  // target's class can differ) -- a static boolean shared across every match in one `fireIdle` call
  // would silently pick one subscriber's answer for all of them.
  fireIdle(targetKey: string, now: number, computeReducedStatus: (subscriberKey: string) => boolean, queue: NotificationQueue, originLabel: string): number;
  sweepExpired(now: number): void;
  pendingCount(targetKey: string): number;
}

export function createIdleSubscriptionStore(): IdleSubscriptionStore {
  let pending: PendingIdleSubscription[] = [];
  return {
    subscribe(sub, now) {
      pending.push({ ...sub, createdAt: now, expiresAt: now + NOTIFY_IDLE_EXPIRY_MS });
    },
    fireIdle(targetKey, now, computeReducedStatus, queue, originLabel) {
      const matches = pending.filter((p) => p.targetKey === targetKey && p.expiresAt > now);
      pending = pending.filter((p) => p.targetKey !== targetKey);
      for (const m of matches) {
        const reducedStatus = computeReducedStatus(m.subscriberKey);
        queue.push(m.subscriberKey, {
          origin: originLabel,
          content: reducedStatus
            ? `${originLabel} changed state (reduced-status notice: the subscribing session is currently holding cross-session messages from this sender's class)`
            : `${originLabel} is now idle`,
          queuedAtMs: now,
        });
      }
      return matches.length;
    },
    sweepExpired(now) {
      pending = pending.filter((p) => p.expiresAt > now);
    },
    pendingCount(targetKey) {
      return pending.filter((p) => p.targetKey === targetKey).length;
    },
  };
}
