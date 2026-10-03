// A recorded input -> output corpus for `transcriptProjectKey`: 2000 generated path-like strings --
// realistic absolute paths, lengths clustered around the 64-code-unit boundary, very long paths,
// punctuation, backslashes, unicode letters, astral characters, lone surrogates, control characters
// and the empty string -- with the key the function returned when the corpus was recorded.
import { expect, test } from "bun:test";
import { transcriptProjectKey } from "./project-key.ts";
import corpus from "./__corpus__/project-key.json";

test("the recorded corpus maps exactly as recorded", () => {
  const rows = corpus as Array<{ path: string; expected: string }>;
  expect(rows.length).toBe(2000);
  const mismatches = rows.filter((row) => transcriptProjectKey(row.path) !== row.expected);
  expect(mismatches).toEqual([]);
});
