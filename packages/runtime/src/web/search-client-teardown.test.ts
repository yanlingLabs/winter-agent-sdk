// The per-session search client's TEARDOWN.
//
// `tools/impl/_exa-session-client.ts` keeps ONE search client per ROOT session -- a child run carries
// its root's `sessionId`, so the whole agent tree shares it. The engine closes it when the ROOT run
// ends, and ONLY then: a child's teardown must leave it open for the parent and siblings still using it.
import { afterEach, describe, expect, test } from "bun:test";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import "../tools/descriptors/index.ts";
import { runEngine } from "../engine.ts";
import { scriptedProvider } from "../provider/mock.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";
import type { ExaSearchClient } from "../tools/impl/_exa-client.ts";
import { exaSearchClientForSession, resetExaSessionClientsForTest } from "../tools/impl/_exa-session-client.ts";
import { resetWebSessionRuntimesForTest } from "./session-runtime.ts";

afterEach(() => {
  resetExaSessionClientsForTest();
  resetWebSessionRuntimesForTest();
});

function fakeClient(): ExaSearchClient & { closes: number } {
  return {
    closes: 0,
    async search() {
      return { ok: false, code: "backend-error", message: "a double" };
    },
    async close() {
      this.closes += 1;
    },
  };
}

/** Seeds `sessionId`'s cached client, exactly as that session's first WebSearch call would. */
function seed(sessionId: string): ReturnType<typeof fakeClient> {
  const client = fakeClient();
  expect(exaSearchClientForSession(sessionId, () => client)).toBe(client);
  return client;
}

/** True while `sessionId` still holds `client` -- a fresh factory is NOT consulted while an entry exists. */
function stillCached(sessionId: string, client: ExaSearchClient): boolean {
  return exaSearchClientForSession(sessionId, () => client) === client && true;
}

async function runToEnd(config: Partial<RuntimeConfig> & { sessionId: string }): Promise<void> {
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config: { cwd: process.cwd(), model: "prova/m", persistSession: false, ...config } as RuntimeConfig,
    input: runtime.input,
    output: runtime.output,
    provider: scriptedProvider([{ kind: "text", text: "ok" }]),
  });
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
  const frames: WinterFrame[] = [];
  for await (const f of host.input) frames.push(f);
  await done;
}

describe("the session's search client is closed by the ROOT run's teardown, and by nothing else", () => {
  test("the ROOT's teardown closes it (awaited: closed by the time the run reports done) and forgets it", async () => {
    const sessionId = "exa-teardown-root";
    const client = seed(sessionId);
    await runToEnd({ sessionId });
    expect(client.closes).toBe(1);
    // Forgotten: the next session under this id (a `--resume` in the same process) builds its own.
    const next = fakeClient();
    expect(exaSearchClientForSession(sessionId, () => next)).toBe(next);
  });

  test("a CHILD's teardown leaves the root's client OPEN -- it is the parent's and every sibling's connection too", async () => {
    const sessionId = "exa-teardown-tree";
    const client = seed(sessionId);
    await runToEnd({ sessionId, agentId: "agent-child-1", insideSubagent: true });
    expect(client.closes).toBe(0);
    expect(stillCached(sessionId, client)).toBe(true);
    // A second child (a sibling, or a resumed generation) changes nothing...
    await runToEnd({ sessionId, agentId: "agent-child-2", insideSubagent: true });
    expect(client.closes).toBe(0);
    // ...and the root's own teardown is what finally closes it, exactly once.
    await runToEnd({ sessionId });
    expect(client.closes).toBe(1);
  });

  test("a root run that THROWS mid-run still closes it; a child that throws still does not", async () => {
    const run = async (config: Partial<RuntimeConfig> & { sessionId: string }): Promise<void> => {
      const { host, runtime } = createInMemoryChannel();
      // The sink fails on the FIRST data frame (`system/init`), long after the web seam is set up and
      // long before the ordinary teardown -- so only the run's outer `finally` can do the closing.
      const output = {
        ...runtime.output,
        write(frame: WinterFrame) {
          if (frame.type === "data") throw new Error("sink failure mid-run");
          return runtime.output.write(frame);
        },
      };
      const done = runEngine({ config: { cwd: process.cwd(), model: "prova/m", persistSession: false, ...config } as RuntimeConfig, input: runtime.input, output: output as typeof runtime.output, provider: scriptedProvider([{ kind: "text", text: "ok" }]) });
      host.output.write({ type: "user", text: "go" });
      host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
      let threw = false;
      await done.catch(() => void (threw = true));
      expect(threw).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0)); // the disposer's close is fire-and-forget
    };
    const sessionId = "exa-teardown-throw";
    const client = seed(sessionId);
    await run({ sessionId, agentId: "agent-child-throws", insideSubagent: true });
    expect(client.closes).toBe(0);
    expect(stillCached(sessionId, client)).toBe(true);
    await run({ sessionId });
    expect(client.closes).toBe(1);
  });
});
