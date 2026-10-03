// A recorded input -> output corpus for `parseFrontmatter`: 18 named shapes, then 2000 generated
// markdown files -- BOMs, CRLF, `----`/`--- x`/`---name` openers, closers mid-line or missing, tab
// indentation, loose values the first YAML pass rejects, inline lists, quotes, comments, typed scalars
// and raw random text -- with the attrs and body the parser gave when the corpus was recorded.
//
// Encoding: an object is `{"$obj": {...}}` (so a `__proto__` key survives as data), `undefined` is
// `{"$undefined": true}`, non-finite numbers and -0 are `{"$num": "NaN" | "Infinity" | "-Infinity" | "-0"}`.
// The answers depend on Bun's YAML parser; recorded under Bun 1.3.14. A Bun whose parser answers some
// rows differently has an overlay, `__corpus__/frontmatter.bun-<version>.json` (`[{index, attrs, body}]`),
// recorded from the implementation that preceded the clean-room rewrite (v0.0.41) under that Bun by
// scripts/record-frontmatter-bun-overlay.ts -- never from the current implementation.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./definitions.ts";
import corpus from "./__corpus__/frontmatter.json";

const RECORDED_UNDER_BUN = "1.3.14";

function decode(v: unknown): unknown {
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
}

type Row = { raw: string; attrs: unknown; body: string };

/** The recorded rows for the running Bun: the base corpus, with that Bun's overlay applied if it is not the base Bun. */
function rowsForThisBun(): Row[] {
  const rows = (corpus as Row[]).map((row) => ({ ...row }));
  if (Bun.version === RECORDED_UNDER_BUN) return rows;
  const overlayPath = join(import.meta.dir, "__corpus__", `frontmatter.bun-${Bun.version}.json`);
  if (!existsSync(overlayPath)) {
    throw new Error(
      `no frontmatter answers are recorded for Bun ${Bun.version} (Bun's YAML parser decides them): record them from v0.0.41 ` +
        `with scripts/record-frontmatter-bun-overlay.ts under this Bun, or run the tests under Bun ${RECORDED_UNDER_BUN}`,
    );
  }
  const overlay = JSON.parse(readFileSync(overlayPath, "utf8")) as Array<{ index: number; attrs: unknown; body: string }>;
  for (const { index, attrs, body } of overlay) rows[index] = { raw: rows[index]!.raw, attrs, body };
  return rows;
}

test("the recorded corpus parses exactly as recorded", () => {
  const rows = rowsForThisBun();
  expect(rows.length).toBe(2018);
  const mismatches = rows.filter((row) => {
    const got = parseFrontmatter(row.raw);
    return got.body !== row.body || !Bun.deepEquals(got.attrs, decode(row.attrs), true);
  });
  expect(mismatches).toEqual([]);
});
