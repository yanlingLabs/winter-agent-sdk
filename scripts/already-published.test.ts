// P7a pre-publish round 3 (review §5): the skip-if-exists decision, with the probe faked.
//
// HERMETIC BY CONSTRUCTION -- `decidePublishes` takes its probe as an argument, which is the whole
// reason the seam exists: a real `npm view` would put the network in the default suite, and the
// interesting cases (auth failure, a package that exists at a different version) are ones a live
// registry will not produce on demand anyway.
import { describe, test, expect } from "bun:test";
import { WINTER_SCOPE, decidePublishes, formatDecisions, probeWithNpmView, type PublishedProbeResult } from "./already-published.ts";

const PKGS = [
  { name: "@scope/a", version: "0.0.1" },
  { name: "@scope/b", version: "0.0.1" },
];

describe("decidePublishes", () => {
  test("a version already on the registry is SKIPPED, and the reason says so", () => {
    const decisions = decidePublishes(PKGS, () => ({ kind: "exists", version: "0.0.1" }));
    expect(decisions.every((d) => !d.publish)).toBe(true);
    expect(decisions[0]!.reason).toContain("already on this registry");
  });

  test("a version the registry does not have is PUBLISHED", () => {
    const decisions = decidePublishes(PKGS, () => ({ kind: "absent" }));
    expect(decisions.every((d) => d.publish)).toBe(true);
  });

  test("a MIXED answer is per package -- a half-done release finishes without a version bump", () => {
    // The case the whole mechanism is for: job 2 failed after job 1 published, and the re-drive at
    // the SAME tag must publish only what is missing. A bump would leave the tag naming something
    // other than what shipped, and both registries refuse a version they already hold.
    const decisions = decidePublishes(PKGS, (name) => (name === "@scope/a" ? { kind: "exists", version: "0.0.1" } : { kind: "absent" }));
    expect(decisions.map((d) => [d.name, d.publish])).toEqual([
      ["@scope/a", false],
      ["@scope/b", true],
    ]);
  });

  test("an UNANSWERABLE probe publishes anyway, and says why -- never a silent skip", () => {
    // The direction that matters. pnpm's own `isAlreadyPublished` swallows every error as "not
    // published"; the dangerous inverse would be reading an auth failure as "already there" and
    // shipping four packages instead of five, green. Publishing is the safe answer: the registry
    // refuses a genuine duplicate with a legible 409.
    const decisions = decidePublishes(PKGS, () => ({ kind: "unknown", reason: "E401 unauthorized" }));
    expect(decisions.every((d) => d.publish)).toBe(true);
    expect(decisions[0]!.reason).toContain("E401 unauthorized");
    expect(decisions[0]!.reason).toContain("refuses a genuine duplicate");
  });

  test("the printed report names every package, its verdict and the registry", () => {
    // The log is the operator's whole view of a re-drive, so its shape is part of the contract.
    const decisions = decidePublishes(PKGS, (name) => (name === "@scope/a" ? { kind: "exists", version: "0.0.1" } : { kind: "absent" }));
    const text = formatDecisions("https://registry.npmjs.org", decisions);
    expect(text).toContain("SKIP    @scope/a@0.0.1");
    expect(text).toContain("PUBLISH @scope/b@0.0.1");
    expect(text).toContain("registry: https://registry.npmjs.org");
  });

  test("the probe's three answers are distinguishable -- `unknown` is not `absent`", () => {
    // Guarding the type itself: collapsing the two would restore pnpm's own failure mode.
    const answers: PublishedProbeResult[] = [{ kind: "exists", version: "1.0.0" }, { kind: "absent" }, { kind: "unknown", reason: "network" }];
    expect(new Set(answers.map((a) => a.kind)).size).toBe(3);
    expect(decidePublishes([PKGS[0]!], () => answers[1]!)[0]!.reason).not.toContain("could not be checked");
    expect(decidePublishes([PKGS[0]!], () => answers[2]!)[0]!.reason).toContain("could not be checked");
  });
});

