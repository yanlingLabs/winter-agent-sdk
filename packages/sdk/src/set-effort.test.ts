// WS-23: `Query.setEffort()` through the WRAPPER, against the REAL engine over the in-memory process
// (the `setPermissionMode()` tests' own pattern): the `set_effort` control request reaches the engine,
// a valid level resolves and moves the NEXT turn's effort, and an invalid one rejects typed.
import { expect, test } from "bun:test";
import { query } from "./query.ts";
import { WinterRpcError } from "./errors.ts";
import { inMemoryProcess } from "winter-agent-runtime/testing";
import type { Provider } from "winter-agent-runtime";
import type { EffortLevel } from "./protocol/config.ts";

test("setEffort(): resolves on the engine's ack and the next turn runs at the new level; an unknown level rejects with `invalid_effort`", async () => {
  const efforts: unknown[] = [];
  const provider: Provider = {
    async generate(req) {
      efforts.push(req.effort);
      return { kind: "text", text: "ok" };
    },
  };
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));
  let releaseEnd!: () => void;
  const endGate = new Promise<void>((resolve) => (releaseEnd = resolve));
  async function* prompt() {
    yield "one";
    await secondGate;
    yield "two";
    await endGate;
  }

  const gen = query({ prompt: prompt(), options: { model: "winter-test/echo", effort: "high", spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, provider) } });
  let valid: Promise<void> | undefined;
  let invalidError: unknown;
  let invalid: Promise<void> | undefined;
  let results = 0;
  for await (const msg of gen) {
    if (msg.type !== "result") continue;
    results++;
    if (results === 1) {
      // Fired, NOT awaited: the ack is delivered by this same read loop, so awaiting here would
      // deadlock (query.test.ts's setPermissionMode test says why). The control request is written
      // BEFORE turn two's prompt, and the engine handles frames in order, so the idle engine has
      // applied it by the time turn two starts.
      valid = gen.setEffort("low");
      invalid = gen.setEffort("minimal" as EffortLevel).catch((e: unknown) => {
        invalidError = e;
      });
      releaseSecond();
    } else {
      releaseEnd();
    }
  }
  await valid; // throws (failing the test) if the ack path is broken
  await invalid;
  expect(efforts).toEqual(["high", "low"]);
  expect(invalidError).toBeInstanceOf(WinterRpcError);
  expect((invalidError as WinterRpcError).code).toBe("invalid_effort");
});
