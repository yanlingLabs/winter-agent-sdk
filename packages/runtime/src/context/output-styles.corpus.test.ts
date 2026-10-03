// A recorded corpus for output-style frontmatter handling: 1500 generated style files (no, empty or
// populated frontmatter; LF and CRLF; `name:` / `description:` / `keep-coding-instructions:` with
// booleans, the yes/no/on/off/1/0 words in any case, numbers, null, lists, maps, quoted and padded
// strings; bodies with headings, blank lines, long lines with an emoji near the 100-character cut and
// reminder tags), each placed as a plugin style directory, a bare plugin style file or a project-tier
// style, with the resolved style recorded for the file stem and for its declared name (`null` = no
// style). The files are written to a temp directory at test time, so the corpus is machine-independent.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOutputStyle } from "./output-styles.ts";
import corpus from "./__corpus__/output-styles.json";

interface Row { mode: "plugin-dir" | "plugin-file" | "project"; pluginName: string; stem: string; content: string; queries: string[]; trusted: boolean; expected: unknown[] }

const root = mkdtempSync(join(tmpdir(), "winter-style-corpus-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function resolveRow(c: Row, dir: string): unknown[] {
  if (c.mode === "project") {
    mkdirSync(join(dir, ".winter", "output-styles"), { recursive: true });
    writeFileSync(join(dir, ".winter", "output-styles", `${c.stem}.md`), c.content);
    return c.queries.map((q) => resolveOutputStyle(q, { cwd: dir, home: join(dir, "no-home"), trustedWorkspace: c.trusted }) ?? null);
  }
  const styles = join(dir, "styles");
  mkdirSync(styles, { recursive: true });
  const file = join(styles, `${c.stem}.md`);
  writeFileSync(file, c.content);
  const source = c.mode === "plugin-dir" ? { name: c.pluginName, outputStylesPath: styles } : { name: c.pluginName, outputStylesPaths: [file] };
  return c.queries.map((q) => resolveOutputStyle(`${c.pluginName}:${q}`, { cwd: join(dir, "no-cwd"), home: join(dir, "no-home"), pluginOutputStyles: [source] }) ?? null);
}

test("the recorded style files resolve exactly as recorded", () => {
  const rows = corpus as unknown as Row[];
  expect(rows.length).toBe(1500);
  const mismatches = rows.filter((row, i) => JSON.stringify(resolveRow(row, join(root, String(i)))) !== JSON.stringify(row.expected));
  expect(mismatches).toEqual([]);
});
