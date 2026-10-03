// A recorded input -> output corpus for `substituteArguments`: 3000 generated (body, args, namedArgs)
// triples -- `$ARGUMENTS`, `$ARGUMENTS[n]` (in and out of range, leading zeros, non-numeric), `$n`
// (multi-digit, word-character neighbours), named arguments (regex metacharacters, `$`, `\`, empty and
// duplicate names, names shadowing `ARGUMENTS` and digits), backslash escapes, `$&`/`$$`-style
// replacement patterns, shell quoting in the args, U+FFFD/U+FFFE/U+FFFF and the empty / whitespace-only
// args cases -- with the text the substituter produced when the corpus was recorded.
import { expect, test } from "bun:test";
import { substituteArguments } from "./resolver.ts";
import corpus from "./__corpus__/substitute-arguments.json";

test("the recorded corpus substitutes exactly as recorded", () => {
  const rows = corpus as Array<{ body: string; args: string; named: string[]; expected: string }>;
  expect(rows.length).toBe(3000);
  const mismatches = rows.filter((row) => substituteArguments(row.body, row.args, row.named) !== row.expected);
  expect(mismatches).toEqual([]);
});
