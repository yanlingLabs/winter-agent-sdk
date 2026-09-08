// P7a Lane C, Step 1 (WS-02 §9 items 1-4; Phase 7a amendment "the pack step runs the repository's
// name/identity scan over the TARBALL contents"): packs every PUBLISHABLE workspace package into a
// real npm tarball, records a checksum manifest, and fails closed if anything forbidden made it
// into the packed bytes.
//
// NOTHING HERE PUBLISHES ANYTHING. This script only ever calls `pnpm pack` (writes a local .tgz) —
// never `pnpm publish` / `npm publish` in any form, and it touches no registry, no network, no git
// tag. The one caller allowed to publish is `.github/workflows/release.yml`, gated on a `v*` tag or
// `workflow_dispatch` (see release-gates.test.ts for the assertion pinning that trigger set).
//
// WHY "PUBLISHABLE" IS COMPUTED, NOT HARD-CODED: a package is publishable iff its own package.json
// is NOT `"private": true` AND carries a `publishConfig` (the spine stamps both together on every
// package meant to ship, per context.md's file-ownership map — "package manifests: every publishable
// package.json (name, publishConfig, files, exports)"). `pnpm -r pack` does NOT itself honour
// `private` (empirically verified while building this script: it happily packs
// `@yanlinglabs/winter-agent-sdk-darwin-arm64`, a `"private": true` platform package with no built
// binary yet — R-7-2 says that package is not published at 7a), so this script computes the
// publishable set itself and packs each one individually via `pnpm --filter <name> pack`, never `-r`.
//
// THE SCAN. Every packed tarball is extracted (mirroring `scripts/gen-declaration-snapshot.ts`'s own
// `tar -xzf ... -C <dir>` pattern) and walked for:
//   1. forbidden directories  — `compat/`, `node_modules/`, `.git/` must never be packed. `compat/`
//      is WS-02 §2's own home for Anthropic-derived DERIVED inventories/digests, and even though
//      nothing in it is a raw Anthropic artifact, R-7a-12 excludes it from every tarball outright —
//      this is the structural half of that exclusion (the `files` allowlist is the other half, and
//      this script's own test asserts BOTH: the allowlist never lists `compat`, and a tarball never
//      contains it).
//   2. official-capture output  — a forward guard for a path segment naming an official-capture
//      output directory. Nothing under this phase's `files` allowlists currently produces one
//      (`runCapture()` only ever prints a report — see `packages/conformance/src/official/capture.ts`'s
//      own header), so this rule is vacuous today and stays that way on purpose.
//   3. an embedded Anthropic artifact by NAME — a path segment literally `claude-agent-sdk` (the
//      upstream package's own directory name once installed) or a file literally named `sdk.mjs`
//      (WS-02 §6.1: "no `sdk.mjs`" is the exact upstream shape this repo must never redistribute).
//      Narrower than a text search for the word "Anthropic": this repo's own
//      `packages/conformance/src/official/capture.ts` legitimately CONTAINS that string (it installs
//      the pinned package ephemerally by name, which WS-02 §6 requires), and a tarball scan that
//      flagged every mention would fail on Lane C's own shipped code, not on a real leak.
//   4. credentials-shaped FILES by name — `.env`, `*.pem`/`*.key`/`*.p12`/`*.pfx`, `id_rsa`-shaped
//      key files, any *-`credentials.json` variant (dot- or otherwise-prefixed, unanchored — review
//      r1 Important-3), a bare `.npmrc`, PLUS a second, independent case-insensitive `credential`
//      substring net on the basename (any extension except recognised source/doc ones — `.ts`/`.js`/
//      `.md`/etc. — which this repo's own legitimate `credentials.ts` modules would otherwise trip).
//      Filename-based rather than content-grepping for secret-looking strings, because this
//      repository's own legitimate test fixtures construct PEM-armored text at runtime and DOCUMENT
//      the PKCS#1/PKCS#8 header strings in comments (see
//      `packages/provider-runtime/src/adapters/google/jwt-rs256.ts`) — a content scan for
//      "-----BEGIN...KEY-----" would false-positive on that comment, not catch a real secret.
//   5. package identity — every `package.json` found inside the tarball must declare a name under
//      the `@yanlinglabs/` scope, and the tarball's own root manifest must match the package this
//      script asked `pnpm pack` to produce (catches an accidental cross-package/foreign manifest
//      leaking into the packed output).
//
// A DELIBERATE NON-RULE: this scan does NOT grep file contents for the literal word "Norma" (or any
// other personal/company identity string). Empirically, `packages/provider-catalog`'s own committed,
// intentional data (`overlay/models.json`, `generated/catalog.json`) and
// `packages/provider-runtime/src/**` carry dozens of legitimate "ported from Norma's ..." provenance
// comments (WS-02 §2: "Ported norma-core subsystems ... land under packages/runtime/src/ as
// Winter-named modules; the port is a copy-and-conform" — the comments disclosing that lineage are
// the DESIGN, not a leak). A blind literal scan would turn every one of those into a false failure
// on day one, on packages Lane C does not own and cannot fix. Scrubbing that provenance language
// (if ever wanted) is a decision for the eventual PUBLIC npm publish (P9's own `Publishable set`),
// not this restricted-GitHub-Packages pipeline — recorded here rather than silently declined.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_OUT_DIR = join(REPO_ROOT, "dist", "packages");

