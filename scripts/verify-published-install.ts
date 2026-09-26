// P7a Lane C, Step 4 (WS-02 §9 amendment, "Cross-repo read access is the org's configuration"): the
// cross-repo ACCEPTANCE step for a real publish. NEVER runs in CI (grep -rn WINTER_PACKAGES_TOKEN
// .github/ finds nothing; release-gates.test.ts pins that). This is a LOCAL OPERATOR step: once a
// maintainer has actually published from `release.yml` (a `v*` tag push or a `workflow_dispatch`),
// this proves a THROWAWAY checkout OUTSIDE this monorepo -- no workspace, no local lockfile, no
// `.npmrc` this repo committed -- can read the package back with a plain `read:packages` token,
// exactly as the router repository's own CI (`github.com/yanlingLabs/winter-runtime-sdk`) will need
// to when it bumps its pin (WS-02 §"Execution amendments — Phase 7a": "a package published from this
// repository is readable by the router repository's CI only with a token holding `read:packages`").
//
// Mirrors `scripts/verify-provider-live.ts`'s own shape: an opt-in env var gate, one printed line
// when not opted in, a `main()` exported for the hermetic spawn-based test, and `process.exitCode`
// (never `process.exit()`) so a `finally` cleanup always runs.
//
// WS-23: the same throwaway checkout then installs `@yanlinglabs/winter-agent-runtime` (the package an
// embedding host -- Winter's daemon -- installs by name), imports its side-effect-free `./version`, and
// proves the runtime, the wrapper and the platform package resolve at ONE exact version
// (`checkExactPins`, hermetically tested over planted trees).
//
// Usage:
//   WINTER_PACKAGES_TOKEN=ghp_xxx bun run scripts/verify-published-install.ts          # the current VERSION file's version
//   WINTER_PACKAGES_TOKEN=ghp_xxx bun run scripts/verify-published-install.ts 0.1.2    # pin an exact version
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { toSemver } from "./sync-version.ts";

export const OPT_IN_VAR = "WINTER_PACKAGES_TOKEN";
export const SKIPPED_LINE =
  "verify:published-install skipped: not opted in (set WINTER_PACKAGES_TOKEN=<a GitHub Packages token with read:packages> to install @yanlinglabs/winter-conformance and @yanlinglabs/winter-agent-runtime from a throwaway checkout outside this monorepo)";

/** WS-23: the embedding root and the two packages it must install beside at the SAME version. */
export const RUNTIME_PACKAGE = "@yanlinglabs/winter-agent-runtime";
export const WRAPPER_PACKAGE = "@yanlinglabs/winter-agent-sdk";
export const PLATFORM_PACKAGE = "@yanlinglabs/winter-agent-sdk-darwin-arm64";

/**
 * WS-23: the EXACT-PIN check over an installed tree -- what an embedding host (Winter's daemon) gets
 * when it installs `@yanlinglabs/winter-agent-runtime@<version>`.
 *
 * The runtime runs in the host's process and talks to the wrapper's `query()` over the same frame
 * protocol a spawned binary would, so a runtime and a wrapper at two versions are a mixed pair nobody
 * tested. `workspace:*` packs to an exact version, which is what keeps them together; this proves the
 * PUBLISHED manifests actually say so, and that the tree a consumer gets resolves one version of each:
 *
 *   - the runtime's own manifest pins the wrapper at exactly `version` (not a range);
 *   - the wrapper the RUNTIME resolves (through its own `require`, as bun's isolated linker nests it)
 *     is `version`;
 *   - that wrapper pins its platform binary package at exactly `version`, and -- when the platform
 *     package is installed at all (a darwin-arm64 host; npm skips it elsewhere) -- it is `version` too.
 *
 * Pure over a directory (`installRoot` holds `node_modules`), so the hermetic suite can plant trees.
 * Returns the problems; empty means the triple is exact.
 */
export function checkExactPins(installRoot: string, version: string): string[] {
  const problems: string[] = [];
  const req = createRequire(join(installRoot, "package.json"));
  let runtimeManifestPath: string;
  try {
    runtimeManifestPath = req.resolve(`${RUNTIME_PACKAGE}/package.json`);
  } catch {
    return [`${RUNTIME_PACKAGE} is not installed under ${installRoot}`];
  }
  const runtime = JSON.parse(readFileSync(runtimeManifestPath, "utf8")) as { version: string; dependencies?: Record<string, string> };
  if (runtime.version !== version) problems.push(`${RUNTIME_PACKAGE} installed at ${runtime.version}, expected ${version}`);
  const pinnedWrapper = runtime.dependencies?.[WRAPPER_PACKAGE];
  if (pinnedWrapper !== version) problems.push(`${RUNTIME_PACKAGE} pins ${WRAPPER_PACKAGE} at ${JSON.stringify(pinnedWrapper)}, expected exactly "${version}"`);
  let wrapperManifestPath: string;
  try {
    wrapperManifestPath = createRequire(runtimeManifestPath).resolve(`${WRAPPER_PACKAGE}/package.json`);
  } catch {
    problems.push(`${WRAPPER_PACKAGE} does not resolve from ${RUNTIME_PACKAGE}`);
    return problems;
  }
  const wrapper = JSON.parse(readFileSync(wrapperManifestPath, "utf8")) as { version: string; optionalDependencies?: Record<string, string> };
  if (wrapper.version !== version) problems.push(`${WRAPPER_PACKAGE} (as ${RUNTIME_PACKAGE} resolves it) is ${wrapper.version}, expected ${version}`);
  const pinnedPlatform = wrapper.optionalDependencies?.[PLATFORM_PACKAGE];
  if (pinnedPlatform !== version) problems.push(`${WRAPPER_PACKAGE} pins ${PLATFORM_PACKAGE} at ${JSON.stringify(pinnedPlatform)}, expected exactly "${version}"`);
  let platformManifestPath: string | undefined;
  try {
    platformManifestPath = createRequire(wrapperManifestPath).resolve(`${PLATFORM_PACKAGE}/package.json`);
  } catch {
    platformManifestPath = undefined; // an optional dependency npm skipped on a non-matching host
  }
  if (platformManifestPath !== undefined && existsSync(platformManifestPath)) {
    const platform = JSON.parse(readFileSync(platformManifestPath, "utf8")) as { version: string };
    if (platform.version !== version) problems.push(`${PLATFORM_PACKAGE} installed at ${platform.version} (${dirname(platformManifestPath)}), expected ${version}`);
  }
  return problems;
}

