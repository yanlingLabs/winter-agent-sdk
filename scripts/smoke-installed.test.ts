// P7a Lane C, fix round 2 (review r1): this is the AUTOMATED, PERMANENT version of the manual
// pack -> npm install --offline -> import check that caught review r1's two Critical findings. Every
// `bun test` run now re-proves what used to be a one-time manual verification: every publishable
// package's bare entry point and every declared `exports` subpath actually imports cleanly from a
// REAL, freshly packed tarball, installed into a REAL throwaway project OUTSIDE this repository --
// never through pnpm's workspace symlinks, which is exactly the gap that let review r1's Criticals
// ship green (`bun test` and "manually verified... resolve correctly" both only ever exercised the
// in-repo, workspace-resolved path).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPublishablePackages } from "./release-pack.ts";
import { assertInstalledTreeIsDistOnly, deriveImportTargets, runBinTarget, runSmoke, runtimesFor, type BinTarget, type SmokeResult } from "./smoke-installed.ts";

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

// P9a-5: a package with NO `exports` and a `bin` field (the darwin-arm64 platform package) is
// BIN-ONLY -- it has no importable specifier at all, so it is covered by a SEPARATE describe below
// rather than the exports-subpath property here.
function isBinOnlyPkg(pkg: { packageJsonPath: string }): boolean {
  const manifest = JSON.parse(readFileSync(pkg.packageJsonPath, "utf8")) as { exports?: unknown; bin?: unknown };
  return manifest.exports === undefined && manifest.bin !== undefined;
}

describe("deriveImportTargets", () => {
  test("every publishable package's OWN exports map is fully covered -- no subpath silently skipped", () => {
    const targets = deriveImportTargets();
    for (const pkg of discoverPublishablePackages()) {
      if (isBinOnlyPkg(pkg)) continue; // covered by the "bin targets" describe below
      const manifest = JSON.parse(readFileSync(pkg.packageJsonPath, "utf8")) as { exports?: Record<string, unknown> | string };
      const exportsField = manifest.exports;
      const expectedSpecifiers =
        typeof exportsField === "object" && exportsField !== null
          ? Object.keys(exportsField).map((k) => (k === "." ? pkg.name : `${pkg.name}/${k.replace(/^\.\//, "")}`))
          : [pkg.name];
      for (const specifier of expectedSpecifiers) {
        expect(targets.some((t) => t.kind === "import" && t.specifier === specifier)).toBe(true);
      }
    }
  });

  test("covers a generous floor (today: 5 exports-based packages, 10 targets total across their exports maps)", () => {
    expect(deriveImportTargets().filter((t) => t.kind === "import").length).toBeGreaterThanOrEqual(10);
  });

  test("every import target's packageName is one of the publishable packages", () => {
    const names = new Set(discoverPublishablePackages().map((p) => p.name));
    for (const target of deriveImportTargets()) {
      if (target.kind !== "import") continue;
      expect(names.has(target.packageName)).toBe(true);
    }
  });

  test("P9a-5: a bin-only package (no `exports`, a `bin` field) contributes exactly one BinTarget, never an ImportTarget", () => {
    const binOnly = discoverPublishablePackages().filter((p) => isBinOnlyPkg(p));
    // Not vacuous: the darwin-arm64 platform package is exactly this shape once publishable.
    expect(binOnly.length).toBeGreaterThanOrEqual(1);
    const targets = deriveImportTargets();
    for (const pkg of binOnly) {
      const matches = targets.filter((t) => (t.kind === "bin" ? t.package === pkg.name : t.packageName === pkg.name));
      expect([pkg.name, matches]).toEqual([pkg.name, [expect.objectContaining({ kind: "bin", package: pkg.name })]]);
    }
  });
});

