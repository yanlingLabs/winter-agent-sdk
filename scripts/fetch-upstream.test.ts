import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyDigest, verifySha512Integrity, ChecksumMismatchError, resolveCacheDir } from "./fetch-upstream.ts";

test("verifyDigest passes on a matching sha256", () => {
  const bytes = new TextEncoder().encode("hello");
  // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
  expect(() => verifyDigest(bytes, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")).not.toThrow();
});
test("verifyDigest throws ChecksumMismatchError on mismatch", () => {
  const bytes = new TextEncoder().encode("hello");
  expect(() => verifyDigest(bytes, "0".repeat(64))).toThrow(ChecksumMismatchError);
});

// sha512 integrity check: a SECOND, independently-sourced hash (npm registry metadata's own
// dist.integrity, WS-02 §6.1 defense-in-depth) — a hand-computed sha256 of the same download can
// never catch a tampered checksums.json entry the way a registry-sourced sha512 can.
test("verifySha512Integrity passes on a matching sha512 SRI string", () => {
  const bytes = new TextEncoder().encode("hello");
  // sha512("hello") base64 = m3HSJL1i83hdltRq0+o9czGb+8KJDKra4t/3JRlnPKcjI8PZm6XBHXx6zG4UuMXaDEZjR1wuXDre9G9zvN7AQw==
  expect(() =>
    verifySha512Integrity(bytes, "sha512-m3HSJL1i83hdltRq0+o9czGb+8KJDKra4t/3JRlnPKcjI8PZm6XBHXx6zG4UuMXaDEZjR1wuXDre9G9zvN7AQw=="),
  ).not.toThrow();
});
test("verifySha512Integrity throws ChecksumMismatchError on mismatch", () => {
  const bytes = new TextEncoder().encode("hello");
  expect(() => verifySha512Integrity(bytes, "sha512-" + "A".repeat(88))).toThrow(ChecksumMismatchError);
});

// --- cacheDir guard (Task 11 / WS-02 §6.1): a caller-supplied cacheDir is never owned by the
// fetch, so it must never be deleted by a caller's cleanup keyed off `ownedDir` — only fresh
// mkdtemps the fetch itself created are. Exercised directly against resolveCacheDir (no network):
// fetchAndVerifyUpstream's own guard test would otherwise require stubbing global fetch against
// the module-level CHECKSUMS pin, which a hand-crafted response can never satisfy (verifyDigest
// would reject anything but the real upstream bytes) — and this repo's hard rule is no committed
// Anthropic artifact, so a fixture tarball to satisfy that check is not an option either.
test("resolveCacheDir: a caller-supplied cacheDir is reported as NOT owned, and survives an ownedDir-gated cleanup", () => {
  const custom = mkdtempSync(join(tmpdir(), "winter-fetch-upstream-guard-"));
  try {
    const { dir, ownedDir } = resolveCacheDir(custom);
    expect(dir).toBe(custom);
    expect(ownedDir).toBe(false);

    writeFileSync(join(dir, "marker.txt"), "still here");
    if (ownedDir) rmSync(dir, { recursive: true, force: true }); // mirrors gen-declaration-snapshot.ts's guard
    expect(existsSync(join(dir, "marker.txt"))).toBe(true); // survives — never owned, never deleted
  } finally {
    rmSync(custom, { recursive: true, force: true });
  }
});

test("resolveCacheDir: an omitted cacheDir is a fresh mkdtemp reported as OWNED, and an ownedDir-gated cleanup removes it", () => {
  const { dir, ownedDir } = resolveCacheDir();
  expect(ownedDir).toBe(true);
  expect(existsSync(dir)).toBe(true);
  writeFileSync(join(dir, "marker.txt"), "ephemeral");
  if (ownedDir) rmSync(dir, { recursive: true, force: true });
  expect(existsSync(dir)).toBe(false); // owned dir is gone
});

