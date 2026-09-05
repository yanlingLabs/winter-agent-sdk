// Phase 6 Task 3: the adapter corpus runner -- WS-13 §13's list, as NAMED CASES a lane fills in.
//
// FROZEN on T3's merge (R6-12). A lane ADDS `corpus/<family>.ts` supplying its own case
// implementations and never edits this file, which is why the case list is DATA (`CORPUS_CASES`) and
// a lane's contribution is a partial record keyed by case id rather than a subclass, a switch arm, or
// an entry appended to a table in here.
//
// WHY A RUNNER AT ALL. WS-13 §13 makes a corpus pass -- not an adapter's existence -- the thing that
// promotes a catalog row from `candidate` to `supported`. That only means something if every family
// is asked the SAME questions, in the same words, with the same notion of "did it pass". A lane
// writing its own ad-hoc suite would answer whichever questions it found easy.
//
// WHAT A CASE MAY ASSERT ON. The ground truth for what a provider was ASKED is the live request the
// fake received (`FakeServer.requests`), never what the adapter believed it sent. A case that
// asserts on adapter intent proves nothing about the wire.
import type { FakeServer } from "../fakes/server.ts";

/** The WS-13 §13 case ids. Stable strings: a lane keys its implementations on them and a report names them. */
export type CorpusCaseId =
  | "serialization-and-headers"
  | "streaming-order"
  | "tool-call-single"
  | "tool-call-multiple"
  | "tool-call-fragmented"
  | "tool-result-replay"
  | "cancel-pre-header"
  | "cancel-mid-stream"
  | "usage-accounting"
  | "error-auth"
  | "error-rate-limit"
  | "error-timeout"
  | "error-network"
  | "error-malformed"
  | "error-provider-codes"
  | "retry-after-no-replay"
  | "effort-mapping"
  | "opaque-continuation"
  | "limit-rejection"
  | "vision-where-advertised"
  | "discovery-edge-cases"
  | "identity-across-resume"
  | "no-silent-tool-dropping";

/** One case: what it asks, and whether an adapter may legitimately not answer it. */
export interface CorpusCaseSpec {
  id: CorpusCaseId;
  /** What the case proves, in one sentence. Reproduced in the report so a reader never has to open this file to know what a passing case means. */
  question: string;
  /**
   * `required` cases must be implemented for a family to pass at all.
   *
   * `capability-gated` cases are skipped ONLY when the adapter's own descriptor says the capability
   * is absent -- a skip is then a FACT about the model, recorded as such, and never a lane quietly
   * declining a case it found hard. That distinction is the whole reason this field exists.
   */
  requirement: "required" | "capability-gated";
}

/**
 * WS-13 §13's list, in the order the spec states it.
 *
 * DATA, not code, so a lane extends the corpus by supplying implementations rather than by editing
 * this array -- and so a lane that MISSES a required case is caught by the runner rather than by a
 * reviewer noticing an absent test.
 */
export const CORPUS_CASES: readonly CorpusCaseSpec[] = [
  { id: "serialization-and-headers", question: "does the live request carry the model, messages, tools and headers the adapter was asked for?", requirement: "required" },
  { id: "streaming-order", question: "do the normalized events arrive in the order the wire produced them, with no reordering or coalescing?", requirement: "required" },
  { id: "tool-call-single", question: "does one tool call arrive complete, with its arguments parsed?", requirement: "capability-gated" },
  { id: "tool-call-multiple", question: "do several tool calls in one turn each keep their own id, name and arguments?", requirement: "capability-gated" },
  { id: "tool-call-fragmented", question: "do arguments split across many deltas reassemble into the same object?", requirement: "capability-gated" },
  { id: "tool-result-replay", question: "does a tool result replayed on the next turn reach the wire in the family's own shape?", requirement: "capability-gated" },
  { id: "cancel-pre-header", question: "does an abort BEFORE the first response byte stop the request without emitting a turn?", requirement: "required" },
  { id: "cancel-mid-stream", question: "does an abort mid-stream stop consumption promptly, without a partial turn being reported as complete?", requirement: "required" },
  { id: "usage-accounting", question: "are input/output (and cache, where the family reports them) token counts carried through unmodified?", requirement: "required" },
  { id: "error-auth", question: "does a 401/403 normalize to `auth`, with the provider's own code preserved?", requirement: "required" },
  { id: "error-rate-limit", question: "does a 429 normalize to `rate_limit` and become an `api_retry` -- never a `rate_limit_event` (R6-B)?", requirement: "required" },
  { id: "error-timeout", question: "does a stalled stream abort as a typed stall rather than hanging?", requirement: "required" },
  { id: "error-network", question: "does a dropped connection normalize to `network`, with NO HTTP status (absent, not null)?", requirement: "required" },
  { id: "error-malformed", question: "does an unparseable body fail as `bad_request` rather than surfacing as a half-decoded turn?", requirement: "required" },
  { id: "error-provider-codes", question: "is the provider's VERBATIM structured code preserved off the full body, before any truncation?", requirement: "required" },
  { id: "retry-after-no-replay", question: "is `Retry-After` honoured (capped at 60s) and is NOTHING replayed once the first byte was consumed?", requirement: "required" },
  { id: "effort-mapping", question: "does effort map onto the model's VERIFIED vocabulary, or get rejected BEFORE a request is sent?", requirement: "capability-gated" },
  { id: "opaque-continuation", question: "is opaque continuation state captured from the completion event only, and replayed exactly, inside its own domain?", requirement: "capability-gated" },
  { id: "limit-rejection", question: "is a request over the model's declared limits rejected with a typed error rather than sent and failed upstream?", requirement: "required" },
  { id: "vision-where-advertised", question: "does an image block reach the wire in the family's own shape, where the descriptor advertises vision?", requirement: "capability-gated" },
  { id: "discovery-edge-cases", question: "is live discovery size-, time- and item-bounded, and is a partial page reported as partial rather than as removal?", requirement: "required" },
  { id: "identity-across-resume", question: "does the resolved provider/model identity survive a resume unchanged?", requirement: "required" },
  { id: "no-silent-tool-dropping", question: "is a tool the model called but the adapter cannot represent an ERROR, never a silently dropped call?", requirement: "required" },
];

