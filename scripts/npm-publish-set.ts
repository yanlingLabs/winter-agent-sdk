// P7a pre-publish (item 5; user ruling 2026-09-08): WHICH PACKAGES GO TO PUBLIC npm.
//
// Every publishable package goes to GitHub Packages -- that is the org's own registry and the whole
// set belongs there. npm is different: it is what a PUBLIC consumer installs, so it gets EXACTLY the
// wrapper and its transitive workspace `dependencies` closure -- `@yanlinglabs/winter-agent-sdk` and
// `@yanlinglabs/winter-provider-catalog` -- and nothing else (user ruling 2026-09-08).
//
// NO EXCEPTIONS MECHANISM, deliberately. An earlier draft carried a ruled-extras list so
// `winter-provider-runtime` could sit on npm without being in the closure; the ruling removed both the
// package and the concept. "Exactly the closure" is a property a test can state in one sentence and
// check in both directions; "the closure plus a list" is a property that degrades every time the list
// grows, and the list is precisely where a harness would eventually be added by someone in a hurry.
//
// So `winter-provider-runtime`, `winter-conformance` and `winter-provider-conformance` are GitHub
// Packages only. The two conformance packages are the org's own test harnesses -- publishing them
// publicly would offer a stranger a package whose only purpose is testing this repository -- and
// `winter-provider-runtime` is the PRIVATE `winter-agent-runtime`'s dependency: the wrapper SPAWNS the
// compiled runtime rather than importing it, so a public consumer of the wrapper never needs it.
//
// THE SET IS DATA (`winter.publish.npm` in each manifest), read here and turned into the `--filter`
// arguments the npm job passes to `pnpm publish`. It is not a list in the YAML, because a list in
// YAML is a second copy of a fact the manifests already know -- and the failure modes are silent in
// both directions: a new runtime dependency of the wrapper that nobody adds to the list is MISSING
// from npm (a consumer's install breaks), and a harness that gains the flag by copy-paste LEAKS.
// `release-gates.test.ts` pins the flagged set against the wrapper's actual transitive closure, so
// neither can happen quietly.
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
 * The wrapper's transitive WORKSPACE dependency closure, computed from `dependencies` alone.
 *
 * `dependencies` and not `devDependencies` or `optionalDependencies`: the question is what a consumer
 * needs at RUN TIME after `npm install @yanlinglabs/winter-agent-sdk`. The platform binary package is
 * an `optionalDependency` and is not published at 7a (R-7-2), so it is correctly outside this set.
 *
 * THIS IS THE WHOLE DEFINITION of the npm set since the ruling: `npmPublishSet()` (the manifest flag,
 * which is what the workflow filters on) must equal this exactly, and `release-gates.test.ts` asserts
 * it in both directions -- a new runtime dependency of the wrapper cannot be forgotten, and nothing
 * else can be added.
 */
export function npmRequiredClosure(root: string = REPO_ROOT): string[] {
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
  visit(NPM_ROOT_PACKAGE);
  return [...seen].sort();
}

/**
 * The npm set in PUBLISH ORDER: every package after the workspace dependencies it declares.
 *
 * P7a pre-publish round 4 (review I1). `discoverPublishablePackages()` sorts ALPHABETICALLY, so the
 * npm job published `winter-agent-sdk` BEFORE `winter-provider-catalog` -- the dependency its own
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
