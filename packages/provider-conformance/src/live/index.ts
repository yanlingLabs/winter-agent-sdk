// Phase 6 Task 8 (Lane D): the opt-in live gate's runner.
//
// Same shape as the adapter corpus runner next door, and for the same reason: the questions are DATA
// (`LIVE_CASES`), a case that cannot apply reports itself skipped with the descriptor fact that made
// it inapplicable, and every case runs even after one fails so a single opt-in run against a real key
// produces the whole picture rather than a bisect.
//
// NEVER IN CI, and structurally so: nothing here is imported by any `.test.ts`, and the only caller
// is `scripts/verify-provider-live.ts`, which refuses to do anything without
// `WINTER_LIVE_PROVIDER_TESTS=1`.
import type { ProviderAdapter, ProviderContext } from "@yanlinglabs/winter-provider-runtime";
import type { WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { LIVE_CASES, LIVE_CASE_IMPLS, type LiveCaseContext, type LiveCaseId, type LiveCaseSpec } from "./cases.ts";

export { LIVE_CASES };
export type { LiveCaseContext, LiveCaseId, LiveCaseSpec };

export interface LiveCaseOutcome {
  id: LiveCaseId;
  status: "ok" | "skipped" | "failed";
  detail: string;
  /** Wall-clock, because a live gate's most common real failure is "it answered, eventually". */
  ms: number;
}

export interface LiveReport {
  providerId: string;
  adapterId: string;
  adapterVersion: string;
  /** The catalog key, so a reader can tell which row this run is evidence for. */
  modelKey: string;
  outcomes: LiveCaseOutcome[];
  /** True when nothing FAILED. A skip is a recorded capability fact, not a failure. */
  ok: boolean;
}

export interface RunLiveCasesOptions {
  providerId: string;
  modelKey: string;
  adapter: ProviderAdapter;
  ctx: ProviderContext;
  /** The provider-local id that goes on the wire. */
  model: string;
  descriptor?: WinterModelDescriptor;
  signal?: AbortSignal;
  /** Progress, one line per case as it finishes. Identifiers and counts only — the case details already obey that rule. */
  onProgress?: (outcome: LiveCaseOutcome) => void;
}

export async function runLiveCases(opts: RunLiveCasesOptions): Promise<LiveReport> {
  const caseCtx: LiveCaseContext = {
    adapter: opts.adapter,
    ctx: opts.ctx,
    model: opts.model,
    ...(opts.descriptor !== undefined ? { descriptor: opts.descriptor } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };
  const outcomes: LiveCaseOutcome[] = [];
  for (const spec of LIVE_CASES) {
    const started = Date.now();
    let outcome: LiveCaseOutcome;
    try {
      const result = await LIVE_CASE_IMPLS[spec.id](caseCtx);
      outcome = { id: spec.id, status: result.status, detail: result.detail, ms: Date.now() - started };
    } catch (err) {
      // The MESSAGE of a case's own thrown assertion is Winter-authored (see `cases.ts`); an error
      // that escaped from an adapter is not, so it is rendered by NAME and code rather than by text.
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      outcome = { id: spec.id, status: "failed", detail, ms: Date.now() - started };
    }
    outcomes.push(outcome);
    opts.onProgress?.(outcome);
  }
  return {
    providerId: opts.providerId,
    adapterId: opts.adapter.id,
    adapterVersion: opts.adapter.version,
    modelKey: opts.modelKey,
    outcomes,
    ok: outcomes.every((o) => o.status !== "failed"),
  };
}

/** One line per case. Identifiers, counts and durations only — never a byte of what a provider returned. */
export function formatLiveReport(report: LiveReport): string {
  const byId = new Map(LIVE_CASES.map((c) => [c.id, c]));
  const lines = report.outcomes.map((o) => `    ${o.status.padEnd(7)} ${o.id.padEnd(17)} ${String(o.ms).padStart(6)}ms  ${o.detail}  (${byId.get(o.id)?.question ?? ""})`);
  return [`  live: ${report.providerId} / ${report.modelKey} via ${report.adapterId}@${report.adapterVersion} -- ${report.ok ? "OK" : "FAILED"}`, ...lines].join("\n");
}
