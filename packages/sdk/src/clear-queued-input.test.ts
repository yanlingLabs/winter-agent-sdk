// `Query.clearQueuedInput()` through the WRAPPER against the real engine over the in-memory process
// (`compact-control.test.ts`'s pattern), plus the one thing only the wrapper decides: against a runtime
// OLDER than the control, the call rejects cleanly with a `WinterRpcError` -- a host must catch it.
import { expect, test } from "bun:test";
import { query } from "./query.ts";
import { WinterRpcError } from "./errors.ts";
import type { SpawnedRuntimeProcess } from "./transport.ts";
import { inMemoryProcess } from "@yanlinglabs/winter-agent-runtime/testing";
import type { Provider } from "@yanlinglabs/winter-agent-runtime";

const provider: Provider = {
  async generate() {
    return { kind: "text", text: "ok" };
  },
};

/** A runtime that predates `clear_queued_input`: the request reaches it under a name it does not know. */
function olderRuntime(args: string[]): SpawnedRuntimeProcess {
  const proc = inMemoryProcess(args, provider);
  return {
    ...proc,
    stdin: {
      write: (chunk: string) => proc.stdin.write(chunk.replace('"subtype":"clear_queued_input"', '"subtype":"clear_queued_input_from_the_future"')),
      end: () => proc.stdin.end(),
    },
    stdout: proc.stdout,
    kill: (signal?: string) => proc.kill(signal),
    get exited() {
      return proc.exited;
    },
    get pid() {
      return proc.pid;
    },
  };
}

async function callAfterFirstResult(spawn: (args: string[]) => SpawnedRuntimeProcess): Promise<{ answer?: { cleared: number }; failure?: unknown; results: number }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  async function* prompt() {
    yield "only one";
    await gate;
  }
  const gen = query({ prompt: prompt(), options: { model: "winter-test/echo", spawnClaudeCodeProcess: (opts) => spawn(opts.args) } });
  let pending: Promise<{ cleared: number }> | undefined;
  let results = 0;
  for await (const msg of gen) {
    if (msg.type !== "result") continue;
    results++;
    // Fired, not awaited inside the loop: the answer arrives through this same read loop.
    pending = gen.clearQueuedInput!();
    pending.then(release, release);
  }
  try {
    return { answer: await pending!, results };
  } catch (failure) {
    return { failure, results };
  }
}

test("clearQueuedInput() with nothing waiting answers { cleared: 0 } and the session carries on", async () => {
  const outcome = await callAfterFirstResult((args) => inMemoryProcess(args, provider));
  expect(outcome.answer).toEqual({ cleared: 0 });
  expect(outcome.results).toBe(1);
});

test("against a runtime older than the control it rejects with a WinterRpcError (unknown_subtype) -- never a hang, never a crash", async () => {
  const outcome = await callAfterFirstResult(olderRuntime);
  expect(outcome.failure).toBeInstanceOf(WinterRpcError);
  expect((outcome.failure as WinterRpcError).code).toBe("unknown_subtype");
  expect(outcome.results).toBe(1);
});
