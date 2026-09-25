// WS-23: the embedded topology -- `runEmbeddedSession` (one session, no process globals) and
// `spawnEmbeddedWorker` (that session in its own Bun Worker, as a `SpawnedRuntimeProcess`).
//
// Every model here is a `winter-test/<double>` resolved through the PRODUCTION reserved-namespace
// door (never testing.ts's in-process provider), every home is a temp dir, and nothing reaches a
// network or a Keychain.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, splitFrames, type Options, type SdkMessage, type SpawnedRuntimeProcess, type SpawnRuntimeOptions, type WinterFrame, type WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import { Queue } from "./protocol/channel.ts";
import { runEmbeddedSession } from "./embedded.ts";
import { EMBEDDED_KILL_GRACE_MS, spawnEmbeddedWorker } from "./embedded-host.ts";
import { MCP_SDK_TEST_SERVER_NAME, MCP_SDK_TEST_TOOL_NAME } from "./provider/mock.ts";
import { startTracking, resetBackgroundTaskRuntimeForTest } from "./tools/impl/background-task-runtime.ts";
import { resolveWorkerCommand, setHostWorkflowWorkerCommand } from "./workflows/sandbox.ts";
import { EMBEDDED_ABORT_END_INPUT_REQUEST_ID, EMBEDDED_ABORT_INTERRUPT_REQUEST_ID } from "./embedded-protocol.ts";

const WORKER_ENTRY = join(import.meta.dir, "embedded-worker.ts");
const THROWING_WORKER_ENTRY = join(import.meta.dir, "embedded-throw.fixture.ts");
const TEMP_ROOTS: string[] = [];
afterAll(() => {
  for (const dir of TEMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `winter-embedded-${label}-`));
  TEMP_ROOTS.push(dir);
  return dir;
}

/** A session environment that can reach nothing real: its own WINTER_HOME, no git snapshot. */
function sessionEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    WINTER_HOME: tempDir("home"),
    WINTER_DISABLE_GIT_INSTRUCTIONS: "1",
    ...extra,
  };
}

function configArgv(config: Record<string, unknown>): string[] {
  return ["--run", "--config-json", JSON.stringify(config)];
}

/** Decode a stdout transcript back into frames (the one shared codec). */
function framesOf(chunks: readonly string[]): WinterFrame[] {
  const split = splitFrames(chunks.join(""), "");
  return split.frames;
}

/**
 * `runEmbeddedSession` as an IN-PROCESS `SpawnedRuntimeProcess`, for the query()-level test below.
 * Test-only: production embeds through a Worker (one realm per session), which the Worker tests use.
 */
function inProcessEmbedded(opts: SpawnRuntimeOptions): SpawnedRuntimeProcess & { stderrText: () => string } {
  const stdin = new Queue<string>();
  const stdout = new Queue<string>();
  const stderr: string[] = [];
  const abort = new AbortController();
  const exited = runEmbeddedSession({
    argv: opts.args,
    env: opts.env,
    input: stdin,
    write: (chunk) => stdout.write(chunk),
    writeErr: (chunk) => stderr.push(chunk),
    signal: abort.signal,
  }).then((code) => {
    stdout.end();
    return { code, signal: null };
  });
  return {
    stdin: { write: (c) => stdin.write(c), end: () => stdin.end() },
    stdout,
    kill: () => abort.abort(),
    exited,
    pid: null,
    stderrText: () => stderr.join(""),
  };
}

async function drain(gen: AsyncIterable<SdkMessage>): Promise<SdkMessage[]> {
  const out: SdkMessage[] = [];
  for await (const m of gen) out.push(m);
  return out;
}

function resultOf(messages: readonly SdkMessage[]): Record<string, unknown> | undefined {
  return messages.find((m) => (m as { type?: string }).type === "result") as Record<string, unknown> | undefined;
}

