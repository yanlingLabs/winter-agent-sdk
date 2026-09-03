// Task 7 (LANE E, WS-06 §3.3 "EnterWorktree"): `{name?: string; path?: string}` mutually exclusive
// (task-7 brief: "spec says name creates, path switches; neither given = error"). `name` creates a
// git worktree under `<cwd>/.winter/worktrees/<name>` (WS-01 §2.4's `.winter/worktrees` convention);
// `path` switches to an ALREADY-REGISTERED worktree of the same repository. Both cases mutate the
// session's own posture through `ctx.session.setCwd` + `ctx.session.addBoundedRoot` -- never
// engine.ts directly (R3-5; the `session` seam is engine.ts's own wiring, registry.ts's own
// documented contract).
//
// This file also hosts the git plumbing (`runGit`, `listWorktrees`, `safeRealpath`, `WorktreeInfo`)
// that exit-worktree.ts imports -- the two tools share one repository model rather than each
// hand-rolling its own `git worktree list --porcelain` parser (a task-7 review judgment call: both
// files are Lane E's own, so this is an intra-lane import, not a cross-lane dependency R3-5 forbids).
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import "../descriptors/enter-worktree.ts"; // self-sufficiency: guarantees the "EnterWorktree" stub is registered before replaceExecutor runs below.

export const ENTER_WORKTREE_TOOL_NAME = "EnterWorktree";

export interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

// Shells out to a real `git` process (Bun.spawn, per the brief) with the given cwd. Never throws on a
// non-zero exit -- every caller inspects `.ok` and turns a failure into a legible tool error using
// `.stderr`, matching this file's own "never let git's own stderr text get lost" discipline.
export async function runGit(args: string[], cwd: string): Promise<GitRunResult> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

// realpathSync canonicalizes symlinks AND (on macOS) the /var <-> /private/var alias that would
// otherwise make a freshly-mkdtemp'd fixture path compare unequal to git's own porcelain-reported
// path for the identical worktree. Returns undefined (never throws) for a path that does not exist.
export function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

export interface WorktreeInfo {
  path: string;
  realPath: string;
  headSha: string;
  branch?: string;
  isMain: boolean;
}

// Parses `git worktree list --porcelain`. Per git's own documented behavior the MAIN worktree is
// always listed first -- `isMain` is derived from list position, not from any heuristic about the
// path itself. Tolerant of both a trailing blank line and no trailing blank line after the last
// record (the final `flush()` after the loop is a no-op when the porcelain output already ended on a
// blank line, since `current` is empty by then).
export async function listWorktrees(cwd: string): Promise<{ ok: true; worktrees: WorktreeInfo[] } | { ok: false; stderr: string }> {
  const result = await runGit(["worktree", "list", "--porcelain"], cwd);
  if (!result.ok) return { ok: false, stderr: result.stderr };

  const worktrees: Array<{ path: string; realPath: string; headSha: string; branch?: string }> = [];
  let current: { path?: string; headSha?: string; branch?: string } = {};
  const flush = (): void => {
    if (current.path !== undefined && current.headSha !== undefined) {
      const realPath = safeRealpath(current.path) ?? current.path;
      worktrees.push({ path: current.path, realPath, headSha: current.headSha, ...(current.branch !== undefined ? { branch: current.branch } : {}) });
    }
    current = {};
  };
  for (const line of result.stdout.split("\n")) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) current.path = line.slice("worktree ".length);
    else if (line.startsWith("HEAD ")) current.headSha = line.slice("HEAD ".length);
    else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    }
    // "detached" / "locked" / "prunable" lines carry no field this shape tracks; ignored.
  }
  flush();

  return { ok: true, worktrees: worktrees.map((w, i) => ({ ...w, isMain: i === 0 })) };
}

function isSingleSegmentName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\");
}

