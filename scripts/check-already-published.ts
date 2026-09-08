// P7a pre-publish round 3 (review §5): job 1's REPORT of what its registry already holds.
//
// Reporting only -- it never fails the job and never skips anything itself, because `pnpm publish -r`
// does its own skipping and this step's value is that the LOG says which packages were already there
// and which were not. A `workflow_dispatch` re-drive at the same tag is then a readable operation
// rather than a guess about why pnpm printed "There are no new packages that should be published".
//
// Exit code is always 0: a registry that cannot be asked is a fact to print, not a reason to stop a
// publish that would have succeeded.
import { readFileSync } from "node:fs";
import { discoverPublishablePackages } from "./release-pack.ts";
import { decidePublishes, formatDecisions, probeWithNpmView } from "./already-published.ts";

if (import.meta.main) {
  const registry = process.argv.find((a) => a.startsWith("--registry="))?.split("=")[1] ?? process.argv[process.argv.indexOf("--registry") + 1];
  if (registry === undefined || registry.startsWith("--")) {
    console.error("check-already-published: --registry <url> is required");
    process.exit(1);
  }
  const packages = discoverPublishablePackages().map((pkg) => ({
    name: pkg.name,
    version: (JSON.parse(readFileSync(pkg.packageJsonPath, "utf8")) as { version: string }).version,
  }));
  const decisions = decidePublishes(packages, probeWithNpmView(registry));
  console.log(`check-already-published: ${decisions.filter((d) => !d.publish).length} of ${decisions.length} already on ${registry}`);
  console.log(formatDecisions(registry, decisions));
}
