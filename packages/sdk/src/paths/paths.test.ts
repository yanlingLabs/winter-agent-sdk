import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, lstatSync, statSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

import { resolveWinterHome } from "./home.ts";
import { transcriptProjectKey } from "./project-key.ts";
import { compatibilityKeys } from "./keys.ts";
import { sessionTempDir, ensureTasksDir, assertOwnedDir, resolveTempBase, WinterPathsError } from "./temp.ts";

// Every home/cwd/temp base in this file is a fresh mkdtemp under the OS temp dir — never
// ~/.winter, ~/.norma, ~/.claude, or the real shared /tmp/winter-<uid> chain.

describe("resolveWinterHome", () => {
  test("defaults to ~/.winter when WINTER_HOME is unset", () => {
    expect(resolveWinterHome({}).endsWith("/.winter")).toBe(true);
  });

  test("uses WINTER_HOME when set to a non-blank value", () => {
    expect(resolveWinterHome({ WINTER_HOME: "/custom/winter/home" })).toBe("/custom/winter/home");
  });

  test("treats an empty-string WINTER_HOME as unset", () => {
    expect(resolveWinterHome({ WINTER_HOME: "" }).endsWith("/.winter")).toBe(true);
  });

  test("treats a whitespace-only WINTER_HOME as unset", () => {
    expect(resolveWinterHome({ WINTER_HOME: "   " }).endsWith("/.winter")).toBe(true);
  });

  test("an explicit undefined value in the env map is treated as unset", () => {
    expect(resolveWinterHome({ WINTER_HOME: undefined }).endsWith("/.winter")).toBe(true);
  });
});

describe("transcriptProjectKey — exact CC project-key algorithm", () => {
  test("WS-05 §3.1 worked example shape (slashes -> dashes, space -> dash, case preserved)", () => {
    // Same shape as the spec's own worked example, with a placeholder username in place of a
    // real one (this repo is public — no personal identity strings in committed fixtures).
    expect(transcriptProjectKey("/Users/alice/Games/pvp/ninja game")).toBe("-Users-alice-Games-pvp-ninja-game");
  });

  test("root path sanitizes to a single dash", () => {
    expect(transcriptProjectKey("/")).toBe("-");
  });

  test("spaces become individual dashes", () => {
    expect(transcriptProjectKey("/a/b c/d")).toBe("-a-b-c-d");
  });

  test("punctuation runs are NOT collapsed — one dash per character", () => {
    expect(transcriptProjectKey("/a!!!b")).toBe("-a---b");
  });

  test("Unicode sanitizes per UTF-16 code unit — a precomposed accent is one dash, an astral emoji (surrogate pair) is two", () => {
    // "/a/café/😀b": "é" (U+00E9, 1 code unit) -> one dash; "/" -> one dash; "😀" (a surrogate
    // PAIR, 2 code units) -> two dashes — four dashes in a row from those three characters.
    expect(transcriptProjectKey("/a/café/😀b")).toBe("-a-caf----b");
  });

  test("exactly 200 sanitized chars: returned unchanged, no hash suffix", () => {
    const input = "a".repeat(200);
    expect(transcriptProjectKey(input)).toBe(input);
  });

  test("201 sanitized chars: 200-char prefix + dash + base-36 hash of the ORIGINAL string", () => {
    const input = "a".repeat(201);
    const result = transcriptProjectKey(input);
    expect(result).toBe("a".repeat(200) + "-rkvsv5");
    expect(result.length).toBe(207);
  });

  test("a >200-char path-shaped string (slashes + words) caps at 200 chars + hash suffix", () => {
    // Path-shaped (not all-alnum) so this fixture can only pass if the hash is computed over the
    // ORIGINAL pre-sanitize string, not the sanitized/truncated one — the exact detail the
    // ephemeral inspection recovered (task-6-report.md).
    const longRaw = "/Users/alice/code/" + Array.from({ length: 20 }, (_, i) => `segment-${i}-of-a-very-long-nested-project-path`).join("/");
    expect(longRaw.length).toBe(927);
    const expected =
      "-Users-alice-code-segment-0-of-a-very-long-nested-project-path-segment-1-of-a-very-long-nested-project-path-segment-2-of-a-very-long-nested-project-path-segment-3-of-a-very-long-nested-project-path-se-nxhjqo";
    expect(transcriptProjectKey(longRaw)).toBe(expected);
    expect(expected.length).toBe(207);
  });
});

