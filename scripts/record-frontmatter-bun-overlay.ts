// Records, for the running Bun, the rows of the `parseFrontmatter` corpus whose answer differs from the
// one recorded under Bun 1.3.14 (`packages/runtime/src/subagents/__corpus__/frontmatter.json`).
//
// Those answers come from Bun's built-in YAML parser, so each Bun release may answer some rows
// differently. The answers are ALWAYS recorded from the implementation that preceded the clean-room
// rewrite (v0.0.41), never from the current one, so the corpus keeps proving that the rewrite changed
// nothing on that Bun.
//
// Usage (run with the Bun to record for):
//   git archive v0.0.41 | tar -x -C <dir>          # plus node_modules linked into <dir> and <dir>/packages/runtime
//   bun scripts/record-frontmatter-bun-overlay.ts <dir>
// Under Bun 1.3.14 it only checks that v0.0.41 reproduces the base corpus row for row (the proof that
// the baseline checkout and this recorder are faithful); under any other Bun it writes
// `frontmatter.bun-<version>.json` beside the base corpus -- `[{ index, attrs, body }]`, in the base
// corpus' encoding -- holding exactly the rows v0.0.41 answers differently there.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE_BUN = "1.3.14";
const baseline = process.argv[2];
if (baseline === undefined) throw new Error("usage: record-frontmatter-bun-overlay.ts <v0.0.41 checkout root>");
const corpusDir = join(import.meta.dir, "..", "packages", "runtime", "src", "subagents", "__corpus__");
const rows = JSON.parse(readFileSync(join(corpusDir, "frontmatter.json"), "utf8")) as Array<{ raw: string; attrs: unknown; body: string }>;
const old = (await import(join(baseline, "packages", "runtime", "src", "subagents", "definitions.ts"))) as {
  parseFrontmatter(raw: string): { attrs: Record<string, unknown>; body: string };
};

/** The base corpus' encoding: `$obj` objects (a `__proto__` key survives), `$undefined`, `$num` for non-finite and -0, `$date`. */
function encode(v: unknown): unknown {
  if (v === undefined) return { $undefined: true };
  if (typeof v === "number") {
    if (Number.isNaN(v)) return { $num: "NaN" };
    if (v === Infinity) return { $num: "Infinity" };
    if (v === -Infinity) return { $num: "-Infinity" };
    if (Object.is(v, -0)) return { $num: "-0" };
    return v;
  }
  if (v instanceof Date) return { $date: v.toISOString() };
  if (Array.isArray(v)) return v.map(encode);
  if (v !== null && typeof v === "object") return { $obj: Object.fromEntries(Object.keys(v).map((key) => [key, encode((v as Record<string, unknown>)[key])])) };
  return v;
}

const overlay: Array<{ index: number; attrs: unknown; body: string }> = [];
rows.forEach((row, index) => {
  const got = old.parseFrontmatter(row.raw);
  const attrs = encode(got.attrs);
  if (JSON.stringify(attrs) !== JSON.stringify(row.attrs) || got.body !== row.body) overlay.push({ index, attrs, body: got.body });
});

if (Bun.version === BASE_BUN) {
  if (overlay.length > 0) throw new Error(`v0.0.41 does not reproduce ${overlay.length} base rows under Bun ${BASE_BUN}: the baseline checkout is not v0.0.41`);
  console.log(`Bun ${BASE_BUN}: v0.0.41 reproduces all ${rows.length} base rows; nothing to record`);
} else {
  const out = join(corpusDir, `frontmatter.bun-${Bun.version}.json`);
  writeFileSync(out, "[" + overlay.map((r) => JSON.stringify(r)).join(",\n") + "]\n");
  console.log(`Bun ${Bun.version}: ${overlay.length} of ${rows.length} rows answer differently from Bun ${BASE_BUN}; wrote ${out}`);
}
