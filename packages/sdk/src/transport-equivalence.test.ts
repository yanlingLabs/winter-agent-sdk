// Task 4 (WS-04 §12): every scenario below runs over BOTH topology legs — the in-memory transport
// (winter-agent-runtime/testing's inMemoryProcess, WS-04 §1.1 virtual handle) and a REAL spawned
// `winter` child (packages/runtime/src/main.ts, WS-04 §1 path (a), run here under the DEV leg —
// `bun src/main.ts`, not the Task 5 compiled binary) — and asserts their normalized message
// sequences are IDENTICAL. A divergence between the two legs is a release blocker per spec, not a
// mere test failure.
//
// Two scenarios (multi-turn, interrupt) drive the raw SpawnedRuntimeProcess frame stream directly
// instead of going through query(): query.ts's iterate() stops at the FIRST terminal result
// (`if (message.type === "result") { ...; break readLoop; }`) and Query.interrupt() is still a
// documented stub (`proc.stdin.end()` — see query.ts's own comment on gen.interrupt), so neither a
// second turn nor a real WS-04 §5 interrupt control_request is reachable through the public
// wrapper today. Both are noted in this task's report as tracked-not-fixed gaps (out of this file
// list's scope — query.ts belongs to Task 2/3) rather than silently worked around.
import { describe, test, expect } from "bun:test";
import { fileURLToPath } from "node:url";
import { query } from "./query.ts";
import { defaultSpawn, type SpawnedRuntimeProcess, type SpawnRuntimeOptions, type SpawnClaudeCodeProcess } from "./transport.ts";
import { ResultError, ProcessError, AbortError, CLIConnectionError } from "./errors.ts";
import { encodeFrame, splitFrames } from "./protocol/codec.ts";
import type { WinterFrame, ControlResponseFrame } from "./protocol/frames.ts";
import type { RuntimeConfig } from "./protocol/config.ts";
import { inMemoryProcess } from "winter-agent-runtime/testing";
import { echoProvider, testProviderByName, type TestProviderName } from "winter-agent-runtime";
import { normalizeTrace, compareTraces, type ConformanceTraceEntry } from "winter-conformance/trace";

// --- fixtures / constants -----------------------------------------------------------------------

// A pinned model constant, and a REAL cwd. scripts/differential.ts's in-memory-only golden can pin
// a synthetic, nonexistent path ("/winter-fixture") because inMemoryProcess never touches the
// filesystem with it — but the CHILD leg here does a real node:child_process.spawn(cmd, args,
// {cwd}), which fails to spawn at all (an immediate "error" event, defaultSpawn's Task-2 Finding-1b
// handler, zero frames) if cwd doesn't exist on disk. Both legs just need to agree with EACH OTHER
// within a single test run — not with a byte-fixed golden across machines/time — so process.cwd()
// (always real) is the right fixture here, not a synthetic constant.
const FIXTURE_CWD = process.cwd();
const FIXTURE_MODEL = "sonnet";

// Absolute path to the real winter entrypoint. There is no package export for a non-data file like
// an entrypoint script (nor should there be one — this is test-only wiring, never a runtime
// import), so this resolves it the same way scripts/differential.ts resolves its sibling-package
// golden file: a relative URL from this file's own location.
const mainPath = fileURLToPath(new URL("../../runtime/src/main.ts", import.meta.url));

// WS-04 §5's interrupt is a protocol-level control_request the WRAPPER has no API to send yet
// (Query.interrupt() is a stub). Testing it at the transport boundary means synchronizing with "the
// engine has genuinely started the turn and is blocked inside provider.generate()" from OUTSIDE the
// process — and unlike a tool-level hang, a provider-level hang emits no observable frame first, so
// there is no wire event to wait on. A short real-clock wait is the only mechanism available across
// a real OS pipe boundary; precedented by this codebase's own timing-based synchronization
// (transport.test.ts's 30ms pre-abort delay, query.ts's own 50ms KILL_GRACE_MS) — 150ms is several
// orders of magnitude past the microtask-scheduling gap it covers. See the task report's Concerns.
const INTERRUPT_SETTLE_MS = 150;

