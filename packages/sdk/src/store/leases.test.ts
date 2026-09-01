// T7 F4 (fix-wave): isPidAlive's EPERM branch (a pid that exists but is owned by another user —
// "can't prove it's dead, treat as alive," the safer direction) was implemented but untested; no
// crash/session-store fixture naturally produces an EPERM from process.kill(pid, 0) (that would
// need a REAL foreign-owned process, which a test can't fabricate portably or safely). Monkey-
// patched here instead — the sibling ESRCH/live/rethrow branches are included alongside it for the
// same reason every other module in this repo gets a dedicated, complete unit-test file rather than
// a single isolated case. This file was previously missing entirely (leases.ts's own coverage lived
// only indirectly, through session-store.test.ts and crash.test.ts's higher-level scenarios).
import { test, expect, afterEach } from "bun:test";
import { isPidAlive } from "./leases.ts";

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