// P9a-5's own three required cases, against a FAKE bin-only package -- never the real compiled
// `winter` binary (that leg is `smoke-installed --runtime=bun`'s real run, exercised via the
// "bin targets" describe above once the platform binary is built).
describe("runBinTarget (P9a-5)", () => {
  const dirs: string[] = [];
  function fakeBin(script: string): string {
    const dir = mkdtempSync(join(tmpdir(), "smoke-bin-target-"));
    dirs.push(dir);
    const bin = join(dir, "fake-bin");
    writeFileSync(bin, script);
    chmodSync(bin, 0o755);
    return bin;
  }
  afterAll(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("on a MATCHING platform, executes `<bin> --version` and passes when it equals the package's version", async () => {
    const bin = fakeBin("#!/bin/sh\necho 0.0.4\n");
    const target: BinTarget = { kind: "bin", package: "@t/fake-darwin-arm64", version: "0.0.4", bin, os: [process.platform], cpu: [process.arch] };
    const result = await runBinTarget(target);
    expect(result).toEqual({ ok: true, output: expect.stringContaining("OK") as unknown as string, skipped: false });
  });

  test("on a MISMATCHING os, SKIPS with the exact printed reason -- never attempts a spawn", async () => {
    const bin = fakeBin("#!/bin/sh\necho should-never-run\nexit 1\n");
    const target: BinTarget = { kind: "bin", package: "@t/fake-other-platform", version: "0.0.4", bin, os: ["definitely-not-a-real-os"], cpu: [process.arch] };
    const result = await runBinTarget(target);
    expect(result).toEqual({
      ok: true,
      skipped: true,
      output: `smoke-installed: SKIP @t/fake-other-platform (bin-only; os/cpu mismatch on ${process.platform}/${process.arch})`,
    });
  });

  test("on a MISMATCHING cpu, SKIPS the same way", async () => {
    const bin = fakeBin("#!/bin/sh\necho should-never-run\nexit 1\n");
    const target: BinTarget = { kind: "bin", package: "@t/fake-other-arch", version: "0.0.4", bin, os: [process.platform], cpu: ["definitely-not-a-real-arch"] };
    const result = await runBinTarget(target);
    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
  });

  test("a bin-only package whose bin prints the WRONG version FAILS -- never a silent pass", async () => {
    const bin = fakeBin("#!/bin/sh\necho 9.9.9\n");
    const target: BinTarget = { kind: "bin", package: "@t/fake-wrong-version", version: "0.0.4", bin, os: [process.platform], cpu: [process.arch] };
    const result = await runBinTarget(target);
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.output).toContain("9.9.9");
    expect(result.output).toContain("0.0.4");
  });

  test("a nonzero exit FAILS, distinctly from a version mismatch", async () => {
    const bin = fakeBin("#!/bin/sh\necho broken >&2\nexit 3\n");
    const target: BinTarget = { kind: "bin", package: "@t/fake-broken", version: "0.0.4", bin, os: [process.platform], cpu: [process.arch] };
    const result = await runBinTarget(target);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("exited 3");
    expect(result.output).toContain("broken");
  });

  test("no `os`/`cpu` declared at all -- matches every host (permissive fallback, never fail-closed on an absent field)", async () => {
    const bin = fakeBin("#!/bin/sh\necho 0.0.4\n");
    const target: BinTarget = { kind: "bin", package: "@t/fake-no-platform-fields", version: "0.0.4", bin };
    const result = await runBinTarget(target);
    expect(result).toEqual({ ok: true, skipped: false, output: expect.stringContaining("OK") as unknown as string });
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
    const specifiers = result.results.flatMap((r) => (r.kind === "import" ? [r.specifier] : []));
    expect(specifiers).toContain("@yanlinglabs/winter-conformance");
    expect(specifiers).toContain("@yanlinglabs/winter-conformance/official");
    expect(specifiers).toContain("@yanlinglabs/winter-provider-conformance");
    expect(specifiers).toContain("@yanlinglabs/winter-provider-conformance/fakes");
  });
});

