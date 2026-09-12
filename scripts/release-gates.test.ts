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
//   3. ci.yml's `pack-smoke` + `pack-smoke-node18` jobs (WS-02 §9 item 3) exist, run on every push
//      (ci.yml's own top-level trigger, not gated behind a release tag), and together cover both
//      Node 18 and Bun via the one shared `scripts/smoke-installed.ts` (fix round 2, review r1
//      Important-4) -- which packs, scans, installs once offline, and imports every publishable
//      package's full exports map internally.
//
// Absence is the one that genuinely needs a test, for the same reason ci-gates.test.ts's own header
// gives: a workflow that never publishes and one that was never SUPPOSED to look identical in a
// diff, and only a test tells them apart.
import { describe, test, expect, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { discoverPublishablePackages } from "./release-pack.ts";
import { npmExpectedSet, npmHarnessSet, npmPublishSet, npmRequiredClosure } from "./npm-publish-set.ts";
import { npmPublishArgs } from "./publish-npm-set.ts";

const WORKFLOWS_DIR = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
const RELEASE_YML_PATH = join(WORKFLOWS_DIR, "release.yml");
const RELEASE_YML = readFileSync(RELEASE_YML_PATH, "utf8");
const CI_YML = readFileSync(join(WORKFLOWS_DIR, "ci.yml"), "utf8");

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
}

/**
 * P9a-3: is this publishable package BIN-ONLY (no `exports` at all, only a `bin` field)? Today: the
 * darwin-arm64 platform package. Several gates below exist to police a JS package's `exports`/`bun`
 * condition drifting from what it ships (S.2's whole reason for a `prepack` guard) -- properties that
 * do not apply to a package with no `exports` map to drift in the first place.
 */
function isBinOnly(pkg: { packageJsonPath: string }): boolean {
  const manifest = JSON.parse(readFileSync(pkg.packageJsonPath, "utf8")) as { exports?: unknown; bin?: unknown };
  return manifest.exports === undefined && manifest.bin !== undefined;
}

