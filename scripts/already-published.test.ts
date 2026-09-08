// P7a pre-publish round 3 (review §5): the skip-if-exists decision, with the probe faked.
//
// HERMETIC BY CONSTRUCTION -- `decidePublishes` takes its probe as an argument, which is the whole
// reason the seam exists: a real `npm view` would put the network in the default suite, and the
// interesting cases (auth failure, a package that exists at a different version) are ones a live
// registry will not produce on demand anyway.
import { describe, test, expect } from "bun:test";
import { decidePublishes, formatDecisions, type PublishedProbeResult } from "./already-published.ts";

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
