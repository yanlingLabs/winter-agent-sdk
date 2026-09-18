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
import { exaSearchClientForSession, exaSearchClientIsClosedForTest, resetExaSessionClientsForTest } from "../tools/impl/_exa-session-client.ts";
import { forgetWebSearchBudgetForSession, reserveWebSearchCall, resetWebSearchBudgetForTest, webSearchCallsUsed } from "../tools/impl/_search-budget.ts";
import { webFetchCache } from "../tools/impl/_web-fetch-cache.ts";
import { resetWebSessionRuntimesForTest } from "./session-runtime.ts";

afterEach(() => {
  resetExaSessionClientsForTest();
  resetWebSearchBudgetForTest();
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

/** `onGenerate` (optional) runs INSIDE the live run, at its one provider call -- the only place a test can observe per-session state while the run still holds it. */
async function runToEnd(config: Partial<RuntimeConfig> & { sessionId: string; onGenerate?: () => void }): Promise<void> {
  const { host, runtime } = createInMemoryChannel();
  const { onGenerate, ...runtimeConfig } = config;
  const scripted = scriptedProvider([{ kind: "text", text: "ok" }]);
  const done = runEngine({
    config: { cwd: process.cwd(), model: "prova/m", persistSession: false, ...runtimeConfig } as RuntimeConfig,
    input: runtime.input,
    output: runtime.output,
    provider:
      onGenerate === undefined
        ? scripted
        : {
            async generate(input) {
              onGenerate();
              return scripted.generate(input);
            },
          },
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
    // Forgotten AND tombstoned: nothing may build another client for a session that has ended (MINOR
    // 6) -- until a ROOT run for that id starts again, which is what an in-process `--resume` is.
    expect(exaSearchClientIsClosedForTest(sessionId)).toBe(true);
    expect(exaSearchClientForSession(sessionId, fakeClient)).toBeUndefined();

    // An in-process `--resume` of that id is a new ROOT run, and it must be able to search again: the
    // tombstone is lifted when the root REGISTERS its web seam. Probed from inside the run (the run's
    // own teardown closes -- and re-tombstones -- the id again by the time it reports done).
    const resumed = fakeClient();
    let insideRun: { tombstoned: boolean; built: ExaSearchClient | undefined } | undefined;
    await runToEnd({
      sessionId,
      onGenerate: () => {
        insideRun = { tombstoned: exaSearchClientIsClosedForTest(sessionId), built: exaSearchClientForSession(sessionId, () => resumed) };
      },
    });
    expect(insideRun).toEqual({ tombstoned: false, built: resumed });
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

  test("after the root's teardown a still-running CHILD gets an ordinary refusal, never a new unclosed client (MINOR 6)", async () => {
    const sessionId = "exa-teardown-late-child";
    const client = seed(sessionId);
    await runToEnd({ sessionId });
    expect(client.closes).toBe(1);
    // A child run of the torn-down session: it must NOT be able to build a client (nothing would ever
    // close it), and the factory must never even be called.
    let built = 0;
    const late = exaSearchClientForSession(sessionId, () => {
      built += 1;
      return fakeClient();
    });
    expect([late, built]).toEqual([undefined, 0]);
    // A child run STARTING does not lift the tombstone -- only a root's does.
    await runToEnd({ sessionId, agentId: "agent-late", insideSubagent: true });
    expect(exaSearchClientIsClosedForTest(sessionId)).toBe(true);
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

describe("the web tools' other per-session state is forgotten by the ROOT run's teardown (MINOR 4)", () => {
  test("the search budget and the fetch cache are dropped at the root's end, and not by a child's", async () => {
    const sessionId = "web-state-teardown";
    const cacheEntry = { bytes: 4, code: 200, codeText: "OK", content: "body", contentType: "text/plain", finalUrl: "https://example.com/" };
    const seedState = (): void => {
      expect(reserveWebSearchCall(sessionId, 200).ok).toBe(true);
      webFetchCache.set(sessionId, "https://example.com/", cacheEntry);
    };

    // A CHILD's teardown leaves both alone: it shares its root's session id, so clearing them would
    // reset its parent's budget and drop its cache mid-turn.
    seedState();
    await runToEnd({ sessionId, agentId: "agent-child", insideSubagent: true });
    expect(webSearchCallsUsed(sessionId)).toBe(1);
    expect(webFetchCache.get(sessionId, "https://example.com/")).toEqual(cacheEntry);

    // The ROOT's teardown drops both, so a resumed run starts with a fresh budget and a cold cache.
    await runToEnd({ sessionId });
    expect(webSearchCallsUsed(sessionId)).toBe(0);
    expect(webFetchCache.get(sessionId, "https://example.com/")).toBeUndefined();
  });

  test("forgetting is idempotent and never touches another session", () => {
    expect(reserveWebSearchCall("keeper", 200).ok).toBe(true);
    forgetWebSearchBudgetForSession("never-seen");
    forgetWebSearchBudgetForSession("never-seen");
    webFetchCache.forgetSession("never-seen");
    expect(webSearchCallsUsed("keeper")).toBe(1);
    forgetWebSearchBudgetForSession("keeper");
    expect(webSearchCallsUsed("keeper")).toBe(0);
  });
});
