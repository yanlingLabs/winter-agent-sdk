import { test, expect } from "bun:test";
import { query, type QueryInternal } from "./query.ts";
import { ResultError, WinterRpcError } from "./errors.ts";
import { inMemoryProcess } from "winter-agent-runtime/testing";
import { echoProvider } from "winter-agent-runtime";
import type { Provider, ProviderTurn } from "winter-agent-runtime";
import type { SpawnedRuntimeProcess, SpawnRuntimeOptions } from "./transport.ts";
import { encodeFrame } from "./protocol/codec.ts";
import { PROTOCOL_VERSION } from "./protocol/frames.ts";
import type { WinterFrame, ControlResponseFrame } from "./protocol/frames.ts";

test("query yields system/init, assistant, result in order", async () => {
  const seen: string[] = [];
  for await (const msg of query({
    prompt: "ping",
    options: { model: "sonnet", spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args) },
  })) {
    seen.push(msg.type);
  }
  expect(seen).toEqual(["system", "assistant", "result"]);
});

test("error-result-then-throw: the terminal error result is yielded, THEN the iterator throws ResultError", async () => {
  // Task 3: Provider moved from prompt-based to messages-based (ProviderTurn return) — shape
  // update only; the throwing behavior under test is unchanged.
  const boom = { async generate(): Promise<ProviderTurn> { throw new Error("down"); } };
  const yielded: string[] = [];
  let thrown: unknown;
  try {
    for await (const msg of query({
      prompt: "ping",
      options: { spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, boom) },
    })) {
      yielded.push(msg.type);
      if (msg.type === "result") { /* observe the error result before the throw */ expect((msg as { is_error?: boolean }).is_error).toBe(true); }
    }
  } catch (e) { thrown = e; }
  expect(yielded).toContain("result");        // result WAS yielded first (report §9)
  expect(thrown).toBeInstanceOf(ResultError); // …then the iterator threw
});

// --- Task 3: wrapper-side streaming input (replaces the P0 firstOf stub) -----------------------
//
// A hand-scripted SpawnedRuntimeProcess double (Task 2 precedent, transport.test.ts) that RECORDS
// every stdin write instead of simulating a real runtime. Its own "result" frame is gated on
// having already received `expectedWrites` stdin writes — not a fixed delay — so the test can
// safely drain `query()` to completion and then assert on `writes`, deterministically: by
// construction, the wrapper cannot have seen a terminal result before it finished sending
// everything under test, regardless of microtask interleaving between the send-loop and the
// read-loop (which Task 3 deliberately runs concurrently — see query.ts).
function recordingProcess(expectedWrites: number): { proc: SpawnedRuntimeProcess; writes: string[] } {
  const writes: string[] = [];
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => { resolveReady = r; });
  const proc: SpawnedRuntimeProcess = {
    stdin: {
      write(chunk: string) {
        writes.push(chunk);
        if (writes.length >= expectedWrites) resolveReady();
      },
      end() {},
    },
    stdout: (async function* () {
      yield encodeFrame({ type: "init", protocolVersion: PROTOCOL_VERSION, sessionId: "s", cwd: "/x", model: "sonnet", permissionMode: "default", tools: [] });
      await ready;
      yield encodeFrame({ type: "data", message: { type: "result", subtype: "success", is_error: false, result: "ok" } });
    })(),
    kill() {},
    exited: Promise.resolve({ code: 0, signal: null }),
    pid: null,
  };
  return { proc, writes };
}

function decodeWrites(writes: string[]): WinterFrame[] {
  return writes.join("").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as WinterFrame);
}

test("string prompt: the wrapper sends one user frame then end_input", async () => {
  const { proc, writes } = recordingProcess(2);
  for await (const _msg of query({ prompt: "hello", options: { spawnClaudeCodeProcess: () => proc } })) { /* drain */ }
  const sent = decodeWrites(writes);
  expect(sent.map((f) => f.type)).toEqual(["user", "control_request"]);
  expect((sent[0] as { text: string }).text).toBe("hello");
  expect((sent[1] as { subtype: string }).subtype).toBe("end_input");
});

