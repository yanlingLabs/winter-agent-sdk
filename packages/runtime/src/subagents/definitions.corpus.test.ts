// A recorded input -> output corpus for `parseFrontmatter`: 18 named shapes, then 2000 generated
// markdown files -- BOMs, CRLF, `----`/`--- x`/`---name` openers, closers mid-line or missing, tab
// indentation, loose values the first YAML pass rejects, inline lists, quotes, comments, typed scalars
// and raw random text -- with the attrs and body the parser gave when the corpus was recorded.
//
// Encoding: an object is `{"$obj": {...}}` (so a `__proto__` key survives as data), `undefined` is
// `{"$undefined": true}`, non-finite numbers and -0 are `{"$num": "NaN" | "Infinity" | "-Infinity" | "-0"}`.
// The answers depend on Bun's YAML parser; recorded under Bun 1.3.14.
import { expect, test } from "bun:test";
import { parseFrontmatter } from "./definitions.ts";
import corpus from "./__corpus__/frontmatter.json";

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

test("the recorded corpus parses exactly as recorded", () => {
  const rows = corpus as Array<{ raw: string; attrs: unknown; body: string }>;
  expect(rows.length).toBe(2018);
  const mismatches = rows.filter((row) => {
    const got = parseFrontmatter(row.raw);
    return got.body !== row.body || !Bun.deepEquals(got.attrs, decode(row.attrs), true);
  });
  expect(mismatches).toEqual([]);
});
