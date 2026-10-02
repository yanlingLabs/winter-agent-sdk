// Host messaging in the router core: WHEN the host is asked (only after in-process resolution says
// `not_found`), what it is told, how its answer becomes the outcome, and that the ledger keeps a retry
// from asking twice.
import { describe, expect, test } from "bun:test";
import { createFakeMessagingRouterSeam, type DeliveryOutcome, type ListedRuntimeObject, type RuntimeMessagingAdapter } from "./adapter.ts";
import { createLoopGuard } from "./outcomes.ts";
import { createNotificationQueue } from "./idle.ts";
import { createSubscriberDirectory, listAgents, sendMessage, type MessagingRuntimeDeps } from "./router.ts";
import { hostAnswerToOutcome, isHostMessageSendAnswer, isHostSessionStopAnswer, normaliseHostMessageListAnswer, boundedHostNote, HOST_MESSAGE_NOTE_MAX, type HostMessagingPort } from "./host.ts";
import { createFakeChild } from "./child-fake.test-support.ts";
import { createMessagingToolHandlers } from "../tools/messaging-handlers.ts";
import { messagingToolPortFromRuntimeDeps } from "../tools/port.ts";
import type { HostMessageListAnswer, HostMessageSendAnswer, HostMessageSendRequest } from "../protocol/config.ts";

const SELF = "parent-1";

function adapter(reachable: ListedRuntimeObject[] = []): RuntimeMessagingAdapter {
  const ok = async (_a: unknown, msg: { messageId: string }): Promise<DeliveryOutcome> => ({ status: "delivered", messageId: msg.messageId });
  return {
    listReachable: async () => reachable,
    steerChild: ok,
    resumeChild: ok,
    deliverToSession: ok,
    subscribeIdle: async (_a, req) => ({ status: "refused", messageId: req.messageId, reason: "no" }),
    senderPermissionClass: async () => "prompts",
  };
}

function host(answer: HostMessageSendAnswer | Error | unknown, listing: HostMessageListAnswer | Error = { sessions: [] }): HostMessagingPort & { sends: HostMessageSendRequest[]; lists: number } {
  const sends: HostMessageSendRequest[] = [];
  const port = {
    sends,
    lists: 0,
    async send(request: HostMessageSendRequest) {
      sends.push(request);
      if (answer instanceof Error) throw answer;
      return answer as HostMessageSendAnswer;
    },
    async list() {
      port.lists++;
      if (listing instanceof Error) throw listing;
      return listing;
    },
    async stop() {
      return { status: "not_running" as const };
    },
  };
  return port;
}

function deps(over: { port?: HostMessagingPort; reachable?: ListedRuntimeObject[]; children?: ReturnType<typeof createFakeChild>[] } = {}): MessagingRuntimeDeps {
  const seam = createFakeMessagingRouterSeam();
  seam.setChildren(over.children ?? []);
  return {
    seam,
    adapter: adapter(over.reachable),
    notifications: createNotificationQueue(),
    loopGuard: createLoopGuard(),
    subscribers: createSubscriberDirectory(),
    now: () => 1_000,
    ...(over.port !== undefined ? { hostMessaging: (sid: string) => (sid === SELF ? over.port : undefined) } : {}),
  };
}

