// A recorded input -> output corpus for `renderInstructionsContext`: 2000 generated file lists (0-4
// files of every kind; empty, whitespace-only, CRLF and multi-line content; empty and unusual paths)
// with the `claudeMd` value it returned when the corpus was recorded (`null` = no value).
import { expect, test } from "bun:test";
import { renderInstructionsContext, type InstructionsContextFile } from "./winter-md.ts";
import corpus from "./__corpus__/instructions-context.json";

test("the recorded corpus renders exactly as recorded", () => {
  const rows = corpus as Array<{ files: InstructionsContextFile[]; expected: string | null }>;
  expect(rows.length).toBe(2000);
  const mismatches = rows.filter((row) => (renderInstructionsContext(row.files) ?? null) !== row.expected);
  expect(mismatches).toEqual([]);
});
