import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionReadState } from "../read-state.ts";
import { getRegisteredTool, type ToolExecutionContext } from "../registry.ts";
import { EXIT_WORKTREE_TOOL_NAME, exitWorktreeExecutor } from "./exit-worktree.ts";

// --- Hermetic git fixture helpers (duplicated from enter-worktree.test.ts's own copy -- see that
// file's identical comment for why: this machine's GLOBAL commit/push hooks must never fire during
// fixture setup, scoped to fixture setup ONLY, never to the tool's own production git calls). ------
async function runGitFixture(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function gitFixture(args: string[], cwd: string): Promise<void> {
  const result = await runGitFixture(args, cwd);
  if (!result.ok) throw new Error(`fixture setup "git ${args.join(" ")}" (cwd=${cwd}) failed: ${result.stderr}`);
}

async function initFixtureRepo(dir: string): Promise<void> {
  await gitFixture(["init", "-b", "main"], dir);
  await gitFixture(["config", "user.email", "lane-e-fixture@example.invalid"], dir);
  await gitFixture(["config", "user.name", "Lane E Fixture"], dir);
  await gitFixture(["commit", "--allow-empty", "-m", "initial commit"], dir);
}

function mkdtempRepo(): string {
  return mkdtempSync(join(tmpdir(), "winter-lane-e-exit-wt-"));
}

// Creates a linked worktree directly via git (never through EnterWorktree -- these tests exercise
// ExitWorktree in isolation) and returns its path.
async function addFixtureWorktree(repo: string, name: string): Promise<string> {
  const path = join(repo, ".winter", "worktrees", name);
  await gitFixture(["worktree", "add", path], repo);
  return path;
}

function makeCtx(cwd: string): { ctx: ToolExecutionContext; calls: { setCwd: string[]; setSessionRoot: string[]; removeBoundedRoot: string[] } } {
  const calls = { setCwd: [] as string[], setSessionRoot: [] as string[], removeBoundedRoot: [] as string[] };
  const ctx: ToolExecutionContext = {
    cwd,
    home: "/home/test",
    sessionId: "test-session",
    readState: createSessionReadState(),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: "/tmp/winter-test",
    sandboxSettings: {},
    session: {
      setCwd(p: string) {
        calls.setCwd.push(p);
      },
      addBoundedRoot() {},
      removeBoundedRoot(p: string) {
        calls.removeBoundedRoot.push(p);
      },
      setPermissionMode() {},
      getBoundedRoots: () => [],
      getPermissionMode: () => "default",
      getSessionRoot: () => cwd,
      setSessionRoot(p: string) {
        calls.setSessionRoot.push(p);
      },
    },
  };
  return { ctx, calls };
}

describe("ExitWorktree (task-7 brief)", () => {
  test("module load installs a real executor over the WS-06 stub", () => {
    const registered = getRegisteredTool(EXIT_WORKTREE_TOOL_NAME);
    expect(registered?.executor).toBeDefined();
  });

  test("an invalid action is a legible validation error", async () => {
    const repo = mkdtempRepo();
    await initFixtureRepo(repo);
    const worktree = await addFixtureWorktree(repo, "wt1");
    const { ctx } = makeCtx(worktree);
    const result = await exitWorktreeExecutor.execute({ action: "delete" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('"keep" or "remove"');
  });

  test("cwd not part of any repository -> legible error", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "winter-lane-e-not-a-repo-"));
    const { ctx } = makeCtx(notARepo);
    const result = await exitWorktreeExecutor.execute({ action: "keep" }, ctx);
    expect(result.isError).toBe(true);
  });

  test("already at the main worktree -> legible error (nothing to exit)", async () => {
    const repo = mkdtempRepo();
    await initFixtureRepo(repo);
    const { ctx } = makeCtx(repo);
    const result = await exitWorktreeExecutor.execute({ action: "keep" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("already at the repository's main worktree");
  });

  test("keep: restores cwd to the main worktree, leaves the worktree registered", async () => {
    const repo = mkdtempRepo();
    await initFixtureRepo(repo);
    const worktree = await addFixtureWorktree(repo, "wt-keep");
    const { ctx, calls } = makeCtx(worktree);

    const result = await exitWorktreeExecutor.execute({ action: "keep" }, ctx);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output);
    expect(parsed.action).toBe("keep");
    expect(calls.setCwd).toEqual([parsed.mainWorktreePath]);
    expect(calls.setSessionRoot).toEqual([parsed.mainWorktreePath]);

    // The worktree must still be registered with git (kept, not removed).
    const listAll = await runGitFixture(["worktree", "list"], repo);
    expect(listAll.stdout).toContain("wt-keep");
  });

  test("remove: a clean worktree (no uncommitted changes, no unmerged commits) is removed without discard_changes", async () => {
    const repo = mkdtempRepo();
    await initFixtureRepo(repo);
    const worktree = await addFixtureWorktree(repo, "wt-clean");
    const worktreeRealPath = realpathSync(worktree); // captured BEFORE removal -- the path won't exist to realpath afterward
    const { ctx, calls } = makeCtx(worktree);

    const result = await exitWorktreeExecutor.execute({ action: "remove" }, ctx);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output);
    expect(parsed.action).toBe("remove");
    expect(parsed.discarded).toBe(false);
    expect(calls.setCwd).toEqual([parsed.mainWorktreePath]);
    expect(calls.setSessionRoot).toEqual([parsed.mainWorktreePath]);
    // M5 (fix wave, P3 close-out): the removed worktree's own path is dropped from the session's
    // bounded roots -- EnterWorktree's own addBoundedRoot(worktree) is undone.
    expect(calls.removeBoundedRoot).toEqual([worktreeRealPath]);

    const listAll = await runGitFixture(["worktree", "list"], repo);
    expect(listAll.stdout).not.toContain("wt-clean");
  });

  // M5 (fix wave, P3 close-out): a `cd` into a SUBDIRECTORY of the worktree (allowed -- it's within
  // bounded roots the moment EnterWorktree adds the worktree itself) previously made ExitWorktree
  // report "the session's cwd is not a worktree of this repository," even though it plainly still
  // was one, just not exactly AT the worktree's own root.
  test("keep: a cwd inside a SUBDIRECTORY of the worktree (not the worktree root itself) is still recognized", async () => {
    const repo = mkdtempRepo();
    await initFixtureRepo(repo);
    const worktree = await addFixtureWorktree(repo, "wt-subdir");
    mkdirSync(join(worktree, "src"));
    const { ctx, calls } = makeCtx(join(worktree, "src"));

    const result = await exitWorktreeExecutor.execute({ action: "keep" }, ctx);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output);
    expect(parsed.worktreePath).toBe(realpathSync(worktree));
    expect(calls.setCwd).toEqual([parsed.mainWorktreePath]);
  });

  test("remove: refuses on uncommitted changes without discard_changes", async () => {
    const repo = mkdtempRepo();
    await initFixtureRepo(repo);
    const worktree = await addFixtureWorktree(repo, "wt-dirty");
    writeFileSync(join(worktree, "untracked.txt"), "scratch content\n");
    const { ctx } = makeCtx(worktree);

    const result = await exitWorktreeExecutor.execute({ action: "remove" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("uncommitted changes");

    const listAll = await runGitFixture(["worktree", "list"], repo);
    expect(listAll.stdout).toContain("wt-dirty"); // still registered -- removal was refused
  });

  test("remove: discard_changes:true removes despite uncommitted changes", async () => {
    const repo = mkdtempRepo();
    await initFixtureRepo(repo);
    const worktree = await addFixtureWorktree(repo, "wt-dirty-force");
    writeFileSync(join(worktree, "untracked.txt"), "scratch content\n");
    const { ctx } = makeCtx(worktree);

    const result = await exitWorktreeExecutor.execute({ action: "remove", discard_changes: true }, ctx);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.output).discarded).toBe(true);

    const listAll = await runGitFixture(["worktree", "list"], repo);
    expect(listAll.stdout).not.toContain("wt-dirty-force");
  });

  test("remove: refuses on unmerged commits (committed on the worktree's branch, not on main) without discard_changes", async () => {
    const repo = mkdtempRepo();
    await initFixtureRepo(repo);
    const worktree = await addFixtureWorktree(repo, "wt-ahead");
    await gitFixture(["commit", "--allow-empty", "-m", "work in progress"], worktree);
    const { ctx } = makeCtx(worktree);

    const result = await exitWorktreeExecutor.execute({ action: "remove" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("not present on the main worktree's branch");

    const listAll = await runGitFixture(["worktree", "list"], repo);
    expect(listAll.stdout).toContain("wt-ahead");
  });

  test("remove: discard_changes:true removes despite unmerged commits", async () => {
    const repo = mkdtempRepo();
    await initFixtureRepo(repo);
    const worktree = await addFixtureWorktree(repo, "wt-ahead-force");
    await gitFixture(["commit", "--allow-empty", "-m", "work in progress"], worktree);
    const { ctx } = makeCtx(worktree);

    const result = await exitWorktreeExecutor.execute({ action: "remove", discard_changes: true }, ctx);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.output).discarded).toBe(true);

    const listAll = await runGitFixture(["worktree", "list"], repo);
    expect(listAll.stdout).not.toContain("wt-ahead-force");
  });

  test("tolerates non-object input without throwing", async () => {
    const repo = mkdtempRepo();
    await initFixtureRepo(repo);
    const worktree = await addFixtureWorktree(repo, "wt-badinput");
    for (const bad of [undefined, null, "nope", 42, []]) {
      const { ctx } = makeCtx(worktree);
      await expect(exitWorktreeExecutor.execute(bad, ctx)).resolves.toMatchObject({ isError: true });
    }
  });
});
