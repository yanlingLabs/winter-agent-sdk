import { describe, test, expect } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionReadState } from "../read-state.ts";
import { getRegisteredTool, type ToolExecutionContext } from "../registry.ts";
import { ENTER_WORKTREE_TOOL_NAME, enterWorktreeExecutor, runGit } from "./enter-worktree.ts";

// --- Hermetic git fixture helpers -------------------------------------------------------------
//
// This machine has GLOBAL git hooks installed (commit+push, every repo -- the name-guard identity
// guard). `GIT_CONFIG_GLOBAL=/dev/null` + `GIT_CONFIG_NOSYSTEM=1` make every fixture-setup git call
// hermetic (never reads global/system config, so a global hooksPath is never even consulted) --
// scoped to FIXTURE SETUP only, never to the production `runGit` the tool under test itself uses (a
// real user's real git identity/config should apply to the tool's own real invocations). Repo
// identity is LOCAL-ONLY and synthetic (never touches global config, never a real username).
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

async function initFixtureRepo(dir: string): Promise<void> {
  const run = async (args: string[]) => {
    const result = await runGitFixture(args, dir);
    if (!result.ok) throw new Error(`fixture setup "git ${args.join(" ")}" failed: ${result.stderr}`);
  };
  await run(["init", "-b", "main"]);
  await run(["config", "user.email", "lane-e-fixture@example.invalid"]);
  await run(["config", "user.name", "Lane E Fixture"]);
  await run(["commit", "--allow-empty", "-m", "initial commit"]);
}

function mkdtempRepo(): string {
  return mkdtempSync(join(tmpdir(), "winter-lane-e-enter-wt-"));
}

