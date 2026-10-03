// A recorded input -> output corpus for `claudeModelTakesFullPrompt`: 2000 distinct generated model
// keys -- provider prefixes (none, one, several slashes), letter case, the Opus 4 line with every
// minor separator/width and date spelling, the substring families, and random token soup -- with the
// answer the function gave when the corpus was recorded.
import { expect, test } from "bun:test";
import { claudeModelTakesFullPrompt } from "./lean-prompt.ts";
import corpus from "./__corpus__/lean-prompt.json";

test("the recorded corpus answers exactly as recorded", () => {
  const rows = corpus as Array<{ key: string; expected: boolean }>;
  expect(rows.length).toBe(2000);
  const mismatches = rows.filter((row) => claudeModelTakesFullPrompt(row.key) !== row.expected);
  expect(mismatches).toEqual([]);
});
