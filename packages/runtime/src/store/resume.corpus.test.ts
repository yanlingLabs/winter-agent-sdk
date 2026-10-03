// A recorded input -> output corpus for `recoverParallelToolResults(chain, pool)`: 1700 generated
// transcripts in a compact form -- `entries` (`u` uuid, `p` parent uuid, `k` kind: `a` assistant whose
// `ids` are its tool_use ids or, without `ids`, a text reply, `e: 1` marking an API-error entry; `r` a
// user entry whose content is tool_result blocks answering `ids`, `m: 1` adding a leading text block;
// `t` a plain user text entry; `x` an entry of another type), `chain` (uuids, root first) and `pool`
// (uuids, file order) -- with the uuid order of the returned chain recorded at the time. The shapes
// cover runs of consecutive call entries, results on each call entry, off-chain sibling call entries
// and siblings of siblings, stray, duplicate and multi-id results, API-error and text-only entries.
import { expect, test } from "bun:test";
import { recoverParallelToolResults } from "./resume.ts";
import type { DialectEntry } from "./resume.ts";
import corpus from "./__corpus__/parallel-tool-results.json";

interface CEntry { u: string; p: string | null; k: "a" | "r" | "t" | "x"; ids?: string[]; e?: 1; m?: 1 }
interface Row { entries: CEntry[]; chain: string[]; pool: string[]; expected: string[] }

function expand(e: CEntry): DialectEntry {
  const base = { uuid: e.u, parentUuid: e.p };
  if (e.k === "a") {
    const content = e.ids ? e.ids.map((id) => ({ type: "tool_use", id, name: "t", input: {} })) : [{ type: "text", text: "reply" }];
    return { ...base, type: "assistant", ...(e.e ? { isApiErrorMessage: true } : {}), message: { role: "assistant", content } } as unknown as DialectEntry;
  }
  if (e.k === "r") {
    const content = [...(e.m ? [{ type: "text", text: "note" }] : []), ...(e.ids ?? []).map((id) => ({ type: "tool_result", tool_use_id: id, content: "out" }))];
    return { ...base, type: "user", message: { role: "user", content } } as unknown as DialectEntry;
  }
  if (e.k === "t") return { ...base, type: "user", message: { role: "user", content: "text" } } as unknown as DialectEntry;
  return { ...base, type: "attachment", attachment: { type: "other" } } as unknown as DialectEntry;
}

test("the recorded corpus recovers exactly as recorded", () => {
  const rows = corpus as Row[];
  expect(rows.length).toBe(1700);
  const mismatches = rows.filter((row) => {
    const byId = new Map(row.entries.map((e) => [e.u, expand(e)] as const));
    const out = recoverParallelToolResults(row.chain.map((u) => byId.get(u)!), row.pool.map((u) => byId.get(u)!));
    return out.map((e) => e.uuid).join(" ") !== row.expected.join(" ");
  });
  expect(mismatches).toEqual([]);
});
