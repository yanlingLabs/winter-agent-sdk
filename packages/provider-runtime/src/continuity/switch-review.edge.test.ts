// Edge cases of `recoverParallelToolResults`: putting a parallel tool batch's side-branch entries back
// into a rebuilt lineage. A transcript writes each call of a parallel batch as its own `assistant`
// entry and parents each call's result on that call's entry, so the single parent chain from the leaf
// misses most of them. The function splices the missing call entries ("siblings") and results back in
// right after each run of consecutive chain `assistant` entries.
import { describe, expect, test } from "bun:test";
import { recoverParallelToolResults, type Node } from "./switch-review.ts";

const user = (uuid: string, parentUuid: string | null, ...results: string[]): Node => ({ uuid, parentUuid, type: "user", role: "user", toolUseIds: [], toolResultIds: results, apiError: false });
const asst = (uuid: string, parentUuid: string | null, ...calls: string[]): Node => ({ uuid, parentUuid, type: "assistant", role: "assistant", toolUseIds: calls, toolResultIds: [], apiError: false });
const other = (uuid: string, parentUuid: string | null, type = "attachment"): Node => ({ uuid, parentUuid, type, toolUseIds: [], toolResultIds: [], apiError: false });
const ids = (nodes: Node[]): string[] => nodes.map((n) => n.uuid);

describe("recoverParallelToolResults: nothing to recover", () => {
  test("a pool that is exactly the chain returns the chain unchanged", () => {
    const chain = [user("u0", null), asst("a1", "u0", "t1"), user("r1", "a1", "t1"), asst("a2", "r1")];
    expect(ids(recoverParallelToolResults(chain, chain))).toEqual(["u0", "a1", "r1", "a2"]);
  });

  test("an empty chain stays empty whatever the pool holds", () => {
    expect(recoverParallelToolResults([], [user("u0", null), asst("a1", "u0", "t1"), user("r1", "a1", "t1")])).toEqual([]);
  });

  test("off-chain nodes with a null parent are ignored", () => {
    const chain = [user("u0", null), asst("a1", "u0", "t1"), user("n", "a1")];
    const pool = [...chain, user("r1", null, "t1"), asst("s", null, "t2")];
    expect(ids(recoverParallelToolResults(chain, pool))).toEqual(["u0", "a1", "n"]);
  });
});

describe("recoverParallelToolResults: member results", () => {
  test("an off-chain result for an unanswered call of a run member is inserted after the run", () => {
    // Batch a1(t1) -> a2(t2); results each parented on their own call; the chain goes through r2.
    const chain = [user("u0", null), asst("a1", "u0", "t1"), asst("a2", "a1", "t2"), user("r2", "a2", "t2"), asst("done", "r2")];
    const pool = [chain[0]!, chain[1]!, chain[2]!, user("r1", "a1", "t1"), chain[3]!, chain[4]!];
    expect(ids(recoverParallelToolResults(chain, pool))).toEqual(["u0", "a1", "a2", "r1", "r2", "done"]);
  });

  test("a run that ENDS the chain gets nothing spliced after it", () => {
    const chain = [user("u0", null), asst("a1", "u0", "t1"), asst("a2", "a1", "t2")];
    const pool = [...chain, user("r1", "a1", "t1"), user("r2", "a2", "t2")];
    expect(ids(recoverParallelToolResults(chain, pool))).toEqual(["u0", "a1", "a2"]);
  });

  test("a result for a call already answered on the chain is never recovered", () => {
    const chain = [user("u0", null), asst("a1", "u0", "t1"), user("r1", "a1", "t1"), asst("a2", "r1")];
    const pool = [...chain, user("dup", "a1", "t1")];
    expect(ids(recoverParallelToolResults(chain, pool))).toEqual(["u0", "a1", "r1", "a2"]);
  });

  test("two off-chain results answering the same open call: only the first in pool order", () => {
    const chain = [user("u0", null), asst("a1", "u0", "t1", "t2"), user("r2", "a1", "t2"), asst("done", "r2")];
    const pool = [...chain, user("x1", "a1", "t1"), user("x2", "a1", "t1")];
    expect(ids(recoverParallelToolResults(chain, pool))).toEqual(["u0", "a1", "x1", "r2", "done"]);
  });

  test("a result answering an open call AND another id is taken whole, and its other id then counts as answered", () => {
    const chain = [user("u0", null), asst("a1", "u0", "t1"), asst("a2", "a1", "t2"), user("n", "a2"), asst("done", "n")];
    const pool = [...chain, user("both", "a1", "t1", "t2"), user("r2", "a2", "t2")];
    // `both` answers t1 (open on a1) and also t2, so r2 under a2 no longer answers anything open.
    expect(ids(recoverParallelToolResults(chain, pool))).toEqual(["u0", "a1", "a2", "both", "n", "done"]);
  });

  test("a result parented on a chain USER entry is not recovered (only run members and siblings are parents)", () => {
    const chain = [user("u0", null), asst("a1", "u0", "t1"), user("n", "a1"), asst("done", "n")];
    const pool = [...chain, user("r1", "n", "t1")];
    expect(ids(recoverParallelToolResults(chain, pool))).toEqual(["u0", "a1", "n", "done"]);
  });

  test("results under one member come back in pool order; members are visited in chain order", () => {
    const chain = [user("u0", null), asst("a1", "u0", "t1", "t3"), asst("a2", "a1", "t2"), user("n", "a2"), asst("done", "n")];
    const pool = [...chain, user("r2", "a2", "t2"), user("r3", "a1", "t3"), user("r1", "a1", "t1")];
    expect(ids(recoverParallelToolResults(chain, pool))).toEqual(["u0", "a1", "a2", "r3", "r1", "r2", "n", "done"]);
  });
});

