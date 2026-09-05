// Phase 5 Lane C (task 6) -- TEST-ONLY: a hermetic real-git fixture.
//
// WHY IT EXISTS. Two of this lane's rules are only meaningfully provable against real git: the
// memory key is derived from `--git-common-dir` so that LINKED WORKTREES share the main
// repository's memory (WS-11 §3), and the WINTER.md parent-walk is bounded by `--show-toplevel`,
// which for a linked worktree is a DIFFERENT directory than the common root. A hand-built `.git`
// file or a mocked spawn would prove neither -- the whole point is that git's own answers to those
// two questions diverge for a worktree, and only git decides that.
//
// WHY THE `-c` FLAGS AND THE SCRUBBED ENV. `git worktree add` needs a commit, and a commit runs
// hooks and reads identity from the user's global config. This machine carries GLOBAL commit/push
// hooks (an identity guard), so an un-isolated fixture commit would execute them -- a test reaching
// outside its own temp directory, which this repo's hard rules forbid. Every knob is therefore
// pinned inline: an empty hooksPath, a fixture identity that is not a real person, no signing, and
// GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM pointed at /dev/null so nothing on the machine is consulted.
// HOME is redirected too, since git falls back to `$HOME/.gitconfig` when GIT_CONFIG_GLOBAL is
// absent on older versions.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitFixture {
  /** The main checkout's working-tree root. */
  main: string;
  /** A linked worktree of the same repository (`git worktree add`), at a path OUTSIDE `main`. */
  worktree: string;
  /** The mkdtemp root holding both -- remove this to clean up. */
  root: string;
}

/** Runs git with every machine-level influence (hooks, identity, signing, config files) neutralised. */
export function hermeticGit(cwd: string, args: string[], home: string, hooksPath: string): string {
  return execFileSync(
    "git",
    ["-c", `core.hooksPath=${hooksPath}`, "-c", "user.name=winter fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    },
  ).trim();
}

/**
 * A real repository with one commit plus a real linked worktree, both under one mkdtemp root.
 *
 * The worktree is placed as a SIBLING of the main checkout, not beneath it: a worktree nested
 * inside the main tree would make the common root an ancestor of the worktree by accident, and the
 * WINTER.md boundary test would pass for the wrong reason.
 */
export function makeGitFixture(): GitFixture {
  const root = mkdtempSync(join(tmpdir(), "winter-ctx-git-"));
  const home = join(root, "fixture-home");
  const hooksPath = join(root, "empty-hooks");
  const main = join(root, "main");
  mkdirSync(home, { recursive: true });
  mkdirSync(hooksPath, { recursive: true });
  mkdirSync(main, { recursive: true });
  hermeticGit(main, ["init", "--initial-branch=trunk"], home, hooksPath);
  writeFileSync(join(main, "seed.txt"), "seed\n", "utf8");
  hermeticGit(main, ["add", "seed.txt"], home, hooksPath);
  hermeticGit(main, ["commit", "-m", "seed"], home, hooksPath);
  const worktree = join(root, "linked");
  hermeticGit(main, ["worktree", "add", "-b", "linked", worktree], home, hooksPath);
  return { main, worktree, root };
}
