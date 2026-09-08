// Phase 4 Task 7 (Lane D, WS-10 §12): the single source of every numeric bound this reference
// enforces, plus typed `DeliveryOutcome` factory helpers (the union type itself is T3's own frozen
// messaging/adapter.ts) and the loop/rapid-repeat guard.
//
// PINNED vs PLACEHOLDER, marked individually below: WS-10 §13/§14 pin exact figures for the
// hold/accept queue caps and the two expiry windows (5 min / 12 h) -- those are cited verbatim.
// WS-10 §12 additionally REQUIRES a max body size, a finite TTL, a max hop count, and rapid-repeat
// dropping to exist, but (per WS-10 §17 Open Question 4 for the size bound, and simply no citation
// anywhere in WS-10/the companion doc for the other three) pins no exact figure for any of them --
// each such constant below is a Lane D CAPTURE-PENDING placeholder (T8 flag), versioned so a future
// capture can replace it without a silent behavior change.
import type { DeliveryOutcome, ListedRuntimeObject } from "./adapter.ts";

export const MAX_GLOBAL_MESSAGE_SIZE = 1_000_000; // CAPTURE-PENDING v1 (WS-10 §17 OQ4): official bound documented only as "about one million characters."
export const DEFAULT_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000; // CAPTURE-PENDING v1: no TTL value is pinned anywhere in WS-10/the companion doc; a conservative 24h default.
export const MAX_HOP_COUNT = 10; // CAPTURE-PENDING v1: no hop-count ceiling is pinned.
export const RAPID_REPEAT_WINDOW_MS = 5_000; // CAPTURE-PENDING v1: "identical rapid repeats dropped" -- no window is pinned.
export const HELD_INBOX_CAP = 100; // WS-10 §13 verbatim.
export const ACCEPTED_QUEUE_CAP = 50; // WS-10 §13 verbatim.
export const DEFAULT_HOLD_EXPIRY_MS = 5 * 60 * 1000; // WS-10 §13 verbatim ("5-minute dialog expiry").
export const NOTIFY_IDLE_EXPIRY_MS = 12 * 60 * 60 * 1000; // WS-10 §14 verbatim ("12-hour expiry").

export function messageExceedsMaxSize(body: string): boolean {
  return body.length > MAX_GLOBAL_MESSAGE_SIZE;
}

export function hopCountExceeded(hopCount: number): boolean {
  return hopCount >= MAX_HOP_COUNT;
}

// --- DeliveryOutcome factories -- avoid hand-typing the ten-variant union at every call site --------

export function delivered(messageId: string): DeliveryOutcome {
  return { status: "delivered", messageId };
}
export function queued(messageId: string): DeliveryOutcome {
  return { status: "queued", messageId };
}
export function resumedAndDelivered(messageId: string): DeliveryOutcome {
  return { status: "resumed_and_delivered", messageId };
}
export function held(messageId: string, reason: string): DeliveryOutcome {
  return { status: "held", messageId, reason };
}
export function subscribed(messageId: string): DeliveryOutcome {
  return { status: "subscribed", messageId };
}
export function deliveryUncertain(messageId: string, reason: string): DeliveryOutcome {
  return { status: "delivery_uncertain", messageId, deliveryMayHaveOccurred: true, reason };
}
export function refused(messageId: string, reason: string): DeliveryOutcome {
  return { status: "refused", messageId, reason };
}
export function ambiguous(messageId: string, candidates: ListedRuntimeObject[]): DeliveryOutcome {
  return { status: "ambiguous", messageId, candidates };
}
export function notFound(messageId: string, reason: string): DeliveryOutcome {
  return { status: "not_found", messageId, reason };
}
export function unavailable(messageId: string, retryable: boolean, reason: string): DeliveryOutcome {
  return { status: "unavailable", messageId, retryable, reason };
}

// --- Loop / rapid-repeat detection (WS-10 §12: "loop detection for repeated sender/target/message
// chains ... identical rapid repeats dropped with a visible outcome") ------------------------------
//
// T8 FLAG: no exact algorithm is pinned by WS-10/the companion doc. This reference tracks, per
// (from, to, body) signature, the last time it was sent; a repeat of the IDENTICAL triple within
// RAPID_REPEAT_WINDOW_MS is reported as a duplicate. Deliberately CONTENT-based and independent of
// router.ts's own per-(senderSessionId, toolUseId) messageId idempotency key: a genuine RETRY (same
// tool-call id) short-circuits to the stored outcome before this guard ever runs (router.ts); this
// guard instead catches a MODEL issuing the same content as a fresh call (a different tool-call id,
// hence a different messageId) in a tight loop -- the "loop detection for repeated ... chains" half
// of the same bullet, addressed by the identical mechanism rather than a separate graph analysis.
export interface LoopGuard {
  check(from: string, to: string, body: string, now: number): "ok" | "duplicate";
}

export function createLoopGuard(): LoopGuard {
  const lastSeen = new Map<string, number>();
  return {
    check(from, to, body, now) {
      const key = JSON.stringify([from, to, body]); // collision-safe: distinct triples can never coincide once each element is individually JSON-escaped
      const prev = lastSeen.get(key);
      lastSeen.set(key, now);
      if (prev !== undefined && now - prev < RAPID_REPEAT_WINDOW_MS) return "duplicate";
      return "ok";
    },
  };
}
