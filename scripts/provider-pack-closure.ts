// 0.0.56 (W9): the PROVIDER LAYER installs alone -- no `winter` binary, no sdk wrapper.
//
// A host with its own agent loop (an in-process `streamTurn` caller under Node) installs
// `@yanlinglabs/winter-provider-runtime` and `@yanlinglabs/winter-provider-catalog` and nothing else.
// Until 0.0.56 the runtime package listed `@yanlinglabs/winter-agent-sdk` as a dependency, and the sdk
// carries the compiled `winter` binary (`@yanlinglabs/winter-agent-sdk-darwin-arm64`, ~71 MB) as an
// optionalDependency: every such host pulled the wrapper, and on darwin-arm64 the binary, for four
// constants. This script is the gate that keeps it gone:
//
//   1. `closureViolations` (pure) -- refuses a packed manifest that names the sdk or the platform
//      package in ANY dependency field, any dependency outside the provider pair, a `bin`, a shipped
//      file that is a native executable, and a compiled JS or declaration file that imports the sdk.
//   2. `packProviderClosure` -- builds and `pnpm pack`s exactly the two packages, extracts them, runs
//      (1) on what was packed, then `npm install --offline`s the two tarballs into a scratch project,
//      checks the installed tree holds those two packages and nothing else, and runs a Node host's path
//      from them (the OpenRouter probe's dry run, and the `./testing` fake adapter).
//
// `bun run scripts/provider-pack-closure.ts` runs (2) and exits non-zero on any violation;
// `scripts/provider-pack-closure.test.ts` runs (1) on synthetic manifests always and (2) under CI or
// `WINTER_TEST_PACK_SMOKE=1`.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPublishablePackages, extractTarball, packOne, type PackedPackage } from "./release-pack.ts";

export const PROVIDER_PACKAGES = ["@yanlinglabs/winter-provider-runtime", "@yanlinglabs/winter-provider-catalog"] as const;
/** What the provider layer must never pull in: the wrapper, and the platform package that carries the binary. */
export const FORBIDDEN_PACKAGES = ["@yanlinglabs/winter-agent-sdk", "@yanlinglabs/winter-agent-sdk-darwin-arm64"] as const;
const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies"] as const;

/** One packed package as the gate sees it: its manifest and every file it ships (relative path + first bytes). */
export interface PackedView {
  manifest: Record<string, unknown>;
  files: Array<{ path: string; head: Uint8Array; text?: string }>;
}

/** Mach-O (both byte orders, 32/64-bit and fat), ELF and PE/MZ magic numbers. */
function isNativeExecutable(head: Uint8Array): boolean {
  if (head.length < 4) return false;
  const b: [number, number, number, number] = [head[0]!, head[1]!, head[2]!, head[3]!];
  const word = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  const MACHO = [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca];
  if (MACHO.includes(word)) return true;
  if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return true; // ELF
  return b[0] === 0x4d && b[1] === 0x5a; // MZ
}

/** A bare `@yanlinglabs/winter-agent-sdk` specifier in an import/export/require -- the package root or any subpath. */
const SDK_SPECIFIER_RE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["']@yanlinglabs\/winter-agent-sdk(?:-darwin-arm64)?(?:\/[^"']*)?["']/;

/** Every reason a packed provider package would drag the sdk or a binary into a host's install. Empty means clean. */
export function closureViolations(view: PackedView): string[] {
  const name = typeof view.manifest["name"] === "string" ? (view.manifest["name"] as string) : "<unnamed>";
  const out: string[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const deps = view.manifest[field];
    if (deps === undefined) continue;
    const names = Array.isArray(deps) ? (deps as unknown[]).map(String) : typeof deps === "object" && deps !== null ? Object.keys(deps) : [];
    for (const dep of names) {
      if ((FORBIDDEN_PACKAGES as readonly string[]).includes(dep)) out.push(`${name}: ${field} names ${dep}, which carries the winter runtime binary`);
      else if (!(PROVIDER_PACKAGES as readonly string[]).includes(dep)) out.push(`${name}: ${field} names ${dep}, outside the provider pair -- a host's install would grow by it`);
    }
  }
  if (view.manifest["bin"] !== undefined) out.push(`${name}: declares a bin`);
  for (const file of view.files) {
    if (isNativeExecutable(file.head)) out.push(`${name}: ships a native executable (${file.path})`);
    if (file.text !== undefined && SDK_SPECIFIER_RE.test(file.text)) out.push(`${name}: ${file.path} imports @yanlinglabs/winter-agent-sdk`);
  }
  return out;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Reads an extracted `package/` directory into the gate's view. JS and declaration files are read as text. */
export function readPackedView(packageRoot: string): PackedView {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>;
  const files = walk(packageRoot).map((full) => {
    const bytes = readFileSync(full);
    const path = relative(packageRoot, full);
    return { path, head: bytes.subarray(0, 4), ...(/\.(m?js|cjs|d\.ts)$/.test(path) ? { text: bytes.toString("utf8") } : {}) };
  });
  return { manifest, files };
}

/** Installed package names under a project's `node_modules` (scoped packages expanded). */
export function installedPackages(projectDir: string): string[] {
  const nm = join(projectDir, "node_modules");
  if (!existsSync(nm)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(nm)) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) for (const inner of readdirSync(join(nm, entry))) out.push(`${entry}/${inner}`);
    else out.push(entry);
  }
  return out.sort();
}

export interface ClosureResult {
  packed: PackedPackage[];
  violations: string[];
  installed: string[];
}