test("AsyncIterable prompt: the wrapper sends each item as a user frame in arrival order, then end_input", async () => {
  const { proc, writes } = recordingProcess(4);
  async function* prompts() {
    yield "a"; yield "b"; yield "c";
  }
  for await (const _msg of query({ prompt: prompts(), options: { spawnClaudeCodeProcess: () => proc } })) { /* drain */ }
  const sent = decodeWrites(writes);
  expect(sent.map((f) => f.type)).toEqual(["user", "user", "user", "control_request"]);
  expect(sent.slice(0, 3).map((f) => (f as { text: string }).text)).toEqual(["a", "b", "c"]);
  expect((sent[3] as { subtype: string }).subtype).toBe("end_input");
});

// --- Task 9 (WS-05 §7): Options.{continue,resume,forkSession,resumeSessionAt,resumeDropsTurn,
// persistSession,sessionId} serialize into --config-json ------------------------------------------

function captureConfigJson(): { hook: (opts: SpawnRuntimeOptions) => SpawnedRuntimeProcess; get: () => Record<string, unknown> } {
  let captured: Record<string, unknown> | undefined;
  return {
    hook(opts: SpawnRuntimeOptions) {
      const idx = opts.args.indexOf("--config-json");
      captured = JSON.parse(opts.args[idx + 1] as string) as Record<string, unknown>;
      return inMemoryProcess(opts.args);
    },
    get() {
      if (captured === undefined) throw new Error("captureConfigJson: spawnClaudeCodeProcess was never invoked");
      return captured;
    },
  };
}

test("Task 9 + fix-wave Minor 3: every resume/continue/fork field, AND the pre-T9 maxTurns/model/permissionMode/cwd fields, are present in --config-json when set on Options", async () => {
  const capture = captureConfigJson();
  for await (const _msg of query({
    prompt: "ping",
    options: {
      sessionId: "11111111-1111-4111-8111-111111111111",
      model: "opus",
      permissionMode: "acceptEdits",
      cwd: "/winter-fixture-config-round-trip",
      maxTurns: 7,
      continue: true,
      resume: "22222222-2222-4222-8222-222222222222",
      forkSession: true,
      resumeSessionAt: "33333333-3333-4333-8333-333333333333",
      resumeDropsTurn: true,
      persistSession: false,
      spawnClaudeCodeProcess: capture.hook,
    },
  })) {
    /* drain */
  }

  expect(capture.get()).toMatchObject({
    sessionId: "11111111-1111-4111-8111-111111111111",
    model: "opus",
    permissionMode: "acceptEdits",
    cwd: "/winter-fixture-config-round-trip",
    maxTurns: 7,
    continue: true,
    resume: "22222222-2222-4222-8222-222222222222",
    forkSession: true,
    resumeSessionAt: "33333333-3333-4333-8333-333333333333",
    resumeDropsTurn: true,
    persistSession: false,
  });
});

test("Task 9 + fix-wave Minor 3: unset resume/continue/fork/maxTurns fields are OMITTED entirely, but model/permissionMode/cwd NEVER are — they always carry a (possibly defaulted) value", async () => {
  const capture = captureConfigJson();
  for await (const _msg of query({ prompt: "ping", options: { spawnClaudeCodeProcess: capture.hook } })) {
    /* drain */
  }
  const config = capture.get();
  for (const key of ["continue", "resume", "forkSession", "resumeSessionAt", "resumeDropsTurn", "persistSession", "maxTurns"]) {
    expect(config).not.toHaveProperty(key);
  }
  expect(typeof config.sessionId).toBe("string"); // still auto-generated when Options.sessionId is unset
  // Unlike the genuinely-optional fields above, these three are NEVER omitted — query.ts computes
  // a default for each when Options doesn't set them, so --config-json always carries a value.
  expect(config.model).toBe("sonnet");
  expect(config.permissionMode).toBe("default");
  expect(config.cwd).toBe(process.cwd()); // query() runs in THIS same test process — an exact, non-flaky comparison
});

// --- Task 5 (WS-07 §3.3 / phase ruling 1): Options.{allowedTools,disallowedTools,permissions,
// settingSources} serialize into --config-json exactly like every prior field above (T9's own
// precedent, same captureConfigJson helper) --------------------------------------------------