type LegName = "inMemory" | "child";
const LEG_NAMES: LegName[] = ["inMemory", "child"];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- leg construction ----------------------------------------------------------------------------

// Builds the SpawnClaudeCodeProcess hook for one leg (WS-04 §1: both legs speak the identical frame
// contract through the same protocol code path — this is the one place that picks which transport
// backs a given scenario run). `testProviderName`, when given, selects a WINTER_TEST_PROVIDER
// scripted behavior — passed as a direct function call for the in-memory leg, as an env var merged
// into the child's environment for the real leg (provider/mock.ts's testProviderByName is the SAME
// function both call, so the two legs are byte-identical by construction). `capture` is populated
// SYNCHRONOUSLY — query() invokes the hook before returning its generator, and the two manually-
// driven scenarios below invoke it directly — so every caller may assume `capture.proc` is set
// before it starts reading.
function spawnHook(leg: LegName, testProviderName: TestProviderName | undefined, capture: { proc?: SpawnedRuntimeProcess }): SpawnClaudeCodeProcess {
  return (opts: SpawnRuntimeOptions): SpawnedRuntimeProcess => {
    const proc =
      leg === "inMemory"
        ? inMemoryProcess(opts.args, testProviderName ? testProviderByName(testProviderName) : echoProvider)
        : defaultSpawn({
            ...opts,
            command: process.execPath, // under bun, process.execPath IS bun, which runs .ts directly
            args: [mainPath, ...opts.args],
            env: testProviderName ? { ...opts.env, WINTER_TEST_PROVIDER: testProviderName } : opts.env,
          });
    capture.proc = proc;
    return proc;
  };
}

// --- trace helpers ---------------------------------------------------------------------------

function kindOfMessage(message: { type: string; subtype?: string }): string {
  return message.type === "system" ? `system/${message.subtype}` : message.type;
}

// Appends one runtime->host trace entry for a raw WinterFrame — "data" frames are unwrapped to
// their .message (matching what query() itself yields, so raw-driven and query()-driven scenarios
// produce directly comparable entry shapes); other frame kinds (init, control_response) are
// recorded whole. `sequence` is a placeholder — normalizeTrace renumbers from final array position.
function pushFrame(entries: ConformanceTraceEntry[], frame: WinterFrame): void {
  if (frame.type === "data") {
    const message = (frame as { message: { type: string; subtype?: string } }).message;
    entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOfMessage(message), payload: message });
  } else {
    entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: frame.type, payload: frame });
  }
}

// Folds "how did this leg's run end" into the SAME comparison mechanism compareTraces already
// provides (direction:"process" exists in the ConformanceTraceEntry taxonomy precisely for this,
// WS-04 §12) rather than a parallel, easy-to-forget assertion: a leg that threw a DIFFERENT error
// class, or exited with a different code/signal, while otherwise emitting identical data frames is
// every bit as real a transport divergence as a mismatched payload.
function describeThrown(err: unknown): Record<string, unknown> {
  if (err === undefined) return { thrownClass: null };
  const ctorName = err instanceof Error ? err.constructor.name : typeof err;
  const out: Record<string, unknown> = { thrownClass: ctorName, message: err instanceof Error ? err.message : String(err) };
  if (err instanceof ProcessError) {
    out.code = err.code ?? null;
    out.signal = err.signal ?? null;
  }
  return out;
}

function pushExit(entries: ConformanceTraceEntry[], payload: Record<string, unknown>): void {
  entries.push({ sequence: entries.length, direction: "process", kind: "exit", payload });
}

// --- scenario runner: through query() ---------------------------------------------------------

