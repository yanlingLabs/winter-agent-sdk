// Task 11 (WS-03 §14 dual-compile, official half): proves the SAME consumer fixture
// (packages/conformance/consumer-fixtures/plain-query.fixture.ts) that already compiles against
// winter's own published surface (compile-fixtures.ts / tsconfig.winter.json) ALSO compiles against
// the real, checksum-verified official @anthropic-ai/claude-agent-sdk@0.3.250 package — a type-level
// drop-in-surface proof, not just a runtime one.
//
// Ephemeral end to end: fetchAndVerifyUpstream() re-verifies the pinned tarball (sha256 + the
// Task-11 sha512 integrity pin) before anything is installed, `npm install --no-save
// --ignore-scripts` lands it in a throwaway mkdtemp prefix (never this repo's own node_modules —
// no Anthropic artifact is ever committed or left behind, the rule since P0), and every temp
// directory this function owns is removed in `finally` regardless of outcome.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAndVerifyUpstream } from "./fetch-upstream.ts";
import { compile } from "./compile-fixtures.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASE_TSCONFIG = join(REPO_ROOT, "tsconfig.base.json");
const OFFICIAL_TSCONFIG_TEMPLATE = join(REPO_ROOT, "packages/conformance/tsconfig.official.json");
const FIXTURE_PATH = join(REPO_ROOT, "packages/conformance/consumer-fixtures/plain-query.fixture.ts");

export interface CompileResult {
  ok: boolean;
  output: string;
}

export async function compileOfficialFixture(): Promise<CompileResult> {
  // T11 review F1 (fix-wave, Minor): both temp-resource acquisitions now happen INSIDE the try,
  // registering a cleanup closure immediately after each succeeds — the ORIGINAL version acquired
  // both (fetchAndVerifyUpstream's owned tarball dir, then this mkdtemp) BEFORE the try began, so a
  // resource-exhaustion failure (ENOSPC/EMFILE — real under sustained CI load) in the SECOND
  // acquisition would strand the FIRST one, already on disk, with nothing left to clean it up
  // (the `finally` below never runs for either, since the throw happens before the try is entered).
  const cleanups: Array<() => void> = [];
  try {
    // Re-verified here (not merely relied upon from an earlier step) — this function must be safe
    // to call in isolation (as the CI job and a local ad-hoc run both do).
    const { tarballPath, ownedDir } = await fetchAndVerifyUpstream();
    if (ownedDir) cleanups.push(() => rmSync(dirname(tarballPath), { recursive: true, force: true }));
    const prefix = mkdtempSync(join(tmpdir(), "winter-official-fixture-"));
    cleanups.push(() => rmSync(prefix, { recursive: true, force: true }));

    const install = Bun.spawn(
      ["npm", "install", "--no-save", "--ignore-scripts", "--prefix", prefix, tarballPath],
      { stdout: "pipe", stderr: "pipe" },
    );
    const installOut = (await new Response(install.stdout).text()) + (await new Response(install.stderr).text());
    if ((await install.exited) !== 0) {
      return { ok: false, output: `npm install --prefix ${prefix} failed:\n${installOut}` };
    }

    const officialPkgDir = join(prefix, "node_modules", "@anthropic-ai", "claude-agent-sdk");
    const officialPkgJson = JSON.parse(readFileSync(join(officialPkgDir, "package.json"), "utf8")) as { types?: string };
    if (!officialPkgJson.types) {
      return { ok: false, output: `installed @anthropic-ai/claude-agent-sdk package.json has no "types" field` };
    }
    // Point @sdk-under-test at the concrete .d.ts FILE the installed package's own package.json
    // names — not the bare package directory — so path-mapping resolution can never depend on
    // directory-vs-file "paths" semantics differing across TS resolution modes.
    const officialTypesPath = join(officialPkgDir, officialPkgJson.types);

    // Built from the checked-in tsconfig.official.json's own template (so a future edit to that
    // file's shape — e.g. a new compilerOption — is picked up here too) with three overrides this
    // temp-directory run specifically needs:
    //   - paths: the bare "node_modules/..." entry only resolves from inside packages/conformance/,
    //     where nothing is actually installed; replaced with the resolved absolute .d.ts path above.
    //   - types: tsconfig.base.json's `"types": ["bun"]` resolves @types/bun by walking up from the
    //     CONFIG FILE's own directory — from a temp dir that lookup fails (TS2688). The fixture
    //     uses no Bun globals, so an empty typeRoots-free array is correct, not a workaround.
    //   - files (replacing include): pins the exact fixture file by absolute path rather than a
    //     relative glob, which would need to be re-anchored for a config file living outside the repo.
    const officialTsconfigTemplate = JSON.parse(readFileSync(OFFICIAL_TSCONFIG_TEMPLATE, "utf8")) as {
      compilerOptions?: Record<string, unknown>;
    };
    const generatedTsconfig = {
      extends: BASE_TSCONFIG,
      compilerOptions: {
        ...officialTsconfigTemplate.compilerOptions,
        types: [],
        paths: { "@sdk-under-test": [officialTypesPath] },
      },
      files: [FIXTURE_PATH],
    };
    const tsconfigPath = join(prefix, "tsconfig.official.generated.json");
    writeFileSync(tsconfigPath, JSON.stringify(generatedTsconfig, null, 2));

    // T11 review F2 (fix-wave, style): reuses compile-fixtures.ts's own compile() helper — the
    // spawn+read+exit-code logic below was a byte-for-byte duplicate of it.
    const r = await compile(tsconfigPath);
    return { ok: r.ok, output: installOut + r.output };
  } finally {
    for (const cleanup of cleanups) cleanup();
  }
}

if (import.meta.main) {
  const { ok, output } = await compileOfficialFixture();
  console.log(output);
  if (!ok) {
    console.error("official-fixture-compile FAILED");
    process.exit(1);
  }
  console.log("official-fixture-compile OK — the consumer fixture compiles against the real official @anthropic-ai/claude-agent-sdk@0.3.250 types");
}
