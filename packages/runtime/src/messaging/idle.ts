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
  // Drains up to `max` (default: all) queued notifications for `ownerKey`, oldest first, and reports
  // how many remain -- the exact `ReadNotificationsOutput` shape (WS-06 §3.6 pinned):
  // `{notifications, remaining}`.
  drain(ownerKey: string, max?: number): { notifications: NotificationRecord[]; remaining: number };
  pendingCount(ownerKey: string): number;
}

export function createNotificationQueue(): NotificationQueue {
  const byOwner = new Map<string, NotificationRecord[]>();
  let counter = 0;
  return {
    push(ownerKey, rec) {
      const list = byOwner.get(ownerKey) ?? [];
      list.push({
        notification_id: `note-${++counter}`,
        origin: rec.origin,
        queued_at: new Date(rec.queuedAtMs).toISOString(),
        content: rec.content,
      });
      byOwner.set(ownerKey, list);
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

export interface FireIdleOptions {
  // WS-10 §14 + item (e) addendum's "apply inbound policy to the returning notice ... held
  // subscriptions deliver a reduced-status notice, not treated as ordinary delivered text." The
  // caller (reference-adapter.ts) computes this by running the SAME inbound-policy decision used for
  // ordinary messages, treating the idling target as the "sender" of its own notice.
  reducedStatus: boolean;
}

export interface IdleSubscriptionStore {
  subscribe(sub: Omit<PendingIdleSubscription, "createdAt" | "expiresAt">, now: number): void;
  // Called when `targetKey` transitions to idle/exited: fires (and removes) every still-unexpired
  // pending subscription for that target, pushing one notice each into `queue` for its own
  // subscriber. Returns how many notices were pushed. WS-10 §14: "emit AT MOST ONE notice" per
  // subscription -- guaranteed structurally here since a fired (or expired) subscription is removed
  // from `pending` and can never fire twice.
  fireIdle(targetKey: string, now: number, opts: FireIdleOptions, queue: NotificationQueue, originLabel: string): number;
  sweepExpired(now: number): void;
  pendingCount(targetKey: string): number;
}

export function createIdleSubscriptionStore(): IdleSubscriptionStore {
  let pending: PendingIdleSubscription[] = [];
  return {
    subscribe(sub, now) {
      pending.push({ ...sub, createdAt: now, expiresAt: now + NOTIFY_IDLE_EXPIRY_MS });
    },
    fireIdle(targetKey, now, opts, queue, originLabel) {
      const matches = pending.filter((p) => p.targetKey === targetKey && p.expiresAt > now);
      pending = pending.filter((p) => p.targetKey !== targetKey);
      for (const m of matches) {
        queue.push(m.subscriberKey, {
          origin: originLabel,
          content: opts.reducedStatus
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