interface QueryScenarioOptions {
  prompt: string | AsyncIterable<string>;
  testProviderName?: TestProviderName;
  useAbortController?: boolean;
  // Invoked once per yielded message, AFTER it's recorded into the trace — the kill/abort
  // scenarios use this to act at a precise, OBSERVED point in the stream (WS-04 events), never a
  // real-clock guess (unlike the raw-driven interrupt scenario, which has no such observable event
  // to key off — see INTERRUPT_SETTLE_MS above).
  onMessage?: (msg: { type: string }, ctx: { proc: SpawnedRuntimeProcess | undefined; abort: () => void }) => void;
}

interface ScenarioResult {
  trace: ConformanceTraceEntry[]; // normalized; always ends with a direction:"process" exit entry
  thrown: unknown;
}

async function traceViaQuery(leg: LegName, scenario: QueryScenarioOptions): Promise<ScenarioResult> {
  const capture: { proc?: SpawnedRuntimeProcess } = {};
  const abortController = scenario.useAbortController ? new AbortController() : undefined;
  const entries: ConformanceTraceEntry[] = [];
  let thrown: unknown;
  try {
    const gen = query({
      prompt: scenario.prompt,
      options: {
        model: FIXTURE_MODEL,
        cwd: FIXTURE_CWD,
        spawnClaudeCodeProcess: spawnHook(leg, scenario.testProviderName, capture),
        ...(abortController ? { abortController } : {}),
      },
    });
    for await (const msg of gen) {
      entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOfMessage(msg), payload: msg });
      scenario.onMessage?.(msg, { proc: capture.proc, abort: () => abortController?.abort() });
    }
  } catch (e) {
    thrown = e;
  } finally {
    // Reap every child leg explicitly (never rely on query()'s own internal paths having already
    // awaited it — the sawTerminal/aborted paths return/throw without doing so) so bun test never
    // lingers on a straggling process.
    if (capture.proc) await capture.proc.exited;
  }
  pushExit(entries, describeThrown(thrown));
  return { trace: normalizeTrace(entries), thrown };
}

// --- scenario runner: raw frame driver (bypasses query() — see header note) ---------------------

function createDriver(proc: SpawnedRuntimeProcess) {
  const pending: WinterFrame[] = [];
  let carry = "";
  const it = proc.stdout[Symbol.asyncIterator]();
  async function nextFrame(): Promise<WinterFrame | null> {
    while (pending.length === 0) {
      const { value, done } = await it.next();
      if (done) return null;
      const split = splitFrames(value, carry);
      carry = split.carry;
      pending.push(...split.frames);
    }
    return pending.shift() ?? null;
  }
  return {
    send(frame: WinterFrame): void {
      proc.stdin.write(encodeFrame(frame));
    },
    nextFrame,
  };
}

function buildRawProc(leg: LegName, testProviderName: TestProviderName | undefined, sessionId: string): SpawnedRuntimeProcess {
  const capture: { proc?: SpawnedRuntimeProcess } = {};
  const hook = spawnHook(leg, testProviderName, capture);
  const config: RuntimeConfig = { sessionId, cwd: FIXTURE_CWD, model: FIXTURE_MODEL };
  return hook({
    command: "winter", // placeholder — ignored by both legs' hooks above (matches query.ts's own "winter" placeholder when a custom spawn hook is set)
    args: ["--run", "--config-json", JSON.stringify(config)],
    cwd: FIXTURE_CWD,
    env: process.env as Record<string, string>,
  });
}

