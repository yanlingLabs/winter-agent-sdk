// WS-24: async hooks (hooks/async-hooks.ts) -- the queue on its own, then real command hooks through
// the real invoker and runner (both doors: DECLARED `async: true` and an ANNOUNCED `{"async": true}`
// first line), then the engine delivering what one said at the next safe point.
import { afterEach, describe, expect, test } from "bun:test";
import type { ControlRequestFrame, RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createAsyncHookQueue, finishedOutput, type AsyncHookJob, type FinishedHookProcess } from "./async-hooks.ts";
import { createCommandHookInvoker } from "./command-invoker.ts";
import { buildHookEntriesFromSettings } from "./from-config.ts";
import { buildHookRegistry, type SourcedHookEntry } from "./registry.ts";
import { runHooks, type HookInvoker, type RunHooksContext } from "./runner.ts";
import { MAX_HOOK_TEXT_CHARS } from "./bounds.ts";
import { liveProcessGroups } from "../process-groups.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type ContentBlock, type Provider, type ProviderMessage, type ProviderTurn } from "../engine.ts";
import { stubExecutor } from "../provider/mock.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await sleep(20);
  }
}

// --- the queue ------------------------------------------------------------------------------------

function manualJob(overrides: Partial<AsyncHookJob> = {}): { job: AsyncHookJob; finish: (f: FinishedHookProcess) => void; killed: () => number } {
  let finish!: (f: FinishedHookProcess) => void;
  let kills = 0;
  const job: AsyncHookJob = {
    event: "PostToolUse",
    hookName: "PostToolUse:Edit",
    finished: new Promise<FinishedHookProcess>((resolve) => (finish = resolve)),
    kill: () => {
      kills++;
      finish({ exitCode: null, stdout: "" });
    },
    timeoutMs: 60_000,
    ...overrides,
  };
  return { job, finish, killed: () => kills };
}

describe("finishedOutput: an async hook can only TALK", () => {
  test("systemMessage and additionalContext are read; every decision-shaped field is ignored", () => {
    const stdout = JSON.stringify({
      systemMessage: "tests passed",
      decision: "block",
      reason: "no",
      continue: false,
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", updatedInput: { x: 2 }, additionalContext: "3 tests ran" },
    });
    expect(finishedOutput("PreToolUse", { exitCode: 0, stdout })).toEqual({ systemMessage: "tests passed", additionalContext: "3 tests ran" });
  });

  test("a non-zero exit (2 included: a block it can no longer perform) or a kill says nothing", () => {
    const stdout = JSON.stringify({ systemMessage: "x" });
    expect(finishedOutput("PostToolUse", { exitCode: 2, stdout })).toEqual({});
    expect(finishedOutput("PostToolUse", { exitCode: 1, stdout })).toEqual({});
    expect(finishedOutput("PostToolUse", { exitCode: null, stdout })).toEqual({});
  });

  test("plain text is context only for the three events whose stdout is context; malformed JSON is silence", () => {
    expect(finishedOutput("SessionStart", { exitCode: 0, stdout: "project briefing" })).toEqual({ additionalContext: "project briefing" });
    expect(finishedOutput("PostToolUse", { exitCode: 0, stdout: "just logging" })).toEqual({});
    expect(finishedOutput("PostToolUse", { exitCode: 0, stdout: "{not json" })).toEqual({});
  });

  test("every text is capped like a synchronous hook's", () => {
    const out = finishedOutput("PostToolUse", { exitCode: 0, stdout: JSON.stringify({ systemMessage: "a".repeat(MAX_HOOK_TEXT_CHARS * 2) }) });
    expect(out.systemMessage!.length).toBeLessThan(MAX_HOOK_TEXT_CHARS + 100);
    expect(out.systemMessage).toContain("truncated");
  });
});

