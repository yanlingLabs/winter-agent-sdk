// P7a Lane C: the release/publish pipeline's own YAML tripwires, in `scripts/ci-gates.test.ts`'s
// PATTERN -- a separate file, not an addition to that one, because ci-gates.test.ts's own header
// already names its exact Phase-6 scope (the catalog/provider-sync gates and the live-gate absence)
// and mixing this phase's publish-pipeline assertions into it would blur two independently-owned
// concerns under one title.
//
// Three things live entirely in YAML, which has no compiler:
//   1. `release.yml`'s `on:` block MUST be exactly `{ push: { tags: ["v*"] }, workflow_dispatch: {} }`
//      -- Global Constraints: "the publish job fires ONLY on v* tags or workflow_dispatch -- never
//      on phase-* tags (a CI assertion pins the on: block)". Every earlier phase of this arc tags
//      its own merge commits `phase-N-...`; if release.yml's trigger ever widened to match those,
//      finishing an unrelated phase would silently publish.
//   2. NO workflow file other than release.yml may run an actual `pnpm publish`/`npm publish`
//      COMMAND (Global Constraints: "NO other workflow contains publish"). Checked at the COMMAND
//      level, comments stripped -- not a bare substring search over the whole file, because this
//      file's own header (and ci.yml's `pack-smoke` job comments) legitimately use the English word
//      "publish" to explain what does and does not do it; a naive `.includes("publish")` would trip
//      on prose describing the constraint, not on anything that could actually publish.
//   3. ci.yml's `pack-smoke` job (WS-02 §9 item 3) exists, runs on every push (ci.yml's own top-level
//      trigger, not gated behind a release tag), packs before it installs anything, and installs
//      with BOTH Node 18 and Bun.
//
// Absence is the one that genuinely needs a test, for the same reason ci-gates.test.ts's own header
// gives: a workflow that never publishes and one that was never SUPPOSED to look identical in a
// diff, and only a test tells them apart.
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const WORKFLOWS_DIR = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
const RELEASE_YML_PATH = join(WORKFLOWS_DIR, "release.yml");
const RELEASE_YML = readFileSync(RELEASE_YML_PATH, "utf8");
const CI_YML = readFileSync(join(WORKFLOWS_DIR, "ci.yml"), "utf8");

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
}

