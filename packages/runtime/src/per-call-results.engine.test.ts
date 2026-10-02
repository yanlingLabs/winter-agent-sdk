// SDK 0.0.40, through the REAL engine, with no timing in the assertions: a round's READ-ONLY calls run
// concurrently (tools/concurrency.ts), each call's result reaches the host in its own `user` frame the
// moment THAT call finishes (completion order), and the model's side is untouched -- the transcript
// records the round as ONE user entry and the next request carries the results together, in CALL order.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlRequestFrame, RuntimeHooksConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "./protocol/channel.ts";
import { runEngine, type ContentBlock, type EngineOptions, type ProviderRequest } from "./engine.ts";
import { isConcurrencySafeTool, MAX_TOOL_CONCURRENCY } from "./tools/concurrency.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "winter-per-call-engine-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Call = { id: string; name: string; input: unknown };
type Executor = (call: { id: string; name: string }, opts?: { signal?: AbortSignal }) => Promise<{ output: string }>;

const userFrameIds = (f: WinterFrame): string[] | undefined => {
  const msg = (f as { message?: { type?: string; message?: { content?: Array<{ type?: string; tool_use_id?: string }> } } }).message;
  if (f.type !== "data" || msg?.type !== "user") return undefined;
  return (msg.message?.content ?? []).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id!);
};
const resultFrames = (frames: WinterFrame[]): string[][] => frames.map(userFrameIds).filter((ids): ids is string[] => ids !== undefined && ids.length > 0);
const idsOf = (blocks: unknown): string[] => (blocks as Array<{ tool_use_id: string }>).map((b) => b.tool_use_id);

