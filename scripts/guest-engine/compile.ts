/** Explicit fixture entries only, pinned Linux Bun base, path-neutral/no-autoload build.
 * Does not execute any Linux program or enable the general runtime entry. */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pin from "../linux-runtime-base.json";
import { copyCheckoutExcludingGit, COMPILE_NO_AUTOLOAD_FLAGS, assertBinaryDoesNotEmbedPath } from "../build-runtime.ts";
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--guest-base" || args[2] !== "--out" || Bun.version !== pin.version) throw new Error("fixed pinned fixture compile arguments required");
const output = resolve(args[3]!); if (existsSync(output)) throw new Error("new artifact directory required");
const base = readFileSync(args[1]!); if (createHash("sha256").update(base).digest("hex") !== pin.executableSha256) throw new Error("guest base hash mismatch");
const checkout = resolve(import.meta.dir, "../.."), temporary = mkdtempSync(join(tmpdir(), "winter-fresh-compile-"));
try {
  const stage = join(temporary, "stage"), source = join(temporary, "source"); mkdirSync(stage); mkdirSync(source); mkdirSync(output, { recursive: true });
  const basePath = join(stage, "linux-bun-base"); writeFileSync(basePath, base, { flag: "wx", mode: 0o500 }); copyCheckoutExcludingGit(checkout, source);
  for (const [entry, name] of [["runtime.ts", "runtimeEntry"], ["provider.ts", "providerWorker"]] as const) {
    const path = join(output, name);
    const child = Bun.spawn([process.execPath, "build", "--compile", ...COMPILE_NO_AUTOLOAD_FLAGS, `--target=${pin.target}`, `--compile-executable-path=${basePath}`, join(source, "scripts/guest-engine", entry), "--outfile", path], { cwd: stage, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); if (code !== 0) throw new Error(`fixture compile failed: ${stderr || stdout}`);
    assertBinaryDoesNotEmbedPath(path, checkout);
  }
  console.log(JSON.stringify({ compiled: true, target: pin.target, baseSha256: pin.executableSha256, linuxExecutionVerified: false, vmExecutionVerified: false }));
} finally { rmSync(temporary, { recursive: true, force: true }); }