/** Build, pack, scan and install the provider pair. Writes only under fresh temp directories, which it removes. */
export async function packProviderClosure(opts: { root?: string; build?: boolean } = {}): Promise<ClosureResult> {
  const root = opts.root ?? fileURLToPath(new URL("..", import.meta.url));
  const targets = discoverPublishablePackages(root).filter((p) => (PROVIDER_PACKAGES as readonly string[]).includes(p.name));
  if (targets.length !== PROVIDER_PACKAGES.length) throw new Error(`provider-pack-closure: expected ${PROVIDER_PACKAGES.join(", ")} among the publishable packages, found ${targets.map((t) => t.name).join(", ")}`);
  if (opts.build !== false) {
    const { buildPackages } = await import("./build-packages.ts");
    await buildPackages({ root, packages: targets });
  }
  const work = mkdtempSync(join(tmpdir(), "winter-provider-closure-"));
  try {
    const packed: PackedPackage[] = [];
    const violations: string[] = [];
    for (const pkg of targets) {
      const result = await packOne(pkg, work, root);
      packed.push(result);
      const extractDir = join(work, `x-${packed.length}`);
      await extractTarball(result.tarballPath, extractDir);
      violations.push(...closureViolations(readPackedView(join(extractDir, "package"))));
    }
    // The install a host performs, offline: every dependency must be satisfied by the two tarballs.
    const project = join(work, "host");
    await Bun.write(join(project, "package.json"), JSON.stringify({ name: "provider-closure-probe", private: true, type: "module" }));
    // NO NETWORK and no ambient npm config: an empty user/global config (no `.npmrc` login, no scope
    // registry), a fresh cache, `--offline`, and the update notifier off -- it is the one request npm
    // would otherwise make on its own. Every dependency must come from the two tarballs on the line.
    const emptyUser = join(work, "empty-user-npmrc");
    const emptyGlobal = join(work, "empty-global-npmrc");
    await Bun.write(emptyUser, "");
    await Bun.write(emptyGlobal, "");
    const env: Record<string, string | undefined> = { ...process.env, npm_config_cache: join(work, "npm-cache"), npm_config_userconfig: emptyUser, npm_config_globalconfig: emptyGlobal, npm_config_update_notifier: "false", npm_config_offline: "true" };
    for (const key of Object.keys(env)) if (/^(node_auth_token|npm_token)$/i.test(key) || /^npm_config_.*(auth|token|password)/i.test(key)) delete env[key];
    const proc = Bun.spawn(["npm", "install", "--offline", "--no-audit", "--no-fund", "--ignore-scripts", "--no-update-notifier", ...packed.map((p) => p.tarballPath)], { cwd: project, stdout: "pipe", stderr: "pipe", env });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`provider-pack-closure: npm install of the two tarballs failed (exit ${code}):\n${stderr || stdout}`);
    const installed = installedPackages(project);
    const expected = [...PROVIDER_PACKAGES].sort();
    if (JSON.stringify(installed) !== JSON.stringify(expected)) violations.push(`the installed tree is ${installed.join(", ") || "<empty>"}; expected exactly ${expected.join(", ")}`);
    // A Node host's whole path, from the installed tarballs: the OpenRouter probe's DRY RUN (canned
    // responses, a fake key, no network) drives the shipped adapter, the stream assembler, the history
    // renderer and `setWinterIdentity`; then the `./testing` subpath's Node-usable fake adapter.
    const probe = join(project, "probe-openrouter-reasoning.mjs");
    await Bun.write(probe, Bun.file(join(root, "scripts", "probe-openrouter-reasoning.mjs")));
    const nodeEnv = { PATH: process.env["PATH"] ?? "", HOME: project };
    const run = Bun.spawn(["node", probe, "--dry-run"], { cwd: project, stdout: "pipe", stderr: "pipe", env: nodeEnv });
    const [probeOut, probeErr, probeCode] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
    if (probeCode !== 0 || !probeOut.includes("ALL 5 STEPS PASS")) violations.push(`the installed packages failed the probe's dry run under Node (exit ${probeCode}):\n${probeOut}${probeErr}`);
    const fake = Bun.spawn(["node", "--input-type=module", "-e", "const t = await import('@yanlinglabs/winter-provider-runtime/testing'); const r = await import('@yanlinglabs/winter-provider-runtime'); const a = t.createFakeProviderAdapter({ turns: [t.fakeTextTurn('ok')] }); const turn = await r.foldProviderStream(a.streamTurn({ model: 'm', messages: [] }, {})); if (turn.text !== 'ok') process.exit(3);"], { cwd: project, stdout: "pipe", stderr: "pipe", env: nodeEnv });
    const [fakeOut, fakeErr, fakeCode] = await Promise.all([new Response(fake.stdout).text(), new Response(fake.stderr).text(), fake.exited]);
    if (fakeCode !== 0) violations.push(`the ./testing fake adapter failed under Node (exit ${fakeCode}):\n${fakeOut}${fakeErr}`);
    return { packed, violations, installed };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = await packProviderClosure();
  for (const p of result.packed) console.log(`  packed ${p.name}@${p.version}  ${p.size}B`);
  console.log(`  installed: ${result.installed.join(", ")}`);
  if (result.violations.length > 0) {
    console.error("provider-pack-closure FAILED:");
    for (const v of result.violations) console.error(`  - ${v}`);
    process.exitCode = 1;
  } else {
    console.log("provider-pack-closure OK -- the provider pair installs alone: no sdk, no winter binary");
  }
}
