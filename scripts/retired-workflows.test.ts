// The spent one-run and per-branch reviewed workflows are RETIRED (deleted), so they can never be re-armed: a workflow file is only ever a live trigger.
//
// Why deleted and not "disabled": a one-run workflow here fires on the FIRST CREATION of a named branch (or on a pull request from a named branch). Every such branch now
// exists on origin and is frozen, so none can fire again today, but deleting and recreating a branch name, or opening a pull request from it, would fire the file again;
// a `if: false` edit is one revert from live. A deleted file cannot fire, and Git history keeps the record (the docs under docs/guided-owner-*.md describe each run).
//
// Kept on purpose: ci.yml and release.yml (live), and cowork-tool-utilities-build.yml, which is not a trigger-only workflow: the utilities build and staging hash it as
// a pinned input (scripts/guest-utilities/{build.py,compile.ts,stage.py}).
//
// This test keeps them gone: (1) no retired file exists, (2) no workflow names a retired or spent trigger branch, (3) every remaining workflow is on the reviewed allow-list.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const WORKFLOWS = ".github/workflows";

export const RETIRED_WORKFLOWS = [
  "guided-owner-matrix-reviewed.yml",
  "guided-owner-matrix-holder-reviewed.yml",
  "cowork-fresh-engine-reviewed.yml",
  "cowork-fresh-engine-build.yml",
  "cowork-host-query-reviewed.yml",
  "cowork-host-query-build.yml",
  "cowork-host-query-utilities-reviewed.yml",
  "cowork-tool-utilities-reviewed.yml",
  "cowork-isolated-reader-source.yml",
] as const;
/** Branches whose creation or pull request a retired workflow listened for. They are spent. */
export const SPENT_BRANCHES = [
  "cowork/guided-owner-matrix-run", "cowork/guided-owner-matrix-run-2", "cowork/fresh-engine-staging", "cowork/linux-host-query-fixture", "cowork/linux-host-query-utilities",
  "cowork/linux-tool-devices", "cowork/isolated-instruction-reader", "cowork/reader-runtime-compatibility",
  "cowork/guided-hosted-run", "cowork/guided-hosted-run-2", "cowork/guided-hosted-run-3", "cowork/guided-hosted-run-4", "cowork/guided-hosted-run-5",
] as const;
export const ALLOWED_WORKFLOWS = ["ci.yml", "release.yml", "cowork-tool-utilities-build.yml"] as const;

/** Pure: the violations of a directory listing (name -> text). */
export function violations(files: Record<string, string>): string[] {
  const found: string[] = [];
  for (const name of Object.keys(files).sort()) {
    if ((RETIRED_WORKFLOWS as readonly string[]).includes(name)) found.push(`retired workflow is back: ${name}`);
    else if (!(ALLOWED_WORKFLOWS as readonly string[]).includes(name)) found.push(`workflow is not on the allow-list: ${name}`);
    for (const branch of SPENT_BRANCHES) if (new RegExp(`${branch.replace(/[/.]/g, "\\$&")}(?![\\w-])`).test(files[name]!)) found.push(`${name} names a spent branch: ${branch}`);
  }
  return found;
}
const live = (): Record<string, string> => Object.fromEntries(readdirSync(join(ROOT, WORKFLOWS)).filter((name) => /\.ya?ml$/.test(name)).map((name) => [name, readFileSync(join(ROOT, WORKFLOWS, name), "utf8")]));

describe("retired workflows stay gone", () => {
  test("no retired workflow file exists", () => {
    for (const name of RETIRED_WORKFLOWS) expect(existsSync(join(ROOT, WORKFLOWS, name))).toBe(false);
  });
  test("the live workflows are exactly the allow-list and name no spent branch", () => {
    expect(violations(live())).toEqual([]);
    expect(Object.keys(live()).sort()).toEqual([...ALLOWED_WORKFLOWS].sort());
  });
  test("the pure check flags a returned file, a new workflow, and a spent branch name (mutations)", () => {
    const base = live();
    expect(violations({ ...base, "guided-owner-matrix-reviewed.yml": "on: push" })).toEqual(["retired workflow is back: guided-owner-matrix-reviewed.yml"]);
    expect(violations({ ...base, "new-one-run.yml": "on: push" })).toEqual(["workflow is not on the allow-list: new-one-run.yml"]);
    expect(violations({ ...base, "ci.yml": `${base["ci.yml"]}\n# branches: [cowork/guided-hosted-run-5]` })).toEqual(["ci.yml names a spent branch: cowork/guided-hosted-run-5"]);
    expect(violations({ ...base, "ci.yml": `${base["ci.yml"]}\n# cowork/guided-hosted-run-6` })).toEqual([]);
    expect(violations({ ...base, "release.yml": `${base["release.yml"]}\nbranches: [cowork/linux-tool-devices]` })).toEqual(["release.yml names a spent branch: cowork/linux-tool-devices"]);
  });
});
