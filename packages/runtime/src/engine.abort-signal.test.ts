// `EngineOptions.abortSignal`: the session HARD STOP for a host that is gone. It must work after the
// input has already ENDED -- exactly the state a dead host leaves (its stdin closed when it died) --
// where no `interrupt` frame can reach the engine any more.
import { expect, test } from "bun:test";
import type { WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "./protocol/channel.ts";
import { runEngine, type Provider } from "./engine.ts";
import { stubExecutor } from "./provider/mock.ts";

function hangingProvider(calls: { n: number }): Provider {
  return {
    generate() {
      calls.n++;
      // Never answers: only the interrupt (the engine races the generation against it) ends the turn.
      return new Promise<never>(() => {});
    },
  };
}

test("aborted after the input ended, mid-turn: the turn ends interrupted, waiting input never runs, runEngine returns", async () => {
  const { host, runtime } = createInMemoryChannel();
  const stop = new AbortController();
  const calls = { n: 0 };
  const done = runEngine({
    config: { sessionId: "abort-signal", cwd: "/tmp", model: "winter-test/echo" },
    input: runtime.input,
    output: runtime.output,
    provider: hangingProvider(calls),
    tools: stubExecutor,
    abortSignal: stop.signal,
  });
  const frames: WinterFrame[] = [];
  const reader = (async () => {
    for await (const f of host.input) frames.push(f);
  })();
  host.output.write({ type: "user", text: "first" });
  host.output.write({ type: "user", text: "second" }); // waiting behind the hung turn
  host.output.end(); // the host's stdin is gone: no frame can arrive from here on
  for (let n = 0; n < 200 && calls.n === 0; n++) await new Promise((r) => setTimeout(r, 5));
  expect(calls.n).toBe(1);

  stop.abort();
  const code = await Promise.race([done, new Promise<"hung">((r) => setTimeout(() => r("hung"), 2_000))]);
  expect(code).not.toBe("hung");
  await reader;
  const results = frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").map((f) => (f as { message: Record<string, unknown> }).message);
  expect(results).toHaveLength(1);
  expect(results[0]!["interrupted"]).toBe(true);
  expect(calls.n).toBe(1); // "second" never started a turn
});

test("an engine whose signal is never aborted behaves as before: input EOF still finishes the turn", async () => {
  const { host, runtime } = createInMemoryChannel();
  const stop = new AbortController();
  const done = runEngine({
    config: { sessionId: "abort-signal-idle", cwd: "/tmp", model: "winter-test/echo" },
    input: runtime.input,
    output: runtime.output,
    provider: { async generate() { await new Promise((r) => setTimeout(r, 50)); return { kind: "text", text: "finished" }; } },
    tools: stubExecutor,
    abortSignal: stop.signal,
  });
  const frames: WinterFrame[] = [];
  const reader = (async () => {
    for await (const f of host.input) frames.push(f);
  })();
  host.output.write({ type: "user", text: "go" });
  host.output.end();
  await done;
  await reader;
  const results = frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").map((f) => (f as { message: Record<string, unknown> }).message);
  expect(results).toHaveLength(1);
  expect(results[0]!["result"]).toBe("finished");
});