export const enterWorktreeExecutor: ToolExecutor = {
  async execute(input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
    const record = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
    const name = typeof record.name === "string" ? record.name : undefined;
    const path = typeof record.path === "string" ? record.path : undefined;

    if (name !== undefined && path !== undefined) {
      return { output: 'Error: EnterWorktree takes exactly one of "name" or "path", not both.', isError: true };
    }
    if (name === undefined && path === undefined) {
      return { output: 'Error: EnterWorktree requires exactly one of "name" or "path".', isError: true };
    }

    // Fence-never-widens principle (task-7 review addition; not stated verbatim in WS-06's own
    // prose -- flagged in the report): `addBoundedRoot` below hands the resolved worktree path
    // straight to the evaluator's bounded-roots input (engine.ts's `extraBoundedRoots`), so a
    // traversal name ("../../etc" or an absolute-looking segment) would otherwise let this tool
    // expand the session's OWN filesystem permission fence to an arbitrary location instead of a
    // path safely confined under `.winter/worktrees`.
    if (name !== undefined && !isSingleSegmentName(name)) {
      return { output: `Error: EnterWorktree "name" must be a single path segment (no "/", not "." or ".."); got ${JSON.stringify(name)}.`, isError: true };
    }

    const repoCheck = await runGit(["rev-parse", "--show-toplevel"], ctx.cwd);
    if (!repoCheck.ok) {
      return { output: `Error: EnterWorktree requires the session's cwd to be inside a git repository. ${ctx.cwd} is not (git: ${repoCheck.stderr}).`, isError: true };
    }

    if (name !== undefined) {
      const worktreesDir = join(ctx.cwd, ".winter", "worktrees");
      const target = join(worktreesDir, name);
      mkdirSync(worktreesDir, { recursive: true });

      const add = await runGit(["worktree", "add", target], ctx.cwd);
      if (!add.ok) {
        return { output: `Error: EnterWorktree failed to create a worktree at ${target}: ${add.stderr}`, isError: true };
      }

      // `git worktree add <path>` with no explicit <commit-ish>/-b auto-creates a branch named after
      // <path>'s basename off HEAD (git's own documented convenience) -- but re-deriving the branch
      // via a real `rev-parse` inside the new worktree (rather than assuming branch === name) is
      // correct even in the edge case where `name` collided with an existing branch git chose to
      // check out instead of creating a new one.
      const branchProbe = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], target);
      const branch = branchProbe.ok && branchProbe.stdout !== "HEAD" ? branchProbe.stdout : undefined;

      ctx.session.setCwd(target);
      ctx.session.addBoundedRoot(target);

      return {
        output: JSON.stringify({
          worktreePath: target,
          ...(branch !== undefined ? { branch } : {}),
          message: `Created worktree "${name}" at ${target}${branch !== undefined ? ` on branch "${branch}"` : ""}.`,
        }),
      };
    }

    // path !== undefined here -- the XOR check above guarantees exactly one of the two is set.
    const requestedPath = path as string;
    const requestedRealPath = safeRealpath(requestedPath);
    if (requestedRealPath === undefined) {
      return { output: `Error: EnterWorktree "path" does not exist: ${requestedPath}`, isError: true };
    }

    const listed = await listWorktrees(ctx.cwd);
    if (!listed.ok) {
      return { output: `Error: EnterWorktree could not enumerate this repository's worktrees: ${listed.stderr}`, isError: true };
    }
    const match = listed.worktrees.find((w) => w.realPath === requestedRealPath);
    if (!match) {
      return { output: `Error: EnterWorktree "path" (${requestedPath}) is not a registered worktree of this repository.`, isError: true };
    }

    ctx.session.setCwd(match.path);
    ctx.session.addBoundedRoot(match.path);

    return {
      output: JSON.stringify({
        worktreePath: match.path,
        ...(match.branch !== undefined ? { branch: match.branch } : {}),
        message: `Switched to registered worktree at ${match.path}${match.branch !== undefined ? ` (branch "${match.branch}")` : ""}.`,
      }),
    };
  },
};

replaceExecutor(ENTER_WORKTREE_TOOL_NAME, enterWorktreeExecutor);
