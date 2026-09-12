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
// P9a-7 (P8d-27 carry, made STRUCTURAL): the compile runs from a PATH-NEUTRAL COPY of this repo,
// never this checkout directly. Bun's bundler writes module-boundary comments naming the SOURCE
// TREE it compiled from (`// ../../../../Users/<dev>/.../packages/runtime/src/...`), so compiling
// straight from a checkout that sits under a developer's home leaks that absolute path into every
// binary this script produces — measured empirically on Norma's own `build-winter.ts` (P8d-27,
// "the developer's own home path baked into `dist/winter` 475 times"), which is the CONSUMER of
// this exact function and until now carried the copy-then-compile dance itself, one call site
// removed from the thing that actually needed it. Doing it HERE means every caller — the platform
// package build, `verify:compiled`, `verify:workflow`, a bare `bun run build:runtime` — gets the
// same guarantee for free, and Norma's own copy of the mechanism becomes redundant rather than the
// only place it exists.
//
// The copy is `rsync -a --exclude .git` (preserves symlinks AS symlinks, never dereferencing —
// which is what lets pnpm's own RELATIVE `node_modules` symlinks survive intact) into a fresh
// `mkdtemp` dir whose path has no bearing on this developer's identity; the entrypoint is re-rooted
// at that copy, `--outfile` still points at the REAL destination (`out`/the platform package/
// `dist/winter` — never inside the copy, which is deleted on every path including failure), and a
// post-build assertion reads the compiled binary's raw bytes and refuses — never echoing the path
// itself, only its length — if this checkout's own absolute path appears anywhere in it. The
// assertion is structural: it holds on CI's `/home/runner/work/...` / `/Users/runner/work/...`
// checkouts exactly as it does on a personal machine, because it never depends on what the path
// LOOKS like — only on whether it was copied away from before compiling.
//
// Usage:
//   bun run scripts/build-runtime.ts                     # -> dist/winter
//   bun run scripts/build-runtime.ts --out <path>         # -> <path> (verify-protocol-compiled.ts's temp-path use)
//   bun run scripts/build-runtime.ts --platform-package   # -> packages/platform/darwin-arm64/bin/winter
//                                                          #    (staged binary is git-ignored — it ships at publish time only)
// --out and --platform-package are mutually exclusive (mirrors resolveRuntimeExecutable's
// explicit-option-beats-platform-package order in packages/sdk/src/transport.ts).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRYPOINT_REL = "packages/runtime/src/main.ts";
const DEFAULT_OUT = fileURLToPath(new URL("../dist/winter", import.meta.url));
const PLATFORM_PACKAGE_OUT = fileURLToPath(new URL("../packages/platform/darwin-arm64/bin/winter", import.meta.url));

export interface BuildRuntimeOptions {
  out?: string; // explicit output path — wins over platformPackage
  platformPackage?: boolean; // stage into packages/platform/darwin-arm64/bin/winter
  /** P9a-7: the checkout to copy-then-compile from. Tests only — defaults to this repository. */
  checkoutRoot?: string;
}

export interface BuildRuntimeResult {
  outPath: string;
  stdout: string;
  stderr: string;
}

/**
 * P9a-7 (P8d-27 carry): copies `checkout` into `dest` (created if absent), EXCLUDING `.git` — the
 * checkout's own history has no bearing on the compiled output and can be sizeable, so there is no
 * reason to pay for it in every path-neutral build. `rsync -a` preserves symlinks as symlinks
 * (never resolving them), which is what lets pnpm's RELATIVE `node_modules` symlinks survive the
 * copy intact — verified by this file's own test, not assumed.
 */
export function copyCheckoutExcludingGit(checkout: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  // Trailing slashes on BOTH sides: rsync copies `checkout`'s CONTENTS into `dest` (never a nested
  // `dest/<checkout-basename>/`), which is what lets `dest` itself serve as the entrypoint root.
  const r = spawnSync("rsync", ["-a", "--exclude", ".git", `${checkout}/`, `${dest}/`], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`build-runtime: copying the checkout into a path-neutral build dir failed: ${r.stderr || r.stdout}`);
}

/**
 * P9a-7's release-blocking gate: the compiled `winter` binary must NEVER embed this checkout's own
 * absolute filesystem path. Reads the binary as raw bytes (never decoded as text — a Mach-O/ELF
 * binary is not valid UTF-8, and a string search must not choke on that) and does a literal byte
 * search for `checkoutPath`. Deliberately NEVER echoes `checkoutPath` itself in the thrown message
 * — only its length — so a caller can safely print this error without leaking the very string it
 * exists to keep out of a shipped artifact.
 */
