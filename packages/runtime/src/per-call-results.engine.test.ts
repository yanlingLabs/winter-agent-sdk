// SDK 0.0.40, through the REAL engine, with no timing in the assertions: a round's concurrent calls
// (tools/concurrency.ts) overlap, each call's result reaches the host in its own `user` frame the moment
// THAT call finishes (completion order), and the model's side is untouched -- the transcript records the
// round as ONE user entry and the next request carries the results together, in CALL order. Plus the
// round's failure paths under concurrency: throws, hook stops, a failure outside any call, a call whose
// checks were still running when a sibling failed, and concurrency lanes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlRequestFrame, RuntimeHooksConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "./protocol/channel.ts";
import { runEngine, type ContentBlock, type EngineOptions, type ProviderRequest } from "./engine.ts";
import { MAX_TOOL_CONCURRENCY, createToolLaneTails, enterToolLane, schedulingForCall, type ToolLaneTails } from "./tools/concurrency.ts";
import { registerMcpServerTools, unregisterMcpServerTools } from "./tools/registry.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "winter-per-call-engine-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Call = { id: string; name: string; input: unknown };
type Executor = (call: { id: string; name: string }, opts?: { signal?: AbortSignal }) => Promise<{ output: string }>;
interface Host {
  interrupt(): void;
  answer(requestId: string, payload: unknown): void;
}
interface RunOptions {
  onFrame?: (f: WinterFrame, host: Host) => void;
  hooks?: RuntimeHooksConfig;
  /** Throw from the runtime's frame write when this returns true (a closed channel). */
  failWrite?: (f: WinterFrame) => boolean;
  capabilities?: string[];
  mcpServers?: Record<string, unknown>;
  /** The session's lanes -- share one map between two runs to make them two engines of ONE session. */
  toolLaneTails?: ToolLaneTails;
  /** Handed the host handle as soon as the run starts (an executor can then interrupt its own turn). */
  onHost?: (host: Host) => void;
}

const userFrameIds = (f: WinterFrame): string[] | undefined => {
  const msg = (f as { message?: { type?: string; message?: { content?: Array<{ type?: string; tool_use_id?: string }> } } }).message;
  if (f.type !== "data" || msg?.type !== "user") return undefined;
  return (msg.message?.content ?? []).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id!);
};
const resultFrames = (frames: WinterFrame[]): string[][] => frames.map(userFrameIds).filter((ids): ids is string[] => ids !== undefined && ids.length > 0);
const idsOf = (blocks: unknown): string[] => (blocks as Array<{ tool_use_id: string }>).map((b) => b.tool_use_id);
const hookRequest = (f: WinterFrame): { requestId: string; event: string; toolUseID?: string } | undefined => {
  if (f.type !== "control_request" || (f as ControlRequestFrame).subtype !== "hook") return undefined;
  const p = (f as ControlRequestFrame).payload as { event: string; toolUseID?: string };
  return { requestId: (f as ControlRequestFrame).requestId, event: p.event, ...(p.toolUseID !== undefined ? { toolUseID: p.toolUseID } : {}) };
};

