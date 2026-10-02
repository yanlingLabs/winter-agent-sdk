// SDK 0.0.40, measured where a host measures it -- at `query()`'s yield -- on BOTH topologies: a spawned
// `winter` process (runtime main.ts under bun, the same engine the compiled binary runs) and an embedded
// Worker. A round's READ-ONLY calls run concurrently and each call's result reaches the host the moment
// THAT call finishes; an unsafe call is a barrier; approval cards come one at a time in call order without
// holding back a call already approved; an interrupt answers every call exactly once. The model's side is
// unchanged: it gets the round's results together, in CALL order.
//
// The model is `winter-test/calls` (the production reserved-namespace double): `CALL` starts a round and
// `+CALL` joins it. The slow tools are an in-process SDK MCP server (`t`), whose `slow` tool is listed
// `readOnlyHint: true` (concurrency-safe) and whose `unsafe` tool carries no hint (a barrier).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSpawn, query, type Options, type SpawnRuntimeOptions, type WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import { spawnEmbeddedWorker } from "./embedded-host.ts";
import { isSandboxAvailable } from "./sandbox/spawn.ts";
import { inMemoryProcess } from "./testing.ts";
import { testProviderByName } from "./provider/mock.ts";
import { listTasks } from "./tools/impl/background-task-runtime.ts";
import { getRegisteredTool } from "./tools/registry.ts";
import type { ToolExecutionContext } from "./tools/registry.ts";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const WORKER_ENTRY = join(import.meta.dir, "embedded-worker.ts");
const SLEEP_SECONDS = 1.5;
const TEMP: string[] = [];
afterAll(() => {
  for (const d of TEMP) rmSync(d, { recursive: true, force: true });
});
function tempDir(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `winter-per-call-${label}-`));
  TEMP.push(d);
  return d;
}

type Spawner = NonNullable<Options["spawnClaudeCodeProcess"]>;
const TOPOLOGIES: Array<[string, (home: string) => Spawner]> = [
  ["a spawned winter process", (home) => (opts: SpawnRuntimeOptions) => defaultSpawn({ ...opts, command: process.execPath, args: [MAIN, ...opts.args], env: { ...opts.env, WINTER_HOME: home } })],
  ["an embedded Worker", () => (opts: SpawnRuntimeOptions) => spawnEmbeddedWorker({ workerEntry: WORKER_ENTRY, spawn: opts })],
];

/** The test's MCP server: `slow` (read-only) and `unsafe` (no hint) each wait `ms`, then answer their `label`. */
function slowServer() {
  const events: Array<{ at: number; what: "start" | "end"; label: string }> = [];
  const instance: WinterMcpServerInstance = {
    listTools: () => [
      { name: "slow", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "unsafe", inputSchema: { type: "object" } },
      // In the host-declared lane "L" (`toolLanes`, below): beside everything, but one at a time within L.
      { name: "laned", inputSchema: { type: "object" } },
    ],
    async callTool(_name, args) {
      const label = String(args["label"]);
      events.push({ at: performance.now(), what: "start", label });
      await Bun.sleep(Number(args["ms"] ?? 0));
      events.push({ at: performance.now(), what: "end", label });
      return { content: [{ type: "text", text: `${label} done` }] };
    },
  };
  return { instance, events };
}

interface Arrival { at: number; message: Record<string, unknown> }
interface RunOptions { canUseTool?: Options["canUseTool"]; onMessage?: (m: Record<string, unknown>, q: { interrupt(): Promise<void> }) => void; server?: ReturnType<typeof slowServer>; cwd?: string }

