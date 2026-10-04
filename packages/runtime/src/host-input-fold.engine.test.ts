// Host input sent WHILE a turn runs is folded into that turn at its next tool round (claude's
// behaviour for a message typed while it works), end to end through a real `runEngine`. Ground truth is
// what the provider receives and what the engine writes -- never an internal count.
//
// Every push is written from INSIDE `generate`, then `generate` waits one macrotask before answering:
// the pump reads the frame on its own schedule, and the wait is what guarantees the frame is pending
// before the tool round's scan runs.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { encodeFrame, splitFrames, WinterCompatibilitySessionStore, compatibilityKeys, type RuntimeConfig, type WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "./protocol/channel.ts";
import { runEngine, type ContentBlock, type EngineOptions, type ProviderMessage, type ProviderRequest, type ProviderTurn, type Provider } from "./engine.ts";
import { stubExecutor } from "./provider/mock.ts";
import { inMemoryProcess } from "./testing.ts";
import { QUEUED_PROMPT_FOOTER, QUEUED_PROMPT_HEADER, type AttachmentPayload } from "./context/attachments.ts";
import { clearNotificationQueue, enqueueTaskNotification, renderAgentNotification } from "./subagents/notification-queue.ts";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "winter-fold-engine-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const folded = (text: string): string => `<system-reminder>\n${QUEUED_PROMPT_HEADER}\n${text}\n\n${QUEUED_PROMPT_FOOTER}\n</system-reminder>`;
const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));
const readCall = (id: string): ProviderTurn => ({ kind: "tool_use", calls: [{ id, name: "Read", input: { file_path: `/nonexistent/${id}` } }] });

interface Recorded {
  requests: ProviderRequest[];
  frames: WinterFrame[];
  attachments: AttachmentPayload[];
  userEntries: unknown[];
}

interface Host {
  push(text: string): void;
  control(subtype: string, requestId: string): void;
}

/**
 * Drives one engine: `prompt` is the one prompt the host sends up front; `script` may push more host
 * input (or controls) at any point. Ends the input once `results` results have been written and the
 * engine has had `settleMs` to start anything else it was going to start.
 */
async function drive(opts: {
  sessionId?: string;
  prompt: string;
  results: number;
  script: (req: ProviderRequest, index: number, host: Host) => ProviderTurn | Promise<ProviderTurn>;
  settleMs?: number;
  agentId?: string;
  engine?: Partial<EngineOptions>;
}): Promise<Recorded> {
  const recorded: Recorded = { requests: [], frames: [], attachments: [], userEntries: [] };
  const { host, runtime } = createInMemoryChannel();
  const hostApi: Host = {
    push: (text) => host.output.write({ type: "user", text }),
    control: (subtype, requestId) => host.output.write({ type: "control_request", requestId, subtype, payload: undefined }),
  };
  const done = runEngine({
    config: {
      sessionId: opts.sessionId ?? `fold-${randomUUID()}`,
      cwd,
      model: "winter-test/fold",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
    },
    input: runtime.input,
    output: runtime.output,
    provider: {
      async generate(req) {
        recorded.requests.push({ ...req, messages: structuredClone(req.messages) as ProviderMessage[] });
        return opts.script(req, recorded.requests.length - 1, hostApi);
      },
    },
    tools: stubExecutor,
    store: {
      recordUserEntry: (content) => {
        recorded.userEntries.push(content);
      },
      recordAssistantEntry: () => {},
      recordAttachmentEntry: (attachment) => {
        recorded.attachments.push(attachment);
      },
    },
    ...(opts.engine ?? {}),
  });
  const reader = (async () => {
    for await (const f of host.input) recorded.frames.push(f);
  })();
  hostApi.push(opts.prompt);
  for (let n = 0; n < 1000 && resultCount(recorded.frames) < opts.results; n++) await tick(5);
  await tick(opts.settleMs ?? 60);
  hostApi.control("end_input", "end");
  await done;
  await reader;
  return recorded;
}