describe("the queue's bounds", () => {
  test("a finished job's output is drained once, oldest first", async () => {
    const queue = createAsyncHookQueue({ warn: () => {} });
    const a = manualJob({ hookName: "A" });
    const b = manualJob({ hookName: "B" });
    queue.adopt(a.job);
    queue.adopt(b.job);
    a.finish({ exitCode: 0, stdout: JSON.stringify({ systemMessage: "from A" }) });
    b.finish({ exitCode: 0, stdout: JSON.stringify({ systemMessage: "from B" }) });
    await sleep(0);
    expect(queue.drain()).toEqual({ outputs: [{ hookName: "A", systemMessage: "from A" }, { hookName: "B", systemMessage: "from B" }], dropped: 0 });
    expect(queue.drain()).toEqual({ outputs: [], dropped: 0 });
  });

  test("the timeout kills a job, and a killed job says nothing", async () => {
    const warnings: string[] = [];
    const queue = createAsyncHookQueue({ warn: (l) => warnings.push(l) });
    const slow = manualJob({ timeoutMs: 30 });
    queue.adopt(slow.job);
    await until(() => slow.killed() > 0);
    await sleep(0);
    expect(queue.running()).toBe(0);
    expect(queue.drain().outputs).toEqual([]);
    expect(warnings.join("\n")).toContain("was killed after 30 ms");
  });

  test("past the concurrency cap a new job is refused -- killed at once, never queued", () => {
    const warnings: string[] = [];
    const queue = createAsyncHookQueue({ maxRunning: 2, warn: (l) => warnings.push(l) });
    const jobs = [manualJob(), manualJob(), manualJob()];
    expect(jobs.map((j) => queue.adopt(j.job))).toEqual([true, true, false]);
    expect(jobs.map((j) => j.killed())).toEqual([0, 0, 1]);
    expect(queue.running()).toBe(2);
    expect(warnings).toHaveLength(1);
  });

  test("past the pending cap the OLDEST output is dropped, and the drain says how many", async () => {
    const queue = createAsyncHookQueue({ maxPending: 2, warn: () => {} });
    for (const name of ["one", "two", "three"]) {
      const j = manualJob({ hookName: name });
      queue.adopt(j.job);
      j.finish({ exitCode: 0, stdout: JSON.stringify({ systemMessage: name }) });
      await sleep(0);
    }
    const drained = queue.drain();
    expect(drained.outputs.map((o) => o.hookName)).toEqual(["two", "three"]);
    expect(drained.dropped).toBe(1);
  });

  test("dispose() (session end) kills every running job and forgets everything undelivered", async () => {
    const queue = createAsyncHookQueue({ warn: () => {} });
    const running = manualJob();
    const done = manualJob();
    queue.adopt(running.job);
    queue.adopt(done.job);
    done.finish({ exitCode: 0, stdout: JSON.stringify({ systemMessage: "never delivered" }) });
    await sleep(0);
    queue.dispose();
    expect(running.killed()).toBe(1);
    expect(queue.drain()).toEqual({ outputs: [], dropped: 0 });
    const late = manualJob();
    expect(queue.adopt(late.job)).toBe(false);
    expect(late.killed()).toBe(1);
  });
});

// --- real command hooks through the invoker and the runner ------------------------------------------

const invokers: Array<{ asyncHooks: { dispose(): void } }> = [];
afterEach(() => {
  for (const i of invokers.splice(0)) i.asyncHooks.dispose();
});

const NEVER_NEXT: HookInvoker = { invoke: async () => ({}) };

function setup(entries: SourcedHookEntry[]): { invoker: ReturnType<typeof createCommandHookInvoker>; ctx: RunHooksContext } {
  const invoker = createCommandHookInvoker(entries, { next: NEVER_NEXT, cwd: "/" });
  invokers.push(invoker);
  const ctx: RunHooksContext = { registry: buildHookRegistry(entries), invoker, audit: { record: () => {} }, sessionId: "s", policyVersion: 1, timeouts: { gatingTimeoutMs: 5000, observationalTimeoutMs: 5000 } };
  return { invoker, ctx };
}

