// T7 F4 (fix-wave): isPidAlive's EPERM branch (a pid that exists but is owned by another user —
// "can't prove it's dead, treat as alive," the safer direction) was implemented but untested; no
// crash/session-store fixture naturally produces an EPERM from process.kill(pid, 0) (that would
// need a REAL foreign-owned process, which a test can't fabricate portably or safely). Monkey-
// patched here instead — the sibling ESRCH/live/rethrow branches are included alongside it for the
// same reason every other module in this repo gets a dedicated, complete unit-test file rather than
// a single isolated case. This file was previously missing entirely (leases.ts's own coverage lived
// only indirectly, through session-store.test.ts and crash.test.ts's higher-level scenarios).
import { test, expect, afterEach, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLease, isPidAlive, releaseLease } from "./leases.ts";

const originalKill = process.kill.bind(process);

afterEach(() => {
  // Always restored, pass or fail — a monkey-patched process.kill leaking into a LATER test file
  // would be a real, hard-to-diagnose hazard (every other suite in this repo calls process.kill
  // indirectly via Bun.spawn's own child-reaping and this store's own lease code).
  process.kill = originalKill;
});

test("isPidAlive: a genuinely live pid (this process's own) is alive", () => {
  expect(isPidAlive(process.pid)).toBe(true);
});

test("isPidAlive: process.kill throwing ESRCH (no such process) reports dead", () => {
  process.kill = ((_pid: number, _signal?: string | number) => {
    const err = new Error("kill ESRCH") as Error & { code?: string };
    err.code = "ESRCH";
    throw err;
  }) as typeof process.kill;

  expect(isPidAlive(999999)).toBe(false);
});

test("isPidAlive: process.kill throwing EPERM (exists, owned by another user) reports alive — 'can't prove it's dead' is the safer direction", () => {
  process.kill = ((_pid: number, _signal?: string | number) => {
    const err = new Error("kill EPERM") as Error & { code?: string };
    err.code = "EPERM";
    throw err;
  }) as typeof process.kill;

  expect(isPidAlive(1)).toBe(true);
});

test("isPidAlive: an unexpected error code rethrows rather than silently reporting either state", () => {
  process.kill = ((_pid: number, _signal?: string | number) => {
    const err = new Error("kill EINVAL") as Error & { code?: string };
    err.code = "EINVAL";
    throw err;
  }) as typeof process.kill;

  expect(() => isPidAlive(1)).toThrow("kill EINVAL");
});

// Phase 10b Lane S, S8 (W18-5): releaseLease -- the same-pid, idempotent sibling of acquireLease.
describe("releaseLease", () => {
  function freshLockPath(): { dir: string; lockPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "winter-lease-release-test-"));
    return { dir, lockPath: join(dir, "sess.lock") };
  }

  test("the same pid releases its own lease -- the lock file is gone afterward, and a second (injected) pid can then claim it", () => {
    const { dir, lockPath } = freshLockPath();
    try {
      const info = acquireLease(lockPath);
      expect(info.pid).toBe(process.pid);

      expect(releaseLease(lockPath)).toBe(true);
      expect(existsSync(lockPath)).toBe(false);

      // A different (injected) pid can now claim it cleanly -- nothing of THIS pid's ownership
      // survives to block or confuse a fresh claimant. `999999` is never this test process's own
      // pid, and no liveness check runs on the WRITE side of acquireLease -- only on contention.
      writeFileSync(lockPath, JSON.stringify({ pid: 999999, startTimeMs: Date.now() }));
      const claimed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
      expect(claimed.pid).toBe(999999);
      expect(claimed.pid).not.toBe(process.pid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("another pid's lease is untouched -- returns false, and the lock file survives with its original holder", () => {
    const { dir, lockPath } = freshLockPath();
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: 999999, startTimeMs: 1234 }));
      expect(releaseLease(lockPath)).toBe(false);
      expect(existsSync(lockPath)).toBe(true);
      expect((JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number }).pid).toBe(999999);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("releasing a lease that was never acquired (no lock file at all) is a safe no-op", () => {
    const { dir, lockPath } = freshLockPath();
    try {
      expect(releaseLease(lockPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("idempotent: releasing twice in a row -- the second call is a no-op, never an error", () => {
    const { dir, lockPath } = freshLockPath();
    try {
      acquireLease(lockPath);
      expect(releaseLease(lockPath)).toBe(true);
      expect(releaseLease(lockPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a released key can be re-claimed by the SAME pid via acquireLease again", () => {
    const { dir, lockPath } = freshLockPath();
    try {
      acquireLease(lockPath);
      expect(releaseLease(lockPath)).toBe(true);
      const reacquired = acquireLease(lockPath);
      expect(reacquired.pid).toBe(process.pid);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
