// A recorded input -> output corpus for `buildSeatbeltProfile`: 600 generated configurations (cwd,
// write roots, plain/glob/regex denies on both sides, glob read-deny entries with matched, unrelated
// and `/` prefixes, nested write roots, homes, brands, allowGitConfigWrites, network, the per-user temp
// dir), each with the exact profile text it rendered when the corpus was recorded -- or the name of
// the error it threw. Every path lives under `/cr` or `/zz` (which do not exist) or is `/`, so the
// rendering does not depend on the machine.
//
// File format: `lines` is a dictionary of distinct profile lines; a row's profile is the lines named by
// its `runs` ([start, count] pairs, flattened) joined with "\n".
import { expect, test } from "bun:test";
import { buildSeatbeltProfile, type SeatbeltProfileInput } from "./profile.ts";
import corpus from "./__corpus__/seatbelt-profile.json";

type Row = { input: SeatbeltProfileInput; runs: number[] } | { input: SeatbeltProfileInput; error: string };

function expectedText(runs: readonly number[], lines: readonly string[]): string {
  const out: string[] = [];
  for (let i = 0; i < runs.length; i += 2) for (let k = 0; k < runs[i + 1]!; k++) out.push(lines[runs[i]! + k]!);
  return out.join("\n");
}

test("the recorded corpus renders exactly as recorded", () => {
  const { lines, rows } = corpus as unknown as { lines: string[]; rows: Row[] };
  expect(rows.length).toBe(600);
  const mismatches: string[] = [];
  for (const [i, row] of rows.entries()) {
    let actual: string;
    try {
      actual = buildSeatbeltProfile(row.input);
    } catch (err) {
      if ("error" in row && (err as Error).name === row.error) continue;
      mismatches.push(`row ${i}: threw ${(err as Error).name}: ${(err as Error).message}\ninput: ${JSON.stringify(row.input)}`);
      continue;
    }
    if ("error" in row) {
      mismatches.push(`row ${i}: expected ${row.error}, rendered a profile\ninput: ${JSON.stringify(row.input)}`);
      continue;
    }
    const expected = expectedText(row.runs, lines);
    if (actual === expected) continue;
    const a = actual.split("\n");
    const e = expected.split("\n");
    let at = 0;
    while (at < a.length && at < e.length && a[at] === e[at]) at++;
    mismatches.push(`row ${i}: first difference at line ${at + 1}\n  expected: ${JSON.stringify(e[at])}\n  actual:   ${JSON.stringify(a[at])}\ninput: ${JSON.stringify(row.input)}`);
  }
  expect(mismatches.slice(0, 5)).toEqual([]);
});
