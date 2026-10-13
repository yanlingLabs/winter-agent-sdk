/** Fixture compilation only. The unsigned measured receipt requires trusted reviewed build/run provenance. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, closeSync, constants, fstatSync, openSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import pin from "../linux-runtime-base.json";
import { copyCheckoutExcludingGit, COMPILE_NO_AUTOLOAD_FLAGS, assertBinaryDoesNotEmbedPath } from "../build-runtime.ts";
const MAX_JSON = 16 * 1024 * 1024, MAX_EXECUTABLE = 256 * 1024 * 1024;
const environment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" };
type Input = { kind: "file"; sha256: string; bytes: number } | { kind: "symlink"; target: string };
function canonical(value: any): string { return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item); }
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function bounded(path: string, limit: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > limit) throw new Error("compile input type/size limit");
    const bytes = Buffer.alloc(before.size + 1); let size = 0;
    while (size < bytes.length) { const count = readSync(fd, bytes, size, bytes.length - size, null); if (!count) break; size += count; }
    const after = fstatSync(fd);
    if (size !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("compile input changed");
    return bytes.subarray(0, size);
  } finally { closeSync(fd); }
}
function inventory(root: string): Record<string, Input> {
  const result = spawnSync("python3", ["-I", "-S", join(root, "scripts/guest-engine/provenance.py"), "inventory", root], { encoding: "utf8", maxBuffer: MAX_JSON, timeout: 30_000 });
  if (result.status !== 0) throw new Error("bounded compile inventory failed");
  return JSON.parse(result.stdout);
}
export async function compileFixture(guestBase: string, output: string): Promise<void> {
  if (Bun.version !== pin.version || existsSync(output)) throw new Error("fixed pinned compiler and new artifact directory required");
  const base = bounded(guestBase, MAX_EXECUTABLE);
  if (hash(base) !== pin.executableSha256) throw new Error("guest base hash mismatch");
  const checkout = resolve(import.meta.dir, "../.."), compilerPath = realpathSync(process.execPath);
  const compiler = { version: Bun.version, ...{ sha256: hash(bounded(compilerPath, MAX_EXECUTABLE)), bytes: statSync(compilerPath).size }, platform: process.platform, architecture: process.arch };
  const before = inventory(checkout), temporary = mkdtempSync(join(tmpdir(), "winter-fresh-compile-"));
  try {
    const stage = join(temporary, "stage"), source = join(temporary, "source"); mkdirSync(stage, { mode: 0o700 }); mkdirSync(source, { mode: 0o700 }); mkdirSync(output, { recursive: true, mode: 0o700 });
    writeFileSync(join(stage, "linux-bun-base"), base, { flag: "wx", mode: 0o500 }); copyCheckoutExcludingGit(checkout, source);
    if (canonical(inventory(source)) !== canonical(before) || canonical(inventory(checkout)) !== canonical(before)) throw new Error("sources/dependencies changed during staging");
    const outputs: Record<string, unknown> = {};
    for (const [entry, name] of [["runtime.ts", "runtimeEntry"], ["provider.ts", "providerWorker"]] as const) {
      const binary = join(output, name), metadataPath = join(stage, `${name}.metafile.json`);
      const command = ["build", "--compile", ...COMPILE_NO_AUTOLOAD_FLAGS, `--target=${pin.target}`, "--compile-executable-path=linux-bun-base", `--metafile=${name}.metafile.json`, `../source/scripts/guest-engine/${entry}`, "--outfile", binary];
      const child = spawnSync(compilerPath, command, { cwd: stage, env: environment, encoding: "utf8", maxBuffer: MAX_JSON, timeout: 120_000 });
      if (child.status !== 0) throw new Error("fixture compile failed (no execution receipt)");
      assertBinaryDoesNotEmbedPath(binary, checkout);
      const raw = JSON.parse(bounded(metadataPath, MAX_JSON).toString("utf8")), bundled: Record<string, Input> = {}, paths = new Map<string, string>();
      if (!raw.inputs || typeof raw.inputs !== "object" || Object.keys(raw.inputs).length > 20000) throw new Error("compile metafile input limit");
      for (const [path, metadata] of Object.entries(raw.inputs) as [string, { bytes: number }][]) {
        const physical = realpathSync(resolve(stage, path)), name = relative(realpathSync(source), physical);
        if (name.startsWith("../") || name.startsWith("/") || before[name]?.kind !== "file" || (before[name] as { bytes: number }).bytes !== metadata.bytes) throw new Error("unmeasured bundled input");
        bundled[name] = before[name]!; paths.set(path, name);
      }
      // Metafile strings contain only normalized source/staging/output paths in retained evidence.
      const remap = (value: any): any => typeof value === "string" ? paths.get(value) ?? value : Array.isArray(value) ? value.map(remap) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [paths.get(key) ?? key, remap(item)])) : value;
      const normalized = JSON.parse(JSON.stringify(remap(raw)).split(checkout).join("<checkout>").split(realpathSync(source)).join("<source>").split(source).join("<source>").split(stage).join("<stage>").split(output).join("<output>").split("../source/").join(""));
      const metadata = canonical(normalized); writeFileSync(join(output, `${name}.metafile.json`), metadata + "\n", { flag: "wx", mode: 0o444 });
      const bytes = bounded(binary, MAX_EXECUTABLE);
      if (bytes.subarray(0, 6).toString("hex") !== "7f454c460201" || bytes.readUInt16LE(18) !== 183) throw new Error("compiled ARM64 ELF required");
      outputs[name] = { entry: `scripts/guest-engine/${entry}`, sha256: hash(bytes), bytes: bytes.length, bundledInputs: bundled, metafileSha256: hash(metadata + "\n"), command: ["<compiler>", ...command.map(value => value === binary ? `<output>/${name}` : value)] };
    }
    if (canonical(inventory(source)) !== canonical(before) || canonical(inventory(checkout)) !== canonical(before) || hash(bounded(compilerPath, MAX_EXECUTABLE)) !== compiler.sha256) throw new Error("compile inputs changed");
    const receipt = { formatVersion: 1, kind: "winter-fresh-engine-compile", inputs: before, inputInventorySha256: hash(canonical(before)), compiler,
      base: { version: pin.version, target: pin.target, sha256: pin.executableSha256 },
      recipe: { flags: ["--compile", ...COMPILE_NO_AUTOLOAD_FLAGS, `--target=${pin.target}`, "--compile-executable-path=linux-bun-base", "--metafile=<entry>.metafile.json"], cwd: "stage", source: "../source", environment },
      outputs, linuxExecutionVerified: false, vmExecutionVerified: false };
    const bytes = canonical(receipt) + "\n"; if (Buffer.byteLength(bytes) > MAX_JSON) throw new Error("compile receipt size limit");
    writeFileSync(join(output, "compile-receipt.json"), bytes, { flag: "wx", mode: 0o444 });
    console.log(JSON.stringify({ compiled: true, compileReceiptSha256: hash(bytes), target: pin.target, linuxExecutionVerified: false, vmExecutionVerified: false }));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--guest-base" || args[2] !== "--out") throw new Error("fixed pinned fixture compile arguments required");
  await compileFixture(resolve(args[1]!), resolve(args[3]!));
}