export interface PackageManifest {
  name: string;
  version: string;
  private?: boolean;
  publishConfig?: unknown;
  /** P7a pre-publish (item 5): `winter.publish.npm` -- see `PublishablePackage.npm`. */
  winter?: { publish?: { npm?: boolean } };
}

export interface PublishablePackage {
  name: string;
  version: string;
  /** Absolute path to the package directory (the parent of its package.json). */
  dir: string;
  packageJsonPath: string;
  /**
   * P7a pre-publish (item 5; user ruling 2026-09-08): does this package also go to PUBLIC npm?
   *
   * Every publishable package goes to GitHub Packages (the org's own registry). Only the WRAPPER and
   * its runtime dependency closure go to npm, because that is what a public consumer installs:
   * `@yanlinglabs/winter-agent-sdk` plus what it needs at run time. The two conformance harnesses are
   * the org's own test tooling and stay GitHub-Packages-only.
   *
   * Read from `winter.publish.npm` in the manifest, so the set is DATA the workflow filters on rather
   * than a list written twice (once in YAML, once in someone's head). `release-gates.test.ts` asserts
   * it equals exactly the wrapper's transitive workspace-dependency closure, so a new runtime
   * dependency of the wrapper cannot be forgotten and a harness package cannot leak.
   */
  npm: boolean;
}

export interface PackedPackage {
  name: string;
  version: string;
  /** Absolute path to the produced .tgz. */
  tarballPath: string;
  /** Basename of tarballPath, the same form checksums.json records under "file". */
  file: string;
  sha256: string;
  size: number;
}

export interface ReleasePackResult {
  outDir: string;
  checksumsPath: string;
  packages: PackedPackage[];
  violations: string[];
  /** Total files inspected by the scan, across every package — proof the scan actually ran (never 0 when packages exist). */
  filesScanned: number;
}

/** A package is publishable iff it is not `"private": true` AND carries a `publishConfig` (R-7-1's set). */
export function isPublishable(pkg: Pick<PackageManifest, "private" | "publishConfig">): boolean {
  return pkg.private !== true && pkg.publishConfig !== undefined;
}

/** Every `package.json` under `<root>/packages/**`, depth-first, `node_modules` pruned, sorted for determinism. */
export function findPackageManifests(root: string = REPO_ROOT): string[] {
  const packagesDir = join(root, "packages");
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a package dir with no packages/ subtree at all -- never true here, but never fatal either
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name === "package.json") out.push(full);
    }
  };
  walk(packagesDir);
  return out;
}

