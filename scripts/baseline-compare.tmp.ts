// TEMPORARY (removed once it has run green on Linux CI): runs the v0.0.41 implementation and the
// current one side by side, on THIS machine, over the inputs of the four corpora whose recorded
// answers depend on the platform or the environment, and requires identical answers. It also lists,
// for diagnosis, every row where the current implementation differs from the macOS recording.
//
// Usage: bun scripts/baseline-compare.tmp.ts <v0.0.41 checkout root>   (node_modules linked into it)
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const baseline = process.argv[2];
if (baseline === undefined) throw new Error("usage: baseline-compare.tmp.ts <v0.0.41 root>");
const NEW = join(import.meta.dir, "..", "packages", "runtime", "src");
const OLD = join(baseline, "packages", "runtime", "src");

type AnyModule = Record<string, any>;
const load = async (root: string, rel: string): Promise<AnyModule> => (await import(join(root, rel))) as AnyModule;
const json = (rel: string): any => JSON.parse(readFileSync(join(NEW, rel), "utf8"));

let failures = 0;
function report(label: string, oldVsNew: unknown[], vsRecorded: unknown[], total: number): void {
  console.log(`${label}: rows=${total} old!=new=${oldVsNew.length} new!=recorded=${vsRecorded.length}`);
  for (const item of oldVsNew.slice(0, 20)) console.log(`  OLD!=NEW ${JSON.stringify(item)}`);
  for (const item of vsRecorded) console.log(`  vs-recorded ${JSON.stringify(item)}`);
  if (oldVsNew.length > 0) failures++;
}

console.log(`bun ${Bun.version} on ${process.platform}, home ${homedir()}`);

// 1. The permission rule corpus (rule grammar, file rules, path predicates, fs fixture).
{
  const support = await load(NEW, "permissions/rule-corpus.test-support.ts");
  const mods = async (root: string): Promise<unknown> => ({
    grammar: await load(root, "permissions/grammar.ts"),
    fileRules: await load(root, "permissions/file-rules.ts"),
    paths: await load(root, "permissions/paths.ts"),
    evaluator: await load(root, "permissions/evaluator.ts"),
  });
  const recorded = json("permissions/__fixtures__/rule-corpus.json");
  const oldC = support.computeCorpus(await mods(OLD), recorded.inputs);
  const newC = support.computeCorpus(await mods(NEW), recorded.inputs);
  const canon = support.canon as (v: unknown) => string;
  const oldVsNew: unknown[] = [];
  const vsRec: unknown[] = [];
  for (const part of ["full", "fs"] as const) {
    for (const key of Object.keys(recorded[part])) {
      if (canon(oldC[part][key]) !== canon(newC[part][key])) oldVsNew.push({ part, key });
      if (canon(newC[part][key]) !== canon(recorded[part][key])) vsRec.push({ part, key, now: newC[part][key], was: recorded[part][key] });
    }
  }
  for (const section of Object.keys(recorded.random)) {
    const o = oldC.random[section] as string[];
    const n = newC.random[section] as string[];
    const r = recorded.random[section] as string[];
    n.forEach((d, i) => {
      if (o[i] !== d) oldVsNew.push({ section, i });
      if (r[i] !== d) vsRec.push({ section, i });
    });
  }
  for (const section of Object.keys(recorded.exhaustive)) {
    if (canon(oldC.exhaustive[section]) !== canon(newC.exhaustive[section])) oldVsNew.push({ exhaustive: section });
    if (canon(recorded.exhaustive[section]) !== canon(newC.exhaustive[section])) vsRec.push({ exhaustive: section });
  }
  report("rule corpus", oldVsNew, vsRec, Object.keys(recorded.full).length + Object.keys(recorded.fs).length);
  const oldFr = await load(OLD, "permissions/file-rules.ts");
  const newFr = await load(NEW, "permissions/file-rules.ts");
  for (const p of ["/private/tmp/x", "/private/var/x", "/private/etc/hosts", "/usr/bin/env", "/usr/lib/x", "/usr/sbin/x", "/tmp/x", "/bin/x"]) {
    const a = oldFr.canonicalizeTrustedSymlinkPath(p);
    const b = newFr.canonicalizeTrustedSymlinkPath(p);
    console.log(`  trustedAlias ${p} old=${a} new=${b}`);
    if (a !== b) failures++;
  }
}