/** One engine run: the model makes `calls` in ONE round, then answers "done". */
async function run(calls: Call[], execute: Executor, opts: RunOptions = {}) {
  const requests: ProviderRequest[] = [];
  const recorded: unknown[] = [];
  const { host, runtime } = createInMemoryChannel();
  const output = opts.failWrite === undefined
    ? runtime.output
    : { ...runtime.output, write: (f: WinterFrame) => { if (opts.failWrite!(f)) throw new Error("the channel is closed"); runtime.output.write(f); } };
  const done = runEngine({
    config: {
      sessionId: "s-per-call", cwd: dir, model: "anthropic/claude-sonnet-5-5", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
      ...(opts.hooks !== undefined ? { hooks: opts.hooks } : {}),
      ...(opts.capabilities !== undefined ? { capabilities: opts.capabilities } : {}),
      ...(opts.mcpServers !== undefined ? { mcpServers: opts.mcpServers } : {}),
    },
    input: runtime.input,
    output,
    provider: {
      async generate(req) {
        requests.push({ ...req, messages: structuredClone(req.messages) });
        return requests.length === 1 ? { kind: "tool_use", calls } : { kind: "text", text: "done" };
      },
    },
    tools: { execute },
    ...(opts.toolLaneTails !== undefined ? { toolLaneTails: opts.toolLaneTails } : {}),
    providerIdentity: { providerId: "anthropic", modelKey: "anthropic/claude-sonnet-5-5", family: "anthropic" },
    describeModel: () => ({}),
    store: {
      recordUserEntry(content: string | ContentBlock[]) { recorded.push(structuredClone(content)); },
      recordAssistantEntry() {},
    },
  } as EngineOptions);
  const frames: WinterFrame[] = [];
  const handle: Host = {
    interrupt: () => host.output.write({ type: "control_request", requestId: "int-1", subtype: "interrupt", payload: { scope: "turn" } }),
    answer: (requestId, payload) => host.output.write({ type: "control_response", requestId, ok: true, payload }),
  };
  opts.onHost?.(handle);
  const reader = (async () => {
    for await (const f of host.input) {
      frames.push(f);
      opts.onFrame?.(f, handle);
    }
  })();
  host.output.write({ type: "user", text: "go" });
  let error: unknown;
  const finished = done.then(() => undefined, (e: unknown) => { error = e; });
  for (let n = 0; n < 5000 && error === undefined && !frames.some((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result"); n++) await new Promise((r) => setTimeout(r, 2));
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  await finished;
  await Promise.race([reader, new Promise((r) => setTimeout(r, 200))]);
  const toolMessages = requests[1]?.messages.filter((m) => (m as { role: string }).role === "tool") ?? [];
  const roundEntries = recorded.filter((c) => Array.isArray(c) && (c as ContentBlock[]).some((b) => b.type === "tool_result"));
  const result = frames.map((f) => (f as { message?: Record<string, unknown> }).message).find((m) => m?.["type"] === "result");
  return { frames, toolMessages, roundEntries, requests, result, error };
}

/** A promise per call id, resolved by the test -- so the completion order is the TEST's choice, not timing's. */
function gates(ids: string[]) {
  const release = new Map<string, () => void>();
  const wait = new Map(ids.map((id) => [id, new Promise<void>((r) => release.set(id, r))]));
  return { wait: (id: string) => wait.get(id)!, release: (id: string) => release.get(id)!() };
}
/** One macrotask -- lets anything that COULD start do so, before an assertion that it did not. */
const flush = () => new Promise((r) => setTimeout(r, 0));

const read = (id: string, path = id): Call => ({ id, name: "Read", input: { file_path: join("/tmp", path) } });
const write = (id: string): Call => ({ id, name: "Write", input: { file_path: join("/tmp", `${id}.txt`), content: "x" } });

describe("a round's read-only calls run concurrently; results reach the host as each finishes", () => {
  test("three reads all in flight at once; frames in COMPLETION order; the model's message in CALL order", async () => {
    const g = gates(["a", "b", "c"]);
    const running = new Set<string>();
    let allThreeAtOnce = false;
    const { frames, toolMessages, roundEntries } = await run([read("a"), read("b"), read("c")], async (call) => {
      running.add(call.id);
      if (running.size === 3) {
        allThreeAtOnce = true;
        g.release("c");
      }
      await g.wait(call.id);
      running.delete(call.id);
      return { output: `${call.id} result` };
    }, {
      onFrame: (f) => {
        const ids = userFrameIds(f);
        if (ids?.[0] === "c") g.release("a");
        if (ids?.[0] === "a") g.release("b");
      },
    });
    expect(allThreeAtOnce).toBe(true);
    expect(resultFrames(frames)).toEqual([["c"], ["a"], ["b"]]);
    expect(toolMessages).toHaveLength(1);
    expect(idsOf((toolMessages[0] as { content: unknown }).content)).toEqual(["a", "b", "c"]);
    expect(roundEntries).toHaveLength(1);
    expect(idsOf(roundEntries[0])).toEqual(["a", "b", "c"]);
  });

  test("an unsafe call is a barrier: it starts only once the reads before it are done, and the reads after it wait for it", async () => {
    const g = gates(["a", "b", "w", "c", "d"]);
    const started: string[] = [];
    const finished = new Set<string>();
    const finishedWhenStarted = new Map<string, string[]>();
    const { frames, toolMessages } = await run([read("a"), read("b"), write("w"), read("c"), read("d")], async (call) => {
      started.push(call.id);
      finishedWhenStarted.set(call.id, [...finished].sort());
      if (started.length === 2 || started.length === 4) g.release(call.id === "b" ? "b" : "d"); // b, then d, finish first
      await g.wait(call.id);
      finished.add(call.id);
      return { output: `${call.id} result` };
    }, {
      onFrame: (f) => {
        const ids = userFrameIds(f);
        if (ids?.[0] === "b") g.release("a");
        if (ids?.[0] === "a") g.release("w");
        if (ids?.[0] === "d") g.release("c");
      },
    });
    expect(started).toEqual(["a", "b", "w", "c", "d"]);
    // a and b overlapped; w started only once BOTH had finished; c and d only once w had.
    expect(finishedWhenStarted.get("b")).toEqual([]);
    expect(finishedWhenStarted.get("w")).toEqual(["a", "b"]);
    expect(finishedWhenStarted.get("c")).toEqual(["a", "b", "w"]);
    expect(finishedWhenStarted.get("d")).toEqual(["a", "b", "w"]);
    expect(resultFrames(frames)).toEqual([["b"], ["a"], ["w"], ["d"], ["c"]]);
    expect(idsOf((toolMessages[0] as { content: unknown }).content)).toEqual(["a", "b", "w", "c", "d"]);
  });

  test(`at most ${MAX_TOOL_CONCURRENCY} calls run at once: the next starts only when one finishes`, async () => {
    const ids = Array.from({ length: MAX_TOOL_CONCURRENCY + 3 }, (_, i) => `r${i}`);
    const g = gates(ids);
    const started: string[] = [];
    let startedWhenCapReached = -1;
    const result = run(ids.map((id) => read(id)), async (call) => {
      started.push(call.id);
      if (started.length === MAX_TOOL_CONCURRENCY) {
        // Every call held: let anything that could start start, then record -- and only then release one.
        void flush().then(() => {
          startedWhenCapReached = started.length;
          for (const id of ids) g.release(id);
        });
      }
      await g.wait(call.id);
      return { output: `${call.id} result` };
    });
    const { frames, toolMessages } = await result;
    expect(startedWhenCapReached).toBe(MAX_TOOL_CONCURRENCY);
    expect(resultFrames(frames).flat().sort()).toEqual([...ids].sort());
    expect(idsOf((toolMessages[0] as { content: unknown }).content)).toEqual(ids);
  });

  test("PostToolUse hooks of concurrent calls: each frame waits for its own hook; the hooks' context reaches the model in CALL order", async () => {
    const g = gates(["a", "b", "c"]);
    let started = 0;
    let answered = 0;
    const { frames, requests } = await run([read("a"), read("b"), read("c")], async (call) => {
      if (++started === 3) g.release("c");
      await g.wait(call.id);
      return { output: `${call.id} result` };
    }, {
      hooks: { PostToolUse: [{ hookCount: 1, source: "sdk" }] },
      onFrame: (f, host) => {
        const hook = hookRequest(f);
        if (hook !== undefined) {
          // Numbered in FIRING order -- completion order (c, b, a).
          host.answer(hook.requestId, { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `ctx-${++answered}` } });
          return;
        }
        const ids = userFrameIds(f);
        if (ids?.[0] === "c") g.release("b");
        if (ids?.[0] === "b") g.release("a");
      },
    });
    expect(resultFrames(frames)).toEqual([["c"], ["b"], ["a"]]);
    const text = JSON.stringify(requests[1]!.messages);
    const at = (n: number) => text.indexOf(`hook additional context: ctx-${n}`);
    expect([at(3), at(2), at(1)].every((i) => i >= 0)).toBe(true);
    expect(at(3)).toBeLessThan(at(2));
    expect(at(2)).toBeLessThan(at(1));
  });

  test("an interrupt mid-batch: the finished call keeps its result, the calls in flight are answered [interrupted], each exactly once, in call order", async () => {
    const { frames, toolMessages, roundEntries } = await run([read("a"), read("b"), read("c")], async (call, opts) => {
      if (call.id === "a") return { output: "a result" };
      await new Promise<void>((resolve) => opts?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return { output: `${call.id} aborted late` };
    }, {
      onFrame: (f, host) => {
        if (userFrameIds(f)?.[0] === "a") host.interrupt();
      },
    });
    expect(resultFrames(frames)).toEqual([["a"], ["b", "c"]]);
    const blocks = (roundEntries[0] ?? []) as Array<{ tool_use_id: string; content: unknown; interrupted?: boolean }>;
    expect(blocks.map((b) => [b.tool_use_id, b.interrupted === true])).toEqual([["a", false], ["b", true], ["c", true]]);
    expect(blocks[0]!.content).toBe("a result");
    expect(toolMessages).toHaveLength(0);
  });
});

describe("failures under concurrency", () => {
  test("two concurrent calls throw: each is answered with ITS OWN error, the round's result names the FIRST", async () => {
    const g = gates(["a", "b"]);
    const { roundEntries, result } = await run([read("a"), read("b"), read("c")], async (call) => {
      if (call.id === "c") return { output: "c ok" };
      await g.wait(call.id);
      throw new Error(`boom-${call.id}`);
    }, {
      onFrame: (f) => {
        // c finishes first; then a throws; b throws only after a's throw has been handled.
        if (userFrameIds(f)?.[0] === "c") {
          g.release("a");
          void flush().then(() => g.release("b"));
        }
      },
    });
    const blocks = (roundEntries[0] ?? []) as Array<{ tool_use_id: string; content: unknown }>;
    expect(blocks.map((b) => [b.tool_use_id, b.content])).toEqual([["a", "[error: boom-a]"], ["b", "[error: boom-b]"], ["c", "c ok"]]);
    expect(result?.["subtype"]).toBe("error_during_execution");
    expect(result?.["result"]).toBe("boom-a");
  });

  test("a concurrent call's PostToolUseFailure (a throw) is applied at settle, in CALL order", async () => {
    const g = gates(["a", "b"]);
    let started = 0;
    let fired = 0;
    const notices: string[] = [];
    await run([read("a"), read("b")], async (call) => {
      if (++started === 2) g.release("b"); // b fails first
      await g.wait(call.id);
      throw new Error(`boom-${call.id}`);
    }, {
      hooks: { PostToolUseFailure: [{ hookCount: 1, source: "sdk" }] },
      onFrame: (f, host) => {
        const hook = hookRequest(f);
        if (hook?.event === "PostToolUseFailure") {
          // Numbered in FIRING order: b's is fired-1, a's fired-2.
          host.answer(hook.requestId, { systemMessage: `fired-${++fired}` });
          if (fired === 1) g.release("a");
          return;
        }
        const msg = (f as { message?: { subtype?: string; content?: string } }).message;
        if (f.type === "data" && msg?.subtype === "informational" && typeof msg.content === "string" && msg.content.startsWith("fired-")) notices.push(msg.content);
      },
    });
    // Applied at settle in CALL order: a's notice, then b's.
    expect(notices).toEqual(["fired-2", "fired-1"]);
  });

  test("a FINISHED call's PostToolUse `continue: false` stops the round before a later call's checks: no further card, no further start", async () => {
    const executed: string[] = [];
    const preToolUseFor: string[] = [];
    let heldPre: { requestId: string } | undefined;
    const { frames, roundEntries, result } = await run([read("a"), read("b"), read("c")], async (call) => {
      executed.push(call.id);
      return { output: `${call.id} result` };
    }, {
      hooks: { PreToolUse: [{ hookCount: 1, source: "sdk" }], PostToolUse: [{ hookCount: 1, source: "sdk" }] },
      onFrame: (f, host) => {
        const hook = hookRequest(f);
        if (hook?.event === "PreToolUse") {
          preToolUseFor.push(hook.toolUseID ?? "?");
          // b's checks are held (its "card") until a has finished and its stop is known.
          if (hook.toolUseID === "b") heldPre = hook;
          else host.answer(hook.requestId, {});
          return;
        }
        if (hook?.event === "PostToolUse") {
          host.answer(hook.requestId, hook.toolUseID === "a" ? { continue: false, stopReason: "enough" } : {});
          return;
        }
        if (userFrameIds(f)?.[0] === "a" && heldPre !== undefined) host.answer(heldPre.requestId, {});
      },
    });
    expect(executed).toEqual(["a"]);
    // c never got as far as its checks (no PreToolUse for it).
    expect(preToolUseFor).toEqual(["a", "b"]);
    const blocks = (roundEntries[0] ?? []) as Array<{ tool_use_id: string; content: unknown }>;
    expect(blocks.map((b) => b.tool_use_id)).toEqual(["a", "b", "c"]);
    expect(String(blocks[1]!.content)).toContain("hook stopped the turn");
    expect(String(blocks[2]!.content)).toContain("hook stopped the turn");
    expect(resultFrames(frames)).toEqual([["a"], ["b"], ["c"]]);
    expect(result?.["terminal_reason"]).toBe("hook_stopped");
  });

  test("a call whose checks were under way when a sibling THREW does not start once they pass: it is padded like the calls never reached", async () => {
    const executed: string[] = [];
    let heldPre: { requestId: string } | undefined;
    const { roundEntries } = await run([read("a"), read("b")], async (call) => {
      executed.push(call.id);
      if (call.id === "a") throw new Error("boom-a");
      return { output: "b ok" };
    }, {
      hooks: { PreToolUse: [{ hookCount: 1, source: "sdk" }], PostToolUseFailure: [{ hookCount: 1, source: "sdk" }] },
      onFrame: (f, host) => {
        const hook = hookRequest(f);
        if (hook?.event === "PreToolUse") {
          if (hook.toolUseID === "b") heldPre = hook;
          else host.answer(hook.requestId, {});
          return;
        }
        if (hook?.event === "PostToolUseFailure") {
          host.answer(hook.requestId, {});
          // a has thrown: only now let b's checks finish.
          if (heldPre !== undefined) host.answer(heldPre.requestId, {});
        }
      },
    });
    expect(executed).toEqual(["a"]);
    const blocks = (roundEntries[0] ?? []) as Array<{ tool_use_id: string; content: unknown }>;
    expect(blocks.map((b) => [b.tool_use_id, b.content])).toEqual([["a", "[error: boom-a]"], ["b", "[error: boom-a]"]]);
  });

  test("a failure OUTSIDE a call (a frame that cannot be written) still pads and records the round before it is rethrown", async () => {
    const { roundEntries, error, result } = await run([read("a"), read("b"), read("c")], async (call) => ({ output: `${call.id} result` }), {
      failWrite: (f) => userFrameIds(f)?.[0] === "b",
    });
    // The failure still ends the turn as an error...
    expect(error !== undefined || result?.["is_error"] === true).toBe(true);
    // ...but only after the round was recorded with a result for EVERY call: no dangling tool_use.
    expect(roundEntries).toHaveLength(1);
    expect(idsOf(roundEntries[0])).toEqual(["a", "b", "c"]);
  });
});

describe("concurrency lanes (McpSdkServerConfig.toolLanes)", () => {
  test("a lane's calls run one at a time in call order, beside the round's other calls", async () => {
    // The host's in-process server, declared the way a host declares it (`McpSdkServerConfig.toolLanes`).
    const lanesrv = {
      type: "sdk",
      name: "lanesrv",
      tools: [{ name: "screen", inputSchema: { type: "object" } }, { name: "web", inputSchema: { type: "object" } }],
      toolLanes: { screen: "screen", web: "web" },
    };
    {
      const g = gates(["s1", "w1", "s2", "r"]);
      const started: string[] = [];
      const call = (id: string, tool: string): Call => ({ id, name: `mcp__lanesrv__${tool}`, input: {} });
      let s2StartedBeforeS1Done = false;
      let s1Done = false;
      let runningTogether: string[] = [];
      const { frames, toolMessages } = await run([call("s1", "screen"), call("w1", "web"), call("s2", "screen"), read("r")], async (c) => {
        started.push(c.id);
        if (c.id === "s2" && !s1Done) s2StartedBeforeS1Done = true;
        if (started.length === 3) {
          // Everything that COULD start has: snapshot, then let them finish.
          void flush().then(() => {
            runningTogether = [...started].sort();
            g.release("r");
            g.release("w1");
            g.release("s1");
          });
        }
        if (c.id === "s2") g.release("s2");
        await g.wait(c.id);
        if (c.id === "s1") s1Done = true;
        return { output: `${c.id} result` };
      }, { capabilities: ["winter.mcp"], mcpServers: { lanesrv } });
      // s1 (lane "screen"), w1 (lane "web") and r (read-only) ran together; s2 (lane "screen") waited for s1.
      expect(runningTogether).toEqual(["r", "s1", "w1"]);
      expect(s2StartedBeforeS1Done).toBe(false);
      expect(resultFrames(frames).flat().sort()).toEqual(["r", "s1", "s2", "w1"]);
      expect(idsOf((toolMessages[0] as { content: unknown }).content)).toEqual(["s1", "w1", "s2", "r"]);
    }
  });
});

describe("a lane is held until the call's work has really stopped (two engines of one session)", () => {
  const laneServer = (name: string) => ({
    type: "sdk",
    name,
    tools: [{ name: "screen", inputSchema: { type: "object" } }],
    toolLanes: { screen: "screen" },
  });

  test("an interrupted lane call keeps its lane until its execution settles; the next holder starts only then", async () => {
    const lanes = createToolLaneTails();
    let host1: Host | undefined;
    let releaseStop!: () => void;
    const stopped = new Promise<void>((r) => (releaseStop = r));
    let s1Settled = false;
    let s2StartedWhileS1Running: boolean | undefined;
    // Engine 1: its lane call is interrupted while running, and its "host" takes a while to actually stop.
    const first = await run([{ id: "s1", name: "mcp__lanesrv1__screen", input: {} }], async (_call, opts) => {
      queueMicrotask(() => host1!.interrupt());
      await new Promise<void>((resolve) => opts?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      await stopped; // still stopping after the cancel
      s1Settled = true;
      return { output: "s1 stopped late" };
    }, { capabilities: ["winter.mcp"], mcpServers: { lanesrv1: laneServer("lanesrv1") }, toolLaneTails: lanes, onHost: (h) => { host1 = h; } });
    expect(resultFrames(first.frames)).toEqual([["s1"]]); // engine 1 answered s1 [interrupted] and moved on
    expect(s1Settled).toBe(false);
    // Engine 2 of the same session: its call of the same lane must wait for s1's work to stop.
    const second = run([{ id: "s2", name: "mcp__lanesrv2__screen", input: {} }], async () => {
      s2StartedWhileS1Running = !s1Settled;
      return { output: "s2 result" };
    }, { capabilities: ["winter.mcp"], mcpServers: { lanesrv2: laneServer("lanesrv2") }, toolLaneTails: lanes });
    for (let i = 0; i < 20; i++) await flush();
    expect(s2StartedWhileS1Running).toBeUndefined(); // not started: the lane is still held
    releaseStop();
    const { frames } = await second;
    expect(s2StartedWhileS1Running).toBe(false);
    expect(resultFrames(frames)).toEqual([["s2"]]);
  });
});

describe("enterToolLane (one session's lanes, shared by every engine of the session)", () => {
  test("each entrant waits for the previous one of its lane only; a settled lane is dropped", async () => {
    const lanes = createToolLaneTails();
    let releaseA!: () => void;
    const a = new Promise<void>((r) => (releaseA = r));
    expect(enterToolLane(lanes, "screen", a)).toBeUndefined();
    const b = Promise.resolve();
    expect(enterToolLane(lanes, "web", b)).toBeUndefined(); // another lane: nothing to wait for
    let releaseC!: () => void;
    const c = new Promise<void>((r) => (releaseC = r));
    expect(enterToolLane(lanes, "screen", c)).toBe(a); // the second "screen" entrant waits for the first
    await b;
    await Promise.resolve();
    expect(lanes.has("web")).toBe(false); // settled and still the tail: dropped
    releaseA();
    await a;
    await Promise.resolve();
    expect(lanes.has("screen")).toBe(true); // a settled, but c is still the lane's holder: kept
    releaseC();
    await c;
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(lanes.size).toBe(0);
  });

  test("a holder that gives up while still waiting its turn never lets the next one start beside the running holder", async () => {
    const lanes = createToolLaneTails();
    let releaseA!: () => void;
    const a = new Promise<void>((r) => (releaseA = r)); // running
    enterToolLane(lanes, "screen", a);
    enterToolLane(lanes, "screen", Promise.resolve()); // b: entered, then interrupted while waiting -- released at once
    const waitForTurn = enterToolLane(lanes, "screen", new Promise<void>(() => {}))!; // c
    let cMayStart = false;
    void waitForTurn.then(() => { cMayStart = true; });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(cMayStart).toBe(false); // a is still running
    releaseA();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(cMayStart).toBe(true);
  });
});

describe("schedulingForCall", () => {
  test("an MCP tool is concurrent only with readOnlyHint: true; false or absent is serial; a host lane is a lane", () => {
    registerMcpServerTools("hintsrv", [
      { name: "ro", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "rw", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
      { name: "none", inputSchema: { type: "object" } },
      { name: "laned", inputSchema: { type: "object" } },
      { name: "badlane", inputSchema: { type: "object" } },
    ], { deferredDefault: false, toolLanes: { laned: "the-lane", badlane: "not a lane!" } });
    try {
      expect(schedulingForCall("mcp__hintsrv__ro", {})).toEqual({ kind: "concurrent" });
      expect(schedulingForCall("mcp__hintsrv__rw", {})).toEqual({ kind: "serial" });
      expect(schedulingForCall("mcp__hintsrv__none", {})).toEqual({ kind: "serial" });
      expect(schedulingForCall("mcp__hintsrv__laned", {})).toEqual({ kind: "lane", lane: "the-lane" });
      expect(schedulingForCall("mcp__hintsrv__badlane", {})).toEqual({ kind: "serial" });
    } finally {
      unregisterMcpServerTools("hintsrv");
    }
  });

  test("built-ins: the readers, the web tools and Agent are concurrent; Write, ToolSearch and unknown names are serial", () => {
    for (const name of ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "Agent"]) expect(schedulingForCall(name, {}).kind).toBe("concurrent");
    for (const name of ["Write", "Edit", "ToolSearch", "no-such-tool"]) expect(schedulingForCall(name, {}).kind).toBe("serial");
  });

  test("Bash is concurrent only for a command claude classifies read-only (and never a sandbox escape)", () => {
    const ctx = { cwd: dir, originalCwd: dir, sandboxEnabled: true };
    expect(schedulingForCall("Bash", { command: "ls -la" }, ctx).kind).toBe("concurrent");
    expect(schedulingForCall("Bash", { command: "cat a.txt | grep x | sort" }, ctx).kind).toBe("concurrent");
    expect(schedulingForCall("Bash", { command: "rm -rf build" }, ctx).kind).toBe("serial");
    expect(schedulingForCall("Bash", { command: "echo hi > f" }, ctx).kind).toBe("serial");
    expect(schedulingForCall("Bash", { command: "ls", dangerouslyDisableSandbox: true }, ctx).kind).toBe("serial");
    expect(schedulingForCall("Bash", { command: "ls" }).kind).toBe("serial"); // no session context: never guessed
  });
});
