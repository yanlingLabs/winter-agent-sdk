// 0.0.58: `@yanlinglabs/winter-web` INSTALLS ALONE -- no other package at all, winter or third-party.
//
// A host that only wants web search and an SSRF-guarded fetch (a Node app with its own agents)
// installs this one package. This script is the gate that keeps it that way:
//
//   1. `webClosureViolations` (pure) -- refuses a packed manifest that declares ANY dependency (every
//      dependency field), a `bin`, a shipped native executable, or a compiled JS/declaration file that
//      imports anything but a `node:` built-in or its own relative files.
//   2. `packWebClosure` -- builds and `pnpm pack`s the package, extracts it, runs (1) on what was
//      packed, `npm install --offline`s the tarball into a scratch project, checks the installed tree
//      is that one package, and runs `scripts/web-node-probe.mjs` from it under Node AND under Bun
//      (refusals in every notation, pinned TLS, the environment-proxy behaviour, the Exa key fallback).
//
// `bun run scripts/web-pack-closure.ts` runs (2) and exits non-zero on any violation;
// `scripts/web-pack-closure.test.ts` runs (1) on synthetic manifests always and (2) under CI or
// `WINTER_TEST_PACK_SMOKE=1`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installedPackages, readPackedView, type PackedView } from "./provider-pack-closure.ts";
import { discoverPublishablePackages, extractTarball, packOne, type PackedPackage } from "./release-pack.ts";

export const WEB_PACKAGE = "@yanlinglabs/winter-web";
const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies"] as const;

/** Every module specifier a compiled file names (static imports/exports, dynamic imports, requires). */
function specifiersIn(text: string): string[] {
  const out: string[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) out.push(m[1]!);
  return out;
}

function isNativeExecutable(head: Uint8Array): boolean {
  if (head.length < 4) return false;
  const word = ((head[0]! << 24) | (head[1]! << 16) | (head[2]! << 8) | head[3]!) >>> 0;
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(word)) return true;
  if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return true;
  return head[0] === 0x4d && head[1] === 0x5a;
}

/** Every reason the packed package would pull something else into a host's install. Empty means clean. */
export function webClosureViolations(view: PackedView): string[] {
  const name = typeof view.manifest["name"] === "string" ? (view.manifest["name"] as string) : "<unnamed>";
  const out: string[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const deps = view.manifest[field];
    if (deps === undefined) continue;
    const names = Array.isArray(deps) ? (deps as unknown[]).map(String) : typeof deps === "object" && deps !== null ? Object.keys(deps) : [];
    for (const dep of names) out.push(`${name}: ${field} names ${dep} -- the package must install with no dependency at all`);
  }
  if (view.manifest["bin"] !== undefined) out.push(`${name}: declares a bin`);
  for (const file of view.files) {
    if (isNativeExecutable(file.head)) out.push(`${name}: ships a native executable (${file.path})`);
    if (file.text === undefined) continue;
    for (const spec of specifiersIn(file.text)) {
      if (spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../")) continue;
      out.push(`${name}: ${file.path} imports "${spec}" -- only node: built-ins and its own files are allowed`);
    }
  }
  return out;
}

export interface WebClosureResult {
  packed: PackedPackage;
  violations: string[];
  installed: string[];
  probes: string[];
}

/** Build, pack, scan, install and probe the package. Writes only under a fresh temp directory, which it removes. */
export async function packWebClosure(opts: { root?: string; build?: boolean } = {}): Promise<WebClosureResult> {
  const root = opts.root ?? fileURLToPath(new URL("..", import.meta.url));
  const target = discoverPublishablePackages(root).find((p) => p.name === WEB_PACKAGE);
  if (target === undefined) throw new Error(`web-pack-closure: ${WEB_PACKAGE} is not among the publishable packages`);
  if (opts.build !== false) {
    const { buildPackages } = await import("./build-packages.ts");
    await buildPackages({ root, packages: [target] });
  }
  const work = mkdtempSync(join(tmpdir(), "winter-web-closure-"));
  try {
    const packed = await packOne(target, work, root);
    const extractDir = join(work, "x");
    await extractTarball(packed.tarballPath, extractDir);
    const violations = webClosureViolations(readPackedView(join(extractDir, "package")));
    const project = join(work, "host");
    await Bun.write(join(project, "package.json"), JSON.stringify({ name: "web-closure-probe", private: true, type: "module" }));
    // NO NETWORK and no ambient npm config, exactly as the provider closure: the tarball is the only source.
    const emptyUser = join(work, "empty-user-npmrc");
    const emptyGlobal = join(work, "empty-global-npmrc");
    await Bun.write(emptyUser, "");
    await Bun.write(emptyGlobal, "");
    const env: Record<string, string | undefined> = { ...process.env, npm_config_cache: join(work, "npm-cache"), npm_config_userconfig: emptyUser, npm_config_globalconfig: emptyGlobal, npm_config_update_notifier: "false", npm_config_offline: "true" };
    for (const key of Object.keys(env)) if (/^(node_auth_token|npm_token)$/i.test(key) || /^npm_config_.*(auth|token|password)/i.test(key)) delete env[key];
    const proc = Bun.spawn(["npm", "install", "--offline", "--no-audit", "--no-fund", "--ignore-scripts", "--no-update-notifier", packed.tarballPath], { cwd: project, stdout: "pipe", stderr: "pipe", env });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`web-pack-closure: npm install of the tarball failed (exit ${code}):\n${stderr || stdout}`);
    const installed = installedPackages(project);
    if (JSON.stringify(installed) !== JSON.stringify([WEB_PACKAGE])) violations.push(`the installed tree is ${installed.join(", ") || "<empty>"}; expected exactly ${WEB_PACKAGE}`);
    const probe = join(project, "web-node-probe.mjs");
    await Bun.write(probe, Bun.file(join(root, "scripts", "web-node-probe.mjs")));
    const probes: string[] = [];
    // A clean environment: no proxy variables leak in from the runner (the probe sets its own).
    const probeEnv = { PATH: process.env["PATH"] ?? "", HOME: project };
    for (const runtime of ["node", process.execPath]) {
      const run = Bun.spawn([runtime, probe], { cwd: project, stdout: "pipe", stderr: "pipe", env: probeEnv });
      const [out, err, exit] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
      probes.push(out.trim());
      if (exit !== 0 || !out.includes("WEB PROBE PASS")) violations.push(`the installed package failed the probe under ${runtime === "node" ? "Node" : "Bun"} (exit ${exit}):\n${out}${err}`);
    }
    return { packed, violations, installed, probes };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = await packWebClosure();
  console.log(`  packed ${result.packed.name}@${result.packed.version}  ${result.packed.size}B`);
  console.log(`  installed: ${result.installed.join(", ")}`);
  for (const line of result.probes) console.log(`  ${line}`);
  if (result.violations.length > 0) {
    console.error("web-pack-closure FAILED:");
    for (const v of result.violations) console.error(`  - ${v}`);
    process.exitCode = 1;
  } else {
    console.log(`web-pack-closure OK -- ${WEB_PACKAGE} installs alone and passes the probe under Node and Bun`);
  }
}
