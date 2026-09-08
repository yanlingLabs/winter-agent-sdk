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
  });
  afterAll(() => rmSync(dirtyDir, { recursive: true, force: true }));

  test("catches all six categories in one pass over one fixture", () => {
    const { violations, filesScanned } = scanExtractedPackage("@yanlinglabs/winter-conformance", dirtyDir);
    expect(filesScanned).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes('forbidden directory "compat"'))).toBe(true);
    expect(violations.some((v) => v.includes('forbidden directory "node_modules"'))).toBe(true);
    expect(violations.some((v) => v.includes("official-capture output"))).toBe(true);
    expect(violations.some((v) => v.includes("Anthropic artifact"))).toBe(true);
    expect(violations.some((v) => v.includes("credentials-shaped"))).toBe(true);
    expect(violations.some((v) => v.includes('unexpected identity ("not-yanlinglabs"'))).toBe(true);
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
});
