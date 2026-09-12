// P7a pre-publish (item 6): the version/tag consistency gate's own test.
//
// HERMETIC: every case builds a synthetic repo in a `mkdtemp` -- a `VERSION` file and a `packages/`
// tree of manifests -- and never reads or writes this repository. The one case that DOES read the
// real tree asserts the shipped state agrees with itself, which is the fact the gate exists to keep.
import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReleaseVersion, taggedVersionFrom } from "./check-release-version.ts";

/** A throwaway repo root: `VERSION` plus one manifest per named package. */
function fixtureRoot(versionFile: string, packages: Array<{ dir: string; name: string; version: string; publishable?: boolean }>): string {
  const root = mkdtempSync(join(tmpdir(), "winter-relver-"));
  writeFileSync(join(root, "VERSION"), `${versionFile}\n`);
  for (const pkg of packages) {
    mkdirSync(join(root, "packages", pkg.dir), { recursive: true });
    writeFileSync(
      join(root, "packages", pkg.dir, "package.json"),
      JSON.stringify({ name: pkg.name, version: pkg.version, ...(pkg.publishable === false ? { private: true } : { publishConfig: { registry: "https://npm.pkg.github.com", access: "restricted" } }) }, null, 2),
    );
  }
  return `${root}/`;
}

describe("taggedVersionFrom", () => {
  test("reads a `v*` tag ref and nothing else", () => {
    expect(taggedVersionFrom("refs/tags/v0.0.1")).toBe("0.0.1");
    expect(taggedVersionFrom("refs/tags/v1.2.3-rc.1")).toBe("1.2.3-rc.1");
    // A branch push and a workflow_dispatch have no tag -- both are `undefined`, not a failure.
    expect(taggedVersionFrom("refs/heads/main")).toBeUndefined();
    expect(taggedVersionFrom(undefined)).toBeUndefined();
    expect(taggedVersionFrom("   ")).toBeUndefined();
    // A `phase-*` tag cannot even reach this workflow (the `on:` block), but it is not a version either.
    expect(taggedVersionFrom("refs/tags/phase-7a")).toBeUndefined();
  });
});

describe("checkReleaseVersion", () => {
  const roots: string[] = [];
  const make = (...args: Parameters<typeof fixtureRoot>): string => {
    const root = fixtureRoot(...args);
    roots.push(root);
    return root;
  };
  const cleanup = (): void => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  };

  test("agreeing tag, VERSION and manifests -> ok", () => {
    const root = make("0.0.001", [
      { dir: "a", name: "@scope/a", version: "0.0.1" },
      { dir: "b", name: "@scope/b", version: "0.0.1" },
    ]);
    const r = checkReleaseVersion({ ref: "refs/tags/v0.0.1", root });
    expect(r.ok).toBe(true);
    if (r.ok) expect([r.version, r.taggedVersion, r.packages.length]).toEqual(["0.0.1", "0.0.1", 2]);
    cleanup();
  });

  test("a tag that does not match the manifests REFUSES, and says what would have shipped", () => {
    // THE FAILURE THIS EXISTS FOR, and it is not a failed publish: tagging `v0.0.2` on a tree still
    // at `0.0.1` publishes `0.0.1` SUCCESSFULLY, to registries where a version can never be
    // re-published, under a tag naming a release that does not exist.
    const root = make("0.0.001", [{ dir: "a", name: "@scope/a", version: "0.0.1" }]);
    const r = checkReleaseVersion({ ref: "refs/tags/v0.0.2", root });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("v0.0.2");
      expect(r.reason).toContain("0.0.1");
      expect(r.reason).toContain("re-published");
    }
    cleanup();
  });

  test("ONE manifest out of step is caught, even with a matching tag -- the set publishes together", () => {
    const root = make("0.0.001", [
      { dir: "a", name: "@scope/a", version: "0.0.1" },
      { dir: "b", name: "@scope/b", version: "0.0.2" },
    ]);
    const r = checkReleaseVersion({ ref: "refs/tags/v0.0.1", root });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("@scope/b@0.0.2");
      expect(r.reason).toContain("version:sync");
    }
    cleanup();
  });

  test("VERSION's zero-padded `#.#.###` form is compared through the same normalisation `version:sync` applies", () => {
    // `VERSION` is `0.0.001`; a manifest carries plain semver `0.0.1`. Comparing the raw strings
    // would refuse every correct release.
    const root = make("0.2.014", [{ dir: "a", name: "@scope/a", version: "0.2.14" }]);
    expect(checkReleaseVersion({ ref: "refs/tags/v0.2.14", root }).ok).toBe(true);
    cleanup();
  });

  test("no tag (workflow_dispatch) still checks manifests against VERSION", () => {
    // A dispatch is a legitimate way to run the workflow, so the tag half is skipped -- but the half
    // that catches "somebody edited a manifest by hand" is not.
    const agreeing = make("0.0.001", [{ dir: "a", name: "@scope/a", version: "0.0.1" }]);
    expect(checkReleaseVersion({ root: agreeing }).ok).toBe(true);
    const drifted = make("0.0.001", [{ dir: "a", name: "@scope/a", version: "9.9.9" }]);
    expect(checkReleaseVersion({ root: drifted }).ok).toBe(false);
    cleanup();
  });

  test("a PRIVATE package is not part of the set -- only publishable versions can be published wrong", () => {
    const root = make("0.0.001", [
      { dir: "a", name: "@scope/a", version: "0.0.1" },
      { dir: "priv", name: "private-thing", version: "9.9.9", publishable: false },
    ]);
    const r = checkReleaseVersion({ ref: "refs/tags/v0.0.1", root });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.packages.map((p) => p.name)).toEqual(["@scope/a"]);
    cleanup();
  });

  test("a tree with NO publishable packages refuses rather than passing vacuously", () => {
    const root = make("0.0.001", [{ dir: "priv", name: "private-thing", version: "0.0.1", publishable: false }]);
    const r = checkReleaseVersion({ ref: "refs/tags/v0.0.1", root });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("no publishable packages");
    cleanup();
  });

  test("THIS repository agrees with itself right now", () => {
    // The live fact: `VERSION`, every publishable manifest, and therefore any `v<VERSION>` tag.
    // P9a-3: 6 packages now that the darwin-arm64 platform package is publishable (discovered as
    // publishable once `discoverPublishablePackages` stops excluding it, per its own manifest fields
    // -- covered here rather than assumed, since a version-check gate that silently missed a package
    // would ship it under the wrong number without failing).
    const r = checkReleaseVersion({});
    expect(r.ok, r.ok ? "" : r.reason).toBe(true);
    if (r.ok) {
      expect(r.packages).toHaveLength(6);
      expect(r.packages.map((p) => p.name)).toContain("@yanlinglabs/winter-agent-sdk-darwin-arm64");
      expect(checkReleaseVersion({ ref: `refs/tags/v${r.version}` }).ok).toBe(true);
    }
  });
});
