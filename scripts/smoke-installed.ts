// P7a Lane C, fix round 2 (review r1, Important-4 / the fix that would have caught both Criticals):
// the install-from-tarball smoke test, generalized to cover EVERY publishable package's bare entry
// point AND every declared `exports` subpath -- derived at RUN TIME from each package's own
// package.json, so a new subpath can never be silently left unchecked the way review r1's Critical
// Findings 1-2 were (the pre-fix smoke legs checked only `@yanlinglabs/winter-agent-sdk` bare and
// `@yanlinglabs/winter-conformance/trace` -- 2 of 5 packages' 10 total entry points).
//
// Both `.github/workflows/ci.yml` (the Bun leg in `pack-smoke`, the Node-18 leg in
// `pack-smoke-node18`) and `.github/workflows/release.yml` (the publish-gate smoke, both runtimes,
// fully blocking) call this ONE script rather than duplicating the probe logic inline -- review r1
// Important-4's own suggested fix names exactly this file.
//
// WHAT IT DOES, in order: (1) packs every publishable package fresh via `releasePack()` (which also
// runs the tarball-content scan -- a violation here aborts before anything is installed); (2) writes
// a throwaway `package.json` + does ONE `npm install --offline` of every packed tarball into a fresh
// mkdtemp OUTSIDE the repo (npm alone correctly cross-resolves each package's inter-dependency
// against the other tarballs on the same command line; `bun install` does not -- see `pack-smoke`'s
// own comment in ci.yml for the empirical proof); (3) for each requested runtime, spawns `node -e` /
// `bun -e` against that ONE installed tree, importing every derived target in turn and FAILING LOUDLY
// (stopping immediately, printing what failed) on the first import error.
//
// Usage:
//   bun run scripts/smoke-installed.ts                  # both runtimes
//   bun run scripts/smoke-installed.ts --runtime=bun     # Bun only
//   bun run scripts/smoke-installed.ts --runtime=node    # Node only
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPublishablePackages, releasePack, type PublishablePackage } from "./release-pack.ts";

export type SmokeRuntime = "node" | "bun";

export interface ImportTarget {
  /** The exact specifier to import, e.g. "@yanlinglabs/winter-agent-sdk" or "@yanlinglabs/winter-conformance/trace". */
  specifier: string;
  packageName: string;
  /** The runtimes this target must import under, from its package's own `engines` (see `runtimesFor`). */
  runtimes: SmokeRuntime[];
}

interface ExportsField {
  exports?: Record<string, unknown> | string;
  engines?: Record<string, string>;
}

/**
 * P7a fix wave (item 1 + item 11 N-1): WHICH RUNTIMES A TARGET MUST IMPORT UNDER, from its package's
 * own `engines`.
 *
 * Before the compiled emit, EVERY package failed under Node and the Node leg was carried as a
 * disclosed advisory (R-7a-16). It is blocking now -- but "every target under both runtimes" is not
 * the right assertion either, and never was: `@yanlinglabs/winter-provider-conformance` stands up
 * loopback servers with `Bun.serve` (`fakes/server.ts` imports `serve` from `"bun"`), which is a
 * DELIBERATE design decision `tsconfig.sdk-fence.json` already records in prose. A compiled emit
 * cannot change that and should not try.
 *
 * So the requirement is DECLARED, per package, in the one field npm already has for it. `engines.node`
 * means "a Node consumer may import this" and the Node leg asserts it; `engines.bun` alone means
 * Bun-only. A package declaring NEITHER is required under both -- fail closed, so a new package
 * cannot opt out of the gate by omission.
 */
export function runtimesFor(manifest: ExportsField): SmokeRuntime[] {
  const engines = manifest.engines ?? {};
  const declaresNode = engines["node"] !== undefined;
  const declaresBun = engines["bun"] !== undefined;
  if (!declaresNode && !declaresBun) return ["node", "bun"];
  const out: SmokeRuntime[] = [];
  if (declaresNode) out.push("node");
  out.push("bun"); // Bun runs everything this repo produces, declared or not
  return out;
}

/**
 * Every publishable package's bare specifier PLUS every declared `exports` subpath, derived from
 * each package's OWN package.json (never hand-maintained) -- review r1 Important-4's "cannot be
 * forgotten" property. A package with no `exports` map (or a single-string one) contributes just its
 * bare name; a package with a `{ ".": ..., "./sub": ... }` map contributes one target per key.
 */
