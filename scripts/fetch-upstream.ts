import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

export class ChecksumMismatchError extends Error {}

const CHECKSUMS = JSON.parse(
  readFileSync(new URL("../packages/conformance/compat/anthropic/0.3.250/checksums.json", import.meta.url), "utf8"),
) as { tarballUrl: string; wrapperTarballSha256: string };

export function verifyDigest(bytes: Uint8Array, expected: string): void {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new ChecksumMismatchError(`expected ${expected}, got ${actual}`);
}

export async function fetchAndVerifyUpstream(opts: { cacheDir?: string } = {}): Promise<{ tarballPath: string; sha256: string }> {
  const res = await fetch(CHECKSUMS.tarballUrl);
  if (!res.ok) throw new Error(`upstream fetch failed: ${res.status} ${res.statusText}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  verifyDigest(bytes, CHECKSUMS.wrapperTarballSha256);           // fails closed on registry tamper/re-pin (WS-02 §6.1)
  const dir = opts.cacheDir ?? mkdtempSync(join(tmpdir(), "winter-upstream-"));  // ephemeral (WS-17 §2)
  const tarballPath = join(dir, "claude-agent-sdk-0.3.250.tgz");
  writeFileSync(tarballPath, bytes);
  return { tarballPath, sha256: CHECKSUMS.wrapperTarballSha256 };
}

if (import.meta.main) {
  fetchAndVerifyUpstream().then(({ sha256 }) => console.log(`verified upstream ${sha256}`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