test("Task 5: allowedTools/disallowedTools/permissions/settingSources are present in --config-json when set on Options", async () => {
  const capture = captureConfigJson();
  for await (const _msg of query({
    prompt: "ping",
    options: {
      allowedTools: ["Read", "Bash(ls *)"],
      disallowedTools: ["Bash(rm *)"],
      permissions: { allow: ["WebFetch(domain:example.com)"], ask: ["Bash(git push*)"], deny: ["Bash(curl *)"] },
      settingSources: ["user", "local"],
      spawnClaudeCodeProcess: capture.hook,
    },
  })) {
    /* drain */
  }

  expect(capture.get()).toMatchObject({
    allowedTools: ["Read", "Bash(ls *)"],
    disallowedTools: ["Bash(rm *)"],
    permissions: { allow: ["WebFetch(domain:example.com)"], ask: ["Bash(git push*)"], deny: ["Bash(curl *)"] },
    settingSources: ["user", "local"],
  });
});

test("Task 5: unset allowedTools/disallowedTools/permissions/settingSources are OMITTED entirely from --config-json", async () => {
  const capture = captureConfigJson();
  for await (const _msg of query({ prompt: "ping", options: { spawnClaudeCodeProcess: capture.hook } })) {
    /* drain */
  }
  const config = capture.get();
  for (const key of ["allowedTools", "disallowedTools", "permissions", "settingSources"]) {
    expect(config).not.toHaveProperty(key);
  }
});

test("Task 9: a pre-allocated Options.sessionId round-trips into the init frame's sessionId", async () => {
  const explicitId = "44444444-4444-4444-8444-444444444444";
  let sawInitSessionId: string | undefined;
  for await (const msg of query({
    prompt: "ping",
    options: { sessionId: explicitId, persistSession: false, spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args) },
  })) {
    if (msg.type === "system" && msg.subtype === "init") sawInitSessionId = (msg as { session_id: string }).session_id;
  }
  expect(sawInitSessionId).toBe(explicitId);
});

// --- Task 2 (WS-04 §3.1, direction inversion): the wrapper's read loop now dispatches
// runtime-originated control_request frames to a handler registry (keyed by subtype), auto-
// answering an unregistered subtype so an old host never parks the runtime forever. Scripted
// double, in-memory only (Query.__internal is a Winter-only extension beyond the WS-03 §4 pinned
// surface — never something a real spawned child depends on for these two tests).

// A scripted double whose stdout emits ONE runtime-originated control_request (after the string
// prompt's user/end_input writes land on stdin, mirroring recordingProcess's own gating idiom
// above) and gates its terminal "result" frame on having OBSERVED the matching control_response
// arrive back on stdin — so asserting "the response landed runtime-side" is deterministic, never a
// timing guess.
function recordingProcessWithControlRequest(subtype: string, requestId: string): { proc: SpawnedRuntimeProcess; writes: string[] } {
  const writes: string[] = [];
  let resolveGotResponse!: () => void;
  const gotResponse = new Promise<void>((r) => {
    resolveGotResponse = r;
  });
  const proc: SpawnedRuntimeProcess = {
    stdin: {
      write(chunk: string) {
        writes.push(chunk);
        for (const line of chunk.split("\n").filter((l) => l.length > 0)) {
          const frame = JSON.parse(line) as { type: string; requestId?: string };
          if (frame.type === "control_response" && frame.requestId === requestId) resolveGotResponse();
        }
      },
      end() {},
    },
    stdout: (async function* () {
      yield encodeFrame({ type: "init", protocolVersion: PROTOCOL_VERSION, sessionId: "s", cwd: "/x", model: "sonnet", permissionMode: "default", tools: [] });
      yield encodeFrame({ type: "control_request", requestId, subtype, payload: { probe: true } });
      await gotResponse;
      yield encodeFrame({ type: "data", message: { type: "result", subtype: "success", is_error: false, result: "ok" } });
    })(),
    kill() {},
    exited: Promise.resolve({ code: 0, signal: null }),
    pid: null,
  };
  return { proc, writes };
}

function decodeControlResponse(writes: string[], requestId: string): ControlResponseFrame | undefined {
  const sent = writes
    .join("")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as WinterFrame);
  return sent.find((f) => f.type === "control_response" && (f as ControlResponseFrame).requestId === requestId) as ControlResponseFrame | undefined;
}

