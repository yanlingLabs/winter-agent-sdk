// The consumer-fixture compiler: `tsc --noEmit` over one of the two fixture tsconfigs (the winter
// package, and the official one under `tsconfig.official.json`).
//
// P7a fix wave round 2 (item 1): A MISSING `dist/` IS REPORTED IN WORDS, not as tsc's own error.
//
// `tsconfig.winter.json` maps `@sdk-under-test` onto the sdk's SOURCE, and in doing so REPLACES the
// repo-wide `paths` it inherits from `tsconfig.base.json` (a tsconfig `extends` merges
// `compilerOptions` shallowly, so a `paths` block overrides the whole map rather than adding to it).
// Every OTHER workspace specifier the sdk source reaches -- `@yanlinglabs/winter-provider-catalog/families`
// is the live one -- therefore resolves the ordinary way, through node_modules to that package's own
// `types` condition, which since the compiled emit is `./dist/*.d.ts`.
//
// So on a checkout that has never run `build:packages`, this compiles only if something else built
// first. It did, by accident, whenever `build-packages.test.ts` happened to run earlier in the same
// `bun test` -- which is exactly how the merge's focused run failed once and passed on re-run. The
// caller (`compile-fixtures.test.ts`) now builds in `beforeAll`; this guard is the second half, for
// every OTHER caller and for a human running `bunx tsc -p ...` by hand.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Every publishable package whose `types` condition names a `dist` file that is not on disk.
 *
 * Read from the MANIFESTS rather than from a list: a package that stops pointing its `types` at
 * `dist` (or a new one that starts) is covered without editing this file. Deliberately does NOT
 * import `release-pack.ts` -- this module is the low-level compile seam and must stay free of the
 * packaging pipeline it is sometimes run before.
 */
export function missingDistPackages(root: string = REPO_ROOT): string[] {
  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir)) return [];
  const missing: string[] = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesDir, entry.name, "package.json");
    if (!existsSync(manifestPath)) continue;
    let manifest: { name?: string; exports?: Record<string, unknown> | string };
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof manifest;
    } catch {
      continue;
    }
    const exportsField = manifest.exports;
    if (typeof exportsField !== "object" || exportsField === null) continue;
    for (const conditions of Object.values(exportsField)) {
      const types = typeof conditions === "object" && conditions !== null ? (conditions as Record<string, unknown>)["types"] : undefined;
      if (typeof types !== "string" || !types.startsWith("./dist/")) continue;
      if (!existsSync(join(packagesDir, entry.name, types.slice(2)))) {
        missing.push(`${manifest.name ?? entry.name} (${types})`);
        break;
      }
    }
  }
  return missing.sort();
}

export async function compile(tsconfig: string): Promise<{ ok: boolean; output: string }> {
  // Checked BEFORE spawning tsc: the failure it produces otherwise is
  // `TS2307: Cannot find module '@yanlinglabs/winter-provider-catalog/families'`, pointed at a line
  // in `packages/sdk/src` -- which reads as a broken import in the sdk rather than as a missing build.
  const missing = missingDistPackages();
  if (missing.length > 0) {
    return {
      ok: false,
      output:
        `compile-fixtures: run \`bun run build:packages\` first -- ${missing.length} publishable package(s) point their \`types\` condition at a \`dist/\` that is not on disk:\n` +
        missing.map((m) => `  ${m}`).join("\n") +
        `\n(this tsconfig maps \`@sdk-under-test\` onto the sdk SOURCE, which replaces the repo-wide \`paths\`, so every other workspace specifier resolves through node_modules to that package's compiled declarations)`,
    };
  }
  const proc = Bun.spawn(["bunx", "tsc", "--noEmit", "-p", tsconfig], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  return { ok: (await proc.exited) === 0, output: out };
}
