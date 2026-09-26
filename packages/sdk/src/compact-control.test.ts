// WS-23 (reasoning-state, decision 5): `Query.compact()` through the WRAPPER, against the REAL engine over
// the in-memory process (`set-effort.test.ts`'s pattern). The daemon calls it on the live child before a
// switch to another provider whose model cannot hold the conversation -- the model being left writes the
// summary -- so it must compact NOW, on the live model, resolve once done, and leave the next turn on the
// compacted history.
import { expect, test } from "bun:test";
import { query } from "./query.ts";
import { WinterRpcError } from "./errors.ts";
import { inMemoryProcess } from "@yanlinglabs/winter-agent-runtime/testing";
import type { Provider, ProviderRequest } from "@yanlinglabs/winter-agent-runtime";

test("compact(): compacts on the live model when idle, resolves with what it kept, and the next turn starts from the summary", async () => {
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    async generate(req) {
      requests.push(req);
      const last = req.messages.at(-1);
      // The summary instruction is the request's last user message (on the prefix-reusing path too).
      const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
      const summarizing = /summar/i.test(text) && !text.includes("question ");
      return { kind: "text", text: summarizing ? "THE SUMMARY" : `answer ${requests.length}` };
    },
  };
  const TURNS = 6;
  const gates = Array.from({ length: TURNS + 1 }, () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    return { gate, release };
  });
  async function* prompt() {
    for (let i = 0; i < TURNS; i++) {
      yield `question ${i}`;
      await gates[i]!.gate;
    }
    yield "after the compaction";
    await gates[TURNS]!.gate;
  }

  const gen = query({ prompt: prompt(), options: { model: "winter-test/echo", spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, provider) } });
  let compacted: Promise<{ retainedCount: number }> | undefined;
  let results = 0;
  let before = 0;
  for await (const msg of gen) {
    if (msg.type !== "result") continue;
    results++;
    if (results === TURNS) {
      before = requests.at(-1)!.messages.length;
      // Fired, not awaited (the ack arrives through this same read loop); the engine settles the
      // compaction before it starts the next turn.
      compacted = gen.compact!();
    }
    gates[results - 1]?.release();
  }
  const outcome = await compacted!;
  expect(outcome.retainedCount).toBeGreaterThan(0);
  const last = requests.at(-1)!;
  const sent = JSON.stringify(last.messages);
  expect(sent).toContain("THE SUMMARY");
  expect(sent).not.toContain("question 0");
  expect(last.messages.length).toBeLessThan(before + 2);
});

test("compact() with nothing to compact rejects typed, and the session carries on", async () => {
  const provider: Provider = {
    async generate() {
      return { kind: "text", text: "ok" };
    },
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  async function* prompt() {
    yield "only one";
    await gate;
  }
  const gen = query({ prompt: prompt(), options: { model: "winter-test/echo", spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, provider) } });
  let failure: unknown;
  let pending: Promise<unknown> | undefined;
  for await (const msg of gen) {
    if (msg.type !== "result") continue;
    // Fired, not awaited inside the loop: the rejection arrives through this same read loop.
    pending = gen.compact!().catch((e: unknown) => {
      failure = e;
    });
    setTimeout(release, 50);
  }
  await pending;
  expect(failure).toBeInstanceOf(WinterRpcError);
  expect((failure as WinterRpcError).code).toBe("compaction_failed");
});
