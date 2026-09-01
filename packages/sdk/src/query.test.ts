import { test, expect } from "bun:test";
import { query } from "./query.ts";
import { ResultError } from "./errors.ts";
import { inMemoryProcess } from "winter-agent-runtime/testing";
import type { ProviderTurn } from "winter-agent-runtime";
import type { SpawnedRuntimeProcess } from "./transport.ts";
import { encodeFrame } from "./protocol/codec.ts";
import { PROTOCOL_VERSION } from "./protocol/frames.ts";
import type { WinterFrame } from "./protocol/frames.ts";

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