/** The exact version this repo's own release pipeline would publish next -- the committed VERSION file, synced the same way `sync-version.ts` does. */
export function currentPublishedVersion(): string {
  return toSemver(readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim());
}

/**
 * review r1 Minor-5: names the runtime `process.execPath` ACTUALLY spawns, rather than assuming
 * "node". Under `bun run scripts/verify-published-install.ts` (the only way this script runs; there
 * is no separate Node entry point for it) `process.execPath` is the Bun binary, so a hard-coded
 * "failed under node" message was always inaccurate -- it never once exercised Node.
 */
export function runtimeLabel(): string {
  return typeof process.versions.bun === "string" ? `Bun ${process.versions.bun}` : process.execPath;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const token = process.env[OPT_IN_VAR];
  if (!token) {
    console.log(SKIPPED_LINE);
    return;
  }

  const version = argv[0] ?? currentPublishedVersion();
  const spec = `@yanlinglabs/winter-conformance@${version}`;

  // Outside the monorepo ON PURPOSE (a fresh mkdtemp under the OS temp root, never a subdirectory of
  // this checkout): the whole point is proving what a repository that has never heard of this
  // workspace's pnpm-workspace.yaml, lockfile, or root .npmrc actually experiences.
  const probeDir = mkdtempSync(join(tmpdir(), "winter-verify-published-install-"));
  try {
    writeFileSync(join(probeDir, "package.json"), JSON.stringify({ name: "winter-verify-published-install-probe", private: true, version: "0.0.0" }, null, 2) + "\n");
    writeFileSync(join(probeDir, ".npmrc"), `@yanlinglabs:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${token}\n`);

    const add = Bun.spawnSync(["pnpm", "add", spec], { cwd: probeDir, stdout: "pipe", stderr: "pipe" });
    if (add.exitCode !== 0) {
      throw new Error(`pnpm add ${spec} failed (exit ${add.exitCode}):\n${decode(add.stdout)}${decode(add.stderr)}`);
    }

    const runtime = runtimeLabel();
    const probeScript = `import(${JSON.stringify("@yanlinglabs/winter-conformance/trace")}).then((m) => { if (typeof m.normalizeTrace !== "function") throw new Error("normalizeTrace missing from the installed package"); console.log("import ok"); });`;
    const run = Bun.spawnSync([process.execPath, "-e", probeScript], { cwd: probeDir, stdout: "pipe", stderr: "pipe" });
    if (run.exitCode !== 0) {
      throw new Error(`import("@yanlinglabs/winter-conformance/trace") failed under ${runtime} (exit ${run.exitCode}):\n${decode(run.stdout)}${decode(run.stderr)}`);
    }

    // WS-23: the embedding root, into the SAME throwaway checkout. Its version module imports nothing,
    // so importing it proves the dist entry resolves without evaluating the engine; then the exact-pin
    // triple is read off the installed tree (`checkExactPins`).
    const runtimeSpec = `${RUNTIME_PACKAGE}@${version}`;
    const addRuntime = Bun.spawnSync(["pnpm", "add", runtimeSpec], { cwd: probeDir, stdout: "pipe", stderr: "pipe" });
    if (addRuntime.exitCode !== 0) {
      throw new Error(`pnpm add ${runtimeSpec} failed (exit ${addRuntime.exitCode}):\n${decode(addRuntime.stdout)}${decode(addRuntime.stderr)}`);
    }
    const versionProbe = `import(${JSON.stringify(`${RUNTIME_PACKAGE}/version`)}).then((m) => { if (m.RUNTIME_VERSION !== ${JSON.stringify(version)}) throw new Error("RUNTIME_VERSION is " + m.RUNTIME_VERSION); console.log("import ok"); });`;
    const runVersion = Bun.spawnSync([process.execPath, "-e", versionProbe], { cwd: probeDir, stdout: "pipe", stderr: "pipe" });
    if (runVersion.exitCode !== 0) {
      throw new Error(`import("${RUNTIME_PACKAGE}/version") failed under ${runtime} (exit ${runVersion.exitCode}):\n${decode(runVersion.stdout)}${decode(runVersion.stderr)}`);
    }
    const pinProblems = checkExactPins(probeDir, version);
    if (pinProblems.length > 0) throw new Error(`the installed runtime/wrapper/platform triple is not exactly ${version}:\n  ${pinProblems.join("\n  ")}`);

    console.log(`verify:published-install OK -- ${spec} installs from GitHub Packages into a throwaway checkout and ./trace imports cleanly under ${runtime}`);
    console.log(`verify:published-install OK -- ${runtimeSpec} installs beside it, ./version reports ${version}, and the runtime, wrapper and platform package are pinned exactly`);
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
