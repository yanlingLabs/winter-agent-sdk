import { describe, test, expect } from "bun:test";
import {
  MAX_GLOBAL_MESSAGE_SIZE,
  MAX_HOP_COUNT,
  RAPID_REPEAT_WINDOW_MS,
  messageExceedsMaxSize,
  hopCountExceeded,
  delivered,
  queued,
  resumedAndDelivered,
  held,
  subscribed,
  deliveryUncertain,
  refused,
  ambiguous,
  notFound,
  unavailable,
  createLoopGuard,
} from "./outcomes.ts";

describe("bounds predicates", () => {
  test("messageExceedsMaxSize is false at the boundary and true just over it", () => {
    expect(messageExceedsMaxSize("a".repeat(MAX_GLOBAL_MESSAGE_SIZE))).toBe(false);
    expect(messageExceedsMaxSize("a".repeat(MAX_GLOBAL_MESSAGE_SIZE + 1))).toBe(true);
  });
  test("hopCountExceeded is false below the cap and true at/over it", () => {
    expect(hopCountExceeded(MAX_HOP_COUNT - 1)).toBe(false);
    expect(hopCountExceeded(MAX_HOP_COUNT)).toBe(true);
    expect(hopCountExceeded(MAX_HOP_COUNT + 1)).toBe(true);
  });
});

describe("DeliveryOutcome factories produce exactly the pinned shapes (WS-10 §12)", () => {
  test("delivered / queued / resumed_and_delivered / subscribed carry only status+messageId", () => {
    expect(delivered("m1")).toEqual({ status: "delivered", messageId: "m1" });
    expect(queued("m1")).toEqual({ status: "queued", messageId: "m1" });
    expect(resumedAndDelivered("m1")).toEqual({ status: "resumed_and_delivered", messageId: "m1" });
    expect(subscribed("m1")).toEqual({ status: "subscribed", messageId: "m1" });
  });
  test("held / refused / not_found carry a reason", () => {
    expect(held("m1", "pending approval")).toEqual({ status: "held", messageId: "m1", reason: "pending approval" });
    expect(refused("m1", "nope")).toEqual({ status: "refused", messageId: "m1", reason: "nope" });
    expect(notFound("m1", "no such agent")).toEqual({ status: "not_found", messageId: "m1", reason: "no such agent" });
  });
  test("delivery_uncertain always carries deliveryMayHaveOccurred: true", () => {
    expect(deliveryUncertain("m1", "crash window")).toEqual({
      status: "delivery_uncertain",
      messageId: "m1",
      deliveryMayHaveOccurred: true,
      reason: "crash window",
    });
  });
  test("ambiguous carries the candidate list verbatim", () => {
    const candidates = [
      { address: "agent:s1:c1", objectKind: "agent" as const, runtimeKind: "winter-agent" as const, status: "running" as const, mode: "default", capabilities: { message: true, resume: false, notifyWhenIdle: false, reply: true } },
    ];
    expect(ambiguous("m1", candidates)).toEqual({ status: "ambiguous", messageId: "m1", candidates });
  });
  test("unavailable carries retryable + reason", () => {
    expect(unavailable("m1", true, "transient")).toEqual({ status: "unavailable", messageId: "m1", retryable: true, reason: "transient" });
    expect(unavailable("m1", false, "permanent")).toEqual({ status: "unavailable", messageId: "m1", retryable: false, reason: "permanent" });
  });
});

describe("createLoopGuard (WS-10 §12 rapid-repeat + loop detection)", () => {
  test("the first occurrence of a triple is always ok", () => {
    const guard = createLoopGuard();
    expect(guard.check("a", "b", "hello", 1000)).toBe("ok");
  });
  test("an identical triple repeated within the rapid-repeat window is a duplicate", () => {
    const guard = createLoopGuard();
    guard.check("a", "b", "hello", 1000);
    expect(guard.check("a", "b", "hello", 1000 + RAPID_REPEAT_WINDOW_MS - 1)).toBe("duplicate");
  });
  test("an identical triple repeated AFTER the window has elapsed is ok again", () => {
    const guard = createLoopGuard();
    guard.check("a", "b", "hello", 1000);
    expect(guard.check("a", "b", "hello", 1000 + RAPID_REPEAT_WINDOW_MS)).toBe("ok");
  });
  test("different bodies to the same (from,to) never collide", () => {
    const guard = createLoopGuard();
    guard.check("a", "b", "hello", 1000);
    expect(guard.check("a", "b", "goodbye", 1000)).toBe("ok");
  });
  test("the same body from a different sender never collides", () => {
    const guard = createLoopGuard();
    guard.check("a", "b", "hello", 1000);
    expect(guard.check("z", "b", "hello", 1000)).toBe("ok");
  });
  test("strings that could naively concatenate into the same key (delimiter confusion) are distinguished", () => {
    const guard = createLoopGuard();
    guard.check("a b", "c", "d", 1000);
    // Naive space-joining would make ("a b","c","d") collide with ("a","b c","d") or ("a","b","c d")
    expect(guard.check("a", "b c", "d", 1000)).toBe("ok");
    expect(guard.check("a", "b", "c d", 1000)).toBe("ok");
  });
});
