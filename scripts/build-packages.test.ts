// P7a fix wave (item 1): the compiled emit's own test.
//
// WHAT THIS PROVES that the installed-tarball smoke does not. The smoke is the end-to-end gate (pack
// -> npm install -> import under Node and Bun) and it is where a broken emit finally shows; it costs
// ~90 s and lives behind `WINTER_TEST_PACK_SMOKE=1` outside CI. These cases are the cheap, always-on
// half: that the build is DERIVED from each manifest rather than hand-listed, that the two
// conditions point at files that exist, and -- the one that nearly shipped wrong -- that the emitted
// declarations carry no `.ts` specifier.
//
// The BUILD ITSELF is opt-in for the same reason the pack smoke is (`bun build` x10 plus five `tsc`
// runs is ~90 s), and gated on the same variable so one flag turns on both halves of the packaging
// gate. Everything that can be proven without running it runs unconditionally.
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPublishablePackages } from "./release-pack.ts";
import { buildPackages, entriesFor, inDependencyOrder, rewriteDeclarationSpecifiers, type BuildPackagesResult } from "./build-packages.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILD_ENABLED = (process.env["CI"] ?? "") !== "" || process.env["WINTER_TEST_PACK_SMOKE"] === "1";
if (!BUILD_ENABLED) {
  console.log(
    "[build-packages] SKIPPING the real build (~90s: bun build x10 + tsc x5). " +
      "Run it with WINTER_TEST_PACK_SMOKE=1 bun test scripts/build-packages.test.ts; CI always runs it.",
  );
}

// P9a-3: the darwin-arm64 platform package ships a compiled BINARY under `bin/`, never a JS
// entry point -- it declares no `exports` at all, so every test below that reads `manifest.exports`
// unconditionally must carve it out rather than crash on `Object.keys(undefined)`.
function isBinOnly(pkg: { packageJsonPath: string }): boolean {
  const manifest = JSON.parse(readFileSync(pkg.packageJsonPath, "utf8")) as { exports?: unknown; bin?: unknown };
  return manifest.exports === undefined && manifest.bin !== undefined;
}

