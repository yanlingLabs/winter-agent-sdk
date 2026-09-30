// query() and an abort that lands BEFORE anything reads the Query.
//
//   1. An ALREADY-aborted signal spawns nothing, and reading the Query throws the same `AbortError` an
//      abort right after a spawn gives.
//   2. An abort after the spawn but before the first read kills the child PROMPTLY -- a caller that
//      aborts and never reads must not leave a live `winter` behind (a host's test suite leaked seven).
import { afterAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "./query.ts";
import { AbortError } from "./errors.ts";
import { defaultSpawn, type SpawnRuntimeOptions, type SpawnedRuntimeProcess } from "./transport.ts";
import { TEST_KEYCHAIN_ENV, TEST_KEYCHAIN_MEMORY } from "./options.ts";

const mainPath = fileURLToPath(new URL("../../runtime/src/main.ts", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "winter-query-abort-home-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** A spawn hook that runs the REAL runtime child on a provider that never answers, and records it. */
function realChild(spawned: SpawnedRuntimeProcess[]): (opts: SpawnRuntimeOptions) => SpawnedRuntimeProcess {
  return (opts) => {
    const proc = defaultSpawn({
      ...opts,
      command: process.execPath,
      args: [mainPath, ...opts.args],
      env: { ...opts.env, WINTER_HOME: home, WINTER_DISABLE_GIT_INSTRUCTIONS: "1", [TEST_KEYCHAIN_ENV]: TEST_KEYCHAIN_MEMORY },
    });
    spawned.push(proc);
    return proc;
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("query() with an abort before the first read", () => {
  test("an ALREADY-aborted signal spawns nothing; reading throws AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    let spawns = 0;
    const q = query({
      prompt: "hi",
      options: {
        model: "winter-test/hang",
        cwd: home,
        abortController: controller,
        spawnClaudeCodeProcess: () => {
          spawns++;
          throw new Error("must not spawn");
        },
      },
    });
    expect(spawns).toBe(0);
    let thrown: unknown;
    try {
      for await (const _message of q) {
        /* nothing arrives */
      }
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AbortError);
    expect(spawns).toBe(0);
  });

  test("the SAME error as an abort right after a real spawn", async () => {
    const spawned: SpawnedRuntimeProcess[] = [];
    const controller = new AbortController();
    const q = query({ prompt: "hi", options: { model: "winter-test/hang", cwd: home, abortController: controller, spawnClaudeCodeProcess: realChild(spawned) } });
    controller.abort();
    let thrown: unknown;
    try {
      for await (const _message of q) {
        /* nothing arrives */
      }
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AbortError);
    expect((thrown as Error).message).toBe("query aborted: runtime process killed");
    await spawned[0]!.exited;
  }, 30_000);

  test("an abort after the spawn kills the child promptly with NO read at all", async () => {
    const spawned: SpawnedRuntimeProcess[] = [];
    const controller = new AbortController();
    // Built and never read: the leak pattern.
    query({ prompt: "hi", options: { model: "winter-test/hang", cwd: home, abortController: controller, spawnClaudeCodeProcess: realChild(spawned) } });
    expect(spawned).toHaveLength(1);
    const child = spawned[0]!;
    const pid = child.pid!;
    expect(isAlive(pid)).toBe(true);
    controller.abort();
    const exit = await Promise.race([child.exited, new Promise<"still running">((resolve) => setTimeout(() => resolve("still running"), 5_000))]);
    expect(exit).not.toBe("still running");
    expect(isAlive(pid)).toBe(false);
  }, 30_000);
});
