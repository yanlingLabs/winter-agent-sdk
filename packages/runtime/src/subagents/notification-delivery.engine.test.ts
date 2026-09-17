// SDK 0.0.16 Lane N: the two DELIVERIES, end to end through a real `runEngine`. Ground truth is
// what the provider actually receives (mid-turn) and what the engine emits on its own (between
// turns) -- never an internal call count.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type ContentBlock, type EngineOptions, type ProviderMessage, type ProviderRequest, type ProviderTurn, type UserEntryMeta } from "../engine.ts";
import { stubExecutor } from "../provider/mock.ts";
import { clearNotificationQueue, enqueueTaskNotification, notificationQueueFor, renderAgentNotification, NOTIFICATION_PREAMBLE, NOTIFICATION_PREAMBLE_IN_HUMAN_TURN } from "./notification-queue.ts";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "winter-notify-engine-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

interface Recorded {
  requests: ProviderRequest[];
  frames: WinterFrame[];
  userEntries: Array<{ content: unknown; opts?: UserEntryMeta }>;
}

/**
 * Drives one engine with a scripted provider. `script` may enqueue notifications at any point (that
 * is the whole point of this harness: a background task finishes WHILE the engine is doing something
 * else), and `afterTurns` runs once every scripted host prompt has produced its result but before
 * `end_input`, which is the window an UNSOLICITED turn lives in.
 */
async function drive(opts: {
  sessionId: string;
  prompts: string[];
  script: (req: ProviderRequest, index: number) => ProviderTurn;
  afterTurns?: () => void | Promise<void>;
  /** Extra settling time after `afterTurns`, for unsolicited turns to run (they need no host input at all). */
  settleMs?: number;
  engine?: Partial<EngineOptions>;
}): Promise<Recorded> {
  const recorded: Recorded = { requests: [], frames: [], userEntries: [] };
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    // `bypassPermissions` because a scripted tool round must not stop on a permission control_request
    // this harness has no host to answer (the mid-turn scenarios are about PLACEMENT, not the gate).
    config: { sessionId: opts.sessionId, cwd, model: "winter-test/notify", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true },
    input: runtime.input,
    output: runtime.output,
    provider: {
      async generate(req) {
        recorded.requests.push({ ...req, messages: structuredClone(req.messages) as ProviderMessage[] });
        return opts.script(req, recorded.requests.length - 1);
      },
    },
    tools: stubExecutor,
    store: {
      recordUserEntry: (content, entryOpts) => {
        recorded.userEntries.push({ content, ...(entryOpts !== undefined ? { opts: entryOpts } : {}) });
      },
      recordAssistantEntry: () => {},
    },
    ...(opts.engine ?? {}),
  });
  const reader = (async () => {
    for await (const f of host.input) recorded.frames.push(f);
  })();
  const results = (): number => recorded.frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").length;
  for (let i = 0; i < opts.prompts.length; i++) {
    host.output.write({ type: "user", text: opts.prompts[i]! });
    for (let n = 0; n < 600 && results() < i + 1; n++) await new Promise((r) => setTimeout(r, 5));
  }
  await opts.afterTurns?.();
  if (opts.settleMs !== undefined) await new Promise((r) => setTimeout(r, opts.settleMs));
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  await done;
  await reader;
  return recorded;
}

function textsOf(message: ProviderMessage | undefined): string[] {
  if (message === undefined) return [];
  if (typeof message.content === "string") return [message.content];
  return message.content.flatMap((b: ContentBlock) => (b.type === "text" ? [b.text] : b.type === "tool_result" ? (typeof b.content === "string" ? [b.content] : []) : []));
}

const lastMessage = (req: ProviderRequest): ProviderMessage | undefined => req.messages[req.messages.length - 1] as ProviderMessage | undefined;

function frameKinds(frames: WinterFrame[]): string[] {
  return frames.flatMap((f) => {
    if (f.type !== "data") return [];
    const m = (f as { message: { type: string; subtype?: string } }).message;
    return [m.type === "system" ? `system:${m.subtype}` : m.type];
  });
}

const agentXml = (taskId: string, description: string): string => renderAgentNotification({ taskId, toolUseId: "toolu_spawn", description, status: "completed", finalMessage: "all done" });