async function runScript(spawner: Spawner, home: string, script: string, opts: RunOptions = {}) {
  const server = opts.server ?? slowServer();
  const arrivals: Arrival[] = [];
  const q = query({
    prompt: script,
    options: {
      model: "winter-test/calls",
      cwd: opts.cwd ?? tempDir("cwd"),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", WINTER_HOME: home, WINTER_DISABLE_GIT_INSTRUCTIONS: "1" },
      ...(opts.canUseTool !== undefined
        ? { canUseTool: opts.canUseTool }
        : { permissionMode: "bypassPermissions" as const, allowDangerouslySkipPermissions: true }),
      ...(isSandboxAvailable() ? {} : { sandbox: { enabled: false } }),
      capabilities: ["winter.mcp"],
      mcpServers: { t: { type: "sdk", name: "t", instance: server.instance, toolLanes: { laned: "L" } } } as NonNullable<Options["mcpServers"]>,
      spawnClaudeCodeProcess: spawner,
    },
  });
  try {
    for await (const message of q) {
      const m = message as unknown as Record<string, unknown>;
      arrivals.push({ at: performance.now(), message: m });
      opts.onMessage?.(m, q);
    }
  } catch (err) {
    // An interrupted turn may end the stream with the runtime's error result; the arrivals are what is checked.
    if (opts.onMessage === undefined) throw err;
  }
  return { arrivals, events: server.events };
}

/** The `user` frames carrying tool results, each with its arrival time, ids and contents. */
function resultFrames(arrivals: Arrival[], parent?: string): Array<{ at: number; ids: string[]; contents: string[]; flags: Array<Record<string, unknown>> }> {
  return arrivals
    .filter(({ message }) => message["type"] === "user" && (parent === undefined ? message["parent_tool_use_id"] == null : message["parent_tool_use_id"] === parent))
    .map(({ at, message }) => {
      const blocks = ((message["message"] as { content?: Array<Record<string, unknown>> }).content ?? []).filter((b) => b["type"] === "tool_result");
      return { at, ids: blocks.map((b) => String(b["tool_use_id"])), contents: blocks.map((b) => JSON.stringify(b["content"])), flags: blocks };
    })
    .filter((f) => f.ids.length > 0);
}

/** The call ids the model made, in CALL order, and the label each carries. */
function callsOf(arrivals: Arrival[], parent?: string): Array<{ id: string; name: string; label?: string }> {
  return arrivals
    .filter(({ message }) => message["type"] === "assistant" && (parent === undefined ? message["parent_tool_use_id"] == null : message["parent_tool_use_id"] === parent))
    .flatMap(({ message }) => ((message["message"] as { content?: Array<Record<string, unknown>> }).content ?? []).filter((b) => b["type"] === "tool_use"))
    .map((b) => ({ id: String(b["id"]), name: String(b["name"]), ...(typeof (b["input"] as { label?: unknown })?.label === "string" ? { label: (b["input"] as { label: string }).label } : {}) }));
}

const resultOf = (arrivals: Arrival[]) => arrivals.find(({ message }) => message["type"] === "result")!.message;
const slow = (label: string, ms: number, joined = true) => `${joined ? "+" : ""}CALL mcp__t__slow ${JSON.stringify({ label, ms })}`;
const unsafe = (label: string, ms: number, joined = true) => `${joined ? "+" : ""}CALL mcp__t__unsafe ${JSON.stringify({ label, ms })}`;
const laned = (label: string, ms: number, joined = true) => `${joined ? "+" : ""}CALL mcp__t__laned ${JSON.stringify({ label, ms })}`;