describe("build-packages: the plan is DERIVED from each manifest", () => {
  test("every publishable package's every exports subpath becomes a build entry", () => {
    // The property that makes a forgotten subpath impossible: a manifest key with no entry would
    // publish a `default` condition pointing at a file nobody emitted, and only the smoke -- after a
    // pack -- would notice.
    for (const pkg of discoverPublishablePackages()) {
      if (isBinOnly(pkg)) {
        expect([pkg.name, entriesFor(pkg)]).toEqual([pkg.name, []]); // bin-only: nothing to build
        continue;
      }
      const manifest = JSON.parse(readFileSync(pkg.packageJsonPath, "utf8")) as { exports: Record<string, unknown> };
      const entries = entriesFor(pkg);
      expect([pkg.name, entries.map((e) => e.subpath).sort()]).toEqual([pkg.name, Object.keys(manifest.exports).sort()]);
      // Each entry names a REAL source file, and it is the `bun` condition's own path -- so the
      // compiled artifact and the source Bun resolves can never describe different modules.
      for (const entry of entries) {
        expect([pkg.name, entry.subpath, existsSync(join(pkg.dir, entry.sourceRelative))]).toEqual([pkg.name, entry.subpath, true]);
      }
    }
  });

  test("the build order is topological -- a package is built after every publishable dependency", () => {
    // `discoverPublishablePackages` sorts alphabetically, which puts the sdk before the catalog it
    // depends on; the declaration run of a dependent resolves its dependency through node_modules to
    // that package's `types`, i.e. to its dist. Wrong order = a `.d.ts` build against a missing one.
    const ordered = inDependencyOrder(discoverPublishablePackages()).map((p) => p.name);
    const position = new Map(ordered.map((name, i) => [name, i]));
    for (const pkg of discoverPublishablePackages()) {
      const manifest = JSON.parse(readFileSync(pkg.packageJsonPath, "utf8")) as { dependencies?: Record<string, string> };
      for (const dep of Object.keys(manifest.dependencies ?? {})) {
        if (!position.has(dep)) continue;
        expect([`${dep} before ${pkg.name}`, position.get(dep)! < position.get(pkg.name)!]).toEqual([`${dep} before ${pkg.name}`, true]);
      }
    }
    // Not vacuous: the catalog really does precede the sdk, which is the pair alphabetical order got wrong.
    expect(position.get("@yanlinglabs/winter-provider-catalog")! < position.get("@yanlinglabs/winter-agent-sdk")!).toBe(true);
  });

  test("every manifest's three conditions agree with the entry they describe", () => {
    // `types`/`bun`/`default` must name the same module in three spellings. A `bun` condition that
    // drifted from the built entry would give this repo's own tests and a published consumer two
    // different modules under one specifier -- the failure mode a source condition invites.
    for (const pkg of discoverPublishablePackages()) {
      if (isBinOnly(pkg)) continue; // bin-only: no exports map to describe
      const manifest = JSON.parse(readFileSync(pkg.packageJsonPath, "utf8")) as { exports: Record<string, Record<string, string>>; main?: string; types?: string };
      for (const [subpath, conditions] of Object.entries(manifest.exports)) {
        expect([pkg.name, subpath, Object.keys(conditions)]).toEqual([pkg.name, subpath, ["types", "bun", "default"]]);
        const stem = conditions["bun"]!.replace(/^\.\/src\//, "").replace(/\.ts$/, "");
        expect([pkg.name, subpath, conditions["default"]]).toEqual([pkg.name, subpath, `./dist/${stem}.js`]);
        expect([pkg.name, subpath, conditions["types"]]).toEqual([pkg.name, subpath, `./dist/${stem}.d.ts`]);
      }
      // `main`/`types` are the legacy fields for tools that ignore `exports`; they must be the
      // NODE-loadable pair, never the source.
      expect([pkg.name, manifest.main]).toEqual([pkg.name, manifest.exports["."]!["default"]]);
      expect([pkg.name, manifest.types]).toEqual([pkg.name, manifest.exports["."]!["types"]]);
    }
  });

  test("`dist` is in every publishable `files` list -- the emit is what ships (bin-only packages ship `bin` instead)", () => {
    for (const pkg of discoverPublishablePackages()) {
      const manifest = JSON.parse(readFileSync(pkg.packageJsonPath, "utf8")) as { files: string[] };
      if (isBinOnly(pkg)) {
        expect([pkg.name, manifest.files.includes("bin")]).toEqual([pkg.name, true]);
        continue;
      }
      expect([pkg.name, manifest.files.includes("dist")]).toEqual([pkg.name, true]);
    }
  });
});

describe("rewriteDeclarationSpecifiers (the step `rewriteRelativeImportExtensions` does NOT do)", () => {
  // MEASURED, not assumed: on TS 5.9.3, with `rewriteRelativeImportExtensions: true` under both
  // `module: esnext`/`bundler` and `nodenext`/`nodenext`, an emitted `.d.ts` keeps
  // `export { a } from "./a.ts"` verbatim. The flag rewrites emitted JAVASCRIPT. A consumer's own
  // tsc cannot resolve `./a.ts` from inside node_modules, so this rewrite is load-bearing -- and a
  // silent no-op here is exactly how it was nearly shipped.
  test("relative `.ts` specifiers become `.js`, in both syntactic positions", () => {
    expect(rewriteDeclarationSpecifiers('export { a } from "./a.ts";')).toBe('export { a } from "./a.js";');
    expect(rewriteDeclarationSpecifiers('import type { B } from "../b/c.ts";')).toBe('import type { B } from "../b/c.js";');
    expect(rewriteDeclarationSpecifiers('export type * from "./types.ts";')).toBe('export type * from "./types.js";');
    expect(rewriteDeclarationSpecifiers('type X = import("./d.ts").D;')).toBe('type X = import("./d.js").D;');
    expect(rewriteDeclarationSpecifiers("export { a } from './a.ts';")).toBe("export { a } from './a.js';");
  });

  test("a BARE specifier and a non-specifier string are untouched", () => {
    // A package name is resolved by the consumer's node_modules and must keep its exact spelling; a
    // string literal TYPE that merely ends in `.ts` is data, not a module reference.
    expect(rewriteDeclarationSpecifiers('export { x } from "@yanlinglabs/winter-provider-catalog";')).toBe('export { x } from "@yanlinglabs/winter-provider-catalog";');
    expect(rewriteDeclarationSpecifiers('declare const p: "./notes.ts";')).toBe('declare const p: "./notes.ts";');
    expect(rewriteDeclarationSpecifiers('export declare function f(path: "src/x.ts"): void;')).toBe('export declare function f(path: "src/x.ts"): void;');
  });
});

describe.skipIf(!BUILD_ENABLED)("build-packages: the real build", () => {
  let result: BuildPackagesResult;
  beforeAll(async () => {
    result = await buildPackages();
  }, 240_000);

  test("every entry emits BOTH a .js and a .d.ts, at the path its manifest condition names (bin-only packages emit none)", () => {
    expect(result.packages.length).toBe(discoverPublishablePackages().length);
    for (const pkg of result.packages) {
      const source = discoverPublishablePackages().find((p) => p.name === pkg.name)!;
      if (isBinOnly(source)) {
        expect([pkg.name, pkg.entries]).toEqual([pkg.name, []]); // bin-only: nothing was built, by design
        continue;
      }
      expect([pkg.name, pkg.entries.length > 0]).toEqual([pkg.name, true]);
      for (const entry of pkg.entries) {
        expect([pkg.name, entry.js, existsSync(join(pkg.dir, entry.js))]).toEqual([pkg.name, entry.js, true]);
        expect([pkg.name, entry.types, existsSync(join(pkg.dir, entry.types))]).toEqual([pkg.name, entry.types, true]);
      }
    }
  });

  test("no emitted file -- .js or .d.ts -- carries a relative `.ts` specifier", () => {
    // THE WHOLE DEFECT, restated as a property of the output. One `.ts` specifier anywhere in the
    // emit is a module a Node consumer cannot load (or a type a consumer's tsc cannot resolve).
    const offenders: string[] = [];
    for (const pkg of result.packages) {
      for (const relative of walk(join(pkg.dir, "dist"))) {
        if (!relative.endsWith(".js") && !relative.endsWith(".d.ts")) continue;
        const text = readFileSync(join(pkg.dir, "dist", relative), "utf8");
        if (/(?:\bfrom\s*|\bimport\s*\(\s*)(["'])\.[^"']*\.ts\1/.test(text)) offenders.push(`${pkg.name}: dist/${relative}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the emitted JS keeps WORKSPACE PEERS external and INLINES relative data", () => {
    // `--packages=external` is what makes one file per entry a complete module: a bare specifier is
    // the consumer's own node_modules resolving a real dependency, while the catalog's
    // `generated/*.json` is bundled in (it is a relative import, and a tarball that shipped a
    // dangling relative JSON reference would fail only at first use).
    // READ ACROSS THE WHOLE `dist` TREE, not just the entry file (P7a pre-publish item 2). Since
    // `--splitting`, an entry is often a thin re-export and the bundled body lives in a shared chunk
    // beside it -- so an assertion pinned to `dist/index.js` measures the wrong file.
    const allJs = (dir: string): string =>
      walk(join(dir, "dist"))
        .filter((f) => f.endsWith(".js"))
        .map((f) => readFileSync(join(dir, "dist", f), "utf8"))
        .join("\n");

    const runtime = result.packages.find((p) => p.name === "@yanlinglabs/winter-provider-runtime")!;
    const js = allJs(runtime.dir);
    expect(js).toContain("@yanlinglabs/winter-provider-catalog");
    expect(js).toMatch(/from\s*["']node:/);

    const catalog = result.packages.find((p) => p.name === "@yanlinglabs/winter-provider-catalog")!;
    const catalogJs = allJs(catalog.dir);
    // No relative IMPORT of the JSON is left (asserted on the specifier, not on the string: the
    // inlined catalog data itself mentions the filename in its own provenance citations). Chunk
    // imports ARE relative and ARE `.js`, which is why the pattern is anchored on `.json`.
    expect(/(?:\bfrom\s*|\bimport\s*\(\s*)(["'])\.[^"']*\.json\1/.test(catalogJs)).toBe(false);
    // ...and the data really is in the bundle, not merely absent.
    expect(catalogJs).toContain("ollama-local");
    expect(catalogJs.length).toBeGreaterThan(500_000);
  });

  test("nothing lands in any package's `src/` -- a rootDir break emits beside the source, silently", () => {
    // MEASURED while writing this: a tsc run that fails `rootDir` containment still EMITS before it
    // reports, and it emits NEXT TO THE SOURCE rather than into `outDir` -- 196 untracked `.d.ts`
    // files appeared under `packages/runtime/src` that way, easy to commit by accident. `buildPackages`
    // throws on it now; this asserts the tree is clean after a successful run, including the private
    // runtime package, which is where they actually landed.
    // Asked of GIT, not of the filesystem: this repo legitimately keeps a few hand-authored ambient
    // declarations beside its sources (`context/presets/text-modules.d.ts`, so `tsc` understands
    // Bun's text-import attribute), and those are TRACKED. Only an UNTRACKED `.d.ts` outside `dist`
    // is build pollution.
    const proc = Bun.spawnSync(["git", "status", "--porcelain", "--", "packages"], { cwd: REPO_ROOT, stdout: "pipe" });
    const untracked = new TextDecoder()
      .decode(proc.stdout)
      .split("\n")
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.slice(3).trim())
      .filter((path) => path.endsWith(".d.ts") && !path.includes("/dist/"));
    expect(untracked).toEqual([]);
  });

  test("item 2: every package emits SHARED CHUNKS, and each entry keeps its own mirrored path", () => {
    // The structural half of the `instanceof` fix, at the artifact. One `bun build --splitting` per
    // package (all entries in one invocation) hoists a module reached by more than one entry into a
    // chunk both import, so it is evaluated ONCE -- which is what makes a class one object across
    // subpaths under Node. Per-entry `--outfile` builds inlined a copy into each.
    for (const pkg of result.packages) {
      const files = walk(join(pkg.dir, "dist")).filter((f) => f.endsWith(".js"));
      for (const entry of pkg.entries) expect([pkg.name, entry.js, files]).toEqual([pkg.name, entry.js, expect.arrayContaining([entry.js.replace(/^dist\//, "")])]);
      // A single-entry package has nothing to share, so chunks are expected only where 2+ entries exist.
      if (pkg.entries.length > 1) {
        const chunks = files.filter((f) => /-[a-z0-9]{8,}\.js$/.test(f));
        expect([pkg.name, chunks.length > 0]).toEqual([pkg.name, true]);
      }
    }
  });

  test("the dist tree MIRRORS src, so two entries both named index.ts cannot collide", () => {
    // `conformance` has `./` and `./official`, both `index.ts`. A flat `--outdir` would have written
    // one over the other, silently, and the smoke would import whichever won.
    const conformance = result.packages.find((p) => p.name === "@yanlinglabs/winter-conformance")!;
    const byPath = conformance.entries.map((e) => e.js).sort();
    expect(byPath).toEqual(["dist/index.js", "dist/official/index.js", "dist/trace.js"]);
    expect(new Set(byPath).size).toBe(byPath.length);
  });

  test("a Node process can import the built entry directly -- the `default` condition, proven off the tarball path", async () => {
    // The cheapest possible statement of the fix, independent of pack/install: point Node at the
    // emitted file itself. The installed-tarball smoke proves the same thing THROUGH the exports map;
    // this one fails first, and its failure names the file rather than the specifier.
    const catalog = result.packages.find((p) => p.name === "@yanlinglabs/winter-provider-catalog")!;
    const entry = join(catalog.dir, "dist/index.js");
    const code = `import(${JSON.stringify(entry)}).then((m) => { if (typeof m.loadCatalog !== "function") { console.error("no loadCatalog export"); process.exit(1); } }).catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });`;
    const proc = Bun.spawn(["node", "-e", code], { stdout: "pipe", stderr: "pipe" });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect([exitCode, stderr.trim()]).toEqual([0, ""]);
  }, 30_000);

  test("...and Bun resolves the `bun` condition, i.e. the SOURCE, for the same specifier", async () => {
    // The other half of the contract, and the reason nothing in this repo changed behaviour: Bun --
    // this repo's tests, verify:workflow, the compiled binary -- must still get `src/*.ts`.
    const code = `const m = await import("@yanlinglabs/winter-provider-catalog"); const url = import.meta.resolve("@yanlinglabs/winter-provider-catalog"); if (!url.endsWith("/src/index.ts")) { console.error("resolved to " + url); process.exit(1); } if (typeof m.loadCatalog !== "function") { console.error("no loadCatalog"); process.exit(1); }`;
    const proc = Bun.spawn(["bun", "-e", code], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect([exitCode, stderr.trim()]).toEqual([0, ""]);
  }, 30_000);
});

/** Every file under `dir`, recursively, as "/"-separated paths relative to it. */
function walk(dir: string): string[] {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const out: string[] = [];
  const visit = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(join(current, entry.name), `${prefix}${entry.name}/`);
      else if (entry.isFile()) out.push(`${prefix}${entry.name}`);
    }
  };
  if (!existsSync(dir)) return out;
  visit(dir, "");
  return out;
}
