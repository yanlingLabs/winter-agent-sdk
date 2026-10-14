/** Private current-parent reader lookup. Preparation + signal are correlation
 * identities only; the actual admitted runtime/Root registration enforces reads.
 * This module is not exported from the SDK package's public index. */
import { assertGuidedPreparationClaim, registerGuidedContextDisposer, type GuidedQueryClaim, type GuidedQueryPreparation,
  type GuidedQueryCorrelation } from "./guided-query-preparation.ts";

interface Scope {
  preparation: GuidedQueryPreparation; signal: AbortSignal; closed: boolean; used: boolean; settled: boolean; failed: boolean;
  held(): void; read(): Promise<string>; close(): void;
}
const active = new WeakMap<AbortSignal, Scope>();
const unavailable = () => new Error("required_context_unavailable");
/** Query-internal lifecycle. A caller object/UUID/signal shape cannot register
 * native authority; this controls only one correlation-owned outgoing subtype. */
export function installGuidedQueryReader(options: {
  preparation: GuidedQueryPreparation; claim: GuidedQueryClaim; binding: Readonly<GuidedQueryCorrelation>; signal: AbortSignal;
  read(signal: AbortSignal): Promise<string>;
}): { close(): void; assertSettled(): void } {
  assertGuidedPreparationClaim(options.preparation, options.claim, options.binding);
  if (active.has(options.signal) || options.signal.aborted) throw unavailable();
  const controller = new AbortController(); let remove: (() => void) | undefined;
  const scope: Scope = {
    preparation: options.preparation, signal: options.signal, closed: false, used: false, settled: false, failed: false,
    held() { if (scope.closed || options.signal.aborted) throw unavailable(); assertGuidedPreparationClaim(options.preparation, options.claim, options.binding); },
    async read() {
      scope.held(); if (scope.used) throw unavailable(); scope.used = true;
      try { const value = await options.read(controller.signal); scope.held(); scope.settled = true; return value; }
      catch { scope.failed = true; scope.settled = true; throw unavailable(); }
    },
    close() { if (scope.closed) return; scope.closed = true; active.delete(options.signal); options.signal.removeEventListener("abort", scope.close); controller.abort(); remove?.(); },
  };
  active.set(options.signal, scope); options.signal.addEventListener("abort", scope.close, { once: true });
  try { remove = registerGuidedContextDisposer(options.claim, scope.close); }
  catch { scope.close(); throw unavailable(); }
  return Object.freeze({ close: scope.close, assertSettled() { scope.held(); if (scope.used && (!scope.settled || scope.failed)) throw unavailable(); } });
}
/** No path, view, budget, control subtype or arbitrary request payload can enter
 * through this lookup. The exact current callback signal is required. */
export async function readGuidedQueryInstructions(preparation: GuidedQueryPreparation, callbackSignal: AbortSignal): Promise<string> {
  const scope = active.get(callbackSignal);
  if (!scope || scope.preparation !== preparation) throw unavailable();
  return scope.read();
}