describe("runEmbeddedSession", () => {
  test("runs a scripted provider turn end to end, through query() and the production provider door", async () => {
    const cwd = tempDir("cwd");
    let proc: ReturnType<typeof inProcessEmbedded> | undefined;
    const messages = await drain(
      query({
        prompt: "go",
        options: {
          model: "winter-test/tooluse",
          cwd,
          env: sessionEnv(),
          spawnClaudeCodeProcess: (o) => (proc = inProcessEmbedded(o)),
        },
      }),
    );
    const init = messages.find((m) => (m as { subtype?: string }).subtype === "init") as { model?: string } | undefined;
    expect(init).toBeDefined();
    // The tool round ran on the registry (stubExecutor's echo for the non-WS-06 `test_tool`), then text.
    const toolResult = messages.find((m) => (m as { type?: string }).type === "user") as { message: { content: Array<{ type: string; content?: unknown }> } } | undefined;
    expect(toolResult?.message.content[0]?.type).toBe("tool_result");
    const result = resultOf(messages);
    expect(result?.subtype).toBe("success");
    expect(result?.result).toBe("tool round done");
    expect(await proc!.exited).toEqual({ code: 0, signal: null });
    expect(proc!.stderrText()).not.toContain("fatal");
  });

  test("an argv with no config exits 1 with the fatal line on stderr and nothing on stdout", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const input = new Queue<string>();
    input.end();
    const code = await runEmbeddedSession({ argv: ["--run"], env: sessionEnv(), input, write: (c) => out.push(c), writeErr: (c) => err.push(c) });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("")).toContain("winter: fatal: Error: winter: expected '--run --config-json <json>' (missing --config-json <json>)");
  });

  test("abort kills this realm's background process groups AT ONCE, before the session even resolves (main.ts's SIGTERM parity)", async () => {
    resetBackgroundTaskRuntimeForTest();
    // A real detached process group, registered the way Bash's run_in_background registers one.
    const child = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    child.unref();
    const exitedChild = new Promise<string | null>((resolve) => child.on("exit", (_code, signal) => resolve(signal)));
    startTracking({ taskId: "embedded-abort-probe", kind: "bash", outputPath: join(tempDir("task"), "out"), description: "sleep", pid: child.pid! });
    const abort = new AbortController();
    const input = new Queue<string>();
    // A config the session will resolve normally: the abort lands while it is still starting up.
    const session = runEmbeddedSession({
      argv: configArgv({ sessionId: crypto.randomUUID(), cwd: tempDir("cwd"), model: "winter-test/echo" }),
      env: sessionEnv(),
      input,
      write: () => {},
      writeErr: () => {},
      signal: abort.signal,
    });
    abort.abort();
    // SIGKILL to the whole group, synchronously in the abort listener -- well before the session ends.
    expect(await Promise.race([exitedChild, Bun.sleep(3000).then(() => "still-running")])).toBe("SIGKILL");
    expect(typeof (await session)).toBe("number");
    resetBackgroundTaskRuntimeForTest();
  });

  test("abort ends a HANGING turn, and the session resolves only after runEngine returned (its interrupted result and its teardown both precede resolution)", async () => {
    const out: string[] = [];
    const input = new Queue<string>();
    const abort = new AbortController();
    const sessionId = crypto.randomUUID();
    // Session-state events on: the teardown's own `idle` is written AFTER the turn loop drains, which
    // makes "the engine unwound" observable from outside.
    const session = runEmbeddedSession({
      argv: configArgv({ sessionId, cwd: tempDir("cwd"), model: "winter-test/hang" }),
      env: sessionEnv({ WINTER_EMIT_SESSION_STATE_EVENTS: "1" }),
      input,
      write: (c) => out.push(c),
      writeErr: () => {},
      signal: abort.signal,
    });
    input.write(JSON.stringify({ type: "user", text: "hello" }) + "\n");
    // Wait until the turn is genuinely in flight (the hang provider never answers).
    const deadline = Date.now() + 10_000;
    const running = (): boolean => framesOf(out).some((f) => JSON.stringify(f).includes('"state":"running"'));
    while (!running() && Date.now() < deadline) await Bun.sleep(20);
    expect(running()).toBe(true);
    let resolved = false;
    void session.then(() => {
      resolved = true;
    });
    abort.abort();
    const code = await Promise.race([session, Bun.sleep(10_000).then(() => "timeout" as const)]);
    expect(code).toBe(0);
    expect(resolved).toBe(true);
    const frames = framesOf(out).map((f) => (f as { type: string; message?: Record<string, unknown> }));
    const data = frames.filter((f) => f.type === "data").map((f) => f.message!);
    const result = data.find((m) => m["type"] === "result");
    expect(result?.["interrupted"]).toBe(true);
    // The LAST session-state report is the teardown's `idle`, written after the interrupted turn.
    const states = data.filter((m) => m["subtype"] === "session_state_changed").map((m) => m["state"]);
    expect(states.at(-1)).toBe("idle");
    // The two synthetic control requests are acknowledged by the engine but never reach the host.
    const acks = frames.filter((f) => f.type === "control_response").map((f) => (f as { requestId?: string }).requestId);
    expect(acks).not.toContain(EMBEDDED_ABORT_END_INPUT_REQUEST_ID);
    expect(acks).not.toContain(EMBEDDED_ABORT_INTERRUPT_REQUEST_ID);
  });
});