async function traceMultiTurn(leg: LegName): Promise<ConformanceTraceEntry[]> {
  const proc = buildRawProc(leg, undefined, "multi-turn-fixture");
  const driver = createDriver(proc);
  const entries: ConformanceTraceEntry[] = [];

  const init = await driver.nextFrame();
  expect(init?.type).toBe("init");
  pushFrame(entries, init!);
  const sys = await driver.nextFrame();
  expect(sys?.type).toBe("data");
  pushFrame(entries, sys!);

  // Both envelopes written up front — mirrors engine.test.ts's own multi-turn precedent (the Queue
  // drains its backlog before honoring end, so both become turns regardless of read timing) and
  // WS-04 §2's "sequence of envelopes in streaming input mode."
  driver.send({ type: "user", text: "first" });
  driver.send({ type: "user", text: "second" });

  let resultsSeen = 0;
  while (resultsSeen < 2) {
    const frame = await driver.nextFrame();
    if (!frame) throw new Error(`${leg}: unexpected EOF while awaiting the second turn's frames`);
    pushFrame(entries, frame);
    if (frame.type === "data" && (frame as { message: { type: string } }).message.type === "result") resultsSeen++;
  }

  // end_input sent only AFTER both turns' results are observed (never up front alongside the user
  // frames): the pump acks end_input as soon as it dequeues that control frame, independent of turn
  // state, so sending it early would race its ack's wire position against turn 1's data frames —
  // an interleaving that can differ between legs on nothing more than chunk/hop count. Sequencing
  // it after both results pins its position structurally instead of by timing.
  driver.send({ type: "control_request", requestId: "end-input-1", subtype: "end_input", payload: undefined });
  const ack = await driver.nextFrame();
  expect(ack?.type).toBe("control_response");
  expect((ack as ControlResponseFrame).ok).toBe(true);
  pushFrame(entries, ack!);

  const eof = await driver.nextFrame();
  expect(eof).toBeNull();

  const exitInfo = await proc.exited;
  pushExit(entries, { code: exitInfo.code, signal: exitInfo.signal });
  return normalizeTrace(entries);
}

async function traceInterrupt(leg: LegName): Promise<ConformanceTraceEntry[]> {
  const proc = buildRawProc(leg, "hang", "interrupt-fixture");
  const driver = createDriver(proc);
  const entries: ConformanceTraceEntry[] = [];

  const init = await driver.nextFrame();
  pushFrame(entries, init!);
  const sys = await driver.nextFrame();
  pushFrame(entries, sys!);

  driver.send({ type: "user", text: "please hang" });
  await sleep(INTERRUPT_SETTLE_MS); // see INTERRUPT_SETTLE_MS's comment above
  driver.send({ type: "control_request", requestId: "interrupt-1", subtype: "interrupt", payload: { scope: "turn" } });

  const ack = await driver.nextFrame();
  expect(ack?.type).toBe("control_response");
  expect((ack as ControlResponseFrame).ok).toBe(true);
  pushFrame(entries, ack!);

  const result = await driver.nextFrame();
  expect(result?.type).toBe("data");
  const resultMessage = (result as { message: unknown }).message;
  // Direct sanity check on the provisional interrupted-result shape (engine.test.ts's own pin) —
  // a cross-leg trace diff alone can never catch a bug that affects BOTH legs identically.
  expect(resultMessage).toEqual({ type: "result", subtype: "success", is_error: false, interrupted: true });
  pushFrame(entries, result!);

  driver.send({ type: "control_request", requestId: "end-input-1", subtype: "end_input", payload: undefined });
  const endAck = await driver.nextFrame();
  expect((endAck as ControlResponseFrame).ok).toBe(true);
  pushFrame(entries, endAck!);

  const eof = await driver.nextFrame();
  expect(eof).toBeNull();

  const exitInfo = await proc.exited;
  pushExit(entries, { code: exitInfo.code, signal: exitInfo.signal });
  return normalizeTrace(entries);
}

// --- the equivalence suite -----------------------------------------------------------------------