/** Every publishable package under `root`, sorted by name for a deterministic pack/manifest order. */
export function discoverPublishablePackages(root: string = REPO_ROOT): PublishablePackage[] {
  const result: PublishablePackage[] = [];
  for (const packageJsonPath of findPackageManifests(root)) {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageManifest;
    if (!isPublishable(pkg)) continue;
    result.push({ name: pkg.name, version: pkg.version, dir: dirname(packageJsonPath), packageJsonPath, npm: pkg.winter?.publish?.npm === true });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

interface PnpmPackJson {
  name: string;
  version: string;
  filename: string;
  files: Array<{ path: string }>;
}

/** Packs one workspace package by name via `pnpm --filter <name> pack` -- never `-r` (see header: `-r` does not honour `private`). */
async function packOne(pkg: PublishablePackage, outDir: string, root: string): Promise<PackedPackage> {
  const proc = Bun.spawn(["pnpm", "--filter", pkg.name, "pack", "--pack-destination", outDir, "--json"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`pnpm pack failed for ${pkg.name} (exit ${exitCode}):\n${stderr || stdout}`);
  let parsed: PnpmPackJson;
  try {
    parsed = JSON.parse(stdout.trim()) as PnpmPackJson;
  } catch {
    throw new Error(`pnpm pack for ${pkg.name} did not print the expected JSON on stdout:\n${stdout}\n${stderr}`);
  }
  const bytes = readFileSync(parsed.filename);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { name: parsed.name, version: parsed.version, tarballPath: parsed.filename, file: basename(parsed.filename), sha256, size: bytes.length };
}

/** `tar -xzf <tarballPath> -C <destDir>` -- the same idiom `gen-declaration-snapshot.ts` and `check-derived-shapes.ts` already use for the pinned-upstream tarball. */
async function extractTarball(tarballPath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  const proc = Bun.spawn(["tar", "-xzf", tarballPath, "-C", destDir], { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`tar extraction failed for ${tarballPath} (exit ${exitCode}): ${stderr}`);
  }
}

const FORBIDDEN_DIR_SEGMENTS = new Set(["compat", "node_modules", ".git"]);
const ANTHROPIC_ARTIFACT_SEGMENTS = new Set(["claude-agent-sdk", "sdk.mjs"]);
// review r1 Important-3: the `credentials.json` alternative is UNANCHORED at the start (no leading
// `^`) so a dot- or otherwise-prefixed variant (`.credentials.json`, `aws.credentials.json`,
// `.aws-credentials.json`) still matches -- confirmed empirically: all three literally END in
// "credentials.json", which the old `^credentials\.json$` anchor refused. The old exact-name-only
// form let every prefixed variant through (Finding 3's planted-file case, `.credentials.json`, was
// invisible to it).
const CREDENTIAL_FILENAME_RE = /^\.env(\..+)?$|\.(pem|key|p12|pfx)$|^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|credentials\.json$|^\.npmrc$/i;
// A SECOND, independent, broader net: any basename containing "credential" at all, case-insensitive
// -- EXCLUDING recognised source/doc extensions. Without that exclusion this false-positives on
// real, legitimate files this exact repo ships (e.g. `packages/provider-runtime/src/credentials/
// credentials.ts`, `adapters/bedrock/credentials.ts` -- confirmed empirically before adding this
// rule): a source file whose NAME describes credential-handling LOGIC is not a credential-shaped
// FILE. A `.json`/`.yaml`/`.txt`/extension-less file (or anything else) containing "credential" is
// still caught -- only recognised code/doc extensions are exempted.
const CREDENTIAL_SUBSTRING_RE = /credential/i;
const NON_CREDENTIAL_SOURCE_EXTENSIONS_RE = /\.(ts|tsx|js|jsx|mjs|cjs|md)$/i;
/**
 * P7a fix wave (item 9; Lane C review M-6): TEST FILES NEVER SHIP.
 *
 * Every tarball carried its own test suite beside the implementation -- provider-runtime shipped 32
 * `.test.ts` files against 59 sources, sdk 17 of 39. They are dead weight in a consumer's
 * `node_modules`, they import test-only devDependencies a consumer never installed (so a bundler or
 * a type-checker walking the tree finds unresolvable specifiers), and they hand a reader of the
 * published package a second, uncompiled surface that looks like part of the API.
 *
 * `*.testing.ts` is NOT matched, deliberately: `provider-runtime` re-exports three of them through
 * its PUBLIC `./testing` subpath (`startXaiOauthFake` and friends), so they are product, not test
 * scaffolding. `*.test-support.ts` is matched -- nothing public re-exports one.
 *
 * The rule lives HERE rather than only in the `files` lists because a manifest is a declaration and
 * this is the output: a future `files` edit, a stray `.npmignore`, or a package that forgets the
 * negation fails the pack instead of shipping quietly.
 */
const TEST_FILE_RE = /\.test\.ts$|\.test-support\.ts$/;

/** Every file under `dir` (recursive), as paths relative to `dir` using "/" separators regardless of platform. */
function walkFiles(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, base));
      continue;
    }
    if (entry.isFile()) out.push(full.slice(base.length + 1).split(sep).join("/"));
  }
  return out;
}

/**
 * Scans one package's EXTRACTED tarball root (the `package/` directory `tar` produces) for the six
 * categories this file's header documents (the sixth, test files, is the P7a fix wave's item 9). Returns a violation string per hit; empty means clean.
 * `expectedName` is the package this extraction is supposed to BE, for the identity check (category 5).
 */
