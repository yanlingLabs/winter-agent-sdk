// P7a fix wave (item 1; R-7a-16's reversal path): THE COMPILED EMIT for every publishable package.
//
// THE PROBLEM, stated as the smoke test found it. Every publishable manifest pointed `main`/`exports`
// at `./src/*.ts`, with `.ts` import specifiers inside. Bun imports that happily; Node cannot, at any
// version -- Node 18 has no TypeScript at all, and even a modern Node's `--experimental-strip-types`
// REFUSES to strip types for a file under `node_modules`
// (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). WS-02 §5 says Bun-first WITH Node consumers and §9
// item 3 gates every publish on a tarball smoke under Node 18 AND Bun, so the Node leg was carried as
// a disclosed, advisory failure (R-7a-16) until this landed.
//
// THE SHAPE. Two emitters, because they answer two different questions:
//
//   * JS -- ONE `bun build` per PACKAGE, listing every export entry, with `--splitting --outdir dist`
//     (P7a pre-publish item 2; it was one `--outfile` invocation per entry). `--packages=external`
//     keeps every bare specifier (workspace peers, `@modelcontextprotocol/sdk`) as a real import that
//     the consumer's own node_modules resolves, while RELATIVE imports -- including the catalog's
//     `generated/*.json` module imports -- are bundled in. `--splitting` hoists a module reached by
//     more than one entry into a SHARED CHUNK, so it is evaluated once: without it every entry
//     inlined its own copy, and a class declared in one source file was N distinct classes at
//     runtime, making `instanceof` false across subpaths of one package under Node.
//   * Declarations -- `tsc --emitDeclarationOnly`, per package, over the whole `src` tree, followed by
//     `rewriteDeclarationSpecifiers`. It has to be tsc (`bun build` emits no types), and a `.d.ts`
//     whose relative specifiers still ended in `.ts` would be exactly the original defect one layer
//     up: a consumer's own `tsc` cannot resolve `./x.ts` from inside `node_modules` either.
//
//     `rewriteRelativeImportExtensions` (the design's route) DOES NOT DO THIS. Measured on TS 5.9.3
//     against a two-file minimal repro under both `module: esnext`/`bundler` and
//     `nodenext`/`nodenext`: the flag rewrites emitted JAVASCRIPT, and the emitted `.d.ts` keeps
//     `export { a } from "./a.ts"` verbatim in every configuration. The option is still set in
//     `tsconfig.build.json` (it is correct for any JS tsc ever emits here), and the rewrite below is
//     what actually makes the declarations resolvable -- with its own plant test, because a silent
//     no-op is precisely how this was nearly shipped.
//
// THE `bun` CONDITION IS WHY THIS CHANGES NOTHING IN-REPO. Each entry's `exports` becomes
// `{ types: ./dist/<e>.d.ts, bun: ./src/<e>.ts, default: ./dist/<e>.js }`: Bun -- this repo's own
// tests, `verify:workflow`, and the compiled `winter` binary that embeds sources -- keeps resolving
// the SOURCE, byte for byte. Only a non-Bun runtime falls through to `default`.
//
// AND `tsconfig.base.json` CARRIES `paths` FOR THE SAME REASON. tsc resolves the `types` condition,
// which names a file that does not exist until this script has run -- so without the path mapping,
// `bun run typecheck` on a fresh clone would fail with "Cannot find module
// '@yanlinglabs/winter-provider-catalog'" (measured, not assumed). The mapping points tsc at `src`,
// which is where Bun and this repo already look; nothing about the PUBLISHED resolution changes.
//
// NOTHING HERE PUBLISHES ANYTHING, and nothing here writes outside `packages/<pkg>/dist` (which is
// gitignored). `release-pack` calls it first so a tarball can never carry a stale or missing dist.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPublishablePackages, type PublishablePackage } from "./release-pack.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export interface BuiltEntry {
  /** The `exports` key this entry serves, e.g. "." or "./official". */
  subpath: string;
  /** Source entry, repo-relative. */
  source: string;
  /** Emitted JS, package-relative (e.g. "dist/official/index.js"). */
  js: string;
  /** Emitted declaration, package-relative. */
  types: string;
}

export interface BuiltPackage {
  name: string;
  dir: string;
  entries: BuiltEntry[];
}

