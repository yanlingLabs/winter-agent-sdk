// The three messaging handlers, over a FAKE port (ruling P-3) -- no router, no adapter, no runtime.
//
// That is the point of the port: the handlers validate, name the caller, and render the outcome, and
// nothing else. Everything below is therefore a statement about the model-facing contract (what is
// refused, what carries `isError`, what the result text is) rather than about routing.
import { describe, expect, test } from "bun:test";

import {
  createMessagingToolHandlers,
  toolUseIdFromExtra,
  VENDOR_TOOL_USE_ID_META_KEY,
  type ListedRuntimeObject,
  type MessagingToolPort,
  type NotificationRecord,
  type RuntimeAddress,
  type SendMessageResult,
  type WinterToolCaller,
} from "./index.ts";
import type { DeliveryOutcome } from "../messaging/index.ts";

interface Recorder {
  port: MessagingToolPort;
  sends: Array<{ from: RuntimeAddress; to: string; body: string; summary?: string; notifyWhenIdle?: boolean; originToolCallId?: string }>;
  lists: Array<{ from: RuntimeAddress }>;
  reads: string[];
}

function recordingPort(config: { outcome?: DeliveryOutcome; notify?: SendMessageResult["notify"]; rows?: ListedRuntimeObject[]; notifications?: NotificationRecord[]; remaining?: number } = {}): Recorder {
  const sends: Recorder["sends"] = [];
  const lists: Recorder["lists"] = [];
  const reads: string[] = [];
  const port: MessagingToolPort = {
    async sendDetailed(request) {
      sends.push(request);
      const outcome = config.outcome ?? ({ status: "queued", messageId: "m_1" } as DeliveryOutcome);
      return config.notify === undefined ? { outcome } : { outcome, notify: config.notify };
    },
    async listReachable(scope) {
      lists.push(scope);
      return config.rows ?? [];
    },
    readNotifications(sessionId) {
      reads.push(sessionId);
      return { notifications: config.notifications ?? [], remaining: config.remaining ?? 0 };
    },
  };
  return { port, sends, lists, reads };
}

const CALLER: WinterToolCaller = { sessionId: "s_caller", toolUseId: "toolu_bound" };

function row(address: string, overrides: Partial<ListedRuntimeObject> = {}): ListedRuntimeObject {
  return {
    address,
    objectKind: "session",
    runtimeKind: "winter-agent",
    status: "running",
    mode: "default",
    capabilities: { message: true, resume: false, notifyWhenIdle: true, reply: true },
    ...overrides,
  };
}

describe("sendMessage: the caller is bound, never read out of the arguments", () => {
  test("a top-level caller sends AS its own session, and the typed outcome is the visible result", async () => {
    const recorder = recordingPort();
    const handlers = createMessagingToolHandlers(recorder.port, CALLER);
    const result = await handlers.sendMessage({ to: "reviewer", message: "take a look" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.text)).toEqual({ status: "queued", messageId: "m_1" });
    expect(recorder.sends[0]?.from).toEqual({ objectKind: "session", runtimeKind: "winter-agent", winterSessionId: "s_caller" });
    expect(recorder.sends[0]?.body).toBe("take a look");
    expect(recorder.sends[0]?.originToolCallId).toBe("toolu_bound");
  });

  test("a CHILD caller sends as `agent:<parent>:<child>`", async () => {
    const recorder = recordingPort();
    const handlers = createMessagingToolHandlers(recorder.port, { sessionId: "s_parent", agentId: "c1" });
    await handlers.sendMessage({ to: "sibling", message: "hi" });
    expect(recorder.sends[0]?.from).toEqual({ objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: "s_parent", parentWinterSessionId: "s_parent", childId: "c1" });
  });

  test("the caller may be a THUNK, re-read on every call", async () => {
    const recorder = recordingPort();
    let sessionId = "s_first";
    const handlers = createMessagingToolHandlers(recorder.port, () => ({ sessionId }));
    await handlers.sendMessage({ to: "x", message: "one" });
    sessionId = "s_second";
    await handlers.sendMessage({ to: "x", message: "two" });
    expect(recorder.sends.map((s) => s.from.winterSessionId)).toEqual(["s_first", "s_second"]);
  });
});