/** Strips a trailing `#...` comment (YAML or shell -- both use `#`), keyed on the `#` being preceded by start-of-line or whitespace so it never eats a real token. */
function stripComment(line: string): string {
  const idx = line.search(/(^|\s)#/);
  return idx === -1 ? line : line.slice(0, idx);
}

/** True iff the file's ACTUAL command text (comments stripped) runs `pnpm publish` or `npm publish` anywhere -- not merely mentions the word "publish" in prose. */
function containsPublishCommand(yamlText: string): boolean {
  return yamlText
    .split("\n")
    .map(stripComment)
    .some((line) => /\b(pnpm|npm)\s+publish\b/.test(line));
}

describe("release.yml's trigger is pinned to v* tags and workflow_dispatch only", () => {
  test("the parsed `on:` block is EXACTLY { push: { tags: [\"v*\"] }, workflow_dispatch: {} }", () => {
    const doc = Bun.YAML.parse(RELEASE_YML) as { on: unknown };
    expect(doc.on).toEqual({ push: { tags: ["v*"] }, workflow_dispatch: {} });
  });

  test("no `push: branches` trigger -- a plain branch push must never publish", () => {
    const doc = Bun.YAML.parse(RELEASE_YML) as { on: { push?: { branches?: unknown } } };
    expect(doc.on.push?.branches).toBeUndefined();
  });

  test("the publish job's permissions are exactly packages:write and contents:read -- nothing broader", () => {
    const doc = Bun.YAML.parse(RELEASE_YML) as { jobs: Record<string, { permissions?: Record<string, string> }> };
    const jobs = Object.values(doc.jobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.permissions).toEqual({ packages: "write", contents: "read" });
  });

  test("it actually publishes via `pnpm publish -r --no-git-checks`, with NODE_AUTH_TOKEN from secrets.GITHUB_TOKEN", () => {
    expect(containsPublishCommand(RELEASE_YML)).toBe(true);
    expect(RELEASE_YML).toContain("pnpm publish -r --no-git-checks");
    expect(RELEASE_YML).toContain("NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
  });

  test("release-pack (the tarball scan) runs as a gate BEFORE the publish step", () => {
    const doc = Bun.YAML.parse(RELEASE_YML) as { jobs: Record<string, { steps: Array<{ run?: string }> }> };
    const steps = Object.values(doc.jobs)[0]!.steps;
    const runLines = steps.map((s) => s.run).filter((r): r is string => typeof r === "string");
    const packIndex = runLines.findIndex((r) => r.includes("release:pack"));
    const publishIndex = runLines.findIndex((r) => /\b(pnpm|npm)\s+publish\b/.test(r));
    expect(packIndex).toBeGreaterThanOrEqual(0);
    expect(publishIndex).toBeGreaterThan(packIndex);
  });
});

describe("release.yml is the ONLY workflow allowed to publish", () => {
  test("there are at least two workflow files, so this sweep is not vacuous", () => {
    expect(workflowFiles().length).toBeGreaterThanOrEqual(2);
    expect(workflowFiles()).toContain("release.yml");
    expect(workflowFiles()).toContain("ci.yml");
  });

  test("every OTHER workflow file's actual command text never runs pnpm/npm publish", () => {
    for (const file of workflowFiles()) {
      if (file === "release.yml") continue;
      const content = readFileSync(join(WORKFLOWS_DIR, file), "utf8");
      expect(containsPublishCommand(content)).toBe(false);
    }
  });

  test("the check above is discriminating, not vacuously true: it DOES flag a publish command when one is present", () => {
    expect(containsPublishCommand("      - run: pnpm publish -r --no-git-checks\n")).toBe(true);
    expect(containsPublishCommand("      # this comment mentions pnpm publish but never runs it\n")).toBe(false);
  });
});

describe("ci.yml's pack-smoke job (WS-02 §9 item 3)", () => {
  test("the job exists and runs on ci.yml's own top-level trigger (every push/PR), not a release tag", () => {
    const doc = Bun.YAML.parse(CI_YML) as { on: unknown; jobs: Record<string, unknown> };
    expect(doc.jobs).toHaveProperty("pack-smoke");
    expect(doc.on).toEqual(["push", "pull_request"]);
  });

  test("it runs release:pack strictly before it tries to install any tarball", () => {
    const doc = Bun.YAML.parse(CI_YML) as { jobs: Record<string, { steps: Array<{ run?: string }> }> };
    const runValues = doc.jobs["pack-smoke"]!.steps.map((s) => s.run).filter((r): r is string => typeof r === "string");
    const packIndex = runValues.findIndex((r) => r.includes("release:pack"));
    // Word-boundary-anchored: "pnpm install" (an EARLIER step) contains "npm install" as a bare
    // substring ("pnpm" = "p" + "npm") -- a plain `.includes("npm install")` matches THAT step
    // first and reports the wrong index (caught by this test itself while writing it).
    const installIndex = runValues.findIndex((r) => /(^|\s)npm install\b/.test(r));
    expect(packIndex).toBeGreaterThanOrEqual(0);
    expect(installIndex).toBeGreaterThan(packIndex);
  });

  test("it pins Node 18 explicitly and exercises both `node -e` and `bun -e`", () => {
    expect(CI_YML).toContain("node-version: 18");
    expect(CI_YML).toContain("node -e");
    expect(CI_YML).toContain("bun -e");
  });

  test("both the sdk bare import and the conformance/trace subpath import are checked under EACH runtime", () => {
    const doc = Bun.YAML.parse(CI_YML) as { jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }> };
    const steps = doc.jobs["pack-smoke"]!.steps;
    const nodeStep = steps.find((s) => s.name === "import under Node 18");
    const bunStep = steps.find((s) => s.name?.startsWith("import under Bun"));
    expect(nodeStep?.run).toContain("@yanlinglabs/winter-agent-sdk");
    expect(nodeStep?.run).toContain("@yanlinglabs/winter-conformance/trace");
    expect(bunStep?.run).toContain("@yanlinglabs/winter-agent-sdk");
    expect(bunStep?.run).toContain("@yanlinglabs/winter-conformance/trace");
  });
});

describe("WINTER_PACKAGES_TOKEN (scripts/verify-published-install.ts's gate) is EXPLICITLY ABSENT from every workflow", () => {
  test("no workflow file names the variable -- the cross-repo acceptance step never runs in CI", () => {
    for (const file of workflowFiles()) {
      const content = readFileSync(join(WORKFLOWS_DIR, file), "utf8");
      expect(content).not.toContain("WINTER_PACKAGES_TOKEN");
    }
  });
});
