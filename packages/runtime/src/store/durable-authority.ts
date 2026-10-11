import { WinterCompatibilitySessionStore, type SessionKey, type SessionStore } from "@yanlinglabs/winter-agent-sdk";

/** Decoration of existing state implementations, not another store or authority source. */
export interface DurableOperationGuard { run<T>(operation: () => T): T }
export function durableOperationGuard(store: SessionStore, winterHome: string, key: SessionKey): DurableOperationGuard {
  return { run: operation => store instanceof WinterCompatibilitySessionStore
    ? store.runOwnedDurableOperation(winterHome, key, operation) : operation() };
}
/** Guards construction (initial reads) and every method (including cached reads). The actual
 * implementation, state, paths and write discipline remain in the supplied factory. */
export function guardedDurableMethods<T extends object>(guard: DurableOperationGuard, factory: () => T): T {
  const state = guard.run(factory);
  return Object.fromEntries(Object.entries(state).map(([name, value]) => [name,
    typeof value === "function" ? (...args: unknown[]) => guard.run(() => value.apply(state, args)) : value,
  ])) as T;
}