function messagesOf(frames: WinterFrame[]): Array<Record<string, unknown>> {
  return frames.flatMap((f) => (f.type === "data" ? [(f as { message: Record<string, unknown> }).message] : []));
}
function resultCount(frames: WinterFrame[]): number {
  return messagesOf(frames).filter((m) => m["type"] === "result").length;
}
function foldFrames(frames: WinterFrame[]): Array<Record<string, unknown>> {
  return messagesOf(frames).filter((m) => m["type"] === "system" && m["subtype"] === "host_input_folded");
}
function textsOf(message: ProviderMessage | undefined): string[] {
  if (message === undefined) return [];
  if (typeof message.content === "string") return [message.content];
  return message.content.flatMap((b: ContentBlock) => (b.type === "text" ? [b.text] : b.type === "tool_result" ? (typeof b.content === "string" ? [b.content] : []) : []));
}
const allText = (req: ProviderRequest): string => req.messages.flatMap(textsOf).join("\n");
const lastText = (req: ProviderRequest): string => textsOf(req.messages[req.messages.length - 1] as ProviderMessage | undefined).join("\n");

describe("a host input sent mid-turn is folded at the next tool round", () => {
  test("one push: the model sees it after the tool result, the turn has ONE result, and the host is told before the next request", async () => {
    const recorded = await drive({
      prompt: "A",
      results: 1,
      script: async (_req, i, host) => {
        if (i === 0) {
          host.push("B");
          await tick();
          return readCall("c1");
        }
        return { kind: "text", text: "done" };
      },
    });
    expect(recorded.requests).toHaveLength(2);
    const last = lastText(recorded.requests[1]!);
    // Folded INTO the tool-result turn, after the tool's own output.
    expect(last).toContain("Read:");
    expect(last).toContain(folded("B"));
    expect(last.indexOf(folded("B"))).toBeGreaterThan(last.indexOf("Read:"));
    expect(resultCount(recorded.frames)).toBe(1);
    const signals = foldFrames(recorded.frames);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ type: "system", subtype: "host_input_folded", count: 1 });
    expect(typeof signals[0]!["uuid"]).toBe("string");
    expect(typeof signals[0]!["session_id"]).toBe("string");
    // Before the second generation's assistant frame -- i.e. before the request that carries it.
    const kinds = messagesOf(recorded.frames);
    const signalAt = kinds.findIndex((m) => m["subtype"] === "host_input_folded");
    const assistants = kinds.flatMap((m, idx) => (m["type"] === "assistant" ? [idx] : []));
    expect(assistants).toHaveLength(2);
    expect(signalAt).toBeGreaterThan(assistants[0]!);
    expect(signalAt).toBeLessThan(assistants[1]!);
    // Persisted as claude's queued_command attachment; never as a `user` entry of its own.
    expect(recorded.attachments.filter((a) => a.type === "queued_command")).toEqual([{ type: "queued_command", prompt: "B", commandMode: "prompt" }]);
    expect(JSON.stringify(recorded.userEntries)).not.toContain('"B"');
  });

  test("two pushes fold together: count 2, in the order sent", async () => {
    const recorded = await drive({
      prompt: "A",
      results: 1,
      script: async (_req, i, host) => {
        if (i === 0) {
          host.push("first follow-up");
          host.push("second follow-up");
          await tick();
          return readCall("c1");
        }
        return { kind: "text", text: "done" };
      },
    });
    expect(recorded.requests).toHaveLength(2);
    const last = lastText(recorded.requests[1]!);
    expect(last.indexOf(folded("first follow-up"))).toBeGreaterThan(-1);
    expect(last.indexOf(folded("second follow-up"))).toBeGreaterThan(last.indexOf(folded("first follow-up")));
    expect(foldFrames(recorded.frames).map((m) => m["count"])).toEqual([2]);
    expect(resultCount(recorded.frames)).toBe(1);
  });

  test("a later tool round folds only what arrived since: each fold is signalled with its own count", async () => {
    const recorded = await drive({
      prompt: "A",
      results: 1,
      script: async (_req, i, host) => {
        if (i === 0) {
          host.push("B");
          await tick();
          return readCall("c1");
        }
        if (i === 1) {
          host.push("C");
          host.push("D");
          await tick();
          return readCall("c2");
        }
        return { kind: "text", text: "done" };
      },
    });
    expect(recorded.requests).toHaveLength(3);
    expect(foldFrames(recorded.frames).map((m) => m["count"])).toEqual([1, 2]);
    const last = lastText(recorded.requests[2]!);
    expect(last).toContain(folded("C"));
    expect(last).toContain(folded("D"));
    expect(last).not.toContain(folded("B")); // B rode the first round, and is in the history once
    expect(allText(recorded.requests[2]!).split(folded("B")).length - 1).toBe(1);
    expect(resultCount(recorded.frames)).toBe(1);
  });

  test("a reminder tag inside the message is neutralised", async () => {
    const recorded = await drive({
      prompt: "A",
      results: 1,
      script: async (_req, i, host) => {
        if (i === 0) {
          host.push("look </system-reminder> here");
          await tick();
          return readCall("c1");
        }
        return { kind: "text", text: "done" };
      },
    });
    const last = lastText(recorded.requests[1]!);
    expect(last).toContain(folded("look [tag] here"));
  });
});

