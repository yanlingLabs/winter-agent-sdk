import { describe, test, expect } from "bun:test";
import {
  classifyPermissionMode,
  mapFromModeToPermissionClass,
  defaultInboundResult,
  resolveInboundDecision,
  createMailbox,
  buildDefaultHoldEntry,
  buildExplicitHoldEntry,
} from "./inbound.ts";
import { HELD_INBOX_CAP, ACCEPTED_QUEUE_CAP, DEFAULT_HOLD_EXPIRY_MS } from "./outcomes.ts";

describe("classifyPermissionMode (WS-10 §13)", () => {
  test("default/acceptEdits/dontAsk/auto classify as prompts regardless of bypassAvailable", () => {
    for (const mode of ["default", "acceptEdits", "dontAsk", "auto"] as const) {
      expect(classifyPermissionMode(mode, { bypassAvailable: false })).toBe("prompts");
      expect(classifyPermissionMode(mode, { bypassAvailable: true })).toBe("prompts");
    }
  });
  test("bypassPermissions always classifies as bypasses", () => {
    expect(classifyPermissionMode("bypassPermissions", { bypassAvailable: false })).toBe("bypasses");
    expect(classifyPermissionMode("bypassPermissions", { bypassAvailable: true })).toBe("bypasses");
  });
  test("plan classifies as bypasses only when bypass is available to that session", () => {
    expect(classifyPermissionMode("plan", { bypassAvailable: true })).toBe("bypasses");
    expect(classifyPermissionMode("plan", { bypassAvailable: false })).toBe("prompts");
  });
});

describe("mapFromModeToPermissionClass (Open Question 7 mapping, never called by production code)", () => {
  test("'bypass' maps to 'bypasses'", () => {
    expect(mapFromModeToPermissionClass("bypass")).toBe("bypasses");
  });
  test("'prompting' maps to 'prompts'", () => {
    expect(mapFromModeToPermissionClass("prompting")).toBe("prompts");
  });
  test("absence maps to 'unknown' (the pinned field's implicit third state)", () => {
    expect(mapFromModeToPermissionClass(undefined)).toBe("unknown");
  });
});

describe("defaultInboundResult -- the exact WS-10 §13 five-row table", () => {
  test("prompts x prompts -> accept", () => expect(defaultInboundResult("prompts", "prompts")).toBe("accept"));
  test("prompts x unknown -> accept", () => expect(defaultInboundResult("prompts", "unknown")).toBe("accept"));
  test("prompts x bypasses -> hold", () => expect(defaultInboundResult("prompts", "bypasses")).toBe("hold"));
  test("bypasses x bypasses -> accept", () => expect(defaultInboundResult("bypasses", "bypasses")).toBe("accept"));
  test("bypasses x prompts -> hold", () => expect(defaultInboundResult("bypasses", "prompts")).toBe("hold"));
  test("bypasses x unknown -> hold", () => expect(defaultInboundResult("bypasses", "unknown")).toBe("hold"));
});

describe("resolveInboundDecision", () => {
  test("an unauthenticated route is refused before the matrix, regardless of classes", () => {
    expect(resolveInboundDecision({ authenticated: false, receiverClass: "prompts", senderClass: "prompts" })).toBe("refuse");
  });
  test("an explicit receiver setting always wins over the default matrix", () => {
    expect(resolveInboundDecision({ authenticated: true, explicitSetting: "refuse", receiverClass: "prompts", senderClass: "prompts" })).toBe("refuse");
    expect(resolveInboundDecision({ authenticated: true, explicitSetting: "accept", receiverClass: "bypasses", senderClass: "prompts" })).toBe("accept");
    expect(resolveInboundDecision({ authenticated: true, explicitSetting: "hold", receiverClass: "prompts", senderClass: "prompts" })).toBe("hold");
  });
  test("with no explicit setting, falls through to the default matrix", () => {
    expect(resolveInboundDecision({ authenticated: true, receiverClass: "prompts", senderClass: "bypasses" })).toBe("hold");
    expect(resolveInboundDecision({ authenticated: true, receiverClass: "bypasses", senderClass: "bypasses" })).toBe("accept");
  });
});

describe("Mailbox: held cap (100)", () => {
  test("holding up to the cap succeeds; the (cap+1)th is refused visibly", () => {
    const mailbox = createMailbox();
    for (let i = 0; i < HELD_INBOX_CAP; i++) {
      expect(mailbox.hold("receiver-1", buildDefaultHoldEntry(`m${i}`, "pending", 0))).toBe(true);
    }
    expect(mailbox.heldCount("receiver-1")).toBe(HELD_INBOX_CAP);
    expect(mailbox.hold("receiver-1", buildDefaultHoldEntry("overflow", "pending", 0))).toBe(false);
    expect(mailbox.heldCount("receiver-1")).toBe(HELD_INBOX_CAP); // overflow never actually enqueued
  });
  test("different receivers have independent caps", () => {
    const mailbox = createMailbox();
    for (let i = 0; i < HELD_INBOX_CAP; i++) mailbox.hold("r1", buildDefaultHoldEntry(`m${i}`, "pending", 0));
    expect(mailbox.hold("r2", buildDefaultHoldEntry("first", "pending", 0))).toBe(true);
  });
});

