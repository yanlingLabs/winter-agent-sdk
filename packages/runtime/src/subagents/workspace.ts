// WS-10 §8: filesystem isolation -- a `Workspace {root, isolationType, cleanupPolicy}` abstraction
// (report §106's own "orchestration never learns git details"). `isolation: "worktree"` REUSES Lane
// E-of-P3's own git plumbing (tools/impl/enter-worktree.ts: runGit/listWorktrees) -- READ-ONLY per
// this lane's own protocol; never edited, never duplicated.
//
// `isolation: "remote"` is NOT handled here at all: `SpawnChildRequest.isolation` (T3-frozen,
// child-handle.ts) is typed `"worktree" | undefined` ONLY -- "remote" never reaches this module by
// construction. WS-10 §8's own typed unsupported-capability error for "remote" is an
// INPUT-VALIDATION concern, handled in tools/impl/agent.ts before a SpawnChildRequest is ever built.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runGit, listWorktrees } from "../tools/impl/enter-worktree.ts";

export type IsolationType = "normal" | "worktree";
export type CleanupPolicy = "auto-remove-if-unchanged" | "keep";

export interface Workspace {
  root: string;
  isolationType: IsolationType;
  cleanupPolicy: CleanupPolicy;
  // Present only for isolationType "worktree" -- the branch git itself created/resolved, for
  // reporting/diagnostics; a "normal" workspace has no branch concept of its own.
  branch?: string;
}

export type CreateWorkspaceResult = { ok: true; workspace: Workspace } | { ok: false; error: string };

// `agentId` names the worktree directory (`.winter/worktrees/agent-<agentId>`) so concurrent
// children never collide on one path -- mirrors EnterWorktree's own `.winter/worktrees/<name>`
// convention (WS-01 §2.4) with the child's own identity as the name, never a model-supplied string
// (a child's own isolation worktree is not named BY the model the way EnterWorktree's `name` input
// is).
export async function createWorkspace(opts: { parentCwd: string; isolation?: "worktree"; agentId: string }): Promise<CreateWorkspaceResult> {
  if (opts.isolation === undefined) {
    return { ok: true, workspace: { root: opts.parentCwd, isolationType: "normal", cleanupPolicy: "keep" } };
  }

  const repoCheck = await runGit(["rev-parse", "--show-toplevel"], opts.parentCwd);
  if (!repoCheck.ok) {
    return { ok: false, error: `isolation:"worktree" requires the session's cwd to be inside a git repository (${opts.parentCwd} is not: ${repoCheck.stderr})` };
  }

  const worktreesDir = join(opts.parentCwd, ".winter", "worktrees");
  const target = join(worktreesDir, `agent-${opts.agentId}`);
  mkdirSync(worktreesDir, { recursive: true });

  const add = await runGit(["worktree", "add", target], opts.parentCwd);
  if (!add.ok) {
    return { ok: false, error: `failed to create an isolation worktree at ${target}: ${add.stderr}` };
  }
  const branchProbe = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], target);
  const branch = branchProbe.ok && branchProbe.stdout !== "HEAD" ? branchProbe.stdout : undefined;

  return {
    ok: true,
    workspace: { root: target, isolationType: "worktree", cleanupPolicy: "auto-remove-if-unchanged", ...(branch !== undefined ? { branch } : {}) },
  };
}

export interface CleanupResult {
  removed: boolean;
  reason: string;
}

// WS-10 §8: "auto-cleaned when unchanged." Reuses ExitWorktree's OWN exact safety checks
// (uncommitted changes via `git status --porcelain`; unmerged commits via `git cherry -v` against
// the repository's main worktree) rather than re-deriving a second, potentially-divergent notion of
// "unchanged" -- a workspace that IS unchanged is removed; one that ISN'T is left in place (NEVER
// force-removed: a child's own worktree holding real, undiscarded work is exactly the case this
// function must never destroy silently). A "normal" (non-worktree) or "keep"-policy workspace has
// nothing to clean up -- always a no-op success.
export async function cleanupWorkspace(workspace: Workspace): Promise<CleanupResult> {
  if (workspace.isolationType !== "worktree" || workspace.cleanupPolicy !== "auto-remove-if-unchanged") {
    return { removed: false, reason: "not an auto-cleanable worktree" };
  }
  const listed = await listWorktrees(workspace.root);
  if (!listed.ok) return { removed: false, reason: `could not enumerate worktrees: ${listed.stderr}` };
  const main = listed.worktrees.find((w) => w.isMain);
  if (!main) return { removed: false, reason: "could not identify the repository's main worktree" };

  const status = await runGit(["status", "--porcelain"], workspace.root);
  const uncommitted = status.ok ? status.stdout.trim().length > 0 : true; // an unreadable status is conservatively treated as "changed"

  const mainRef = main.branch ?? main.headSha;
  const cherry = await runGit(["cherry", "-v", mainRef], workspace.root);
  const unmerged = cherry.ok ? cherry.stdout.split("\n").some((l) => l.startsWith("+")) : true; // same conservative treatment as ExitWorktree's own check

  if (uncommitted || unmerged) {
    const reasons = [uncommitted ? "uncommitted changes" : undefined, unmerged ? "unmerged commits" : undefined].filter((r): r is string => r !== undefined);
    return { removed: false, reason: `left in place: ${reasons.join(" and ")}` };
  }

  const remove = await runGit(["worktree", "remove", workspace.root], main.path);
  if (!remove.ok) return { removed: false, reason: `git worktree remove failed: ${remove.stderr}` };
  return { removed: true, reason: "unchanged" };
}