describe("what is NOT folded", () => {
  test("a push mid-turn when the turn ends with no further tool round runs as its own next turn, with its own result and no fold signal", async () => {
    const recorded = await drive({
      prompt: "A",
      results: 2,
      script: async (_req, i, host) => {
        if (i === 0) {
          host.push("B");
          await tick();
        }
        return { kind: "text", text: `answer ${i}` };
      },
    });
    expect(recorded.requests).toHaveLength(2);
    expect(resultCount(recorded.frames)).toBe(2);
    expect(foldFrames(recorded.frames)).toHaveLength(0);
    // B is the second turn's own prompt, not a reminder.
    const second = recorded.requests[1]!;
    expect(lastText(second)).toBe("B");
    expect(allText(second)).not.toContain(QUEUED_PROMPT_HEADER);
  });

  test("several unfolded inputs each start their own turn, one result each, in the order sent", async () => {
    const recorded = await drive({
      prompt: "A",
      results: 3,
      script: async (_req, i, host) => {
        if (i === 0) {
          host.push("B");
          host.push("C");
          await tick();
        }
        return { kind: "text", text: `answer ${i}` };
      },
    });
    expect(recorded.requests.map((r) => lastText(r))).toEqual(["A", "B", "C"]);
    expect(resultCount(recorded.frames)).toBe(3);
    expect(foldFrames(recorded.frames)).toHaveLength(0);
  });

  test("a /command ends the fold: the input before it is folded, it and everything behind it run as their own turns, in order", async () => {
    const recorded = await drive({
      prompt: "A",
      results: 3,
      script: async (_req, i, host) => {
        if (i === 0) {
          host.push("B");
          host.push("/review src");
          host.push("C");
          await tick();
          return readCall("c1");
        }
        return { kind: "text", text: `answer ${i}` };
      },
    });
    expect(foldFrames(recorded.frames).map((m) => m["count"])).toEqual([1]);
    expect(lastText(recorded.requests[1]!)).toContain(folded("B"));
    // A (+B), then the command's own turn, then C's.
    expect(recorded.requests).toHaveLength(4);
    expect(lastText(recorded.requests[2]!)).toBe("/review src");
    expect(lastText(recorded.requests[3]!)).toBe("C");
    expect(resultCount(recorded.frames)).toBe(3);
  });

  test("a subagent engine never folds host input", async () => {
    const recorded = await drive({
      agentId: "child-1",
      prompt: "A",
      results: 2,
      script: async (_req, i, host) => {
        if (i === 0) {
          host.push("B");
          await tick();
          return readCall("c1");
        }
        return { kind: "text", text: `answer ${i}` };
      },
    });
    expect(foldFrames(recorded.frames)).toHaveLength(0);
    expect(recorded.requests.flatMap((r) => r.messages.flatMap(textsOf)).some((t) => t.includes(QUEUED_PROMPT_HEADER))).toBe(false);
    expect(resultCount(recorded.frames)).toBe(2);
  });

  test("an interrupt leaves the pending input pending: it runs as the next turn", async () => {
    const recorded = await drive({
      prompt: "A",
      results: 2,
      script: async (_req, i, host) => {
        if (i === 0) {
          host.push("B");
          await tick();
          host.control("interrupt", "int-1");
          await tick();
          return readCall("c1");
        }
        return { kind: "text", text: `answer ${i}` };
      },
    });
    expect(foldFrames(recorded.frames)).toHaveLength(0);
    expect(resultCount(recorded.frames)).toBe(2);
    // B is the next turn's own prompt (the interrupted turn left A unanswered, so the layout joins the two).
    expect(lastText(recorded.requests.at(-1)!).endsWith("B")).toBe(true);
    expect(allText(recorded.requests.at(-1)!)).not.toContain(QUEUED_PROMPT_HEADER);
  });
});

