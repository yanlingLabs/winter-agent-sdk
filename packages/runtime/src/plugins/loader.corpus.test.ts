// A recorded input -> output corpus for `loadPlugins`' handling of a manifest's custom component
// paths (`skills`/`commands`/`agents`/`outputStyles`/`workflows`), its `hooks` entries and the
// folder-shadowed notice: 500 generated plugin layouts -- default directories present, absent or
// files; custom directories; in-root, out-of-root and dangling symlinks; hook files of every shape;
// manifest values that are strings, arrays, objects, inline command maps and junk -- each with the
// result the loader gave when the corpus was recorded. Layouts are materialised by
// loader.corpus-fixture.ts, and `<tmp>` stands for the temp dir in every recorded path.
//
// The corpus was recorded on macOS, whose default volume folds case: a layout holding `Skill.MD`
// where the loader looks for `SKILL.md` loads that file there and not on a case-sensitive volume. Off
// macOS those layouts (`dependsOnCaseFolding`) are skipped; every other row is asserted everywhere,
// and on macOS every row is.
import { expect, test } from "bun:test";
import { dependsOnCaseFolding, runLayout, type PluginLayout } from "./loader.corpus-fixture.ts";
import corpus from "./__corpus__/plugin-loader-manifest.json";

const CASE_FOLDING_VOLUME = process.platform === "darwin";

test("the recorded corpus loads exactly as recorded", () => {
  const rows = corpus as Array<{ layout: PluginLayout; expected: unknown }>;
  expect(rows.length).toBe(500);
  const skipped = CASE_FOLDING_VOLUME ? [] : rows.flatMap((row, i) => (dependsOnCaseFolding(row.layout) ? [i] : []));
  if (skipped.length > 0) console.log(`plugin loader corpus: ${skipped.length} of ${rows.length} layouts depend on a case-folding volume and are not asserted on ${process.platform}`);
  const mismatches = rows.flatMap((row, i) => {
    if (skipped.includes(i)) return [];
    const actual = runLayout(row.layout);
    return JSON.stringify(actual) === JSON.stringify(row.expected) ? [] : [{ i, expected: row.expected, actual }];
  });
  expect(mismatches.slice(0, 3)).toEqual([]);
  expect(mismatches.length).toBe(0);
});
