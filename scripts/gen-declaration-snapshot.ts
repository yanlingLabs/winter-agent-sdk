import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetchAndVerifyUpstream } from "./fetch-upstream.ts";

export interface ExportInventory { symbols: Array<{ name: string; kind: string }> }

const RE = /export\s+(?:declare\s+)?(interface|type|function|const|class)\s+([A-Za-z0-9_]+)/g;

export function extractInventory(dtsFiles: Record<string, string>): { exports: ExportInventory; digests: Record<string, string> } {
  const symbols: ExportInventory["symbols"] = [];
  const digests: Record<string, string> = {};
  for (const [file, text] of Object.entries(dtsFiles)) {
    for (const m of text.matchAll(RE)) symbols.push({ name: m[2]!, kind: m[1]! });
    digests[file] = createHash("sha256").update(text).digest("hex"); // digest only — never store upstream text
  }
  symbols.sort((a, b) => a.name.localeCompare(b.name));
  return { exports: { symbols }, digests };
}

export function diffInventory(a: ExportInventory, b: ExportInventory): string[] {
  const key = (s: { name: string; kind: string }) => `${s.name} (${s.kind})`;
  const A = new Set(a.symbols.map(key)), B = new Set(b.symbols.map(key));
  const lines: string[] = [];
  for (const s of B) if (!A.has(s)) lines.push(`added export: ${s}`);
  for (const s of A) if (!B.has(s)) lines.push(`removed export: ${s}`);
  return lines;
}

// ---- import.meta.main driver: fetch → extract tarball → inventory → --check or write ----

const SNAPSHOT_DIR = new URL("../packages/conformance/compat/anthropic/0.3.250/", import.meta.url);
const EXPORTS_PATH = new URL("exports.json", SNAPSHOT_DIR);
const DIGESTS_PATH = new URL("declaration-digests.json", SNAPSHOT_DIR);

async function extractDtsFromTarball(tarballPath: string): Promise<Record<string, string>> {
  const workDir = dirname(tarballPath);
  const outDir = join(workDir, "extracted");
  mkdirSync(outDir, { recursive: true });
  const proc = Bun.spawn(["tar", "-xzf", tarballPath, "-C", outDir], { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`tar extraction failed (exit ${exitCode}): ${stderr}`);
  }
  const pkgDir = join(outDir, "package");
  // Discover package/*.d.ts dynamically (not a hard-coded list) so a re-pin that adds a new
  // declaration entry-point is picked up by the inventory instead of silently skipped.
  const dtsFiles: Record<string, string> = {};
  for (const name of readdirSync(pkgDir).filter((n) => n.endsWith(".d.ts")).sort()) {
    dtsFiles[name] = readFileSync(join(pkgDir, name), "utf8"); // held in memory only — never written into the repo
  }
  return dtsFiles;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const { tarballPath, ownedDir } = await fetchAndVerifyUpstream();
  let dtsFiles: Record<string, string>;
  try {
    dtsFiles = await extractDtsFromTarball(tarballPath);
  } finally {
    // Task 11 guard: this call never passes a cacheDir, so ownedDir is always true today — but the
    // cleanup is keyed off it (not unconditional) so this caller stays correct the moment it (or
    // any future caller copying this pattern) ever does pass one. A caller-supplied cacheDir must
    // never be deleted out from under its owner (WS-02 §6.1).
    if (ownedDir) rmSync(dirname(tarballPath), { recursive: true, force: true }); // ephemeral cleanup — tarball + extracted .d.ts never persist
  }

  if (Object.keys(dtsFiles).length === 0) {
    console.error("no .d.ts files found under package/ in the upstream tarball");
    process.exit(1);
  }

  const { exports: freshExports, digests: freshDigests } = extractInventory(dtsFiles);

  if (check) {
    if (!existsSync(EXPORTS_PATH) || !existsSync(DIGESTS_PATH)) {
      console.error("no committed snapshot found — run `bun run conformance:snapshot` first");
      process.exit(1);
    }
    const committedExports = JSON.parse(readFileSync(EXPORTS_PATH, "utf8")) as ExportInventory;
    const committedDigests = JSON.parse(readFileSync(DIGESTS_PATH, "utf8")) as Record<string, string>;

    const lines = diffInventory(committedExports, freshExports);
    const files = new Set([...Object.keys(committedDigests), ...Object.keys(freshDigests)]);
    for (const file of files) {
      if (committedDigests[file] !== freshDigests[file]) lines.push(`digest changed: ${file}`);
    }

    if (lines.length > 0) {
      console.error("conformance drift detected against committed 0.3.250 snapshot:");
      for (const line of lines) console.error(`  - ${line}`);
      process.exit(1);
    }
    console.log(`conformance snapshot clean — ${freshExports.symbols.length} exported symbols across ${files.size} files, no drift`);
  } else {
    mkdirSync(new URL(".", EXPORTS_PATH), { recursive: true });
    writeFileSync(EXPORTS_PATH, JSON.stringify(freshExports, null, 2) + "\n");
    writeFileSync(DIGESTS_PATH, JSON.stringify(freshDigests, null, 2) + "\n");
    console.log(`wrote conformance snapshot: ${freshExports.symbols.length} exported symbols across ${Object.keys(freshDigests).length} files`);
  }
}
