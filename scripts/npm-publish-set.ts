// WHICH PACKAGES GO TO PUBLIC npm.
//
// Every publishable package goes to GitHub Packages -- that is the org's own registry and the whole
// set belongs there. npm is different: a version there can never be withdrawn, and it is what a
// stranger installs. So the npm set is
//
//     the transitive workspace `dependencies` CLOSURE of the ROOTS,
//     where the roots are: the wrapper, plus every package flagged as a HARNESS
//
// which today is five: `@yanlinglabs/winter-agent-sdk` and `@yanlinglabs/winter-provider-catalog`
// (what `npm install @yanlinglabs/winter-agent-sdk` needs at run time), the two harness roots
// `@yanlinglabs/winter-conformance` + `@yanlinglabs/winter-provider-conformance`, and
// `@yanlinglabs/winter-provider-runtime`, which the second harness genuinely imports.
//
// WHY THE HARNESSES ARE ROOTS (R-7b-5). P7a ruled "EXACTLY the wrapper's closure, no exceptions
// mechanism", for a good reason worth restating: "the closure plus a list" degrades every time the
// list grows, and a list is exactly where a harness would eventually be added by someone in a hurry.
// R-7b-5 widened it, and the widening is NOT a list. `@yanlinglabs/winter-runtime-sdk` lives in its
// OWN repository and needs both harnesses as dev dependencies (goldens + the trace normalizer; the
// loopback provider fakes); reaching GitHub Packages from that repo's CI would require a cross-repo
// `read:packages` token whose only purpose is fetching test fixtures. So the two harnesses carry a
// SECOND manifest flag, `winter.publish.harness`, that says what they are -- and the rule stays
// falsifiable in both directions: `npm: true` on a package that is neither a root nor reachable from
// one is still a REFUSAL (`release-gates.test.ts`), which is the copy-paste leak the exact-closure
// rule existed to stop.
//
// WHY IT IS A CLOSURE AND NOT A UNION (the correction to R-7b-5's own arithmetic, which said four).
// A published package's manifest pins its `dependencies` at the exact version -- measured:
// `winter-provider-conformance`'s packed manifest carries `"@yanlinglabs/winter-provider-runtime":
// "<version>"`, because `corpus/{bedrock,google,openai,continuity}.ts` import VALUES from it. Four
// targets would put a harness on npm whose install 404s on a dependency that is not there, which is
// exactly the C1/I1 failure the routing gate was built to catch, one package over -- and it would
// defeat R-7b-5's own stated purpose, since the router's CI would still need the GitHub Packages
// token it was meant to stop needing. `winter-provider-runtime` therefore enters npm BY CLOSURE,
// not by being a harness: it is not one, and the flag's meaning stays crisp.
//
// THE SET IS DATA (`winter.publish.*` in each manifest), read here and turned into the arguments the
// npm job passes. It is not a list in the YAML, because a list in YAML is a second copy of a fact the
// manifests already know -- and the failure modes are silent in both directions: a new runtime
// dependency of a root that nobody flags is MISSING from npm (a consumer's install breaks), and a
// package that gains the flag by copy-paste LEAKS.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { discoverPublishablePackages, type PublishablePackage } from "./release-pack.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The published wrapper -- the one package a public consumer installs by name. */
export const NPM_ROOT_PACKAGE = "@yanlinglabs/winter-agent-sdk";

/** Packages whose manifest declares `winter.publish.npm: true`, sorted. */
export function npmPublishSet(root: string = REPO_ROOT): PublishablePackage[] {
  return discoverPublishablePackages(root).filter((p) => p.npm);
}

/**
 * The transitive WORKSPACE dependency closure of `roots`, computed from `dependencies` alone.
 *
 * `dependencies` and not `devDependencies` or `optionalDependencies`: the question is what a consumer
 * needs at RUN TIME after `npm install <root>`. The platform binary package is an
 * `optionalDependency` and is not published at 7a (R-7-2), so it is correctly outside this set.
 *
 * `roots` defaults to the wrapper plus every harness root (R-7b-5), which makes this THE WHOLE
 * DEFINITION of the npm set: `npmPublishSet()` (the `winter.publish.npm` flag, which is what the
 * workflow filters on) must equal it exactly, asserted in both directions by
 * `release-gates.test.ts`. The parameter exists so that test can plant a synthetic graph -- a rule
 * that has only ever been evaluated on the one tree it was written for proves nothing.
 */
