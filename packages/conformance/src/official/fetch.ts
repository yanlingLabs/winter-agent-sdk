// P7a Lane C (WS-02 §9 Step 2): moved here verbatim from `scripts/fetch-upstream.ts`, which is now a
// thin caller re-exporting these names and keeping only the CLI entry point (`bun run
// conformance:fetch`). Living inside `@yanlinglabs/winter-conformance` makes this an IMPORTABLE
// module: `capture.ts` beside it imports `fetchAndVerifyUpstream` directly rather than reaching back
// out to `scripts/`, and any other consumer of the pinned-upstream mechanics (WS-02 §6) can import it
// from the published package instead of a repo-relative script path. The RUN_OFFICIAL_CAPTURE=1 gate
// and the checksum pins below are byte-for-byte unchanged by the move.
//
// review r1 Critical Finding 1: `CHECKSUMS` used to be read at MODULE TOP LEVEL, which means merely
// IMPORTING this file (or the barrels that re-export it -- `./index.ts`, `../index.ts`, the bare
// `@yanlinglabs/winter-conformance` package) did file I/O against `compat/anthropic/0.3.250/
// checksums.json`. `compat/` is deliberately excluded from this package's `files` allowlist
// (R-7a-12) -- it never ships -- so a real install threw `ENOENT` the instant anything imported the
// barrel, reproduced against a real packed tarball. `getChecksums()` below makes the read LAZY
// (memoized, called only from inside `fetchAndVerifyUpstream()`) so importing this module -- or
// anything that re-exports it -- performs NO I/O; only *calling* `fetchAndVerifyUpstream()` does,
// and only a repository checkout (never an installed package) can satisfy it.
import { createHash } from "node:crypto";
import { brandedInstanceOf } from "../bun-required.ts";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHECKSUM_MISMATCH_BRAND = Symbol.for("@yanlinglabs/winter-conformance:ChecksumMismatchError");
const OFFICIAL_COMPAT_UNAVAILABLE_BRAND = Symbol.for("@yanlinglabs/winter-conformance:OfficialCompatUnavailableError");

export class ChecksumMismatchError extends Error {
  // P7a fix wave r3 (F2): this class is exported from BOTH `@yanlinglabs/winter-conformance` and
  // `.../official`, and the compiled emit gives each entry its own copy -- so a plain prototype
  // `instanceof` is false across subpaths under Node. See `../bun-required.ts` for the whole
  // reasoning; the brand is package-scoped, so another package's class still does not match.
  readonly [CHECKSUM_MISMATCH_BRAND] = true;
  static [Symbol.hasInstance] = brandedInstanceOf(CHECKSUM_MISMATCH_BRAND);
  constructor(message: string) {
    super(message);
    this.name = "ChecksumMismatchError";
  }
}

/** Thrown by `getChecksums()` when `compat/anthropic/0.3.250/checksums.json` is absent -- i.e. this module is running from an INSTALLED package rather than a repository checkout. Never a raw ENOENT. */
export class OfficialCompatUnavailableError extends Error {
  // F2, same reason as `ChecksumMismatchError` above.
  readonly [OFFICIAL_COMPAT_UNAVAILABLE_BRAND] = true;
  static [Symbol.hasInstance] = brandedInstanceOf(OFFICIAL_COMPAT_UNAVAILABLE_BRAND);
  constructor(message: string) {
    super(message);
    this.name = "OfficialCompatUnavailableError";
  }
}

interface UpstreamChecksums {
  tarballUrl: string;
  wrapperTarballSha256: string;
  wrapperTarballIntegrity: string;
}

// Relative to THIS file (packages/conformance/src/official/fetch.ts): ../../ is the package root
// (packages/conformance/), where compat/anthropic/0.3.250/checksums.json lives IN THE REPOSITORY --
// never inside an installed `node_modules/@yanlinglabs/winter-conformance` (R-7a-12 excludes
// `compat/` from `files` on purpose).
const CHECKSUMS_URL = new URL("../../compat/anthropic/0.3.250/checksums.json", import.meta.url);
let cachedChecksums: UpstreamChecksums | undefined;

