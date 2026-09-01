import { test, expect } from "bun:test";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

// Whether "nothing configured" throws depends on whether the darwin-arm64 platform package is
// resolvable at all in THIS environment — pnpm's os/cpu gating on its `optionalDependencies` entry
// means that varies by platform (installed on a matching darwin/arm64 machine, absent everywhere
// else, e.g. CI's ubuntu runner). Probed directly rather than assumed from `process.platform`, so
// this stays correct regardless of exactly which platforms a given pnpm version chooses to link an
// os-gated optional dependency on.
const PLATFORM_PACKAGE_RESOLVABLE = (() => {
  try {
    createRequire(import.meta.url).resolve("@yanlinglabs/winter-agent-sdk-darwin-arm64/package.json");
    return true;
  } catch {
    return false;
  }
})();

test("resolution order: explicit path wins", () => {
  expect(resolveRuntimeExecutable({ pathToClaudeCodeExecutable: "/custom/winter" })).toBe("/custom/winter");
});

// Task 5 gave the darwin-arm64 platform package a real "bin" field (packages/platform/darwin-arm64/
// package.json) — so "nothing configured" only throws where the platform package isn't resolvable
// at all; where it IS resolvable, resolution now succeeds instead (see the darwin-only test below).
test.skipIf(PLATFORM_PACKAGE_RESOLVABLE)(
  "resolution order: nothing configured throws the typed executable-not-found error (platform package not installed here)",
  () => {
    expect(() => resolveRuntimeExecutable({})).toThrow(WinterSDKError);
  },
);

// Task 5, darwin-only (brief-pinned: test.skipIf(process.platform !== "darwin")): stages a
// placeholder file at the darwin-arm64 platform package's declared "bin" path and proves
// resolveRuntimeExecutable finds it via the platform package with NO explicit option — the middle
// rung of the explicit-option -> platform-package -> typed-error order. A placeholder (not a real
// compiled binary) is sufficient: resolveRuntimeExecutable only ever joins a path read from
// package.json's "bin" field — it never touches the filesystem to check the target exists or runs
// — so a real `bun build --compile` is deliberately NOT exercised in this fast unit test; that
// end-to-end proof is verify:compiled's job (the transport-equivalence suite's compiled leg), not
// this one's. Backs up/restores any file that already exists at that path rather than deleting it
// outright, so a developer's own local `bun run build:runtime -- --platform-package` output
// survives running this test.
test.skipIf(process.platform !== "darwin")(
  "resolution order (darwin): platform package's staged bin resolves with no explicit option",
  () => {
    const binPath = fileURLToPath(new URL("../../platform/darwin-arm64/bin/winter", import.meta.url));
    const binDir = dirname(binPath);
    const dirPreexisted = existsSync(binDir);
    const previousContent = existsSync(binPath) ? readFileSync(binPath) : undefined;
    mkdirSync(binDir, { recursive: true });
    writeFileSync(binPath, "placeholder binary staged by transport.test.ts (Task 5)\n");
    try {
      expect(resolveRuntimeExecutable({})).toBe(binPath);
    } finally {
      if (previousContent !== undefined) {
        writeFileSync(binPath, previousContent);
      } else {
        rmSync(binPath, { force: true });
        if (!dirPreexisted) rmSync(binDir, { recursive: true, force: true });
      }
    }
  },
);

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
  // Assert definedness before comparing (Task 5 rider): process.env.PATH/HOME are `string |
  // undefined` — asserting each is actually set FIRST makes a genuine "PATH is unset in this
  // environment" failure fail loudly and specifically here, rather than risk two `undefined`s
  // quietly comparing equal and passing without ever proving inheritance carried a real value.
  expect(process.env.PATH).toBeDefined();
  expect(process.env.HOME).toBeDefined();
  expect(capturedEnv!.PATH).toBe(process.env.PATH!);
  expect(capturedEnv!.HOME).toBe(process.env.HOME!);
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

// CI fix round (ubuntu run 33523165941, verify:compiled): "Finding 7 abort BEFORE query() runs
// still spawns eagerly > child leg" crashed with an unlistened EPIPE on `child.stdin` — a real
// child_process ChildProcess exposes stdin/stdout/stderr as SEPARATE EventEmitters from `child`
// itself, so the Finding-1b listener on `child`'s own "error" (above) does not cover any of them.
// Root cause: killing a still-booting `bun main.ts` dev child (transpiling, has not yet opened its
// stdin for reading) right before writing+ending its stdin (query.ts's prompt-send IIFE, always
// concurrent with the read loop) races a write against an already-broken pipe; the resulting EPIPE
// on the writable's flush/destroy had no listener, and Node's one EventEmitter special case (an
// unlistened "error" event throws) crashed the host. The compiled leg passed in the same CI run
// (the compiled binary boots ~instantly and drains stdin before the kill lands) — this is a LINUX
// pipe-timing race, confirmed NOT reproducible on macOS (see the task report's RED-honesty section:
// neither the natural abort-before-query() race nor this test's DETERMINISTIC construction below
// crashes locally, across dozens of runs, pre- or post-fix — the CI log is the only cross-platform
// RED evidence available).
//
// This test constructs the dead-pipe state DIRECTLY instead of racing for it — the real bug is a
// timing race by definition, so racing for it locally would be exactly as flaky/silent here as it
// was on macOS in CI. `await proc.exited` first guarantees the child's read end is unambiguously
// gone before stdin is ever touched, which is a STRONGER condition than the CI race (there, the
// child merely hadn't finished booting) — if writing into a definitely-dead pipe is safe, the
// narrower "still booting" case is too.
test("defaultSpawn: writing to stdin after the child has already exited never crashes the host (unlistened EPIPE)", async () => {
  let uncaught: unknown;
  let unhandledRejectionErr: unknown;
  const onUncaught = (err: unknown) => {
    uncaught = err;
  };
  const onUnhandledRejection = (err: unknown) => {
    unhandledRejectionErr = err;
  };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    const proc = defaultSpawn({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    });
    const info = await proc.exited;
    expect(info.code).toBe(0);
    // The pipe's read side is DEFINITELY gone by now (the child has fully exited and been reaped)
    // — write() then end() against it is the exact dead-pipe operation that raised EPIPE in CI.
    proc.stdin.write("x\n");
    proc.stdin.end();
    // Settle a few ticks so any async "error" emission (EPIPE surfaces on the writable's own
    // flush/destroy, not synchronously from write()/end() themselves) has a real chance to fire.
    // CI-fix fix-wave note: the handlers above are defense-in-depth for a plain-Node embedding of
    // this transport, not the mechanism that actually makes this test a tripwire under bun's own
    // test runner — bun 1.3.14 attributes an async uncaught exception to whichever test is
    // currently in flight and fails IT directly, before these process-level handlers ever get a
    // chance to fire (empirically confirmed: re-review's scratch probes under this repo's pinned
    // bun 1.3.14). Either way the tripwire property holds — a regression here fails this test, one
    // way (bun's own crash attribution) or the other (these handlers, under plain Node) — so the
    // wait and the assertions below stay unchanged; only this comment's causal claim is corrected.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUnhandledRejection);
  }
  expect(uncaught).toBeUndefined();
  expect(unhandledRejectionErr).toBeUndefined();
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
