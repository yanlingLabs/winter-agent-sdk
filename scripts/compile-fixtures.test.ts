// P7a fix wave round 2 (item 1): SELF-CONTAINED. This file used to be order-dependent and nobody
// could see it -- `tsconfig.winter.json` maps `@sdk-under-test` onto the sdk SOURCE, which REPLACES
// the repo-wide `paths` it inherits, so every other workspace specifier the sdk reaches resolves
// through node_modules to that package's `types` condition -- `./dist/*.d.ts` since the compiled
// emit landed. On a checkout with no `dist/` it therefore compiled only if `build-packages.test.ts`
// happened to run earlier in the same `bun test`, which is exactly how the merge's focused run
// failed once and passed on re-run.
//
// So the build is this file's OWN precondition, run in `beforeAll`. `buildPackages()` is idempotent
// (it cleans and rewrites `dist` every time), and `compile()` carries the second half of the fix: a
// missing `dist` is reported in words rather than as tsc's `TS2307` pointed at a line in the sdk.
import { test, expect, beforeAll } from "bun:test";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { compile, missingDistPackages } from "./compile-fixtures.ts";
import { buildPackages } from "./build-packages.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

beforeAll(async () => {
  await buildPackages();
}, 240_000);

test("plain-query fixture compiles against the winter package (un-skipped in Task 7)", async () => {
  const r = await compile("packages/conformance/tsconfig.winter.json");
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

    const r = await compile("packages/conformance/tsconfig.winter.json");
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
