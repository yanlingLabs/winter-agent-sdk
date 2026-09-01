// Winter crash tests (Task 7 brief, beyond the official 13-case suite in session-store.test.ts):
// torn final line, kill-during-append (a REAL spawned+SIGKILLed child), and lease contention (a
// REAL live foreign pid). Every home here is a fresh mkdtemp — never ~/.winter/~/.norma/~/.claude.
//
// The two child-process tests embed the store module path as a JS string literal (safe regardless
// of spaces in the checkout path — this repo's own path has one) and resolve it to a `file://` URL
// via pathToFileURL before a dynamic import, rather than a static import specifier string, so a
// space in the path can never be misparsed as a bare (non-URL) specifier. Children are spawned via
// process.execPath (matches scripts/verify-protocol-compiled.ts's own convention) and always
// reaped (kill + awaited `.exited`) in a finally block.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, statSync, existsSync, readFileSync, writeFileSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { WinterCompatibilitySessionStore, WinterStoreLeaseError, type SessionStoreEntry } from "./session-store.ts";

const STORE_MODULE_PATH = fileURLToPath(new URL("./session-store.ts", import.meta.url));

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "winter-crash-test-"));
}

let seq = 0;
function entry(overrides: Partial<SessionStoreEntry> = {}): SessionStoreEntry {
  seq += 1;
  return { type: "test_entry", uuid: `uuid-${seq}`, timestamp: new Date(2020, 0, 1, 0, 0, seq).toISOString(), seq, ...overrides };
}

type Subprocess = ReturnType<typeof Bun.spawn>;

