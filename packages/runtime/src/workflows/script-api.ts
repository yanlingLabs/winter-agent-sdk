// Phase 5 Lane W (task 4), WS-11 §1.6: the SCRIPT API -- the globals a workflow body sees, and the
// only surface it has. Ported from Norma's `workflows/worker-harness.ts` (D8/D11) and widened to the
// full CC contract.
//
// THIS RUNS INSIDE THE SANDBOXED WORKER, never in the daemon. Everything that needs a capability
// (spawning an agent, reading a nested workflow's source) is a `deps` callback that goes over the
// NDJSON bridge; everything else is plain in-worker JavaScript. That split is the security model:
// the parent is the only process that can act, and it only ever acts on well-typed requests.
//
// FOUR DELTAS from Norma's original, each from WS-11 §1.6:
//   - `pipeline` stages take `(prevResult, originalItem, index)` -- Norma's took `(x)` only;
//   - `budget` is a real mirrored ceiling, not a no-op stub;
//   - `workflow()` exists at all (one-level nesting);
//   - the caps are enforced with EXPLICIT errors: 4096 items per call, and the total-agent cap
//     "recording how many completed before the stop" (WS-11 §1.8) rather than truncating silently.
import { promptKey, type JournalEntry } from "./journal.ts";
import { makeSemaphore } from "./semaphore.ts";
import type { BudgetSnapshot } from "./budget.ts";
import type { AgentOpts } from "./types.ts";
import type { WorkflowRef } from "./bridge.ts";

/**
 * What the bridge answers for one `agent()` call.
 *
 * The `ok: true, value: null` / `ok: false` split IS the WS-11 §1.6 contract, expressed in the type:
 * a skipped or terminally-failed agent RESOLVES null (so `.filter(Boolean)` works, which is what the
 * spec tells authors to write), while a refusal the script must not be able to swallow -- the agent
 * cap, the budget ceiling, no spawn capability at all -- comes back `ok: false` and THROWS.
 */
export type AgentBridgeResult =
  | { ok: true; value: unknown; budget?: BudgetSnapshot }
  | { ok: false; error: string; budget?: BudgetSnapshot };

export type WorkflowResolveResult = { ok: true; source: string } | { ok: false; error: string };

export interface ScriptApiDeps {
  source: string;
  args: unknown;
  concurrency: number;
  totalAgentCap: number;
  maxItemsPerCall: number;
  budget: BudgetSnapshot;
  agent(prompt: string, opts?: AgentOpts): Promise<AgentBridgeResult>;
  /** Resolves a nested `workflow(nameOrRef)` to its SOURCE. Parent-side: the worker cannot read the project workflows dir. */
  resolveWorkflow(ref: WorkflowRef, args: unknown): Promise<WorkflowResolveResult>;
  phase(title: string): void;
  log(message: string): void;
  /** F8: called ONCE, with how many leading `agent()` calls replayed from the resume journal. */
  reportCachedPrefix?(count: number): void;
  /** WS-11 §1.5: the prior run's ordered `agent()` results. Absent/empty for a fresh run. */
  resumeJournal?: JournalEntry[];
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...a: unknown[]) => Promise<unknown>;

// --- Determinism guards (WS-11 §1.6) --------------------------------------------------------------
//
// A resumed prefix has to be byte-stable for the positional journal replay below to mean anything,
// so time and randomness are WITHHELD rather than frozen: a script reaching for them fails loudly
// instead of silently becoming non-deterministic. Timestamps and seeds arrive through `args`.
//
// Proxies, not deleted globals: `Math.max` and `new Date(ts)` must keep working, and only the two
// non-deterministic members are intercepted.

const guardedMath = new Proxy(Math, {
  get(target, prop, receiver) {
    if (prop === "random") {
      return () => {
        throw new Error("Math.random is withheld for determinism (WS-11 §1.6) -- pass a seed via args");
      };
    }
    return Reflect.get(target, prop, receiver);
  },
});

const GuardedDate = new Proxy(Date, {
  get(target, prop, receiver) {
    if (prop === "now") {
      return () => {
        throw new Error("Date.now is withheld for determinism (WS-11 §1.6) -- pass timestamps via args");
      };
    }
    return Reflect.get(target, prop, receiver);
  },
  construct(target, argsList, newTarget) {
    if (argsList.length === 0) {
      throw new Error("argless new Date() is withheld for determinism (WS-11 §1.6) -- pass a timestamp via args");
    }
    const instance = Reflect.construct(target, argsList, newTarget) as Date;
    // F7: without this, `new Date(0).constructor` resolves through `Date.prototype.constructor` to
    // the REAL Date, and `.now()` / an argless `new` both walk straight past the guards above
    // (measured). An OWN property shadows the prototype's, closing that route per instance.
    //
    // `Object.getPrototypeOf(x).constructor` is NOT closed and cannot be from here: it would mean
    // replacing `Date.prototype.constructor` process-wide, and this worker entry is runnable
    // IN-PROCESS by R5-15's design -- commit 9fe9ab6 is this lane's own record of what a global
    // mutation from it costs. Disclosed as a skipped test in script-api.test.ts.
    try {
      Object.defineProperty(instance, "constructor", { value: GuardedDate, writable: true, configurable: true, enumerable: false });
    } catch {
      /* a frozen/exotic instance -- the guards on the proxy itself still stand */
    }
    return instance;
  },
});

