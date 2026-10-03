// A recorded input -> output corpus for `loadPlugins`' handling of a manifest's custom component
// paths (`skills`/`commands`/`agents`/`outputStyles`/`workflows`), its `hooks` entries and the
// folder-shadowed notice: 500 generated plugin layouts -- default directories present, absent or
// files; custom directories; in-root, out-of-root and dangling symlinks; hook files of every shape;
// manifest values that are strings, arrays, objects, inline command maps and junk -- each with the
// result the loader gave when the corpus was recorded. Layouts are materialised by
// loader.corpus-fixture.ts, and `<tmp>` stands for the temp dir in every recorded path.
import { expect, test } from "bun:test";
import { runLayout, type PluginLayout } from "./loader.corpus-fixture.ts";
import corpus from "./__corpus__/plugin-loader-manifest.json";

test("the recorded corpus loads exactly as recorded", () => {
  const rows = corpus as Array<{ layout: PluginLayout; expected: unknown }>;
  expect(rows.length).toBe(500);
  const mismatches = rows.flatMap((row, i) => {
    const actual = runLayout(row.layout);
    return JSON.stringify(actual) === JSON.stringify(row.expected) ? [] : [{ i, expected: row.expected, actual }];
  });
  expect(mismatches.slice(0, 3)).toEqual([]);
  expect(mismatches.length).toBe(0);
});