describe("DECLARED async (a handler's `async: true`)", () => {
  test("the runner is answered at once; what the hook says arrives later through the queue", async () => {
    const { invoker, ctx } = setup([
      { id: "h", event: "PostToolUse", source: "user", async: true, command: `sleep 1; echo '{"systemMessage":"lint clean","hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"0 warnings"}}'` },
    ]);
    const started = Date.now();
    const composite = await runHooks("PostToolUse", { toolUseID: "tu-1", toolName: "Edit", payload: { tool_response: "ok" } }, ctx);
    expect(Date.now() - started).toBeLessThan(800); // the hook sleeps 1 s: it was not waited for
    expect(composite.decision).toBeUndefined();
    expect(invoker.asyncHooks.running()).toBe(1);
    await until(() => invoker.asyncHooks.running() === 0);
    expect(invoker.asyncHooks.drain().outputs).toEqual([{ hookName: "PostToolUse:Edit", systemMessage: "lint clean", additionalContext: "0 warnings", toolUseID: "tu-1" }]);
  });

  test("its group is in the process-group ledger while it runs, and its own timeout kills it", async () => {
    const { invoker, ctx } = setup([{ id: "h", event: "PostToolUse", source: "user", async: true, timeoutMs: 300, command: `sleep 30; echo '{"systemMessage":"never"}'` }]);
    const before = liveProcessGroups().length;
    await runHooks("PostToolUse", { toolUseID: "tu", toolName: "Edit" }, ctx);
    expect(liveProcessGroups().filter((g) => g.kind === "hook").length).toBeGreaterThan(0);
    await until(() => invoker.asyncHooks.running() === 0, 5000);
    await until(() => liveProcessGroups().length === before, 3000);
    expect(invoker.asyncHooks.drain().outputs).toEqual([]);
  });

  test("session end (dispose) kills a hook still running", async () => {
    const { invoker, ctx } = setup([{ id: "h", event: "PostToolUse", source: "user", async: true, command: "sleep 30" }]);
    const before = liveProcessGroups().length;
    await runHooks("PostToolUse", { toolUseID: "tu", toolName: "Edit" }, ctx);
    expect(invoker.asyncHooks.running()).toBe(1);
    invoker.asyncHooks.dispose();
    await until(() => liveProcessGroups().length === before, 3000);
  });
});

describe("ANNOUNCED async (a first stdout line `{\"async\": true}`)", () => {
  test("the runner is answered on that line; the rest of stdout is the hook's later output", async () => {
    const { invoker, ctx } = setup([{ id: "h", event: "PostToolUse", source: "user", command: `echo '{"async":true,"asyncTimeout":5000}'; sleep 1; echo '{"systemMessage":"later"}'` }]);
    const started = Date.now();
    const composite = await runHooks("PostToolUse", { toolUseID: "tu", toolName: "Bash" }, ctx);
    expect(Date.now() - started).toBeLessThan(800); // the hook runs 1 s past its announcement
    expect(composite.decision).toBeUndefined();
    await until(() => invoker.asyncHooks.running() === 0);
    expect(invoker.asyncHooks.drain().outputs).toEqual([{ hookName: "PostToolUse:Bash", systemMessage: "later", toolUseID: "tu" }]);
  });

  test("an async hook can never deny: neither its announcement nor its later output decides the call", async () => {
    const { invoker, ctx } = setup([
      { id: "h", event: "PreToolUse", source: "user", command: `echo '{"async":true,"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}'; echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}'` },
    ]);
    const composite = await runHooks("PreToolUse", { toolUseID: "tu", toolName: "Bash", input: { command: "ls" } }, ctx);
    expect(composite.decision).toBeUndefined();
    await until(() => invoker.asyncHooks.running() === 0);
    expect(invoker.asyncHooks.drain().outputs).toEqual([]); // a decision is not something it can SAY
  });

  test("a synchronous hook whose first line is not an announcement is waited for exactly as before", async () => {
    const { invoker, ctx } = setup([{ id: "h", event: "PreToolUse", source: "user", command: `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"sync"}}'` }]);
    const composite = await runHooks("PreToolUse", { toolUseID: "tu", toolName: "Bash", input: {} }, ctx);
    expect(composite.decision).toBe("deny");
    expect(invoker.asyncHooks.running()).toBe(0);
  });
});

