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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPublishablePackages, releasePack, type PublishablePackage } from "./release-pack.ts";

export type SmokeRuntime = "node" | "bun";

export interface ImportTarget {
  kind: "import";
  /** The exact specifier to import, e.g. "@yanlinglabs/winter-agent-sdk" or "@yanlinglabs/winter-conformance/trace". */
  specifier: string;
  packageName: string;
  /** The runtimes this target must import under, from its package's own `engines` (see `runtimesFor`). */
  runtimes: SmokeRuntime[];
}

/**
 * P9a-5: a BIN-ONLY package's smoke target (the darwin-arm64 platform package today). There is no
 * `specifier` to import -- the package declares no `exports` at all -- so the smoke instead runs the
 * declared binary itself with `--version` and checks the printed version against the package's own.
 * `os`/`cpu` mirror the manifest fields verbatim (M1): when they do not match the CURRENT host, the
 * target is a SKIP, never an attempt (the file cannot exist there by construction -- P9a-4, `bun
 * build --compile` never cross-compiles).
 */
export interface BinTarget {
  kind: "bin";
  package: string;
  version: string;
  /** Absolute path to the bin file this package's manifest declares. */
  bin: string;
  os?: string[];
  cpu?: string[];
}

export type SmokeTarget = ImportTarget | BinTarget;

/** One attempt's outcome, discriminated the same way as the target it came from. */
export type SmokeAttempt =
  | { kind: "import"; specifier: string; runtime: SmokeRuntime; ok: boolean; output: string }
  | { kind: "bin"; package: string; ok: boolean; output: string; skipped: boolean };

