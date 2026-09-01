// Task 10 move: extracted from the old combined paths.test.ts (which also covered home.ts/
// project-key.ts/keys.ts) when those three moved to packages/sdk/src/paths -- temp.ts stays
// runtime-private (Ruling P1-C: Bun-only/macOS-first temp-dir resolution is not part of the
// published sdk's store/paths surface), so its coverage stays alongside it here, unchanged.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, lstatSync, statSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { sessionTempDir, ensureTasksDir, assertOwnedDir, resolveTempBase, WinterPathsError } from "./temp.ts";

// Every temp base in this file is a fresh mkdtemp under the OS temp dir — never ~/.winter,
// ~/.norma, ~/.claude, or the real shared /tmp/winter-<uid> chain.

describe("sessionTempDir (D18)", () => {
  function freshBase(): string {
    return mkdtempSync(join(tmpdir(), "winter-paths-temp-"));
  }

  test("resolveTempBase: WINTER_TMPDIR unset/blank defaults to '/tmp'; a non-blank override wins (pure decision, no mkdir)", () => {
    expect(resolveTempBase(undefined)).toBe("/tmp");
    expect(resolveTempBase({})).toBe("/tmp");
    expect(resolveTempBase({ WINTER_TMPDIR: "" })).toBe("/tmp");
    expect(resolveTempBase({ WINTER_TMPDIR: "   " })).toBe("/tmp");
    expect(resolveTempBase({ WINTER_TMPDIR: "/custom/base" })).toBe("/custom/base");
  });

  test("creates root + scratchpad eagerly (real 0700 dirs); tasks/ is computed but not created until ensureTasksDir()", () => {
    const base = freshBase();
    try {
      const dirs = sessionTempDir({ tempProjectKey: "proj-a", backendUuid: "11111111-1111-4111-8111-111111111111", env: { WINTER_TMPDIR: base } });

      expect(statSync(dirs.root).isDirectory()).toBe(true);
      expect(statSync(dirs.root).mode & 0o777).toBe(0o700);
      expect(statSync(dirs.scratchpad).isDirectory()).toBe(true);
      expect(statSync(dirs.scratchpad).mode & 0o777).toBe(0o700);
      expect(() => lstatSync(dirs.tasks)).toThrow();

      const tasksDir = ensureTasksDir(dirs);
      expect(tasksDir).toBe(dirs.tasks);
      expect(statSync(dirs.tasks).isDirectory()).toBe(true);
      expect(statSync(dirs.tasks).mode & 0o777).toBe(0o700);

      // idempotent
      expect(ensureTasksDir(dirs)).toBe(dirs.tasks);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("the real uid appears exactly twice, adjacently, in the path chain — never a literal constant", () => {
    const base = freshBase();
    try {
      const uid = process.getuid!();
      const marker = `winter-${uid}`;
      const dirs = sessionTempDir({ tempProjectKey: "proj-b", backendUuid: "22222222-2222-4222-8222-222222222222", env: { WINTER_TMPDIR: base } });

      expect(dirs.root.split(marker).length - 1).toBe(2);
      expect(dirs.root).toContain(join(marker, marker));
      expect(dirs.root).toBe(join(realpathSync(base), marker, marker, "proj-b", "22222222-2222-4222-8222-222222222222"));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("realpaths the base before composing the chain (symlinked base, e.g. macOS /tmp -> /private/tmp)", () => {
    const real = freshBase();
    const alias = join(tmpdir(), `winter-paths-alias-${process.pid}-${Date.now()}`);
    symlinkSync(real, alias);
    try {
      const dirs = sessionTempDir({ tempProjectKey: "proj-c", backendUuid: "33333333-3333-4333-8333-333333333333", env: { WINTER_TMPDIR: alias } });
      const realBase = realpathSync(real);
      expect(dirs.root.startsWith(realBase + "/")).toBe(true);
      expect(dirs.root).not.toContain(alias);
    } finally {
      rmSync(real, { recursive: true, force: true });
      rmSync(alias, { force: true });
    }
  });

  test("refuses a symlink planted at a level it must create", () => {
    const base = freshBase();
    const decoyTarget = freshBase();
    try {
      const established = sessionTempDir({
        tempProjectKey: "proj-d",
        backendUuid: "44444444-4444-4444-8444-444444444444",
        env: { WINTER_TMPDIR: base },
      });
      const projectDir = dirname(established.root); // .../winter-<uid>/winter-<uid>/proj-d
      const evilSessionPath = join(projectDir, "55555555-5555-4555-8555-555555555555");
      symlinkSync(decoyTarget, evilSessionPath);

      expect(() =>
        sessionTempDir({ tempProjectKey: "proj-d", backendUuid: "55555555-5555-4555-8555-555555555555", env: { WINTER_TMPDIR: base } }),
      ).toThrow(WinterPathsError);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(decoyTarget, { recursive: true, force: true });
    }
  });

  test("refuses a pre-existing regular file where a directory level is expected", () => {
    const base = freshBase();
    try {
      const established = sessionTempDir({
        tempProjectKey: "proj-e",
        backendUuid: "66666666-6666-4666-8666-666666666666",
        env: { WINTER_TMPDIR: base },
      });
      const projectDir = dirname(established.root);
      const collidingPath = join(projectDir, "77777777-7777-4777-8777-777777777777");
      writeFileSync(collidingPath, "not a directory");

      expect(() =>
        sessionTempDir({ tempProjectKey: "proj-e", backendUuid: "77777777-7777-4777-8777-777777777777", env: { WINTER_TMPDIR: base } }),
      ).toThrow(WinterPathsError);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("rejects an empty or path-hostile tempProjectKey/backendUuid before touching disk", () => {
    const base = freshBase();
    try {
      expect(() => sessionTempDir({ tempProjectKey: "", backendUuid: "u", env: { WINTER_TMPDIR: base } })).toThrow(WinterPathsError);
      expect(() => sessionTempDir({ tempProjectKey: "../escape", backendUuid: "u", env: { WINTER_TMPDIR: base } })).toThrow(WinterPathsError);
      expect(() => sessionTempDir({ tempProjectKey: "ok", backendUuid: "", env: { WINTER_TMPDIR: base } })).toThrow(WinterPathsError);
      expect(() => sessionTempDir({ tempProjectKey: "ok", backendUuid: "a/b", env: { WINTER_TMPDIR: base } })).toThrow(WinterPathsError);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("assertOwnedDir — foreign-owner branch, unit-tested without root", () => {
  test("throws when the stat's uid does not match the real process uid", () => {
    const fakeStat = { uid: process.getuid!() + 1, isDirectory: () => true, isSymbolicLink: () => false };
    expect(() => assertOwnedDir(fakeStat, "/fake/path")).toThrow(WinterPathsError);
  });

  test("throws on a symlink even if isDirectory reports true", () => {
    const fakeStat = { uid: process.getuid!(), isDirectory: () => true, isSymbolicLink: () => true };
    expect(() => assertOwnedDir(fakeStat, "/fake/path")).toThrow(WinterPathsError);
  });

  test("throws on a non-directory", () => {
    const fakeStat = { uid: process.getuid!(), isDirectory: () => false, isSymbolicLink: () => false };
    expect(() => assertOwnedDir(fakeStat, "/fake/path")).toThrow(WinterPathsError);
  });

  test("passes for a real, owned, plain directory", () => {
    const fakeStat = { uid: process.getuid!(), isDirectory: () => true, isSymbolicLink: () => false };
    expect(() => assertOwnedDir(fakeStat, "/fake/path")).not.toThrow();
  });
});