// Bounded poll for a path to exist, rather than a fixed sleep — a fixed sleep can't distinguish
// "the loop hasn't gotten far yet" from "the child process/transpile startup itself hasn't
// finished yet" on a cold or loaded runner (Ruling P1-P is this exact class of darwin-tested
// assumption failing on a slower CI runner). Throws if `path` never appears within `timeoutMs`.
async function waitForPath(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path} to exist`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function reap(child: Subprocess | undefined): Promise<void> {
  if (child === undefined) return;
  child.kill("SIGKILL");
  await child.exited;
}

describe("crash: torn final line", () => {
  test("truncating mid-line leaves earlier entries intact, quarantines the torn tail, repairs the file, and stays clean on re-load and future appends", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-crash", sessionId: "torn-tail" };
      const e1 = entry();
      const e2 = entry();
      await store.append(key, [e1, e2]);

      const jsonlPath = join(home, "projects", "proj-crash", "torn-tail.jsonl");
      const fullSize = statSync(jsonlPath).size;
      truncateSync(jsonlPath, fullSize - 5); // chop mid-way through e2's line — simulates a crash mid-write

      const loaded1 = await store.load(key);
      expect(loaded1).toEqual([e1]);

      const quarantinePath = `${jsonlPath}.tail-quarantine`;
      expect(existsSync(quarantinePath)).toBe(true);
      const quarantineSize1 = statSync(quarantinePath).size;
      expect(quarantineSize1).toBeGreaterThan(0);

      // idempotent: a second load() must not re-detect corruption or grow the quarantine again
      const loaded2 = await store.load(key);
      expect(loaded2).toEqual([e1]);
      expect(statSync(quarantinePath).size).toBe(quarantineSize1);

      // the repaired file is genuinely clean on disk: a fresh append lands correctly, never
      // concatenated onto the torn fragment (this is why repair MUST truncate, not just skip it
      // in memory — an unrepaired file would corrupt e3's own line on the next O_APPEND write)
      const e3 = entry();
      await store.append(key, [e3]);
      expect(await store.load(key)).toEqual([e1, e3]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a file that is ONE single unterminated line (never had a complete entry) quarantines entirely and loads as []", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-crash", sessionId: "torn-only-line" };
      await store.append(key, [entry()]);
      const jsonlPath = join(home, "projects", "proj-crash", "torn-only-line.jsonl");
      truncateSync(jsonlPath, 3); // leaves only `{"t` or similar — not even the start of valid JSON

      const loaded = await store.load(key);
      expect(loaded).toEqual([]); // the key IS known (file exists) — [] not null
      expect(statSync(`${jsonlPath}.tail-quarantine`).size).toBeGreaterThan(0);
      expect(statSync(jsonlPath).size).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // T7 F3 (fix-wave): parseWithTailRepair's "ends WITH a trailing newline, but the last LINE's
  // content is unparseable JSON" branch (session-store.ts's `endsWithNewline` true / `isParseableJson`
  // false path) is implemented but was untested — a truncation (mid-write crash) can only ever
  // produce a torn tail that DOESN'T end in a newline (the writer was cut off before finishing the
  // line) or one that's a complete, valid line. The "structurally complete-looking but garbage"
  // shape needs a hand-written fixture: nothing this store's own append() ever produces gets here
  // naturally.
  test("a file whose last line IS newline-terminated but is unparseable JSON quarantines exactly that line, repairs the file, and keeps earlier valid entries", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-crash", sessionId: "unparseable-last-line" };
      const projDir = join(home, "projects", "proj-crash");
      mkdirSync(projDir, { recursive: true });
      const jsonlPath = join(projDir, "unparseable-last-line.jsonl");

      const e1 = entry();
      const validLine = JSON.stringify(e1);
      const garbageLine = "{garbage-not-valid-json"; // newline-terminated, but not valid JSON at all
      writeFileSync(jsonlPath, `${validLine}\n${garbageLine}\n`);

      const loaded = await store.load(key);
      expect(loaded).toEqual([e1]); // the earlier valid entry survives untouched

      const quarantinePath = `${jsonlPath}.tail-quarantine`;
      expect(existsSync(quarantinePath)).toBe(true);
      expect(readFileSync(quarantinePath, "utf8")).toBe(`${garbageLine}\n`);
      expect(readFileSync(jsonlPath, "utf8")).toBe(`${validLine}\n`); // repaired: garbage line removed

      // the repaired file is genuinely clean — a fresh append lands correctly, not concatenated
      // onto the removed garbage
      const e2 = entry();
      await store.append(key, [e2]);
      expect(await store.load(key)).toEqual([e1, e2]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("crash: kill-during-append", () => {
  test("SIGKILLing a real child mid-loop leaves every complete line intact plus at most one quarantined tail", async () => {
    const home = freshHome();
    let child: Subprocess | undefined;
    try {
      const projectKey = "proj-crash";
      const sessionId = "kill-mid-append";
      const count = 300;
      const delayMs = 3;
      const key = { projectKey, sessionId };
      const code = `(async () => {
        const { pathToFileURL } = await import("node:url");
        const mod = await import(pathToFileURL(${JSON.stringify(STORE_MODULE_PATH)}).href);
        const store = new mod.WinterCompatibilitySessionStore({ winterHome: ${JSON.stringify(home)} });
        const key = ${JSON.stringify(key)};
        for (let i = 0; i < ${count}; i++) {
          await store.append(key, [{ type: "test_entry", uuid: "child-" + i, timestamp: new Date().toISOString(), index: i }]);
          await new Promise((r) => setTimeout(r, ${delayMs}));
        }
      })();`;

      child = Bun.spawn([process.execPath, "-e", code], { stdout: "ignore", stderr: "ignore" });

      // Wait for PROOF the child has actually started and completed at least one append (its
      // jsonl exists), rather than a fixed sleep guessing how long spawn+transpile startup takes —
      // removes cold/loaded-runner startup time as a flake vector entirely. Then a short further
      // delay lets a few more iterations land before the kill, so it has a real chance of landing
      // mid-loop rather than immediately after the first write.
      const jsonlPath = join(home, "projects", projectKey, `${sessionId}.jsonl`);
      await waitForPath(jsonlPath, 10_000);
      await new Promise((r) => setTimeout(r, 50));
      child.kill("SIGKILL");
      await child.exited;

      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const loaded = await store.load(key);

      expect(loaded).not.toBeNull();
      const entries = loaded ?? [];
      expect(entries.length).toBeGreaterThan(0); // proves at least some appends landed before the kill
      expect(entries.length).toBeLessThan(count); // proves the kill actually landed mid-loop

      // every surviving entry is intact and in strict index order — no gaps, no dupes, no corruption
      const indices = entries.map((e) => e["index"] as number);
      expect(indices).toEqual(Array.from({ length: entries.length }, (_, i) => i));

      // AT MOST one quarantined tail fragment — never systemic multi-line corruption
      const quarantinePath = join(home, "projects", projectKey, `${sessionId}.jsonl.tail-quarantine`);
      if (existsSync(quarantinePath)) {
        expect(statSync(quarantinePath).size).toBeGreaterThan(0);
      }
    } finally {
      await reap(child);
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("crash: lease contention", () => {
  test("a live foreign pid holding the lock throws a typed lease error, not a generic one", async () => {
    const home = freshHome();
    let dummy: Subprocess | undefined;
    try {
      // A genuinely live, otherwise-idle process — its pid is the "foreign live holder" this test
      // fabricates into the lock file below.
      dummy = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 2147483647);"], { stdout: "ignore", stderr: "ignore" });

      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-crash", sessionId: "contended" };
      await store.append(key, [entry()]); // creates the lock, owned by THIS test process

      const lockPath = join(home, "projects", "proj-crash", "contended.lock");
      writeFileSync(lockPath, JSON.stringify({ pid: dummy.pid, startTimeMs: Date.now() }));

      let caught: unknown;
      try {
        await store.append(key, [entry()]);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(WinterStoreLeaseError);
      expect((caught as WinterStoreLeaseError).heldByPid).toBe(dummy.pid);

      // the main jsonl must be untouched by the rejected append — contention fails BEFORE any
      // write, so only the ONE entry from the earlier successful append is still there
      expect(await store.load(key)).toHaveLength(1);
    } finally {
      await reap(dummy);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("contention is keyed by pid, not by JS store-instance identity: a second same-process instance with no foreign lock succeeds", async () => {
    const home = freshHome();
    try {
      const store1 = new WinterCompatibilitySessionStore({ winterHome: home });
      const store2 = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-crash", sessionId: "same-process" };
      const e1 = entry();
      const e2 = entry();
      await store1.append(key, [e1]);
      await expect(store2.append(key, [e2])).resolves.toBeUndefined(); // same pid (this test process) — re-entry, not contention
      expect(await store1.load(key)).toEqual([e1, e2]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("stale-steal: once the lock-holding process has genuinely exited, a new writer reclaims the lease (pid-gone detection)", async () => {
    const home = freshHome();
    let child: Subprocess | undefined;
    try {
      const key = { projectKey: "proj-crash", sessionId: "stale-steal" };
      // A short-lived child that acquires the lease for one entry, then exits ON ITS OWN — no kill
      // involved, so its pid becomes CLEANLY gone (genuinely stale), matching P1's pid-gone-only
      // detection rule rather than the SIGKILL scenario above.
      const code = `(async () => {
        const { pathToFileURL } = await import("node:url");
        const mod = await import(pathToFileURL(${JSON.stringify(STORE_MODULE_PATH)}).href);
        const store = new mod.WinterCompatibilitySessionStore({ winterHome: ${JSON.stringify(home)} });
        await store.append(${JSON.stringify(key)}, [{ type: "test_entry", uuid: "child-1", timestamp: new Date().toISOString() }]);
      })();`;
      child = Bun.spawn([process.execPath, "-e", code], { stdout: "ignore", stderr: "ignore" });
      const exitCode = await child.exited;
      expect(exitCode).toBe(0);
      const childPid = child.pid;

      const lockPath = join(home, "projects", "proj-crash", "stale-steal.lock");
      const childLease = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
      expect(childLease.pid).toBe(childPid);

      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const e2 = entry();
      await store.append(key, [e2]); // must steal the now-stale lease rather than throwing

      const newLease = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
      expect(newLease.pid).toBe(process.pid);
      expect(newLease.pid).not.toBe(childPid);

      const loaded = await store.load(key);
      expect(loaded).toHaveLength(2);
      expect(loaded![1]).toEqual(e2);
    } finally {
      await reap(child);
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// Whole-branch review Important 1 / Ruling P1-S: load()'s tail-repair previously mutated a torn
// tail UNCONDITIONALLY, never consulting the writer lease first. A reader landing in the middle of
// a LIVE writer's own append() (a real, non-hypothetical shape now that Task 9's resume/continue
// can run a read concurrently with another process still appending to the SAME session) would
// quarantine+truncate the live writer's own half-written line out from under it — corrupting a
// file that was never actually corrupt, just caught mid-flight. The fix: before repairing, check
// whether the SAME session's lock names a DIFFERENT, still-live pid; if so, defer repair entirely
// (return the complete lines only, exactly as parseWithTailRepair already computed them, but touch
// nothing on disk) — repair happens later, once the real owner appends again (its own next
// O_APPEND write extends past the "torn" point, so there is nothing left to repair) or once an
// unleased reader (the dead-pid variant below) finds it.
//
// These two cases construct the STATE directly rather than racing a real concurrent writer for it
// (the ONLY reliable way to hit this deterministically — a real race would be exactly as flaky here
// as it was for the CI-fix thread's EPIPE bug): a live dummy process's pid is planted into the
// `.lock` file (same technique as the "lease contention" suite above), and a real torn tail is
// created the same way the "crash: torn final line" suite already does (truncateSync mid-line).
describe("crash: lease-aware tail repair (Ruling P1-S)", () => {
  test("a torn tail with a DIFFERENT LIVE pid in the lease is left completely untouched — no quarantine, no truncate — but complete lines are still returned", async () => {
    const home = freshHome();
    let dummy: Subprocess | undefined;
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-crash", sessionId: "live-holder-torn" };
      const e1 = entry();
      const e2 = entry();
      await store.append(key, [e1, e2]); // creates the lock, owned by THIS test process for now

      const jsonlPath = join(home, "projects", "proj-crash", "live-holder-torn.jsonl");
      const fullSize = statSync(jsonlPath).size;
      truncateSync(jsonlPath, fullSize - 5); // chop mid-way through e2's line — a real torn tail
      const tornSize = statSync(jsonlPath).size;

      // A genuinely live, otherwise-idle process — its pid is planted as the lease holder below,
      // simulating "some other process is (or still could be) the live writer of this session,"
      // the exact condition load() must defer to rather than repair over.
      dummy = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 2147483647);"], { stdout: "ignore", stderr: "ignore" });
      const lockPath = join(home, "projects", "proj-crash", "live-holder-torn.lock");
      writeFileSync(lockPath, JSON.stringify({ pid: dummy.pid, startTimeMs: Date.now() }));

      const loaded = await store.load(key);
      expect(loaded).toEqual([e1]); // complete lines only — same value repair would have produced

      const quarantinePath = `${jsonlPath}.tail-quarantine`;
      expect(existsSync(quarantinePath)).toBe(false); // NEVER created while the lease pid is alive
      expect(statSync(jsonlPath).size).toBe(tornSize); // the file itself is byte-for-byte untouched

      // idempotent: a second read while the lease is still live defers again, identically
      const loaded2 = await store.load(key);
      expect(loaded2).toEqual([e1]);
      expect(existsSync(quarantinePath)).toBe(false);
      expect(statSync(jsonlPath).size).toBe(tornSize);
    } finally {
      await reap(dummy);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the SAME torn tail with a DEAD pid in the lease still gets repaired exactly as before", async () => {
    const home = freshHome();
    let child: Subprocess | undefined;
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-crash", sessionId: "dead-holder-torn" };
      const e1 = entry();
      const e2 = entry();
      await store.append(key, [e1, e2]);

      const jsonlPath = join(home, "projects", "proj-crash", "dead-holder-torn.jsonl");
      const fullSize = statSync(jsonlPath).size;
      truncateSync(jsonlPath, fullSize - 5);

      // A short-lived child that exits ON ITS OWN (never killed) — its pid becomes CLEANLY gone,
      // matching P1's pid-gone-only detection rule (same technique as the "stale-steal" test above).
      child = Bun.spawn([process.execPath, "-e", "1"], { stdout: "ignore", stderr: "ignore" });
      const exitCode = await child.exited;
      expect(exitCode).toBe(0);

      const lockPath = join(home, "projects", "proj-crash", "dead-holder-torn.lock");
      writeFileSync(lockPath, JSON.stringify({ pid: child.pid, startTimeMs: Date.now() }));

      const loaded = await store.load(key);
      expect(loaded).toEqual([e1]);

      const quarantinePath = `${jsonlPath}.tail-quarantine`;
      expect(existsSync(quarantinePath)).toBe(true); // repair fires normally — the holder is genuinely dead
      expect(statSync(quarantinePath).size).toBeGreaterThan(0);
      expect(statSync(jsonlPath).size).toBeLessThan(fullSize); // truncated down to the complete-lines boundary
      const quarantineSize1 = statSync(quarantinePath).size;

      // idempotent on a second read, same as the pre-existing torn-tail suite — no re-detection,
      // no quarantine growth
      const loaded2 = await store.load(key);
      expect(loaded2).toEqual([e1]);
      expect(statSync(quarantinePath).size).toBe(quarantineSize1);
    } finally {
      await reap(child);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("same-pid re-entry (T7): a torn tail whose lease is held by THIS process is repaired normally — a process never defers to its own in-flight lease", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-crash", sessionId: "self-holder-torn" };
      const e1 = entry();
      const e2 = entry();
      await store.append(key, [e1, e2]); // lease is this test process's own pid — never "foreign"

      const jsonlPath = join(home, "projects", "proj-crash", "self-holder-torn.jsonl");
      const fullSize = statSync(jsonlPath).size;
      truncateSync(jsonlPath, fullSize - 5);

      const loaded = await store.load(key);
      expect(loaded).toEqual([e1]);
      expect(existsSync(`${jsonlPath}.tail-quarantine`)).toBe(true); // repairs exactly as pre-P1-S
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