/** The context a case implementation is handed. */
export interface CorpusCaseContext {
  fake: FakeServer;
  /** The model id the case should ask for. The runner passes the one it was configured with, so a family fake can key its scenario table on it. */
  model: string;
}

/** What a case returns. A THROW is a failure; returning `{ skipped }` is the capability-gated "this model does not do that". */
export type CorpusCaseResult = void | { skipped: string };

export type CorpusCaseImpl = (ctx: CorpusCaseContext) => Promise<CorpusCaseResult>;

export interface RunAdapterCorpusOptions {
  /** Names the family in the report. */
  adapter: string;
  fake: FakeServer;
  model: string;
  /** The lane's implementations, keyed by case id. A missing REQUIRED case is a failure the runner reports -- never a silent absence. */
  cases: Partial<Record<CorpusCaseId, CorpusCaseImpl>>;
}

export interface CorpusCaseOutcome {
  id: CorpusCaseId;
  status: "passed" | "failed" | "skipped" | "missing";
  detail?: string;
}

export interface CorpusReport {
  adapter: string;
  model: string;
  outcomes: CorpusCaseOutcome[];
  /** True only when every REQUIRED case passed and no case failed. A capability-gated skip does not block a pass; a missing required case does. */
  ok: boolean;
}

/**
 * Runs the corpus.
 *
 * EVERY case runs, even after one fails: a family lane wants the whole picture from one run, and
 * stopping at the first failure turns a corpus into a bisect.
 *
 * A MISSING required case is `"missing"` rather than silently absent -- that status is what makes
 * "the corpus passed" mean "every question was asked", which is the only reading under which WS-13
 * §13's promotion rule means anything.
 */
export async function runAdapterCorpus(opts: RunAdapterCorpusOptions): Promise<CorpusReport> {
  const outcomes: CorpusCaseOutcome[] = [];
  for (const spec of CORPUS_CASES) {
    const impl = opts.cases[spec.id];
    if (impl === undefined) {
      outcomes.push(
        spec.requirement === "required"
          ? { id: spec.id, status: "missing", detail: `no implementation supplied for a REQUIRED case: ${spec.question}` }
          : { id: spec.id, status: "skipped", detail: "capability-gated, and no implementation supplied" },
      );
      continue;
    }
    try {
      const result = await impl({ fake: opts.fake, model: opts.model });
      if (result !== undefined && "skipped" in result) {
        outcomes.push({ id: spec.id, status: "skipped", detail: result.skipped });
        continue;
      }
      outcomes.push({ id: spec.id, status: "passed" });
    } catch (err) {
      outcomes.push({ id: spec.id, status: "failed", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  const ok = outcomes.every((o) => o.status === "passed" || o.status === "skipped");
  return { adapter: opts.adapter, model: opts.model, outcomes, ok };
}

/** A one-line-per-case rendering, so a failing lane run says which questions went unanswered without anyone opening this file. */
export function formatCorpusReport(report: CorpusReport): string {
  const byId = new Map(CORPUS_CASES.map((c) => [c.id, c]));
  const lines = report.outcomes.map((o) => `  ${o.status.padEnd(8)} ${o.id}${o.detail !== undefined ? ` -- ${o.detail}` : ""}  (${byId.get(o.id)?.question ?? ""})`);
  return [`corpus: ${report.adapter} / ${report.model} -- ${report.ok ? "OK" : "FAILED"}`, ...lines].join("\n");
}