describe("WS-10 §12's retry key: the PER-CALL vendor tool-use id wins", () => {
  test("`extra._meta[\"claudecode/toolUseId\"]` is forwarded as originToolCallId over the bound one", async () => {
    const recorder = recordingPort();
    const handlers = createMessagingToolHandlers(recorder.port, CALLER);
    await handlers.sendMessage({ to: "x", message: "m" }, { _meta: { [VENDOR_TOOL_USE_ID_META_KEY]: "toolu_percall" } });
    expect(recorder.sends[0]?.originToolCallId).toBe("toolu_percall");
  });

  test("the reader is DEFENSIVE -- a missing or wrongly-typed key degrades to the bound id, never a crash", () => {
    expect(toolUseIdFromExtra(undefined)).toBeUndefined();
    expect(toolUseIdFromExtra(null)).toBeUndefined();
    expect(toolUseIdFromExtra({})).toBeUndefined();
    expect(toolUseIdFromExtra({ _meta: null })).toBeUndefined();
    expect(toolUseIdFromExtra({ _meta: { [VENDOR_TOOL_USE_ID_META_KEY]: 7 } })).toBeUndefined();
    expect(toolUseIdFromExtra({ _meta: { [VENDOR_TOOL_USE_ID_META_KEY]: "" } })).toBeUndefined();
    expect(toolUseIdFromExtra({ _meta: { [VENDOR_TOOL_USE_ID_META_KEY]: "toolu_x" } })).toBe("toolu_x");
  });

  test("a caller with NO tool-use id at all sends without one -- never a fabricated stable-looking key", async () => {
    const recorder = recordingPort();
    const handlers = createMessagingToolHandlers(recorder.port, { sessionId: "s1" });
    await handlers.sendMessage({ to: "x", message: "m" });
    expect(recorder.sends[0]?.originToolCallId).toBeUndefined();
  });
});