export function deriveImportTargets(packages: readonly PublishablePackage[] = discoverPublishablePackages()): ImportTarget[] {
  const targets: ImportTarget[] = [];
  for (const pkg of packages) {
    const manifest = JSON.parse(readFileSync(pkg.packageJsonPath, "utf8")) as ExportsField;
    const runtimes = runtimesFor(manifest);
    const exportsField = manifest.exports;
    if (exportsField === undefined || typeof exportsField === "string") {
      targets.push({ specifier: pkg.name, packageName: pkg.name, runtimes });
      continue;
    }
    for (const key of Object.keys(exportsField)) {
      const specifier = key === "." ? pkg.name : `${pkg.name}/${key.replace(/^\.\//, "")}`;
      targets.push({ specifier, packageName: pkg.name, runtimes });
    }
  }
  return targets.sort((a, b) => a.specifier.localeCompare(b.specifier));
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Spawns `node -e` / `bun -e` importing exactly one specifier, cwd'd into the installed probe. */
async function importUnder(runtime: SmokeRuntime, specifier: string, probeDir: string): Promise<{ ok: boolean; output: string }> {
  const code = `import(${JSON.stringify(specifier)}).then(() => { console.log(${JSON.stringify(`${runtime}: ${specifier} OK`)}); }).catch((e) => { console.error(${JSON.stringify(`${runtime}: ${specifier} FAILED:`)}, e && e.message ? e.message : e); process.exit(1); });`;
  const proc = Bun.spawn([runtime, "-e", code], { cwd: probeDir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ok: exitCode === 0, output: (stdout + stderr).trim() };
}

export interface SmokeResult {
  ok: boolean;
  /** Every (runtime, target) pair attempted, in order, up to and including the first failure. */
  results: Array<{ specifier: string; runtime: SmokeRuntime; ok: boolean; output: string }>;
  targets: ImportTarget[];
}

export async function runSmoke(opts: { runtimes?: readonly SmokeRuntime[] } = {}): Promise<SmokeResult> {
  const runtimes = opts.runtimes ?? (["node", "bun"] as const);
  const outDir = mkdtempSync(join(tmpdir(), "winter-smoke-pack-"));
  const probeDir = mkdtempSync(join(tmpdir(), "winter-smoke-probe-"));
  const results: SmokeResult["results"] = [];
  try {
    const packed = await releasePack({ outDir });
    if (packed.violations.length > 0) {
      throw new Error(`release-pack found violations, refusing to smoke-test:\n${packed.violations.join("\n")}`);
    }
    const targets = deriveImportTargets();

    // Outside the monorepo on purpose: a fresh mkdtemp, no pnpm-workspace.yaml, no lockfile, no
    // committed .npmrc in scope -- the only thing that could make this succeed is the packed
    // tarballs themselves resolving each other correctly.
    writeFileSync(join(probeDir, "package.json"), JSON.stringify({ name: "winter-smoke-probe", private: true, version: "0.0.0" }, null, 2) + "\n");
    const install = Bun.spawnSync(["npm", "install", "--offline", ...packed.packages.map((p) => p.tarballPath)], { cwd: probeDir, stdout: "pipe", stderr: "pipe" });
    if (install.exitCode !== 0) {
      throw new Error(`npm install --offline failed (exit ${install.exitCode}):\n${decode(install.stdout)}${decode(install.stderr)}`);
    }

    for (const runtime of runtimes) {
      for (const target of targets) {
        if (!target.runtimes.includes(runtime)) {
          console.log(`smoke-installed SKIP: ${runtime} import of "${target.specifier}" -- that package declares no \`engines.${runtime}\``);
          continue;
        }
        const result = await importUnder(runtime, target.specifier, probeDir);
        results.push({ specifier: target.specifier, runtime, ok: result.ok, output: result.output });
        if (!result.ok) {
          console.error(`smoke-installed FAILED: ${runtime} import of "${target.specifier}"\n${result.output}`);
          return { ok: false, results, targets };
        }
        console.log(`smoke-installed OK: ${runtime} import of "${target.specifier}"`);
      }
    }
    return { ok: true, results, targets };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    rmSync(probeDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const runtimeArg = process.argv.find((a) => a.startsWith("--runtime="))?.split("=")[1];
  if (runtimeArg !== undefined && runtimeArg !== "node" && runtimeArg !== "bun") {
    console.error(`smoke-installed: --runtime must be "node" or "bun", got "${runtimeArg}"`);
    process.exit(1);
  }
  const { ok, targets } = await runSmoke(runtimeArg ? { runtimes: [runtimeArg] } : {});
  console.log(`smoke-installed: ${targets.length} target(s) across every publishable package's exports map`);
  if (!ok) process.exitCode = 1;
  else console.log("smoke-installed OK -- every target imports cleanly under every requested runtime");
}