describe("spawnEmbeddedWorker (one Worker per session)", () => {
  /** An SDK MCP server that answers with its OWN label and records every call it receives. */
  function labelledServer(label: string, gate: { arrived: Set<string>; bothArrived: Promise<void>; arrive: () => void }): { instance: WinterMcpServerInstance; calls: Array<Record<string, unknown>> } {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      instance: {
        listTools: () => [{ name: "echo", inputSchema: { type: "object" } }],
        async callTool(_name: string, args: Record<string, unknown>) {
          calls.push(args);
          gate.arrived.add(label);
          gate.arrive();
          // Held until BOTH sessions are inside a tool call at once: the two Workers are live
          // concurrently, not one after the other.
          await Promise.race([gate.bothArrived, Bun.sleep(15_000)]);
          return { content: [{ type: "text", text: `answered-by-${label}` }] };
        },
      },
    };
  }

  test("two concurrent sessions in two Workers: each MCP call reaches its own session's server", async () => {
    const arrived = new Set<string>();
    let release!: () => void;
    const bothArrived = new Promise<void>((resolve) => (release = resolve));
    const gate = { arrived, bothArrived, arrive: () => arrived.size >= 2 && release() };
    const serverA = labelledServer("A", gate);
    const serverB = labelledServer("B", gate);
    const procs: SpawnedRuntimeProcess[] = [];
    const run = (server: typeof serverA): Promise<SdkMessage[]> =>
      drain(
        query({
          prompt: "go",
          options: {
            model: "winter-test/mcpsdk",
            cwd: tempDir("cwd"),
            env: sessionEnv(),
            allowedTools: [MCP_SDK_TEST_TOOL_NAME],
            capabilities: ["winter.mcp"],
            mcpServers: { [MCP_SDK_TEST_SERVER_NAME]: { type: "sdk", name: MCP_SDK_TEST_SERVER_NAME, instance: server.instance } } as NonNullable<Options["mcpServers"]>,
            spawnClaudeCodeProcess: (o) => {
              const p = spawnEmbeddedWorker({ workerEntry: WORKER_ENTRY, spawn: o });
              procs.push(p);
              return p;
            },
          },
        }),
      );
    const [a, b] = await Promise.all([run(serverA), run(serverB)]);
    expect(serverA.calls).toEqual([{ x: 1 }]);
    expect(serverB.calls).toEqual([{ x: 1 }]);
    const toolResultText = (messages: SdkMessage[]): unknown =>
      (messages.find((m) => (m as { type?: string }).type === "user") as { message: { content: Array<{ content?: unknown }> } } | undefined)?.message.content[0]?.content;
    expect(toolResultText(a)).toBe("answered-by-A");
    expect(toolResultText(b)).toBe("answered-by-B");
    expect(resultOf(a)?.result).toBe("mcp sdk done");
    expect(resultOf(b)?.result).toBe("mcp sdk done");
    for (const p of procs) expect(await p.exited).toEqual({ code: 0, signal: null });
    expect(procs.every((p) => p.pid === null)).toBe(true);
  }, 60_000);

  test("Bash runs from inside a Worker: the session's shell child (sandboxed where the host has sandbox-exec) spawns and answers", async () => {
    // Dispatch keeps Bash, and embedded, its shell child is spawned by a Worker thread of the host
    // process, on the Worker's own process.env -- measured here rather than assumed.
    const messages = await drain(
      query({
        prompt: "go",
        options: {
          model: "winter-test/lanec",
          cwd: tempDir("cwd"),
          env: sessionEnv(),
          spawnClaudeCodeProcess: (o) => spawnEmbeddedWorker({ workerEntry: WORKER_ENTRY, spawn: o }),
        },
      }),
    );
    const toolResult = messages.find((m) => (m as { type?: string }).type === "user") as { message: { content: Array<{ type: string; content?: unknown; is_error?: boolean }> } } | undefined;
    expect(toolResult?.message.content[0]?.is_error ?? false).toBe(false);
    expect(JSON.stringify(toolResult?.message.content[0]?.content)).toContain("winter-t8-lanec");
    expect(resultOf(messages)?.result).toBe("lane c done");
  }, 30_000);

  test("kill() aborts the session: exited settles only once the Worker closed, after its engine wrote its interrupted result and its teardown", async () => {
    const sessionId = crypto.randomUUID();
    const proc = spawnEmbeddedWorker({
      workerEntry: WORKER_ENTRY,
      spawn: {
        command: "winter",
        args: configArgv({ sessionId, cwd: tempDir("cwd"), model: "winter-test/hang" }),
        cwd: tempDir("cwd"),
        env: sessionEnv({ WINTER_EMIT_SESSION_STATE_EVENTS: "1" }),
      },
    });
    const out: string[] = [];
    const reading = (async () => {
      for await (const chunk of proc.stdout) out.push(chunk);
    })();
    proc.stdin.write(JSON.stringify({ type: "user", text: "hello" }) + "\n");
    const deadline = Date.now() + 15_000;
    const running = (): boolean => out.join("").includes('"state":"running"');
    while (!running() && Date.now() < deadline) await Bun.sleep(20);
    expect(running()).toBe(true);
    const t0 = Date.now();
    proc.kill();
    proc.kill("SIGKILL"); // the wrapper's own escalation -- must not cut the graceful end short
    const exit = await proc.exited;
    // A GRACEFUL end (the exit message's code), well inside the terminate() backstop.
    expect(exit).toEqual({ code: 0, signal: null });
    expect(Date.now() - t0).toBeLessThan(EMBEDDED_KILL_GRACE_MS);
    expect(proc.state).toBe("closed");
    await reading;
    const text = out.join("");
    expect(text).toContain('"interrupted":true');
    const states = [...text.matchAll(/"session_state_changed","state":"(\w+)"/g)].map((m) => m[1]);
    expect(states.at(-1)).toBe("idle");
  }, 30_000);

  test("a Worker whose entry THROWS surfaces as an error exit with the reason on stderr, and the host survives", async () => {
    const proc = spawnEmbeddedWorker({
      workerEntry: THROWING_WORKER_ENTRY,
      spawn: { command: "winter", args: configArgv({ sessionId: crypto.randomUUID(), cwd: "/" }), cwd: "/", env: sessionEnv() },
    });
    const errText: string[] = [];
    const readErr = (async () => {
      for await (const chunk of proc.stderr!) errText.push(chunk);
    })();
    const stdoutChunks: string[] = [];
    for await (const chunk of proc.stdout) stdoutChunks.push(chunk);
    expect(await proc.exited).toEqual({ code: 1, signal: null });
    await readErr;
    expect(stdoutChunks).toEqual([]);
    expect(errText.join("")).toContain("embedded runtime worker failed");
    expect(errText.join("")).toContain("fixture: the embedded worker threw");
    // The host (this test process) is alive and can start the next session.
    expect(process.pid).toBeGreaterThan(0);
  }, 30_000);

  test("an entry that does not resolve is an error exit too -- never a hang", async () => {
    const proc = spawnEmbeddedWorker({
      workerEntry: join(import.meta.dir, "no-such-embedded-worker.ts"),
      spawn: { command: "winter", args: configArgv({ sessionId: crypto.randomUUID(), cwd: "/" }), cwd: "/", env: sessionEnv() },
    });
    for await (const _ of proc.stdout) {
      /* drain */
    }
    expect(await proc.exited).toEqual({ code: 1, signal: null });
  }, 30_000);

  test("a session that cannot start reports exit 1 through the Worker's own exit message, not a crash", async () => {
    const proc = spawnEmbeddedWorker({
      workerEntry: WORKER_ENTRY,
      spawn: { command: "winter", args: ["--run"], cwd: "/", env: sessionEnv() },
    });
    const err: string[] = [];
    const readErr = (async () => {
      for await (const chunk of proc.stderr!) err.push(chunk);
    })();
    for await (const _ of proc.stdout) {
      /* drain */
    }
    expect(await proc.exited).toEqual({ code: 1, signal: null });
    await readErr;
    expect(err.join("")).toContain("winter: fatal:");
    expect(err.join("")).not.toContain("embedded runtime worker failed");
  }, 30_000);

  test("terminate() is the hard backstop: a Worker that never answers is reported as killed", async () => {
    const proc = spawnEmbeddedWorker({
      workerEntry: THROWING_WORKER_ENTRY,
      spawn: { command: "winter", args: ["--spin"], cwd: "/", env: sessionEnv() },
      killGraceMs: 100,
    });
    await Bun.sleep(200); // the fixture spins synchronously on a `--spin` start
    proc.kill();
    expect(await proc.exited).toEqual({ code: null, signal: "SIGKILL" });
  }, 30_000);
});