// --- Source transform -----------------------------------------------------------------------------
//
// The body is compiled as an AsyncFunction, which is not a module: `export` is a syntax error there.
// So `export const meta = {...}` is rewritten to an assignment into a capture cell, and any other
// stray `export ` is stripped. The META VALUE this produces is NOT the authority on the meta block --
// meta.ts parses it statically, parent-side, before the worker ever starts; this capture exists so a
// script can still read its own meta and so the worker can report what it actually ran.

// DISCLOSED FALSE POSITIVE (whole-branch n2), stated here beside the dynamic-import one below
// because it has the same shape and the same honest answer: the `export ` strip is a LINE-ANCHORED
// REGEX, not a parser, so it also rewrites a line that begins with `export ` inside a template
// literal, a block comment or a string. A script containing
//
//     const doc = `
//     export const x = 1;
//     `;
//
// gets that line's `export ` removed from its own data. The alternative is a real JS parser in the
// worker's hot path for a case no workflow has any reason to hit; a script that must carry such a
// line can indent it (the anchor allows leading whitespace, so `  export ` is stripped too --
// prefix it with any non-space character instead) or build it from pieces. Documented rather than
// silently tolerated, which is what the sibling `import` note already does.
function transformSource(source: string): string {
  return source
    .replace(/\bexport\s+(?:const|let|var)\s+meta\s*=/, "__META__.value =")
    .replace(/^[ \t]*export\s+/gm, "");
}

