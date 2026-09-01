import { test, expect } from "bun:test";
import { query } from "./query.ts";
import { resolveRuntimeExecutable, defaultSpawn, type SpawnedRuntimeProcess } from "./transport.ts";
import { WinterSDKError, CLIConnectionError, ProcessError, ProtocolDecodeError, AbortError } from "./errors.ts";
import { encodeFrame } from "./protocol/codec.ts";
import { PROTOCOL_VERSION } from "./protocol/frames.ts";
import { inMemoryProcess } from "winter-agent-runtime/testing";
import type { ProviderTurn } from "winter-agent-runtime";

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

test("maxBufferSize: a complete frame followed by an oversized unterminated tail in ONE chunk still delivers the complete frame first (review Finding 2)", async () => {
  const hugeTail = "x".repeat(500); // no trailing \n: stays in carry, never becomes a frame
  const chunk = initFrame() + systemFrame() + hugeTail;
  const proc = makeFakeProcess({ stdout: chunksIterable([chunk]) });
  const seen: string[] = [];
  let thrown: unknown;
  try {
    for await (const msg of query({ prompt: "hi", options: { maxBufferSize: 100, spawnClaudeCodeProcess: () => proc } })) {
      seen.push(msg.type);
    }
  } catch (e) {
    thrown = e;
  }
  expect(seen).toEqual(["system"]);
  expect(thrown).toBeInstanceOf(ProtocolDecodeError);
});

// --- abort / kill escalation -----------------------------------------------------------------

