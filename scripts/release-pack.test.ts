// P7a Lane C, Step 1's own test. Hermetic: every `pnpm pack` invocation below writes into a
// `mkdtemp`, never the repo's own `dist/`, and touches no registry (pnpm resolves the workspace's
// already-installed local packages; no network call happens, verified while writing this file).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverPublishablePackages,
  findPackageManifests,
  isPublishable,
  releasePack,
  scanExtractedPackage,
  type ReleasePackResult,
} from "./release-pack.ts";

/** R-7-1's publishable set at 7a, sorted -- discoverPublishablePackages's own contract. */
const EXPECTED_PACKAGE_NAMES = [
  "@yanlinglabs/winter-agent-sdk",
  "@yanlinglabs/winter-conformance",
  "@yanlinglabs/winter-provider-catalog",
  "@yanlinglabs/winter-provider-conformance",
  "@yanlinglabs/winter-provider-runtime",
];

describe("isPublishable", () => {
  test("private:true is never publishable, publishConfig or not", () => {
    expect(isPublishable({ private: true, publishConfig: { registry: "x" } })).toBe(false);
    expect(isPublishable({ private: true })).toBe(false);
  });
  test("no publishConfig is not publishable even when not private (e.g. the workspace root)", () => {
    expect(isPublishable({})).toBe(false);
    expect(isPublishable({ private: false })).toBe(false);
  });
  test("not private, with a publishConfig, is publishable", () => {
    expect(isPublishable({ publishConfig: { registry: "https://npm.pkg.github.com" } })).toBe(true);
  });
});

describe("findPackageManifests / discoverPublishablePackages against the real repo", () => {
  test("finds every package.json under packages/, none inside a node_modules segment", () => {
    const manifests = findPackageManifests();
    expect(manifests.length).toBeGreaterThan(5); // 7 workspace packages today, generous floor
    for (const m of manifests) expect(m.split(/[\\/]/)).not.toContain("node_modules");
  });

  test("the publishable set is exactly R-7-1's five packages -- excludes the private runtime and the unpublished (R-7-2) platform package", () => {
    const names = discoverPublishablePackages().map((p) => p.name);
    expect(names).toEqual(EXPECTED_PACKAGE_NAMES);
    expect(names).not.toContain("winter-agent-runtime");
    expect(names).not.toContain("@yanlinglabs/winter-agent-sdk-darwin-arm64");
  });

  test("every discovered package's dir actually contains the package.json it was read from", () => {
    for (const pkg of discoverPublishablePackages()) {
      expect(existsSync(join(pkg.dir, "package.json"))).toBe(true);
    }
  });
});