// WS-11 §1.6: "no filesystem, process, network, import/require, or host-runtime ambient access."
// `require` is shadowed by naming it in the scope below; DYNAMIC `import()` cannot be, because
// `import` is a reserved word and `new AsyncFunction("import", ...)` is itself a syntax error.
//
// MEASURED, not assumed: `await import("node:fs")` inside a `new AsyncFunction` body RESOLVES under
// bun 1.3.14 -- it is not the syntax error a module-vs-function reading would predict. So the guard
// is a source-level refusal: `import` can only be reached through this literal token (it is syntax,
// never a value, so it cannot be called through a computed name).
//
// HONEST SCOPE, and this paragraph is a CORRECTION of an earlier claim in this lane's own report,
// which said "`import` is syntax, never a value, so there is no computed-name route around it." That
// is FALSE, and measured to be false: `(function(){}).constructor` reaches the real `Function`
// regardless of the shadowed binding, and a token assembled at runtime (`"imp" + "ort"`) is invisible
// to a scanner that reads source text. So this guard raises the cost of the obvious route and closes
// nothing absolutely.
//
// That is not a defect in the design, only in the claim. WS-11 §1.7's answer has always been that the
// body runs in a SEATBELTED SUBPROCESS (no writes, no network, no fork, exec of the self binary only,
// `~/.winter/run` read-denied) and that scope shadowing is defence in depth -- Norma's own port
// carried the identical framing ("belt-and-suspenders under the seatbelt"). What follows from it is a
// DOCUMENTATION obligation, discharged in three places: script-api.test.ts pins every measured route,
// closed ones as assertions and open ones as named `test.skip`s; worker-harness.ts's in-process
// spawner is marked test-only; and the lane report says so.
//
// A false positive (the token inside a string or comment) refuses a script that would have been
// harmless. That direction is the right one to err in, and the remedy is one line of authoring.
const DYNAMIC_IMPORT_RE = /\bimport\s*[(.]/;

function assertNoDynamicImport(body: string): void {
  if (DYNAMIC_IMPORT_RE.test(body)) {
    throw new Error(
      "`import` is not available to a workflow script -- no filesystem, process, network or import access (WS-11 §1.6); pass what the script needs through `args`",
    );
  }
}

interface RunState {
  /** Positional call index, SHARED with any nested workflow -- WS-11 §1.6: a child shares "the run's agent counter". */
  callIndex: number;
  /** Latches on the first journal mismatch: everything from there on runs live. */
  diverged: boolean;
  /** Agents actually DISPATCHED (a cached prefix never spawned, so it never counts). */
  dispatched: number;
  completed: number;
  budget: BudgetSnapshot;
}

export interface ScriptRunResult {
  meta: unknown;
  result: unknown;
}

/**
 * Compiles and runs one workflow body, returning its captured `meta` and its `return` value.
 *
 * Throws only for the conditions WS-11 §1.6/§1.8 say must throw: a syntax error, a determinism-guard
 * violation, a cap breach, a budget ceiling, an unresolvable or over-nested `workflow()`, or whatever
 * the body itself threw. Everything a script is meant to be able to absorb (`parallel`'s failing
 * thunk, a skipped agent) resolves instead.
 */
export async function runWorkflowScript(deps: ScriptApiDeps): Promise<ScriptRunResult> {
  // Bounds in-worker fan-out. The RUNTIME-side semaphore (runtime.ts) is the authoritative bound --
  // this one keeps the worker from posting thousands of bridge frames at once (semaphore.ts's own
  // "two instances" note).
  const sem = makeSemaphore(deps.concurrency);
  const journal = deps.resumeJournal ?? [];
  const state: RunState = { callIndex: 0, diverged: false, dispatched: 0, completed: 0, budget: deps.budget };

  function budgetView() {
    return {
      get total() {
        return state.budget.total;
      },
      spent: () => state.budget.spent,
      remaining: () => (state.budget.total === null ? Infinity : Math.max(0, state.budget.total - state.budget.spent)),
    };
  }

  async function agent(prompt: string, opts?: AgentOpts): Promise<unknown> {
    const index = state.callIndex++;
    const key = promptKey(String(prompt), opts);

    // WS-11 §1.5: the longest UNCHANGED PREFIX replays from cache. `diverged` latches on the first
    // call whose (prompt, opts) no longer matches the journal at that index -- a changed call, or
    // simply running past the journal's recorded end -- so that call and everything after it runs
    // live, even where some later index would coincidentally match. A cached call spawns nothing,
    // so it costs nothing against the cap and takes no semaphore slot.
    const cached = journal[index];
    if (!state.diverged && cached !== undefined && cached.promptKey === key) return cached.value;
    if (!state.diverged) {
      // The FIRST divergence: `index` is exactly the cached-prefix length. Reported once, one-way --
      // the parent needs it to carry the replayed prefix into this run's own journal (F8).
      state.diverged = true;
      deps.reportCachedPrefix?.(index);
    }

    // WS-11 §1.8: exceeding the total cap FAILS the run with a message recording how many completed
    // before the stop -- never a silent truncation. Checked BEFORE acquiring a slot so a run pinned
    // at capacity fails fast rather than queueing behind work that can never help it.
    if (state.dispatched >= deps.totalAgentCap) {
      throw new Error(
        `workflow exceeded the per-run agent cap (${deps.totalAgentCap}) -- ${state.completed} completed before the stop`,
      );
    }
    // WS-11 §1.6: "a set `total` is a hard ceiling: once reached, further `agent()` calls throw."
    // The mirror is advisory (the parent refuses too, authoritatively) but it is what makes the
    // error message a BUDGET error rather than an opaque bridge refusal.
    if (state.budget.total !== null && state.budget.spent >= state.budget.total) {
      throw new Error(
        `workflow budget exhausted: ${state.budget.spent} of ${state.budget.total} tokens spent -- further agent() calls are refused (WS-11 §1.6)`,
      );
    }

    state.dispatched++;
    await sem.acquire();
    let outcome: AgentBridgeResult;
    try {
      outcome = await deps.agent(String(prompt), opts);
    } finally {
      sem.release();
      state.completed++;
    }
    if (outcome.budget !== undefined) state.budget = outcome.budget;
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.value;
  }

  function assertItemCap(kind: "parallel" | "pipeline", count: number): void {
    if (count > deps.maxItemsPerCall) {
      throw new Error(
        `${kind}() was given ${count} items, over the per-call limit of ${deps.maxItemsPerCall} (WS-11 §1.6) -- split the work across calls`,
      );
    }
  }

  /** A barrier. A thunk that throws resolves to null; the call itself NEVER rejects (WS-11 §1.6). */
  async function parallel(thunks: Array<() => unknown>): Promise<unknown[]> {
    const list = Array.from(thunks ?? []);
    assertItemCap("parallel", list.length);
    return Promise.all(
      list.map(async (thunk) => {
        try {
          return await thunk();
        } catch {
          return null;
        }
      }),
    );
  }

  /**
   * Per-item flow through all stages with NO inter-stage barrier (WS-11 §1.6) -- every item races
   * ahead independently, which is exactly why the stage signature carries `originalItem` and `index`:
   * a stage cannot rely on the ambient `phase()` state or on its siblings' positions.
   */
  async function pipeline(items: unknown[], ...stages: Array<(prev: unknown, item: unknown, index: number) => unknown>): Promise<unknown[]> {
    const list = Array.from(items ?? []);
    assertItemCap("pipeline", list.length);
    return Promise.all(
      list.map(async (item, index) => {
        let current: unknown = item;
        try {
          for (const stage of stages) current = await stage(current, item, index);
          return current;
        } catch {
          return null; // this item drops to null and skips its remaining stages; its siblings continue
        }
      }),
    );
  }

  /**
   * Compiles and runs one body at `depth`. Depth 0 is the launched workflow; depth 1 is a nested
   * `workflow()` call. At depth 1 the `workflow` global THROWS -- WS-11 §1.6: "nesting is one level."
   */
  async function runBody(source: string, args: unknown, depth: number): Promise<ScriptRunResult> {
    const metaCell: { value: unknown } = { value: undefined };

    const nested = async (nameOrRef: string | WorkflowRef, childArgs?: unknown): Promise<unknown> => {
      if (depth >= 1) {
        throw new Error("workflow() nesting is one level deep -- a nested workflow cannot call workflow() itself (WS-11 §1.6)");
      }
      const ref: WorkflowRef = typeof nameOrRef === "string" ? { name: nameOrRef } : nameOrRef;
      const resolved = await deps.resolveWorkflow(ref, childArgs);
      if (!resolved.ok) throw new Error(resolved.error);
      const child = await runBody(resolved.source, childArgs, depth + 1);
      return child.result;
    };

    // Every global the body can see. Anything NOT in this list is genuinely absent inside the body --
    // an AsyncFunction's scope chain reaches the real global object, so the dangerous ambients are
    // shadowed by being NAMED here with an `undefined` value, which is what makes
    // `typeof Bun === "undefined"` true (WS-11 §1.6's own literal wording).
    const scope: Record<string, unknown> = {
      // The API
      agent,
      parallel,
      pipeline,
      phase: (title: unknown) => deps.phase(String(title)),
      log: (message: unknown) => deps.log(String(message)),
      budget: budgetView(),
      workflow: nested,
      args,
      __META__: metaCell,
      // Standard built-ins, with the two determinism guards swapped in
      JSON,
      Math: guardedMath,
      Date: GuardedDate,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Promise,
      RegExp,
      Map,
      Set,
      Error,
      Symbol,
      // `console` is REDIRECTED, not passed through (a Winter delta from Norma's port). The worker's
      // real stdout is the NDJSON bridge: a `console.log` reaching it would inject a non-frame line
      // into the parent's parser mid-run. Routing it to `log()` keeps the author's debugging habit
      // working and puts the output exactly where WS-11 §1.6 says narrator lines go.
      console: {
        log: (...parts: unknown[]) => deps.log(parts.map(stringifyLogPart).join(" ")),
        info: (...parts: unknown[]) => deps.log(parts.map(stringifyLogPart).join(" ")),
        warn: (...parts: unknown[]) => deps.log(parts.map(stringifyLogPart).join(" ")),
        error: (...parts: unknown[]) => deps.log(parts.map(stringifyLogPart).join(" ")),
        debug: (...parts: unknown[]) => deps.log(parts.map(stringifyLogPart).join(" ")),
      },
      // Shadowed ambients (WS-11 §1.6: "no filesystem, process, network, import/require, or
      // host-runtime ambient access"). Naming them as parameters is what shadows them.
      Bun: undefined,
      process: undefined,
      // F7 (measured): `performance.now()` and `crypto.randomUUID()` both defeated the determinism
      // guards above -- they are a clock and an entropy source by any other name, and a resumed
      // prefix that used either is not byte-stable. Shadowed for the same reason Date.now is.
      performance: undefined,
      crypto: undefined,
      require: undefined,
      module: undefined,
      exports: undefined,
      fetch: undefined,
      globalThis: undefined,
      self: undefined,
      global: undefined,
      XMLHttpRequest: undefined,
      WebSocket: undefined,
      Worker: undefined,
      Function: undefined,
    };

    const names = Object.keys(scope);
    const body = transformSource(source);
    assertNoDynamicImport(body);
    const compiled = new AsyncFunction(...names, `"use strict";\n${body}`);
    const result = await compiled(...names.map((n) => scope[n]));
    return { meta: metaCell.value, result };
  }

  const outcome = await runBody(deps.source, deps.args, 0);
  // A run that never diverged replayed its journal END TO END -- the 100%-cache-hit case, which has
  // no first-divergence moment to report from.
  if (!state.diverged && journal.length > 0) deps.reportCachedPrefix?.(state.callIndex);
  return outcome;
}

function stringifyLogPart(part: unknown): string {
  if (typeof part === "string") return part;
  try {
    return JSON.stringify(part) ?? String(part);
  } catch {
    return String(part);
  }
}