describe("sendMessage with a host port", () => {
  test("an unresolvable target is asked of the host with the raw `to`, the runtime's message id, and no sender", async () => {
    const port = host({ status: "queued", note: "it is mid-turn" });
    const result = await sendMessage(deps({ port }), { sessionId: SELF, toolUseId: "tu-1" }, { to: "s_abc", message: "do more", summary: "more", notify_when_idle: false });
    expect(port.sends).toEqual([{ to: "s_abc", message: "do more", summary: "more", notifyWhenIdle: false, messageId: result.outcome.messageId }]);
    expect(result).toEqual({ outcome: { status: "queued", messageId: result.outcome.messageId }, note: "it is mid-turn" });
  });

  test("a subagent sender is named as fromAgentId, information only", async () => {
    const port = host({ status: "delivered" });
    await sendMessage(deps({ port }), { sessionId: SELF, agentId: "a1", toolUseId: "tu-1" }, { to: "s_abc", message: "hi" });
    expect(port.sends[0]?.fromAgentId).toBe("a1");
  });

  test("a subagent of this session resolves in-process and the host is never asked", async () => {
    const port = host({ status: "delivered" });
    const child = createFakeChild({ id: "c1", parentSessionId: SELF, name: "worker" });
    const result = await sendMessage(deps({ port, children: [child] }), { sessionId: SELF, toolUseId: "tu-1" }, { to: "worker", message: "hi" });
    expect(result.outcome.status).toBe("delivered"); // the fake adapter's steer: the child was resolved locally
    expect(port.sends).toEqual([]);
  });

  test("a retry of the same tool call returns the stored outcome without asking the host again", async () => {
    const port = host({ status: "resumed_and_delivered" });
    const d = deps({ port });
    const first = await sendMessage(d, { sessionId: SELF, toolUseId: "tu-1" }, { to: "s_abc", message: "hi" });
    const again = await sendMessage(d, { sessionId: SELF, toolUseId: "tu-1" }, { to: "s_abc", message: "hi" });
    expect(again.outcome).toEqual(first.outcome);
    expect(port.sends).toHaveLength(1);
  });

  test("a host that throws or answers garbage is delivery_uncertain", async () => {
    const thrown = await sendMessage(deps({ port: host(new Error("pipe closed")) }), { sessionId: SELF, toolUseId: "t" }, { to: "s_abc", message: "hi" });
    expect(thrown.outcome).toMatchObject({ status: "delivery_uncertain", deliveryMayHaveOccurred: true });
    const garbage = await sendMessage(deps({ port: host({ status: "refused" }) }), { sessionId: SELF, toolUseId: "t" }, { to: "s_abc", message: "hi" });
    expect(garbage.outcome).toMatchObject({ status: "delivery_uncertain" });
  });

  test("no port for this session: not_found exactly as before", async () => {
    const result = await sendMessage(deps(), { sessionId: SELF, toolUseId: "t" }, { to: "s_abc", message: "hi" });
    expect(result.outcome).toMatchObject({ status: "not_found", reason: 'no agent or session named "s_abc" is currently reachable' });
  });

  test("the bounds still run first: an oversized body never reaches the host", async () => {
    const port = host({ status: "delivered" });
    const result = await sendMessage(deps({ port }), { sessionId: SELF, toolUseId: "t" }, { to: "s_abc", message: "x".repeat(1_000_001) });
    expect(result.outcome.status).toBe("refused");
    expect(port.sends).toEqual([]);
  });

  test("the host's notify fact rides beside the outcome", async () => {
    const port = host({ status: "delivered", notify: { refused: "no idle notices for host sessions" } });
    const result = await sendMessage(deps({ port }), { sessionId: SELF, toolUseId: "t" }, { to: "s_abc", message: "hi", notify_when_idle: true });
    expect(result.notify).toEqual({ refused: "no idle notices for host sessions" });
  });
});

describe("listAgents with a host port", () => {
  const local: ListedRuntimeObject = { address: "agent:parent-1:c1", name: "worker", objectKind: "agent", runtimeKind: "winter-agent", status: "running", mode: "default", capabilities: { message: true, resume: false, notifyWhenIdle: false, reply: true } };

  test("host rows follow the in-process rows; duplicates and malformed rows are dropped", async () => {
    const port = host({ status: "delivered" }, { sessions: [
      { address: "session:s_1", name: "Fix it", status: "running", mode: "code" },
      { address: "agent:parent-1:c1", status: "running", mode: "code" },
      { address: "", status: "running", mode: "code" },
    ] });
    const { rows, listing } = await listAgents(deps({ port, reachable: [local] }), { sessionId: SELF }, {});
    expect(rows.map((r) => r.address)).toEqual(["agent:parent-1:c1", "session:s_1"]);
    expect(listing.split("\n")[1]).toBe("- Fix it (session:s_1) [session/winter-agent] status=running mode=code");
  });

  test("a host's omitted count (and the SDK's own cap) is reported, never silently cut", async () => {
    const port = host({ status: "delivered" }, { sessions: [{ address: "session:s_1", status: "running", mode: "code" }], omitted: 7 });
    const result = await listAgents(deps({ port }), { sessionId: SELF }, {});
    expect(result.omitted).toBe(7);
    expect(result.listing.split("\n").at(-1)).toBe("(7 more reachable sessions not listed)");
    const many = Array.from({ length: 205 }, (_, i) => ({ address: `session:s_${i}`, status: "running" as const, mode: "code" }));
    expect(normaliseHostMessageListAnswer({ sessions: many })?.omitted).toBe(5);
    const handlers = createMessagingToolHandlers(messagingToolPortFromRuntimeDeps(deps({ port })), { sessionId: SELF });
    const listed = JSON.parse((await handlers.listAgents({})).text) as { listing: string };
    expect(listed.listing).toEndWith("(7 more reachable sessions not listed)");
  });

  test("the calling tool's signal reaches the host's send", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const port = { ...host({ status: "delivered" }), async send(_r: HostMessageSendRequest, opts?: { signal?: AbortSignal }) { seen.push(opts?.signal); return { status: "delivered" as const }; } };
    const controller = new AbortController();
    await sendMessage(deps({ port }), { sessionId: SELF, toolUseId: "t" }, { to: "s_abc", message: "hi" }, { signal: controller.signal });
    expect(seen[0]).toBe(controller.signal);
  });

  test("the calling tool's signal reaches the host's list too (ListAgents)", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const port = { ...host({ status: "delivered" }), async list(_r: unknown, opts?: { signal?: AbortSignal }) { seen.push(opts?.signal); return { sessions: [] }; } };
    const controller = new AbortController();
    const handlers = createMessagingToolHandlers(messagingToolPortFromRuntimeDeps(deps({ port })), { sessionId: SELF, signal: controller.signal });
    await handlers.listAgents({});
    expect(seen[0]).toBe(controller.signal);
  });

  test("a failing host listing lists only the in-process rows", async () => {
    const port = host({ status: "delivered" }, new Error("down"));
    const { rows } = await listAgents(deps({ port, reachable: [local] }), { sessionId: SELF }, {});
    expect(rows).toEqual([local]);
  });
});