describe("compatibilityKeys", () => {
  test("a plain non-git directory: all three keys match and equal transcriptProjectKey(realpath(dir))", () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-paths-test-"));
    try {
      const keys = compatibilityKeys(dir);
      const expected = transcriptProjectKey(realpathSync(dir));
      expect(keys.transcriptProjectKey).toBe(expected);
      expect(keys.tempProjectKey).toBe(expected);
      expect(keys.memoryProjectKey).toBe(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // darwin-only by nature: the fixture's premise IS macOS's /tmp -> /private/tmp symlink. On linux
  // /private/tmp does not exist, realpath cannot unify the two spellings, and the equality below is
  // legitimately false — first real ubuntu CI run (33529015303) proved it (controller Ruling P1-P).
  // Follow-up (phase fix-wave): a platform-neutral variant that PLANTS a symlinked dir under mkdtemp
  // and asserts both spellings key identically would test the same realpath-normalization intent everywhere.
  test.skipIf(process.platform !== "darwin")("/tmp vs /private/tmp resolve to the identical key (macOS realpath symlink)", () => {
    const dir = mkdtempSync("/tmp/winter-paths-test-");
    try {
      const viaTmp = compatibilityKeys(dir);
      const viaPrivate = compatibilityKeys(dir.replace(/^\/tmp\//, "/private/tmp/"));
      expect(viaPrivate.transcriptProjectKey).toBe(viaTmp.transcriptProjectKey);
      expect(viaPrivate.tempProjectKey).toBe(viaTmp.tempProjectKey);
      expect(viaPrivate.memoryProjectKey).toBe(viaTmp.memoryProjectKey);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("worktree: memory key follows the main repo root; transcript/temp keys follow the worktree cwd (WS-05 §3.2)", () => {
    const base = mkdtempSync(join(tmpdir(), "winter-paths-git-"));
    try {
      const mainRepo = join(base, "main");
      mkdirSync(mainRepo, { recursive: true });
      const git = (args: string[], cwd = mainRepo): string => execFileSync("git", args, { cwd, encoding: "utf8" });
      git(["init", "-q", "-b", "main"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "Test"]);
      writeFileSync(join(mainRepo, "f.txt"), "hi");
      git(["add", "f.txt"]);
      git(["commit", "-q", "-m", "init"]);

      const worktreeDir = join(base, "wt1");
      git(["worktree", "add", "-q", "-b", "feature", worktreeDir]);

      const fromMainRoot = compatibilityKeys(mainRepo);
      const fromWorktree = compatibilityKeys(worktreeDir);

      expect(fromWorktree.memoryProjectKey).toBe(fromMainRoot.transcriptProjectKey);
      expect(fromWorktree.transcriptProjectKey).not.toBe(fromWorktree.memoryProjectKey);
      expect(fromWorktree.transcriptProjectKey).toBe(transcriptProjectKey(realpathSync(worktreeDir)));
      expect(fromWorktree.tempProjectKey).toBe(fromWorktree.transcriptProjectKey);

      // "git common root", not "worktree-only": a plain subdirectory of the MAIN repo (no
      // worktree involved at all) also scopes memory to the repo root.
      const subDir = join(mainRepo, "sub", "deeper");
      mkdirSync(subDir, { recursive: true });
      const fromSubdir = compatibilityKeys(subDir);
      expect(fromSubdir.memoryProjectKey).toBe(fromMainRoot.transcriptProjectKey);
      expect(fromSubdir.transcriptProjectKey).toBe(transcriptProjectKey(realpathSync(subDir)));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

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
