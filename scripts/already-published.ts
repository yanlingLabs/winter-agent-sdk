// P7a pre-publish round 3 (review §5): IS THIS EXACT VERSION ALREADY ON THIS REGISTRY?
//
// A release is two publishes to two registries, and the second can fail after the first succeeded --
// which leaves the tag naming a half-done release. The recovery has to be "re-drive the same tag",
// not "bump the version": GitHub Packages and npm both refuse a version they already hold, so a bump
// would mean the tag no longer names what shipped.
//
// So every publish path asks first, per package, against ITS OWN registry, and skips what is already
// there with a printed line. pnpm's `recursivePublish` has a probe of its own (`isAlreadyPublished`,
// pnpm.cjs:188575) but it swallows EVERY error as "not published" -- including an auth failure --
// which is exactly the shape that turns a re-drive into a confusing 401 instead of a skip. This one
// distinguishes the three answers a registry can give and says which it got.
//
// PURE SEAM. `probe` is injected, so the decision logic is testable with no network at all (a real
// `npm view` would make every test that touches this reach the internet, which the whole-branch
// constraint forbids).

/** What a registry said about one exact `<name>@<version>`. */
export type PublishedProbeResult =
  /** The version is there -- `npm view` printed it. */
  | { kind: "exists"; version: string }
  /** The registry answered, and it is not there (404, or E404 on the package itself). */
  | { kind: "absent" }
  /** The registry could not be asked (auth, network, a malformed response). NEVER read as "absent". */
  | { kind: "unknown"; reason: string };

export type PublishDecision = { name: string; version: string; publish: boolean; reason: string };

/**
 * Decides, per package, whether to publish.
 *
 * `unknown` PUBLISHES: an unanswerable probe must not silently skip a package that was never
 * published -- the registry itself will refuse a genuine duplicate, and a 409 is a legible failure
 * while a silent skip is a release that quietly shipped four packages instead of five.
 */
export function decidePublishes(
  packages: ReadonlyArray<{ name: string; version: string }>,
  probe: (name: string, version: string) => PublishedProbeResult,
): PublishDecision[] {
  return packages.map(({ name, version }) => {
    const result = probe(name, version);
    if (result.kind === "exists") return { name, version, publish: false, reason: `already on this registry at ${result.version}` };
    if (result.kind === "absent") return { name, version, publish: true, reason: "not on this registry" };
    return { name, version, publish: true, reason: `could not be checked (${result.reason}) -- publishing anyway; the registry refuses a genuine duplicate` };
  });
}

/**
 * `npm view <name>@<version> version`, against a registry named BOTH ways, mapped onto the three answers.
 *
 * P7a pre-publish round 4 (review M4): `--registry` alone is DECORATIVE for a scoped name -- it sets
 * only `registries.default`, and the scope binding outranks it. That is C1's trap one layer down, and
 * it was correct here only by coincidence: each job's `setup-node` binding happens to agree with the
 * flag its own probe passes. The next reuse of this seam (a third registry, a probe run outside its
 * job) would silently query the wrong one and get a confident `absent` -- the worst possible wrong
 * answer, since "absent" means "publish".
 *
 * So the scope is bound explicitly too. `--@yanlinglabs:registry=<url>` is the CLI form of the same
 * key setup-node writes into its userconfig, and a CLI flag outranks any config file, so the probe
 * asks the registry it was told to ask no matter what `.npmrc` is in scope.
 */
export const WINTER_SCOPE = "@yanlinglabs";

export function probeWithNpmView(registry: string): (name: string, version: string) => PublishedProbeResult {
  return (name, version) => {
    const proc = Bun.spawnSync(
      ["npm", "view", `${name}@${version}`, "version", "--registry", registry, `--${WINTER_SCOPE}:registry=${registry}`],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = new TextDecoder().decode(proc.stdout).trim();
    const stderr = new TextDecoder().decode(proc.stderr).trim();
    if (proc.exitCode === 0) {
      // `npm view <pkg>@<missing-version>` exits 0 with EMPTY stdout -- the package exists, that
      // version does not. Reading exit 0 alone as "exists" would skip every first publish of a new
      // version, which is the common case.
      return stdout.length > 0 ? { kind: "exists", version: stdout } : { kind: "absent" };
    }
    if (/E404|404 Not Found/.test(stderr)) return { kind: "absent" };
    return { kind: "unknown", reason: stderr.split("\n")[0] ?? `exit ${proc.exitCode}` };
  };
}

/** One line per package, in the order given -- the log a re-drive is read from. */
export function formatDecisions(registry: string, decisions: readonly PublishDecision[]): string {
  return decisions.map((d) => `  ${d.publish ? "PUBLISH" : "SKIP   "} ${d.name}@${d.version} -- ${d.reason}`).join("\n") + `\n  (registry: ${registry})`;
}