export interface BuildPackagesResult {
  packages: BuiltPackage[];
  /** Every `bun build` / `tsc` invocation, in order — so a caller can report what actually ran. */
  commands: string[];
}

/**
 * The export entries of one package, read from its OWN manifest.
 *
 * Derived rather than listed, exactly like `deriveImportTargets` in the smoke: a subpath added to a
 * manifest without a build entry would otherwise ship a `default` pointing at a file nobody emitted,
 * and the smoke would find it only after a pack.
 *
 * A manifest whose `exports` map is already CONDITIONAL (this script's own output, on a rebuild)
 * reads the `bun` condition -- the source path -- rather than the compiled one.
 */
export function entriesFor(pkg: PublishablePackage): Array<{ subpath: string; sourceRelative: string }> {
  const manifest = JSON.parse(require("node:fs").readFileSync(pkg.packageJsonPath, "utf8")) as { exports?: Record<string, unknown> | string; bin?: unknown };
  const field = manifest.exports;
  // P9a-3: a BIN-ONLY package (the darwin-arm64 platform package: no `exports` at all, only `bin`)
  // ships a compiled native BINARY, never a JS entry point -- there is nothing here for `bun build`/
  // `tsc` to build, and no `dist/` for it to land in. Checked before the "no exports -> src/index.ts"
  // default below, which exists for a package that has JS but omits `exports` (none exist in this
  // workspace today; kept as the documented fallback for one that might).
  if (field === undefined && manifest.bin !== undefined) return [];
  if (field === undefined) return [{ subpath: ".", sourceRelative: "src/index.ts" }];
  if (typeof field === "string") return [{ subpath: ".", sourceRelative: field.replace(/^\.\//, "") }];
  const out: Array<{ subpath: string; sourceRelative: string }> = [];
  for (const [subpath, value] of Object.entries(field)) {
    const source =
      typeof value === "string"
        ? value
        : typeof (value as Record<string, unknown>)["bun"] === "string"
          ? ((value as Record<string, string>)["bun"] as string)
          : undefined;
    if (source === undefined) throw new Error(`build:packages: ${pkg.name} exports["${subpath}"] has no source path (expected a string or a "bun" condition)`);
    out.push({ subpath, sourceRelative: source.replace(/^\.\//, "") });
  }
  return out;
}

/** `src/official/index.ts` -> `dist/official/index.js` — the dist tree MIRRORS src, so two entries named `index.ts` cannot collide. */
function distPathFor(sourceRelative: string, extension: ".js" | ".d.ts"): string {
  const withoutSrc = sourceRelative.replace(/^src\//, "");
  return `dist/${withoutSrc.replace(/\.ts$/, extension === ".js" ? ".js" : ".d.ts")}`;
}

/**
 * Rewrites RELATIVE module specifiers ending in `.ts` to `.js`, in one emitted `.d.ts`.
 *
 * Bounded to the two syntactic positions a specifier can occupy in a declaration file -- the
 * `from "..."` clause of an import/export, and a type-position `import("...")` -- and to specifiers
 * that START with `.`, so a package name is never touched and a `.ts` inside a string literal TYPE
 * (`type Ext = "./x.ts"`) is left alone. Exported for its plant test.
 */
export function rewriteDeclarationSpecifiers(source: string): string {
  return source
    .replace(/(\bfrom\s*)(["'])(\.[^"']*)\.ts\2/g, (_m, from: string, quote: string, path: string) => `${from}${quote}${path}.js${quote}`)
    .replace(/(\bimport\s*\(\s*)(["'])(\.[^"']*)\.ts\2/g, (_m, open: string, quote: string, path: string) => `${open}${quote}${path}.js${quote}`);
}

/** Every `.d.ts` under `dir`, recursively, as paths relative to it. Empty when `dir` does not exist. */
function declarationsUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...declarationsUnder(full).map((p) => `${entry.name}/${p}`));
    else if (entry.isFile() && entry.name.endsWith(".d.ts")) out.push(entry.name);
  }
  return out;
}

/** Applies `rewriteDeclarationSpecifiers` to every `.d.ts` under `dir`; returns how many files changed. */
function rewriteDeclarationsIn(dir: string): number {
  let changed = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      changed += rewriteDeclarationsIn(full);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".d.ts")) continue;
    const before = readFileSync(full, "utf8");
    const after = rewriteDeclarationSpecifiers(before);
    if (after !== before) {
      writeFileSync(full, after);
      changed++;
    }
  }
  return changed;
}

async function run(command: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`build:packages: \`${command.join(" ")}\` failed (exit ${exitCode}) in ${cwd}:\n${stdout}\n${stderr}`);
}

/**
 * Builds `dist/` for every publishable package.
 *
 * `root` is injectable so `build-packages.test.ts` can drive a real build without a caller having to
 * trust that it cleaned up: the test points it at the repo (the only tree that HAS these packages)
 * and asserts on `packages/<pkg>/dist`, which is gitignored and rebuilt by this function every time.
 */
/**
 * The publishable set in DEPENDENCY ORDER.
 *
 * `tsconfig.build.json` sets `paths: {}` -- it must, because the repo-wide `paths` (which point tsc
 * at other packages' `src`) would pull files from outside this package's `rootDir` into the program
 * and fail the declaration emit outright. So a cross-package import in a `.d.ts` run resolves the
 * ordinary way, through node_modules to that package's own `types` -- i.e. to its `dist`, which has
 * to exist first. Alphabetical order (what `discoverPublishablePackages` returns) puts the sdk before
 * the catalog it depends on, so the order is COMPUTED from the manifests rather than written down:
 * a new dependency between two publishable packages reorders the build by itself.
 */
export function inDependencyOrder(packages: readonly PublishablePackage[]): PublishablePackage[] {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const ordered: PublishablePackage[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (pkg: PublishablePackage): void => {
    const seen = state.get(pkg.name);
    if (seen === "done") return;
    if (seen === "visiting") throw new Error(`build:packages: dependency cycle through ${pkg.name}`);
    state.set(pkg.name, "visiting");
    const manifest = JSON.parse(require("node:fs").readFileSync(pkg.packageJsonPath, "utf8")) as { dependencies?: Record<string, string> };
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      const target = byName.get(dep);
      if (target !== undefined) visit(target);
    }
    state.set(pkg.name, "done");
    ordered.push(pkg);
  };
  for (const pkg of packages) visit(pkg);
  return ordered;
}

export async function buildPackages(opts: { root?: string; packages?: readonly PublishablePackage[] } = {}): Promise<BuildPackagesResult> {
  const root = opts.root ?? REPO_ROOT;
  const packages = inDependencyOrder(opts.packages ?? discoverPublishablePackages(root));
  const commands: string[] = [];
  const built: BuiltPackage[] = [];

  for (const pkg of packages) {
    // P9a-3: a bin-only package has no JS to build at all -- `entriesFor` returns `[]` for it, and
    // there is nothing here to clean, create, bundle or declare. Recorded in `built` with zero
    // entries so `result.packages.length` still equals every publishable package's count.
    const entryPlan = entriesFor(pkg);
    if (entryPlan.length === 0) {
      built.push({ name: pkg.name, dir: pkg.dir, entries: [] });
      continue;
    }

    const distDir = join(pkg.dir, "dist");
    // A FULL CLEAN per build, never an incremental overlay: a source file deleted between builds
    // would otherwise leave its stale `.js`/`.d.ts` in the tarball, still resolvable and wrong.
    rmSync(distDir, { recursive: true, force: true });
    mkdirSync(distDir, { recursive: true });

    // ONE MULTI-ENTRY BUILD PER PACKAGE, WITH CODE SPLITTING (P7a pre-publish, item 2).
    //
    // This was one `bun build --outfile` PER ENTRY, and that is what made a class declared in one
    // source file exist as N distinct classes at runtime: each entry bundle inlined its own copy of
    // every internal module it reached. Under Node -- where a consumer resolves the `default`
    // condition -- `instanceof` across two subpaths of ONE package was therefore false, which the fix
    // wave papered over with `Symbol.for` branding (kept: it is a public contract now, and it also
    // covers the cross-realm case splitting cannot).
    //
    // `--splitting` with every entry in one invocation is the structural answer: a module reached by
    // more than one entry is hoisted into a SHARED CHUNK that both entries import, so it is evaluated
    // once and its classes are one object. `--outdir` (not `--outfile`) is required for it, and bun
    // names each entry's output by its path relative to the common root of the entrypoints -- all of
    // which live under `src/`, so the emitted tree MIRRORS src exactly as the per-entry build did
    // (`src/official/index.ts` -> `dist/official/index.js`). Chunks land beside them as
    // `<name>-<hash>.js`, imported by relative specifier, so nothing about the `exports` map moves.
    //
    // `--packages=external` still keeps every bare specifier a real import the consumer resolves;
    // only RELATIVE imports are bundled, and now deduplicated across entries.
    for (const { sourceRelative } of entryPlan) mkdirSync(dirname(join(pkg.dir, distPathFor(sourceRelative, ".js"))), { recursive: true });
    const buildCommand = [
      "bun",
      "build",
      ...entryPlan.map((e) => e.sourceRelative),
      "--target=node",
      "--format=esm",
      "--packages=external",
      "--splitting",
      "--outdir",
      "dist",
    ];
    commands.push(`(${pkg.name}) ${buildCommand.join(" ")}`);
    await run(buildCommand, pkg.dir);

    const entries: BuiltEntry[] = [];
    for (const { subpath, sourceRelative } of entryPlan) {
      const jsRelative = distPathFor(sourceRelative, ".js");
      if (!existsSync(join(pkg.dir, jsRelative))) throw new Error(`build:packages: ${pkg.name} ${subpath}: bun build produced no ${jsRelative}`);
      entries.push({ subpath, source: relative(root, join(pkg.dir, sourceRelative)), js: jsRelative, types: distPathFor(sourceRelative, ".d.ts") });
    }

    // ONE tsc run per package, over the whole src tree: declarations are cheap and a `.d.ts` for a
    // file that is only reachable transitively is still needed by a consumer's type-checker.
    //
    // Snapshotted BEFORE the run so the containment check below reports what THIS run wrote, not the
    // hand-authored ambient declarations this repo legitimately keeps beside its sources
    // (`context/presets/text-modules.d.ts` is one).
    const declarationsBefore = new Set(declarationsUnder(join(root, "packages")));
    const tsc = ["bunx", "tsc", "-p", "tsconfig.build.json"];
    commands.push(`(${pkg.name}) ${tsc.join(" ")}`);
    await run(tsc, pkg.dir);
    const rewritten = rewriteDeclarationsIn(distDir);
    commands.push(`(${pkg.name}) rewriteDeclarationSpecifiers: ${rewritten} .d.ts file(s)`);
    for (const entry of entries) {
      if (!existsSync(join(pkg.dir, entry.types))) throw new Error(`build:packages: ${pkg.name} ${entry.subpath}: tsc produced no ${entry.types}`);
    }
    // NOTHING MAY LAND IN `src/`. A tsc run that fails `rootDir` containment (a file reached from
    // outside this package) still EMITS before it reports, and it emits BESIDE THE SOURCE rather than
    // into `outDir` -- 196 stray `.d.ts` files appeared under `packages/runtime/src` exactly that way
    // while this script was being written, untracked and easy to commit by accident. A loud failure
    // beats a `.gitignore` entry: the emit is the symptom, the containment break is the defect.
    const stray = declarationsUnder(join(root, "packages")).filter((p) => !declarationsBefore.has(p) && !p.includes("/dist/"));
    if (stray.length > 0) {
      throw new Error(
        `build:packages: ${pkg.name}'s declaration run wrote ${stray.length} NEW .d.ts file(s) outside dist/ ` +
          `(the first few: ${stray.slice(0, 5).join(", ")}). That means tsc pulled in a file outside this package's rootDir; ` +
          `delete them, then either exclude the importer or move the shared type into this package.`,
      );
    }
    built.push({ name: pkg.name, dir: pkg.dir, entries });
  }
  return { packages: built, commands };
}

if (import.meta.main) {
  const result = await buildPackages();
  for (const pkg of result.packages) {
    console.log(`build:packages: ${pkg.name} -> ${pkg.entries.map((e) => e.js).join(", ")}`);
  }
  console.log(`build:packages: OK (${result.packages.length} packages, ${result.packages.reduce((n, p) => n + p.entries.length, 0)} entries)`);
}
