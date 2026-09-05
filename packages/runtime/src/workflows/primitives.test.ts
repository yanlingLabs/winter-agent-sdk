// Phase 5 Lane W (task 4): the three ported primitives -- the counting semaphore, the per-run
// journal, and the budget accountant view. Ported from Norma's `workflows/{semaphore,journal}.ts`
// (D8/D11: the implementation vehicle), with the CC-contract deltas the brief names:
//   - the concurrency cap becomes `min(16, CPUs - 2)` rather than Norma's flat 16;
//   - `budget` becomes a REAL shared hard ceiling over the host's ContextAccountant, replacing
//     Norma's no-op `{ remaining: () => Infinity }` stub.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSemaphore, resolveConcurrencyCap, DEFAULT_MAX_CONCURRENCY } from "./semaphore.ts";
import { promptKey, RunJournal } from "./journal.ts";
import { createBudget } from "./budget.ts";
import { createContextAccountant } from "../engine.ts";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "winter-wf-primitives-"));
}

describe("semaphore -- per-run agent fan-out (WS-11 §1.6 caps)", () => {
  test("holds `max` permits and QUEUES the rest -- excess never runs eagerly and is never dropped", async () => {
    const sem = makeSemaphore(2);
    const order: number[] = [];
    await sem.acquire();
    await sem.acquire();
    let thirdEntered = false;
    const third = sem.acquire().then(() => {
      thirdEntered = true;
      order.push(3);
    });
    await Promise.resolve();
    expect(thirdEntered).toBe(false); // queued, not admitted
    sem.release();
    await third;
    expect(order).toEqual([3]);
  });

  test("a released permit admits queued waiters in FIFO order", async () => {
    const sem = makeSemaphore(1);
    await sem.acquire();
    const seen: number[] = [];
    const a = sem.acquire().then(() => seen.push(1));
    const b = sem.acquire().then(() => seen.push(2));
    sem.release();
    await a;
    sem.release();
    await b;
    expect(seen).toEqual([1, 2]);
  });

  test("`min(16, CPUs - 2)`, floored at 1 -- the CC cap, not Norma's flat 16", () => {
    expect(resolveConcurrencyCap(64)).toBe(16); // 62 > 16 -> the 16 ceiling binds
    expect(resolveConcurrencyCap(10)).toBe(8);
    expect(resolveConcurrencyCap(4)).toBe(2);
    expect(resolveConcurrencyCap(2)).toBe(1); // 0 would deadlock every run
    expect(resolveConcurrencyCap(1)).toBe(1);
    expect(DEFAULT_MAX_CONCURRENCY).toBe(16);
  });
});

describe("journal -- the resume cache (WS-11 §1.5)", () => {
  test("promptKey is POSITIONAL and keyed on (prompt, opts) -- identical calls key identically", () => {
    expect(promptKey("go", { label: "a" })).toBe(promptKey("go", { label: "a" }));
    expect(promptKey("go", undefined)).not.toBe(promptKey("go", { label: "a" }));
    expect(promptKey("go")).toBe(promptKey("go", undefined));
  });

  test("append/load round-trips in order, one JSON object per line", () => {
    const dir = scratch();
    const journal = new RunJournal(dir, "wf_1");
    journal.append(promptKey("a"), "A");
    journal.append(promptKey("b"), { deep: [1, 2] });
    expect(new RunJournal(dir, "wf_1").load()).toEqual([
      { promptKey: promptKey("a"), value: "A" },
      { promptKey: promptKey("b"), value: { deep: [1, 2] } },
    ]);
    expect(readFileSync(join(dir, "wf_1", "journal.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("loading a run that never journaled anything is an empty array, never a throw", () => {
    expect(new RunJournal(scratch(), "wf_missing").load()).toEqual([]);
  });

  test("a corrupt line is SKIPPED, not fatal -- a truncated journal still replays its readable prefix", () => {
    const dir = scratch();
    const journal = new RunJournal(dir, "wf_2");
    journal.append(promptKey("a"), "A");
    journal.appendRaw("{not json\n");
    journal.append(promptKey("b"), "B");
    expect(new RunJournal(dir, "wf_2").load().map((e) => e.value)).toEqual(["A", "B"]);
  });

  test("the journal lives at `<dir>/<runId>/journal.jsonl` -- one directory per run (WS-11 §1.8)", () => {
    const dir = scratch();
    new RunJournal(dir, "wf_3").append(promptKey("x"), 1);
    expect(existsSync(join(dir, "wf_3", "journal.jsonl"))).toBe(true);
  });
});

describe("budget -- the REAL shared hard ceiling (WS-11 §1.6)", () => {
  test("the DEFAULT total is null: no ceiling, and `agent()` is never refused for budget", () => {
    const budget = createBudget({ accountant: createContextAccountant({ limit: 1000 }) });
    expect(budget.total).toBe(null);
    expect(budget.exceeded()).toBe(false);
    expect(budget.remaining()).toBe(Infinity);
  });

  test("`spent()` reads the HOST's accountant live -- the pool is shared with the main loop, not a private counter", () => {
    const accountant = createContextAccountant({ limit: 1000 });
    const budget = createBudget({ accountant, total: 500 });
    expect(budget.spent()).toBe(0);
    accountant.record({ inputTokens: 120, outputTokens: 30 });
    expect(budget.spent()).toBe(150);
    expect(budget.remaining()).toBe(350);
  });

  test("a set `total` is a HARD ceiling: once reached, the budget reports exceeded", () => {
    const accountant = createContextAccountant({ limit: 10_000 });
    const budget = createBudget({ accountant, total: 100 });
    accountant.record({ inputTokens: 60, outputTokens: 39 });
    expect(budget.exceeded()).toBe(false);
    accountant.record({ inputTokens: 60, outputTokens: 40 });
    expect(budget.exceeded()).toBe(true); // >= the ceiling, not merely >
    expect(budget.remaining()).toBe(0); // never negative -- a script's `remaining()` is a quantity
  });

  test("the wire snapshot carries what the WORKER needs to mirror the ceiling in-script", () => {
    const accountant = createContextAccountant({ limit: 10_000 });
    const budget = createBudget({ accountant, total: 100 });
    accountant.record({ inputTokens: 10, outputTokens: 5 });
    expect(budget.snapshot()).toEqual({ total: 100, spent: 15 });
  });
});