// 2. The plugin loader corpus.
{
  const fixture = await load(NEW, "plugins/loader.corpus-fixture.ts");
  const oldLoad = (await load(OLD, "plugins/loader.ts")).loadPlugins;
  const newLoad = (await load(NEW, "plugins/loader.ts")).loadPlugins;
  const rows = json("plugins/__corpus__/plugin-loader-manifest.json") as Array<{ layout: unknown; expected: unknown }>;
  const oldVsNew: unknown[] = [];
  const vsRec: unknown[] = [];
  rows.forEach((row, i) => {
    const a = JSON.stringify(fixture.runLayout(row.layout, oldLoad));
    const b = JSON.stringify(fixture.runLayout(row.layout, newLoad));
    if (a !== b) oldVsNew.push({ i });
    if (b !== JSON.stringify(row.expected)) vsRec.push({ i, layout: row.layout });
  });
  report("plugin loader", oldVsNew, vsRec, rows.length);
}

// 3. The frontmatter corpus.
{
  const oldParse = (await load(OLD, "subagents/definitions.ts")).parseFrontmatter;
  const newParse = (await load(NEW, "subagents/definitions.ts")).parseFrontmatter;
  const rows = json("subagents/__corpus__/frontmatter.json") as Array<{ raw: string; attrs: unknown; body: string }>;
  const decode = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(decode);
    if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o["$undefined"] === true) return undefined;
      if (typeof o["$num"] === "string") return o["$num"] === "-0" ? -0 : Number(o["$num"]);
      if (typeof o["$date"] === "string") return new Date(o["$date"]);
      const inner = o["$obj"] as Record<string, unknown>;
      return Object.fromEntries(Object.keys(inner).map((key) => [key, decode(inner[key])]));
    }
    return v;
  };
  const oldVsNew: unknown[] = [];
  const vsRec: unknown[] = [];
  rows.forEach((row, i) => {
    const a = oldParse(row.raw);
    const b = newParse(row.raw);
    if (a.body !== b.body || !Bun.deepEquals(a.attrs, b.attrs, true)) oldVsNew.push({ i });
    if (b.body !== row.body || !Bun.deepEquals(b.attrs, decode(row.attrs), true)) vsRec.push({ i });
  });
  report("frontmatter", oldVsNew, vsRec, rows.length);
}

// 4. The @import token corpus.
{
  const oldExpand = (await load(OLD, "context/imports.ts")).expandImports;
  const newExpand = (await load(NEW, "context/imports.ts")).expandImports;
  const rows = json("context/__corpus__/import-tokens.json") as Array<{ content: string; expected: unknown }>;
  const input = (content: string) => ({ content, filePath: "/cleanroom-imports-corpus/dir/NOTES.md", tier: "project", projectRoot: "/cleanroom-imports-corpus/elsewhere-root" });
  const home = homedir();
  const oldVsNew: unknown[] = [];
  const vsRec: unknown[] = [];
  rows.forEach((row, i) => {
    const a = oldExpand(input(row.content));
    const b = newExpand(input(row.content));
    if (JSON.stringify(a) !== JSON.stringify(b)) oldVsNew.push({ i });
    const hp = dirname(home);
    const ph = (p: string): string => (p === home || p.startsWith(`${home}/`) ? `~HOME~${p.slice(home.length)}` : p === hp || p.startsWith(`${hp}/`) ? `~HOME~/..${p.slice(hp.length)}` : p);
    const got = { content: b.content, dropped: (b.dropped as string[]).map(ph) };
    if (JSON.stringify(got) !== JSON.stringify(row.expected)) vsRec.push({ i, got: got.dropped, homeParent: dirname(home) });
  });
  report("imports", oldVsNew, vsRec, rows.length);
}

console.log(failures === 0 ? "BASELINE COMPARE: old == new everywhere" : `BASELINE COMPARE: ${failures} section(s) differ`);
process.exit(failures === 0 ? 0 : 1);
