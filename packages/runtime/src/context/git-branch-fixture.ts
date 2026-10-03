// TEST-ONLY: builds small hermetic git repositories in a chosen BRANCH SHAPE -- which branch is checked
// out (or a detached / unborn HEAD), which `refs/remotes/origin/*` refs exist, and where
// `refs/remotes/origin/HEAD` points -- for the gitStatus branch-line tests and their recorded corpus.
// No remote, network or working-tree content is involved: every ref points at one commit of the empty
// tree, written with `commit-tree`, so the working tree is always clean. Git runs with the machine's
// config, hooks and identity neutralised (see git-fixture.ts).
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hermeticGit } from "./git-fixture.ts";

export interface BranchShape {
  /** `{ branch: name }` checks that (born) branch out; `"detached"` detaches HEAD at the commit; `"unborn"` leaves `trunk` with no commit. */
  checkout: { branch: string } | "detached" | "unborn";
  /** Branch names that exist under `refs/remotes/origin/`. */
  originBranches: string[];
  /** Where `refs/remotes/origin/HEAD` points: absent = not set; otherwise the FULL ref it targets (it need not exist). */
  originHead?: string;
}

export interface BranchRepo {
  dir: string;
  /** The environment to run `computeGitStatus` with (machine config neutralised). */
  env: Record<string, string | undefined>;
}

/** Creates a repository in the given shape under `parent` (a fresh mkdtemp root when omitted). */
export function makeBranchRepo(shape: BranchShape, parent?: string): BranchRepo {
  const root = parent ?? mkdtempSync(join(tmpdir(), "winter-ctx-branch-"));
  const dir = mkdtempSync(join(root, "repo-"));
  const home = join(root, "fixture-home");
  const hooks = join(root, "empty-hooks");
  mkdirSync(home, { recursive: true });
  mkdirSync(hooks, { recursive: true });
  const git = (args: string[]): string => hermeticGit(dir, args, home, hooks);
  git(["init", "-q", "--initial-branch=trunk"]);
  const tree = git(["mktree"]);
  const commit = git(["commit-tree", tree, "-m", "seed"]);
  for (const name of shape.originBranches) git(["update-ref", `refs/remotes/origin/${name}`, commit]);
  if (shape.originHead !== undefined) git(["symbolic-ref", "refs/remotes/origin/HEAD", shape.originHead]);
  if (shape.checkout === "detached") git(["update-ref", "--no-deref", "HEAD", commit]);
  else if (shape.checkout !== "unborn") {
    git(["update-ref", `refs/heads/${shape.checkout.branch}`, commit]);
    git(["symbolic-ref", "HEAD", `refs/heads/${shape.checkout.branch}`]);
  }
  return { dir, env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" } };
}

/** The two branch lines of a gitStatus value (`Current branch: ...`, `Main branch ...: ...`). */
export function branchLines(status: string | undefined): { current: string | null; main: string | null } {
  if (status === undefined) return { current: null, main: null };
  const parts = status.split("\n\n");
  const current = parts.find((p) => p.startsWith("Current branch: ")) ?? null;
  const main = parts.find((p) => p.startsWith("Main branch (you will usually use this for PRs): ")) ?? null;
  return { current, main };
}