describe("transport equivalence: inMemoryProcess vs the real winter child (main.ts, dev leg)", () => {
  test("plain query", async () => {
    const a = await traceViaQuery("inMemory", { prompt: "hi" });
    const b = await traceViaQuery("child", { prompt: "hi" });
    expect(compareTraces(a.trace, b.trace)).toEqual([]);
    expect(a.thrown).toBeUndefined();
    expect(a.trace.map((e) => e.kind)).toEqual(["system/init", "assistant", "result", "exit"]);
    const assistantMsg = a.trace[1]!.payload as { message: { content: unknown } };
    expect(assistantMsg.message.content).toEqual([{ type: "text", text: "echo: hi" }]);
  });

  test("multi-turn (streaming input, 2 envelopes)", async () => {
    const a = await traceMultiTurn("inMemory");
    const b = await traceMultiTurn("child");
    expect(compareTraces(a, b)).toEqual([]);
    expect(a.map((e) => e.kind)).toEqual(["init", "system/init", "assistant", "result", "assistant", "result", "control_response", "exit"]);
    const first = a[2]!.payload as { message: { content: unknown } };
    expect(first.message.content).toEqual([{ type: "text", text: "echo: first" }]);
    const second = a[4]!.payload as { message: { content: unknown } };
    expect(second.message.content).toEqual([{ type: "text", text: "echo: second" }]);
  });

  test("tool round", async () => {
    const a = await traceViaQuery("inMemory", { prompt: "go", testProviderName: "tooluse" });
    const b = await traceViaQuery("child", { prompt: "go", testProviderName: "tooluse" });
    expect(compareTraces(a.trace, b.trace)).toEqual([]);
    expect(a.trace.map((e) => e.kind)).toEqual(["system/init", "assistant", "user", "assistant", "result", "exit"]);
    const toolUseMsg = a.trace[1]!.payload as { message: { content: unknown } };
    expect(toolUseMsg.message.content).toEqual([{ type: "tool_use", id: "test-call-1", name: "test_tool", input: { probe: true } }]);
    const toolResultMsg = a.trace[2]!.payload as { message: { content: unknown } };
    expect(toolResultMsg.message.content).toEqual([{ type: "tool_result", tool_use_id: "test-call-1", content: 'test_tool:{"probe":true}' }]);
  });

  test("interrupt mid-turn", async () => {
    const a = await traceInterrupt("inMemory");
    const b = await traceInterrupt("child");
    expect(compareTraces(a, b)).toEqual([]);
    expect(a.map((e) => e.kind)).toEqual(["init", "system/init", "control_response", "result", "control_response", "exit"]);
  });

  test("error-result-then-throw (boom)", async () => {
    const a = await traceViaQuery("inMemory", { prompt: "hi", testProviderName: "boom" });
    const b = await traceViaQuery("child", { prompt: "hi", testProviderName: "boom" });
    expect(compareTraces(a.trace, b.trace)).toEqual([]);
    // A cross-leg diff alone can't catch a bug shared by both legs — assert the actual contract
    // directly too (report §9: the error result is yielded, THEN the iterator throws).
    expect(a.thrown).toBeInstanceOf(ResultError);
    expect(b.thrown).toBeInstanceOf(ResultError);
    expect(a.trace.map((e) => e.kind)).toEqual(["system/init", "result", "exit"]);
    const resultMsg = a.trace[1]!.payload as { is_error?: boolean; result?: string };
    expect(resultMsg.is_error).toBe(true);
    expect(resultMsg.result).toContain("boom");
  });

  test("EOF-without-result (kill mid-turn)", async () => {
    const killOnSystem = (msg: { type: string }, ctx: { proc: SpawnedRuntimeProcess | undefined }) => {
      if (msg.type === "system") ctx.proc?.kill();
    };
    const a = await traceViaQuery("inMemory", { prompt: "hi", testProviderName: "hang", onMessage: killOnSystem });
    const b = await traceViaQuery("child", { prompt: "hi", testProviderName: "hang", onMessage: killOnSystem });
    expect(compareTraces(a.trace, b.trace)).toEqual([]);
    // Both legs must surface the TYPED WS-04 §6.1 error, never a raw stream error (T2-deferred
    // finding, folded into this scenario per the task brief).
    expect(a.thrown).toBeInstanceOf(ProcessError);
    expect(b.thrown).toBeInstanceOf(ProcessError);
    expect(a.trace.map((e) => e.kind)).toEqual(["system/init", "exit"]);
  });

  test("abort mid-turn (AbortController -> AbortError after drain)", async () => {
    const abortOnSystem = (msg: { type: string }, ctx: { abort: () => void }) => {
      if (msg.type === "system") ctx.abort();
    };
    const a = await traceViaQuery("inMemory", { prompt: "hi", testProviderName: "hang", useAbortController: true, onMessage: abortOnSystem });
    const b = await traceViaQuery("child", { prompt: "hi", testProviderName: "hang", useAbortController: true, onMessage: abortOnSystem });
    expect(compareTraces(a.trace, b.trace)).toEqual([]);
    expect(a.thrown).toBeInstanceOf(AbortError);
    expect(b.thrown).toBeInstanceOf(AbortError);
    expect(a.trace.map((e) => e.kind)).toEqual(["system/init", "exit"]);
  });
});

