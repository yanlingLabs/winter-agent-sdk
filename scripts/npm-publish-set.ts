// P7a pre-publish (item 5; user ruling 2026-09-08): WHICH PACKAGES GO TO PUBLIC npm.
//
// Every publishable package goes to GitHub Packages -- that is the org's own registry and the whole
// set belongs there. npm is different: it is what a PUBLIC consumer installs, so it gets the WRAPPER
// and its runtime dependency closure and nothing else. `@yanlinglabs/winter-conformance` and
// `@yanlinglabs/winter-provider-conformance` are the org's own test harnesses; publishing them
// publicly would offer a stranger a package whose only purpose is testing this repository.
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
 * Packages on npm that the wrapper's `dependencies` closure does NOT reach, each with the ruling.
 *
 * MEASURED, not assumed: the wrapper's own closure is `{winter-agent-sdk, winter-provider-catalog}`.
 * `winter-provider-runtime` is a dependency of the PRIVATE `winter-agent-runtime` (the compiled
 * `winter` binary), not of the wrapper -- the wrapper spawns that binary rather than importing it --
 * so a closure computed from `dependencies` alone will never contain it. It is on npm because the
 * user ruled it in: it is the provider layer a public host uses DIRECTLY (adapters, credential
 * stores, endpoint policy) and it is `engines.node`-importable, which is the whole point of the
 * compiled emit.
 *
 * The list is the ONE place a package may be on npm without being in the closure, so the parity test
 * can still be exact in both directions: nothing in the closure may be missing, and nothing outside
 * `closure ∪ this` may be present.
 */
export const NPM_RULED_EXTRAS: Readonly<Record<string, string>> = {
  "@yanlinglabs/winter-provider-runtime":
    "user ruling 2026-09-08: the provider layer a public host uses directly (adapters, credential stores, endpoint policy). Not in the wrapper's `dependencies` closure because the wrapper SPAWNS the compiled runtime rather than importing it -- `winter-provider-runtime` is the private `winter-agent-runtime`'s dependency, and that package is never published.",
};

/** `--filter <name>` per package, in the order `pnpm publish` should receive them. */
export function npmFilterArgs(root: string = REPO_ROOT): string[] {
  return npmPublishSet(root).flatMap((p) => ["--filter", p.name]);
}

if (import.meta.main) {
  // Printed as a single line the workflow interpolates into its `pnpm publish` command, so the YAML
  // never spells a package name.
  process.stdout.write(npmFilterArgs().join(" "));
}