export function npmRequiredClosure(root: string = REPO_ROOT, roots: readonly string[] = [NPM_ROOT_PACKAGE, ...npmHarnessSet(root)]): string[] {
  const byName = new Map(discoverPublishablePackages(root).map((p) => [p.name, p]));
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    const pkg = byName.get(name);
    if (pkg === undefined) return; // not a workspace package -- an ordinary npm dependency
    seen.add(name);
    const manifest = JSON.parse(readFileSync(pkg.packageJsonPath, "utf8")) as { dependencies?: Record<string, string> };
    for (const dep of Object.keys(manifest.dependencies ?? {})) visit(dep);
  };
  for (const name of roots) visit(name);
  return [...seen].sort();
}

/**
 * The npm set in PUBLISH ORDER: every package after the workspace dependencies it declares.
 *
 * P7a pre-publish round 4 (review I1). `discoverPublishablePackages()` sorts ALPHABETICALLY, so the
 * npm job published the WRAPPER before the catalog it depends on -- the dependency its own
 * packed manifest pins at that exact version. For the interval between the two uploads, npm served
 * the one package a public consumer installs by name declaring a dependency that did not exist, and
 * `npm install @yanlinglabs/winter-agent-sdk` 404'd on it. If the second upload then failed, that
 * state persisted on a registry from which the version can never be withdrawn or re-published, until
 * a re-drive landed the dependency.
 *
 * Derived from the SAME `dependencies` edges `npmRequiredClosure()` walks -- a depth-first POST-order,
 * where a node is emitted only after everything it depends on. Correct for any future set, not just a
 * two-element one, and it is the graph rather than a second hand-maintained list.
 *
 * `readManifest` is injectable so a test can plant a reversed graph and see the order follow it: an
 * order that happened to be right because the real graph agrees with the alphabet would prove nothing.
 */
export function npmPublishOrder(
  root: string = REPO_ROOT,
  readManifest: (pkg: PublishablePackage) => { dependencies?: Record<string, string> } = (pkg) =>
    JSON.parse(readFileSync(pkg.packageJsonPath, "utf8")) as { dependencies?: Record<string, string> },
): PublishablePackage[] {
  const inSet = new Map(npmPublishSet(root).map((p) => [p.name, p]));
  const ordered: PublishablePackage[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (pkg: PublishablePackage): void => {
    const seen = state.get(pkg.name);
    if (seen === "done") return;
    // A cycle cannot be published in any order, so it is a refusal rather than an arbitrary choice.
    if (seen === "visiting") throw new Error(`npm-publish-set: dependency cycle through ${pkg.name}`);
    state.set(pkg.name, "visiting");
    for (const dep of Object.keys(readManifest(pkg).dependencies ?? {})) {
      const target = inSet.get(dep);
      if (target !== undefined) visit(target); // only edges INSIDE the npm set can constrain the order
    }
    state.set(pkg.name, "done");
    ordered.push(pkg);
  };
  for (const pkg of inSet.values()) visit(pkg);
  return ordered;
}

/**
 * Packages whose manifest declares `winter.publish.harness: true`, sorted.
 *
 * R-7b-5: org TEST HARNESSES published to npm for an out-of-repo consumer -- today
 * `@yanlinglabs/winter-runtime-sdk`, whose CI would otherwise need a cross-repo `read:packages`
 * token solely to fetch test fixtures. A harness is not a dependency of anything published: nothing
 * pulls one in transitively, and flagging one does not put it in any consumer's install.
 */
export function npmHarnessSet(root: string = REPO_ROOT): string[] {
  return discoverPublishablePackages(root)
    .filter((p) => p.harness)
    .map((p) => p.name)
    .sort();
}

/** THE RULE, named: the closure of {wrapper} ∪ {harness roots}. Equals `npmPublishSet()` exactly. */
export function npmExpectedSet(root: string = REPO_ROOT): string[] {
  return npmRequiredClosure(root);
}

/** `--filter <name>` per package, in the order `pnpm publish` should receive them. */
export function npmFilterArgs(root: string = REPO_ROOT): string[] {
  return npmPublishSet(root).flatMap((p) => ["--filter", p.name]);
}

if (import.meta.main) {
  // Printed as a single line the workflow puts into `$GITHUB_OUTPUT`, so the YAML never spells a
  // package name (review M1: a `$(…)` substitution inside the publish command degraded to an
  // unfiltered publish when the script failed).
  //
  // `--format=names` is what the npm job asks for since round 3: bare package names, because that job
  // publishes per package with `npm publish <tarball>` rather than handing `--filter` pairs to pnpm.
  //
  // PUBLISH ORDER, not alphabetical (review I1): dependencies before dependents, so npm never serves
  // the wrapper declaring a dependency that is not there yet.
  const names = process.argv.includes("--format=names");
  process.stdout.write(names ? npmPublishOrder().map((p) => p.name).join(" ") : npmFilterArgs().join(" "));
}