export function assertBinaryDoesNotEmbedPath(binaryPath: string, checkoutPath: string): void {
  const bytes = readFileSync(binaryPath);
  if (bytes.includes(Buffer.from(checkoutPath))) {
    throw new Error(`build-runtime: the compiled binary embeds the checkout path (${checkoutPath.length} chars, redacted)`);
  }
}

export async function buildRuntime(opts: BuildRuntimeOptions = {}): Promise<BuildRuntimeResult> {
  if (opts.out && opts.platformPackage) {
    throw new Error("buildRuntime: `out` and `platformPackage` are mutually exclusive");
  }
  const outPath = opts.out ? resolve(opts.out) : opts.platformPackage ? PLATFORM_PACKAGE_OUT : DEFAULT_OUT;
  const checkoutRoot = resolve(opts.checkoutRoot ?? REPO_ROOT);

  mkdirSync(dirname(outPath), { recursive: true });

  // REAL FINDING (bun 1.3.14): `bun build --compile` stages an unmodified copy of its base
  // executable template as a hidden `.<hash>-00000000.bun-build` file IN ITS CWD while assembling
  // the final --outfile, and does not always clean it up afterward (confirmed empirically: two
  // manual invocations from the repo root each left one such file behind, byte-identical to each
  // other, byte-DIFFERENT from the actual compiled output — i.e. a pre-injection base-binary
  // staging artifact, not a build product). Spawning from an ephemeral scratch cwd keeps any such
  // stray file out of the repo tree entirely regardless of bun's cleanup behavior in a given
  // version — the entrypoint and `outPath` are both absolute, so cwd has no bearing on where the
  // bundler resolves imports from or where the real output lands.
  const scratchCwd = mkdtempSync(join(tmpdir(), "winter-build-runtime-"));
  // P9a-7: the path-neutral copy of the checkout the compile actually runs against. A SEPARATE
  // mkdtemp from `scratchCwd` above — that one is bun's own staging cwd, this one is the source
  // tree — kept apart so a failure in one cleanup path never masks the other's.
  const copyRoot = mkdtempSync(join(tmpdir(), "winter-build-runtime-copy-"));
  try {
    copyCheckoutExcludingGit(checkoutRoot, copyRoot);

    // pnpm's node_modules symlinks are RELATIVE, so a plain recursive copy should carry them
    // intact — verified here, never assumed: a broken link is a broken build, and this is exactly
    // the kind of failure a silent fallback could hide.
    const scopeDir = join(copyRoot, "node_modules", "@yanlinglabs");
    if (existsSync(scopeDir)) {
      for (const entry of readdirSync(scopeDir)) {
        if (!existsSync(join(scopeDir, entry))) {
          throw new Error(`build-runtime: the path-neutral copy's node_modules/@yanlinglabs/${entry} symlink did not survive the copy`);
        }
      }
    }

    const entrypoint = join(copyRoot, ENTRYPOINT_REL);
    // process.execPath under bun IS the bun binary (matches transport-equivalence.test.ts's own
    // spawnHook precedent for invoking bun itself rather than trusting a "bun" on PATH).
    const proc = Bun.spawn([process.execPath, "build", "--compile", entrypoint, "--outfile", outPath], {
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
    // The release-blocking assertion: refuse (never publish) a binary that still embeds THIS
    // checkout's absolute path — the whole reason the copy above exists.
    assertBinaryDoesNotEmbedPath(outPath, checkoutRoot);
    return { outPath, stdout, stderr };
  } finally {
    // Runs on every path, failures included — a partial/failed copy or scratch dir has no reason
    // to survive.
    rmSync(scratchCwd, { recursive: true, force: true });
    rmSync(copyRoot, { recursive: true, force: true });
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
    // exactOptionalPropertyTypes (tsconfig.base.json): `out?: string` means "omit it or provide a
    // string", never "provide string | undefined" — so `out` is only spread in when actually set,
    // matching this file's own `...(opts.platformPackage ? ... )`-style conditional-inclusion idiom
    // used elsewhere in this codebase (e.g. transport-equivalence.test.ts's spawnHook).
    const { outPath } = await buildRuntime({ ...(out !== undefined ? { out } : {}), platformPackage });
    console.log(`built winter runtime -> ${outPath}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
