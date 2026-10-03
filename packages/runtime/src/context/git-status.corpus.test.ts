// A recorded corpus for the gitStatus branch lines: 40 generated branch shapes (a checked-out, detached
// or unborn HEAD; a subset of origin branches including slashed names; origin/HEAD
// unset, pointing at an existing or missing origin branch, or at a ref outside origin) with the
// `Current branch:` / `Main branch ...:` lines recorded for each. Each shape is rebuilt here as a real
// hermetic local repository (git-branch-fixture.ts) -- git has no injection point to fake.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeGitStatus } from "./git-status.ts";
import { branchLines, makeBranchRepo, type BranchShape } from "./git-branch-fixture.ts";
import corpus from "./__corpus__/git-branch-pick.json";

const root = mkdtempSync(join(tmpdir(), "winter-ctx-branch-corpus-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test(
  "the recorded branch shapes give exactly the recorded branch lines",
  async () => {
    const rows = corpus as Array<{ shape: BranchShape; expected: { current: string | null; main: string | null } }>;
    expect(rows.length).toBe(40);
    const mismatches: unknown[] = [];
    for (const row of rows) {
      const repo = makeBranchRepo(row.shape, root);
      const got = branchLines(await computeGitStatus(repo.dir, repo.env));
      if (JSON.stringify(got) !== JSON.stringify(row.expected)) mismatches.push({ shape: row.shape, got, expected: row.expected });
    }
    expect(mismatches).toEqual([]);
  },
  60_000,
);
