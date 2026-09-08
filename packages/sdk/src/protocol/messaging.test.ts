// The facet's wire guards, both directions.
//
// These run on BOTH sides of the pipe -- the runtime validates an incoming request before touching
// its adapter, the wrapper validates the answer before handing it to a router that will branch on
// it -- so a guard that accepted a bad shape would not fail loudly anywhere: the router would read
// `undefined` off a field it believes is present. Each test below therefore names the field whose
// absence would be read as a WRONG ANSWER rather than as a missing one.
import { describe, test, expect } from "bun:test";
import {
  MESSAGING_CONTROL_SUBTYPES,
  MESSAGING_CONTROL_SUBTYPE_LIST,
  isDeliveryOutcome,
  isGlobalAgentMessage,
  isListedRuntimeObjectArray,
  isMessagingChildRequest,
  isMessagingDeliverRequest,
  isMessagingSubscribeIdleRequest,
  isPermissionClassLabel,
  isRuntimeAddress,
  resolveFacetTarget,
} from "./messaging.ts";
import { buildChildAddress, buildSessionAddress, parseRuntimeAddress, serializeRuntimeAddress, type GlobalAgentMessage } from "../messaging/index.ts";

const SESSION = buildSessionAddress("s_1");
const CHILD = buildChildAddress("s_1", "c_1");

function envelope(overrides: Partial<GlobalAgentMessage> = {}): GlobalAgentMessage {
  return {
    messageId: "m1",
    from: SESSION,
    fromGeneration: 0,
    to: CHILD,
    toGeneration: 0,
    body: "hello",
    notifyWhenIdle: false,
    createdAt: 0,
    expiresAt: 0,
    hopCount: 0,
    senderPermissionClass: "prompts",
    ...overrides,
  };
}

describe("the six subtypes are one closed set", () => {
  test("the list and the record agree, and every value is namespaced", () => {
    expect([...MESSAGING_CONTROL_SUBTYPE_LIST].sort()).toEqual(Object.values(MESSAGING_CONTROL_SUBTYPES).sort());
    expect(MESSAGING_CONTROL_SUBTYPE_LIST).toHaveLength(6);
    // The `messaging.` prefix is what keeps these from ever colliding with the pinned subtypes
    // (`interrupt`, `set_model`, `list_models`, ...), which carry no namespace at all.
    for (const subtype of MESSAGING_CONTROL_SUBTYPE_LIST) expect(subtype.startsWith("messaging.")).toBe(true);
  });
});

describe("isRuntimeAddress", () => {
  test("accepts both canonical forms", () => {
    expect(isRuntimeAddress(SESSION)).toBe(true);
    expect(isRuntimeAddress(CHILD)).toBe(true);
  });

  test("refuses an `agent` address with no childId -- the one shape serializeRuntimeAddress THROWS on", () => {
    // Accepting it would push a programmer error a layer deeper, into a throw inside the adapter,
    // where it reads as an adapter fault rather than a malformed request.
    expect(isRuntimeAddress({ objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: "s_1" })).toBe(false);
    expect(() => serializeRuntimeAddress({ objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: "s_1" })).toThrow();
  });

  test("refuses a foreign objectKind/runtimeKind, an empty session id, and non-objects", () => {
    expect(isRuntimeAddress({ ...SESSION, objectKind: "workflow" })).toBe(false);
    expect(isRuntimeAddress({ ...SESSION, runtimeKind: "gemini-agent" })).toBe(false);
    expect(isRuntimeAddress({ ...SESSION, winterSessionId: "" })).toBe(false);
    expect(isRuntimeAddress(null)).toBe(false);
    expect(isRuntimeAddress([SESSION])).toBe(false);
    expect(isRuntimeAddress("session:s_1")).toBe(false); // the SERIALIZED form is not the address
  });
});

describe("isGlobalAgentMessage", () => {
  test("accepts a well-formed envelope", () => {
    expect(isGlobalAgentMessage(envelope())).toBe(true);
  });

  test("refuses one whose `to` is not an address -- the field the handler routes on", () => {
    expect(isGlobalAgentMessage(envelope({ to: "agent:s_1:c_1" as unknown as GlobalAgentMessage["to"] }))).toBe(false);
    expect(isGlobalAgentMessage({ ...envelope(), to: undefined })).toBe(false);
  });

  test("refuses one with no messageId -- the outcome would echo an id the router never allocated", () => {
    expect(isGlobalAgentMessage({ ...envelope(), messageId: "" })).toBe(false);
  });

  test("refuses a foreign senderPermissionClass -- WS-10 §13's matrix has exactly three inputs", () => {
    // A fourth value would fall through `defaultInboundResult`'s comparisons and silently take the
    // "not bypasses" branch, i.e. an unknown sender would be treated as a known one.
    expect(isGlobalAgentMessage({ ...envelope(), senderPermissionClass: "admin" })).toBe(false);
  });

  test("refuses a non-string body and a non-boolean notifyWhenIdle", () => {
    expect(isGlobalAgentMessage({ ...envelope(), body: 42 })).toBe(false);
    expect(isGlobalAgentMessage({ ...envelope(), notifyWhenIdle: "yes" })).toBe(false);
  });
});

