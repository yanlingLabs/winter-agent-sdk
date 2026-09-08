// P7a fix wave round 2 (item 1): SELF-CONTAINED. This file used to be order-dependent and nobody
// could see it -- `tsconfig.winter.json` maps `@sdk-under-test` onto the sdk SOURCE, which REPLACES
// the repo-wide `paths` it inherits, so every other workspace specifier the sdk reaches resolves
// through node_modules to that package's `types` condition -- `./dist/*.d.ts` since the compiled
// emit landed. On a checkout with no `dist/` it therefore compiled only if `build-packages.test.ts`
// happened to run earlier in the same `bun test`, which is exactly how the merge's focused run
// failed once and passed on re-run.
//
// So the build is this file's OWN precondition, run in `beforeAll`. `buildPackages()` is idempotent
// (it cleans and rewrites `dist` every time), and `compile({requireDist:true})` carries the second
// half: a missing `dist` is reported in words rather than as tsc's `TS2307` pointed at a line in the sdk.
//
// ROUND 3 (F1): `requireDist` is OPT-IN, and the third test below is why. Round 2 made the guard
// unconditional, and `compile()` has a SECOND caller -- `compile-official-fixture.ts` -- whose
// generated tsconfig reaches no winter package at all and whose ci.yml job (`official-fixture-compile`)
// has no build step and needs none. The guard was a false positive there and turned that job red on
// every commit of round 2, invisibly: `compileOfficialFixture` had no test, and the round's own new
// position gates inspected only ci.yml's `build` job and release.yml's single job. The last test is
// that job's exact step, run with every `dist` deleted.
//
// ROUND 4: THAT LAST TEST IS OPT-IN, and F1 stays proven locally without it. `compileOfficialFixture`
// FETCHES AND INSTALLS the pinned upstream tarball, so it is a network test, and the whole-branch
// constraint is that the default suite is hermetic -- a dropped connection has to be a skipped
// network leg, never a red suite. It is gated on the SAME harness variable as the pack+install legs
// (`WINTER_TEST_PACK_SMOKE`, item 11 N-3) rather than a second one: one flag turns on every
// network/packaging leg in the repo, and CI sets `CI` so all of them run there unchanged.
//
// What still proves F1 by default is the hermetic half, split out below: the guard is OPT-IN, so a
// caller that does not ask for it is never refused for a missing `dist`. That is the entire mechanism
// of the round-2 regression -- `compile()` refusing a caller that needs no build -- and it needs no
// network to state. The gated test adds the end-to-end confirmation through the real script entry.
import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { compile, missingDistPackages } from "./compile-fixtures.ts";
import { buildPackages } from "./build-packages.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The one harness variable for every network/packaging leg in this repo (item 11 N-3's own). */
const NETWORK_LEGS_ENABLED = (process.env["CI"] ?? "") !== "" || process.env["WINTER_TEST_PACK_SMOKE"] === "1";
if (!NETWORK_LEGS_ENABLED) {
  // PRINTED, not silent: a skipped test that says nothing is indistinguishable from a passing one.
  console.log(
    "[compile-fixtures] SKIPPING the official-fixture leg (it FETCHES and installs the pinned upstream tarball). " +
      "Run it with WINTER_TEST_PACK_SMOKE=1 bun test scripts/compile-fixtures.test.ts; CI always runs it. " +
      "F1's mechanism -- the dist guard being opt-in -- is proven hermetically by the test above it.",
  );
}

beforeAll(async () => {
  await buildPackages();
}, 240_000);

test("plain-query fixture compiles against the winter package (un-skipped in Task 7)", async () => {
  const r = await compile("packages/conformance/tsconfig.winter.json", { requireDist: true });
  expect(r.ok, r.output).toBe(true);
});

test("P7a r2: the build really is this file's precondition -- with no dist, `compile` names the fix", async () => {
  // Proves BOTH halves at once, and it is the only place the guard can be proven: `beforeAll` has
  // already built, so the dist is deleted here and rebuilt before the assertion returns. Nothing
  // else in the suite depends on `dist` mid-run (the pack/build legs are opt-in and build their own).
  const dists = ["sdk", "provider-catalog", "provider-runtime", "conformance", "provider-conformance"].map((p) => join(REPO_ROOT, "packages", p, "dist"));
  try {
    for (const dir of dists) rmSync(dir, { recursive: true, force: true });
    expect(missingDistPackages().length).toBeGreaterThan(0);

    const r = await compile("packages/conformance/tsconfig.winter.json", { requireDist: true });
    expect(r.ok).toBe(false);
    // The whole point: the operator is told what to RUN, not handed a TS2307 in a file they did not
    // touch. Named literally so a reworded message that stops saying it fails here.
    expect(r.output).toContain("bun run build:packages");
    expect(r.output).toContain("@yanlinglabs/winter-provider-catalog");
    expect(r.output).not.toContain("TS2307");
  } finally {
    await buildPackages();
  }
  // ...and the rebuild really restored it, so this test cannot leave the tree broken for another file.
  expect(missingDistPackages()).toEqual([]);
}, 300_000);

