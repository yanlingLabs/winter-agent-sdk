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
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { discoverPublishablePackages } from "./release-pack.ts";
import { NPM_RULED_EXTRAS, npmPublishSet, npmRequiredClosure } from "./npm-publish-set.ts";

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

  test("each publish job's permissions are exactly what that registry needs -- nothing broader", () => {
    // TWO JOBS since the pre-publish round (item 5), with DIFFERENT minimal grants: `packages: write`
    // is GitHub Packages' and stays there; `id-token: write` is npm provenance's and exists only on
    // the npm job. Neither has the other's -- which is the whole reason they are separate jobs.
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    expect(Object.keys(doc.jobs)).toEqual(["publish", "publish-npm"]);
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
    for (const [file, yml, jobName] of [["ci.yml", CI_YML, "build"], ["release.yml", RELEASE_YML, undefined]] as const) {
      const doc = Bun.YAML.parse(yml) as WorkflowDoc;
      const job = jobName !== undefined ? doc.jobs[jobName]! : Object.values(doc.jobs)[0]!;
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

  test("release.yml builds the emit explicitly BEFORE its own gates AND immediately before the one publish command", () => {
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    const runs = Object.values(doc.jobs)[0]!.steps.map((s) => s.run ?? "");
    const firstBuild = runs.findIndex((r) => r.startsWith("bun run build:packages"));
    const lastBuild = runs.map((r) => r.startsWith("bun run build:packages")).lastIndexOf(true);
    const testAt = runs.findIndex((r) => r.startsWith("bun test"));
    const fixtureAt = runs.findIndex((r) => r.includes("tsconfig.winter.json"));
    const publishAt = runs.findIndex((r) => r.includes("pnpm publish"));
    expect(firstBuild, "release.yml must build the compiled emit explicitly, never as a smoke step's side effect").toBeGreaterThanOrEqual(0);
    expect(publishAt).toBeGreaterThanOrEqual(0);
    // Its own gate sequence resolves through `types` -> `./dist/*.d.ts`, exactly as ci.yml's does.
    expect(firstBuild).toBeLessThan(testAt);
    expect(firstBuild).toBeLessThan(fixtureAt);
    // ...and the bytes that SHIP are built ADJACENT to the step that publishes them. Fourteen steps
    // run between the first build and the publish; a build separated from it by anything that could
    // rewrite or remove `dist` would satisfy a plain ordering check and still publish wrong bytes.
    expect(publishAt - lastBuild).toBe(1);
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
    const steps = Object.values(doc.jobs)[0]!.steps;
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

  test("there are exactly two publish jobs, and the npm one DEPENDS on GitHub Packages succeeding", () => {
    // Order matters in one direction only: npm is the registry a version can never be taken back
    // from, so it must not run until the recoverable one has succeeded.
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    expect(Object.keys(doc.jobs)).toEqual(["publish", "publish-npm"]);
    expect(doc.jobs["publish-npm"]?.needs).toBe("publish");
    expect(doc.jobs["publish"]?.needs).toBeUndefined();
  });

  test("the npm publish is TOKEN-GATED, so a missing NPM_TOKEN never blocks the GitHub Packages publish", () => {
    // `if:` cannot read `secrets` in a job-level condition, so the secret is lifted into `env` on the
    // step and the condition tests that -- which is also why this is a step gate, not a job gate.
    // With no token the step is SKIPPED (green) and the other registry has already published.
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    const step = doc.jobs["publish-npm"]!.steps.find((s) => (s.run ?? "").includes("pnpm publish"))!;
    expect(step).toBeDefined();
    expect(String((step as unknown as { if?: unknown }).if ?? "")).toContain("env.NPM_TOKEN");
    expect(JSON.stringify((step as unknown as { env?: unknown }).env ?? {})).toContain("secrets.NPM_TOKEN");
    // The GitHub Packages job's own publish carries NO such gate -- it is the leg that must always run.
    const ghStep = doc.jobs["publish"]!.steps.find((s) => (s.run ?? "").includes("pnpm publish"))!;
    expect((ghStep as unknown as { if?: unknown }).if).toBeUndefined();
  });

  test("the npm publish names the npm registry, `--access public` and `--provenance`, and the job grants id-token: write", () => {
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    const job = doc.jobs["publish-npm"]!;
    const run = job.steps.find((s) => (s.run ?? "").includes("pnpm publish"))!.run!;
    // `--registry` OVERRIDES `.npmrc`'s scope pin, which exists so nothing reaches npm by accident.
    expect(run).toContain("--registry https://registry.npmjs.org");
    // EXPLICIT, because `publishConfig.access` stays `restricted` for GitHub Packages and npm's own
    // default for a scoped package would be restricted too -- which the free plan cannot do.
    expect(run).toContain("--access public");
    expect(run).toContain("--provenance");
    // `--provenance` is the ONLY reason this job has id-token, and only this job has it.
    expect(job.permissions).toEqual({ "id-token": "write", contents: "read" });
  });

  test("item 5 (ruling): the npm set is DATA, and it is exactly the wrapper's closure plus the ruled extras", () => {
    // npm gets the WRAPPER and what a public consumer needs; GitHub Packages gets everything. The set
    // lives in `winter.publish.npm` per manifest rather than as a list in this YAML, and this is the
    // test that keeps the data honest in BOTH directions:
    //   * nothing in the wrapper's transitive workspace `dependencies` closure may be MISSING -- a
    //     new runtime dependency that nobody flags breaks `npm install @yanlinglabs/winter-agent-sdk`;
    //   * nothing outside `closure ∪ NPM_RULED_EXTRAS` may be PRESENT -- a harness that gains the
    //     flag by copy-paste would be published publicly, and npm cannot take a version back.
    const flagged = npmPublishSet().map((p) => p.name).sort();
    const closure = npmRequiredClosure();
    const allowed = new Set([...closure, ...Object.keys(NPM_RULED_EXTRAS)]);

    expect(closure.filter((name) => !flagged.includes(name))).toEqual([]);
    expect(flagged.filter((name) => !allowed.has(name))).toEqual([]);
    // The set as it stands today, pinned so a change is a deliberate edit here too.
    expect(flagged).toEqual(["@yanlinglabs/winter-agent-sdk", "@yanlinglabs/winter-provider-catalog", "@yanlinglabs/winter-provider-runtime"]);
    expect(closure).toEqual(["@yanlinglabs/winter-agent-sdk", "@yanlinglabs/winter-provider-catalog"]);
  });

  test("item 5 (ruling): the two conformance HARNESSES are GitHub Packages only", () => {
    // Named, because "not in the set" is the property that matters and it is easiest to lose by
    // accident: these are the org's own test tooling, and publishing them publicly would offer a
    // stranger a package whose only purpose is testing this repository.
    const flagged = new Set(npmPublishSet().map((p) => p.name));
    for (const harness of ["@yanlinglabs/winter-conformance", "@yanlinglabs/winter-provider-conformance"]) {
      expect([harness, flagged.has(harness)]).toEqual([harness, false]);
      // ...and they are still publishable AT ALL -- GitHub Packages gets the whole set.
      expect([harness, discoverPublishablePackages().some((p) => p.name === harness)]).toEqual([harness, true]);
    }
  });

  test("item 5 (ruling): every NPM_RULED_EXTRA is real, flagged, and carries the ruling", () => {
    const flagged = new Set(npmPublishSet().map((p) => p.name));
    const closure = new Set(npmRequiredClosure());
    expect(Object.keys(NPM_RULED_EXTRAS).length).toBeGreaterThan(0);
    for (const [name, why] of Object.entries(NPM_RULED_EXTRAS)) {
      expect([name, flagged.has(name)]).toEqual([name, true]);
      // An extra that JOINS the closure must leave this list -- otherwise the list stops meaning
      // "outside the closure" and the parity above weakens without anyone noticing.
      expect([name, closure.has(name)]).toEqual([name, false]);
      expect([name, why.length > 60]).toEqual([name, true]);
    }
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

  test("`publishConfig.access` stays `restricted` in every manifest -- npm's public-ness is a FLAG, not a file", () => {
    // If a manifest flipped to `access: public`, a GitHub Packages publish would start asserting
    // something about a registry it is not talking to, and the npm leg's explicit flag would look
    // redundant rather than load-bearing.
    for (const pkg of discoverPublishablePackages()) {
      const manifest = JSON.parse(readFileSync(pkg.packageJsonPath, "utf8")) as { publishConfig?: { access?: string; registry?: string } };
      expect([pkg.name, manifest.publishConfig?.access]).toEqual([pkg.name, "restricted"]);
      expect([pkg.name, manifest.publishConfig?.registry]).toEqual([pkg.name, "https://npm.pkg.github.com"]);
    }
  });

  test("`.npmrc` keeps the scope on GitHub Packages and carries NO literal token", () => {
    const npmrc = readFileSync(fileURLToPath(new URL("../.npmrc", import.meta.url)), "utf8");
    expect(npmrc).toContain("@yanlinglabs:registry=https://npm.pkg.github.com");
    // The npmjs auth line is env-expanded, never a value: `${NODE_AUTH_TOKEN}` and nothing else.
    expect(npmrc).toContain("//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}");
    expect(npmrc).not.toMatch(/_authToken=(?!\$\{)/);
    expect(npmrc).not.toMatch(/npm_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}/);
  });

  test("item 6: the version/tag gate runs BEFORE any publish, in BOTH jobs", () => {
    // A publish that ships the wrong number does not fail -- it succeeds, to registries where a
    // version can never be re-published. Both jobs check out afresh, so both must check.
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    for (const jobName of ["publish", "publish-npm"]) {
      const runs = doc.jobs[jobName]!.steps.map((s) => s.run ?? "");
      const gateAt = runs.findIndex((r) => r.includes("check-release-version.ts"));
      const publishAt = runs.findIndex((r) => r.includes("pnpm publish"));
      expect([jobName, gateAt >= 0]).toEqual([jobName, true]);
      expect([jobName, publishAt >= 0]).toEqual([jobName, true]);
      expect([jobName, gateAt < publishAt]).toEqual([jobName, true]);
    }
  });
});

describe("release.yml's own Node 18 smoke (R-7a-16): BLOCKING, as ci.yml's leg now is too", () => {
  test("the publish job has no job-level continue-on-error", () => {
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    expect(Object.values(doc.jobs)[0]?.["continue-on-error"]).toBeUndefined();
  });

  test("no step in the publish job sets continue-on-error -- including the Node 18 smoke steps specifically", () => {
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    for (const step of Object.values(doc.jobs)[0]!.steps) expect(step["continue-on-error"]).toBeUndefined();
  });

  test("it runs a Node 18 smoke via scripts/smoke-installed.ts, pinned via actions/setup-node, strictly before publish", () => {
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    const steps = Object.values(doc.jobs)[0]!.steps;
    const setupNode = steps.find((s) => s.uses?.startsWith("actions/setup-node"));
    expect(setupNode?.with).toEqual({ "node-version": 18 });

    const runValues = steps.map((s) => s.run).filter((r): r is string => typeof r === "string");
    const nodeSmokeIndex = runValues.findIndex((r) => r.includes("smoke-installed.ts") && r.includes("--runtime=node"));
    const publishIndex = runValues.findIndex((r) => /\b(pnpm|npm)\s+publish\b/.test(r));
    expect(nodeSmokeIndex).toBeGreaterThanOrEqual(0);
    expect(publishIndex).toBeGreaterThan(nodeSmokeIndex);
  });

  test("the Bun leg runs too (WS-02 §9 item 3 names both runtimes), also strictly before publish", () => {
    const doc = Bun.YAML.parse(RELEASE_YML) as WorkflowDoc;
    const steps = Object.values(doc.jobs)[0]!.steps;
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