describe.skipIf(!PACK_SMOKE_ENABLED)("runSmoke: the Node leg is GREEN since the compiled emit landed (P7a fix wave, item 1; R-7a-16 reversed)", () => {
  // THE ASSERTION THAT TRACKS THE EMIT (item 11, N-1). This block used to assert the exact opposite
  // -- that Node could import NOTHING, failing on the first target with "Stripping types" -- which
  // was the honest statement of a disclosed carry while every manifest pointed at raw `./src/*.ts`.
  // Inverting it is the deliverable: leaving the old assertion in place would have made the fix look
  // like a regression, and deleting it would have left the reversal unproven.
  let result: SmokeResult;
  beforeAll(async () => {
    result = await runSmoke({ runtimes: ["node"] });
  }, 180_000);

  test("every Node-declared target imports cleanly under Node -- nothing fails", () => {
    expect(result.ok).toBe(true);
    for (const r of result.results) {
      const label = r.kind === "import" ? r.specifier : r.package;
      expect([label, r.ok]).toEqual([label, true]);
    }
  });

  test("the Node leg actually RAN over the Node-declared packages -- it is not vacuously green", () => {
    // A gate that skipped everything would satisfy the test above forever. These four packages
    // declare `engines.node`, so all eight of their targets must appear in the Node results.
    const attempted = new Set(result.results.flatMap((r) => (r.kind === "import" && r.runtime === "node" ? [r.specifier] : [])));
    for (const specifier of [
      "@yanlinglabs/winter-agent-sdk",
      "@yanlinglabs/winter-provider-catalog",
      "@yanlinglabs/winter-provider-catalog/families",
      "@yanlinglabs/winter-provider-runtime",
      "@yanlinglabs/winter-provider-runtime/testing",
      "@yanlinglabs/winter-conformance",
      "@yanlinglabs/winter-conformance/trace",
      "@yanlinglabs/winter-conformance/official",
    ]) {
      expect([specifier, attempted.has(specifier)]).toEqual([specifier, true]);
    }
  });

  test("the Bun-only package is SKIPPED under Node by its own declaration, not by a hand-list", () => {
    // `provider-conformance` stands up loopback servers with `Bun.serve`, a design decision
    // `tsconfig.sdk-fence.json` already records. It declares `engines.bun` and no `engines.node`, and
    // `runtimesFor` is what turns that declaration into the skip -- so a package that ACQUIRES a
    // Node engine is gated the moment it says so.
    const attempted = new Set(result.results.flatMap((r) => (r.kind === "import" && r.runtime === "node" ? [r.specifier] : [])));
    expect(attempted.has("@yanlinglabs/winter-provider-conformance")).toBe(false);
    expect(runtimesFor({ engines: { bun: ">=1.2" } })).toEqual(["bun"]);
    expect(runtimesFor({ engines: { node: ">=18" } })).toEqual(["node", "bun"]);
    // FAIL CLOSED: a package declaring neither engine is required under both.
    expect(runtimesFor({})).toEqual(["node", "bun"]);
  });
});

// --- P7a pre-publish round 2 (item 8): the dist-only check has teeth ------------------------------
//
// `runSmoke` asserts the INSTALLED tree is dist-only before it imports anything, and a check that has
// never been shown failing is a check nobody can trust. These drive the predicate against synthetic
// trees, so both failure modes are demonstrated without a pack.
describe("assertInstalledTreeIsDistOnly", () => {
  const roots: string[] = [];
  function tree(pkg: { exports?: unknown; withSrc?: boolean }): string {
    const probe = mkdtempSync(join(tmpdir(), "winter-distonly-"));
    roots.push(probe);
    const dir = join(probe, "node_modules", "@scope", "thing");
    mkdirSync(join(dir, "dist"), { recursive: true });
    if (pkg.withSrc === true) mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@scope/thing", exports: pkg.exports ?? { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } } }, null, 2));
    return probe;
  }
  afterAll(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  test("a clean dist-only install passes", () => {
    expect(assertInstalledTreeIsDistOnly(tree({}), ["@scope/thing"])).toEqual([]);
  });

  test("a `src/` directory on disk is caught", () => {
    const v = assertInstalledTreeIsDistOnly(tree({ withSrc: true }), ["@scope/thing"]);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("src exists");
  });

  test("a surviving `bun` condition is caught -- the failure that reads as a missing module", () => {
    // The one the ruling makes possible: `src/` gone, the manifest still naming it. A Bun consumer
    // then fails at RESOLUTION, which looks like a broken package rather than a manifest that lies.
    const v = assertInstalledTreeIsDistOnly(tree({ exports: { ".": { types: "./dist/index.d.ts", bun: "./src/index.ts", default: "./dist/index.js" } } }), ["@scope/thing"]);
    // TWO reports, because there are two independent reasons: the condition should not be there at
    // all, and its target is not in the package. Either alone would be a violation, so both fire --
    // asserted rather than collapsed, so a future change that drops one is visible.
    expect(v).toHaveLength(2);
    expect(v.some((line) => line.includes("`bun` condition"))).toBe(true);
    expect(v.some((line) => line.includes("./src/index.ts"))).toBe(true);
  });

  test("any condition naming `./src/` is caught, whatever it is called", () => {
    const v = assertInstalledTreeIsDistOnly(tree({ exports: { "./sub": { types: "./dist/sub.d.ts", node: "./src/sub.ts", default: "./dist/sub.js" } } }), ["@scope/thing"]);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("./src/sub.ts");
  });

  test("a package that is not installed at all is reported, never silently skipped", () => {
    expect(assertInstalledTreeIsDistOnly(tree({}), ["@scope/absent"])[0]).toContain("no package.json");
  });
});
