import { test, expect } from "bun:test";
import { query } from "./query.ts";
import { resolveRuntimeExecutable, defaultSpawn, type SpawnedRuntimeProcess } from "./transport.ts";
import { WinterSDKError, CLIConnectionError, ProcessError, ProtocolDecodeError, AbortError } from "./errors.ts";
import { encodeFrame } from "./protocol/codec.ts";
import { PROTOCOL_VERSION } from "./protocol/frames.ts";
import { inMemoryProcess } from "winter-agent-runtime/testing";

// --- test doubles -----------------------------------------------------------------------------
// Hand-scripted SpawnedRuntimeProcess doubles: emit exact byte chunks (encoded frames) so
// EOF-without-result, data-before-init, version-mismatch, oversized-line, and exit-before-init
// are testable WITHOUT runtime cooperation (controller ruling). The happy-path + abort-drain
// tests use the real inMemoryProcess.

function chunksIterable(chunks: string[]): AsyncIterable<string> {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

function makeFakeProcess(opts: {
  stdout: AsyncIterable<string>;
  exited?: Promise<{ code: number | null; signal: string | null }>;
  kill?: (signal?: string) => void;
}): SpawnedRuntimeProcess {
  return {
    stdin: { write() {}, end() {} },
    stdout: opts.stdout,
    kill: opts.kill ?? (() => {}),
    exited: opts.exited ?? Promise.resolve({ code: 0, signal: null }),
    pid: 4242,
  };
}

const initFrame = (protocolVersion: string = PROTOCOL_VERSION) =>
  encodeFrame({
    type: "init",
    protocolVersion: protocolVersion as `${number}.${number}`,
    sessionId: "s",
    cwd: "/x",
    model: "sonnet",
    permissionMode: "default",
    tools: [],
  });

const systemFrame = () =>
  encodeFrame({
    type: "data",
    message: { type: "system", subtype: "init", session_id: "s", cwd: "/x", model: "sonnet", permissionMode: "default", tools: [] },
  });

// --- resolution order ---------------------------------------------------------------------------

test("resolution order: explicit path wins; nothing configured throws the typed executable-not-found error", () => {
  expect(resolveRuntimeExecutable({ pathToClaudeCodeExecutable: "/custom/winter" })).toBe("/custom/winter");
  expect(() => resolveRuntimeExecutable({})).toThrow(WinterSDKError);
});

// --- lifecycle mapping (WS-04 §6.1) ---------------------------------------------------------------

test("EOF after init without a terminal result → ProcessError, after delivering complete frames", async () => {
  const proc = makeFakeProcess({
    stdout: chunksIterable([initFrame(), systemFrame()]),
    exited: Promise.resolve({ code: null, signal: null }),
  });
  const seen: string[] = [];
  let thrown: unknown;
  try {
    for await (const msg of query({ prompt: "hi", options: { spawnClaudeCodeProcess: () => proc } })) {
      seen.push(msg.type);
    }
  } catch (e) {
    thrown = e;
  }
  expect(seen).toEqual(["system"]);
  expect(thrown).toBeInstanceOf(ProcessError);
});

test("data frame arriving before init → ProtocolDecodeError (init-first enforcement)", async () => {
  const badFirst = encodeFrame({ type: "data", message: { type: "assistant", message: { content: [] } } });
  const proc = makeFakeProcess({ stdout: chunksIterable([badFirst]) });
  let thrown: unknown;
  try {
    for await (const _msg of query({ prompt: "hi", options: { spawnClaudeCodeProcess: () => proc } })) {
      /* should never yield */
    }
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(ProtocolDecodeError);
});

test("init protocolVersion with a different MAJOR → CLIConnectionError naming both versions", async () => {
  const proc = makeFakeProcess({ stdout: chunksIterable([initFrame("2.0")]) });
  let thrown: unknown;
  try {
    for await (const _msg of query({ prompt: "hi", options: { spawnClaudeCodeProcess: () => proc } })) {
      /* never reached */
    }
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(CLIConnectionError);
  expect((thrown as Error).message).toContain("2.0");
  expect((thrown as Error).message).toContain(PROTOCOL_VERSION);
});

test("exit before init → CLIConnectionError", async () => {
  const proc = makeFakeProcess({ stdout: chunksIterable([]), exited: Promise.resolve({ code: 1, signal: null }) });
  let thrown: unknown;
  try {
    for await (const _msg of query({ prompt: "hi", options: { spawnClaudeCodeProcess: () => proc } })) {
      /* never reached */
    }
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(CLIConnectionError);
});

test("oversized single line beyond maxBufferSize → ProtocolDecodeError, not a hang", async () => {
  const hugeNoNewline = "x".repeat(500); // no trailing \n: never resolves to a frame on its own
  const proc = makeFakeProcess({ stdout: chunksIterable([hugeNoNewline]) });
  let thrown: unknown;
  try {
    for await (const _msg of query({ prompt: "hi", options: { maxBufferSize: 100, spawnClaudeCodeProcess: () => proc } })) {
      /* never reached */
    }
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(ProtocolDecodeError);
});

// --- abort / kill escalation -----------------------------------------------------------------

test("abort signal drains buffered frames then the iterator ends with the pinned cancellation error", async () => {
  const controller = new AbortController();
  const hangingProvider = { async generate(): Promise<{ text: string }> { return new Promise(() => {}); } };
  const seen: string[] = [];
  let thrown: unknown;
  try {
    for await (const msg of query({
      prompt: "hi",
      options: {
        spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, hangingProvider),
        abortController: controller,
      },
    })) {
      seen.push(msg.type);
      if (msg.type === "system") controller.abort();
    }
  } catch (e) {
    thrown = e;
  }
  expect(seen).toEqual(["system"]);
  expect(thrown).toBeInstanceOf(AbortError);
});

test("abort signal escalates SIGTERM then SIGKILL when the process does not comply", async () => {
  const killSignals: Array<string | undefined> = [];
  let settleExited!: (v: { code: number | null; signal: string | null }) => void;
  const exited = new Promise<{ code: number | null; signal: string | null }>((res) => {
    settleExited = res;
  });
  const proc: SpawnedRuntimeProcess = {
    stdin: { write() {}, end() {} },
    stdout: (async function* () {
      yield initFrame();
      yield systemFrame();
      await new Promise(() => {}); // simulate a runtime that ignores the first signal
    })(),
    kill(signal?: string) {
      killSignals.push(signal);
      if (killSignals.length === 2) settleExited({ code: null, signal: signal ?? null });
    },
    exited,
    pid: 999,
  };
  const controller = new AbortController();
  const seen: string[] = [];
  let thrown: unknown;
  try {
    for await (const msg of query({ prompt: "hi", options: { spawnClaudeCodeProcess: () => proc, abortController: controller } })) {
      seen.push(msg.type);
      if (msg.type === "system") controller.abort();
    }
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(AbortError);
  expect(killSignals.length).toBe(2);
  expect(killSignals[1]).toBe("SIGKILL");
});

// --- defaultSpawn (real child; exercised as a unit here, wired end-to-end in Task 4) -----------

test("defaultSpawn spawns a real child and reads its stdout to completion", async () => {
  const proc = defaultSpawn({
    command: process.execPath,
    args: ["-e", "process.stdout.write('hi')"],
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  });
  let out = "";
  for await (const chunk of proc.stdout) out += chunk;
  const info = await proc.exited;
  expect(out).toBe("hi");
  expect(info.code).toBe(0);
});