interface ExportsField {
  exports?: Record<string, unknown> | string;
  engines?: Record<string, string>;
  bin?: string | Record<string, string>;
  os?: string[];
  cpu?: string[];
  version?: string;
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
 *
 * P9a-5: a package with NO `exports` AND a `bin` field (the darwin-arm64 platform package) is
 * BIN-ONLY -- it contributes a single `BinTarget` instead of an (unimportable) bare specifier. The
 * `bin` path is resolved relative to the INSTALLED package directory at smoke time (`probeDir`'s
 * `node_modules/<name>/...`), so this function alone cannot make it absolute; `runBinTarget` and the
 * caller in `runSmoke` do that once the probe install exists (see `resolveBinTargetPath`).
 */
export function deriveImportTargets(packages: readonly PublishablePackage[] = discoverPublishablePackages()): SmokeTarget[] {
  const targets: SmokeTarget[] = [];
  for (const pkg of packages) {
    const manifest = JSON.parse(readFileSync(pkg.packageJsonPath, "utf8")) as ExportsField;
    const exportsField = manifest.exports;
    if (exportsField === undefined && manifest.bin !== undefined) {
      const binField = manifest.bin;
      const relBin = typeof binField === "string" ? binField : Object.values(binField)[0];
      if (relBin === undefined) continue; // malformed manifest -- nothing to smoke, nothing to import either
      targets.push({
        kind: "bin",
        package: pkg.name,
        version: manifest.version ?? pkg.version,
        bin: join(pkg.dir, relBin),
        ...(manifest.os !== undefined ? { os: manifest.os } : {}),
        ...(manifest.cpu !== undefined ? { cpu: manifest.cpu } : {}),
      });
      continue;
    }
    const runtimes = runtimesFor(manifest);
    if (exportsField === undefined || typeof exportsField === "string") {
      targets.push({ kind: "import", specifier: pkg.name, packageName: pkg.name, runtimes });
      continue;
    }
    for (const key of Object.keys(exportsField)) {
      const specifier = key === "." ? pkg.name : `${pkg.name}/${key.replace(/^\.\//, "")}`;
      targets.push({ kind: "import", specifier, packageName: pkg.name, runtimes });
    }
  }
  return targets.sort((a, b) => {
    const an = a.kind === "import" ? a.specifier : a.package;
    const bn = b.kind === "import" ? b.specifier : b.package;
    return an.localeCompare(bn);
  });
}

/**
 * `deriveImportTargets()` reads a `BinTarget`'s `bin` from the WORKSPACE package dir -- there is no
 * other source of truth for the relative path there. `runSmoke`'s probe installs into a throwaway
 * project instead, so the file actually executed there is the INSTALLED copy; re-read from the
 * INSTALLED manifest (never by mangling the workspace path into a probe one) so a package whose
 * `bin` moves is still found correctly.
 */
export function resolveBinTargetPath(target: BinTarget, probeDir: string): string {
  const installedPkgDir = join(probeDir, "node_modules", ...target.package.split("/"));
  const manifest = JSON.parse(readFileSync(join(installedPkgDir, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
  const binField = manifest.bin;
  const relBin = typeof binField === "string" ? binField : binField !== undefined ? Object.values(binField)[0] : undefined;
  if (relBin === undefined) throw new Error(`resolveBinTargetPath: ${target.package}'s installed manifest has no "bin" entry`);
  return join(installedPkgDir, relBin);
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

/**
 * P9a-5: executes `<bin> --version` when the target's declared `os`/`cpu` matches the CURRENT host,
 * and asserts the printed line equals the package's own `version` exactly. On a mismatching host the
 * file cannot exist by construction (P9a-4), so this SKIPS with the exact printed reason rather than
 * attempting a spawn that could only ever fail with ENOENT for the wrong reason.
 */
export async function runBinTarget(target: BinTarget, binPath: string = target.bin): Promise<{ ok: boolean; output: string; skipped: boolean }> {
  const osOk = target.os === undefined || target.os.includes(process.platform);
  const cpuOk = target.cpu === undefined || target.cpu.includes(process.arch);
  if (!osOk || !cpuOk) {
    const line = `smoke-installed: SKIP ${target.package} (bin-only; os/cpu mismatch on ${process.platform}/${process.arch})`;
    console.log(line);
    return { ok: true, output: line, skipped: true };
  }
  const proc = Bun.spawn([binPath, "--version"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    return { ok: false, output: `${target.package}: \`${binPath} --version\` exited ${exitCode}: ${(stdout + stderr).trim()}`, skipped: false };
  }
  const printed = stdout.trim();
  if (printed !== target.version) {
    return { ok: false, output: `${target.package}: \`${binPath} --version\` printed "${printed}", expected "${target.version}"`, skipped: false };
  }
  return { ok: true, output: `${target.package}: --version OK (${printed})`, skipped: false };
}

/**
 * Every violation of the dist-only contract in an INSTALLED tree: a `src/` directory on disk, or a
 * manifest whose `exports` still names one (a `bun` condition, or any condition under `./src/`).
 *
 * Exported so `smoke-installed.test.ts` can drive it against a synthetic tree rather than only
 * against the real one -- a check that has never been shown failing is a check nobody can trust.
 */
export function assertInstalledTreeIsDistOnly(probeDir: string, packageNames: readonly string[]): string[] {
  const violations: string[] = [];
  for (const name of packageNames) {
    const pkgDir = join(probeDir, "node_modules", ...name.split("/"));
    if (existsSync(join(pkgDir, "src"))) violations.push(`  ${name}: node_modules/${name}/src exists -- a published package ships compiled output only`);
    const manifestPath = join(pkgDir, "package.json");
    if (!existsSync(manifestPath)) {
      violations.push(`  ${name}: installed but has no package.json`);
      continue;
    }
    const exportsField = (JSON.parse(readFileSync(manifestPath, "utf8")) as { exports?: Record<string, unknown> | string }).exports;
    if (typeof exportsField !== "object" || exportsField === null) continue;
    for (const [subpath, conditions] of Object.entries(exportsField)) {
      const targets = typeof conditions === "string" ? { default: conditions } : (conditions as Record<string, unknown>);
      for (const [condition, target] of Object.entries(targets)) {
        if (condition === "bun") violations.push(`  ${name}: installed exports["${subpath}"] still carries a \`bun\` condition (${String(target)}), which points outside a dist-only package`);
        if (typeof target === "string" && target.startsWith("./src/")) violations.push(`  ${name}: installed exports["${subpath}"].${condition} names ${target}, which is not in a dist-only package`);
      }
    }
  }
  return violations;
}

export interface SmokeResult {
  ok: boolean;
  /** Every attempt (import or bin), in order, up to and including the first failure. */
  results: SmokeAttempt[];
  targets: SmokeTarget[];
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

    // P7a pre-publish round 2 (item 8): the INSTALLED tree is dist-only, asserted before a single
    // import is attempted. `releasePack`'s scan reads the tarballs; this reads what npm actually
    // WROTE -- the same fact one step further along, and the step a consumer lives in. A `bun`
    // condition surviving here would send Bun to a `src/` path that is not on disk, which is the one
    // failure the source-condition design makes possible and the one no import test would attribute
    // correctly (it looks like a missing module, not a manifest that lies).
    const distOnly = assertInstalledTreeIsDistOnly(probeDir, packed.packages.map((p) => p.name));
    if (distOnly.length > 0) throw new Error(`the installed tree is not dist-only:\n${distOnly.join("\n")}`);

    // P9a-5: bin targets run ONCE per `runSmoke()` call, independent of which `runtimes` were
    // requested -- a compiled binary is not a Node/Bun import, so there is nothing for the runtime
    // loop below to gate it on. Both single-runtime CI jobs (`--runtime=node`/`--runtime=bun`) still
    // reach this exactly once each, which is the "both jobs stay on the skip path" ruling (P9a-5) on
    // a non-matching host, and a real execution on a matching one (the new macOS job).
    for (const target of targets) {
      if (target.kind !== "bin") continue;
      const binPath = resolveBinTargetPath(target, probeDir);
      const result = await runBinTarget(target, binPath);
      results.push({ kind: "bin", package: target.package, ok: result.ok, output: result.output, skipped: result.skipped });
      if (!result.ok) {
        console.error(`smoke-installed FAILED: bin check of "${target.package}"\n${result.output}`);
        return { ok: false, results, targets };
      }
      if (!result.skipped) console.log(`smoke-installed OK: bin check of "${target.package}"`);
    }

    for (const runtime of runtimes) {
      for (const target of targets) {
        if (target.kind !== "import") continue;
        if (!target.runtimes.includes(runtime)) {
          console.log(`smoke-installed SKIP: ${runtime} import of "${target.specifier}" -- that package declares no \`engines.${runtime}\``);
          continue;
        }
        const result = await importUnder(runtime, target.specifier, probeDir);
        results.push({ kind: "import", specifier: target.specifier, runtime, ok: result.ok, output: result.output });
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
  console.log(`smoke-installed: ${targets.length} target(s) across every publishable package's exports map and bin entries`);
  if (!ok) process.exitCode = 1;
  else console.log("smoke-installed OK -- every target imports/executes cleanly under every requested runtime");
}