describe("RULING P-4: the four model-facing failures carry `isError: true`", () => {
  const failures: DeliveryOutcome[] = [
    { status: "refused", messageId: "m", reason: "not allowed" },
    { status: "ambiguous", messageId: "m", candidates: [] },
    { status: "not_found", messageId: "m", reason: "no such target" },
    { status: "unavailable", messageId: "m", retryable: true, reason: "gone" },
  ];

  for (const outcome of failures) {
    test(`\`${outcome.status}\` -> isError: true`, async () => {
      const recorder = recordingPort({ outcome });
      const handlers = createMessagingToolHandlers(recorder.port, CALLER);
      const result = await handlers.sendMessage({ to: "x", message: "m" });
      expect(result.isError).toBe(true);
      expect((JSON.parse(result.text) as { status: string }).status).toBe(outcome.status);
    });
  }

  const successes: DeliveryOutcome[] = [
    { status: "delivered", messageId: "m" },
    { status: "queued", messageId: "m" },
    { status: "held", messageId: "m", reason: "inbound policy" },
    { status: "subscribed", messageId: "m" },
  ];

  for (const outcome of successes) {
    test(`\`${outcome.status}\` -> no isError`, async () => {
      const recorder = recordingPort({ outcome });
      const handlers = createMessagingToolHandlers(recorder.port, CALLER);
      const result = await handlers.sendMessage({ to: "x", message: "m" });
      expect(result.isError).toBeUndefined();
    });
  }

  test("a REFUSED ARGUMENT is an error result too -- data the model corrects from, never a throw", async () => {
    const recorder = recordingPort();
    const handlers = createMessagingToolHandlers(recorder.port, CALLER);
    const result = await handlers.sendMessage({ to: "x", message: "m", priority: "high" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("priority");
    expect(recorder.sends).toHaveLength(0); // never entered the messaging system
  });
});

describe("sendMessage: the summary and the supplementary notify fact", () => {
  test("an absent summary is DERIVED from the first message line before it reaches the port", async () => {
    const recorder = recordingPort();
    const handlers = createMessagingToolHandlers(recorder.port, CALLER);
    await handlers.sendMessage({ to: "x", message: "first line\nsecond line" });
    expect(recorder.sends[0]?.summary).toBe("first line");
  });

  test("a combined call reports the idle subscription BESIDE the outcome, never as an eleventh status", async () => {
    const recorder = recordingPort({ notify: { subscribed: true } });
    const handlers = createMessagingToolHandlers(recorder.port, CALLER);
    const result = await handlers.sendMessage({ to: "x", message: "m", notify_when_idle: true });
    expect(JSON.parse(result.text)).toEqual({ status: "queued", messageId: "m_1", notify: { subscribed: true } });
    expect(recorder.sends[0]?.notifyWhenIdle).toBe(true);
  });
});

describe("listAgents: output is EXACTLY `{ listing: string }`", () => {
  test("the SDK's own formatter renders the port's rows, and the caller's row is NOT re-filtered here", async () => {
    // The port already excludes the caller (both hosts' `listReachable` do). Re-filtering here would
    // be a second copy of that rule, in the layer least able to know the caller's real address.
    const rows = [row("session:s_caller"), row("session:s_peer", { name: "reviewer" })];
    const recorder = recordingPort({ rows });
    const handlers = createMessagingToolHandlers(recorder.port, CALLER);
    const result = await handlers.listAgents({});
    expect(result.isError).toBeUndefined();
    const { listing } = JSON.parse(result.text) as { listing: string };
    expect(Object.keys(JSON.parse(result.text))).toEqual(["listing"]);
    expect(listing.split("\n")).toEqual([
      "- session:s_caller [session/winter-agent] status=running mode=default",
      "- reviewer (session:s_peer) [session/winter-agent] status=running mode=default",
    ]);
    expect(recorder.lists[0]?.from).toEqual({ objectKind: "session", runtimeKind: "winter-agent", winterSessionId: "s_caller" });
  });

  test("no rows -> the sentence, still inside the pinned one-field shape", async () => {
    const recorder = recordingPort({ rows: [] });
    const handlers = createMessagingToolHandlers(recorder.port, CALLER);
    expect(JSON.parse((await handlers.listAgents({})).text)).toEqual({ listing: "No agents or sessions are currently reachable." });
  });

  test("an unknown argument is refused rather than ignored", async () => {
    const recorder = recordingPort();
    const handlers = createMessagingToolHandlers(recorder.port, CALLER);
    const result = await handlers.listAgents({ limit: 5 });
    expect(result.isError).toBe(true);
    expect(recorder.lists).toHaveLength(0);
  });
});

describe("readNotifications: the drained page and what is left", () => {
  test("drains the CALLER's own queue and returns both fields", async () => {
    const notifications: NotificationRecord[] = [{ notification_id: "n1", origin: "session:s_peer", queued_at: "1970-01-01T00:00:05.000Z", content: "peer went idle" }];
    const recorder = recordingPort({ notifications, remaining: 2 });
    const handlers = createMessagingToolHandlers(recorder.port, CALLER);
    const result = await handlers.readNotifications({});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.text)).toEqual({ notifications, remaining: 2 });
    expect(recorder.reads).toEqual(["s_caller"]);
  });

  test("RULING P-4: a stray argument is refused, and nothing is drained", async () => {
    const recorder = recordingPort();
    const handlers = createMessagingToolHandlers(recorder.port, CALLER);
    const result = await handlers.readNotifications({ extra: 1 });
    expect(result.isError).toBe(true);
    expect(recorder.reads).toHaveLength(0);
  });
});