test("abort signal drains buffered frames then the iterator ends with the pinned cancellation error", async () => {
  const controller = new AbortController();
  // Task 3: Provider moved from prompt-based to messages-based (ProviderTurn return) — shape
  // update only; this provider's job is just to hang forever, unchanged.
  const hangingProvider = { async generate(): Promise<ProviderTurn> { return new Promise(() => {}); } };
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
  // "Ignores the first signal" means it doesn't die on SIGTERM — it MUST still die (stream closes)
  // once truly killed (SIGKILL), matching WS-04 §6's "kill/abort ... same observable sequence (exit
  // event, then stream termination)" for any compliant transport. A double whose stdout never
  // completes even after a successful kill would not represent any real transport (review Finding
  // 5) — releaseHang is what "SIGKILL actually lands" looks like here.
  let releaseHang: (() => void) | undefined;
  const hang = new Promise<void>((res) => {
    releaseHang = res;
  });
  const proc: SpawnedRuntimeProcess = {
    stdin: { write() {}, end() {} },
    stdout: (async function* () {
      yield initFrame();
      yield systemFrame();
      await hang;
    })(),
    kill(signal?: string) {
      killSignals.push(signal);
      if (killSignals.length === 2) {
        settleExited({ code: null, signal: signal ?? null });
        releaseHang?.();
      }
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

test("abort with a real backlog: 2+ pre-queued frames are all yielded before the cancellation error (review Finding 5)", async () => {
  const dataFrame1 = encodeFrame({
    type: "data",
    message: { type: "assistant", message: { content: [{ type: "text", text: "one" }] } },
  });
  const dataFrame2 = encodeFrame({
    type: "data",
    message: { type: "assistant", message: { content: [{ type: "text", text: "two" }] } },
  });
  // All frames (including the required init) are ALREADY in the pipe — a real backlog, not one
  // frame trickled in per read — before the consumer ever asks for anything. Aborting before
  // iteration even starts is the maximal-pressure version of the race Finding 5 identified: an
  // already-settled `exited` must never win over frames that are already available to drain.
  const proc = makeFakeProcess({
    stdout: chunksIterable([initFrame(), systemFrame(), dataFrame1, dataFrame2]),
    exited: Promise.resolve({ code: null, signal: "SIGTERM" }),
  });
  const controller = new AbortController();
  controller.abort();
  const seen: string[] = [];
  let thrown: unknown;
  try {
    for await (const msg of query({ prompt: "hi", options: { spawnClaudeCodeProcess: () => proc, abortController: controller } })) {
      seen.push(msg.type);
    }
  } catch (e) {
    thrown = e;
  }
  expect(seen).toEqual(["system", "assistant", "assistant"]);
  expect(thrown).toBeInstanceOf(AbortError);
});

test("a terminal success completes cleanly even when abort fires in the same tick as the result (review Finding 6)", async () => {
  const successResult = encodeFrame({ type: "data", message: { type: "result", subtype: "success", is_error: false, result: "ok" } });
  const controller = new AbortController();
  const proc = makeFakeProcess({
    stdout: chunksIterable([initFrame(), systemFrame(), successResult]),
    exited: Promise.resolve({ code: 0, signal: null }),
  });
  const seen: string[] = [];
  let thrown: unknown;
  try {
    for await (const msg of query({ prompt: "hi", options: { spawnClaudeCodeProcess: () => proc, abortController: controller } })) {
      seen.push(msg.type);
      if (msg.type === "result") controller.abort(); // fires while the terminal result is still being processed
    }
  } catch (e) {
    thrown = e;
  }
  expect(seen).toEqual(["system", "result"]);
  expect(thrown).toBeUndefined();
});

// --- Options.env resolution (controller Ruling P1-D) --------------------------------------------

test("Options.env omitted: the spawn hook receives the wrapper's own process.env (inherit, Ruling P1-D)", async () => {
  let capturedEnv: Record<string, string> | undefined;
  const proc = makeFakeProcess({ stdout: chunksIterable([initFrame(), systemFrame()]) });
  let thrown: unknown;
  try {
    for await (const _msg of query({
      prompt: "hi",
      options: {
        spawnClaudeCodeProcess: (opts) => {
          capturedEnv = opts.env;
          return proc;
        },
      },
    })) {
      /* EOF-without-result is expected here; only the captured env matters for this test */
    }
  } catch (e) {
    thrown = e;
  }
  expect(capturedEnv).toBeDefined();
  expect(capturedEnv!.PATH).toBe(process.env.PATH);
  expect(capturedEnv!.HOME).toBe(process.env.HOME);
  expect(thrown).toBeInstanceOf(ProcessError);
});

test("Options.env supplied: the spawn hook receives EXACTLY that env — no PATH leak (replace, unchanged)", async () => {
  let capturedEnv: Record<string, string> | undefined;
  const proc = makeFakeProcess({ stdout: chunksIterable([initFrame(), systemFrame()]) });
  let thrown: unknown;
  try {
    for await (const _msg of query({
      prompt: "hi",
      options: {
        env: { FOO: "1" },
        spawnClaudeCodeProcess: (opts) => {
          capturedEnv = opts.env;
          return proc;
        },
      },
    })) {
      /* EOF-without-result is expected here; only the captured env matters for this test */
    }
  } catch (e) {
    thrown = e;
  }
  expect(capturedEnv).toEqual({ FOO: "1" });
  expect(thrown).toBeInstanceOf(ProcessError);
});

// --- defaultSpawn: child-process "error" event must never crash the host (review Finding 1) ----

test("defaultSpawn: aborting a live real child surfaces AbortError, not an uncaught exception", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  let thrown: unknown;
  try {
    for await (const _msg of query({
      prompt: "hi",
      options: {
        // A real, harmless sleeping child (never speaks the winter protocol) — the point is to
        // prove the abort path around a REAL defaultSpawn-backed process survives end to end with
        // no uncaught "error" event crashing the test runner, not protocol semantics.
        spawnClaudeCodeProcess: (opts) =>
          defaultSpawn({ ...opts, command: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"] }),
        abortController: controller,
      },
    })) {
      /* the sleeping child never writes a frame */
    }
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(AbortError);
});

test("defaultSpawn: a spawn failure (bad executable) surfaces as a typed lifecycle error, not a crash", async () => {
  let thrown: unknown;
  try {
    for await (const _msg of query({
      prompt: "hi",
      options: { pathToClaudeCodeExecutable: "/definitely/does/not/exist/winter-xyz-not-real" },
    })) {
      /* never reached */
    }
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(CLIConnectionError);
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