describe("fail-closed floors stay synchronous", () => {
  test("`async` on a fail-closed PreToolUse/PermissionRequest handler is refused at registration: the hook is KEPT, synchronous, and the refusal reported", () => {
    const built = buildHookEntriesFromSettings([
      {
        source: "user",
        path: "/home/u/settings.json",
        settings: {
          hooks: {
            PreToolUse: [{ hooks: [{ type: "command", command: "floor.sh", failClosed: true, async: true }] }],
            PostToolUse: [{ hooks: [{ type: "command", command: "observe.sh", failClosed: true, async: true }] }],
          },
        },
      },
    ]);
    const pre = built.entries.find((e) => e.event === "PreToolUse")!;
    expect(pre).toMatchObject({ command: "floor.sh", failClosed: true });
    expect(pre.async).toBeUndefined();
    expect(built.rejected).toHaveLength(1);
    expect(built.rejected[0]!.reason).toContain("fail-closed");
    expect(built.rejected[0]!.reason).toContain("registered without async");
    // failClosed means nothing on PostToolUse, so its async stands.
    expect(built.entries.find((e) => e.event === "PostToolUse")!.async).toBe(true);
  });

  test("`async` on a SessionEnd handler is refused too: nothing survives the session's end to run it in the background", () => {
    const built = buildHookEntriesFromSettings([
      { source: "user", settings: { hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "bye.sh", async: true }] }], Stop: [{ hooks: [{ type: "command", command: "stop.sh", async: true }] }] } } },
    ]);
    const end = built.entries.find((e) => e.event === "SessionEnd")!;
    expect(end.command).toBe("bye.sh");
    expect(end.async).toBeUndefined();
    expect(built.rejected).toHaveLength(1);
    expect(built.rejected[0]!.reason).toContain("SessionEnd");
    expect(built.rejected[0]!.reason).toContain("registered without async");
    expect(built.entries.find((e) => e.event === "Stop")!.async).toBe(true);
  });

  test("a fail-closed gating hook that ANNOUNCES async is not backgrounded: it is malformed, so the call is denied", async () => {
    const { invoker, ctx } = setup([{ id: "h", event: "PreToolUse", source: "user", failClosed: true, command: `echo '{"async":true}'; sleep 0.2` }]);
    const composite = await runHooks("PreToolUse", { toolUseID: "tu", toolName: "Bash", input: {} }, ctx);
    expect(composite.decision).toBe("deny");
    expect(invoker.asyncHooks.running()).toBe(0);
  });
});

// --- the engine delivers it at the next safe point ------------------------------------------------

function textOf(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content.map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? textOf(b.content) : "")).join("\n");
}

describe("the engine: delivered between requests, as a harness reminder", () => {
  test("a background PostToolUse hook's output reaches the NEXT request after it finished -- never the one in flight", async () => {
    const { host, runtime } = createInMemoryChannel();
    const requests: ProviderMessage[][] = [];
    const turns: ProviderTurn[] = [{ kind: "tool_use", calls: [{ id: "c1", name: "t", input: {} }] }, { kind: "text", text: "first done" }, { kind: "text", text: "second done" }];
    let i = 0;
    const provider: Provider = {
      async generate(input) {
        requests.push(input.messages.map((m) => ({ ...m })));
        return turns[Math.min(i++, turns.length - 1)]!;
      },
    };
    const config: RuntimeConfig = { sessionId: "s-async", cwd: "/tmp", model: "winter-test/echo", allowedTools: ["t"] };
    const done = runEngine({
      config,
      input: runtime.input,
      output: runtime.output,
      provider,
      tools: stubExecutor,
      extraHookEntries: [{ id: "PostToolUse:user:0:0", event: "PostToolUse", source: "user", async: true, command: `sleep 0.3; echo '{"systemMessage":"tests passed","hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"12 tests ran"}}'` }],
    });
    const frames: WinterFrame[] = [];
    const reading = (async () => {
      for await (const f of host.input) {
        frames.push(f);
        if (f.type === "control_request") host.output.write({ type: "control_response", requestId: (f as ControlRequestFrame).requestId, ok: true, payload: {} });
      }
    })();
    host.output.write({ type: "user", text: "first" });
    await until(() => frames.some((f) => f.type === "data" && JSON.stringify(f).includes("first done")));
    await sleep(700); // the background hook finishes while the session is idle
    host.output.write({ type: "user", text: "second" });
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    await done;
    await reading;

    // The request right after the tool round was built before the hook finished: not in it.
    expect(requests[1]!.map((m) => textOf(m.content)).join("\n")).not.toContain("12 tests ran");
    // The second prompt's request carries it, as a reminder at the tail.
    const second = requests[2]!.map((m) => textOf(m.content)).join("\n");
    expect(second).toContain("<system-reminder>\nAsync PostToolUse:t hook finished in the background: tests passed\n12 tests ran\n</system-reminder>");
    // ...and the systemMessage was the host's notice too.
    expect(JSON.stringify(frames)).toContain('"content":"tests passed"');
  }, 20_000);
});