function makeCtx(cwd: string): { ctx: ToolExecutionContext; calls: { setCwd: string[]; addBoundedRoot: string[]; setSessionRoot: string[] } } {
  const calls = { setCwd: [] as string[], addBoundedRoot: [] as string[], setSessionRoot: [] as string[] };
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
      addBoundedRoot(p: string) {
        calls.addBoundedRoot.push(p);
      },
      removeBoundedRoot() {},
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

describe("EnterWorktree (task-7 brief)", () => {
  test("module load installs a real executor over the WS-06 stub", () => {
    const registered = getRegisteredTool(ENTER_WORKTREE_TOOL_NAME);
    expect(registered?.executor).toBeDefined();
  });

  test("neither name nor path -> legible error", async () => {
    const repo = mkdtempRepo();
    await initFixtureRepo(repo);
    const { ctx } = makeCtx(repo);
    const result = await enterWorktreeExecutor.execute({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("requires exactly one");
  });

  test("both name and path -> legible error", async () => {
    const repo = mkdtempRepo();
    await initFixtureRepo(repo);
    const { ctx } = makeCtx(repo);
    const result = await enterWorktreeExecutor.execute({ name: "a", path: "/tmp/b" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("not both");
  });

  test("a traversal-shaped name is rejected (fence-never-widens)", async () => {
    const repo = mkdtempRepo();
    await initFixtureRepo(repo);
    const { ctx, calls } = makeCtx(repo);
    for (const bad of ["../escape", "a/b", ".", "..", "/etc/passwd"]) {
      const result = await enterWorktreeExecutor.execute({ name: bad }, ctx);
      expect(result.isError).toBe(true);
    }
    expect(calls.addBoundedRoot).toEqual([]);
  });

  test("cwd not inside a git repository -> legible error, never a throw", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "winter-lane-e-not-a-repo-"));
    const { ctx } = makeCtx(notARepo);
    const result = await enterWorktreeExecutor.execute({ name: "foo" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("git repository");
  });

  test("name creates a worktree under .winter/worktrees/<name>, switches cwd, and widens the bounded root", async () => {
    const repo = mkdtempRepo();
    await initFixtureRepo(repo);
    const { ctx, calls } = makeCtx(repo);

    const result = await enterWorktreeExecutor.execute({ name: "feature-x" }, ctx);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output);
    const expectedPath = join(repo, ".winter", "worktrees", "feature-x");
    expect(parsed.worktreePath).toBe(expectedPath);
    expect(parsed.branch).toBe("feature-x"); // git's own convention: no -b given -> branch named after the basename
    expect(calls.setCwd).toEqual([expectedPath]);
    expect(calls.addBoundedRoot).toEqual([expectedPath]);
    // RULING P3-L (fix wave): the session root moves WITH the worktree switch, same target as cwd.
    expect(calls.setSessionRoot).toEqual([expectedPath]);

    // The worktree is real and git actually knows about it.
    const list = await runGit(["worktree", "list", "--porcelain"], repo);
    expect(list.stdout).toContain(realpathSync(expectedPath));
  });

  test("creating a second worktree with a different name does not collide", async () => {
    const repo = mkdtempRepo();
    await initFixtureRepo(repo);
    const { ctx: ctx1 } = makeCtx(repo);
    const { ctx: ctx2 } = makeCtx(repo);
    const first = await enterWorktreeExecutor.execute({ name: "one" }, ctx1);
    const second = await enterWorktreeExecutor.execute({ name: "two" }, ctx2);
    expect(first.isError).toBeUndefined();
    expect(second.isError).toBeUndefined();
    expect(JSON.parse(first.output).worktreePath).not.toBe(JSON.parse(second.output).worktreePath);
  });

  // T8 rider (Lane E review, "duplicate-worktree-name test"): the sibling test above only ever
  // proves two DIFFERENT names don't collide -- it says nothing about the SAME name requested
  // twice, which `git worktree add` genuinely refuses (the target path already exists and is
  // already a registered worktree). Proves the generic `!add.ok` error path (this file's own
  // `add.stderr`-based branch) fires legibly rather than throwing, and that the FIRST worktree is
  // completely unaffected by the second, failed attempt.
  test("creating a SECOND worktree with the SAME name fails legibly (git itself refuses); the first worktree is untouched", async () => {
    const repo = mkdtempRepo();
    await initFixtureRepo(repo);
    const { ctx: ctx1 } = makeCtx(repo);
    const { ctx: ctx2, calls: calls2 } = makeCtx(repo);

    const first = await enterWorktreeExecutor.execute({ name: "dup" }, ctx1);
    expect(first.isError).toBeUndefined();
    const firstPath = JSON.parse(first.output).worktreePath as string;

    const second = await enterWorktreeExecutor.execute({ name: "dup" }, ctx2);
    expect(second.isError).toBe(true);
    expect(second.output).toContain("Error: EnterWorktree failed to create a worktree");
    // The failed second attempt never touched the SECOND context's own posture-mutation seam.
    expect(calls2.setCwd).toEqual([]);
    expect(calls2.addBoundedRoot).toEqual([]);

    // The FIRST worktree is still there, completely unaffected by the second call's failure.
    const list = await runGit(["worktree", "list", "--porcelain"], repo);
    expect(list.stdout).toContain(realpathSync(firstPath));
  });

  test("path switches to an already-registered worktree, matching via realpath even through a symlinked temp dir", async () => {
    const repo = mkdtempRepo();
    await initFixtureRepo(repo);
    // Create the worktree directly via git (not through the tool under test) to prove EnterWorktree's
    // "path" branch recognizes a worktree it did not itself create.
    const worktreePath = join(repo, ".winter", "worktrees", "existing");
    const add = await runGitFixture(["worktree", "add", worktreePath], repo);
    expect(add.ok).toBe(true);

    const { ctx, calls } = makeCtx(repo);
    const result = await enterWorktreeExecutor.execute({ path: worktreePath }, ctx);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output);
    expect(parsed.worktreePath).toBe(realpathSync(worktreePath));
    expect(calls.setCwd).toEqual([realpathSync(worktreePath)]);
    expect(calls.addBoundedRoot).toEqual([realpathSync(worktreePath)]);
    expect(calls.setSessionRoot).toEqual([realpathSync(worktreePath)]);
  });

  test("path pointing at a real directory that is NOT a registered worktree -> legible error", async () => {
    const repo = mkdtempRepo();
    await initFixtureRepo(repo);
    const notAWorktree = mkdtempSync(join(tmpdir(), "winter-lane-e-stray-dir-"));
    const { ctx } = makeCtx(repo);
    const result = await enterWorktreeExecutor.execute({ path: notAWorktree }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("not a registered worktree");
  });

  test("path pointing at a nonexistent path -> legible error, never a throw", async () => {
    const repo = mkdtempRepo();
    await initFixtureRepo(repo);
    const { ctx } = makeCtx(repo);
    const result = await enterWorktreeExecutor.execute({ path: join(repo, "does", "not", "exist") }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("does not exist");
  });

  test("tolerates non-object input without throwing", async () => {
    const repo = mkdtempRepo();
    await initFixtureRepo(repo);
    for (const bad of [undefined, null, "nope", 42, []]) {
      const { ctx } = makeCtx(repo);
      await expect(enterWorktreeExecutor.execute(bad, ctx)).resolves.toMatchObject({ isError: true });
    }
  });
});
