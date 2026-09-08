// P7a pre-publish round 3 (review I1 + §5): THE npm PUBLISH, per package, from `pnpm pack` tarballs.
//
// WHY NOT `pnpm publish`. pnpm's recursive publish REBUILDS npm's argv
// (`recursivePublish`, pnpm.cjs:188546) and forwards only `--access`, `--dry-run`, `--force` and
// `--otp`. `--provenance` is a recognised option -- so it does not error -- and is silently dropped:
// `id-token: write` was granted and never used, and the workflow's own test kept passing because it
// read the YAML text rather than the behaviour. `npm publish <tarball>` honours it.
//
// WHY THE TARBALLS COME FROM `pnpm pack`. The published manifest is dist-only through
// `publishConfig.exports`/`files` overrides, and pnpm applies those at pack time while plain
// `npm pack` IGNORES them -- so packing with npm here would publish a manifest whose `bun` condition
// names a `src/` the tarball does not contain. `releasePack()` already packs with pnpm and scans the
// result, so this reuses it rather than opening a second packing path.
//
// SKIP-IF-EXISTS, per package, against npm (review §5): a half-done release is finished by a
// `workflow_dispatch` re-drive at the SAME tag, never by a version bump -- a bump would leave the tag
// naming something other than what shipped, and both registries refuse a version they already hold.
//
// NOTHING HERE CHOOSES A REGISTRY. `actions/setup-node` (`registry-url` + `scope`) wrote a userconfig
// binding `@yanlinglabs` to npmjs with the matching `_authToken`, and `NPM_CONFIG_USERCONFIG` points
// npm at it. Passing `--registry` here would set only `registries.default`, which the scope binding
// outranks -- the exact trap review C1 documents.
import { readFileSync } from "node:fs";
import { discoverPublishablePackages } from "./release-pack.ts";
import { decidePublishes, formatDecisions, probeWithNpmView, type PublishDecision } from "./already-published.ts";

const NPM_REGISTRY = "https://registry.npmjs.org";

export interface PublishPlanEntry {
  name: string;
  version: string;
  tarballPath: string;
}

/** `npm publish <tarball> --provenance --access public` -- the flags npm honours and pnpm drops. */
export function npmPublishArgs(tarballPath: string): string[] {
  return ["npm", "publish", tarballPath, "--provenance", "--access", "public"];
}

/**
 * Runs one publish. Separated so the caller's loop is testable and so a failure names the package.
 *
 * `dryRun` appends `--dry-run`: npm then prints the target registry and the tarball contents and
 * exits without uploading, which is what the routing gate uses.
 */
export async function publishOne(entry: PublishPlanEntry, opts: { dryRun?: boolean } = {}): Promise<{ ok: boolean; output: string }> {
  const args = [...npmPublishArgs(entry.tarballPath), ...(opts.dryRun === true ? ["--dry-run"] : [])];
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ok: exitCode === 0, output: (stdout + stderr).trim() };
}

if (import.meta.main) {
  const namesArg = process.argv.find((a) => a.startsWith("--packages="))?.split("=").slice(1).join("=") ?? process.argv[process.argv.indexOf("--packages") + 1];
  if (namesArg === undefined || namesArg.startsWith("--") || namesArg.trim() === "") {
    console.error("publish-npm-set: --packages \"<name> <name>\" is required (the workflow supplies it from scripts/npm-publish-set.ts)");
    process.exit(1);
  }
  const wanted = new Set(namesArg.trim().split(/\s+/));
  const dryRun = process.argv.includes("--dry-run");

  const { releasePack } = await import("./release-pack.ts");
  const packed = await releasePack({});
  if (packed.violations.length > 0) {
    console.error(`publish-npm-set: refusing to publish -- the tarball scan found violations:\n${packed.violations.join("\n")}`);
    process.exit(1);
  }

  const known = new Map(discoverPublishablePackages().map((p) => [p.name, p]));
  for (const name of wanted) {
    if (!known.has(name)) {
      console.error(`publish-npm-set: "${name}" is not a publishable package in this workspace`);
      process.exit(1);
    }
  }

  const plan: PublishPlanEntry[] = packed.packages
    .filter((p) => wanted.has(p.name))
    .map((p) => ({ name: p.name, version: (JSON.parse(readFileSync(known.get(p.name)!.packageJsonPath, "utf8")) as { version: string }).version, tarballPath: p.tarballPath }));
  if (plan.length !== wanted.size) {
    console.error(`publish-npm-set: packed ${plan.length} of the ${wanted.size} requested package(s)`);
    process.exit(1);
  }

  const decisions: PublishDecision[] = decidePublishes(plan, probeWithNpmView(NPM_REGISTRY));
  console.log(`publish-npm-set: ${plan.length} package(s) requested`);
  console.log(formatDecisions(NPM_REGISTRY, decisions));

  let failed = 0;
  for (const decision of decisions) {
    if (!decision.publish) continue;
    const entry = plan.find((p) => p.name === decision.name)!;
    const result = await publishOne(entry, dryRun ? { dryRun: true } : {});
    console.log(`publish-npm-set: ${result.ok ? "OK" : "FAILED"} ${entry.name}@${entry.version}\n${result.output}`);
    if (!result.ok) failed++;
  }
  if (failed > 0) {
    console.error(`publish-npm-set: ${failed} package(s) failed to publish`);
    process.exit(1);
  }
  console.log("publish-npm-set: done");
}
