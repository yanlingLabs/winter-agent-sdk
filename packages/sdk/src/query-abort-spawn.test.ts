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
import { encodeFrame } from "./protocol/codec.ts";
import { PROTOCOL_VERSION } from "./protocol/frames.ts";

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

// --- second review: a rejecting `exited`, and an abort AFTER the Query finished ---------------------------

const initFrame = () =>
  encodeFrame({ type: "init", protocolVersion: PROTOCOL_VERSION as `${number}.${number}`, sessionId: "s", cwd: "/x", model: "winter-test/echo", permissionMode: "default", tools: [] });
const successFrame = () => encodeFrame({ type: "data", message: { type: "result", subtype: "success", is_error: false, result: "ok" } });

function fakeProc(opts: { stdout: string[]; exited: Promise<{ code: number | null; signal: string | null }>; kills: string[] }): SpawnedRuntimeProcess {
  return {
    stdin: { write() {}, end() {} },
    stdout: (async function* () {
      for (const chunk of opts.stdout) yield chunk;
    })(),
    kill: (signal?: string) => void opts.kills.push(signal ?? "SIGTERM"),
    exited: opts.exited,
    pid: 4242,
  };
}

describe("query() spawn-time abort handling, second review", () => {
  test("a custom spawn hook whose `exited` REJECTS never becomes an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const controller = new AbortController();
      const exited = Promise.reject(new Error("the hook's process handle failed"));
      exited.catch(() => {}); // the test's own reference is handled; query()'s must be too
      query({ prompt: "hi", options: { abortController: controller, spawnClaudeCodeProcess: () => fakeProc({ stdout: [], exited, kills: [] }) } });
      controller.abort(); // exercises the kill path's own `exited` handler as well
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("once the Query has FINISHED, a later abort does not kill a child that is shutting down gracefully", async () => {
    const kills: string[] = [];
    let resolveExit!: (v: { code: number | null; signal: string | null }) => void;
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => (resolveExit = resolve));
    const controller = new AbortController();
    const messages: string[] = [];
    for await (const message of query({ prompt: "hi", options: { abortController: controller, spawnClaudeCodeProcess: () => fakeProc({ stdout: [initFrame(), successFrame()], exited, kills }) } })) {
      messages.push(message.type);
    }
    expect(messages).toContain("result");
    controller.abort(); // after the exchange completed; the child has not exited yet
    await new Promise((resolve) => setTimeout(resolve, 150)); // past the SIGKILL grace
    expect(kills).toEqual([]);
    resolveExit({ code: 0, signal: null });
  });

  test("an abort BEFORE the first read still kills at once, then the SIGKILL is cancelled when the Query finishes", async () => {
    const kills: string[] = [];
    const controller = new AbortController();
    const q = query({ prompt: "hi", options: { abortController: controller, spawnClaudeCodeProcess: () => fakeProc({ stdout: [], exited: new Promise(() => {}), kills }) } });
    controller.abort();
    expect(kills).toEqual(["SIGTERM"]);
    await expect((async () => {
      for await (const _message of q) {
        /* nothing */
      }
    })()).rejects.toBeInstanceOf(AbortError);
    await new Promise((resolve) => setTimeout(resolve, 150)); // past the grace: the escalation was cancelled by the finish
    expect(kills).toEqual(["SIGTERM"]);
  });
});