// --- P7a pre-publish round 4 ----------------------------------------------------------------------
describe("npmPublishOrder (review I1)", () => {
  test("the real set publishes the catalog BEFORE the sdk that depends on it", async () => {
    const { npmPublishOrder } = await import("./npm-publish-set.ts");
    expect(npmPublishOrder().map((p) => p.name)).toEqual([
      "@yanlinglabs/winter-provider-catalog",
      "@yanlinglabs/winter-agent-sdk",
    ]);
  });

  test("a REVERSED graph reverses the order -- it follows the edges, not the alphabet", async () => {
    // Without this, the real answer above could be right by coincidence: the correct order happens to
    // be the reverse-alphabetical one for today's two packages, so an implementation that simply
    // sorted descending would pass. Planting the opposite dependency direction is what distinguishes
    // "reads the graph" from "got lucky".
    const { npmPublishOrder } = await import("./npm-publish-set.ts");
    const reversed = npmPublishOrder(undefined, (pkg) =>
      pkg.name === "@yanlinglabs/winter-provider-catalog"
        ? { dependencies: { "@yanlinglabs/winter-agent-sdk": "workspace:*" } }
        : {},
    );
    expect(reversed.map((p) => p.name)).toEqual([
      "@yanlinglabs/winter-agent-sdk",
      "@yanlinglabs/winter-provider-catalog",
    ]);
  });

  test("no package appears before one it depends on -- the property, over the real graph", async () => {
    const { npmPublishOrder } = await import("./npm-publish-set.ts");
    const { readFileSync } = await import("node:fs");
    const order = npmPublishOrder();
    const position = new Map(order.map((p, i) => [p.name, i]));
    for (const pkg of order) {
      const manifest = JSON.parse(readFileSync(pkg.packageJsonPath, "utf8")) as { dependencies?: Record<string, string> };
      for (const dep of Object.keys(manifest.dependencies ?? {})) {
        if (!position.has(dep)) continue;
        expect([`${dep} before ${pkg.name}`, position.get(dep)! < position.get(pkg.name)!]).toEqual([`${dep} before ${pkg.name}`, true]);
      }
    }
  });

  test("a dependency CYCLE is refused, never resolved into an arbitrary order", async () => {
    const { npmPublishOrder } = await import("./npm-publish-set.ts");
    expect(() =>
      npmPublishOrder(undefined, (pkg) => ({
        dependencies:
          pkg.name === "@yanlinglabs/winter-agent-sdk"
            ? { "@yanlinglabs/winter-provider-catalog": "workspace:*" }
            : { "@yanlinglabs/winter-agent-sdk": "workspace:*" },
      })),
    ).toThrow(/cycle/);
  });
});

describe("probeWithNpmView (review M4)", () => {
  test("the probe binds the SCOPE, so a scope pin in scope cannot redirect it", () => {
    // C1's trap one layer down: `--registry` sets only `registries.default`, which the scope binding
    // outranks -- so a probe passing only that flag asks whatever registry the ambient `.npmrc` names
    // and can answer a confident `absent` about the wrong one. "Absent" means "publish".
    //
    // Asserted on the ARGUMENTS rather than by running npm: the live behaviour needs a network, and
    // what has to be true is that the scoped key is passed at all -- a CLI flag outranks every config
    // file, so its presence IS the guarantee.
    const calls: string[][] = [];
    const originalSpawnSync = Bun.spawnSync;
    try {
      (Bun as unknown as { spawnSync: unknown }).spawnSync = ((cmd: string[]) => {
        calls.push(cmd);
        return { exitCode: 1, stdout: new TextEncoder().encode(""), stderr: new TextEncoder().encode("npm error code E404") };
      }) as unknown as typeof Bun.spawnSync;
      const probe = probeWithNpmView("https://registry.npmjs.org");
      expect(probe("@yanlinglabs/winter-agent-sdk", "0.0.1")).toEqual({ kind: "absent" });
    } finally {
      (Bun as unknown as { spawnSync: unknown }).spawnSync = originalSpawnSync;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--registry");
    expect(calls[0]).toContain("https://registry.npmjs.org");
    // The scoped form -- the one that actually decides for a scoped package name.
    expect(calls[0]).toContain(`--${WINTER_SCOPE}:registry=https://registry.npmjs.org`);
  });
});