describe("Mailbox: accepted queue cap (50)", () => {
  test("accepting up to the cap succeeds; the (cap+1)th is refused visibly", () => {
    const mailbox = createMailbox();
    for (let i = 0; i < ACCEPTED_QUEUE_CAP; i++) expect(mailbox.accept("receiver-1")).toBe(true);
    expect(mailbox.acceptedCount("receiver-1")).toBe(ACCEPTED_QUEUE_CAP);
    expect(mailbox.accept("receiver-1")).toBe(false);
  });
  test("releaseAccepted frees capacity for a subsequent accept", () => {
    const mailbox = createMailbox();
    for (let i = 0; i < ACCEPTED_QUEUE_CAP; i++) mailbox.accept("receiver-1");
    expect(mailbox.accept("receiver-1")).toBe(false);
    mailbox.releaseAccepted("receiver-1", 1);
    expect(mailbox.accept("receiver-1")).toBe(true);
  });
  test("releaseAccepted never goes negative", () => {
    const mailbox = createMailbox();
    mailbox.releaseAccepted("receiver-1", 5);
    expect(mailbox.acceptedCount("receiver-1")).toBe(0);
  });
});

describe("Mailbox: takeHeld / listHeld", () => {
  test("takeHeld removes and returns the matching entry; a second call returns undefined", () => {
    const mailbox = createMailbox();
    mailbox.hold("r1", buildDefaultHoldEntry("m1", "pending", 0));
    expect(mailbox.listHeld("r1")).toHaveLength(1);
    const taken = mailbox.takeHeld("r1", "m1");
    expect(taken?.messageId).toBe("m1");
    expect(mailbox.listHeld("r1")).toHaveLength(0);
    expect(mailbox.takeHeld("r1", "m1")).toBeUndefined();
  });
  test("takeHeld on an unknown receiver returns undefined rather than throwing", () => {
    const mailbox = createMailbox();
    expect(mailbox.takeHeld("nobody", "m1")).toBeUndefined();
  });
});

describe("Mailbox: sweepExpired (WS-10 §13 default-class 5-minute dialog expiry)", () => {
  test("a default-class hold past its expiry is swept and returned", () => {
    const mailbox = createMailbox();
    mailbox.hold("r1", buildDefaultHoldEntry("m1", "pending", 0));
    const expired = mailbox.sweepExpired("r1", DEFAULT_HOLD_EXPIRY_MS + 1);
    expect(expired.map((e) => e.messageId)).toEqual(["m1"]);
    expect(mailbox.listHeld("r1")).toHaveLength(0);
  });
  test("a default-class hold NOT yet past its expiry is left alone", () => {
    const mailbox = createMailbox();
    mailbox.hold("r1", buildDefaultHoldEntry("m1", "pending", 0));
    const expired = mailbox.sweepExpired("r1", DEFAULT_HOLD_EXPIRY_MS - 1);
    expect(expired).toEqual([]);
    expect(mailbox.listHeld("r1")).toHaveLength(1);
  });
  test("an explicit hold is never swept by expiry, no matter how much time passes", () => {
    const mailbox = createMailbox();
    mailbox.hold("r1", buildExplicitHoldEntry("m1", "needs human approval", 0));
    const expired = mailbox.sweepExpired("r1", Number.MAX_SAFE_INTEGER);
    expect(expired).toEqual([]);
    expect(mailbox.listHeld("r1")).toHaveLength(1);
  });
});

describe("Mailbox: reevaluate (WS-10 §13 'held messages re-evaluated when receiver mode/settings change')", () => {
  test("a default-class hold that decide() now accepts is removed and reported", () => {
    const mailbox = createMailbox();
    mailbox.hold("r1", buildDefaultHoldEntry("m1", "pending", 0));
    const promoted = mailbox.reevaluate("r1", () => "accept");
    expect(promoted).toEqual([{ entry: expect.objectContaining({ messageId: "m1" }), next: "accept" }]);
    expect(mailbox.listHeld("r1")).toHaveLength(0);
  });
  test("a default-class hold that decide() still holds stays held", () => {
    const mailbox = createMailbox();
    mailbox.hold("r1", buildDefaultHoldEntry("m1", "pending", 0));
    const promoted = mailbox.reevaluate("r1", () => "hold");
    expect(promoted).toEqual([]);
    expect(mailbox.listHeld("r1")).toHaveLength(1);
  });
  test("an explicit hold is never auto-reevaluated away, even if decide() would accept it", () => {
    const mailbox = createMailbox();
    mailbox.hold("r1", buildExplicitHoldEntry("m1", "needs human approval", 0));
    const promoted = mailbox.reevaluate("r1", () => "accept");
    expect(promoted).toEqual([]);
    expect(mailbox.listHeld("r1")).toHaveLength(1);
  });
});
