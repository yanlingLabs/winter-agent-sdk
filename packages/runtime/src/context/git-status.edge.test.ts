// Edge cases of the gitStatus snapshot's two branch lines -- the checked-out branch and the main
// branch -- against real (hermetic, local-only) git repositories in specific branch shapes.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeGitStatus } from "./git-status.ts";
import { branchLines, makeBranchRepo, type BranchShape } from "./git-branch-fixture.ts";

const root = mkdtempSync(join(tmpdir(), "winter-ctx-branch-edge-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function lines(shape: BranchShape): Promise<{ current: string | null; main: string | null; status: string | undefined }> {
  const repo = makeBranchRepo(shape, root);
  const status = await computeGitStatus(repo.dir, repo.env);
  return { ...branchLines(status), status };
}
const main = (name: string) => `Main branch (you will usually use this for PRs): ${name}`;

describe("the current-branch line", () => {
  test("a checked-out branch is named, slashes and all", async () => {
    expect((await lines({ checkout: { branch: "feature/x-1" }, originBranches: [] })).current).toBe("Current branch: feature/x-1");
  });
  test("a detached HEAD reads `HEAD`", async () => {
    expect((await lines({ checkout: "detached", originBranches: [] })).current).toBe("Current branch: HEAD");
  });
  test("an unborn branch (no commit yet) reads `HEAD`, and its commit list is empty", async () => {
    const out = await lines({ checkout: "unborn", originBranches: [] });
    expect(out.current).toBe("Current branch: HEAD");
    expect(out.status).toEndWith("Status:\n(clean)\n\nRecent commits:\n");
  });
});

describe("the main-branch line", () => {
  test("no origin refs at all: `main`, whatever the local branch is called", async () => {
    expect((await lines({ checkout: { branch: "master" }, originBranches: [] })).main).toBe(main("main"));
  });
  test("origin/HEAD naming an existing origin branch wins over main/master", async () => {
    expect((await lines({ checkout: { branch: "trunk" }, originBranches: ["main", "develop"], originHead: "refs/remotes/origin/develop" })).main).toBe(main("develop"));
  });
  test("origin/HEAD naming a slashed branch keeps everything after the first `origin/`", async () => {
    expect((await lines({ checkout: { branch: "trunk" }, originBranches: ["feat/x"], originHead: "refs/remotes/origin/feat/x" })).main).toBe(main("feat/x"));
    expect((await lines({ checkout: { branch: "trunk" }, originBranches: ["origin/x"], originHead: "refs/remotes/origin/origin/x" })).main).toBe(main("origin/x"));
  });
  test("origin/HEAD naming a branch origin does NOT have falls back to main/master", async () => {
    expect((await lines({ checkout: { branch: "trunk" }, originBranches: ["master"], originHead: "refs/remotes/origin/gone" })).main).toBe(main("master"));
    expect((await lines({ checkout: { branch: "trunk" }, originBranches: [], originHead: "refs/remotes/origin/gone" })).main).toBe(main("main"));
  });
  test("origin/HEAD pointing outside origin: its short name must still exist under origin to count", async () => {
    expect((await lines({ checkout: { branch: "trunk" }, originBranches: ["master"], originHead: "refs/heads/trunk" })).main).toBe(main("master"));
    expect((await lines({ checkout: { branch: "trunk" }, originBranches: ["trunk", "main"], originHead: "refs/heads/trunk" })).main).toBe(main("trunk"));
  });
  test("without origin/HEAD: main beats master; master alone is master; anything else is `main`", async () => {
    expect((await lines({ checkout: { branch: "trunk" }, originBranches: ["master", "main"] })).main).toBe(main("main"));
    expect((await lines({ checkout: { branch: "trunk" }, originBranches: ["master", "develop"] })).main).toBe(main("master"));
    expect((await lines({ checkout: { branch: "trunk" }, originBranches: ["develop", "trunk"] })).main).toBe(main("main"));
  });
  test("a detached or unborn checkout does not change the main-branch pick", async () => {
    expect((await lines({ checkout: "detached", originBranches: ["develop"], originHead: "refs/remotes/origin/develop" })).main).toBe(main("develop"));
    expect((await lines({ checkout: "unborn", originBranches: ["master"] })).main).toBe(main("master"));
  });
});