// The in-memory leg runs the engine in THIS process, so the test can reach the session's own task
// registry while the round is running -- the one place a single subagent can be stopped from outside.
describe("concurrent subagents on an in-memory process", () => {
  const inMemory = (home: string): Spawner => (opts) => inMemoryProcess(opts.args, testProviderByName("calls"), undefined, { ...opts.env, WINTER_HOME: home });

  test("TaskStop on one of two concurrent subagents stops that one alone; each spawn's result lands exactly once; both children's usage reaches the session", async () => {
    const home = tempDir("home");
    const base = slowServer();
    let stopOutput: string | undefined;
    const server = {
      events: base.events,
      instance: {
        listTools: base.instance.listTools,
        async callTool(toolName: string, args: Record<string, unknown>) {
          if (args["label"] === "one-long") {
            // Child one is now running: stop it by its task id, through the real TaskStop tool.
            const row = listTasks().find((t) => t.kind === "agent" && t.description === "one" && t.status === "running")!;
            const ctx = { sessionId: "test", signal: new AbortController().signal, emitFrame: () => {} } as unknown as ToolExecutionContext;
            const out = await getRegisteredTool("TaskStop")!.executor!.execute({ task_id: row.taskId }, ctx);
            stopOutput = out.output;
          }
          return base.instance.callTool(toolName, args);
        },
      } as WinterMcpServerInstance,
    };
    const script = [
      `CALL Agent ${JSON.stringify({ description: "one", prompt: slow("one-long", 20_000, false), subagent_type: "general-purpose", run_in_background: false })}`,
      `+CALL Agent ${JSON.stringify({ description: "two", prompt: [slow("two-a", 300, false), slow("two-b", 300)].join("\n"), subagent_type: "general-purpose", run_in_background: false })}`,
    ].join("\n");
    const { arrivals, events } = await runScript(inMemory(home), home, script, { server });
    expect(stopOutput).toContain("stopped task");
    const spawns = callsOf(arrivals).filter((c) => c.name === "Agent");
    expect(spawns).toHaveLength(2);
    // Child two was untouched: both its calls ran to the end and both results reached its thread once.
    expect(events.filter((e) => e.what === "end").map((e) => e.label).sort()).toEqual(expect.arrayContaining(["two-a", "two-b"]));
    expect(resultFrames(arrivals, spawns[1]!.id).flatMap((f) => f.contents).join(" ")).toContain("two-a done");
    // Each spawn's own result reached the main thread exactly once (one stopped, one completed)...
    const mainIds = resultFrames(arrivals).flatMap((f) => f.ids);
    expect(mainIds.sort()).toEqual([spawns[0]!.id, spawns[1]!.id].sort());
    const reported = JSON.parse(String(resultOf(arrivals)["result"])) as Array<{ content: string }>;
    expect(reported).toHaveLength(2);
    expect(reported[0]!.content).toContain("stopped by request");
    expect(reported[0]!.content).not.toContain("one-long done");
    // ...and the turn ended normally (no hang, no error), its usage including both children's generations.
    const result = resultOf(arrivals);
    expect(result["subtype"]).toBe("success");
    const modelUsage = result["modelUsage"] as Record<string, { inputTokens: number; outputTokens: number }>;
    const sessionTokens = Object.values(modelUsage).reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
    const own = result["usage"] as { input_tokens: number; output_tokens: number };
    const childTokens = ["one", "two"].map((d) => listTasks().find((t) => t.kind === "agent" && t.description === d)!.usage!()!.total_tokens);
    // The roll-up is a synchronous fold (no await between read and write), so concurrent children cannot
    // lose each other's updates: the session's tokens hold its own last generation AND both children's.
    expect(childTokens.every((n) => n > 0)).toBe(true);
    expect(sessionTokens).toBeGreaterThanOrEqual(own.input_tokens + own.output_tokens + childTokens[0]! + childTokens[1]!);
  }, 60_000);
});

