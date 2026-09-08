// P7a pre-publish (item 4): `tsconfig.base.json`'s `paths` and every publishable package's `exports`
// map describe THE SAME MODULES, in two languages.
//
// WHY THEY EXIST SEPARATELY. `exports` is what a consumer resolves (`types` -> `./dist/*.d.ts`,
// `bun` -> the source, `default` -> the compiled JS). `paths` is what THIS repository's own tsc
// resolves, and it exists because the `types` condition names a file that does not exist until
// `build:packages` has run -- without the mapping, `bun run typecheck` on a fresh clone fails with
// "Cannot find module '@yanlinglabs/winter-provider-catalog'" (measured when the emit landed).
//
// WHY THEY MUST AGREE, and what goes wrong when they do not. They are two answers to "what is this
// specifier", and only one of them is checked by anything a consumer runs:
//
//   * a subpath added to `exports` with no `paths` entry resolves in-repo through node_modules to the
//     `types` condition -- i.e. to a `dist` file. On a built tree that WORKS, so nothing fails; on a
//     clean checkout it fails with a confusing "cannot find module" pointing at a package that is
//     right there. (This is exactly the shape of the round-2/3 order-dependence, one level up.)
//   * a `paths` entry with no `exports` key is worse and quieter: in-repo code imports the specifier
//     happily, every gate is green, and the PUBLISHED package has no such subpath at all. The first
//     person to find out is a consumer.
//   * and an entry that points at a DIFFERENT source file than the `bun` condition gives this repo's
//     tsc one module and Bun another under one name.
//
// So this is a parity test, in both directions, comparing the SOURCE PATH each side names.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { discoverPublishablePackages } from "./release-pack.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

interface Manifest {
  name: string;
  exports?: Record<string, Record<string, string> | string>;
}

/** `tsconfig.base.json`'s `paths`, JSON with `//` line comments stripped the way the repo's own tests read it. */
function basePaths(): Record<string, string[]> {
  const raw = readFileSync(`${REPO_ROOT}tsconfig.base.json`, "utf8").replace(/^\s*\/\/.*$/gm, "");
  return (JSON.parse(raw) as { compilerOptions: { paths?: Record<string, string[]> } }).compilerOptions.paths ?? {};
}

/** Specifier -> the SOURCE file that specifier means, from each publishable package's `exports` map. */
function expectedFromExports(): Map<string, string> {
  const out = new Map<string, string>();
  for (const pkg of discoverPublishablePackages()) {
    const manifest = JSON.parse(readFileSync(pkg.packageJsonPath, "utf8")) as Manifest;
    for (const [subpath, conditions] of Object.entries(manifest.exports ?? {})) {
      // The `bun` condition IS the source path (that is the whole point of the condition); a plain
      // string export is the source path itself.
      const source = typeof conditions === "string" ? conditions : conditions["bun"];
      if (source === undefined) throw new Error(`${manifest.name} exports["${subpath}"] has no source path`);
      const specifier = subpath === "." ? manifest.name : `${manifest.name}/${subpath.replace(/^\.\//, "")}`;
      const packageDir = pkg.dir.slice(REPO_ROOT.length).replace(/\/$/, "");
      out.set(specifier, `./${packageDir}/${source.replace(/^\.\//, "")}`);
    }
  }
  return out;
}

/**
 * `paths` entries that name a package OUTSIDE the publishable set, with why each is legitimate.
 *
 * `winter-agent-runtime` is `"private": true` and never published, so it has no `exports` map to
 * agree with -- but in-repo code imports it by specifier, so it needs the mapping. Keyed with a
 * rationale for the same reason every other allowlist in this repo is: an entry nobody can explain
 * is an entry nobody can remove.
 */
const NON_PUBLISHABLE_PATHS: Readonly<Record<string, string>> = {
  "winter-agent-runtime": "the PRIVATE runtime package -- never published, so it has no exports map to agree with, but in-repo code imports it by specifier",
};

describe("P7a pre-publish (item 4): tsconfig `paths` and package `exports` agree", () => {
  test("every publishable `exports` subpath has a `paths` entry pointing at the SAME source file", () => {
    const paths = basePaths();
    const missing: string[] = [];
    const mismatched: string[] = [];
    for (const [specifier, source] of expectedFromExports()) {
      const entry = paths[specifier];
      if (entry === undefined) {
        missing.push(`${specifier} -> ${source}`);
        continue;
      }
      if (entry.length !== 1 || entry[0] !== source) mismatched.push(`${specifier}: paths says ${JSON.stringify(entry)}, exports' \`bun\` condition says ${JSON.stringify(source)}`);
    }
    expect(
      missing.length === 0 ? "" : `exports subpaths with no tsconfig.base.json \`paths\` entry (in-repo tsc will resolve them through \`types\` -> a dist file that may not exist):\n  ${missing.join("\n  ")}`,
    ).toBe("");
    expect(mismatched.length === 0 ? "" : `paths and exports name DIFFERENT source files:\n  ${mismatched.join("\n  ")}`).toBe("");
  });

  test("no STALE `paths` entry survives -- every one names a real exports subpath or a justified non-publishable package", () => {
    // The quieter direction: a `paths` entry with no `exports` key lets in-repo code import a
    // specifier the PUBLISHED package does not have, with every gate green.
    const expected = expectedFromExports();
    const unexplained = Object.keys(basePaths()).filter((specifier) => !expected.has(specifier) && NON_PUBLISHABLE_PATHS[specifier] === undefined);
    expect(
      unexplained.length === 0
        ? ""
        : `tsconfig.base.json \`paths\` entries that no publishable \`exports\` map declares (add the subpath to the package, delete the entry, or record it in NON_PUBLISHABLE_PATHS with a reason):\n  ${unexplained.join("\n  ")}`,
    ).toBe("");
  });

  test("every NON_PUBLISHABLE_PATHS entry is real, private, and carries a reason", () => {
    for (const [specifier, why] of Object.entries(NON_PUBLISHABLE_PATHS)) {
      expect([specifier, basePaths()[specifier] !== undefined]).toEqual([specifier, true]);
      expect([specifier, why.length > 40]).toEqual([specifier, true]);
      // Really private: a package that becomes publishable must move out of this list, not stay in it.
      const target = basePaths()[specifier]![0]!;
      const pkgDir = target.replace(/^\.\//, "").split("/src/")[0]!;
      const manifest = JSON.parse(readFileSync(`${REPO_ROOT}${pkgDir}/package.json`, "utf8")) as { private?: boolean; publishConfig?: unknown };
      expect([specifier, manifest.private === true || manifest.publishConfig === undefined]).toEqual([specifier, true]);
    }
  });

  test("the parity is not vacuous: it covers every publishable package and all ten subpaths", () => {
    const expected = expectedFromExports();
    expect(expected.size).toBe(10);
    expect(new Set([...expected.keys()].map((s) => s.split("/").slice(0, 2).join("/"))).size).toBe(discoverPublishablePackages().length);
    // And each mapped file really exists -- a `paths` pair that agreed on a path nobody wrote would
    // satisfy both tests above.
    for (const [, source] of expected) expect([source, readFileSync(`${REPO_ROOT}${source.replace(/^\.\//, "")}`, "utf8").length > 0]).toEqual([source, true]);
  });
});
