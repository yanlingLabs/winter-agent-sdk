// Host input folded into the running turn, and `Query.clearQueuedInput()`, measured where a host
// measures them -- at `query()`'s yield -- on BOTH topologies: a spawned `winter` process (runtime
// main.ts under bun, the same engine the compiled binary runs) and an embedded Worker.
//
// The model is `winter-test/calls` (the reserved prompt-scripted double). The first prompt calls the
// test's in-process `hold` tool, which does not answer until the test releases it, so the turn is
// provably still running while the prompt iterable sends more input. Every release waits for the ack
// of a control request sent AFTER that input: the runtime reads its input in order, so the ack proves
// the input is already pending in the engine.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSpawn, query, type Options, type Query, type SDKHostInputFoldedMessage, type SpawnRuntimeOptions, type WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import { spawnEmbeddedWorker } from "./embedded-host.ts";
import { isSandboxAvailable } from "./sandbox/spawn.ts";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const WORKER_ENTRY = join(import.meta.dir, "embedded-worker.ts");
const TEMP: string[] = [];
afterAll(() => {
  for (const d of TEMP) rmSync(d, { recursive: true, force: true });
});
function tempDir(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `winter-fold-${label}-`));
  TEMP.push(d);
  return d;
}

type Spawner = NonNullable<Options["spawnClaudeCodeProcess"]>;
const TOPOLOGIES: Array<[string, (home: string) => Spawner]> = [
  ["a spawned winter process", (home) => (opts: SpawnRuntimeOptions) => defaultSpawn({ ...opts, command: process.execPath, args: [MAIN, ...opts.args], env: { ...opts.env, WINTER_HOME: home } })],
  ["an embedded Worker", () => (opts: SpawnRuntimeOptions) => spawnEmbeddedWorker({ workerEntry: WORKER_ENTRY, spawn: opts })],
];

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** `hold`: answers only once `release` resolves; `started` resolves when it is called. */
function holdServer() {
  const started = deferred();
  const release = deferred();
  const instance: WinterMcpServerInstance = {
    listTools: () => [{ name: "hold", inputSchema: { type: "object" } }],
    async callTool() {
      started.resolve();
      await release.promise;
      return { content: [{ type: "text", text: "held" }] };
    },
  };
  return { instance, started, release };
}

/**
 * One query: the prompt is "call hold", then -- once hold is running -- `followUps`, then `whileHeld`
 * (which may call a control on the query), then hold is released. The iterable ends once a result has
 * arrived and the session has had a moment to start anything else it was going to.
 */
async function run(spawner: Spawner, home: string, followUps: string[], whileHeld: (q: Query) => Promise<void>) {
  const server = holdServer();
  const firstResult = deferred();
  const messages: Array<Record<string, unknown>> = [];
  const foldCounts: number[] = [];
  let q!: Query;
  async function* prompt(): AsyncGenerator<string> {
    yield "CALL mcp__t__hold {}";
    await server.started.promise;
    for (const text of followUps) yield text;
    await whileHeld(q);
    server.release.resolve();
    await firstResult.promise;
    await new Promise((r) => setTimeout(r, 300));
  }
  q = query({
    prompt: prompt(),
    options: {
      model: "winter-test/calls",
      cwd: tempDir("cwd"),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", WINTER_HOME: home, WINTER_DISABLE_GIT_INSTRUCTIONS: "1" },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      ...(isSandboxAvailable() ? {} : { sandbox: { enabled: false } }),
      capabilities: ["winter.mcp"],
      mcpServers: { t: { type: "sdk", name: "t", instance: server.instance } } as NonNullable<Options["mcpServers"]>,
      spawnClaudeCodeProcess: spawner,
    },
  });
  for await (const message of q) {
    // A consumer narrows on the frame with no cast: `count` is a number here.
    if (message.type === "system" && message.subtype === "host_input_folded") {
      const folded: SDKHostInputFoldedMessage = message;
      foldCounts.push(folded.count);
    }
    const m = message as unknown as Record<string, unknown>;
    messages.push(m);
    if (m["type"] === "result") firstResult.resolve();
  }
  return { messages, foldCounts };
}

const folds = (messages: Array<Record<string, unknown>>): SDKHostInputFoldedMessage[] =>
  messages.filter((m) => m["type"] === "system" && m["subtype"] === "host_input_folded") as unknown as SDKHostInputFoldedMessage[];
const results = (messages: Array<Record<string, unknown>>) => messages.filter((m) => m["type"] === "result");

describe.each(TOPOLOGIES)("host input sent mid-turn, through %s", (_label, makeSpawner) => {
  test("is folded into the running turn: one host_input_folded {count: 2}, ONE result", async () => {
    const home = tempDir("home");
    const { messages, foldCounts } = await run(makeSpawner(home), home, ["first follow-up", "second follow-up"], async (q) => {
      await q.supportedModels(); // its ack proves both follow-ups are already pending
    });
    expect(foldCounts).toEqual([2]);
    const signals = folds(messages);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.count).toBe(2);
    expect(typeof signals[0]!.uuid).toBe("string");
    expect(results(messages)).toHaveLength(1);
    // Signalled before the turn's closing generation.
    const signalAt = messages.indexOf(signals[0] as unknown as Record<string, unknown>);
    const lastAssistant = messages.map((m) => m["type"]).lastIndexOf("assistant");
    expect(signalAt).toBeLessThan(lastAssistant);
  }, 30_000);

  test("clearQueuedInput() drops what is waiting, answers how many, and the dropped inputs never run", async () => {
    const home = tempDir("home");
    let cleared: { cleared: number } | undefined;
    const { messages, foldCounts } = await run(makeSpawner(home), home, ["dropped one", "dropped two"], async (q) => {
      cleared = await q.clearQueuedInput!();
    });
    expect(foldCounts).toEqual([]);
    expect(cleared).toEqual({ cleared: 2 });
    expect(folds(messages)).toHaveLength(0);
    expect(results(messages)).toHaveLength(1);
    expect(JSON.stringify(messages)).not.toContain("dropped one");
  }, 30_000);
});
