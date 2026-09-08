// P7a Lane C, fix round 2 (review r1, Important-4 / the fix that would have caught both Criticals):
// the install-from-tarball smoke test, generalized to cover EVERY publishable package's bare entry
// point AND every declared `exports` subpath -- derived at RUN TIME from each package's own
// package.json, so a new subpath can never be silently left unchecked the way review r1's Critical
// Findings 1-2 were (the pre-fix smoke legs checked only `@yanlinglabs/winter-agent-sdk` bare and
// `@yanlinglabs/winter-conformance/trace` -- 2 of 5 packages' 10 total entry points).
//
// Both `.github/workflows/ci.yml` (the blocking Bun leg in `pack-smoke`, the advisory Node-18 leg in
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
}

interface ExportsField {
  exports?: Record<string, unknown> | string;
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
    const exportsField = manifest.exports;
    if (exportsField === undefined || typeof exportsField === "string") {
      targets.push({ specifier: pkg.name, packageName: pkg.name });
      continue;
    }
    for (const key of Object.keys(exportsField)) {
      const specifier = key === "." ? pkg.name : `${pkg.name}/${key.replace(/^\.\//, "")}`;
      targets.push({ specifier, packageName: pkg.name });
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