test("P7a pre-publish (item 3): the fixture compiles against the BUILT declarations, not the source", async () => {
  // THE ONE LINK NO OTHER GATE CROSSES. `tsconfig.winter.json` maps `@sdk-under-test` onto the sdk
  // SOURCE, so it proves the fixture type-checks against the sdk's AUTHORED api -- while an installed
  // consumer resolves `@yanlinglabs/winter-agent-sdk` through `types: ./dist/index.d.ts`, i.e. through
  // `tsc --emitDeclarationOnly` plus `rewriteDeclarationSpecifiers`. `smoke-installed.ts` proves the
  // emitted JS IMPORTS under both runtimes but type-checks nothing; `conformance:snapshot --check`
  // reads the upstream OFFICIAL tarball's declarations, not winter's own emit.
  //
  // `requireDist: true` because this tsconfig genuinely needs the build -- and it is the reason that
  // flag is a caller assertion rather than a property of `compile()`.
  const r = await compile("packages/conformance/tsconfig.winter-dist.json", { requireDist: true });
  expect(r.ok, r.output).toBe(true);
}, 120_000);

test("P7a pre-publish (item 3): that fixture really resolves through `dist` -- with none, it cannot find the sdk", async () => {
  // Non-vacuity, and it is the whole claim: if this still compiled with no `dist`, the tsconfig would
  // be reading the source through some inherited `paths` and proving nothing new.
  const dists = ["sdk", "provider-catalog", "provider-runtime", "conformance", "provider-conformance"].map((p) => join(REPO_ROOT, "packages", p, "dist"));
  try {
    for (const dir of dists) rmSync(dir, { recursive: true, force: true });
    // Asked WITHOUT the guard, so tsc actually runs and its own diagnostic is what we read.
    const r = await compile("packages/conformance/tsconfig.winter-dist.json");
    expect(r.ok).toBe(false);
    expect(r.output).toContain("Cannot find module '@sdk-under-test'");
  } finally {
    await buildPackages();
  }
  expect(missingDistPackages()).toEqual([]);
}, 300_000);

test("P7a r4 (F1, hermetic): with NO dist, a caller that does not ask for the guard is not refused", async () => {
  // F1's MECHANISM, with no network. The round-2 regression was `compile()` refusing a caller that
  // needs no build; `requireDist` makes the check something the CALLER asks for, so the statement to
  // prove locally is that the same missing-`dist` tree refuses one caller and not the other.
  //
  // The opt-out side compiles a throwaway tsconfig in a mkdtemp -- a self-contained file reaching no
  // winter package, which is the shape `compile-official-fixture.ts` generates -- so this asserts the
  // flag's semantics rather than re-testing tsc.
  const scratch = mkdtempSync(join(tmpdir(), "winter-compile-optout-"));
  const dists = ["sdk", "provider-catalog", "provider-runtime", "conformance", "provider-conformance"].map((p) => join(REPO_ROOT, "packages", p, "dist"));
  try {
    writeFileSync(join(scratch, "standalone.ts"), "export const answer: number = 42;\n");
    writeFileSync(
      join(scratch, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { noEmit: true, strict: true, target: "ES2022", module: "ESNext", moduleResolution: "bundler", types: [] }, files: ["standalone.ts"] }, null, 2),
    );

    for (const dir of dists) rmSync(dir, { recursive: true, force: true });
    expect(missingDistPackages().length).toBeGreaterThan(0); // the precondition really is absent

    // NO `requireDist`: the guard must not fire, and the compile must genuinely run.
    const optedOut = await compile(join(scratch, "tsconfig.json"));
    expect(optedOut.ok, optedOut.output).toBe(true);
    expect(optedOut.output).not.toContain("bun run build:packages");

    // ...while the SAME tree still refuses the caller that did ask -- the two halves of one flag,
    // asserted against one state of the world so neither can pass for the wrong reason.
    const optedIn = await compile("packages/conformance/tsconfig.winter.json", { requireDist: true });
    expect(optedIn.ok).toBe(false);
    expect(optedIn.output).toContain("bun run build:packages");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    await buildPackages();
  }
  expect(missingDistPackages()).toEqual([]);
}, 300_000);

test.skipIf(!NETWORK_LEGS_ENABLED)("P7a r3 (F1): the OFFICIAL fixture job's exact step succeeds with every `dist` deleted -- it needs no build", async () => {
  // THE REGRESSION ROUND 2 SHIPPED, as a test. `compileOfficialFixture` generates its own tsconfig
  // whose `@sdk-under-test` points at the INSTALLED OFFICIAL package's declarations and whose `files`
  // is the one fixture; the fixture imports nothing else. No winter package is reachable, so no
  // `dist` is required -- and ci.yml's `official-fixture-compile` job accordingly has no build step.
  //
  // Driven through the SCRIPT'S OWN ENTRY (`compileOfficialFixture()`), not through `compile()`, so
  // a future change that reintroduces a `dist` dependency anywhere in that path fails here rather
  // than in CI.
  //
  // NETWORK, hence gated (round 4): it fetches and installs the pinned official tarball. The
  // hermetic test above proves the same mechanism -- the guard is opt-in -- without one, so a
  // default `bun test` still fails if F1 regresses; this adds the end-to-end confirmation.
  const dists = ["sdk", "provider-catalog", "provider-runtime", "conformance", "provider-conformance"].map((p) => join(REPO_ROOT, "packages", p, "dist"));
  try {
    for (const dir of dists) rmSync(dir, { recursive: true, force: true });
    expect(missingDistPackages().length).toBeGreaterThan(0); // the precondition really is absent

    const { compileOfficialFixture } = await import("./compile-official-fixture.ts");
    const r = await compileOfficialFixture();
    expect(r.ok, r.output).toBe(true);
    // ...and specifically NOT refused by the dist guard, which is the shape of the round-2 failure.
    expect(r.output).not.toContain("bun run build:packages");
  } finally {
    await buildPackages();
  }
  expect(missingDistPackages()).toEqual([]);
}, 300_000);
