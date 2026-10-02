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
        `CALL Agent ${JSON.stringify({ description: "one", prompt: childOne, subagent_type: "general-purpose" })}`,
        `+CALL Agent ${JSON.stringify({ description: "two", prompt: childTwo, subagent_type: "general-purpose" })}`,
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

    test("a subagent's round runs the same way, on the spawning call's thread, with ids distinct from its parent's", async () => {
      const home = tempDir("home");
      const childScript = [slow("x", 800, false), slow("y", 200)].join("\n");
      const { arrivals, events } = await runScript(spawnerFor(home), home, `CALL Agent ${JSON.stringify({ description: "two reads", prompt: childScript, subagent_type: "general-purpose" })}`);
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
