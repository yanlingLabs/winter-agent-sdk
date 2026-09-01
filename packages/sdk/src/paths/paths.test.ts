// Task 10 move: this file originally also covered paths/temp.ts (sessionTempDir/ensureTasksDir/
// assertOwnedDir) — temp.ts stays runtime-private (Ruling P1-C: Bun-only/macOS-first temp-dir
// resolution is not part of the published sdk's store/paths surface), so those describe blocks
// moved to packages/runtime/src/paths/temp.test.ts instead of following this file's git-mv. Only
// the home.ts/project-key.ts/keys.ts coverage remains here, alongside the modules it tests.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { resolveWinterHome } from "./home.ts";
import { transcriptProjectKey } from "./project-key.ts";
import { compatibilityKeys } from "./keys.ts";

// Every home/cwd base in this file is a fresh mkdtemp under the OS temp dir — never
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

  // T6 fix-wave (low): every test above passes an explicit env object — the zero-arg branch
  // (`env ?? process.env`, home.ts:15) was never directly exercised. Flake-aware, same accepted
  // precedent as temp.test.ts's identical resolveTempBase(undefined) case (T6 review): this reads
  // the REAL process.env, so it assumes WINTER_HOME is unset in whatever environment runs this
  // suite — true for every CI runner and dev machine this repo's own tooling controls, but not a
  // guarantee this test itself can enforce.
  test("the zero-arg branch falls through to the real process.env (flake-aware — assumes WINTER_HOME is unset here, matching resolveTempBase's identical precedent)", () => {
    expect(resolveWinterHome().endsWith("/.winter")).toBe(true);
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

  // Fix-wave follow-up (Ruling P1-P note): a platform-neutral variant of the darwin-only test
  // above, using a SELF-MADE symlink rather than relying on macOS's system /tmp -> /private/tmp
  // one — resolveCanonical's realpathSync collapses a symlink to its real target on every POSIX
  // platform, not just darwin, so this exercises the identical realpath-normalization intent
  // everywhere, including the linux CI runner the original test could never touch.
  test("a self-made symlink to a real directory keys identically to the directory itself (platform-neutral realpath normalization)", () => {
    const parent = mkdtempSync(join(tmpdir(), "winter-paths-symlink-test-"));
    try {
      const realDir = join(parent, "real");
      mkdirSync(realDir);
      const linkPath = join(parent, "link");
      symlinkSync(realDir, linkPath, "dir");

      const viaReal = compatibilityKeys(realDir);
      const viaLink = compatibilityKeys(linkPath);
      expect(viaLink.transcriptProjectKey).toBe(viaReal.transcriptProjectKey);
      expect(viaLink.tempProjectKey).toBe(viaReal.tempProjectKey);
      expect(viaLink.memoryProjectKey).toBe(viaReal.memoryProjectKey);

      // sanity: the two input paths really were spelled differently — this isn't accidentally
      // testing "the same string against itself"
      expect(linkPath).not.toBe(realDir);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  // T6 fix-wave (low): keys.ts's platformNormalize (.normalize("NFC")) is darwin-only, mirroring
  // the pinned consumer's own platform gate — untested directly until now. Two halves, per the
  // review's own APFS-variance warning: a pure STRING-level check (no real directory backing
  // either spelling — exercises resolveCanonical's ENOENT fallback, which is deterministic on
  // every OS) runs unconditionally, branching its expectation on platform; a second, on-disk check
  // observes whatever THIS filesystem's realpathSync actually does (APFS unifies NFC/NFD spellings
  // of the same dirent; most Linux filesystems store/match raw bytes and do not) rather than
  // assuming one behavior.
  describe("NFC/NFD path normalization (darwin-only unification)", () => {
    // Explicit backslash-u escapes, never typed characters: the two are visually indistinguishable in an
    // editor/terminal/diff, so relying on literal bytes here would risk a future re-save silently
    // re-normalizing one to match the other and quietly defeating this whole test.
    const NFC_CHAR = "\u00e9"; // precomposed "e-acute" -- ONE UTF-16 code unit
    const NFD_CHAR = "e\u0301"; // "e" + combining acute accent -- decomposed, TWO code units

    test("pure string equivalence (no real directory): NFD and NFC spellings key identically on darwin only — never assumed on other platforms", () => {
      const base = "/winter-fixture-nfd-test";
      const nfcPath = `${base}/caf${NFC_CHAR}`;
      const nfdPath = `${base}/caf${NFD_CHAR}`;
      expect(nfcPath).not.toBe(nfdPath); // sanity: genuinely different byte sequences

      const nfcKey = compatibilityKeys(nfcPath).transcriptProjectKey;
      const nfdKey = compatibilityKeys(nfdPath).transcriptProjectKey;

      if (process.platform === "darwin") {
        expect(nfdKey).toBe(nfcKey);
      } else {
        // Not a bug on this platform — nothing normalizes the two spellings here, matching
        // keys.ts's own deliberately darwin-only platformNormalize gate.
        expect(nfdKey).not.toBe(nfcKey);
      }
    });

    test("on-disk: an NFD-named real directory keys consistently with whatever THIS filesystem's own realpath does to the NFC spelling — never a single assumed fs behavior", () => {
      const parent = mkdtempSync(join(tmpdir(), "winter-nfd-fs-test-"));
      try {
        const nfdDir = join(parent, `caf${NFD_CHAR}`);
        mkdirSync(nfdDir);
        const nfcDir = join(parent, `caf${NFC_CHAR}`);

        // Ground truth, straight from the filesystem (bypassing keys.ts entirely): does realpath
        // resolve the NFC spelling to the SAME dirent the NFD spelling created (APFS-style
        // Unicode-aware lookup), or does it not exist as a distinct path at all (byte-literal,
        // most-Linux-style)?
        let fsUnifiesSpellings: boolean;
        try {
          realpathSync(nfcDir);
          fsUnifiesSpellings = true;
        } catch {
          fsUnifiesSpellings = false;
        }

        const keyViaNfd = compatibilityKeys(nfdDir).transcriptProjectKey;
        const keyViaNfc = compatibilityKeys(nfcDir).transcriptProjectKey;

        if (fsUnifiesSpellings || process.platform === "darwin") {
          // Either the filesystem itself resolves both spellings to the same dirent, or (darwin)
          // keys.ts's own NFC normalization step unifies them regardless of what the fs did —
          // either way the two spellings must key identically.
          expect(keyViaNfc).toBe(keyViaNfd);
        } else {
          // Byte-literal fs, non-darwin: the NFC spelling genuinely does not resolve to this
          // dirent — resolveCanonical's ENOENT fallback returns it unresolved, so the two
          // spellings key DIFFERENTLY. Correct behavior on this platform, not a bug.
          expect(keyViaNfc).not.toBe(keyViaNfd);
        }
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    });
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