describe("the host's workflow worker command (workflows/sandbox.ts)", () => {
  test("runEmbeddedSession installs the host's command for the length of its run, then restores the default", async () => {
    const derived = resolveWorkerCommand();
    const host = { file: "/opt/host/winter-core", args: ["__runtime-workflow-worker", "--bridge"] };
    const input = new Queue<string>();
    const abort = new AbortController();
    const out: string[] = [];
    const sessionId = crypto.randomUUID();
    const session = runEmbeddedSession({
      argv: configArgv({ sessionId, cwd: tempDir("cwd"), model: "winter-test/hang" }),
      env: sessionEnv({ WINTER_EMIT_SESSION_STATE_EVENTS: "1" }),
      input,
      write: (c) => out.push(c),
      writeErr: () => {},
      signal: abort.signal,
      workflowWorkerCommand: host,
    });
    input.write(JSON.stringify({ type: "user", text: "hi" }) + "\n");
    const deadline = Date.now() + 10_000;
    while (!out.join("").includes('"state":"running"') && Date.now() < deadline) await Bun.sleep(20);
    // Mid-run, in this realm: what a Workflow launch would spawn.
    expect(resolveWorkerCommand()).toEqual(host);
    abort.abort();
    await session;
    expect(resolveWorkerCommand()).toEqual(derived);
  });


  test("installed for a realm, it replaces the derived default; restoring brings the default back", () => {
    const derived = resolveWorkerCommand();
    const restore = setHostWorkflowWorkerCommand({ file: "/opt/host/winter-core", args: ["__runtime-workflow-worker", "--bridge"] });
    try {
      expect(resolveWorkerCommand()).toEqual({ file: "/opt/host/winter-core", args: ["__runtime-workflow-worker", "--bridge"] });
      // A caller stating its own derivation inputs still gets the derivation (the unit tests of it).
      expect(resolveWorkerCommand({ compiled: true, execPath: "/x/winter" })).toEqual({ file: "/x/winter", args: ["__workflow-worker", "--bridge"] });
    } finally {
      restore();
    }
    expect(resolveWorkerCommand()).toEqual(derived);
  });

  test("the command is copied on install, so a caller mutating its object later changes nothing", () => {
    const command = { file: "/opt/host/a", args: ["--bridge"] };
    const restore = setHostWorkflowWorkerCommand(command);
    try {
      command.args.push("--evil");
      command.file = "/tmp/b";
      expect(resolveWorkerCommand()).toEqual({ file: "/opt/host/a", args: ["--bridge"] });
    } finally {
      restore();
    }
  });
});