export function scanExtractedPackage(expectedName: string, packageRoot: string): { violations: string[]; filesScanned: number } {
  const relPaths = walkFiles(packageRoot);
  const violations: string[] = [];
  let sawOwnManifest = false;

  for (const relPath of relPaths) {
    const segments = relPath.split("/");
    const name = segments[segments.length - 1] ?? relPath;

    for (const seg of segments.slice(0, -1)) {
      if (FORBIDDEN_DIR_SEGMENTS.has(seg)) violations.push(`${expectedName}: forbidden directory "${seg}" shipped at ${relPath}`);
      if (seg.toLowerCase().includes("official-capture")) violations.push(`${expectedName}: official-capture output shipped at ${relPath}`);
    }
    if (ANTHROPIC_ARTIFACT_SEGMENTS.has(name.toLowerCase()) || segments.some((s) => ANTHROPIC_ARTIFACT_SEGMENTS.has(s.toLowerCase()))) {
      violations.push(`${expectedName}: an embedded Anthropic artifact name ("${name}") shipped at ${relPath}`);
    }
    if (CREDENTIAL_FILENAME_RE.test(name) || (CREDENTIAL_SUBSTRING_RE.test(name) && !NON_CREDENTIAL_SOURCE_EXTENSIONS_RE.test(name))) {
      violations.push(`${expectedName}: a credentials-shaped file shipped at ${relPath}`);
    }
    if (TEST_FILE_RE.test(name)) violations.push(`${expectedName}: a test file shipped at ${relPath} (exclude it in this package's "files")`);

    if (name === "package.json") {
      const full = join(packageRoot, ...relPath.split("/"));
      let nestedName: unknown;
      try {
        nestedName = (JSON.parse(readFileSync(full, "utf8")) as { name?: unknown }).name;
      } catch {
        violations.push(`${expectedName}: ${relPath} is not valid JSON`);
        continue;
      }
      if (typeof nestedName !== "string" || !nestedName.startsWith("@yanlinglabs/")) {
        violations.push(`${expectedName}: ${relPath} declares an unexpected identity ("${String(nestedName)}", not an "@yanlinglabs/" name)`);
      }
      if (relPath === "package.json") {
        sawOwnManifest = true;
        if (nestedName !== expectedName) violations.push(`${expectedName}: the tarball's own package.json declares "${String(nestedName)}" instead`);
      }
    }
  }

  if (!sawOwnManifest) violations.push(`${expectedName}: no package.json found at the tarball root`);
  return { violations, filesScanned: relPaths.length };
}

export async function releasePack(opts: { outDir?: string; root?: string; build?: boolean } = {}): Promise<ReleasePackResult> {
  const root = opts.root ?? REPO_ROOT;
  const outDir = opts.outDir ?? DEFAULT_OUT_DIR;
  // P7a fix wave (item 1): THE COMPILED EMIT IS BUILT FIRST, always. Every manifest's `default`
  // condition points into `dist/`, so packing without building would produce a tarball whose Node
  // entry point is a file that is not in it -- and the tarball scan cannot see a MISSING file. A
  // stale dist is the quieter version of the same failure, which is why the build cleans before it
  // writes rather than overlaying. `build: false` exists only for a caller that has just built.
  if (opts.build !== false) {
    const { buildPackages } = await import("./build-packages.ts");
    await buildPackages({ root });
  }
  mkdirSync(outDir, { recursive: true });

  const targets = discoverPublishablePackages(root);
  if (targets.length === 0) {
    throw new Error("release-pack: no publishable packages found under packages/ -- check every package.json's private/publishConfig fields");
  }

  const packages: PackedPackage[] = [];
  const violations: string[] = [];
  let filesScanned = 0;

  for (const pkg of targets) {
    const packed = await packOne(pkg, outDir, root);
    packages.push(packed);

    const scanDir = mkdtempSync(join(tmpdir(), "winter-pack-scan-"));
    try {
      await extractTarball(packed.tarballPath, scanDir);
      const packageRoot = join(scanDir, "package"); // npm/pnpm tarball convention: everything sits under package/
      const result = scanExtractedPackage(pkg.name, packageRoot);
      violations.push(...result.violations);
      filesScanned += result.filesScanned;
    } finally {
      rmSync(scanDir, { recursive: true, force: true });
    }
  }

  packages.sort((a, b) => a.name.localeCompare(b.name));
  const checksumsPath = join(outDir, "checksums.json");
  writeFileSync(checksumsPath, JSON.stringify(packages, null, 2) + "\n");

  return { outDir, checksumsPath, packages, violations, filesScanned };
}

if (import.meta.main) {
  const result = await releasePack();
  console.log(`release-pack: packed ${result.packages.length} package(s) into ${result.outDir}`);
  for (const p of result.packages) console.log(`  ${p.name}@${p.version}  ${p.file}  ${p.size}B  sha256:${p.sha256}`);
  console.log(`  scanned ${result.filesScanned} file(s) across every extracted tarball`);
  if (result.violations.length > 0) {
    console.error("release-pack FAILED -- the tarball scan found:");
    for (const v of result.violations) console.error(`  - ${v}`);
    process.exitCode = 1;
  } else {
    console.log("release-pack OK -- no forbidden content in any packed tarball");
  }
}
