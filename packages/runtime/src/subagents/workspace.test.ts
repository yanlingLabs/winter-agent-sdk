import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace, cleanupWorkspace } from "./workspace.ts";

// --- Hermetic git fixture helpers (mirrors tools/impl/enter-worktree.test.ts's own established
// pattern exactly -- this machine has GLOBAL git hooks installed; GIT_CONFIG_GLOBAL=/dev/null +
// GIT_CONFIG_NOSYSTEM=1 make fixture SETUP hermetic; production workspace.ts calls the real,
// unwrapped runGit from enter-worktree.ts, matching that file's own precedent that the TOOL's real
// git operations should see a real user's real config). Repo identity is LOCAL-ONLY and synthetic.
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
  await run(["config", "user.email", "lane-c-fixture@example.invalid"]);
  await run(["config", "user.name", "Lane C Fixture"]);
  await run(["commit", "--allow-empty", "-m", "initial commit"]);
}

const tempDirs: string[] = [];
function mkdtempRepoDir(): string {
  const d = mkdtempSync(join(tmpdir(), "winter-lane-c-workspace-"));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("createWorkspace (WS-10 §8)", () => {
  test("no isolation requested -> a 'normal' workspace at the parent cwd, kept (nothing to clean up)", async () => {
    const cwd = mkdtempRepoDir();
    const result = await createWorkspace({ parentCwd: cwd, agentId: "a1" });
    expect(result).toEqual({ ok: true, workspace: { root: cwd, isolationType: "normal", cleanupPolicy: "keep" } });
  });

  test("isolation:worktree outside a git repo returns a typed failure, never throws", async () => {
    const cwd = mkdtempRepoDir(); // deliberately NOT git-initialized
    const result = await createWorkspace({ parentCwd: cwd, isolation: "worktree", agentId: "a1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("git repository");
  });

  test("isolation:worktree inside a real repo creates .winter/worktrees/agent-<id> on a fresh branch", async () => {
    const cwd = mkdtempRepoDir();
    await initFixtureRepo(cwd);
    const result = await createWorkspace({ parentCwd: cwd, isolation: "worktree", agentId: "agent-xyz" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workspace.root).toBe(join(cwd, ".winter", "worktrees", "agent-agent-xyz"));
      expect(result.workspace.isolationType).toBe("worktree");
      expect(result.workspace.cleanupPolicy).toBe("auto-remove-if-unchanged");
      expect(existsSync(result.workspace.root)).toBe(true);
    }
  });

  test("two concurrent children get two distinct, non-colliding worktree paths", async () => {
    const cwd = mkdtempRepoDir();
    await initFixtureRepo(cwd);
    const a = await createWorkspace({ parentCwd: cwd, isolation: "worktree", agentId: "a" });
    const b = await createWorkspace({ parentCwd: cwd, isolation: "worktree", agentId: "b" });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.workspace.root).not.toBe(b.workspace.root);
  });
});

describe("cleanupWorkspace (WS-10 §8 'auto-cleaned when unchanged')", () => {
  test("a 'normal' workspace is a no-op (nothing to clean up)", async () => {
    const cwd = mkdtempRepoDir();
    const result = await cleanupWorkspace({ root: cwd, isolationType: "normal", cleanupPolicy: "keep" });
    expect(result.removed).toBe(false);
  });

  test("an UNCHANGED worktree (no commits, no uncommitted files) is auto-removed", async () => {
    const cwd = mkdtempRepoDir();
    await initFixtureRepo(cwd);
    const created = await createWorkspace({ parentCwd: cwd, isolation: "worktree", agentId: "clean" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const result = await cleanupWorkspace(created.workspace);
    expect(result).toEqual({ removed: true, reason: "unchanged" });
    expect(existsSync(created.workspace.root)).toBe(false);
  });

  test("a worktree with uncommitted changes is LEFT IN PLACE, never force-removed", async () => {
    const cwd = mkdtempRepoDir();
    await initFixtureRepo(cwd);
    const created = await createWorkspace({ parentCwd: cwd, isolation: "worktree", agentId: "dirty" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeFileSync(join(created.workspace.root, "new-file.txt"), "uncommitted work");
    const result = await cleanupWorkspace(created.workspace);
    expect(result.removed).toBe(false);
    expect(result.reason).toContain("uncommitted changes");
    expect(existsSync(created.workspace.root)).toBe(true);
  });

  test("a worktree with a real commit not on the main branch is LEFT IN PLACE", async () => {
    const cwd = mkdtempRepoDir();
    await initFixtureRepo(cwd);
    const created = await createWorkspace({ parentCwd: cwd, isolation: "worktree", agentId: "ahead" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeFileSync(join(created.workspace.root, "work.txt"), "real work");
    await runGitFixture(["add", "work.txt"], created.workspace.root);
    await runGitFixture(["commit", "-m", "real work"], created.workspace.root);
    const result = await cleanupWorkspace(created.workspace);
    expect(result.removed).toBe(false);
    expect(result.reason).toContain("unmerged commits");
    expect(existsSync(created.workspace.root)).toBe(true);
  });
});