/** One engine run: the model makes `calls` in ONE round, then answers "done". `onFrame` sees every host frame live. */
async function run(calls: Call[], execute: Executor, onFrame?: (f: WinterFrame, host: { interrupt(): void; answer(requestId: string, payload: unknown): void }) => void, hooks?: RuntimeHooksConfig) {
  const requests: ProviderRequest[] = [];
  const recorded: unknown[] = [];
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config: { sessionId: "s-per-call", cwd: dir, model: "anthropic/claude-sonnet-5-5", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, ...(hooks !== undefined ? { hooks } : {}) },
    input: runtime.input,
    output: runtime.output,
    provider: {
      async generate(req) {
        requests.push({ ...req, messages: structuredClone(req.messages) });
        return requests.length === 1 ? { kind: "tool_use", calls } : { kind: "text", text: "done" };
      },
    },
    tools: { execute },
    providerIdentity: { providerId: "anthropic", modelKey: "anthropic/claude-sonnet-5-5", family: "anthropic" },
    describeModel: () => ({}),
    store: {
      recordUserEntry(content: string | ContentBlock[]) { recorded.push(structuredClone(content)); },
      recordAssistantEntry() {},
    },
  } as EngineOptions);
  const frames: WinterFrame[] = [];
  const handle = {
    interrupt: () => host.output.write({ type: "control_request", requestId: "int-1", subtype: "interrupt", payload: { scope: "turn" } }),
    answer: (requestId: string, payload: unknown) => host.output.write({ type: "control_response", requestId, ok: true, payload }),
  };
  const reader = (async () => {
    for await (const f of host.input) {
      frames.push(f);
      onFrame?.(f, handle);
    }
  })();
  host.output.write({ type: "user", text: "go" });
  for (let n = 0; n < 5000 && !frames.some((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result"); n++) await new Promise((r) => setTimeout(r, 2));
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  await done;
  await reader;
  const toolMessages = requests[1]?.messages.filter((m) => (m as { role: string }).role === "tool") ?? [];
  const roundEntries = recorded.filter((c) => Array.isArray(c) && (c as ContentBlock[]).some((b) => b.type === "tool_result"));
  return { frames, toolMessages, roundEntries, requests };
}

/** A promise per call id, resolved by the test -- so the completion order is the TEST's choice, not timing's. */
function gates(ids: string[]) {
  const release = new Map<string, () => void>();
  const wait = new Map(ids.map((id) => [id, new Promise<void>((r) => release.set(id, r))]));
  return { wait: (id: string) => wait.get(id)!, release: (id: string) => release.get(id)!() };
}

const read = (id: string, path = id): Call => ({ id, name: "Read", input: { file_path: join("/tmp", path) } });

describe("a round's read-only calls run concurrently; results reach the host as each finishes", () => {
  test("the premise: Read is concurrency-safe, Write is not", () => {
    expect(isConcurrencySafeTool("Read")).toBe(true);
    expect(isConcurrencySafeTool("WebFetch")).toBe(true);
    expect(isConcurrencySafeTool("Write")).toBe(false);
    expect(isConcurrencySafeTool("Bash")).toBe(false);
    expect(isConcurrencySafeTool("ToolSearch")).toBe(false);
    expect(isConcurrencySafeTool("no-such-tool")).toBe(false);
  });

  test("three reads all in flight at once; frames in COMPLETION order; the model's message in CALL order", async () => {
    const g = gates(["a", "b", "c"]);
    const running = new Set<string>();
    let allThreeAtOnce = false;
    const { frames, toolMessages, roundEntries } = await run([read("a"), read("b"), read("c")], async (call) => {
      running.add(call.id);
      if (running.size === 3) {
        allThreeAtOnce = true;
        // Finish them in the order c, a, b -- each released only once the previous one's frame is out.
        g.release("c");
      }
      await g.wait(call.id);
      running.delete(call.id);
      return { output: `${call.id} result` };
    }, (f) => {
      const ids = userFrameIds(f);
      if (ids?.[0] === "c") g.release("a");
      if (ids?.[0] === "a") g.release("b");
    });
    expect(allThreeAtOnce).toBe(true);
    expect(resultFrames(frames)).toEqual([["c"], ["a"], ["b"]]);
    expect(toolMessages).toHaveLength(1);
    expect(idsOf((toolMessages[0] as { content: unknown }).content)).toEqual(["a", "b", "c"]);
    expect(roundEntries).toHaveLength(1);
    expect(idsOf(roundEntries[0])).toEqual(["a", "b", "c"]);
  });

  test("an unsafe call is a barrier: it waits for the reads before it, and the reads after it wait for it", async () => {
    const log: string[] = [];
    const { frames, toolMessages } = await run(
      [read("a"), read("b"), { id: "w", name: "Write", input: { file_path: join(dir, "out.txt"), content: "x" } }, read("c"), read("d")],
      async (call) => {
        log.push(`start ${call.id}`);
        await new Promise((r) => setTimeout(r, call.id === "a" ? 40 : 10));
        log.push(`end ${call.id}`);
        return { output: `${call.id} result` };
      },
    );
    // a and b overlap; w starts only after both ended; c and d start only after w ended.
    expect(log.indexOf("start b")).toBeLessThan(log.indexOf("end a"));
    expect(log.indexOf("start w")).toBeGreaterThan(Math.max(log.indexOf("end a"), log.indexOf("end b")));
    expect(Math.min(log.indexOf("start c"), log.indexOf("start d"))).toBeGreaterThan(log.indexOf("end w"));
    expect(log.indexOf("start d")).toBeLessThan(log.indexOf("end c"));
    expect(resultFrames(frames)).toEqual([["b"], ["a"], ["w"], ["c"], ["d"]]);
    expect(idsOf((toolMessages[0] as { content: unknown }).content)).toEqual(["a", "b", "w", "c", "d"]);
  });

  test(`at most ${MAX_TOOL_CONCURRENCY} calls run at once`, async () => {
    const ids = Array.from({ length: MAX_TOOL_CONCURRENCY + 3 }, (_, i) => `r${i}`);
    let running = 0;
    let peak = 0;
    const { frames, toolMessages } = await run(ids.map((id) => read(id)), async (call) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 15));
      running--;
      return { output: `${call.id} result` };
    });
    expect(peak).toBe(MAX_TOOL_CONCURRENCY);
    expect(resultFrames(frames).flat().sort()).toEqual([...ids].sort());
    expect(idsOf((toolMessages[0] as { content: unknown }).content)).toEqual(ids);
  });

  test("PostToolUse hooks of concurrent calls: each frame waits for its own hook; the hooks' context reaches the model in CALL order", async () => {
    const g = gates(["a", "b", "c"]);
    let started = 0;
    let answered = 0;
    const hookOrder: string[] = [];
    const { frames, requests } = await run(
      [read("a"), read("b"), read("c")],
      async (call) => {
        if (++started === 3) g.release("c");
        await g.wait(call.id);
        return { output: `${call.id} result` };
      },
      (f, host) => {
        if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "hook") {
          const req = f as ControlRequestFrame;
          const p = req.payload as { event: string; payload?: { tool_use_id?: string } };
          hookOrder.push(p.event);
          // Numbered in the order the hooks FIRE -- completion order (c, b, a) -- so a model that saw them
          // in firing order would read ctx-1, ctx-2, ctx-3.
          host.answer(req.requestId, { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `ctx-${++answered}` } });
          return;
        }
        const ids = userFrameIds(f);
        if (ids?.[0] === "c") g.release("b");
        if (ids?.[0] === "b") g.release("a");
      },
      { PostToolUse: [{ hookCount: 1, source: "sdk" }] },
    );
    expect(hookOrder).toEqual(["PostToolUse", "PostToolUse", "PostToolUse"]);
    expect(resultFrames(frames)).toEqual([["c"], ["b"], ["a"]]);
    // The model reads the three hooks' context in CALL order: a's (fired 3rd), b's (2nd), c's (1st).
    const text = JSON.stringify(requests[1]!.messages);
    const at = (n: number) => text.indexOf(`hook additional context: ctx-${n}`);
    expect([at(3), at(2), at(1)].every((i) => i >= 0)).toBe(true);
    expect(at(3)).toBeLessThan(at(2));
    expect(at(2)).toBeLessThan(at(1));
  });

  test("an interrupt mid-batch: the finished call keeps its result, the calls in flight are answered [interrupted], each exactly once, in call order", async () => {
    const { frames, toolMessages, roundEntries } = await run(
      [read("a"), read("b"), read("c")],
      async (call, opts) => {
        if (call.id === "a") return { output: "a result" };
        // b and c hang until the turn's signal aborts them.
        await new Promise<void>((resolve) => opts?.signal?.addEventListener("abort", () => resolve(), { once: true }));
        return { output: `${call.id} aborted late` };
      },
      (f, host) => {
        if (userFrameIds(f)?.[0] === "a") host.interrupt();
      },
    );
    expect(resultFrames(frames)).toEqual([["a"], ["b", "c"]]);
    const blocks = (roundEntries[0] ?? []) as Array<{ tool_use_id: string; content: unknown; interrupted?: boolean }>;
    expect(blocks.map((b) => [b.tool_use_id, b.interrupted === true])).toEqual([["a", false], ["b", true], ["c", true]]);
    expect(blocks[0]!.content).toBe("a result");
    // The interrupted turn asks the provider nothing more.
    expect(toolMessages).toHaveLength(0);
  });
});
