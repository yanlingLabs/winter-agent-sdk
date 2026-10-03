// A recorded input -> output corpus for `recoverParallelToolResults`: 1000 generated transcript node
// pools (simulated parallel tool batches with results in shuffled completion order, missing,
// duplicated, multi-id and misparented results, API-error entries, attachments, plus fully random
// pools) with the chain a parent walk from the last node yields -- sometimes cut to a suffix -- and
// the uuid order the function returned when the corpus was recorded.
// Row: {pool: [uuid, parentUuid, type, toolUseIds, toolResultIds, apiError 0|1][], chain, expected}.
import { expect, test } from "bun:test";
import { recoverParallelToolResults, type Node } from "./switch-review.ts";
import corpus from "./__corpus__/parallel-recovery.json";

type Row = { pool: Array<[string, string | null, string, string[], string[], number]>; chain: string[]; expected: string[] };

function node([uuid, parentUuid, type, toolUseIds, toolResultIds, apiError]: Row["pool"][number]): Node {
  return { uuid, parentUuid, type, ...(type === "user" || type === "assistant" ? { role: type } : {}), toolUseIds, toolResultIds, apiError: apiError === 1 };
}

test("the recorded corpus recovers exactly as recorded", () => {
  const rows = corpus as unknown as Row[];
  expect(rows.length).toBe(1000);
  const mismatches = rows.filter((row) => {
    const pool = row.pool.map(node);
    const byUuid = new Map(pool.map((n) => [n.uuid, n] as const));
    const chain = row.chain.map((u) => byUuid.get(u)!);
    return recoverParallelToolResults(chain, pool).map((n) => n.uuid).join("\n") !== row.expected.join("\n");
  });
  expect(mismatches).toEqual([]);
});