describe("scanExtractedPackage: a synthetic dirty fixture proves the scan has teeth", () => {
  let dirtyDir: string;

  beforeAll(() => {
    dirtyDir = mkdtempSync(join(tmpdir(), "winter-release-pack-dirty-"));
    writeFileSync(join(dirtyDir, "package.json"), JSON.stringify({ name: "@yanlinglabs/winter-conformance", version: "0.0.1" }));
    mkdirSync(join(dirtyDir, "compat", "anthropic"), { recursive: true });
    writeFileSync(join(dirtyDir, "compat", "anthropic", "leftover.json"), "{}");
    mkdirSync(join(dirtyDir, "node_modules", "foo"), { recursive: true });
    writeFileSync(join(dirtyDir, "node_modules", "foo", "index.js"), "");
    writeFileSync(join(dirtyDir, ".env"), "SECRET=1");
    mkdirSync(join(dirtyDir, "claude-agent-sdk"), { recursive: true });
    writeFileSync(join(dirtyDir, "claude-agent-sdk", "sdk.mjs"), "");
    mkdirSync(join(dirtyDir, "nested"), { recursive: true });
    writeFileSync(join(dirtyDir, "nested", "package.json"), JSON.stringify({ name: "not-yanlinglabs" }));
    mkdirSync(join(dirtyDir, "official-capture-output"), { recursive: true });
    writeFileSync(join(dirtyDir, "official-capture-output", "report.txt"), "x");
    // P7a fix wave (item 9): a test file, a test-support file, and the two CONTROLS that must NOT
    // be flagged -- a public `testing.ts` (provider-runtime re-exports three through `./testing`)
    // and an ordinary source file whose name merely contains the word.
    mkdirSync(join(dirtyDir, "src"), { recursive: true });
    writeFileSync(join(dirtyDir, "src", "thing.test.ts"), "");
    writeFileSync(join(dirtyDir, "src", "raw-fake.test-support.ts"), "");
    writeFileSync(join(dirtyDir, "src", "testing.ts"), "");
    writeFileSync(join(dirtyDir, "src", "xai-oauth.testing.ts"), "");
    writeFileSync(join(dirtyDir, "src", "latest.ts"), "");
  });
  afterAll(() => rmSync(dirtyDir, { recursive: true, force: true }));

  test("catches all seven categories in one pass over one fixture", () => {
    const { violations, filesScanned } = scanExtractedPackage("@yanlinglabs/winter-conformance", dirtyDir);
    expect(filesScanned).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes('forbidden directory "compat"'))).toBe(true);
    expect(violations.some((v) => v.includes('forbidden directory "node_modules"'))).toBe(true);
    expect(violations.some((v) => v.includes("official-capture output"))).toBe(true);
    expect(violations.some((v) => v.includes("Anthropic artifact"))).toBe(true);
    expect(violations.some((v) => v.includes("credentials-shaped"))).toBe(true);
    expect(violations.some((v) => v.includes('unexpected identity ("not-yanlinglabs"'))).toBe(true);
    // P7a fix wave (item 9): the test-file category, both spellings...
    expect(violations.some((v) => v.includes("a test file shipped at src/thing.test.ts"))).toBe(true);
    expect(violations.some((v) => v.includes("a test file shipped at src/raw-fake.test-support.ts"))).toBe(true);
    // ...and NOT the controls, scoped to the TEST-FILE rule. `*.testing.ts` is PRODUCT
    // (provider-runtime's public `./testing` subpath re-exports three of them), and a source file is
    // a source file whatever it is called -- a rule that swept either would silently break the
    // published `./testing` entry point.
    //
    // NARROWED in the pre-publish round: since item 8 every `src/` entry is also a violation under a
    // DIFFERENT rule, so a bare `.includes("testing.ts")` now matches that one and would assert the
    // opposite of what this line means. The control is about which RULE fires, not whether the path
    // appears anywhere in the output.
    const testFileHits = violations.filter((v) => v.includes("a test file shipped at"));
    expect(testFileHits.some((v) => v.includes("testing.ts") && !v.includes(".test"))).toBe(false);
    expect(testFileHits.some((v) => v.includes("latest.ts"))).toBe(false);
    // P7a pre-publish r2 (item 8): a published tarball is DIST-ONLY, so every `src/` entry is a
    // violation in its own right -- the fixture's `src/*` files above are each reported.
    expect(violations.some((v) => v.includes("a source file shipped at src/latest.ts"))).toBe(true);
    expect(violations.filter((v) => v.includes("a source file shipped at")).length).toBeGreaterThanOrEqual(5);
  });

  test("a mismatched root package.json (right scope, wrong package) is caught by the identity check", () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-release-pack-wrongname-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@yanlinglabs/winter-provider-runtime", version: "0.0.1" }));
      const { violations } = scanExtractedPackage("@yanlinglabs/winter-conformance", dir);
      expect(violations.some((v) => v.includes('declares "@yanlinglabs/winter-provider-runtime" instead'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing root package.json is caught, not silently accepted", () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-release-pack-nomanifest-"));
    try {
      writeFileSync(join(dir, "index.js"), "");
      const { violations } = scanExtractedPackage("@yanlinglabs/winter-conformance", dir);
      expect(violations.some((v) => v.includes("no package.json found"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a clean, single-file package has zero violations", () => {
    const clean = mkdtempSync(join(tmpdir(), "winter-release-pack-clean-"));
    try {
      writeFileSync(join(clean, "package.json"), JSON.stringify({ name: "@yanlinglabs/winter-conformance", version: "0.0.1" }));
      writeFileSync(join(clean, "index.js"), "export const ok = true;\n");
      const { violations, filesScanned } = scanExtractedPackage("@yanlinglabs/winter-conformance", clean);
      expect(violations).toEqual([]);
      expect(filesScanned).toBe(2);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });

  // review r1 Important-3: the exact reviewer's own probe, reproduced. `.credentials.json` (a
  // dot-prefixed variant) was invisible to the old `^credentials\.json$` anchor -- the sibling
  // `compat/anthropic/leftover.json` plant proved the harness itself was sound, so the miss was a
  // real regex gap, not a test artifact.
  test("credentials-shaped filenames: dot- and prefix-variants are caught, and legitimate source files named `credentials.ts` are NOT false-flagged", () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-release-pack-credentials-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@yanlinglabs/winter-provider-runtime", version: "0.0.1" }));
      writeFileSync(join(dir, ".credentials.json"), "{}"); // the reviewer's exact planted-file case
      writeFileSync(join(dir, "aws.credentials.json"), "{}");
      writeFileSync(join(dir, ".aws-credentials.json"), "{}");
      mkdirSync(join(dir, "src", "credentials"), { recursive: true });
      writeFileSync(join(dir, "src", "credentials", "credentials.ts"), "export const ok = true;\n"); // a REAL, legitimate module -- must NOT be flagged
      writeFileSync(join(dir, "src", "credentials", "credentials.test.ts"), "export const ok = true;\n");

      const { violations } = scanExtractedPackage("@yanlinglabs/winter-provider-runtime", dir);
      const credentialViolations = violations.filter((v) => v.includes("credentials-shaped"));
      expect(credentialViolations.some((v) => v.includes(".credentials.json") && !v.includes("aws"))).toBe(true);
      expect(credentialViolations.some((v) => v.includes("aws.credentials.json"))).toBe(true);
      expect(credentialViolations.some((v) => v.includes(".aws-credentials.json"))).toBe(true);
      expect(credentialViolations.some((v) => v.includes("credentials.ts"))).toBe(false);
      expect(credentialViolations).toHaveLength(3); // exactly the three planted JSON variants, nothing else
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("releasePack: the real, hermetic, mkdtemp-destined pack (WS-02 §9 Step 1's own test)", () => {
  let outDir: string;
  let result: ReleasePackResult;

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), "winter-release-pack-out-"));
    result = await releasePack({ outDir });
  }, 60_000);
  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  test("packs into the GIVEN mkdtemp, never the repo's own dist/", () => {
    expect(result.outDir).toBe(outDir);
    expect(result.checksumsPath).toBe(join(outDir, "checksums.json"));
    for (const p of result.packages) expect(p.tarballPath.startsWith(outDir)).toBe(true);
  });

  test("the manifest names match the five R-7-1 packages, each a real tarball on disk", () => {
    expect(result.packages.map((p) => p.name)).toEqual(EXPECTED_PACKAGE_NAMES);
    for (const p of result.packages) {
      expect(existsSync(p.tarballPath)).toBe(true);
      expect(p.size).toBeGreaterThan(0);
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(p.version.length).toBeGreaterThan(0);
    }
  });

  test("checksums.json on disk matches the returned manifest exactly", () => {
    const onDisk = JSON.parse(readFileSync(result.checksumsPath, "utf8"));
    expect(onDisk).toEqual(result.packages);
  });

  test("the recorded sha256 is the real hash of the tarball's actual bytes", () => {
    for (const p of result.packages) {
      const bytes = readFileSync(p.tarballPath);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(p.sha256);
      expect(bytes.length).toBe(p.size);
    }
  });

  test("no packed tarball contains compat/ or node_modules/ -- verified independently via `tar -tzf`, not just this script's own scanner", async () => {
    for (const p of result.packages) {
      const proc = Bun.spawn(["tar", "-tzf", p.tarballPath], { stdout: "pipe", stderr: "pipe" });
      const [listing, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(exitCode).toBe(0);
      const paths = listing.trim().split("\n");
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        expect(path).not.toMatch(/(^|\/)compat\//);
        expect(path).not.toMatch(/(^|\/)node_modules\//);
      }
    }
  });

  test("R-7a-12: the conformance tarball DOES ship goldens/*.trace.json (they are publishable, not excluded)", async () => {
    const conformance = result.packages.find((p) => p.name === "@yanlinglabs/winter-conformance");
    expect(conformance).toBeDefined();
    const proc = Bun.spawn(["tar", "-tzf", conformance!.tarballPath], { stdout: "pipe" });
    const listing = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(listing).toMatch(/goldens\/.*\.trace\.json/);
  });

  test("the scan actually ran (inspected every packed file) and found nothing on the real repo", () => {
    expect(result.filesScanned).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });

  test("P7a pre-publish r2 (item 8): NO tarball ships `src/` at all -- verified via `tar -tzf`", async () => {
    // The user ruling: "on npm I'd prefer just the ready-to-use packages; source stays on GitHub".
    // `tar -tzf` rather than the scanner's own answer, so a bug shared between the two cannot pass
    // both. The in-repo `exports` still carry a `bun` condition pointing at `src/` -- that is what
    // this monorepo and the compiled binary run -- and `publishConfig.exports` is what drops it from
    // the PACKED manifest; the next test is that half.
    for (const p of result.packages) {
      const proc = Bun.spawn(["tar", "-tzf", p.tarballPath], { stdout: "pipe" });
      const listing = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      const paths = listing.trim().split("\n");
      expect([p.name, paths.filter((f) => /^package\/src\//.test(f))]).toEqual([p.name, []]);
      // ...and `dist/` really is there, so "no src" is not "nothing at all".
      expect([p.name, paths.some((f) => f.startsWith("package/dist/"))]).toEqual([p.name, true]);
      // Every tarball carries its own licence (item 9) and README.
      expect([p.name, paths.includes("package/LICENSE")]).toEqual([p.name, true]);
      expect([p.name, paths.includes("package/README.md")]).toEqual([p.name, true]);
    }
  });

  test("P7a pre-publish r2 (item 8): the PACKED manifest has no `bun` condition -- publishConfig.exports applied", async () => {
    // The half that would otherwise fail silently and late: `src/` gone while the manifest still
    // names it. A Bun consumer then fails at RESOLUTION, which reads as a missing module rather than
    // as a manifest that lies. Read out of the extracted tarball, since the repo's own manifest is
    // deliberately different.
    for (const p of result.packages) {
      const dir = mkdtempSync(join(tmpdir(), "winter-packed-manifest-"));
      try {
        const proc = Bun.spawn(["tar", "-xzf", p.tarballPath, "-C", dir], { stdout: "pipe", stderr: "pipe" });
        expect(await proc.exited).toBe(0);
        const packed = JSON.parse(readFileSync(join(dir, "package", "package.json"), "utf8")) as {
          exports: Record<string, Record<string, string>>;
          files?: string[];
          license?: string;
          scripts?: Record<string, string>;
          publishConfig?: Record<string, unknown>;
          repository?: { type?: string; url?: string; directory?: string };
        };
        for (const [subpath, conditions] of Object.entries(packed.exports)) {
          expect([p.name, subpath, Object.keys(conditions)]).toEqual([p.name, subpath, ["types", "default"]]);
          for (const target of Object.values(conditions)) expect([p.name, subpath, target.startsWith("./dist/")]).toEqual([p.name, subpath, true]);
        }
        expect([p.name, packed.files?.includes("src")]).toEqual([p.name, false]);
        // P7a pre-publish r3 (I1): pnpm STRIPS `scripts` from the packed manifest, so the `prepack`
        // guard that refuses a non-pnpm packer never reaches a consumer -- which is what makes the
        // guard free rather than a behaviour change for anyone installing these packages.
        expect([p.name, packed.scripts ?? {}]).toEqual([p.name, {}]);
        // M2 (r2 review, correcting the round-2 report): pnpm removes only the override keys it
        // LIFTS -- `exports` -- so `publishConfig` SURVIVES with its remaining keys. The report said
        // the block was stripped; it is not, and `access` is deliberately still there.
        expect([p.name, packed.publishConfig]).toEqual([p.name, { access: "restricted" }]);
        // Item 9 + 10, on the artifact a registry actually receives.
        expect([p.name, packed.license]).toEqual([p.name, "MIT"]);
        expect([p.name, packed.repository?.url]).toEqual([p.name, "git+https://github.com/yanlingLabs/winter-agent-sdk.git"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("P7a fix wave (item 9): NO tarball ships a test file -- verified via `tar -tzf`, independently of the scanner", async () => {
    // Before this fix every tarball carried its own suite: provider-runtime 32 `.test.ts` against 59
    // sources, sdk 17 of 39, 72 across the five. `tar -tzf` rather than `result.violations` on
    // purpose -- the scanner's own rule is what the `files` lists are checked against, so a bug
    // shared between the two would pass both.
    for (const p of result.packages) {
      const proc = Bun.spawn(["tar", "-tzf", p.tarballPath], { stdout: "pipe" });
      const listing = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      const paths = listing.trim().split("\n");
      expect([p.name, paths.filter((f) => /\.test\.ts$|\.test-support\.ts$/.test(f))]).toEqual([p.name, []]);
    }
  });

  test("P7a pre-publish r2 (item 8): provider-runtime's `./testing` subpath ships as COMPILED output", async () => {
    // Was: "still ships the `*.testing.ts` SOURCES". Since the dist-only ruling it ships their
    // compiled form instead -- the declared entry point is unchanged, the artifact behind it is not.
    // Kept as a test rather than deleted, because the property that matters is the same one: a
    // declared subpath must have a file behind it, and an exclusion written one character wider
    // would still break it.
    const runtime = result.packages.find((p) => p.name === "@yanlinglabs/winter-provider-runtime")!;
    const proc = Bun.spawn(["tar", "-tzf", runtime.tarballPath], { stdout: "pipe" });
    const listing = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(listing).toContain("package/dist/testing.js");
    expect(listing).toContain("package/dist/testing.d.ts");
    expect(listing).not.toContain("xai-oauth.testing.ts");
  });

  test("P7a pre-publish r2 (item 8): every publishable manifest declares a DIST-ONLY `files`, and a publishConfig.exports without `bun`", () => {
    // The declaration half. The assertions above are about the OUTPUT of today's five packages; this
    // one fails the moment a sixth is added wrong, before anybody packs.
    //
    // Was: `files` must CONTAIN `src` plus two test negations. The dist-only ruling inverts it --
    // `src` must be absent, and the negations went with it (nothing to prune once no source ships).
    for (const pkg of discoverPublishablePackages()) {
      const manifest = JSON.parse(readFileSync(pkg.packageJsonPath, "utf8")) as {
        files: string[];
        exports: Record<string, Record<string, string>>;
        publishConfig: { exports?: Record<string, Record<string, string>> };
      };
      expect([pkg.name, manifest.files]).toEqual([pkg.name, expect.arrayContaining(["dist", "README.md", "LICENSE"])]);
      expect([pkg.name, manifest.files.some((f) => f === "src" || f.startsWith("!src/"))]).toEqual([pkg.name, false]);

      // The IN-REPO map keeps its `bun` condition -- this monorepo and the compiled binary run source.
      for (const conditions of Object.values(manifest.exports)) expect([pkg.name, Object.keys(conditions)]).toEqual([pkg.name, ["types", "bun", "default"]]);
      // The PUBLISHED map drops it, entry for entry, naming the same compiled targets.
      const published = manifest.publishConfig.exports;
      expect([pkg.name, published !== undefined]).toEqual([pkg.name, true]);
      expect([pkg.name, Object.keys(published!)]).toEqual([pkg.name, Object.keys(manifest.exports)]);
      for (const [subpath, conditions] of Object.entries(published!)) {
        expect([pkg.name, subpath, Object.keys(conditions)]).toEqual([pkg.name, subpath, ["types", "default"]]);
        expect([pkg.name, subpath, conditions["types"]]).toEqual([pkg.name, subpath, manifest.exports[subpath]!["types"]]);
        expect([pkg.name, subpath, conditions["default"]]).toEqual([pkg.name, subpath, manifest.exports[subpath]!["default"]]);
      }
    }
  });
});