describe("a task notification and a host push pending at the same tool round", () => {
  test("both are delivered in that round: the host input first, then the notification", async () => {
    const sessionId = `fold-notify-${randomUUID()}`;
    clearNotificationQueue(sessionId);
    const recorded = await drive({
      sessionId,
      prompt: "A",
      results: 1,
      script: async (_req, i, host) => {
        if (i === 0) {
          enqueueTaskNotification({ sessionId, value: renderAgentNotification({ taskId: "task-1", toolUseId: "toolu_x", description: "bg probe", status: "completed", finalMessage: "all done" }), taskId: "task-1" });
          host.push("B");
          await tick();
          return readCall("c1");
        }
        return { kind: "text", text: "done" };
      },
    });
    expect(recorded.requests).toHaveLength(2);
    const last = lastText(recorded.requests[1]!);
    const hostAt = last.indexOf(folded("B"));
    const notifyAt = last.indexOf("<task-notification>");
    expect(hostAt).toBeGreaterThan(-1);
    expect(notifyAt).toBeGreaterThan(hostAt);
    expect(foldFrames(recorded.frames).map((m) => m["count"])).toEqual([1]);
    expect(resultCount(recorded.frames)).toBe(1);
    clearNotificationQueue(sessionId);
  });
});

describe("clear_queued_input", () => {
  test("drops every pending host input and answers how many; the dropped inputs never run", async () => {
    const recorded = await drive({
      prompt: "A",
      results: 1,
      settleMs: 120,
      script: async (_req, i, host) => {
        if (i === 0) {
          host.push("B");
          host.push("C");
          host.control("clear_queued_input", "clear-1");
          await tick();
          return readCall("c1");
        }
        return { kind: "text", text: `answer ${i}` };
      },
    });
    const response = recorded.frames.find((f) => f.type === "control_response" && (f as { requestId?: string }).requestId === "clear-1") as { ok: boolean; payload?: unknown } | undefined;
    expect(response).toMatchObject({ ok: true, payload: { cleared: 2 } });
    // The running turn carried on (its tool round folded nothing), and nothing else ran.
    expect(recorded.requests).toHaveLength(2);
    expect(foldFrames(recorded.frames)).toHaveLength(0);
    expect(recorded.requests.flatMap((r) => r.messages.flatMap(textsOf)).some((t) => t === "B" || t === "C" || t.includes(QUEUED_PROMPT_HEADER))).toBe(false);
    expect(resultCount(recorded.frames)).toBe(1);
  });

  test("with nothing pending it answers 0 and changes nothing", async () => {
    const recorded = await drive({
      prompt: "A",
      results: 1,
      script: async (_req, i, host) => {
        if (i === 0) {
          host.control("clear_queued_input", "clear-0");
          await tick();
        }
        return { kind: "text", text: "done" };
      },
    });
    const response = recorded.frames.find((f) => f.type === "control_response" && (f as { requestId?: string }).requestId === "clear-0");
    expect(response).toMatchObject({ ok: true, payload: { cleared: 0 } });
    expect(resultCount(recorded.frames)).toBe(1);
  });

  test("a queued task notification is untouched: it still gets its own turn", async () => {
    const sessionId = `fold-clear-notify-${randomUUID()}`;
    clearNotificationQueue(sessionId);
    const recorded = await drive({
      sessionId,
      prompt: "A",
      results: 2,
      script: async (_req, i, host) => {
        if (i === 0) {
          host.push("B");
          host.control("clear_queued_input", "clear-n");
          await tick();
          // Arrives while the turn runs and ends with no tool round: it waits for its own turn.
          enqueueTaskNotification({ sessionId, value: renderAgentNotification({ taskId: "task-2", toolUseId: "toolu_y", description: "bg", status: "completed", finalMessage: "ok" }), taskId: "task-2" });
        }
        return { kind: "text", text: `answer ${i}` };
      },
    });
    const response = recorded.frames.find((f) => f.type === "control_response" && (f as { requestId?: string }).requestId === "clear-n");
    expect(response).toMatchObject({ ok: true, payload: { cleared: 1 } });
    expect(resultCount(recorded.frames)).toBe(2);
    expect(lastText(recorded.requests[1]!)).toContain("<task-notification>");
    clearNotificationQueue(sessionId);
  });
});