/** Strips a trailing `#...` comment (YAML or shell -- both use `#`), keyed on the `#` being preceded by start-of-line or whitespace so it never eats a real token. */
function stripComment(line: string): string {
  const idx = line.search(/(^|\s)#/);
  return idx === -1 ? line : line.slice(0, idx);
}

/** True iff the file's ACTUAL command text (comments stripped) runs `pnpm publish` or `npm publish` anywhere -- not merely mentions the word "publish" in prose. */
/**
 * Does this step's `run` actually PUBLISH? (P7a pre-publish r3.)
 *
 * The two jobs no longer share a command: job 1 uses `pnpm publish -r`, and job 2 uses
 * `scripts/publish-npm-set.ts`, which runs `npm publish <tarball> --provenance` per package because
 * pnpm's recursive publish silently drops `--provenance` (review I1). Assertions about ordering and
 * gating must recognise BOTH, or they quietly stop applying to the job that changed -- which is how a
 * release gate rots.
 */
/**
 * The COMMAND lines of a step's `run`, with shell comments and blank lines dropped.
 *
 * A multi-line `run` carries prose, and prose contains words: the round-4 adjacency check matched
 * `rm ` inside "the round-3 form went GREEN", and called a step that only computes an output a step
 * that might delete `dist`. Ordering assertions must read what the step DOES.
 */
const commandLines = (run: string): string =>
  run
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
    .join("\n");

const IS_PUBLISH_STEP = (run: string): boolean => /\bpnpm publish\b/.test(run) || run.includes("publish-npm-set.ts");

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

  test("each publish job's permissions are exactly what that registry needs -- nothing broader", () => {
    // TWO PUBLISH JOBS since the pre-publish round (item 5), with DIFFERENT minimal grants:
    // `packages: write` is GitHub Packages' and stays there; `id-token: write` is npm provenance's
    // and exists only on the npm job. Neither has the other's -- which is the whole reason they are
    // separate jobs. P9a-4 adds a THIRD job, `build-platform`, which publishes nothing and therefore
    // carries no elevated permissions at all (the default token grant, unstated here).
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    expect(Object.keys(doc.jobs)).toEqual(["build-platform", "publish", "publish-npm"]);
    expect(doc.jobs["build-platform"]?.permissions).toBeUndefined();
    expect(doc.jobs["publish"]?.permissions).toEqual({ packages: "write", contents: "read" });
    expect(doc.jobs["publish-npm"]?.permissions).toEqual({ "id-token": "write", contents: "read" });
  });

  test("it actually publishes via `pnpm publish -r --no-git-checks`, with NODE_AUTH_TOKEN from secrets.GITHUB_TOKEN", () => {
    expect(containsPublishCommand(RELEASE_YML)).toBe(true);
    expect(RELEASE_YML).toContain("pnpm publish -r --no-git-checks");
    expect(RELEASE_YML).toContain("NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
  });

  // --- P7a fix wave r2 (item 2, re-review N2): the compiled emit is built EXPLICITLY ---------------
  //
  // Both workflows relied on a SIDE EFFECT. In ci.yml, `bun test` and the consumer-fixture `tsc` both
  // resolve through a package's `types` condition -- `./dist/*.d.ts` since the emit -- and only
  // compiled because some earlier test happened to build; that is how the merge's focused run failed
  // once and passed on re-run. In release.yml, `releasePack()` builds (so the smokes pass), but
  // `pnpm publish` does not go through `releasePack()` at all: it packs each workspace package from
  // whatever is on disk. Both are now explicit steps, in a pinned POSITION -- a step that exists but
  // runs after the thing it feeds is the same bug with a step in it.
  test("ci.yml's build job runs `bun run build:packages` BEFORE `bun test` and before the consumer-fixture tsc", () => {
    const doc = Bun.YAML.parse(CI_YML) as WorkflowDoc;
    const runs = doc.jobs["build"]!.steps.map((s) => s.run ?? "");
    const buildAt = runs.findIndex((r) => r.startsWith("bun run build:packages"));
    const testAt = runs.findIndex((r) => r.startsWith("bun test"));
    const fixtureAt = runs.findIndex((r) => r.includes("tsconfig.winter.json"));
    expect(buildAt, "ci.yml's build job must run `bun run build:packages`").toBeGreaterThanOrEqual(0);
    expect(testAt).toBeGreaterThanOrEqual(0);
    expect(fixtureAt).toBeGreaterThanOrEqual(0);
    expect(buildAt).toBeLessThan(testAt);
    expect(buildAt).toBeLessThan(fixtureAt);
  });

  // --- P7a fix wave r3 (F1): EVERY dist-consuming job, DERIVED --------------------------------------
  //
  // Round 2's two assertions above and below name their jobs by hand -- `build` and release.yml's
  // single publish job -- and that hand-list is what let F1 through: item 1 made `compile()`'s dist
  // guard unconditional in the same round, which turned a THIRD job (`official-fixture-compile`) red
  // while these gates looked elsewhere. So the set of jobs that need a build is now COMPUTED from the
  // steps themselves, and each is judged against what its own steps actually resolve.
  //
  // Two shapes need `dist`, and one deliberately does not:
  //   * the consumer-fixture tsc (`tsconfig.winter.json`) -- its `paths` replaces the inherited map,
  //     so every transitive workspace specifier resolves through `types` -> `./dist/*.d.ts`;
  //   * `bun test`, which runs `compile-fixtures.test.ts` and `bun-required.test.ts` (both build in
  //     `beforeAll`, but the step should not depend on that);
  //   * `compile-official-fixture.ts` -- NEEDS NO BUILD: its generated tsconfig points
  //     `@sdk-under-test` at the installed OFFICIAL declarations and reaches no winter package, which
  //     `compile-fixtures.test.ts` proves by running it with every `dist` deleted.

  /**
   * A step that resolves a winter package through its `types` condition, i.e. needs `dist` on disk.
   *
   * `tsconfig.winter` matches BOTH consumer-fixture configs (P7a pre-publish item 3 added
   * `tsconfig.winter-dist.json`, which resolves `@sdk-under-test` through the BUILT declarations and
   * therefore needs `dist` even harder than its sibling). A prefix rather than two exact names, so a
   * third `tsconfig.winter-*.json` is covered on arrival -- the hand-list is what let F1 through.
   * `tsconfig.official.json` is deliberately NOT matched: it reaches no winter package.
   */
  const NEEDS_DIST = (run: string): boolean => run.includes("tsconfig.winter") || run.startsWith("bun test");
  /** A step that calls a `compile()` consumer but needs no `dist` -- recorded so its absence is a DECISION. */
  const COMPILE_CONSUMER_NO_DIST = (run: string): boolean => run.includes("compile-official-fixture.ts");

  test("F1: every job with a dist-consuming step builds first -- derived from the steps, never a hand-listed pair", () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const [file, yml] of [["ci.yml", CI_YML], ["release.yml", RELEASE_YML]] as const) {
      const doc = Bun.YAML.parse(yml) as WorkflowDoc;
      for (const [jobName, job] of Object.entries(doc.jobs)) {
        const runs = job.steps.map((s) => s.run ?? "");
        const firstConsumer = runs.findIndex(NEEDS_DIST);
        if (firstConsumer === -1) continue;
        checked++;
        const buildAt = runs.findIndex((r) => r.startsWith("bun run build:packages"));
        if (buildAt === -1 || buildAt >= firstConsumer) {
          offenders.push(`${file}:${jobName} -- first dist-consuming step is [${firstConsumer}] "${runs[firstConsumer]}", build is ${buildAt === -1 ? "ABSENT" : `at [${buildAt}]`}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // Not vacuous: ci.yml's `build` and release.yml's publish job both qualify today.
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  test("item 3: BOTH workflows compile the fixture against the BUILT declarations, after the build", () => {
    // The `dist`-typed fixture is the one gate that crosses `tsc --emitDeclarationOnly` +
    // `rewriteDeclarationSpecifiers` -- the link an installed consumer resolves and no other gate
    // touches. Asserted in both files, and after the build, since it needs `dist` by construction.
    for (const [file, yml, jobName] of [["ci.yml", CI_YML, "build"], ["release.yml", RELEASE_YML, "publish"]] as const) {
      const doc = Bun.YAML.parse(yml) as WorkflowDoc;
      const job = doc.jobs[jobName]!;
      const runs = job.steps.map((s) => s.run ?? "");
      const distFixtureAt = runs.findIndex((r) => r.includes("tsconfig.winter-dist.json"));
      expect([file, distFixtureAt >= 0]).toEqual([file, true]);
      const buildAt = runs.findIndex((r) => r.startsWith("bun run build:packages"));
      expect([file, buildAt < distFixtureAt]).toEqual([file, true]);
      // ...and the SOURCE-typed sibling is still there: the two prove different things.
      expect([file, runs.some((r) => r.includes("tsconfig.winter.json"))]).toEqual([file, true]);
    }
  });

  test("F1: `official-fixture-compile` calls a `compile()` consumer and deliberately has NO build step", () => {
    // THE JOB ROUND 2 BROKE, named. Its step needs no `dist` -- asserted as a fact here so a future
    // change that adds one to that path fails BY NAME, and so that the missing build reads as a
    // decision rather than an omission. `compile-fixtures.test.ts` proves the claim by running this
    // job's exact entry with every `dist` deleted.
    const doc = Bun.YAML.parse(CI_YML) as WorkflowDoc;
    const job = doc.jobs["official-fixture-compile"];
    expect(job, "ci.yml must still have the official-fixture-compile job").toBeDefined();
    const runs = job!.steps.map((s) => s.run ?? "");
    expect(runs.some(COMPILE_CONSUMER_NO_DIST)).toBe(true);
    expect(runs.some(NEEDS_DIST), "official-fixture-compile must not acquire a dist-consuming step without a build").toBe(false);
    expect(runs.some((r) => r.startsWith("bun run build:packages"))).toBe(false);
  });

  test("F1: every `compile()` consumer in either workflow is classified -- a new one cannot be silently unjudged", () => {
    // The two predicates above are only as good as their coverage of the scripts that call
    // `compile()`. This enumerates them from the SOURCE and requires each to be named by one
    // predicate or the other, so a third caller added later fails here rather than in CI.
    const consumers = ["scripts/compile-official-fixture.ts"]; // + compile-fixtures.test.ts, which runs under `bun test`
    for (const consumer of consumers) {
      const src = readFileSync(fileURLToPath(new URL(`../${consumer}`, import.meta.url)), "utf8");
      expect([consumer, /from "\.\/compile-fixtures\.ts"/.test(src)]).toEqual([consumer, true]);
      const step = `bun run ${consumer}`;
      expect([consumer, NEEDS_DIST(step) || COMPILE_CONSUMER_NO_DIST(step)]).toEqual([consumer, true]);
    }
  });

  test("r4 (N3): BOTH publish jobs build the emit before their gates and leave nothing between build and publish", () => {
    // Widened from job 1 only. Job 2 satisfies the property intrinsically -- `publish-npm-set.ts`
    // calls `releasePack()`, which builds before packing -- but "satisfied intrinsically" is a claim
    // about today's implementation, and this test is the place it should be written down.
    //
    // P9a-4: named explicitly rather than `Object.entries(doc.jobs)` over ALL of them -- `build-platform`
    // is a THIRD job now, and it builds the RUNTIME BINARY (`build-runtime.ts`), never the JS emit
    // (`build:packages`), and publishes nothing at all; it is pinned separately (its own describe).
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    for (const jobName of ["publish", "publish-npm"] as const) {
      const job = doc.jobs[jobName]!;
      const jobRuns = job.steps.map((s) => s.run ?? "");
      const build = jobRuns.map((r) => r.startsWith("bun run build:packages")).lastIndexOf(true);
      const publish = jobRuns.findIndex(IS_PUBLISH_STEP);
      expect([jobName, build >= 0]).toEqual([jobName, true]);
      expect([jobName, publish >= 0]).toEqual([jobName, true]);
      expect([jobName, build < publish]).toEqual([jobName, true]);
      for (const between of jobRuns.slice(build + 1, publish)) {
        const commands = commandLines(between);
        expect([jobName, commands, /build:packages|\brm\b|\bdist\b|pnpm pack|npm pack/.test(commands)]).toEqual([jobName, commands, false]);
      }
    }
  });

  test("release.yml builds the emit explicitly BEFORE its own gates AND immediately before the publish", () => {
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    const runs = doc.jobs["publish"]!.steps.map((s) => s.run ?? "");
    const firstBuild = runs.findIndex((r) => r.startsWith("bun run build:packages"));
    const lastBuild = runs.map((r) => r.startsWith("bun run build:packages")).lastIndexOf(true);
    const testAt = runs.findIndex((r) => r.startsWith("bun test"));
    const fixtureAt = runs.findIndex((r) => r.includes("tsconfig.winter.json"));
    const publishAt = runs.findIndex(IS_PUBLISH_STEP);
    expect(firstBuild, "release.yml must build the compiled emit explicitly, never as a smoke step's side effect").toBeGreaterThanOrEqual(0);
    expect(publishAt).toBeGreaterThanOrEqual(0);
    // Its own gate sequence resolves through `types` -> `./dist/*.d.ts`, exactly as ci.yml's does.
    expect(firstBuild).toBeLessThan(testAt);
    expect(firstBuild).toBeLessThan(fixtureAt);
    // ...and the bytes that SHIP are built LAST, with nothing between the build and the publish that
    // could rewrite or remove `dist`. Fourteen steps run between the FIRST build and the publish, so
    // a plain "build precedes publish" ordering would be satisfied by a stale tree.
    //
    // WIDENED in round 3 from "exactly adjacent" to "nothing in between touches dist": job 1 gained a
    // read-only `check-already-published` step there (the §5 re-drive report). Adjacency was a proxy
    // for the real property; naming the property directly is what lets a read-only step sit there.
    expect(lastBuild).toBeLessThan(publishAt);
    for (const between of runs.slice(lastBuild + 1, publishAt)) {
      const commands = commandLines(between);
      expect([commands, /build:packages|\brm\b|\bdist\b|pnpm pack|npm pack/.test(commands)]).toEqual([commands, false]);
    }
  });

  test("neither workflow's build step is silenced -- no continue-on-error on it", () => {
    for (const yml of [CI_YML, RELEASE_YML]) {
      const doc = Bun.YAML.parse(yml) as WorkflowDoc;
      for (const job of Object.values(doc.jobs)) {
        for (const step of job.steps) {
          if ((step.run ?? "").startsWith("bun run build:packages")) expect(step["continue-on-error"]).toBeUndefined();
        }
      }
    }
  });

  test("scripts/smoke-installed.ts (which packs + scans internally) runs as a gate BEFORE the publish step", () => {
    const doc = Bun.YAML.parse(RELEASE_YML) as { jobs: Record<string, { steps: Array<{ run?: string }> }> };
    const steps = doc.jobs["publish"]!.steps;
    const runLines = steps.map((s) => s.run).filter((r): r is string => typeof r === "string");
    const smokeIndex = runLines.findIndex((r) => r.includes("smoke-installed.ts"));
    const publishIndex = runLines.findIndex((r) => /\b(pnpm|npm)\s+publish\b/.test(r));
    expect(smokeIndex).toBeGreaterThanOrEqual(0);
    expect(publishIndex).toBeGreaterThan(smokeIndex);
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

// Shared shape for the handful of tests below that need to inspect `continue-on-error` and `with`
// at both the job and step level.
interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  ["continue-on-error"]?: boolean;
}
interface WorkflowJob {
  steps: WorkflowStep[];
  ["continue-on-error"]?: boolean;
  /** P7a pre-publish (item 5): the two publish jobs carry different, minimal grants. */
  permissions?: Record<string, string>;
  /** P7a pre-publish (item 5): the npm job's dependency on the GitHub Packages job. */
  needs?: string | string[];
}
interface WorkflowDoc {
  on: unknown;
  jobs: Record<string, WorkflowJob>;
}

describe("ci.yml's pack-smoke jobs (WS-02 §9 item 3; the Node18/Bun split is R-7a-16, fix round 1)", () => {
  test("both jobs exist and run on ci.yml's own top-level trigger (every push/PR), not a release tag", () => {
    const doc = Bun.YAML.parse(CI_YML) as WorkflowDoc;
    expect(doc.jobs).toHaveProperty("pack-smoke");
    expect(doc.jobs).toHaveProperty("pack-smoke-node18");
    expect(doc.on).toEqual(["push", "pull_request"]);
  });

  test("R-7a-16 REVERSED (P7a fix wave, item 1): pack-smoke-node18 is BLOCKING -- no continue-on-error anywhere on it", () => {
    // This test used to assert `continue-on-error: true`, and its inversion IS the deliverable: the
    // compiled emit landed, so the Node leg is a real gate rather than a disclosed carry. Asserted
    // at the JOB level and on every STEP, because a step-level flag would silence it just as well.
    const doc = Bun.YAML.parse(CI_YML) as WorkflowDoc;
    const job = doc.jobs["pack-smoke-node18"]!;
    expect(job["continue-on-error"]).toBeUndefined();
    for (const step of job.steps) expect(step["continue-on-error"]).toBeUndefined();
  });

  test("R-7a-16: pack-smoke (the Bun leg) stays BLOCKING -- no continue-on-error on the job or on any of its steps", () => {
    const doc = Bun.YAML.parse(CI_YML) as WorkflowDoc;
    const job = doc.jobs["pack-smoke"]!;
    expect(job["continue-on-error"]).toBeUndefined();
    for (const step of job.steps) expect(step["continue-on-error"]).toBeUndefined();
  });

  // review r1 (Important-4): both jobs now call the ONE shared scripts/smoke-installed.ts, which
  // packs, scans, installs (one offline npm install), and imports EVERY publishable package's full
  // exports map internally -- deriveImportTargets()'s own test (scripts/smoke-installed.test.ts)
  // proves that coverage property; these YAML-level tests only need to prove each job invokes the
  // right script with the right --runtime flag, since the coverage itself is no longer expressible
  // as grep-able inline `node -e`/`bun -e` text.
  test("pack-smoke-node18 pins Node 18 explicitly and calls smoke-installed.ts --runtime=node; pack-smoke has NO setup-node and calls it --runtime=bun", () => {
    const doc = Bun.YAML.parse(CI_YML) as WorkflowDoc;
    const node18Job = doc.jobs["pack-smoke-node18"]!;
    const setupNode = node18Job.steps.find((s) => s.uses?.startsWith("actions/setup-node"));
    expect(setupNode?.with).toEqual({ "node-version": 18 });
    expect(node18Job.steps.some((s) => s.run?.includes("smoke-installed.ts") && s.run?.includes("--runtime=node"))).toBe(true);

    const bunJob = doc.jobs["pack-smoke"]!;
    expect(bunJob.steps.some((s) => s.uses?.startsWith("actions/setup-node"))).toBe(false);
    expect(bunJob.steps.some((s) => s.run?.includes("smoke-installed.ts") && s.run?.includes("--runtime=bun"))).toBe(true);
  });

  test("the Node18 job's own step name records that R-7a-16 was REVERSED, not silently dropped", () => {
    // The advisory name said "advisory until the compiled emit lands". Now it has to say the
    // opposite, in the same place, so a reader of the workflow learns the state of the carry from
    // the workflow rather than from a report.
    const doc = Bun.YAML.parse(CI_YML) as WorkflowDoc;
    const names = doc.jobs["pack-smoke-node18"]!.steps.map((s) => s.name).filter((n): n is string => typeof n === "string");
    expect(names.some((n) => n.toUpperCase().includes("BLOCKING") && n.includes("R-7a-16"))).toBe(true);
    expect(names.some((n) => n.toLowerCase().includes("advisory"))).toBe(false);
  });
});

// --- P7a pre-publish (items 5 + 6): the DUAL-REGISTRY release, and the version gate ---------------
describe("release.yml publishes to BOTH registries, npm second and token-gated", () => {
  test("the trigger set is UNCHANGED -- adding a second registry must not widen what can publish", () => {
    // Asserted first and separately: everything else in this describe is about a NEW publish path,
    // and the one property that must not move while adding one is what fires the workflow at all.
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    expect(doc.on).toEqual({ push: { tags: ["v*"] }, workflow_dispatch: {} });
  });

  test("there are exactly two PUBLISH jobs (plus the P9a-4 build job), and the npm one DEPENDS on GitHub Packages succeeding", () => {
    // Order matters in one direction only: npm is the registry a version can never be taken back
    // from, so it must not run until the recoverable one has succeeded.
    //
    // P9a-4: a third job, `build-platform`, exists to produce the darwin-arm64 binary -- it publishes
    // nothing (pinned separately below) and BOTH publish jobs now `needs` it too.
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    expect(Object.keys(doc.jobs)).toEqual(["build-platform", "publish", "publish-npm"]);
    expect(doc.jobs["publish"]?.needs).toBe("build-platform");
    expect(doc.jobs["publish-npm"]?.needs).toEqual(["publish", "build-platform"]);
  });

  test("the npm publish is TOKEN-GATED, so a missing NPM_TOKEN never blocks the GitHub Packages publish", () => {
    // `if:` cannot read `secrets` in a job-level condition, so the secret is lifted into `env` on the
    // step and the condition tests that -- which is also why this is a step gate, not a job gate.
    // With no token the step is SKIPPED (green) and the other registry has already published.
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    const step = doc.jobs["publish-npm"]!.steps.find((s) => IS_PUBLISH_STEP(s.run ?? ""))!;
    expect(step).toBeDefined();
    expect(String((step as unknown as { if?: unknown }).if ?? "")).toContain("env.NPM_TOKEN");
    expect(JSON.stringify((step as unknown as { env?: unknown }).env ?? {})).toContain("secrets.NPM_TOKEN");
    // The GitHub Packages job's own publish carries NO such gate -- it is the leg that must always run.
    const ghStep = doc.jobs["publish"]!.steps.find((s) => IS_PUBLISH_STEP(s.run ?? ""))!;
    expect((ghStep as unknown as { if?: unknown }).if).toBeUndefined();
  });

  test("r3: the npm publish carries `--access public` and `--provenance`, and NO `--registry` at all", () => {
    // REWRITTEN in round 3, and every change here is a correction of something this test used to
    // assert wrongly:
    //   * it read the YAML STRING, which is why `--provenance` "passing" meant nothing -- pnpm's
    //     recursive publish drops the flag. The effective command now comes from the script.
    //   * it required `--registry https://registry.npmjs.org`, which does NOT choose the registry for
    //     a scoped package (`--registry` sets only `registries.default`; the scope binding outranks
    //     it). Passing it would be harmless but misleading, so it is asserted ABSENT: the registry is
    //     chosen by `actions/setup-node`'s scope binding, and `publish-routing.test.ts` proves that
    //     with a real dry-run rather than a string.
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    const job = doc.jobs["publish-npm"]!;
    const args = npmPublishArgs("/tmp/example.tgz");
    expect(args).toContain("--provenance");
    expect(args).toContain("--access");
    expect(args).toContain("public");
    expect(args.join(" ")).not.toContain("--registry");
    // `--provenance` is the ONLY reason this job has id-token, and only this job has it.
    expect(job.permissions).toEqual({ "id-token": "write", contents: "read" });
  });

  test("item 5 / R-7b-5: the npm set is DATA, and it is EXACTLY the closure of {wrapper} + {harness roots}", () => {
    // npm gets what an out-of-repo consumer installs and nothing else. Two kinds of ROOT:
    //   * THE WRAPPER -- `npm install @yanlinglabs/winter-agent-sdk` must work;
    //   * THE HARNESS ROOTS (R-7b-5) -- `@yanlinglabs/winter-runtime-sdk` lives in its own repository
    //     and needs both conformance harnesses as dev dependencies; without them on npm its CI would
    //     need a cross-repo `read:packages` token whose only purpose is fetching test fixtures.
    // ...and then the CLOSURE of those roots, because a published manifest pins its `dependencies` at
    // an exact version: a root on npm whose dependency is not there is an install that 404s.
    //
    // Checked in BOTH directions against that closure ALONE:
    //   * nothing in it may be MISSING -- a runtime dependency nobody flags breaks a consumer's install;
    //   * nothing outside it may be PRESENT -- a package that gains the flag by copy-paste would be
    //     published publicly, and npm cannot take a version back.
    //
    // STILL NO EXCEPTIONS MECHANISM, which is what P7a's exact-closure ruling was protecting. The
    // `harness` flag is not a list of extras: it names what a package IS, and the closure does the
    // rest. `npm: true` on a package that is neither a root nor reachable from one is a refusal.
    const flagged = npmPublishSet().map((p) => p.name).sort();
    expect(flagged).toEqual(npmExpectedSet());
    // The set as it stands, pinned so a change is a deliberate edit here too.
    //
    // P9a-3: the closure now walks `optionalDependencies` too (M3's exact bug: the wrapper's
    // optional dependency on the darwin-arm64 platform package must be ON npm, or a consumer's
    // install names a package that 404s forever). That widens the closure by exactly one package.
    expect(npmExpectedSet()).toEqual([
      "@yanlinglabs/winter-agent-sdk",
      "@yanlinglabs/winter-agent-sdk-darwin-arm64",
      "@yanlinglabs/winter-conformance",
      "@yanlinglabs/winter-provider-catalog",
      "@yanlinglabs/winter-provider-conformance",
      "@yanlinglabs/winter-provider-runtime",
    ]);
    // The two roles stay distinct: `provider-runtime` is on npm BY CLOSURE (provider-conformance
    // imports values from it), never by being a harness.
    expect(npmHarnessSet()).toEqual(["@yanlinglabs/winter-conformance", "@yanlinglabs/winter-provider-conformance"]);
    // The wrapper's OWN closure (no harness roots) now includes its optionalDependency, sorted.
    expect(npmRequiredClosure(undefined, ["@yanlinglabs/winter-agent-sdk"])).toEqual([
      "@yanlinglabs/winter-agent-sdk",
      "@yanlinglabs/winter-agent-sdk-darwin-arm64",
      "@yanlinglabs/winter-provider-catalog",
    ]);
  });

  test("R-7b-5: the harness ROOTS are exactly the two conformance packages, by name", () => {
    // Named, because "which packages are roots" is the judgement R-7b-5 actually made and the one
    // easiest to widen by accident. The PREVIOUS form of this test asserted the two harnesses were
    // NOT on npm; the ruling reversed that, and the property worth keeping is the narrower one: the
    // flag says what a package IS, and only these two are it.
    const harness = npmHarnessSet();
    expect(harness).toEqual(["@yanlinglabs/winter-conformance", "@yanlinglabs/winter-provider-conformance"]);
    for (const name of harness) expect([name, discoverPublishablePackages().some((p) => p.name === name)]).toEqual([name, true]);
    // Every publishable package is now on npm -- which is exactly why the plants below exist: on THIS
    // tree the rule and "all of them" give the same answer, so only a synthetic tree can show it
    // refusing anything.
    expect(npmPublishSet()).toHaveLength(6);
    expect(discoverPublishablePackages()).toHaveLength(6);
    // The one package outside the publishable set is outside it for a reason that has nothing to do
    // with this flag: the PRIVATE runtime. The darwin-arm64 platform package is IN the set now
    // (P9a-3 -- R-7-2's gap is closed, CI can build the binary it needs, P9a-4).
    expect(discoverPublishablePackages().some((p) => p.name === "winter-agent-runtime")).toBe(false);
    expect(discoverPublishablePackages().some((p) => p.name.endsWith("-darwin-arm64"))).toBe(true);
  });

  // --- the PLANTS ---------------------------------------------------------------------------------
  //
  // Every assertion above is evaluated against the ONE tree the rule was written for, where it now
  // selects every publishable package -- so "flagged equals the closure" is currently
  // indistinguishable from "flagged equals everything", and a rule nobody has seen REFUSE is not a
  // rule. These drive the same functions over synthetic trees (the `check-release-version.test.ts`
  // fixture-root pattern) where the right answer is known AND different from "all of them".
  describe("the closure rule is falsifiable: synthetic trees where it must refuse", () => {
    interface FixturePkg {
      dir: string;
      name: string;
      deps?: string[];
      devDeps?: string[];
      npm?: boolean;
      harness?: boolean;
    }
    const madeRoots: string[] = [];
    function fixtureRoot(packages: FixturePkg[]): string {
      const root = mkdtempSync(join(tmpdir(), "winter-npmset-"));
      madeRoots.push(root);
      for (const pkg of packages) {
        mkdirSync(join(root, "packages", pkg.dir), { recursive: true });
        writeFileSync(
          join(root, "packages", pkg.dir, "package.json"),
          JSON.stringify(
            {
              name: pkg.name,
              version: "0.0.0",
              publishConfig: { access: "restricted" },
              ...(pkg.deps ? { dependencies: Object.fromEntries(pkg.deps.map((d) => [d, "workspace:*"])) } : {}),
              ...(pkg.devDeps ? { devDependencies: Object.fromEntries(pkg.devDeps.map((d) => [d, "workspace:*"])) } : {}),
              winter: { publish: { ...(pkg.npm !== undefined ? { npm: pkg.npm } : {}), ...(pkg.harness ? { harness: true } : {}) } },
            },
            null,
            2,
          ),
        );
      }
      return `${root}/`;
    }
    afterAll(() => {
      for (const root of madeRoots) rmSync(root, { recursive: true, force: true });
    });

    test("a HARNESS's own runtime dependency is REQUIRED -- the five-not-four correction, on a tree where it is not everything", () => {
      // The exact shape this repository has: a harness importing a package the wrapper does not.
      // Under closure-of-roots `@t/lib` is required; under a closure-UNION-list rule it is not, and
      // `npm install @t/harness` 404s on it. `@t/unrelated` is the control that keeps the expected
      // answer from being "all of them".
      const root = fixtureRoot([
        { dir: "w", name: "@t/wrapper", deps: ["@t/cat"] },
        { dir: "c", name: "@t/cat" },
        { dir: "h", name: "@t/harness", deps: ["@t/lib"], harness: true },
        { dir: "l", name: "@t/lib" },
        { dir: "x", name: "@t/unrelated" },
      ]);
      expect(npmHarnessSet(root)).toEqual(["@t/harness"]);
      expect(npmRequiredClosure(root, ["@t/wrapper", ...npmHarnessSet(root)])).toEqual(["@t/cat", "@t/harness", "@t/lib", "@t/wrapper"]);
    });

    test("REFUSAL 1 (the LEAK direction): a package flagged `npm` that is neither a root nor reachable from one", () => {
      const root = fixtureRoot([
        { dir: "w", name: "@t/wrapper", deps: ["@t/cat"], npm: true },
        { dir: "c", name: "@t/cat", npm: true },
        { dir: "x", name: "@t/unrelated", npm: true }, // the copy-pasted flag
      ]);
      const flagged = npmPublishSet(root).map((p) => p.name).sort();
      const expected = npmRequiredClosure(root, ["@t/wrapper", ...npmHarnessSet(root)]);
      expect(flagged).toEqual(["@t/cat", "@t/unrelated", "@t/wrapper"]);
      expect(expected).toEqual(["@t/cat", "@t/wrapper"]);
      expect(flagged).not.toEqual(expected); // ...which is the failure the real gate reports
    });

    test("REFUSAL 2 (the 404 direction): a root's dependency that nobody flagged is MISSING", () => {
      const root = fixtureRoot([
        { dir: "w", name: "@t/wrapper", deps: ["@t/cat"], npm: true },
        { dir: "c", name: "@t/cat" }, // publishable, depended on, NOT flagged
      ]);
      const flagged = npmPublishSet(root).map((p) => p.name).sort();
      const expected = npmRequiredClosure(root, ["@t/wrapper", ...npmHarnessSet(root)]);
      expect(flagged).toEqual(["@t/wrapper"]);
      expect(expected).toEqual(["@t/cat", "@t/wrapper"]);
      expect(flagged).not.toEqual(expected);
    });

    test("`devDependencies` never widen the set -- the question is what a consumer needs at RUN time", () => {
      const root = fixtureRoot([
        { dir: "w", name: "@t/wrapper", devDeps: ["@t/tooling"], npm: true },
        { dir: "t", name: "@t/tooling" },
      ]);
      expect(npmRequiredClosure(root, ["@t/wrapper"])).toEqual(["@t/wrapper"]);
    });
  });

  test("item 5 (ruling): the npm job FILTERS by the data -- no package name is spelled in the YAML", () => {
    // A name in the workflow would be a second copy of the manifests' own fact, and the one that
    // drifts. The job computes the filters from `scripts/npm-publish-set.ts` at run time.
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    const job = doc.jobs["publish-npm"]!;
    const runs = job.steps.map((s) => s.run ?? "");
    expect(runs.some((r) => r.includes("npm-publish-set.ts"))).toBe(true);
    // No publishable package name appears anywhere in the workflow's own text.
    for (const pkg of discoverPublishablePackages()) expect([pkg.name, RELEASE_YML.includes(pkg.name)]).toEqual([pkg.name, false]);
  });

  // --- P7a pre-publish round 2 (items 9-11) --------------------------------------------------------
  test("item 9: MIT across the WHOLE repo -- every manifest, publishable or private, and a LICENSE beside each", () => {
    // "Whole repo" means the private packages too: a package that is never published still carries a
    // licence for anyone reading the source, and a missing one on the private runtime would be the
    // first thing a lawyer asks about. The publishable five additionally SHIP the file.
    const roots = readdirSync(fileURLToPath(new URL("../packages", import.meta.url)), { withFileTypes: true });
    const manifests = [fileURLToPath(new URL("../package.json", import.meta.url))];
    const walk = (relative: string): void => {
      const abs = fileURLToPath(new URL(`../${relative}/package.json`, import.meta.url));
      if (existsSync(abs)) manifests.push(abs);
    };
    for (const entry of roots) {
      if (!entry.isDirectory()) continue;
      walk(`packages/${entry.name}`);
      for (const nested of readdirSync(fileURLToPath(new URL(`../packages/${entry.name}`, import.meta.url)), { withFileTypes: true })) {
        if (nested.isDirectory()) walk(`packages/${entry.name}/${nested.name}`);
      }
    }
    expect(manifests.length).toBeGreaterThanOrEqual(7); // root + 6 packages + the platform package
    for (const path of manifests) {
      const manifest = JSON.parse(readFileSync(path, "utf8")) as { name?: string; license?: string };
      expect([manifest.name ?? path, manifest.license]).toEqual([manifest.name ?? path, "MIT"]);
    }
    // The root file itself, and one in every publishable package.
    const rootLicense = readFileSync(fileURLToPath(new URL("../LICENSE", import.meta.url)), "utf8");
    expect(rootLicense).toContain("MIT License");
    expect(rootLicense).toContain("yanlingLabs");
    for (const pkg of discoverPublishablePackages()) {
      const own = readFileSync(join(pkg.dir, "LICENSE"), "utf8");
      expect([pkg.name, own]).toEqual([pkg.name, rootLicense]); // the SAME licence, not a variant
      const manifest = JSON.parse(readFileSync(pkg.packageJsonPath, "utf8")) as { files: string[] };
      expect([pkg.name, manifest.files.includes("LICENSE")]).toEqual([pkg.name, true]);
    }
  });

  test("item 9: provider-catalog's NOTICE survives and its README points at it", () => {
    // The third-party attribution for the upstream catalog data is a different document from the
    // licence, and the one that would be quietly lost by "we added a LICENSE, done".
    const dir = discoverPublishablePackages().find((p) => p.name === "@yanlinglabs/winter-provider-catalog")!.dir;
    expect(readFileSync(join(dir, "NOTICE"), "utf8").length).toBeGreaterThan(0);
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    expect(readme).toContain("## License");
    expect(readme).toContain("NOTICE");
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { files: string[] };
    expect(manifest.files).toEqual(expect.arrayContaining(["NOTICE", "PROVENANCE.md"]));
  });

  test("item 10: every publishable manifest carries the provenance prerequisites", () => {
    // npm provenance VERIFIES the repository URL against the workflow's own origin, so a missing or
    // wrong `repository` is not a metadata nicety -- it fails `--provenance` at publish time, after
    // the GitHub Packages leg has already succeeded.
    for (const pkg of discoverPublishablePackages()) {
      const manifest = JSON.parse(readFileSync(pkg.packageJsonPath, "utf8")) as {
        repository?: { type?: string; url?: string; directory?: string };
        homepage?: string;
        bugs?: { url?: string };
      };
      expect([pkg.name, manifest.repository?.type]).toEqual([pkg.name, "git"]);
      expect([pkg.name, manifest.repository?.url]).toEqual([pkg.name, "git+https://github.com/yanlingLabs/winter-agent-sdk.git"]);
      // `directory` is what makes each package's npm page link at its own subtree, and it must name
      // the real one -- derived from the package's own path, never a literal repeated five times.
      const expectedDir = pkg.dir.replace(/\/$/, "").split("/packages/")[1]!;
      expect([pkg.name, manifest.repository?.directory]).toEqual([pkg.name, `packages/${expectedDir}`]);
      expect([pkg.name, manifest.homepage]).toEqual([pkg.name, "https://github.com/yanlingLabs/winter-agent-sdk"]);
      expect([pkg.name, manifest.bugs?.url]).toEqual([pkg.name, "https://github.com/yanlingLabs/winter-agent-sdk/issues"]);
    }
  });

  test("item 11: the ROOT README documents both registries, the dist-only contract, and the licence", () => {
    const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
    expect(readme).toContain("### From public npm");
    expect(readme).toContain("@yanlinglabs:registry=https://npm.pkg.github.com");
    expect(readme).toContain("read:packages");
    expect(readme).toContain("COMPILED OUTPUT ONLY");
    expect(readme).toContain("## License");
    expect(readme).toContain("MIT");
    // The sentence the ruling replaced must be gone everywhere -- the repo is about to be public, so
    // "source is visible on npm" is both wrong and the wrong thing to advertise.
    expect(readme).not.toContain("source-visible");
  });

  test("item 7: every publishable package SHIPS a README that documents BOTH registries honestly", () => {
    // npm renders each package's own README, so the install instructions have to be per package --
    // and they have to say the RIGHT thing for that package. The discriminator is DERIVED from
    // `npmPublishSet()` rather than spelled, so it kept working when R-7b-5 moved all five packages
    // onto npm: the "### From public npm" heading must be present exactly for the packages that are
    // there, and the "GitHub Packages only" sentence exactly for the ones that are not (today: none,
    // and the branch stays because a package leaving the npm set must re-earn its README).
    const npmNames = new Set(npmPublishSet().map((p) => p.name));
    for (const pkg of discoverPublishablePackages()) {
      const manifest = JSON.parse(readFileSync(pkg.packageJsonPath, "utf8")) as { files: string[] };
      expect([pkg.name, manifest.files.includes("README.md")]).toEqual([pkg.name, true]);
      const readme = readFileSync(join(pkg.dir, "README.md"), "utf8");
      expect([pkg.name, readme.includes("## Install")]).toEqual([pkg.name, true]);
      // GitHub Packages needs the scope pinned AND an authenticated read -- both, in every README.
      expect([pkg.name, readme.includes("@yanlinglabs:registry=https://npm.pkg.github.com")]).toEqual([pkg.name, true]);
      expect([pkg.name, readme.includes("read:packages")]).toEqual([pkg.name, true]);
      // ITEM 11: the DIST-ONLY sentence, and the source pointed at GitHub.
      expect([pkg.name, readme.includes("COMPILED OUTPUT ONLY")]).toEqual([pkg.name, true]);
      expect([pkg.name, readme.includes("github.com/yanlingLabs/winter-agent-sdk")]).toEqual([pkg.name, true]);
      // R4 (M1): no README may point a reader at a "registry pin" -- the committed `.npmrc` pins
      // nothing and `publishConfig.registry` is gone from every manifest. Round 2's N1 named this
      // sentence and it was fixed in ONE README; a third copy must not be able to survive the next
      // removal, so the sweep is over all five rather than a hand-check.
      expect([pkg.name, /registry pin/i.test(readme)]).toEqual([pkg.name, false]);
      expect([pkg.name, /`publishConfig`[^.\n]*registry|registry[^.\n]*`publishConfig`/i.test(readme)]).toEqual([pkg.name, false]);
      // Item 9: a licence section per package.
      expect([pkg.name, readme.includes("## License")]).toEqual([pkg.name, true]);
      // And the PUBLIC-npm section is present exactly for the packages that are on npm.
      //
      // Keyed on the SECTION HEADING, not on `npm install <name>`: that command is how you install
      // from GitHub Packages too (the registry is chosen by `.npmrc`, not by the verb), so matching
      // the command would call every README an npm README. The heading is the claim being made.
      expect([pkg.name, readme.includes("### From public npm")]).toEqual([pkg.name, npmNames.has(pkg.name)]);
      if (!npmNames.has(pkg.name)) {
        expect([pkg.name, readme.includes("GitHub Packages only")]).toEqual([pkg.name, true]);
        // ...and it must not tell a reader the public registry has it.
        expect([pkg.name, readme.includes("registry.npmjs.org")]).toEqual([pkg.name, false]);
      } else {
        expect([pkg.name, readme.includes(`npm install ${pkg.name}`)]).toEqual([pkg.name, true]);
      }
    }
  });

  test("r3 (I2): no README claims a path SHIPS that the package's own `files` does not include", () => {
    // REPLACES an exact-phrase denylist, and that shape is the finding. Round 2 asserted the absence
    // of two literal sentences ("tarballs contain `src/`", "source-visible"), so it could only ever
    // catch the two the implementer had already rewritten by hand -- and three other phrasings of the
    // same false claim survived, one of them pointing the reader at the very `files` field that
    // disproved it. These files SHIP, and are what a registry renders on the package page.
    //
    // The property, instead: a README may not say a top-level path ships unless `files` includes it.
    // Derived per package, so it holds for any phrasing and for paths nobody has thought of yet.
    // R4 (M5): backticks are OPTIONAL, and the negation skip is per CLAUSE, not per line. Round 3
    // skipped any line containing `no`/`not`/`never` outright and only saw backticked paths, so both
    // "There is no ambiguity: the tarballs ship `src/` as well." and "the tarballs ship the src/
    // directory" passed -- demonstrated by the reviewer. A docs gate is still a heuristic (RELEASING.md
    // says so), but these two evasions are closed.
    const SHIPPING_CLAIM = /(?:ship|ships|shipped|contains?|included?|are in)\b[^.\n]{0,80}?`?([a-zA-Z0-9_.-]+)\/`?/g;
    for (const pkg of discoverPublishablePackages()) {
      const manifest = JSON.parse(readFileSync(pkg.packageJsonPath, "utf8")) as { files: string[] };
      const shipped = new Set(manifest.files.filter((f) => !f.startsWith("!")).map((f) => f.replace(/\/$/, "")));
      const readme = readFileSync(join(pkg.dir, "README.md"), "utf8");
      // Sentences that DENY a path ships are the point of the dist-only paragraph -- skip them, or
      // the fix reads as the violation.
      const claims: string[] = [];
      for (const line of readme.split("\n")) {
        // Split into CLAUSES first (`:` `;` `,` and the em dash this repo's prose uses), so a
        // negation in one clause cannot excuse an assertion in another.
        for (const clause of line.split(/[:;,]|—|--/)) {
          if (/\bnot\b|\bno\b|never/i.test(clause)) continue;
          SHIPPING_CLAIM.lastIndex = 0;
          for (let m = SHIPPING_CLAIM.exec(clause); m !== null; m = SHIPPING_CLAIM.exec(clause)) {
            const path = m[1]!;
            if (!shipped.has(path)) claims.push(`${path}/ -- "${clause.trim().slice(0, 120)}"`);
          }
        }
      }
      expect([pkg.name, claims]).toEqual([pkg.name, []]);
      // Not vacuous, in BOTH spellings and against the two evasions the review demonstrated.
      //
      // The plant path deliberately contains no `not`/`no`/`never` as a WORD: `-` is a non-word
      // character, so a name like `zzz-not-shipped` would trip the negation filter on its own text --
      // which is itself a true statement about the heuristic's limit, recorded in RELEASING.md, and
      // not what these three plants are measuring.
      for (const plant of [
        "The published tarballs ship `zzz-absent/` as well.",
        "The published tarballs ship the zzz-absent/ directory as well.",
        "There is no ambiguity: the published tarballs ship `zzz-absent/` as well.",
      ]) {
        const caught: string[] = [];
        for (const clause of plant.split(/[:;,]|—|--/)) {
          if (/\bnot\b|\bno\b|never/i.test(clause)) continue;
          SHIPPING_CLAIM.lastIndex = 0;
          for (let m = SHIPPING_CLAIM.exec(clause); m !== null; m = SHIPPING_CLAIM.exec(clause)) {
            if (!shipped.has(m[1]!)) caught.push(m[1]!);
          }
        }
        expect([plant, caught]).toEqual([plant, ["zzz-absent"]]);
      }
    }
  });

  test("r3 (I2): no README names a NON-npm package as being on npm -- derived, not spot-checked", () => {
    // The finding: both harness READMEs still listed the pre-ruling THREE-package npm set, naming
    // `winter-provider-runtime` as "on public npm as well". These files SHIP in the tarballs, and the
    // item-7 discriminators could not see the sentence -- they check what a README says about ITSELF,
    // not what it says about other packages.
    //
    // Derived from `npmPublishSet()`, so the assertion moves with the data: any publishable package
    // that is NOT on npm must never appear near an npm claim in any README.
    const npmNames = new Set(npmPublishSet().map((p) => p.name));
    const nonNpm = discoverPublishablePackages().map((p) => p.name).filter((name) => !npmNames.has(name));

    // A sentence that both names a non-npm package and claims npm carriage, on one line or across a
    // wrapped paragraph -- so the check survives reflowing.
    const NPM_CLAIM = /(on|to|from)\s+(public\s+)?npm|npm install|registry\.npmjs\.org/i;

    // R-7b-5 EMPTIED `nonNpm`: every publishable package is on npm now, so the sweep below is
    // vacuously true on this tree. The scanner still has to be shown WORKING, or it will have rotted
    // silently by the time a package leaves the set again -- so it is planted here against a
    // synthetic README and a synthetic non-npm name. (The original finding it exists for: both
    // harness READMEs listed a three-package npm set naming `winter-provider-runtime` as "on public
    // npm as well" -- a claim about ANOTHER package, which the item-7 discriminators cannot see.)
    const plantReadme = "The `@t/gh-only` package is available on public npm as well.\n\n`@t/gh-only` is GitHub Packages only.";
    const plantParagraphs = plantReadme.split(/\n\s*\n/).filter((para) => para.includes("@t/gh-only"));
    expect(plantParagraphs.map((para) => NPM_CLAIM.test(para))).toEqual([true, false]);
    for (const pkg of discoverPublishablePackages()) {
      const readme = readFileSync(join(pkg.dir, "README.md"), "utf8");
      const paragraphs = readme.split(/\n\s*\n/);
      for (const name of nonNpm) {
        for (const paragraph of paragraphs) {
          if (!paragraph.includes(name)) continue;
          // The package's OWN README may of course say "npm install <itself>" for the GitHub
          // Packages install -- the registry is chosen by `.npmrc`, not by the verb.
          if (pkg.name === name && paragraph.includes(`npm install ${name}`)) continue;
          const claims = NPM_CLAIM.test(paragraph);
          expect(
            [pkg.name, name, claims ? paragraph.trim().slice(0, 200) : ""],
          ).toEqual([pkg.name, name, ""]);
        }
      }
    }
  });

  test("r3 (I1): every JS publishable package refuses a non-pnpm packer, and RELEASING.md says why (bin-only packages carry no prepack guard -- S.2's decision, see below)", () => {
    // The measured failure: `npm pack` IGNORES `publishConfig.exports`, so an npm-packed tarball keeps
    // `"bun": "./src/index.ts"` while `files` ships no `src/` -- it installs and imports fine under
    // NODE and dies under BUN, which is the runtime this SDK is built for. No gate could see it
    // (`releasePack` shells out to `pnpm pack`; CI never runs `npm pack`), and against registries
    // where a version can never be re-published, prose is the wrong instrument.
    //
    // The guard runs under `npm pack` AND `npm publish`, passes under pnpm (how both release jobs and
    // `releasePack()` pack), and never reaches a consumer: pnpm strips `scripts` from the packed
    // manifest, which the packed-manifest test asserts.
    //
    // P9a-3 (S.2's decision, recorded here rather than silently relaxed): the darwin-arm64 platform
    // package is BIN-ONLY -- it declares no `exports`/`publishConfig.exports` at all, so there is no
    // `bun`-condition-vs-`files` drift for a non-pnpm packer to introduce, which is this guard's ENTIRE
    // stated reason. `pnpm pack`/`npm pack` behave identically for a manifest with no `exports`
    // override to apply or skip. It carries no `prepack` script, checked explicitly (never a
    // guard that would apply to nothing) so a future JS entry point added to this package without one
    // is still caught by every OTHER assertion in this describe.
    for (const pkg of discoverPublishablePackages()) {
      const manifest = JSON.parse(readFileSync(pkg.packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
      if (isBinOnly(pkg)) {
        expect([pkg.name, manifest.scripts?.["prepack"]]).toEqual([pkg.name, undefined]);
        continue;
      }
      const prepack = manifest.scripts?.["prepack"];
      expect([pkg.name, prepack !== undefined]).toEqual([pkg.name, true]);
      expect([pkg.name, prepack!.includes("npm_config_user_agent")]).toEqual([pkg.name, true]);
      expect([pkg.name, prepack!.includes("pnpm")]).toEqual([pkg.name, true]);
      // The error has to EXPLAIN, not just refuse: the reader is holding a tarball that would look
      // fine to them under Node.
      expect([pkg.name, /Bun/.test(prepack!)]).toEqual([pkg.name, true]);
      expect([pkg.name, prepack!.includes("RELEASING.md")]).toEqual([pkg.name, true]);
    }
    const releasing = readFileSync(fileURLToPath(new URL("../RELEASING.md", import.meta.url)), "utf8");
    expect(releasing).toContain("pnpm");
    expect(releasing).toContain("Cannot find module");        // the measured Bun failure, spelled out
    expect(releasing).toContain("workflow_dispatch");          // the re-drive
    expect(releasing).toContain("Do not bump the version");
    expect(releasing).toContain("check-release-version.ts");   // the version/tag gate
    // ...and the root README points at it, or nobody finds it.
    expect(readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8")).toContain("RELEASING.md");
  });

  test("r3 (I3): every package whose source carries the grok-build derivation SHIPS the root NOTICE", () => {
    // The asymmetry the review found, inverted: the NOTICE that attributes a real Apache-2.0 upstream
    // shipped in nothing and was referenced by nothing, while provider-catalog's -- whose own first
    // paragraph disclaims all third-party source -- shipped and was pinned.
    //
    // Derived from the SOURCE, so a third package that later carries the derivation is covered: any
    // publishable package mentioning the upstream must ship a NOTICE identical to the root one and
    // name it from its README's License section.
    const rootNotice = readFileSync(fileURLToPath(new URL("../NOTICE", import.meta.url)), "utf8");
    expect(rootNotice).toContain("grok-build");
    expect(rootNotice).toContain("Apache");
    let carriers = 0;
    for (const pkg of discoverPublishablePackages()) {
      const sources = Bun.spawnSync(["git", "grep", "-l", "grok-build", "--", "src"], { cwd: pkg.dir, stdout: "pipe" });
      const derives = new TextDecoder().decode(sources.stdout).trim().length > 0;
      const manifest = JSON.parse(readFileSync(pkg.packageJsonPath, "utf8")) as { files: string[] };
      const readme = readFileSync(join(pkg.dir, "README.md"), "utf8");
      if (!derives) continue;
      carriers++;
      expect([pkg.name, manifest.files.includes("NOTICE")]).toEqual([pkg.name, true]);
      expect([pkg.name, readFileSync(join(pkg.dir, "NOTICE"), "utf8")]).toEqual([pkg.name, rootNotice]);
      expect([pkg.name, readme.includes("NOTICE")]).toEqual([pkg.name, true]);
      expect([pkg.name, /Apache/.test(readme)]).toEqual([pkg.name, true]);
    }
    // Not vacuous, and the two the review named.
    expect(carriers).toBeGreaterThanOrEqual(2);
    // The root README names it too -- it is the only place a reader looking for licences starts.
    const rootReadme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
    expect(rootReadme).toContain("./NOTICE");
    expect(rootReadme).toContain("grok-build");
  });

  test("r3 (M1): no WORKFLOW file carries the replaced source-visibility claim either", () => {
    // The item-11 sweep ran over READMEs only, so `release.yml`'s copy of the exact sentence -- the
    // literal phrase the report called "gone everywhere" -- survived. Extended to the files this test
    // already reads.
    for (const [name, yml] of [["ci.yml", CI_YML], ["release.yml", RELEASE_YML]] as const) {
      expect([name, /source-visible/.test(yml)]).toEqual([name, false]);
      expect([name, /tarballs ship `src\/`/.test(yml)]).toEqual([name, false]);
    }
  });

  test("r3: the npm job carries a RUNBOOK for the failure it can actually have", () => {
    // Review §5's ordering constraints, written where an operator reading a red job will find them.
    // The three that are not derivable from the YAML: do not bump (re-drive at the same tag), the
    // secret must exist before the tag, and never hand-pack with plain `npm` (round-2 concern 1 --
    // `npm pack` ignores the `publishConfig` overrides that make the tarballs dist-only).
    const npmJobText = RELEASE_YML.slice(RELEASE_YML.indexOf("publish-npm:"));
    expect(npmJobText).toContain("workflow_dispatch` at the SAME tag");
    expect(npmJobText).toContain("DO NOT bump the version");
    expect(npmJobText).toContain("BEFORE the tag is pushed");
    expect(npmJobText).toContain("`npm pack` IGNORES");
  });

  test("item 7: no README leaks a literal token -- the auth lines are env-expanded", () => {
    for (const pkg of discoverPublishablePackages()) {
      const readme = readFileSync(join(pkg.dir, "README.md"), "utf8");
      expect([pkg.name, /_authToken=(?!\$\{)/.test(readme)]).toEqual([pkg.name, false]);
      expect([pkg.name, /ghp_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}/.test(readme)]).toEqual([pkg.name, false]);
    }
  });

  test("r3 (C1): `publishConfig.access` stays `restricted` for every JS package, and NO manifest pins a `registry`", () => {
    // `access` stays: it is GitHub Packages' setting, and npm's own default for a scoped package
    // would be restricted too, which the free plan cannot do -- so the npm leg's `--access public` is
    // load-bearing rather than redundant.
    //
    // `registry` is GONE, and its absence is the fix. pnpm's recursive publish rebuilds npm's argv as
    // `publishConfig.registry ?? pickRegistryForPackage(...)` and DISCARDS the operator's
    // `--registry`, so a pinned registry sent both npm-set packages to GitHub Packages -- the npm leg
    // could never reach npm. This assertion used to REQUIRE the field; inverting it is the fix.
    //
    // P9a-3: the darwin-arm64 platform package is the ONE deliberate exception, `access: "public"`
    // verbatim (the Interfaces block) -- job 1's `pnpm publish -r` sends it to GitHub Packages exactly
    // like every other package regardless of this field's value (GitHub Packages does not gate on
    // npm's public/restricted distinction the way npmjs.org's free plan does), and job 2 already
    // passes `--access public` on the CLI for every npm-set package, overriding the manifest either
    // way -- so this is a documented divergence, not a behavior difference for either publish job.
    for (const pkg of discoverPublishablePackages()) {
      const manifest = JSON.parse(readFileSync(pkg.packageJsonPath, "utf8")) as { publishConfig?: Record<string, unknown> };
      expect([pkg.name, "registry" in (manifest.publishConfig ?? {})]).toEqual([pkg.name, false]);
      if (isBinOnly(pkg)) {
        expect([pkg.name, manifest.publishConfig?.["access"]]).toEqual([pkg.name, "public"]);
        continue;
      }
      expect([pkg.name, manifest.publishConfig?.["access"]]).toEqual([pkg.name, "restricted"]);
    }
  });

  test("r3 (C1/C2/M3): the committed `.npmrc` pins NO registry and carries NO token line at all", () => {
    // ANOTHER INVERTED ASSERTION, and the same fix. This used to REQUIRE
    // `@yanlinglabs:registry=https://npm.pkg.github.com` as a "safe default" -- and that line beat the
    // npm job's own `--registry` at both the pnpm and the npm layer (`pickRegistryForPackage` and
    // `pickRegistry` both consult the SCOPE before the default), so every "npm" publish resolved to
    // GitHub Packages. A committed pin is global; there are two registries; each job now binds its own
    // through `actions/setup-node`, which supplies the matching credential in the same file.
    //
    // The `${NODE_AUTH_TOKEN}` line went with it: it authenticated nothing locally and made every
    // pnpm invocation in the repo print a config WARN (M3).
    const npmrc = readFileSync(fileURLToPath(new URL("../.npmrc", import.meta.url)), "utf8");
    expect(npmrc).not.toMatch(/^\s*@yanlinglabs:registry=/m);
    expect(npmrc).not.toMatch(/^\s*[^#\n]*_authToken=/m);
    expect(npmrc).not.toMatch(/^\s*registry=/m);
    expect(npmrc).not.toMatch(/npm_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}/);
    // The file survives so the reasoning has somewhere to live -- the next person to reach for a pin
    // reads why it was removed. A silently deleted file teaches nobody.
    expect(npmrc).toContain("PINS NO REGISTRY AND NO TOKEN");
  });

  test("r3 (C2): each publish job binds its OWN registry and credential through setup-node", () => {
    // The mechanism that replaced the committed pin, and the one that gives job 1 a GitHub Packages
    // credential AT ALL -- before this round nothing read `NODE_AUTH_TOKEN` (pnpm has no such
    // plumbing) and there was no `_authToken` line anywhere, so the first tag push would have failed
    // with ENEEDAUTH and published nothing.
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    const expected = [
      ["publish", "https://npm.pkg.github.com", "secrets.GITHUB_TOKEN"],
      ["publish-npm", "https://registry.npmjs.org", "secrets.NPM_TOKEN"],
    ] as const;
    for (const [jobName, registryUrl, secret] of expected) {
      const job = doc.jobs[jobName]!;
      const setupNode = job.steps.find((step) => (step.uses ?? "").startsWith("actions/setup-node"))!;
      expect([jobName, setupNode !== undefined]).toEqual([jobName, true]);
      const withBlock = (setupNode as unknown as { with?: Record<string, unknown> }).with ?? {};
      expect([jobName, withBlock["registry-url"]]).toEqual([jobName, registryUrl]);
      // `scope` is what makes setup-node write `@yanlinglabs:registry=<url>` rather than only the
      // default -- without it the binding this whole design rests on is not created.
      expect([jobName, withBlock["scope"]]).toEqual([jobName, "@yanlinglabs"]);
      // ...and the credential for THAT registry, from THAT job's secret.
      const publishStep = job.steps.find((step) => /pnpm publish|publish-npm-set\.ts/.test(step.run ?? ""))!;
      expect([jobName, JSON.stringify((publishStep as unknown as { env?: unknown }).env ?? {})]).toEqual([
        jobName,
        expect.stringContaining(secret) as unknown as string,
      ]);
    }
  });

  test("r3 (I1): the npm job publishes PER TARBALL with `npm publish`, because pnpm drops `--provenance`", () => {
    // pnpm's recursive publish forwards only `--access`/`--dry-run`/`--force`/`--otp`; `--provenance`
    // is recognised (so it does not error) and silently dropped, which meant `id-token: write` was
    // granted and never used while the YAML-text assertion kept passing. The flags now live in
    // `scripts/publish-npm-set.ts`, where they reach npm.
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    const job = doc.jobs["publish-npm"]!;
    const runs = job.steps.map((step) => step.run ?? "");
    expect(runs.some((r) => r.includes("publish-npm-set.ts"))).toBe(true);
    expect(runs.some((r) => r.includes("pnpm publish"))).toBe(false); // NOT pnpm, in this job
    // The effective command, read from the script rather than the YAML.
    expect(npmPublishArgs("/tmp/x.tgz")).toEqual(["npm", "publish", "/tmp/x.tgz", "--provenance", "--access", "public"]);
    // ...and job 1 keeps pnpm's recursive publish, which is correct for it: no provenance is claimed.
    const ghRuns = doc.jobs["publish"]!.steps.map((step) => step.run ?? "");
    expect(ghRuns.some((r) => r.startsWith("pnpm publish -r --no-git-checks"))).toBe(true);
    expect(doc.jobs["publish"]!.permissions?.["id-token"]).toBeUndefined();
    expect(doc.jobs["publish-npm"]!.permissions?.["id-token"]).toBe("write");
  });

  test("r3 (M1): the npm set reaches the publish through `$GITHUB_OUTPUT`, never a `$(…)` substitution", () => {
    // A failing substitution inside the command used to degrade it to an unfiltered, non-recursive
    // `pnpm publish` in the workspace root -- which fails, because the root is private, but for a
    // reason unrelated to what went wrong. A step that cannot produce its output fails as itself.
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    const steps = doc.jobs["publish-npm"]!.steps;
    const idStep = steps.find((step) => (step as unknown as { id?: string }).id === "npm-set")!;
    expect(idStep).toBeDefined();
    expect(idStep.run).toContain("$GITHUB_OUTPUT");
    expect(idStep.run).toContain("npm-publish-set.ts");
    // R4 (M3): and it FAILS on an empty output. `set -e` does not fire on a failed command
    // substitution inside a simple command's argument, so the round-3 form went GREEN with nothing --
    // the comment claimed "a step that cannot produce its output fails as itself" and it did not.
    // Assigned on its own line (where `set -e` does fire) and then checked explicitly.
    expect(idStep.run).toMatch(/ARGS="\$\(bun run scripts\/npm-publish-set\.ts/);
    expect(idStep.run).toMatch(/if \[ -z "\$ARGS" \]/);
    expect(idStep.run).toContain("exit 1");
    const publishStep = steps.find((step) => (step.run ?? "").includes("publish-npm-set.ts"))!;
    expect(publishStep.run).toContain("steps.npm-set.outputs");
    expect(publishStep.run).not.toContain("$(");
  });

  test("r3 (§5): BOTH jobs consult their own registry for versions it already has", () => {
    // Idempotent re-drive: a half-done release is finished by a `workflow_dispatch` at the SAME tag,
    // never by a version bump (which would leave the tag naming something other than what shipped,
    // since both registries refuse a version they already hold).
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    const ghRuns = doc.jobs["publish"]!.steps.map((step) => step.run ?? "");
    expect(ghRuns.some((r) => r.includes("check-already-published.ts") && r.includes("https://npm.pkg.github.com"))).toBe(true);
    // The npm job's probe runs inside its publisher, per package, against npmjs.
    const publisher = readFileSync(fileURLToPath(new URL("../scripts/publish-npm-set.ts", import.meta.url)), "utf8");
    expect(publisher).toContain("decidePublishes");
    expect(publisher).toContain("https://registry.npmjs.org");
  });

  test("item 6: the version/tag gate runs BEFORE any publish, in BOTH jobs", () => {
    // A publish that ships the wrong number does not fail -- it succeeds, to registries where a
    // version can never be re-published. Both jobs check out afresh, so both must check.
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    for (const jobName of ["publish", "publish-npm"]) {
      const runs = doc.jobs[jobName]!.steps.map((s) => s.run ?? "");
      const gateAt = runs.findIndex((r) => r.includes("check-release-version.ts"));
      const publishAt = runs.findIndex(IS_PUBLISH_STEP);
      expect([jobName, gateAt >= 0]).toEqual([jobName, true]);
      expect([jobName, publishAt >= 0]).toEqual([jobName, true]);
      expect([jobName, gateAt < publishAt]).toEqual([jobName, true]);
    }
  });
});

// --- P9a-4: the darwin-arm64 binary, built on a macOS runner, gated before either publish ----------
describe("P9a-4: build-platform builds the darwin-arm64 binary on a real macOS arm64 runner and never publishes", () => {
  test("build-platform runs on a `macos-` labeled runner and asserts `uname -m`/`uname -s` rather than trusting the label", () => {
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    const job = doc.jobs["build-platform"]!;
    expect(String((job as unknown as { ["runs-on"]?: unknown })["runs-on"] ?? "")).toMatch(/^macos-/);
    const runs = job.steps.map((s) => s.run ?? "").join("\n");
    expect(runs).toContain("uname -m");
    expect(runs).toContain("uname -s");
  });

  test("build-platform runs NO publish command -- it produces the binary, never ships it to a registry", () => {
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    const job = doc.jobs["build-platform"]!;
    for (const step of job.steps) expect(IS_PUBLISH_STEP(step.run ?? "")).toBe(false);
    // The general sweep (containsPublishCommand, comment-stripped) agrees, over the job's own text.
    const jobText = RELEASE_YML.slice(RELEASE_YML.indexOf("build-platform:"), RELEASE_YML.indexOf("publish:"));
    expect(containsPublishCommand(jobText)).toBe(false);
  });

  test("build-platform stages the binary via `bun run scripts/build-runtime.ts --platform-package` and uploads ONE artifact", () => {
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    const job = doc.jobs["build-platform"]!;
    const runs = job.steps.map((s) => s.run ?? "");
    expect(runs.some((r) => r.includes("build-runtime.ts") && r.includes("--platform-package"))).toBe(true);
    const upload = job.steps.find((s) => s.uses?.startsWith("actions/upload-artifact"));
    expect(upload).toBeDefined();
    expect((upload as unknown as { with?: { name?: string } })?.with?.name).toBe("winter-darwin-arm64");
  });

  test("both publish jobs restore + verify the binary (test -x, Mach-O arm64, sha256) BEFORE their own gates and BEFORE the publish step", () => {
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    for (const jobName of ["publish", "publish-npm"] as const) {
      const runs = doc.jobs[jobName]!.steps.map((s) => s.run ?? "");
      const download = doc.jobs[jobName]!.steps.findIndex((s) => s.uses?.startsWith("actions/download-artifact"));
      const restoreAt = runs.findIndex((r) => r.includes("shasum -a 256 -c"));
      const gateAt = runs.findIndex((r) => r.includes("check-release-version.ts"));
      const publishAt = runs.findIndex(IS_PUBLISH_STEP);
      expect([jobName, download >= 0]).toEqual([jobName, true]);
      expect([jobName, restoreAt >= 0]).toEqual([jobName, true]);
      expect([jobName, restoreAt < gateAt]).toEqual([jobName, true]);
      expect([jobName, restoreAt < publishAt]).toEqual([jobName, true]);
      // The three checks the Interfaces block names, all present in the restore step's own text.
      const restoreStep = doc.jobs[jobName]!.steps.find((s) => (s.run ?? "").includes("shasum -a 256 -c"))!;
      expect([jobName, restoreStep.run]).toEqual([jobName, expect.stringContaining("test -x") as unknown as string]);
      expect([jobName, restoreStep.run]).toEqual([jobName, expect.stringContaining("Mach-O 64-bit executable arm64") as unknown as string]);
      expect([jobName, restoreStep.run]).toEqual([jobName, expect.stringContaining("chmod +x") as unknown as string]);
    }
  });

  test("ci.yml carries the SAME macOS build job (minus the tag pin), on every push, and it never publishes", () => {
    const doc = Bun.YAML.parse(CI_YML) as WorkflowDoc;
    const job = doc.jobs["build-platform"];
    expect(job).toBeDefined();
    expect(String((job as unknown as { ["runs-on"]?: unknown })["runs-on"] ?? "")).toMatch(/^macos-/);
    const runs = job!.steps.map((s) => s.run ?? "");
    expect(runs.some((r) => r.includes("uname -m"))).toBe(true);
    expect(runs.some((r) => r.includes("build-runtime.ts") && r.includes("--platform-package"))).toBe(true);
    // P9a-5: the EXECUTE path -- smoke-installed.ts --runtime=bun runs for real on a matching host.
    expect(runs.some((r) => r.includes("smoke-installed.ts") && r.includes("--runtime=bun"))).toBe(true);
    for (const step of job!.steps) expect(IS_PUBLISH_STEP(step.run ?? "")).toBe(false);
    expect(containsPublishCommand(CI_YML.slice(CI_YML.indexOf("build-platform:"), CI_YML.indexOf("\n  build:")))).toBe(false);
  });
});

describe("release.yml's own Node 18 smoke (R-7a-16): BLOCKING, as ci.yml's leg now is too", () => {
  test("the publish job has no job-level continue-on-error", () => {
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    expect(doc.jobs["publish"]?.["continue-on-error"]).toBeUndefined();
  });

  test("no step in the publish job sets continue-on-error -- including the Node 18 smoke steps specifically", () => {
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    for (const step of doc.jobs["publish"]!.steps) expect(step["continue-on-error"]).toBeUndefined();
  });

  test("it runs a Node 18 smoke via scripts/smoke-installed.ts, pinned via actions/setup-node, strictly before publish", () => {
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    const steps = doc.jobs["publish"]!.steps;
    const setupNode = steps.find((s) => s.uses?.startsWith("actions/setup-node"));
    // The `with` block gained `registry-url`/`scope` in round 3 (that is what gives this job a
    // GitHub Packages credential at all -- review C2), so the pin is on the node VERSION, which is
    // what this test is about; the routing half is asserted by its own test above.
    expect((setupNode as unknown as { with?: Record<string, unknown> })?.with?.["node-version"]).toBe(18);

    const runValues = steps.map((s) => s.run).filter((r): r is string => typeof r === "string");
    const nodeSmokeIndex = runValues.findIndex((r) => r.includes("smoke-installed.ts") && r.includes("--runtime=node"));
    const publishIndex = runValues.findIndex((r) => /\b(pnpm|npm)\s+publish\b/.test(r));
    expect(nodeSmokeIndex).toBeGreaterThanOrEqual(0);
    expect(publishIndex).toBeGreaterThan(nodeSmokeIndex);
  });

  test("the Bun leg runs too (WS-02 §9 item 3 names both runtimes), also strictly before publish", () => {
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    const steps = doc.jobs["publish"]!.steps;
    const runValues = steps.map((s) => s.run).filter((r): r is string => typeof r === "string");
    const bunSmokeIndex = runValues.findIndex((r) => r.includes("smoke-installed.ts") && r.includes("--runtime=bun"));
    const publishIndex = runValues.findIndex((r) => /\b(pnpm|npm)\s+publish\b/.test(r));
    expect(bunSmokeIndex).toBeGreaterThanOrEqual(0);
    expect(publishIndex).toBeGreaterThan(bunSmokeIndex);
  });
});

describe("WINTER_PACKAGES_TOKEN (scripts/verify-published-install.ts's gate) is EXPLICITLY ABSENT from every workflow", () => {
  test("no workflow file's ACTUAL command/expression text ever references the variable -- comments stripped, exactly like the publish-command check above, since ci.yml's own comment documents the absence BY NAME (checked separately below)", () => {
    for (const file of workflowFiles()) {
      const content = readFileSync(join(WORKFLOWS_DIR, file), "utf8");
      const liveText = content.split("\n").map(stripComment).join("\n");
      expect(liveText).not.toContain("WINTER_PACKAGES_TOKEN");
    }
  });

  test("the absence is documented in ci.yml rather than left to be re-derived, so the next reader knows it is a decision", () => {
    expect(CI_YML).toContain("verify-published-install.ts");
    expect(CI_YML).toContain("WINTER_PACKAGES_TOKEN");
    expect(CI_YML.toLowerCase()).toContain("deliberately absent");
  });
});
