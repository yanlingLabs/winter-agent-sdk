// Phase 5 Lane W (task 4), WS-11 §1.6: `budget` -- "{ total: number | null, spent(), remaining() };
// shared turn-level token pool across the main loop and all workflows; a set `total` is a hard
// ceiling: once reached, further `agent()` calls throw".
//
// RETIREMENT DELTA (WS-11 §1.7): Norma shipped `{ remaining: () => Infinity, spend: () => {},
// limit: () => {} }` -- a no-op stub whose only job was to keep a script from crashing on the name.
// This is the real thing, and the word "shared" is what makes it real: `spent()` reads the SESSION's
// own `ContextAccountant` (the one the engine records every provider call into, reached through
// `WorkflowRunHost.accountant`), never a private counter this module increments. A workflow's spend
// and the main loop's spend are the same number because they are literally the same accountant.
//
// THE CEILING IS ENFORCED PARENT-SIDE (runtime.ts's serviceAgent), not in the script. The worker
// mirrors the numbers so `budget.remaining()` reads truthfully inside a script, but a script that
// ignores the mirror still cannot spawn past the ceiling: the bridge refuses the call and the
// worker's `agent()` throws. A guard that lived only in the untrusted body would be advisory.
import type { ContextAccountant } from "../engine.ts";

/** What crosses the bridge so the worker's own `budget` object can answer without a round trip. */
export interface BudgetSnapshot {
  total: number | null;
  spent: number;
}

export interface WorkflowBudget {
  /** `null` = no ceiling. THE DEFAULT (WS-11 §1.6 as amended by the task brief). */
  readonly total: number | null;
  spent(): number;
  remaining(): number;
  /** True once `spent() >= total`. Always false when `total` is null. */
  exceeded(): boolean;
  snapshot(): BudgetSnapshot;
}

export interface BudgetDeps {
  accountant: Pick<ContextAccountant, "contextTokens">;
  /** Omitted (or null) = no ceiling. */
  total?: number | null;
}

export function createBudget(deps: BudgetDeps): WorkflowBudget {
  const total = typeof deps.total === "number" && Number.isFinite(deps.total) && deps.total > 0 ? deps.total : null;
  const spent = () => deps.accountant.contextTokens();
  return {
    total,
    spent,
    // `Infinity` rather than `null` for an unbounded budget, deliberately: WS-11 types this as a
    // NUMBER-returning method, and a script writing `if (budget.remaining() < 1000)` must behave
    // sanely under the default. `null` would make that comparison silently true (null < 1000), i.e.
    // an unbounded budget would read as exhausted -- the exact inversion of the default's meaning.
    remaining: () => (total === null ? Infinity : Math.max(0, total - spent())),
    exceeded: () => total !== null && spent() >= total,
    snapshot: () => ({ total, spent: spent() }),
  };
}
