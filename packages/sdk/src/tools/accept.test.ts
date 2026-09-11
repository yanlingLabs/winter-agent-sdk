// The acceptors, "no more and no less" (WS-10 §10.1/§10.2, ruling P-4).
//
// The first two describes are the router's own plants (`test/official/aliases-containment.test.ts`
// and `test/messaging/handlers.test.ts`), ported so the behaviour they pinned survives the move to
// this package. Where ruling P-4 CHANGED the answer -- an overlong `summary` is now truncated rather
// than refused -- the plant is carried in its new form and marked, never quietly dropped.
import { describe, expect, test } from "bun:test";

import {
  acceptNativeListAgentsArgs,
  acceptNativeReadNotificationsArgs,
  acceptNativeSendMessageArgs,
  deriveSendMessageSummary,
  SEND_MESSAGE_SUMMARY_MAX,
} from "./index.ts";

describe("SendMessage: every WS-10 §10.1 constraint, and no extra field", () => {
  test("the four native fields are taken exactly", () => {
    expect(acceptNativeSendMessageArgs({ to: "reviewer", message: "ping" })).toEqual({ ok: true, args: { to: "reviewer", message: "ping" } });
    expect(acceptNativeSendMessageArgs({ to: "r", message: "m", summary: "s", notify_when_idle: true })).toEqual({
      ok: true,
      args: { to: "r", message: "m", summary: "s", notify_when_idle: true },
    });
  });

  test('"no more" is as load-bearing as "no less": an extra field would be a second, undocumented schema', () => {
    expect(acceptNativeSendMessageArgs({ to: "r", message: "m", priority: "high" })).toEqual({ ok: false, reason: "unknown argument(s): priority" });
    // `from` is not in the native schema at all, so a model naming a different sender is refused as
    // an unknown argument rather than silently honoured -- every fence is keyed on caller identity.
    expect(acceptNativeSendMessageArgs({ to: "session:x", message: "hi", from: "session:root" }).ok).toBe(false);
  });

  test("`to` is validated by the messaging subpath's own rules, through the shared validator", () => {
    for (const [to, fragment] of [
      ["", "non-empty"],
      ["x".repeat(301), "300"],
      ["a\nb", "newline"],
      ["*", "broadcast"],
      ["a*b", "broadcast"],
    ] as const) {
      const result = acceptNativeSendMessageArgs({ to, message: "hi" });
      expect([to, result.ok]).toEqual([to, false]);
      if (!result.ok) expect([to, result.reason.includes(fragment)]).toEqual([to, true]);
    }
    expect(acceptNativeSendMessageArgs({ message: "m" }).ok).toBe(false);
    expect(acceptNativeSendMessageArgs({ to: "r" }).ok).toBe(false);
    expect(acceptNativeSendMessageArgs("nope").ok).toBe(false);
  });

  test("`notify_when_idle` must be a boolean", () => {
    expect(acceptNativeSendMessageArgs({ to: "r", message: "m", notify_when_idle: "yes" }).ok).toBe(false);
  });

  test("RULING P-4: an overlong `summary` is TRUNCATED to 200, never refused", () => {
    // The router's plant asserted a refusal here. P-4 resolves the divergence the Winter branch's
    // way: WS-10 §10.1 calls `summary` "truncated when overlong", which is a computed value, not a
    // validation error -- and refusing a call for a decoration the runtime can fix itself costs the
    // model a whole turn.
    const result = acceptNativeSendMessageArgs({ to: "r", message: "m", summary: "s".repeat(250) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.summary).toHaveLength(SEND_MESSAGE_SUMMARY_MAX);
      expect(result.args.summary).toBe("s".repeat(200));
    }
    // A non-string summary is still a type error, which truncation cannot repair.
    expect(acceptNativeSendMessageArgs({ to: "r", message: "m", summary: 7 }).ok).toBe(false);
  });

  test("RULING P-4: an EMPTY message is legal ONLY as the pure idle subscription", () => {
    // WS-10 §10.1's `""` is the pure idle subscription -- which is only meaningful WITH
    // notify_when_idle. The router's acceptor took a bare empty message and let the router decide;
    // P-4 puts the rule in the acceptor on both branches, where the model gets a correctable answer.
    expect(acceptNativeSendMessageArgs({ to: "r", message: "", notify_when_idle: true }).ok).toBe(true);
    const bare = acceptNativeSendMessageArgs({ to: "r", message: "" });
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.reason).toContain("notify_when_idle");
  });
});

describe("ListAgents: two reserved optional fields, nothing else", () => {
  test("`{}`, absent, and both reserved fields are accepted; anything else is not", () => {
    expect(acceptNativeListAgentsArgs({})).toEqual({ ok: true, args: {} });
    expect(acceptNativeListAgentsArgs(undefined)).toEqual({ ok: true, args: {} });
    expect(acceptNativeListAgentsArgs(null)).toEqual({ ok: true, args: {} });
    expect(acceptNativeListAgentsArgs({ channel: "c", q: "q" })).toEqual({ ok: true, args: { channel: "c", q: "q" } });
    expect(acceptNativeListAgentsArgs({ limit: 5 }).ok).toBe(false);
    expect(acceptNativeListAgentsArgs({ q: "x".repeat(257) }).ok).toBe(false);
    expect(acceptNativeListAgentsArgs({ channel: 5 }).ok).toBe(false);
  });
});

describe("ReadNotifications: the empty object, and only the empty object (ruling P-4)", () => {
  test("`{}` is accepted; a stray field is refused", () => {
    expect(acceptNativeReadNotificationsArgs({})).toEqual({ ok: true, args: {} });
    expect(acceptNativeReadNotificationsArgs(undefined)).toEqual({ ok: true, args: {} });
    const extra = acceptNativeReadNotificationsArgs({ extra: 1 });
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.reason).toContain("extra");
  });
});

describe("deriveSendMessageSummary (WS-10 §10.1: derived from the first message line when absent)", () => {
  test("an absent summary becomes the first line of the message, trimmed and capped", () => {
    expect(deriveSendMessageSummary(undefined, "  review the schema  \nand the second line")).toBe("review the schema");
    expect(deriveSendMessageSummary(undefined, "x".repeat(250))).toBe("x".repeat(200));
  });

  test("nothing to derive from -- an empty first line yields no summary at all", () => {
    expect(deriveSendMessageSummary(undefined, "")).toBeUndefined();
    expect(deriveSendMessageSummary(undefined, "\nsecond line only")).toBeUndefined();
  });

  test("a supplied summary wins, and is itself capped -- never a validation error", () => {
    expect(deriveSendMessageSummary("mine", "the message")).toBe("mine");
    expect(deriveSendMessageSummary("s".repeat(250), "the message")).toBe("s".repeat(200));
  });
});