/**
 * Lazily reads and memoizes the pinned-upstream checksums. Called ONLY from inside
 * `fetchAndVerifyUpstream()` -- never at module load -- so importing this file (directly or through
 * a barrel) never touches the filesystem. When `compat/` is absent (an installed package, per
 * R-7a-12), throws a typed, worded `OfficialCompatUnavailableError` instead of letting a raw `ENOENT`
 * surface with no explanation of why.
 */
export function getChecksums(): UpstreamChecksums {
  if (cachedChecksums !== undefined) return cachedChecksums;
  let raw: string;
  try {
    raw = readFileSync(CHECKSUMS_URL, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new OfficialCompatUnavailableError(
        "official upstream fetch needs the repository checkout; the published package does not ship compat/",
      );
    }
    throw e; // an unexpected read error (permissions, etc.) is never masked as "not shipped"
  }
  cachedChecksums = JSON.parse(raw) as UpstreamChecksums;
  return cachedChecksums;
}

export function verifyDigest(bytes: Uint8Array, expected: string): void {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new ChecksumMismatchError(`expected ${expected}, got ${actual}`);
}

// A SECOND, independently-sourced hash (npm registry metadata's own `dist.integrity`, WS-02 §6.1
// defense-in-depth) — verified alongside verifyDigest's sha256, never in place of it. Both hashes
// cover the exact same bytes but come from different provenance (a hand-computed sha256 vs. the
// registry API's own attestation), so a tampered checksums.json entry has to fool BOTH sources —
// and a different hash *algorithm family* — to pass silently.
export function verifySha512Integrity(bytes: Uint8Array, expectedIntegrity: string): void {
  const prefix = "sha512-";
  if (!expectedIntegrity.startsWith(prefix)) {
    throw new Error(`unsupported integrity format (expected a "${prefix}" SRI string): ${expectedIntegrity}`);
  }
  const expectedBase64 = expectedIntegrity.slice(prefix.length);
  const actualBase64 = createHash("sha512").update(bytes).digest("base64");
  if (actualBase64 !== expectedBase64) {
    throw new ChecksumMismatchError(`expected ${expectedIntegrity}, got ${prefix}${actualBase64}`);
  }
}

// Task 11 (WS-02 §6.1 guard): resolves where the verified tarball is written and whether the
// CALLER or this function owns that directory's lifecycle. A caller-supplied cacheDir is never
// created-and-owned by us — the caller decided its lifetime, so `ownedDir: false` tells every
// consumer (gen-declaration-snapshot.ts, compile-official-fixture.ts, capture-official-golden.ts)
// to never rmSync it. An omitted cacheDir gets a fresh ephemeral mkdtemp (WS-17 §2) that IS owned
// here — `ownedDir: true` — so a caller's `if (ownedDir) rmSync(...)` cleans it up as before.
export function resolveCacheDir(cacheDir?: string): { dir: string; ownedDir: boolean } {
  if (cacheDir !== undefined) {
    mkdirSync(cacheDir, { recursive: true }); // caller's dir may not exist yet; never deleted by us either way
    return { dir: cacheDir, ownedDir: false };
  }
  return { dir: mkdtempSync(join(tmpdir(), "winter-upstream-")), ownedDir: true };
}

export async function fetchAndVerifyUpstream(
  opts: { cacheDir?: string } = {},
): Promise<{ tarballPath: string; sha256: string; ownedDir: boolean }> {
  const checksums = getChecksums(); // lazy: throws OfficialCompatUnavailableError if compat/ is absent (an installed package)
  const res = await fetch(checksums.tarballUrl);
  if (!res.ok) throw new Error(`upstream fetch failed: ${res.status} ${res.statusText}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  verifyDigest(bytes, checksums.wrapperTarballSha256);                     // fails closed on registry tamper/re-pin (WS-02 §6.1)
  verifySha512Integrity(bytes, checksums.wrapperTarballIntegrity);         // second, independently-sourced hash — see above
  const { dir, ownedDir } = resolveCacheDir(opts.cacheDir);
  const tarballPath = join(dir, "claude-agent-sdk-0.3.250.tgz");
  writeFileSync(tarballPath, bytes);
  return { tarballPath, sha256: checksums.wrapperTarballSha256, ownedDir };
}

// No `if (import.meta.main)` CLI entry here on purpose: this module is a pure library now (P7a Lane
// C). The CLI entry (`bun run conformance:fetch`) lives in the thin caller `scripts/fetch-upstream.ts`,
// which imports `fetchAndVerifyUpstream` from here.
