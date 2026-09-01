import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

export class ChecksumMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChecksumMismatchError";
  }
}

const CHECKSUMS = JSON.parse(
  readFileSync(new URL("../packages/conformance/compat/anthropic/0.3.250/checksums.json", import.meta.url), "utf8"),
) as { tarballUrl: string; wrapperTarballSha256: string; wrapperTarballIntegrity: string };

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
  const res = await fetch(CHECKSUMS.tarballUrl);
  if (!res.ok) throw new Error(`upstream fetch failed: ${res.status} ${res.statusText}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  verifyDigest(bytes, CHECKSUMS.wrapperTarballSha256);                     // fails closed on registry tamper/re-pin (WS-02 §6.1)
  verifySha512Integrity(bytes, CHECKSUMS.wrapperTarballIntegrity);         // second, independently-sourced hash — see above
  const { dir, ownedDir } = resolveCacheDir(opts.cacheDir);
  const tarballPath = join(dir, "claude-agent-sdk-0.3.250.tgz");
  writeFileSync(tarballPath, bytes);
  return { tarballPath, sha256: CHECKSUMS.wrapperTarballSha256, ownedDir };
}

if (import.meta.main) {
  fetchAndVerifyUpstream().then(({ sha256 }) => console.log(`verified upstream ${sha256}`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
