// Edge cases of `recoverParallelToolResults`: which off-chain call entries and results a run of chain
// assistant entries brings back, where they are spliced, and in what order.
import { describe, expect, test } from "bun:test";
import { recoverParallelToolResults } from "./resume.ts";
import type { DialectEntry } from "./resume.ts";

const A = (uuid: string, parentUuid: string | null, calls: string[], extra: Record<string, unknown> = {}): DialectEntry =>
  ({ type: "assistant", uuid, parentUuid, message: { role: "assistant", content: calls.length > 0 ? calls.map((id) => ({ type: "tool_use", id, name: "t", input: {} })) : [{ type: "text", text: "reply" }] }, ...extra }) as unknown as DialectEntry;
const R = (uuid: string, parentUuid: string | null, ids: string[], leadingText = false): DialectEntry =>
  ({ type: "user", uuid, parentUuid, message: { role: "user", content: [...(leadingText ? [{ type: "text", text: "note" }] : []), ...ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: "out" }))] } }) as unknown as DialectEntry;
const U = (uuid: string, parentUuid: string | null): DialectEntry => ({ type: "user", uuid, parentUuid, message: { role: "user", content: "text" } }) as unknown as DialectEntry;
const order = (chain: DialectEntry[], pool: DialectEntry[]): string => recoverParallelToolResults(chain, pool).map((e) => e.uuid).join(" ");

describe("recoverParallelToolResults: nothing to do", () => {
  test("an empty chain, a chain with no assistant entry, and a chain with nothing off it come back as a COPY", () => {
    expect(recoverParallelToolResults([], [U("u", null)])).toEqual([]);
    const chain = [U("u", null)];
    const out = recoverParallelToolResults(chain, chain);
    expect(out).toEqual(chain);
    expect(out).not.toBe(chain);
  });

  test("a run that ends the chain gets nothing spliced, not even its own members' results", () => {
    const u = U("u", null), a1 = A("a1", "u", ["c1"]), r1 = R("r1", "a1", ["c1"]);
    expect(order([u, a1], [u, a1, r1])).toBe("u a1");
  });

  test("off-chain entries with a null parent are never recovered", () => {
    const u = U("u", null), a1 = A("a1", "u", ["c1"]), orphan = R("orphan", null, ["c1"]), n = U("n", "a1");
    expect(order([u, a1, n], [u, a1, orphan, n])).toBe("u a1 n");
  });
});

describe("recoverParallelToolResults: results of the run's own call entries", () => {
  test("results parented on a run member that answer its still-open calls come back, after the run's LAST entry", () => {
    const u = U("u", null), a1 = A("a1", "u", ["c1"]), a2 = A("a2", "a1", ["c2"]), r1 = R("r1", "a1", ["c1"]), r2 = R("r2", "a2", ["c2"]), n = U("n", "r2");
    expect(order([u, a1, a2, r2, n], [u, a1, a2, r1, r2, n])).toBe("u a1 a2 r1 r2 n");
  });

  test("a result answering only calls the chain already answers is never brought back", () => {
    const u = U("u", null), a1 = A("a1", "u", ["c1"]), r1 = R("r1", "a1", ["c1"]), dup = R("dup", "a1", ["c1"]), n = U("n", "r1");
    expect(order([u, a1, r1, n], [u, a1, r1, dup, n])).toBe("u a1 r1 n");
  });

  test("two results for the same open call: the first in pool order wins", () => {
    const u = U("u", null), a1 = A("a1", "u", ["c1", "c2"]), x = R("x", "a1", ["c1"]), y = R("y", "a1", ["c1"]), z = R("z", "a1", ["c2"]), n = U("n", "a1");
    expect(order([u, a1, n], [u, a1, x, y, z, n])).toBe("u a1 x z n");
  });

  test("a result qualifies if it answers ANY open call not yet answered in this pass; then every id it carries counts as answered", () => {
    const u = U("u", null), a1 = A("a1", "u", ["c1", "c2"]), x = R("x", "a1", ["c1"]), y = R("y", "a1", ["c1", "c2"]), n = U("n", "a1");
    expect(order([u, a1, n], [u, a1, x, y, n])).toBe("u a1 x y n"); // y re-answers c1 alongside c2
    const rA = R("rA", "a1", ["c1", "c9"]), rB = R("rB", "a1", ["c9", "c2"]);
    expect(order([u, a1, n], [u, a1, rA, rB, n])).toBe("u a1 rA rB n");
  });

  test("ids answered by a recovered result stay answered for LATER runs of the chain", () => {
    const u = U("u", null), a1 = A("a1", "u", ["c1"]), rx = R("rx", "a1", ["c1", "c2"]), m = U("m", "a1"), a2 = A("a2", "m", ["c2"]), ry = R("ry", "a2", ["c2"]), n = U("n", "a2");
    expect(order([u, a1, m, a2, n], [u, a1, rx, m, a2, ry, n])).toBe("u a1 rx m a2 n");
  });

  test("a result entry may carry other blocks beside its tool_results", () => {
    const u = U("u", null), a1 = A("a1", "u", ["c1"]), r1 = R("r1", "a1", ["c1"], true), n = U("n", "a1");
    expect(order([u, a1, n], [u, a1, r1, n])).toBe("u a1 r1 n");
  });

  test("an API-error assistant entry ON the chain still belongs to the run (and can be its last entry)", () => {
    const u = U("u", null), a1 = A("a1", "u", ["c1"]), e = A("e", "a1", [], { isApiErrorMessage: true }), r1 = R("r1", "a1", ["c1"]), n = U("n", "e");
    expect(order([u, a1, e, n], [u, a1, e, r1, n])).toBe("u a1 e r1 n");
  });
});