for (const [name, spawnerFor] of TOPOLOGIES) {
  describe(`tool rounds on ${name}`, () => {
    test("read-only calls run concurrently: results arrive in COMPLETION order, the model gets them in CALL order", async () => {
      const home = tempDir("home");
      const { arrivals, events } = await runScript(spawnerFor(home), home, [slow("a", 900, false), slow("b", 300), slow("c", 600)].join("\n"));
      const calls = callsOf(arrivals);
      expect(calls.map((c) => c.label)).toEqual(["a", "b", "c"]);
      expect(new Set(calls.map((c) => c.id)).size).toBe(3);
      const byId = new Map(calls.map((c) => [c.id, c.label]));
      const frames = resultFrames(arrivals);
      expect(frames.map((f) => f.ids.map((id) => byId.get(id)))).toEqual([["b"], ["c"], ["a"]]);
      // They overlapped: every call started before any ended. And the results did not arrive together: the
      // first frame reached the host before the slowest call had even finished (one clock, one process).
      const firstEnd = Math.min(...events.filter((e) => e.what === "end").map((e) => e.at));
      expect(events.filter((e) => e.what === "start").every((e) => e.at < firstEnd)).toBe(true);
      const slowestEnd = events.find((e) => e.what === "end" && e.label === "a")!.at;
      expect(frames[0]!.at).toBeLessThan(slowestEnd);
      const reported = JSON.parse(String(resultOf(arrivals)["result"])) as Array<{ content: string }>;
      expect(reported.map((r) => r.content)).toEqual(["a done", "b done", "c done"]);
    }, 60_000);

    test("an unsafe call between read-only ones serialises the round around it", async () => {
      const home = tempDir("home");
      const { arrivals, events } = await runScript(spawnerFor(home), home, [slow("a", 400, false), unsafe("u", 100), slow("c", 300), slow("d", 100)].join("\n"));
      const at = (what: "start" | "end", label: string) => events.find((e) => e.what === what && e.label === label)!.at;
      expect(at("start", "u")).toBeGreaterThanOrEqual(at("end", "a"));
      expect(Math.min(at("start", "c"), at("start", "d"))).toBeGreaterThanOrEqual(at("end", "u"));
      expect(at("start", "d")).toBeLessThan(at("end", "c")); // c and d still overlap with each other
      const byId = new Map(callsOf(arrivals).map((c) => [c.id, c.label]));
      expect(resultFrames(arrivals).map((f) => f.ids.map((id) => byId.get(id)))).toEqual([["a"], ["u"], ["d"], ["c"]]);
      expect((JSON.parse(String(resultOf(arrivals)["result"])) as Array<{ content: string }>).map((r) => r.content)).toEqual(["a done", "u done", "c done", "d done"]);
    }, 60_000);

    test("approval cards come one at a time in call order; a card does not hold back a call already approved; a denial is that call's result alone", async () => {
      const home = tempDir("home");
      const asked: string[] = [];
      let aFinishedBeforeBAnswered = false;
      const server = slowServer();
      const aEnded = (): boolean => server.events.some((e) => e.what === "end" && e.label === "a");
      const { arrivals, events } = await runScript(spawnerFor(home), home, [slow("a", 600, false), slow("b", 0), slow("c", 100)].join("\n"), {
        canUseTool: async (_tool, input) => {
          const label = String((input as { label?: unknown }).label);
          asked.push(label);
          if (label !== "b") return { behavior: "allow", updatedInput: input };
          // b's card is answered only once a has FINISHED running -- possible only if a ran while b waited.
          for (let n = 0; n < 300 && !aEnded(); n++) await Bun.sleep(10);
          aFinishedBeforeBAnswered = aEnded();
          return { behavior: "deny", message: "not b" };
        },
        server,
      });
      expect(asked).toEqual(["a", "b", "c"]);
      expect(aFinishedBeforeBAnswered).toBe(true);
      expect(events.some((e) => e.label === "b")).toBe(false); // the denied call never ran
      const byId = new Map(callsOf(arrivals).map((c) => [c.id, c.label]));
      const frames = resultFrames(arrivals);
      expect(frames.flatMap((f) => f.ids.map((id) => byId.get(id))).sort()).toEqual(["a", "b", "c"]);
      expect(frames.every((f) => f.ids.length === 1)).toBe(true);
      const bFrame = frames.find((f) => byId.get(f.ids[0]!) === "b")!;
      expect(bFrame.contents[0]).toContain("not b");
      expect(bFrame.flags[0]!["denied"]).toBe(true);
      // The model: the three results in call order, b's being the denial.
      const reported = JSON.parse(String(resultOf(arrivals)["result"])) as Array<{ content: string }>;
      expect(reported.map((r) => r.content.includes("not b") ? "denied" : r.content)).toEqual(["a done", "denied", "c done"]);
    }, 60_000);

    test("an interrupt mid-batch answers every call exactly once: finished ones with their result, the rest [interrupted], in call order", async () => {
      const home = tempDir("home");
      let interrupted = false;
      const { arrivals } = await runScript(spawnerFor(home), home, [slow("a", 50, false), slow("b", 20_000), slow("c", 20_000)].join("\n"), {
        onMessage: (m, q) => {
          if (!interrupted && m["type"] === "user" && JSON.stringify(m).includes("a done")) {
            interrupted = true;
            void q.interrupt();
          }
        },
      });
      expect(interrupted).toBe(true);
      const byId = new Map(callsOf(arrivals).map((c) => [c.id, c.label]));
      const frames = resultFrames(arrivals);
      expect(frames.map((f) => f.ids.map((id) => byId.get(id)))).toEqual([["a"], ["b", "c"]]);
      expect(frames[1]!.flags.every((b) => b["interrupted"] === true)).toBe(true);
    }, 60_000);

    test("serial calls still reach the host one by one: the first call's result arrives before the second call has finished", async () => {
      const home = tempDir("home");
      const cwd = tempDir("cwd");
      const marker = join(cwd, "slow-finished");
      // The second command writes a marker only AFTER its sleep: if the first result arrives while the marker
      // is still absent, it arrived before the second call finished -- causal, not a millisecond gap.
      const script = [`CALL Bash {"command":"echo quick-one"}`, `+CALL Bash ${JSON.stringify({ command: `sleep ${SLEEP_SECONDS}; touch ${marker}; echo slow-one` })}`].join("\n");
      let markerWhenFirstArrived: boolean | undefined;
      const { arrivals } = await runScript(spawnerFor(home), home, script, {
        cwd,
        onMessage: (m) => {
          if (markerWhenFirstArrived === undefined && m["type"] === "user" && JSON.stringify(m).includes("quick-one")) markerWhenFirstArrived = existsSync(marker);
        },
      });
      const frames = resultFrames(arrivals);
      expect(frames.map((f) => f.ids.length)).toEqual([1, 1]);
      expect(frames[0]!.contents[0]).toContain("quick-one");
      expect(frames[1]!.contents[0]).toContain("slow-one");
      expect(markerWhenFirstArrived).toBe(false);
      expect(existsSync(marker)).toBe(true);
    }, 60_000);

    test("two read-only Bash calls run at the same time: the second is already reading before the first can finish", async () => {
      const home = tempDir("home");
      const cwd = tempDir("cwd");
      const a = join(cwd, "fifo-a");
      const b = join(cwd, "fifo-b");
      expect(Bun.spawnSync(["mkfifo", a, b]).exitCode).toBe(0);
      // Causal, not timed: the writer first opens B -- which blocks until `cat fifo-b`, the SECOND call, is
      // reading -- and only then answers A, which the FIRST call is waiting on. Run one after the other, the
      // first call could never finish; after 10 s the fallback answers both "serial", so the test fails
      // rather than hangs.
      const writer = Bun.spawn(["sh", "-c", `exec 3>"${b}"; printf together > "${a}"; printf together >&3`]);
      let fellBack = false;
      const fallback = setTimeout(() => {
        fellBack = true;
        writer.kill();
        Bun.spawn(["sh", "-c", `printf serial > "${a}"`]);
        Bun.spawn(["sh", "-c", `printf serial > "${b}"`]);
      }, 10_000);
      try {
        const script = [`CALL Bash ${JSON.stringify({ command: "cat fifo-a" })}`, `+CALL Bash ${JSON.stringify({ command: "cat fifo-b" })}`].join("\n");
        const { arrivals } = await runScript(spawnerFor(home), home, script, { cwd });
        const reported = JSON.parse(String(resultOf(arrivals)["result"])) as Array<{ content: string }>;
        expect(fellBack).toBe(false);
        expect(reported).toHaveLength(2);
        expect(reported.every((r) => r.content.includes("together"))).toBe(true);
      } finally {
        clearTimeout(fallback);
        writer.kill();
      }
    }, 60_000);

    test("a host-declared lane: its calls run one at a time in call order, while the round's other calls run beside them", async () => {
      const home = tempDir("home");
      const { arrivals, events } = await runScript(spawnerFor(home), home, [laned("x", 400, false), slow("z", 300), laned("y", 50)].join("\n"));
      const at = (what: "start" | "end", label: string) => events.find((e) => e.what === what && e.label === label)!.at;
      expect(at("start", "z")).toBeLessThan(at("end", "x")); // z ran beside x
      expect(at("start", "y")).toBeGreaterThanOrEqual(at("end", "x")); // y (same lane) waited for x
      const reported = JSON.parse(String(resultOf(arrivals)["result"])) as Array<{ content: string }>;
      expect(reported.map((r) => r.content)).toEqual(["x done", "z done", "y done"]);
    }, 60_000);

    test("two subagents run AT THE SAME TIME, each with its own tool calls on its own thread, their approvals relayed to the parent", async () => {
      const home = tempDir("home");
      const server = slowServer();
      const asked: string[] = [];
      const childOne = [slow("p1", 600, false), slow("p2", 100)].join("\n");
      const childTwo = [slow("q1", 600, false)].join("\n");
      const script = [
        `CALL Agent ${JSON.stringify({ description: "one", prompt: childOne, subagent_type: "general-purpose", run_in_background: false })}`,
        `+CALL Agent ${JSON.stringify({ description: "two", prompt: childTwo, subagent_type: "general-purpose", run_in_background: false })}`,
      ].join("\n");
      const { arrivals, events } = await runScript(spawnerFor(home), home, script, {
        server,
        // Every call -- the two spawns and the children's own calls -- asks the parent's host (the relay).
        canUseTool: async (tool, input) => {
          asked.push(tool === "Agent" ? `Agent:${String((input as { description?: unknown }).description)}` : String((input as { label?: unknown }).label));
          return { behavior: "allow", updatedInput: input };
        },
      });
      const spawns = callsOf(arrivals).filter((c) => c.name === "Agent");
      expect(spawns).toHaveLength(2);
      const one = spawns[0]!;
      const two = spawns[1]!;
      // Each child's calls ran on its own thread...
      expect(callsOf(arrivals, one.id).map((c) => c.label)).toEqual(["p1", "p2"]);
      expect(callsOf(arrivals, two.id).map((c) => c.label)).toEqual(["q1"]);
      expect(resultFrames(arrivals, one.id).flatMap((f) => f.ids)).toHaveLength(2);
      expect(resultFrames(arrivals, two.id).flatMap((f) => f.ids)).toHaveLength(1);
      // ...and the two children overlapped: each child's first call started before the other's ended.
      const at = (what: "start" | "end", label: string) => events.find((e) => e.what === what && e.label === label)!.at;
      expect(at("start", "q1")).toBeLessThan(at("end", "p1"));
      expect(at("start", "p1")).toBeLessThan(at("end", "q1"));
      // Every call's approval reached the parent's host, the children's included.
      expect(asked.filter((a) => a.startsWith("Agent:")).sort()).toEqual(["Agent:one", "Agent:two"]);
      expect(asked.filter((a) => !a.startsWith("Agent:")).sort()).toEqual(["p1", "p2", "q1"]);
      // Each spawn's own result came back once, on the main thread.
      expect(resultFrames(arrivals).flatMap((f) => f.ids).sort()).toEqual([one.id, two.id].sort());
    }, 60_000);

    for (const background of [false, true]) test(`a lane holds across the SESSION: two concurrent ${background ? "background" : "foreground"} subagents' lane calls, and the parent's beside them, never overlap`, async () => {
      const home = tempDir("home");
      const server = slowServer();
      // Each child first runs a read-only call (so the two children are demonstrably at work at the same
      // time), then a call in lane L; the parent's own round has a lane-L call beside the two spawns.
      const child = (tag: string) => [slow(`${tag}-read`, 300, false), `CALL mcp__t__laned ${JSON.stringify({ label: `${tag}-lane`, ms: 400 })}`].join("\n");
      const script = [
        `CALL Agent ${JSON.stringify({ description: "one", prompt: child("one"), subagent_type: "general-purpose", run_in_background: background })}`,
        `+CALL Agent ${JSON.stringify({ description: "two", prompt: child("two"), subagent_type: "general-purpose", run_in_background: background })}`,
        laned("parent-lane", 400),
      ].join("\n");
      const { arrivals, events } = await runScript(spawnerFor(home), home, script, { server });
      const at = (what: "start" | "end", label: string) => events.find((e) => e.what === what && e.label === label)!.at;
      // The two children really ran side by side...
      expect(at("start", "two-read")).toBeLessThan(at("end", "one-read"));
      expect(at("start", "one-read")).toBeLessThan(at("end", "two-read"));
      // ...and still no two lane-L calls were ever running at once, wherever they came from.
      const lane = ["one-lane", "two-lane", "parent-lane"].map((label) => ({ label, start: at("start", label), end: at("end", label) })).sort((a, b) => a.start - b.start);
      for (let i = 1; i < lane.length; i++) expect(lane[i]!.start).toBeGreaterThanOrEqual(lane[i - 1]!.end);
      const reported = JSON.parse(String(resultOf(arrivals)["result"])) as Array<{ content: string }>;
      expect(reported).toHaveLength(3);
      expect(reported[2]!.content).toBe("parent-lane done");
    }, 60_000);

    test("an interrupt while two foreground subagents run ends both promptly; each spawn is answered exactly once", async () => {
      const home = tempDir("home");
      let interrupted = false;
      const started = performance.now();
      const script = [
        `CALL Agent ${JSON.stringify({ description: "one", prompt: slow("one-long", 20_000, false), subagent_type: "general-purpose", run_in_background: false })}`,
        `+CALL Agent ${JSON.stringify({ description: "two", prompt: [slow("two-quick", 50, false), `CALL mcp__t__slow ${JSON.stringify({ label: "two-long", ms: 20_000 })}`].join("\n"), subagent_type: "general-purpose", run_in_background: false })}`,
      ].join("\n");
      const { arrivals } = await runScript(spawnerFor(home), home, script, {
        onMessage: (m, q) => {
          // Child two's first result reached the host: both children are mid-call now.
          if (!interrupted && m["type"] === "user" && m["parent_tool_use_id"] != null && JSON.stringify(m).includes("two-quick done")) {
            interrupted = true;
            void q.interrupt();
          }
        },
      });
      expect(interrupted).toBe(true);
      expect(performance.now() - started).toBeLessThan(15_000); // neither 20 s call ran out
      const spawns = callsOf(arrivals).filter((c) => c.name === "Agent");
      expect(spawns).toHaveLength(2);
      const answered = resultFrames(arrivals).flatMap((f) => f.ids);
      expect(answered.sort()).toEqual([spawns[0]!.id, spawns[1]!.id].sort());
    }, 60_000);

    test("a subagent's round runs the same way, on the spawning call's thread, with ids distinct from its parent's", async () => {
      const home = tempDir("home");
      const childScript = [slow("x", 800, false), slow("y", 200)].join("\n");
      const { arrivals, events } = await runScript(spawnerFor(home), home, `CALL Agent ${JSON.stringify({ description: "two reads", prompt: childScript, subagent_type: "general-purpose", run_in_background: false })}`);
      const spawnId = callsOf(arrivals)[0]!.id;
      const childCalls = callsOf(arrivals, spawnId);
      expect(childCalls.map((c) => c.label)).toEqual(["x", "y"]);
      expect(childCalls.some((c) => c.id === spawnId)).toBe(false);
      const byId = new Map(childCalls.map((c) => [c.id, c.label]));
      const childFrames = resultFrames(arrivals, spawnId);
      expect(childFrames.map((f) => f.ids.map((id) => byId.get(id)))).toEqual([["y"], ["x"]]);
      // y's result reached the host before x had finished (one clock, one process) -- not a ms gap.
      expect(childFrames[0]!.at).toBeLessThan(events.find((e) => e.what === "end" && e.label === "x")!.at);
      expect(resultFrames(arrivals).map((f) => f.ids)).toEqual([[spawnId]]);
    }, 60_000);
  });
}
