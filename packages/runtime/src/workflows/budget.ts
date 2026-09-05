// Phase 5 Lane W (task 4), WS-11 §1.6: `budget` -- "{ total: number | null, spent(), remaining() };
// shared turn-level token pool across the main loop and all workflows; a set `total` is a hard
// ceiling: once reached, further `agent()` calls throw".
//
// RETIREMENT DELTA (WS-11 §1.7): Norma shipped `{ remaining: () => Infinity, spend: () => {},
// limit: () => {} }` -- a no-op stub whose only job was to keep a script from crashing on the name.
// The CEILING here is real: a set `total` is enforced parent-side and refuses further `agent()` calls.
//
// THE QUANTITY IS NOT YET THE POOL WS-11 §1.6 DESCRIBES -- RULING P5-J (spine, fix wave), stated here
// rather than implied. An earlier version of this file read `ContextAccountant.contextTokens()` and
// claimed a workflow's spend and the main loop's were "the same number because they are literally the
// same accountant". That was wrong twice over:
//
//   1. `contextTokens()` is the LAST provider call's context size -- `last = inputTokens +
//      outputTokens`, an overwrite, not an accumulation (engine.ts). It is non-monotonic: a smaller
//      subsequent call lowers it and a compaction lowers it sharply, so a ceiling that was reached
//      can become un-reached.
//   2. It is blind to the workflow's own agents. `subagents/child-engine.ts` calls `runEngine` with
//      no `contextAccountant`, so every child builds its own; none of a workflow's agent spend ever
//      moves the number its ceiling reads.
//
// So this reads a CUMULATIVE `spentTokens()` accessor supplied by the host, and falls back to 0 --
// deliberately NOT to `contextTokens()`, because a wrong number that looks plausible is worse than an
// honest zero. P5-J is what will supply it (a session-level cumulative counter, with child usage
// routed into the parent's accountant); until then a workflow with a `total` set simply never trips
// its ceiling, which is the same behaviour as the default `total: null`.
//
// THE CEILING IS ENFORCED PARENT-SIDE (runtime.ts's serviceAgent), not in the script. The worker
// mirrors the numbers so `budget.remaining()` reads truthfully inside a script, but a script that
// ignores the mirror still cannot spawn past the ceiling: the bridge refuses the call and the
// worker's `agent()` throws. A guard that lived only in the untrusted body would be advisory.
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
  /**
   * The session's CUMULATIVE token spend (RULING P5-J). Absent = 0, never `contextTokens()` -- see
   * this module's header for why substituting that quantity is worse than reporting nothing.
   */
  spentTokens?: () => number;
  /** Omitted (or null) = no ceiling. */
  total?: number | null;
}

export function createBudget(deps: BudgetDeps): WorkflowBudget {
  const total = typeof deps.total === "number" && Number.isFinite(deps.total) && deps.total > 0 ? deps.total : null;
  const spent = () => deps.spentTokens?.() ?? 0;
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