describe("recoverParallelToolResults: off-chain sibling call entries", () => {
  test("splice order: the siblings, then the members' results, then the siblings' results", () => {
    const u = U("u", null), a1 = A("a1", "u", ["c1"]), a2 = A("a2", "a1", ["c2"]), r1 = R("r1", "a1", ["c1"]), s = A("s", "a2", ["c3"]), rs = R("rs", "s", ["c3"]), r2 = R("r2", "a2", ["c2"]), n = U("n", "r2");
    expect(order([u, a1, a2, r2, n], [u, a1, a2, r1, s, rs, r2, n])).toBe("u a1 a2 s r1 rs r2 n");
  });

  test("a sibling of a sibling comes back when it follows its parent in the pool -- but not when it precedes it", () => {
    const u = U("u", null), a1 = A("a1", "u", ["c1"]), r1 = R("r1", "a1", ["c1"]), s1 = A("s1", "a1", ["c2"]), s2 = A("s2", "s1", ["c3"]), rs1 = R("rs1", "s1", ["c2"]), rs2 = R("rs2", "s2", ["c3"]), n = U("n", "r1");
    expect(order([u, a1, r1, n], [u, a1, s1, s2, r1, rs1, rs2, n])).toBe("u a1 s1 s2 rs1 rs2 r1 n");
    expect(order([u, a1, r1, n], [u, a1, s2, s1, r1, rs1, rs2, n])).toBe("u a1 s1 rs1 r1 n");
  });

  test("a sibling with a call nobody answers stays out -- but its own sibling may still come back", () => {
    const u = U("u", null), a1 = A("a1", "u", ["c1"]), r1 = R("r1", "a1", ["c1"]), s1 = A("s1", "a1", ["c2"]), s2 = A("s2", "s1", ["c3"]), rs2 = R("rs2", "s2", ["c3"]), n = U("n", "r1");
    expect(order([u, a1, r1, n], [u, a1, s1, s2, r1, rs2, n])).toBe("u a1 s2 rs2 r1 n");
  });

  test("a sibling whose calls are all already answered, or that has no calls at all (a text reply), comes back alone", () => {
    const u = U("u", null), a1 = A("a1", "u", ["c1"]), r1 = R("r1", "a1", ["c1", "c2"]), s = A("s", "a1", ["c2"]), n = U("n", "r1");
    expect(order([u, a1, r1, n], [u, a1, s, r1, n])).toBe("u a1 s r1 n");
    const t = A("t", "a1", []);
    expect(order([u, a1, r1, n], [u, a1, t, r1, n])).toBe("u a1 t r1 n");
  });

  test("an off-chain API-error assistant entry is never a sibling", () => {
    const u = U("u", null), a1 = A("a1", "u", ["c1"]), r1 = R("r1", "a1", ["c1"]), se = A("se", "a1", ["c5"], { isApiErrorMessage: true }), rse = R("rse", "se", ["c5"]), n = U("n", "r1");
    expect(order([u, a1, r1, n], [u, a1, se, rse, r1, n])).toBe("u a1 r1 n");
  });

  test("a sibling must hang off THIS run (a member or an earlier sibling); a user entry never makes one reachable", () => {
    const u = U("u", null), a1 = A("a1", "u", ["c1"]), m = U("m", "a1"), a2 = A("a2", "m", ["c2"]), n = U("n", "a2");
    const offUser = U("ou", "a1"), s = A("s", "ou", ["c3"]), rs = R("rs", "s", ["c3"]);
    expect(order([u, a1, m, a2, n], [u, a1, offUser, s, rs, m, a2, n])).toBe("u a1 m a2 n");
  });
});