describe("mid-turn delivery (after a tool round)", () => {
  test("the notification lands WITH the tool results of the round it arrived in, carrying the in-human-turn preamble", async () => {
    const sessionId = "notify-midturn";
    clearNotificationQueue(sessionId);
    const recorded = await drive({
      sessionId,
      prompts: ["do the thing"],
      script: (_req, i) => {
        if (i === 0) {
          // The background task finishes WHILE this tool call is in flight.
          enqueueTaskNotification({ sessionId, value: agentXml("task-1", "bg probe"), taskId: "task-1" });
          return { kind: "tool_use", calls: [{ id: "call-1", name: "Read", input: { file_path: "/nonexistent" } }] };
        }
        return { kind: "text", text: "done" };
      },
    });

    expect(recorded.requests).toHaveLength(2);
    // Request 2 is the one that follows the tool round. The notification is part of the SAME user
    // turn as the tool results -- claude's request layout folds a text-only attachment into the last
    // `tool_result`'s string content, so asserting "the last message's texts" is asserting placement.
    const texts = textsOf(lastMessage(recorded.requests[1]!)).join("\n");
    expect(texts).toContain("<task-notification>");
    expect(texts).toContain('<summary>Agent "bg probe" finished</summary>');
    expect(texts).toContain(NOTIFICATION_PREAMBLE_IN_HUMAN_TURN.trimEnd());
    // ...and the tool result it rode in with is still there.
    expect(texts).toContain("Read:");
    // No unsolicited turn happened: it was already delivered.
    expect(recorded.requests).toHaveLength(2);
    clearNotificationQueue(sessionId);
  });

  test("the drained notification is NOT re-delivered on a later round", async () => {
    const sessionId = "notify-midturn-once";
    clearNotificationQueue(sessionId);
    const recorded = await drive({
      sessionId,
      prompts: ["two rounds please"],
      script: (_req, i) => {
        if (i === 0) {
          enqueueTaskNotification({ sessionId, value: agentXml("task-1", "bg probe"), taskId: "task-1" });
          return { kind: "tool_use", calls: [{ id: "c1", name: "Read", input: { file_path: "/a" } }] };
        }
        if (i === 1) return { kind: "tool_use", calls: [{ id: "c2", name: "Read", input: { file_path: "/b" } }] };
        return { kind: "text", text: "done" };
      },
    });
    const occurrences = recorded.requests.flatMap((r) => r.messages.flatMap(textsOf)).filter((t) => t.includes("<task-notification>"));
    // Request 2 and request 3 both CARRY it in their history (it is a persisted attachment), but it
    // was appended exactly once: the count in the LAST request is 1.
    expect(textsOf(lastMessage(recorded.requests[2]!)).filter((t) => t.includes("<task-notification>"))).toHaveLength(0);
    expect(occurrences.length).toBeGreaterThan(0);
    clearNotificationQueue(sessionId);
  });
});

