// SDK 0.0.40: a tool round's results reach the HOST one `user` frame per call, each as soon as its call
// finishes -- measured where a host measures it, at `query()`'s yield, on BOTH topologies: a spawned
// `winter` process (runtime main.ts under bun, the same engine the compiled binary runs) and an embedded
// Worker. The model's side is unchanged: it still gets the round's results together, in call order.
//
// The model is `winter-test/calls` (the production reserved-namespace double): `CALL` starts a round and
// `+CALL` joins it, so the two Bash calls below are ONE parallel batch -- a quick `echo`, then a call that
// sleeps. Calls of a round run one after another, so before 0.0.40 both results arrived together after the
// sleep; now the quick one arrives first, a whole sleep earlier.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSpawn, query, type Options, type SpawnRuntimeOptions } from "@yanlinglabs/winter-agent-sdk";
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

interface Arrival { at: number; message: Record<string, unknown> }

async function runScript(spawner: Spawner, home: string, script: string): Promise<Arrival[]> {
  const arrivals: Arrival[] = [];
  for await (const message of query({
    prompt: script,
    options: {
      model: "winter-test/calls",
      cwd: tempDir("cwd"),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", WINTER_HOME: home, WINTER_DISABLE_GIT_INSTRUCTIONS: "1" },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      ...(isSandboxAvailable() ? {} : { sandbox: { enabled: false } }),
      spawnClaudeCodeProcess: spawner,
    },
  })) {
    arrivals.push({ at: performance.now(), message: message as unknown as Record<string, unknown> });
  }
  return arrivals;
}

/** The `user` frames carrying tool results, each with its arrival time and the ids it carries. */
function resultFrames(arrivals: Arrival[], parent?: string): Array<{ at: number; ids: string[]; contents: string[] }> {
  return arrivals
    .filter(({ message }) => message["type"] === "user" && (parent === undefined ? message["parent_tool_use_id"] == null : message["parent_tool_use_id"] === parent))
    .map(({ at, message }) => {
      const blocks = ((message["message"] as { content?: Array<Record<string, unknown>> }).content ?? []).filter((b) => b["type"] === "tool_result");
      return { at, ids: blocks.map((b) => String(b["tool_use_id"])), contents: blocks.map((b) => JSON.stringify(b["content"])) };
    })
    .filter((f) => f.ids.length > 0);
}

const QUICK_THEN_SLOW = [`CALL Bash {"command":"echo quick-one"}`, `+CALL Bash {"command":"sleep ${SLEEP_SECONDS}; echo slow-one"}`].join("\n");

for (const [name, spawnerFor] of TOPOLOGIES) {
  describe(`results reach the host as each call finishes -- ${name}`, () => {
    test("two calls of one round: two frames, one result each, the quick one a whole sleep earlier; the model still gets both together", async () => {
      const home = tempDir("home");
      const arrivals = await runScript(spawnerFor(home), home, QUICK_THEN_SLOW);
      const frames = resultFrames(arrivals);
      expect(frames.map((f) => f.ids)).toEqual([["calls-1-1"], ["calls-1-1-2"]]);
      expect(frames[0]!.contents[0]).toContain("quick-one");
      expect(frames[1]!.contents[0]).toContain("slow-one");
      expect(frames[1]!.at - frames[0]!.at).toBeGreaterThan(SLEEP_SECONDS * 1000 * 0.7);
      // ONE round: the two calls came in one assistant message.
      const callTurns = arrivals.filter(({ message }) => message["type"] === "assistant" && JSON.stringify(message).includes("tool_use"));
      expect(callTurns).toHaveLength(1);
      // The model's answer is the JSON of every result it was handed -- both, in call order.
      const result = arrivals.find(({ message }) => message["type"] === "result")!.message;
      expect(result["subtype"]).toBe("success");
      const reported = JSON.parse(String(result["result"])) as Array<{ name: string; isError: boolean; content: string }>;
      expect(reported.map((r) => [r.name, r.isError])).toEqual([["Bash", false], ["Bash", false]]);
      expect(reported[0]!.content).toContain("quick-one");
      expect(reported[1]!.content).toContain("slow-one");
    }, 60_000);

    test("a subagent's round reaches the host the same way, on the spawning call's thread", async () => {
      const home = tempDir("home");
      const childScript = QUICK_THEN_SLOW;
      const script = `CALL Agent ${JSON.stringify({ description: "two calls", prompt: childScript, subagent_type: "general-purpose" })}`;
      const arrivals = await runScript(spawnerFor(home), home, script);
      const spawnId = "calls-1-1";
      const childFrames = resultFrames(arrivals, spawnId);
      expect(childFrames.map((f) => f.ids.length)).toEqual([1, 1]);
      expect(childFrames[0]!.contents[0]).toContain("quick-one");
      expect(childFrames[1]!.contents[0]).toContain("slow-one");
      expect(childFrames[1]!.at - childFrames[0]!.at).toBeGreaterThan(SLEEP_SECONDS * 1000 * 0.7);
      // The spawn's own result follows on the main thread, once.
      expect(resultFrames(arrivals).map((f) => f.ids)).toEqual([[spawnId]]);
    }, 60_000);
  });
}
