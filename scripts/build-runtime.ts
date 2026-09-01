// Compiles the winter runtime entrypoint (packages/runtime/src/main.ts) into a single-file,
// dependency-free executable via `bun build --compile` (Task 5, WS-02 §7.4). This is the artifact
// that actually ships: the darwin-arm64 platform package's `bin` field points at a copy of it
// (--platform-package below), and verify-protocol-compiled.ts proves it behaves identically to the
// in-memory/dev-child legs — a compiled `$bunfs` binary and `bun src/main.ts` are NOT guaranteed to
// behave the same (dynamic import()/import.meta.dir/require.resolve silently break only in the
// compiled form), so an actual compile is the only way to prove the compiled path, not just the
// dev path (mirrors this codebase's other "the real artifact is the proof" scripts, e.g.
// scripts/differential.ts against the golden).
//
// `bun build --compile` is CLI-only — as of this repo's pinned bun-types (1.4.0), Bun.build()'s JS
// API's `compile` option exists on paper but the brief pins the CLI invocation verbatim
// (`bun build --compile <entry> --outfile <out>`), so this shells out to the real CLI the same way
// scripts/gen-declaration-snapshot.ts shells out to `tar` — proving the exact command a developer
// or CI would run, not a JS-API approximation of it.
//
// Usage:
//   bun run scripts/build-runtime.ts                     # -> dist/winter
//   bun run scripts/build-runtime.ts --out <path>         # -> <path> (verify-protocol-compiled.ts's temp-path use)
//   bun run scripts/build-runtime.ts --platform-package   # -> packages/platform/darwin-arm64/bin/winter
//                                                          #    (staged binary is git-ignored — it ships at publish time only)
// --out and --platform-package are mutually exclusive (mirrors resolveRuntimeExecutable's
// explicit-option-beats-platform-package order in packages/sdk/src/transport.ts).

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRYPOINT = fileURLToPath(new URL("../packages/runtime/src/main.ts", import.meta.url));
const DEFAULT_OUT = fileURLToPath(new URL("../dist/winter", import.meta.url));
const PLATFORM_PACKAGE_OUT = fileURLToPath(new URL("../packages/platform/darwin-arm64/bin/winter", import.meta.url));

export interface BuildRuntimeOptions {
  out?: string; // explicit output path — wins over platformPackage
  platformPackage?: boolean; // stage into packages/platform/darwin-arm64/bin/winter
}

export interface BuildRuntimeResult {
  outPath: string;
  stdout: string;
  stderr: string;
}

export async function buildRuntime(opts: BuildRuntimeOptions = {}): Promise<BuildRuntimeResult> {
  if (opts.out && opts.platformPackage) {
    throw new Error("buildRuntime: `out` and `platformPackage` are mutually exclusive");
  }
  const outPath = opts.out ? resolve(opts.out) : opts.platformPackage ? PLATFORM_PACKAGE_OUT : DEFAULT_OUT;

  mkdirSync(dirname(outPath), { recursive: true });

  // REAL FINDING (bun 1.3.14): `bun build --compile` stages an unmodified copy of its base
  // executable template as a hidden `.<hash>-00000000.bun-build` file IN ITS CWD while assembling
  // the final --outfile, and does not always clean it up afterward (confirmed empirically: two
  // manual invocations from the repo root each left one such file behind, byte-identical to each
  // other, byte-DIFFERENT from the actual compiled output — i.e. a pre-injection base-binary
  // staging artifact, not a build product). Spawning from an ephemeral scratch cwd keeps any such
  // stray file out of the repo tree entirely regardless of bun's cleanup behavior in a given
  // version — `ENTRYPOINT` and `outPath` are both absolute, so cwd has no bearing on where the
  // bundler resolves imports from or where the real output lands.
  const scratchCwd = mkdtempSync(join(tmpdir(), "winter-build-runtime-"));
  try {
    // process.execPath under bun IS the bun binary (matches transport-equivalence.test.ts's own
    // spawnHook precedent for invoking bun itself rather than trusting a "bun" on PATH).
    const proc = Bun.spawn([process.execPath, "build", "--compile", ENTRYPOINT, "--outfile", outPath], {
      cwd: scratchCwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(`bun build --compile failed (exit ${exitCode}):\n${stderr || stdout}`);
    }
    return { outPath, stdout, stderr };
  } finally {
    rmSync(scratchCwd, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const platformPackage = process.argv.includes("--platform-package");
  const outIdx = process.argv.indexOf("--out");
  const out = outIdx === -1 ? undefined : process.argv[outIdx + 1];
  if (platformPackage && out) {
    console.error("build-runtime: --out and --platform-package are mutually exclusive");
    process.exit(1);
  }
  try {
    const { outPath } = await buildRuntime({ out, platformPackage });
    console.log(`built winter runtime -> ${outPath}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