// --- child-leg-only plumbing: stderr, and the T2 finding-7 observation --------------------------
//
// Neither of these is a cross-leg comparison: the in-memory leg has no real OS stderr (its
// SpawnedRuntimeProcess has no `stderr` field at all — WS-04 §1.1 virtual handle), and finding 7 is
// an OBSERVE-AND-REPORT item (task brief), not a behavior either leg is expected to differ on.

describe("child leg: stderr plumbing", () => {
  test("stderr routes to options.stderr; an unrecognized WINTER_TEST_PROVIDER fails before init (CLIConnectionError)", async () => {
    const stderrChunks: string[] = [];
    const capture: { proc?: SpawnedRuntimeProcess } = {};
    const hook: SpawnClaudeCodeProcess = (opts) => {
      const proc = defaultSpawn({
        ...opts,
        command: process.execPath,
        args: [mainPath, ...opts.args],
        env: { ...opts.env, WINTER_TEST_PROVIDER: "definitely-not-a-real-provider" },
      });
      capture.proc = proc;
      return proc;
    };
    let thrown: unknown;
    try {
      for await (const _msg of query({
        prompt: "hi",
        options: { cwd: FIXTURE_CWD, spawnClaudeCodeProcess: hook, stderr: (chunk) => stderrChunks.push(chunk) },
      })) {
        /* main.ts exits before writing a single frame — this body should never run */
      }
    } catch (e) {
      thrown = e;
    }
    if (capture.proc) await capture.proc.exited;

    // Stderr forwarding is a detached async task in query.ts, independent of the consumer's own
    // iteration — give it a brief settle window after the child has fully exited rather than
    // asserting the instant the loop above returns (flake risk flagged pre-implementation).
    const deadline = Date.now() + 1000;
    while (stderrChunks.join("").length === 0 && Date.now() < deadline) {
      await sleep(10);
    }

    expect(thrown).toBeInstanceOf(CLIConnectionError); // exited before init -> WS-04 §6.1
    expect(stderrChunks.join("")).toContain("WINTER_TEST_PROVIDER");
  });
});

describe("Finding 7 (T2, tracked — observe only, no fix): abort BEFORE query() runs still spawns eagerly", () => {
  for (const leg of LEG_NAMES) {
    test(`${leg} leg`, async () => {
      const controller = new AbortController();
      controller.abort(); // aborted BEFORE query() is ever called
      const capture: { proc?: SpawnedRuntimeProcess } = {};
      let invoked = false;
      const inner = spawnHook(leg, "hang", capture);
      const hook: SpawnClaudeCodeProcess = (opts) => {
        invoked = true;
        return inner(opts);
      };
      let thrown: unknown;
      try {
        for await (const _msg of query({ prompt: "hi", options: { cwd: FIXTURE_CWD, spawnClaudeCodeProcess: hook, abortController: controller } })) {
          /* observe only */
        }
      } catch (e) {
        thrown = e;
      }
      if (capture.proc) await capture.proc.exited;
      // OBSERVED, not fixed: query() spawns the process even though the AbortSignal was already
      // aborted before query() was ever called (see this task's report for the full note).
      expect(invoked).toBe(true);
      expect(thrown).toBeInstanceOf(AbortError);
    });
  }
});
