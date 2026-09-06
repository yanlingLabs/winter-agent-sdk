// Phase 6 Task 8 (Lane D): the opt-in live gate's runner.
//
// Same shape as the adapter corpus runner next door, and for the same reason: the questions are DATA
// (`LIVE_CASES`), a case that cannot apply reports itself skipped with the descriptor fact that made
// it inapplicable, and every case runs even after one fails so a single opt-in run against a real key
// produces the whole picture rather than a bisect.
//
// NEVER REACHES A VENDOR FROM CI — and the guarantee is a GATE, not an absence of callers. This
// runner IS executed under `bun test`, by `scripts/verify-provider-live.test.ts`'s I1 fixture, which
// spawns the script against a loopback fake (`startFake`, `127.0.0.1:0`) with a scripted adapter
// supplied through `WINTER_LIVE_ADAPTERS_MODULE`. What keeps that hermetic is the two things a real
// run needs and that fixture never provides: a real endpoint, and an adapter reached through the
// merged-adapter path. Everything else refuses by default — the script does nothing without
// `WINTER_LIVE_PROVIDER_TESTS=1` AND a per-provider `WINTER_LIVE_<PROVIDER>_API_KEY`, CI sets
// neither (`grep -rn WINTER_LIVE .github/` finds nothing), and that test's own spawn helper STRIPS
// every `WINTER_LIVE_*` variable from the inherited environment before adding back only what the
// case needs.
//
// So the rule for the next author is not "do not import this from a test". It is: a fixture that
// drives this runner must pin BOTH the endpoint (a loopback fake) and the adapter (the module
// override). A fixture that omits either one goes live on the machine that runs it.
import type { ProviderAdapter, ProviderContext } from "@yanlinglabs/winter-provider-runtime";
import type { WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { describeThrown } from "../corpus/classifier-safety.ts";
import { LIVE_CASES, LIVE_CASE_IMPLS, LiveCaseAssertionError, type LiveCaseContext, type LiveCaseId, type LiveCaseSpec } from "./cases.ts";

export { LIVE_CASES, LiveCaseAssertionError };
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
      // THE TYPE IS THE PERMISSION TO PRINT (review round 1, I1). A `LiveCaseAssertionError` was
      // constructed in `cases.ts` out of measurements, so its message is Winter-authored and safe.
      // Anything else escaped from an ADAPTER, and an adapter failure is a `ProviderRequestError`
      // whose message embeds a snippet of the provider's own response body — scrubbed of credentials
      // but still content. Those render as identity only: class name, normalized code, HTTP status,
      // the provider's structured code.
      //
      // The earlier version rendered `${err.name}: ${err.message}` for BOTH, which put that snippet
      // on an operator's terminal on every adapter throw — and the case impls do not catch, so every
      // adapter throw arrives here.
      const detail = err instanceof LiveCaseAssertionError ? err.message : describeThrown(err);
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

// -------------------------------------------------------------------------------------------------
// P6.5 Lane L (WS-13b §7): the per-target ROW.
//
// `formatLiveReport` above prints one line per CASE, which is what an operator debugging a provider
// wants. What a widening phase wants is one line per TARGET — a row that says whether this provider
// answered at all, how long it took, whether it can be driven agentically (the tool round), and under
// what identity Winter asked. Twenty of those read as a table; twenty five-line blocks do not.
//
// The output rule is the same one the cases obey and is the reason this shape is fixed rather than a
// free-form string: identifiers, a verdict, a duration and Winter's own identity. There is no field
// here that could carry a byte of what a provider returned.
// -------------------------------------------------------------------------------------------------

/** How the target's credential was named — WS-13b §1's three documented third-party paths. Mirrors the gate's `LiveTargetKind`. */
export type LiveTargetKindLabel = "api-key" | "oauth" | "keyless";

export interface LiveRowSummary {
  providerId: string;
  /** The CATALOG KEY (`<providerId>/<model>`), never the provider-local id and never a display name. */
  model: string;
  kind: LiveTargetKindLabel;
  /** True when no case FAILED. A skipped case is a recorded capability fact, not a failure. */
  ok: boolean;
  /** The summed wall-clock of every case. A live gate's most common real failure is "it answered, eventually". */
  latencyMs: number;
  /**
   * True only when the tool round ran and PASSED.
   *
   * A skip therefore reads `false` — deliberately, because the question this column answers is "can
   * this row be driven agentically?", and "the descriptor says it cannot" is a no. The per-case line
   * above always says WHICH of the two it was, so the row is a summary and never the whole story.
   */
  toolCallOk: boolean;
  /**
   * The identity string THIS BUILD sends (`winterUserAgent()`), recorded beside the result so a live
   * run's output carries the identity claim WS-13b §1 makes.
   *
   * It is not a wire observation — this runner never sees an outgoing header. That Winter's own
   * user-agent is genuinely on every family's requests is pinned by the corpus (`corpus/*.test.ts`,
   * "every request carries Winter's OWN user-agent"), against the live request a fake received.
   */
  identityHeader: string;
}

export interface LiveRowSummaryOptions {
  kind: LiveTargetKindLabel;
  identityHeader: string;
}

/** Folds a finished `LiveReport` into its one-line row. Pure: no adapter, no endpoint, no clock. */
export function liveRowSummary(report: LiveReport, opts: LiveRowSummaryOptions): LiveRowSummary {
  return {
    providerId: report.providerId,
    model: report.modelKey,
    kind: opts.kind,
    ok: report.ok,
    latencyMs: report.outcomes.reduce((total, outcome) => total + outcome.ms, 0),
    toolCallOk: report.outcomes.some((outcome) => outcome.id === "tool-round" && outcome.status === "ok"),
    identityHeader: opts.identityHeader,
  };
}

/** `key=value` pairs, in a fixed order, so a run's rows grep and diff. */
export function formatLiveRow(row: LiveRowSummary): string {
  return `  live-row providerId=${row.providerId} model=${row.model} kind=${row.kind} ok=${row.ok} latencyMs=${row.latencyMs} toolCallOk=${row.toolCallOk} identityHeader=${row.identityHeader}`;
}

/**
 * The per-target case: run every live leg against one target, and fold the result into its row.
 *
 * One call so the gate cannot run the cases and then forget the row, or report a row built from
 * something other than the run it names.
 */
export async function runLiveTarget(opts: RunLiveCasesOptions & LiveRowSummaryOptions): Promise<{ report: LiveReport; row: LiveRowSummary }> {
  const report = await runLiveCases(opts);
  return { report, row: liveRowSummary(report, { kind: opts.kind, identityHeader: opts.identityHeader }) };
}

/** One line per case. Identifiers, counts and durations only — never a byte of what a provider returned. */
export function formatLiveReport(report: LiveReport): string {
  const byId = new Map(LIVE_CASES.map((c) => [c.id, c]));
  const lines = report.outcomes.map((o) => `    ${o.status.padEnd(7)} ${o.id.padEnd(17)} ${String(o.ms).padStart(6)}ms  ${o.detail}  (${byId.get(o.id)?.question ?? ""})`);
  return [`  live: ${report.providerId} / ${report.modelKey} via ${report.adapterId}@${report.adapterVersion} -- ${report.ok ? "OK" : "FAILED"}`, ...lines].join("\n");
}
