// Phase 5 Lane W (task 4): the counting semaphore that bounds a run's agent fan-out, ported from
// Norma's `workflows/semaphore.ts` (D8/D11).
//
// TWO INSTANCES, deliberately, exactly as the original: the WORKER-side one (script-api.ts) throttles
// in-worker dispatch so a script's `parallel([...1000 thunks])` never posts a thousand bridge frames
// at once, and the RUNTIME-side one (runtime.ts, per live run) is the AUTHORITATIVE bound, because
// it is the one wrapping the actual `spawnAgent` call. Both are constructed with the same cap; the
// worker's is an optimisation, the runtime's is the contract.
//
// CC-CONTRACT DELTA (WS-11 §1.6/§1.7): the cap is `min(16, CPUs - 2)`, not Norma's flat 16.
import { cpus } from "node:os";

/** The ceiling half of `min(16, CPUs - 2)`. Exported so a test asserts the CONSTANT, not a re-derived literal. */
export const DEFAULT_MAX_CONCURRENCY = 16;

/**
 * WS-11 §1.6: "concurrent `agent()` calls `min(16, CPUs - 2)` per run (excess queue and run as slots
 * free)".
 *
 * Floored at 1: on a 1- or 2-core machine `CPUs - 2` is 0 or negative, and a semaphore with zero
 * permits deadlocks every run that calls `agent()` even once -- silently, with no error, forever.
 * The floor is the difference between "slow on a small machine" and "broken on a small machine".
 */
export function resolveConcurrencyCap(cpuCount: number = cpus().length): number {
  return Math.max(1, Math.min(DEFAULT_MAX_CONCURRENCY, cpuCount - 2));
}

export interface Semaphore {
  acquire(): Promise<void>;
  release(): void;
}

export function makeSemaphore(max: number): Semaphore {
  const permits = Math.max(1, Math.floor(max));
  let active = 0;
  const queue: Array<() => void> = [];
  return {
    acquire: () =>
      new Promise<void>((resolve) => {
        if (active < permits) {
          active++;
          resolve();
        } else {
          queue.push(resolve);
        }
      }),
    release: () => {
      active--;
      const next = queue.shift();
      if (next) {
        active++;
        next();
      }
    },
  };
}
