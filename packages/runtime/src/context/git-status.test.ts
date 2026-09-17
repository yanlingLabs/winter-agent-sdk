// SDK 0.0.16 Lane C: the systemContext `gitStatus` snapshot, in claude 0.3.250's `aHe` shape
// (captured: "Current branch: trunk\n\nMain branch (you will usually use this for PRs): main\n\n
// Git user: …\n\nStatus:\n?? b.txt\n\nRecent commits:\n<sha> first commit subject").
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeGitStatus, gitInstructionsEnabled, GIT_STATUS_CAVEAT, GIT_STATUS_MAX_CHARS } from "./git-status.ts";
import { hermeticGit, makeGitFixture, type GitFixture } from "./git-fixture.ts";

let fixture: GitFixture;
let env: Record<string, string | undefined>;
const hooks = (f: GitFixture) => join(f.root, "empty-hooks");
const home = (f: GitFixture) => join(f.root, "fixture-home");

beforeAll(() => {
  fixture = makeGitFixture();
  // Read-only git calls with the machine's own config neutralised, and a repo-local identity.
  env = { ...process.env, HOME: home(fixture), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  hermeticGit(fixture.main, ["config", "user.name", "Fixture Person"], home(fixture), hooks(fixture));
});
afterAll(() => rmSync(fixture.root, { recursive: true, force: true }));

describe("computeGitStatus", () => {
  test("claude's part order and labels; untracked files in the short status; the recent commit", async () => {
    writeFileSync(join(fixture.main, "untracked.txt"), "x\n");
    const status = (await computeGitStatus(fixture.main, env))!;
    const parts = status.split("\n\n");
    expect(parts[0]).toBe(GIT_STATUS_CAVEAT);
    expect(parts[1]).toBe("Current branch: trunk");
    // No remote: claude falls back to `main` regardless of the local branch name.
    expect(parts[2]).toBe("Main branch (you will usually use this for PRs): main");
    expect(parts[3]).toBe("Git user: Fixture Person");
    expect(parts[4]).toBe("Status:\n?? untracked.txt");
    expect(parts[5]).toMatch(/^Recent commits:\n[0-9a-f]+ seed$/);
    expect(parts).toHaveLength(6);
    rmSync(join(fixture.main, "untracked.txt"));
  });

  test("a clean tree says (clean)", async () => {
    const status = (await computeGitStatus(fixture.main, env))!;
    expect(status).toContain("Status:\n(clean)");
  });

  test("the status is cut at 2 000 characters with claude's hint line", async () => {
    const dir = join(fixture.main, "many");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 120; i++) writeFileSync(join(dir, `file-with-a-longish-name-${String(i).padStart(4, "0")}.txt`), "x");
    // `status --short` collapses an untracked directory, so track nothing and list the files instead.
    hermeticGit(fixture.main, ["add", "-N", "many"], home(fixture), hooks(fixture));
    const status = (await computeGitStatus(fixture.main, env))!;
    const statusPart = status.slice(status.indexOf("Status:\n") + "Status:\n".length, status.indexOf("\n\nRecent commits:"));
    expect(statusPart).toEndWith('\n... (truncated because it exceeds 2k characters. If you need more information, run "git status" using Bash)');
    expect(statusPart.indexOf("\n... (truncated")).toBe(GIT_STATUS_MAX_CHARS);
    hermeticGit(fixture.main, ["reset", "-q", "many"], home(fixture), hooks(fixture));
    rmSync(dir, { recursive: true, force: true });
  });

  test("a directory outside any repository has no gitStatus", async () => {
    const outside = mkdtempSync(join(tmpdir(), "winter-nogit-"));
    try {
      expect(await computeGitStatus(outside, { ...env, GIT_CEILING_DIRECTORIES: tmpdir() })).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("the linked worktree reports its own branch", async () => {
    expect(await computeGitStatus(fixture.worktree, env)).toContain("Current branch: linked");
  });
});

describe("gitInstructionsEnabled (the kill switch over includeGitInstructions)", () => {
  test("unset env: the setting decides, defaulting on", () => {
    expect(gitInstructionsEnabled(undefined, undefined)).toBe(true);
    expect(gitInstructionsEnabled(undefined, false)).toBe(false);
    expect(gitInstructionsEnabled("", true)).toBe(true);
  });
  test("a truthy env value disables, a falsy one enables, either way over the setting", () => {
    expect(gitInstructionsEnabled("1", true)).toBe(false);
    expect(gitInstructionsEnabled("true", undefined)).toBe(false);
    expect(gitInstructionsEnabled("0", false)).toBe(true);
    expect(gitInstructionsEnabled("false", false)).toBe(true);
  });
});
