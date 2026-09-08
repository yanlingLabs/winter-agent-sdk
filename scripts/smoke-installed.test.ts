// P7a Lane C, fix round 2 (review r1): this is the AUTOMATED, PERMANENT version of the manual
// pack -> npm install --offline -> import check that caught review r1's two Critical findings. Every
// `bun test` run now re-proves what used to be a one-time manual verification: every publishable
// package's bare entry point and every declared `exports` subpath actually imports cleanly from a
// REAL, freshly packed tarball, installed into a REAL throwaway project OUTSIDE this repository --
// never through pnpm's workspace symlinks, which is exactly the gap that let review r1's Criticals
// ship green (`bun test` and "manually verified... resolve correctly" both only ever exercised the
// in-repo, workspace-resolved path).
import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { discoverPublishablePackages } from "./release-pack.ts";
import { deriveImportTargets, runSmoke, type SmokeResult } from "./smoke-installed.ts";

// --- P7a fix wave (item 11, N-3): the pack+install legs are OPT-IN outside CI --------------------
//
// `runSmoke` runs a real `pnpm pack` of five packages and a real `npm install` of the tarballs into
// a throwaway project. That is ~62 seconds, and it lands on EVERY `bun test` -- including the
// focused, single-file runs a contributor does dozens of times an hour. A suite that is slow enough
// to avoid is a suite that gets avoided, which costs more coverage than these two describes buy.
//
// WHAT IS NOT SKIPPED: `deriveImportTargets` above, which is the part that answers "is any exports
// subpath silently uncovered" and is pure. Only the two legs that shell out are gated.
//
// NOTHING IN CI CHANGES. `process.env.CI` is set on every GitHub runner, so both describes run there
// under `bun test` exactly as before -- and the pack-smoke jobs additionally invoke
// `scripts/smoke-installed.ts` DIRECTLY, which this gate cannot reach at all. The local opt-in is
// `WINTER_TEST_PACK_SMOKE=1`, a harness variable (the `WINTER_TEST_*` class the brand gate never
// treats as a product surface).
const PACK_SMOKE_ENABLED = (process.env["CI"] ?? "") !== "" || process.env["WINTER_TEST_PACK_SMOKE"] === "1";
if (!PACK_SMOKE_ENABLED) {
  // PRINTED, not silent. A skipped test that says nothing is indistinguishable from a passing one
  // in a scrollback, and this is the one gate whose absence a reader must notice.
  console.log(
    "[smoke-installed] SKIPPING the pack+install legs (~62s: pnpm pack x5 + npm install). " +
      "Run them with WINTER_TEST_PACK_SMOKE=1 bun test scripts/smoke-installed.test.ts; CI always runs them, " +
      "and the pack-smoke jobs also invoke scripts/smoke-installed.ts directly.",
  );
}

describe("deriveImportTargets", () => {
  test("every publishable package's OWN exports map is fully covered -- no subpath silently skipped", () => {
    const targets = deriveImportTargets();
    for (const pkg of discoverPublishablePackages()) {
      const manifest = JSON.parse(readFileSync(pkg.packageJsonPath, "utf8")) as { exports?: Record<string, unknown> | string };
      const exportsField = manifest.exports;
      const expectedSpecifiers =
        typeof exportsField === "object" && exportsField !== null
          ? Object.keys(exportsField).map((k) => (k === "." ? pkg.name : `${pkg.name}/${k.replace(/^\.\//, "")}`))
          : [pkg.name];
      for (const specifier of expectedSpecifiers) {
        expect(targets.some((t) => t.specifier === specifier)).toBe(true);
      }
    }
  });

  test("covers a generous floor (today: 5 packages, 10 targets total across their exports maps)", () => {
    expect(deriveImportTargets().length).toBeGreaterThanOrEqual(10);
  });

  test("every target's packageName is one of the five R-7-1 publishable packages", () => {
    const names = new Set(discoverPublishablePackages().map((p) => p.name));
    for (const target of deriveImportTargets()) expect(names.has(target.packageName)).toBe(true);
  });
});

describe.skipIf(!PACK_SMOKE_ENABLED)("runSmoke: the real pack -> install -> import cycle, under Bun (BLOCKING in ci.yml/release.yml)", () => {
  let result: SmokeResult;
  beforeAll(async () => {
    result = await runSmoke({ runtimes: ["bun"] });
  }, 120_000);

  test("every target imports cleanly -- this is the exact check that would have caught review r1's two Criticals", () => {
    expect(result.ok).toBe(true);
    expect(result.results.length).toBe(result.targets.length); // no early stop -- nothing failed
    for (const r of result.results) expect(r.ok).toBe(true);
  });

  test("specifically covers the two packages review r1 found broken: winter-conformance (+ ./official) and winter-provider-conformance (+ ./fakes)", () => {
    const specifiers = result.results.map((r) => r.specifier);
    expect(specifiers).toContain("@yanlinglabs/winter-conformance");
    expect(specifiers).toContain("@yanlinglabs/winter-conformance/official");
    expect(specifiers).toContain("@yanlinglabs/winter-provider-conformance");
    expect(specifiers).toContain("@yanlinglabs/winter-provider-conformance/fakes");
  });
});

describe.skipIf(!PACK_SMOKE_ENABLED)("runSmoke: the Node 18+ leg fails fast with the DISCLOSED, pre-existing reason (advisory in CI, blocking in release.yml)", () => {
  test("the current Node runtime cannot import ANY of them (raw TypeScript shipped, no compiled emit) -- proves the gate is honest, not that this lane broke something new", async () => {
    const result = await runSmoke({ runtimes: ["node"] });
    expect(result.ok).toBe(false);
    expect(result.results).toHaveLength(1); // fails loudly on the FIRST target, exactly as designed
    expect(result.results[0]?.ok).toBe(false);
    expect(result.results[0]?.output).toMatch(/Stripping types|Unexpected token|SyntaxError/);
  }, 60_000);
});
