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
// Usage:
//   WINTER_PACKAGES_TOKEN=ghp_xxx bun run scripts/verify-published-install.ts          # the current VERSION file's version
//   WINTER_PACKAGES_TOKEN=ghp_xxx bun run scripts/verify-published-install.ts 0.1.2    # pin an exact version
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toSemver } from "./sync-version.ts";

export const OPT_IN_VAR = "WINTER_PACKAGES_TOKEN";
export const SKIPPED_LINE =
  "verify:published-install skipped: not opted in (set WINTER_PACKAGES_TOKEN=<a GitHub Packages token with read:packages> to install @yanlinglabs/winter-conformance from a throwaway checkout outside this monorepo)";

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

    console.log(`verify:published-install OK -- ${spec} installs from GitHub Packages into a throwaway checkout and ./trace imports cleanly under ${runtime}`);
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