describe("recoverParallelToolResults: siblings", () => {
  test("an off-chain call entry hanging off a run member comes back BEFORE the member results, its own results after them", () => {
    // a1(t1) -> s2(t2) -> s3(t3) written as a chain of call entries; the next turn chained through r1.
    const chain = [user("u0", null), asst("a1", "u0", "t1"), user("r1", "a1", "t1"), asst("done", "r1")];
    const pool = [chain[0]!, chain[1]!, asst("s2", "a1", "t2"), asst("s3", "s2", "t3"), chain[2]!, user("r2", "s2", "t2"), user("r3", "s3", "t3"), chain[3]!];
    expect(ids(recoverParallelToolResults(chain, pool))).toEqual(["u0", "a1", "s2", "s3", "r2", "r3", "r1", "done"]);
  });

  test("the insert point is after the run's LAST member; member results precede sibling results", () => {
    const chain = [user("u0", null), asst("a1", "u0", "t1"), asst("a2", "a1", "t2"), user("n", "a2"), asst("done", "n")];
    const pool = [...chain, asst("s3", "a2", "t3"), user("r3", "s3", "t3"), user("r1", "a1", "t1"), user("r2", "a2", "t2")];
    expect(ids(recoverParallelToolResults(chain, pool))).toEqual(["u0", "a1", "a2", "s3", "r1", "r2", "r3", "n", "done"]);
  });

  test("a sibling with a call no result answers is left out -- but entries hanging off it are still reachable", () => {
    const chain = [user("u0", null), asst("a1", "u0", "t1"), user("r1", "a1", "t1"), asst("done", "r1")];
    const pool = [...chain, asst("s2", "a1", "t2"), asst("s3", "s2", "t3"), user("r3", "s3", "t3")];
    expect(ids(recoverParallelToolResults(chain, pool))).toEqual(["u0", "a1", "s3", "r3", "r1", "done"]);
  });

  test("a sibling is recovered when all its calls are answered, some already on the chain", () => {
    const chain = [user("u0", null), asst("a1", "u0", "t1"), user("r", "a1", "t1", "t2"), asst("done", "r")];
    const pool = [...chain, asst("s2", "a1", "t2")];
    expect(ids(recoverParallelToolResults(chain, pool))).toEqual(["u0", "a1", "s2", "r", "done"]);
  });

  test("an off-chain assistant with no calls at all, hanging off a run member, is recovered as a sibling", () => {
    const chain = [user("u0", null), asst("a1", "u0", "t1"), user("r1", "a1", "t1"), asst("done", "r1")];
    const pool = [...chain, asst("txt", "a1")];
    expect(ids(recoverParallelToolResults(chain, pool))).toEqual(["u0", "a1", "txt", "r1", "done"]);
  });

  test("an API-error assistant entry is never a sibling", () => {
    const chain = [user("u0", null), asst("a1", "u0", "t1"), user("r1", "a1", "t1"), asst("done", "r1")];
    const err: Node = { ...asst("err", "a1"), apiError: true };
    expect(ids(recoverParallelToolResults(chain, [...chain, err]))).toEqual(["u0", "a1", "r1", "done"]);
  });

  test("siblings are considered in pool order: one listed before its own parent sibling is not reached", () => {
    const chain = [user("u0", null), asst("a1", "u0", "t1"), user("r1", "a1", "t1"), asst("done", "r1")];
    const pool = [...chain, asst("s3", "s2", "t3"), asst("s2", "a1", "t2"), user("r2", "s2", "t2"), user("r3", "s3", "t3")];
    expect(ids(recoverParallelToolResults(chain, pool))).toEqual(["u0", "a1", "s2", "r2", "r1", "done"]);
  });

  test("non-assistant off-chain entries (attachments, meta user text) never come back", () => {
    const chain = [user("u0", null), asst("a1", "u0", "t1"), user("n", "a1"), asst("done", "n")];
    const pool = [...chain, other("att", "a1"), user("meta", "a1"), user("r1", "a1", "t1"), other("att2", "r1")];
    expect(ids(recoverParallelToolResults(chain, pool))).toEqual(["u0", "a1", "r1", "n", "done"]);
  });
});

describe("recoverParallelToolResults: several runs", () => {
  test("each run gets its own insert, and a node recovered for one run is not recovered again", () => {
    const chain = [user("u0", null), asst("a1", "u0", "t1"), user("n1", "a1"), asst("b1", "n1", "t5"), user("n2", "b1"), asst("done", "n2")];
    const pool = [...chain, user("r1", "a1", "t1"), asst("sb", "b1", "t6"), user("r6", "sb", "t6"), user("r5", "b1", "t5")];
    expect(ids(recoverParallelToolResults(chain, pool))).toEqual(["u0", "a1", "r1", "n1", "b1", "sb", "r5", "r6", "n2", "done"]);
  });

  test("ids answered by an earlier run's recovery count as answered for a later run", () => {
    const chain = [user("u0", null), asst("a1", "u0", "t1"), user("n1", "a1"), asst("b1", "n1", "t1"), user("n2", "b1"), asst("done", "n2")];
    const pool = [...chain, user("r1", "a1", "t1"), user("again", "b1", "t1")];
    expect(ids(recoverParallelToolResults(chain, pool))).toEqual(["u0", "a1", "r1", "n1", "b1", "n2", "done"]);
  });

  test("a chain of only assistant entries is one run that ends the chain: nothing is inserted", () => {
    const chain = [asst("a1", null, "t1"), asst("a2", "a1", "t2")];
    const pool = [...chain, user("r1", "a1", "t1")];
    expect(ids(recoverParallelToolResults(chain, pool))).toEqual(["a1", "a2"]);
  });
});