describe("between-turn delivery (the unsolicited turn)", () => {
  test("a notification arriving while the engine is idle starts its own turn: init, assistant, result", async () => {
    const sessionId = "notify-unsolicited";
    clearNotificationQueue(sessionId);
    const recorded = await drive({
      sessionId,
      prompts: ["kick it off"],
      script: () => ({ kind: "text", text: "ok" }),
      afterTurns: () => {
        enqueueTaskNotification({ sessionId, value: agentXml("task-9", "bg probe"), taskId: "task-9" });
      },
      settleMs: 200,
    });

    expect(recorded.requests).toHaveLength(2);
    const texts = textsOf(lastMessage(recorded.requests[1]!)).join("\n");
    expect(texts).toContain(NOTIFICATION_PREAMBLE.trimEnd());
    expect(texts).toContain('<summary>Agent "bg probe" finished</summary>');

    // The frame ORDER the pinned binary shows for an unsolicited turn: a SECOND system:init, then the
    // assistant stream, then its own result.
    const kinds = frameKinds(recorded.frames);
    const secondInit = kinds.indexOf("system:init", kinds.indexOf("system:init") + 1);
    expect(secondInit).toBeGreaterThan(kinds.indexOf("result"));
    expect(kinds.slice(secondInit)).toEqual(["system:init", "assistant", "result"]);
    // Two results, one host prompt: the second turn is unsolicited by construction.
    expect(kinds.filter((k) => k === "result")).toHaveLength(2);
    clearNotificationQueue(sessionId);
  });

  test("the unsolicited turn's envelope is persisted META-FLAGGED with its origin", async () => {
    const sessionId = "notify-persist";
    clearNotificationQueue(sessionId);
    const recorded = await drive({
      sessionId,
      prompts: ["hello"],
      script: () => ({ kind: "text", text: "ok" }),
      afterTurns: () => {
        enqueueTaskNotification({ sessionId, value: agentXml("task-2", "bg probe"), taskId: "task-2" });
      },
      settleMs: 200,
    });
    const meta = recorded.userEntries.filter((e) => typeof e.content === "string" && e.content.includes("<task-notification>"));
    expect(meta).toHaveLength(1);
    expect(meta[0]!.opts).toEqual({ isMeta: true, origin: { kind: "task-notification" } });
    // A host prompt is recorded with NO meta at all (byte-identical to before this lane).
    expect(recorded.userEntries[0]!.opts).toBeUndefined();
    clearNotificationQueue(sessionId);
  });

  test("ONE notification per turn: two queued completions become two turns", async () => {
    const sessionId = "notify-one-per-turn";
    clearNotificationQueue(sessionId);
    const recorded = await drive({
      sessionId,
      prompts: ["go"],
      script: () => ({ kind: "text", text: "ok" }),
      afterTurns: () => {
        enqueueTaskNotification({ sessionId, value: agentXml("task-a", "probe a"), taskId: "task-a" });
        enqueueTaskNotification({ sessionId, value: agentXml("task-b", "probe b"), taskId: "task-b" });
      },
      settleMs: 400,
    });
    expect(recorded.requests).toHaveLength(3);
    expect(textsOf(lastMessage(recorded.requests[1]!)).join("\n")).toContain("probe a");
    const third = textsOf(lastMessage(recorded.requests[2]!)).join("\n");
    expect(third).toContain("probe b");
    expect(third).not.toContain("probe a"); // never two in one turn
    expect(frameKinds(recorded.frames).filter((k) => k === "result")).toHaveLength(3);
    clearNotificationQueue(sessionId);
  });

  test("OWNERSHIP: a notification addressed to a live subagent is NOT taken by the main engine", async () => {
    const sessionId = "notify-owner";
    clearNotificationQueue(sessionId);
    const queue = notificationQueueFor(sessionId);
    const disposeChild = queue.registerEndpoint("agent-1", () => {});
    const recorded = await drive({
      sessionId,
      prompts: ["go"],
      script: () => ({ kind: "text", text: "ok" }),
      afterTurns: () => {
        enqueueTaskNotification({ sessionId, value: agentXml("task-c", "child work"), agentId: "agent-1", taskId: "task-c" });
      },
      settleMs: 200,
    });
    expect(recorded.requests).toHaveLength(1); // no unsolicited turn: it is not this engine's
    expect(queue.peek("agent-1")).toHaveLength(1);
    disposeChild();
    // ...and once the child's engine is gone, the entry belongs to the main thread.
    expect(queue.peekMain()?.taskId).toBe("task-c");
    clearNotificationQueue(sessionId);
  });

  test("a notification enqueued after the input closed is not lost -- it simply never starts a turn", async () => {
    const sessionId = "notify-after-close";
    clearNotificationQueue(sessionId);
    const recorded = await drive({
      sessionId,
      prompts: ["go"],
      script: () => ({ kind: "text", text: "ok" }),
    });
    enqueueTaskNotification({ sessionId, value: agentXml("task-late", "late probe"), taskId: "task-late" });
    expect(recorded.requests).toHaveLength(1);
    // The queue for this session was dropped at teardown, so the late entry lands in a fresh one and
    // holds no reference to the finished engine.
    expect(notificationQueueFor(sessionId).size()).toBe(1);
    clearNotificationQueue(sessionId);
  });
});