test("runtime-originated control_request reaches a registered handler; the response lands runtime-side", async () => {
  const requestId = "probe-1";
  const { proc, writes } = recordingProcessWithControlRequest("test_subtype", requestId);
  const gen = query({ prompt: "hi", options: { spawnClaudeCodeProcess: () => proc } });

  const internal = (gen as unknown as { __internal?: QueryInternal }).__internal;
  expect(internal).toBeDefined();
  let receivedPayload: unknown;
  internal!.registerControlRequestHandler("test_subtype", async (payload) => {
    receivedPayload = payload;
    return { ok: true, payload: { answer: 42 } };
  });

  for await (const _msg of gen) {
    /* drain */
  }

  expect(receivedPayload).toEqual({ probe: true });
  const response = decodeControlResponse(writes, requestId);
  expect(response).toBeDefined();
  expect(response!.ok).toBe(true);
  expect(response!.payload).toEqual({ answer: 42 });
});

test("an unregistered control subtype from the runtime is auto-answered ok:false, unhandled_subtype", async () => {
  const requestId = "probe-2";
  const { proc, writes } = recordingProcessWithControlRequest("nobody_handles_this", requestId);
  const gen = query({ prompt: "hi", options: { spawnClaudeCodeProcess: () => proc } });

  for await (const _msg of gen) {
    /* drain — no handler registered */
  }

  const response = decodeControlResponse(writes, requestId);
  expect(response).toBeDefined();
  expect(response!.ok).toBe(false);
  expect(response!.error?.code).toBe("unhandled_subtype");
});

// --- Task 2: real setPermissionMode()/interrupt() — replacing the P0/P1 stubs. Both send a real
// control_request and resolve/reject on the runtime's ack, correlated by requestId
// (pendingHostRequests in query.ts). Driven against the REAL engine (inMemoryProcess), never a
// scripted double, since what's under test is the engine's own set_permission_mode/interrupt
// handling reached THROUGH the wrapper — string prompts close stdin immediately (before any
// message is even yielded), so both tests use streaming input, gated open until after the control
// call's effect is observed, exactly like engine.test.ts's own interrupt precedent.

test("setPermissionMode(): sends a real control request mid-iteration; an invalid mode rejects with a typed error, a valid mode resolves", async () => {
  let releasePrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  async function* prompt() {
    yield "hi";
    await promptGate; // keep the stream open (WS-04 §3: streaming input) until the turn completes
  }

  const gen = query({ prompt: prompt(), options: { spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, echoProvider) } });

  let validPromise: Promise<void> | undefined;
  let invalidPromise: Promise<void> | undefined;
  for await (const msg of gen) {
    // Fired, NOT awaited, here: the ack is processed by THIS SAME read loop, so awaiting inline
    // would suspend the very loop that has to keep running to deliver it — a deadlock. Both
    // promises are awaited after the loop ends instead (already settled by then).
    if (msg.type === "system" && validPromise === undefined) {
      validPromise = gen.setPermissionMode("plan");
      invalidPromise = gen.setPermissionMode("not_a_real_mode");
    }
    if (msg.type === "result") releasePrompt();
  }

  await validPromise; // throws (failing the test) if the ack path is broken
  let invalidError: unknown;
  try {
    await invalidPromise;
  } catch (e) {
    invalidError = e;
  }
  expect(invalidError).toBeInstanceOf(WinterRpcError);
  expect((invalidError as WinterRpcError).code).toBe("invalid_mode");
});

test("interrupt(): sends a real control request and resolves on ack; drain semantics stay byte-identical to the raw-frame scenario", async () => {
  let enteredGenerate!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredGenerate = resolve;
  });
  const blockingProvider: Provider = {
    generate() {
      enteredGenerate();
      return new Promise(() => {}); // never resolves; the engine must abandon it on interrupt
    },
  };
  let releasePrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  async function* prompt() {
    yield "hang";
    await promptGate;
  }

  const gen = query({ prompt: prompt(), options: { spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, blockingProvider) } });

  let interruptPromise: Promise<void> | undefined;
  void (async () => {
    await entered; // deterministic: only interrupt once the engine is genuinely blocked inside generate()
    interruptPromise = gen.interrupt();
  })();

  const seen: string[] = [];
  for await (const msg of gen) {
    seen.push(msg.type);
    if (msg.type === "result") {
      expect((msg as { interrupted?: boolean }).interrupted).toBe(true);
      releasePrompt();
    }
  }

  expect(seen).toEqual(["system", "result"]);
  await interruptPromise; // already resolved during the loop above; surfaces any rejection here
});
