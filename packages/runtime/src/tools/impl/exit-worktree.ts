// Task 7 (LANE E, WS-06 §3.3 "ExitWorktree"): `{action: "keep"|"remove"; discard_changes?: boolean}`.
// `remove` refuses on uncommitted files or unmerged commits unless `discard_changes: true` (checked
// via `git status --porcelain` / `git cherry -v`, per the brief); both actions restore the session's
// cwd to the repository's main worktree via `ctx.session.setCwd` -- never engine.ts directly (R3-5).
//
// NEEDS_CONTEXT (task-7 brief: "Unavailable to isolation-pinned subagents = descriptor predicate...
// note if the predicate is missing"): tools/descriptors/exit-worktree.ts's own header comment
// documents that "Unavailable to subagents with isolation-pinned cwd" (WS-06 §3.3) is deliberately
// NOT modeled as an AvailabilityPredicate at T1 and defers enforcement to this executor -- but
// ToolExecutionContext (registry.ts) carries NO field identifying "this call is running inside an
// isolation-pinned subagent" at all. This is narrower than (and therefore cannot reuse)
// AskUserQuestion's own `insideSubagent` AvailabilityPredicate field, which excludes EVERY subagent,
// not only ones whose cwd is pinned by Agent's own `isolation: "worktree"` input. There is therefore
// NO signal this executor can check today to enforce that WS-06 §3.3 sentence at all -- see
// task-7-report.md's Concerns for the full NEEDS_CONTEXT writeup (a later phase needs either a
// narrower AvailabilityPredicate field or a new ToolExecutionContext field before this can be
// enforced anywhere).
import { sep } from "node:path";
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import "../descriptors/exit-worktree.ts"; // self-sufficiency: guarantees the "ExitWorktree" stub is registered before replaceExecutor runs below.
import { listWorktrees, runGit, safeRealpath, type WorktreeInfo } from "./enter-worktree.ts";

export const EXIT_WORKTREE_TOOL_NAME = "ExitWorktree";

function hasUncommittedChanges(statusPorcelainOutput: string): boolean {
  return statusPorcelainOutput.trim().length > 0;
}

// M5 (fix wave, P3 close-out): the session's cwd need not sit AT a worktree's own realPath -- an
// allowed `Bash: cd src` (a subdirectory is within bounded roots the moment EnterWorktree adds the
// worktree itself) leaves `ctx.cwd` somewhere UNDER the worktree, not equal to it, and the previous
// exact-equality match then reported "the session's cwd is not a worktree of this repository" for a
// session that plainly still was. Matches "cwd is AT OR UNDER a worktree's realPath," and among
// multiple candidates (a worktree nested inside another's directory tree -- unusual, but not
// prevented by anything upstream) picks the LONGEST matching realPath, i.e. the most specific
// (deepest) worktree actually containing cwd, never an ancestor.
function findWorktreeContainingCwd(worktrees: readonly WorktreeInfo[], cwdRealPath: string): WorktreeInfo | undefined {
  const candidates = worktrees.filter((w) => cwdRealPath === w.realPath || cwdRealPath.startsWith(w.realPath + sep));
  if (candidates.length === 0) return undefined;
  return candidates.reduce((longest, w) => (w.realPath.length > longest.realPath.length ? w : longest));
}

// "Unmerged commits": commits reachable from the worktree's own HEAD that are not yet reflected on
// the main worktree's branch/HEAD, per `git cherry -v <upstream>` (task-7 brief: "check via git
// status/cherry -v"). `+`-prefixed lines are commits with no patch-equivalent on the other side;
// `-`-prefixed lines are already-applied-elsewhere (e.g. after a rebase/squash merge onto the main
// branch) and are deliberately NOT treated as "unmerged" by this check.
function hasUnmergedCommits(cherryOutput: string): boolean {
  return cherryOutput.split("\n").some((line) => line.startsWith("+"));
}