describe("isDeliveryOutcome", () => {
  test("accepts all ten statuses WS-10 §6.2 defines", () => {
    for (const status of ["delivered", "queued", "resumed_and_delivered", "held", "subscribed", "delivery_uncertain", "refused", "not_found"]) {
      expect([status, isDeliveryOutcome({ status, messageId: "m1", reason: "r", deliveryMayHaveOccurred: true })]).toEqual([status, true]);
    }
    expect(isDeliveryOutcome({ status: "ambiguous", messageId: "m1", candidates: [] })).toBe(true);
    expect(isDeliveryOutcome({ status: "unavailable", messageId: "m1", retryable: true, reason: "r" })).toBe(true);
  });

  test("refuses `ambiguous` with no candidates array -- 'the router never chooses arbitrarily' needs the candidates", () => {
    expect(isDeliveryOutcome({ status: "ambiguous", messageId: "m1" })).toBe(false);
  });

  test("refuses `unavailable` with no `retryable` -- undefined is neither of the two answers §6.2 defines", () => {
    expect(isDeliveryOutcome({ status: "unavailable", messageId: "m1", reason: "r" })).toBe(false);
  });

  test("refuses an invented status and a missing messageId", () => {
    expect(isDeliveryOutcome({ status: "maybe", messageId: "m1" })).toBe(false);
    expect(isDeliveryOutcome({ status: "delivered" })).toBe(false);
  });
});

describe("the request guards", () => {
  test("deliver requires a well-formed envelope and nothing else", () => {
    expect(isMessagingDeliverRequest({ message: envelope() })).toBe(true);
    expect(isMessagingDeliverRequest({ message: { messageId: "" } })).toBe(false);
    expect(isMessagingDeliverRequest({})).toBe(false);
  });

  test("steer/resume require a NON-EMPTY id: an empty one would address the session itself as a child", () => {
    expect(isMessagingChildRequest({ id: "c_1", message: envelope() })).toBe(true);
    expect(isMessagingChildRequest({ id: "", message: envelope() })).toBe(false);
    expect(isMessagingChildRequest({ message: envelope() })).toBe(false);
  });

  test("subscribe_idle requires an id and the CALLER's messageId; subscriberSessionId is optional but typed", () => {
    expect(isMessagingSubscribeIdleRequest({ id: "c_1", messageId: "m1" })).toBe(true);
    expect(isMessagingSubscribeIdleRequest({ id: "c_1", messageId: "m1", subscriberSessionId: "s_2" })).toBe(true);
    expect(isMessagingSubscribeIdleRequest({ id: "c_1" })).toBe(false); // no messageId -> the notice could never be correlated back
    expect(isMessagingSubscribeIdleRequest({ id: "c_1", messageId: "m1", subscriberSessionId: 7 })).toBe(false);
  });
});

describe("the response guards", () => {
  test("isListedRuntimeObjectArray accepts a real listing and refuses rows missing what a router reads", () => {
    const row = { address: "agent:s_1:c_1", objectKind: "agent", runtimeKind: "winter-agent", status: "running", mode: "default", capabilities: { message: true, resume: false, notifyWhenIdle: false, reply: true } };
    expect(isListedRuntimeObjectArray([])).toBe(true);
    expect(isListedRuntimeObjectArray([row])).toBe(true);
    expect(isListedRuntimeObjectArray([{ ...row, capabilities: undefined }])).toBe(false); // steer-vs-resume is chosen off these flags
    expect(isListedRuntimeObjectArray([{ ...row, address: 7 }])).toBe(false);
    expect(isListedRuntimeObjectArray({ rows: [row] })).toBe(false); // a bare array, never an envelope
  });

  test("isPermissionClassLabel is exactly the three §13 inputs", () => {
    expect(["prompts", "bypasses", "unknown"].every(isPermissionClassLabel)).toBe(true);
    expect(isPermissionClassLabel("plan")).toBe(false);
    expect(isPermissionClassLabel(undefined)).toBe(false);
  });
});

describe("resolveFacetTarget: the one addressing rule the facet owns", () => {
  const resolve = (sessionId: string, id: string) => resolveFacetTarget(sessionId, id, parseRuntimeAddress, buildChildAddress);

  test("a canonical address is used exactly as given -- including one owned by ANOTHER session", () => {
    expect(resolve("s_1", "agent:s_1:c_1")).toEqual(CHILD);
    expect(resolve("s_1", "session:s_2")).toEqual(buildSessionAddress("s_2"));
    // Reach beyond the session is NOT decided here: the adapter refuses a child of another parent
    // (WS-10 §10.3), and it must be the one that does, so the refusal is uniform for every caller.
    expect(resolve("s_1", "agent:s_2:c_9")).toEqual(buildChildAddress("s_2", "c_9"));
  });

  test("a bare id is a CHILD id inside the receiving session", () => {
    expect(resolve("s_1", "c_1")).toEqual(CHILD);
  });

  test("a display NAME is not resolved -- it becomes a child id that simply will not match", () => {
    // The load-bearing negative: rules 3/4/5 (name -> object, ambiguity, staleness) are inseparable
    // and need the whole directory, which is the router's. A facet that resolved a name here would
    // be a second implementation of §11 that never got its ambiguity or staleness checks.
    expect(resolve("s_1", "researcher")).toEqual(buildChildAddress("s_1", "researcher"));
  });
});