describe("the tool handler renders the host's note", () => {
  test("SendMessage's result is the outcome plus the note, an error only for a failure status", async () => {
    const port = host({ status: "resumed_and_delivered", note: "you'll be woken" });
    const handlers = createMessagingToolHandlers(messagingToolPortFromRuntimeDeps(deps({ port })), { sessionId: SELF, toolUseId: "tu" });
    const ok = await handlers.sendMessage({ to: "s_abc", message: "hi", summary: "hi" });
    expect(ok.isError).toBeUndefined();
    expect(JSON.parse(ok.text)).toEqual({ status: "resumed_and_delivered", messageId: port.sends[0]!.messageId, note: "you'll be woken" });
  });
});

describe("the guards", () => {
  test("isHostSessionStopAnswer requires a reason for the failure statuses", () => {
    expect(isHostSessionStopAnswer({ status: "stopped" })).toBe(true);
    expect(isHostSessionStopAnswer({ status: "not_running" })).toBe(true);
    expect(isHostSessionStopAnswer({ status: "refused" })).toBe(false);
    expect(isHostSessionStopAnswer({ status: "refused", reason: "a chat session" })).toBe(true);
    expect(isHostSessionStopAnswer({ status: "killed" })).toBe(false);
  });

  test("isHostMessageSendAnswer requires a reason exactly where the outcome carries one", () => {
    expect(isHostMessageSendAnswer({ status: "delivered" })).toBe(true);
    expect(isHostMessageSendAnswer({ status: "not_found" })).toBe(false);
    expect(isHostMessageSendAnswer({ status: "not_found", reason: "no such session" })).toBe(true);
    expect(isHostMessageSendAnswer({ status: "unavailable", reason: "x", retryable: "yes" })).toBe(false);
    expect(isHostMessageSendAnswer({ status: "delivered", notify: { subscribed: false } })).toBe(false);
    expect(isHostMessageSendAnswer({ status: "held", reason: "x" })).toBe(false);
  });

  test("hostAnswerToOutcome stamps the runtime's id and the unavailable default", () => {
    expect(hostAnswerToOutcome("m1", { status: "unavailable", reason: "starting" })).toEqual({ status: "unavailable", messageId: "m1", retryable: false, reason: "starting" });
    expect(hostAnswerToOutcome("m1", { status: "delivery_uncertain", reason: "r" })).toEqual({ status: "delivery_uncertain", messageId: "m1", deliveryMayHaveOccurred: true, reason: "r" });
  });

  test("normaliseHostMessageListAnswer keeps only addressable rows and refuses a non-listing", () => {
    expect(normaliseHostMessageListAnswer({ nope: 1 })).toBeUndefined();
    expect(normaliseHostMessageListAnswer({ sessions: [{ address: "a*b", status: "running", mode: "code" }, { address: "s_1", status: "idle", mode: "code", extra: 1 }] })).toEqual({ sessions: [{ address: "s_1", status: "idle", mode: "code" }] });
  });

  test("a note is trimmed and bounded", () => {
    expect(boundedHostNote("  ")).toBeUndefined();
    expect(boundedHostNote("x".repeat(HOST_MESSAGE_NOTE_MAX + 50))!.length).toBe(HOST_MESSAGE_NOTE_MAX);
  });
});