export const exitWorktreeExecutor: ToolExecutor = {
  async execute(input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
    const record = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
    const action = record.action;
    if (action !== "keep" && action !== "remove") {
      return { output: `Error: ExitWorktree "action" must be "keep" or "remove"; got ${JSON.stringify(action)}.`, isError: true };
    }
    const discardChanges = record.discard_changes === true;

    const listed = await listWorktrees(ctx.cwd);
    if (!listed.ok) {
      return { output: `Error: ExitWorktree could not enumerate this repository's worktrees: ${listed.stderr}`, isError: true };
    }
    const main = listed.worktrees.find((w) => w.isMain);
    if (!main) {
      return { output: "Error: ExitWorktree could not identify this repository's main worktree.", isError: true };
    }

    const currentRealPath = safeRealpath(ctx.cwd) ?? ctx.cwd;
    const current = findWorktreeContainingCwd(listed.worktrees, currentRealPath);
    if (!current) {
      return { output: `Error: ExitWorktree: the session's cwd (${ctx.cwd}) is not a worktree of this repository.`, isError: true };
    }
    if (current.isMain) {
      return { output: "Error: ExitWorktree: the session is already at the repository's main worktree; there is nothing to exit.", isError: true };
    }

    if (action === "keep") {
      ctx.session.setCwd(main.path);
      // RULING P3-L: exiting a worktree restores the session root to the main worktree too.
      ctx.session.setSessionRoot(main.path);
      return {
        output: JSON.stringify({
          action: "keep",
          worktreePath: current.path,
          mainWorktreePath: main.path,
          message: `Kept worktree at ${current.path}; session returned to the main worktree at ${main.path}.`,
        }),
      };
    }

    // action === "remove" from here.
    const status = await runGit(["status", "--porcelain"], current.path);
    if (!status.ok) {
      return { output: `Error: ExitWorktree could not check ${current.path} for uncommitted changes: ${status.stderr}`, isError: true };
    }
    const uncommitted = hasUncommittedChanges(status.stdout);

    const mainRef = main.branch ?? main.headSha;
    const cherry = await runGit(["cherry", "-v", mainRef], current.path);
    // A `cherry` command failure (e.g. an unresolvable ref) is treated conservatively as "cannot
    // prove this is safe" -- i.e. as if unmerged commits WERE found -- rather than silently treating
    // an inability to check as "clean" and letting removal proceed past a check that never actually ran.
    const unmerged = cherry.ok ? hasUnmergedCommits(cherry.stdout) : true;

    if ((uncommitted || unmerged) && !discardChanges) {
      const reasons = [uncommitted ? "uncommitted changes" : undefined, unmerged ? "commits not present on the main worktree's branch" : undefined].filter(
        (r): r is string => r !== undefined,
      );
      return {
        output: `Error: ExitWorktree refuses to remove ${current.path}: it has ${reasons.join(" and ")}. Pass discard_changes: true to remove it anyway.`,
        isError: true,
      };
    }

    // Removed with cwd = the MAIN worktree, never the worktree being removed -- git refuses to
    // remove a worktree a process is currently running inside of.
    const removeArgs = ["worktree", "remove", ...(discardChanges ? ["--force"] : []), current.path];
    const remove = await runGit(removeArgs, main.path);
    if (!remove.ok) {
      return { output: `Error: ExitWorktree failed to remove ${current.path}: ${remove.stderr}`, isError: true };
    }

    ctx.session.setCwd(main.path);
    // RULING P3-L: exiting a worktree restores the session root to the main worktree too.
    ctx.session.setSessionRoot(main.path);
    // M5 (fix wave, P3 close-out): the removal half of EnterWorktree's own `addBoundedRoot` call --
    // `current.path` is the EXACT string EnterWorktree added (never `current.realPath`, which can
    // differ under a symlinked temp dir; addBoundedRoot/removeBoundedRoot both key on the tool's own
    // literal target string, not its realpath). The session's filesystem permission fence no longer
    // includes a path that no longer exists on disk once the worktree is actually removed.
    ctx.session.removeBoundedRoot(current.path);
    return {
      output: JSON.stringify({
        action: "remove",
        worktreePath: current.path,
        mainWorktreePath: main.path,
        discarded: uncommitted || unmerged,
        message: `Removed worktree at ${current.path}; session returned to the main worktree at ${main.path}.`,
      }),
    };
  },
};

replaceExecutor(EXIT_WORKTREE_TOOL_NAME, exitWorktreeExecutor);
