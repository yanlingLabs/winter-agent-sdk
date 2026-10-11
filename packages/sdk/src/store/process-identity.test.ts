import { afterEach, expect, test, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLease, releaseLease, isLeaseHolderAlive, isLeaseOwnedByCurrentProcess } from "./leases.ts";
import { parseLinuxProcessIdentity, type LeaseProcessIdentity } from "./process-identity.ts";

const boot = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const oldBoot = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const current = { bootId: boot, startTicks: "9007199254740993" };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function path() { const dir = mkdtempSync(join(tmpdir(), "winter-guest-lease-")); dirs.push(dir); return join(dir, "session.lock"); }
const probe = () => current;

test("Linux stat parser handles parenthesis/spaces in comm and preserves 64-bit ticks", () => {
  const fields = ["S", ...Array.from({ length: 18 }, () => "0"), current.startTicks];
  expect(parseLinuxProcessIdentity(`${boot.toUpperCase()}\n`, `42 (worker (name) spaced) ${fields.join(" ")}`)).toEqual(current);
  expect(parseLinuxProcessIdentity("not-a-boot", "42 (name) S")).toBeNull();
  expect(parseLinuxProcessIdentity(boot, "42 (name) S")).toBeNull();
});
test("previous boot needs explicit host termination evidence; current identity is reentrant", () => {
  const lock = path(); writeFileSync(lock, JSON.stringify({ pid: process.pid, startTimeMs: 1, processIdentity: { ...current, bootId: oldBoot } }));
  expect(releaseLease(lock, { identityProbe: probe })).toBe(false);
  expect(() => acquireLease(lock, { identityProbe: probe })).toThrow("live process");
  const acquired = acquireLease(lock, { identityProbe: probe, confirmPreviousBootTerminated: () => true });
  expect(acquired.processIdentity).toEqual(current);
  expect(acquireLease(lock, { identityProbe: probe })).toEqual(acquired);
  expect(releaseLease(lock, { identityProbe: probe })).toBe(true);
});
test("reused PID in same guest boot with different start ticks is stale", () => {
  const lock = path(); writeFileSync(lock, JSON.stringify({ pid: process.pid, startTimeMs: 1, processIdentity: { ...current, startTicks: "1" } }));
  expect(acquireLease(lock, { identityProbe: probe }).processIdentity).toEqual(current);
});
test("legacy live PID and unreadable identity never silently become own lease", () => {
  const lock = path(); writeFileSync(lock, JSON.stringify({ pid: process.pid, startTimeMs: 1 }));
  expect(() => acquireLease(lock, { identityProbe: probe })).toThrow("live process");
  expect(releaseLease(lock, { identityProbe: probe })).toBe(false);
  const saved = { pid: process.pid, startTimeMs: 1, processIdentity: current };
  expect(isLeaseHolderAlive(saved, { identityProbe: () => null })).toBe(true);
  expect(() => acquireLease(lock, { identityProbe: () => null })).toThrow("cannot establish");
});
test("corrupt identity requires recovery and leaves evidence unchanged", () => {
  const lock = path(); const bytes = JSON.stringify({ pid: process.pid, startTimeMs: 1, processIdentity: { bootId: "invalid", startTicks: "1" } });
  writeFileSync(lock, bytes);
  expect(() => acquireLease(lock, { identityProbe: probe })).toThrow("recovery");
  expect(readFileSync(lock, "utf8")).toBe(bytes);
});
test("new writer identity is stamped before exposing the lease", () => {
  const lock = path(); expect(existsSync(lock)).toBe(false);
  acquireLease(lock, { identityProbe: (_pid): LeaseProcessIdentity => current });
  expect(JSON.parse(readFileSync(lock, "utf8")).processIdentity).toEqual(current);
});
test("null, zero and numeric ticks cannot be coerced into trusted process identity", () => {
  for (const processIdentity of [null, 0, { bootId: boot, startTicks: 1 }]) {
    const lock = path(); const bytes = JSON.stringify({ pid: process.pid, startTimeMs: 1, processIdentity }); writeFileSync(lock, bytes);
    expect(() => acquireLease(lock, { identityProbe: probe })).toThrow("recovery");
    expect(readFileSync(lock, "utf8")).toBe(bytes);
  }
});

test("foreign-kernel lease is alive even with no PID in the local namespace", () => {
  const lease = { pid: 2147483647, startTimeMs: 1, processIdentity: { ...current, bootId: oldBoot } };
  expect(isLeaseHolderAlive(lease, { identityProbe: pid => pid === process.pid ? current : null })).toBe(true);
  expect(isLeaseHolderAlive(lease, { identityProbe: pid => pid === process.pid ? current : null, confirmPreviousBootTerminated: () => false })).toBe(true);
  expect(isLeaseHolderAlive(lease, { identityProbe: pid => pid === process.pid ? current : null, confirmPreviousBootTerminated: () => true })).toBe(false);
});
test.skipIf(process.platform === "linux")("a host without a Linux identity probe cannot claim or steal a Linux lease", () => {
  expect(isLeaseOwnedByCurrentProcess({ pid: process.pid, startTimeMs: 1, processIdentity: current })).toBe(false);
  expect(isLeaseHolderAlive({ pid: 2147483647, startTimeMs: 1, processIdentity: current })).toBe(true);
});

test("normal holder release between EEXIST and lease read is retried atomically", () => {
  const lock = path();
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startTimeMs: 1, processIdentity: current }));
  const originalRead = fs.readFileSync;
  let released = false;
  const read = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === lock && !released) { released = true; unlinkSync(lock); }
    return originalRead(...args);
  }) as typeof fs.readFileSync);
  try {
    const acquired = acquireLease(lock, { identityProbe: probe });
    expect(released).toBe(true);
    expect(acquired.processIdentity).toEqual(current);
    expect(JSON.parse(originalRead(lock, "utf8")).pid).toBe(process.pid);
  } finally { read.mockRestore(); }
});