// --- resume ------------------------------------------------------------------------------------------

async function drainAll(stdout: AsyncIterable<string>): Promise<WinterFrame[]> {
  const frames: WinterFrame[] = [];
  let carry = "";
  for await (const chunk of stdout) {
    const split = splitFrames(chunk, carry);
    carry = split.carry;
    frames.push(...split.frames);
  }
  return frames;
}

describe("resume", () => {
  test("a resumed session rebuilds the folded message exactly where the running turn put it", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-fold-resume-"));
    try {
      const sessionId = randomUUID();
      const base: Omit<RuntimeConfig, "sessionId"> = { cwd, model: "winter-test/echo", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true };

      // Run 1: prompt A; while its first generation runs the host sends B; a tool round folds it.
      const first: ProviderRequest[] = [];
      let pushB!: () => void;
      const firstProvider: Provider = {
        async generate(req) {
          first.push({ ...req, messages: structuredClone(req.messages) as ProviderMessage[] });
          if (first.length === 1) {
            pushB();
            await tick();
            return readCall("r1");
          }
          return { kind: "text", text: "done" };
        },
      };
      const run1 = inMemoryProcess(["--config-json", JSON.stringify({ ...base, sessionId })], firstProvider, stubExecutor, { WINTER_HOME: home });
      pushB = () => run1.stdin.write(encodeFrame({ type: "user", text: "B" }));
      run1.stdin.write(encodeFrame({ type: "user", text: "A" }));
      const frames1Promise = drainAll(run1.stdout);
      for (let n = 0; n < 400 && first.length < 2; n++) await tick(5);
      await tick(60);
      run1.stdin.write(encodeFrame({ type: "control_request", requestId: "e1", subtype: "end_input", payload: undefined }));
      const frames1 = await frames1Promise;
      await run1.exited;
      expect(frames1.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result")).toHaveLength(1);
      expect(first).toHaveLength(2);

      // The transcript holds the attachment entry.
      const entries = await new WinterCompatibilitySessionStore({ winterHome: home }).load({ projectKey: compatibilityKeys(cwd).transcriptProjectKey, sessionId });
      expect(entries!.filter((e) => e.type === "attachment" && (e as { attachment?: { type?: string } }).attachment?.type === "queued_command")).toHaveLength(1);

      // Run 2: resume, one more prompt. Its first request carries the run-1 history, fold included, at
      // the same position: everything run 1's last request carried comes first, unchanged.
      const second: ProviderRequest[] = [];
      const secondProvider: Provider = {
        async generate(req) {
          second.push({ ...req, messages: structuredClone(req.messages) as ProviderMessage[] });
          return { kind: "text", text: "again" };
        },
      };
      const run2 = inMemoryProcess(["--config-json", JSON.stringify({ ...base, sessionId: randomUUID(), resume: sessionId })], secondProvider, stubExecutor, { WINTER_HOME: home });
      run2.stdin.write(encodeFrame({ type: "user", text: "next" }));
      run2.stdin.write(encodeFrame({ type: "control_request", requestId: "e2", subtype: "end_input", payload: undefined }));
      await drainAll(run2.stdout);
      await run2.exited;
      expect(second).toHaveLength(1);
      const before = first[1]!.messages.flatMap(textsOf);
      const after = second[0]!.messages.flatMap(textsOf);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.join("\n").split(folded("B")).length - 1).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
