// A recorded corpus for the `@import` token grammar: 2500 generated contents mixing tokens of every
// shape (`./`, `~/`, absolute, `/` alone, bare names, leading punctuation, `@@`, escaped spaces, stray
// backslashes, `#fragments`, tokens resolving inside and outside the project root) with separators,
// fenced blocks and inline code spans. Each is expanded as a PROJECT-tier file whose project root
// does not exist, so every valid out-of-root token is reported in `dropped` and nothing is read from
// disk; the recorded `dropped` paths have the home directory replaced by `~HOME~`, and the home's
// parent directory (what `~/..` resolves to) by `~HOME~/..`, so the corpus holds on any machine whose
// home sits at the same depth (`/Users/<name>` when it was recorded on macOS, `/home/<name>` on Linux).
import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { expandImports } from "./imports.ts";
import corpus from "./__corpus__/import-tokens.json";

const FILE = "/cleanroom-imports-corpus/dir/WINTER.md";
const ROOT = "/cleanroom-imports-corpus/elsewhere-root";
const home = homedir();
const homeParent = dirname(home);

/** A dropped path with the machine's home, or else the home's parent, replaced by its placeholder. */
function placeholdered(p: string): string {
  if (p === home || p.startsWith(`${home}/`)) return `~HOME~${p.slice(home.length)}`;
  if (homeParent !== "/" && (p === homeParent || p.startsWith(`${homeParent}/`))) return `~HOME~/..${p.slice(homeParent.length)}`;
  return p;
}

test("the recorded contents expand exactly as recorded", () => {
  const rows = corpus as Array<{ content: string; expected: { content: string; dropped: string[] } }>;
  expect(rows.length).toBe(2500);
  const mismatches = rows.filter((row) => {
    const res = expandImports({ content: row.content, filePath: FILE, tier: "project", projectRoot: ROOT });
    const got = { content: res.content, dropped: res.dropped.map(placeholdered) };
    return JSON.stringify(got) !== JSON.stringify(row.expected);
  });
  expect(mismatches).toEqual([]);
});
