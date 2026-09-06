// `winter-provider-conformance` — the behavioural corpus every adapter must pass.
//
// WS-13 §13 makes a corpus pass, not an adapter's existence, the thing that promotes a catalog row
// from `candidate` to `supported`: request serialization and headers, streaming order, single /
// multiple / fragmented tool calls, tool-result replay, cancellation pre-header and mid-stream,
// usage accounting, the auth / rate-limit / timeout / network / malformed error classes,
// `Retry-After` parsing without unsafe replay, effort mapping, opaque continuation, limit and
// parameter rejection, discovery edge cases, identity across resume and model switch — and, as
// hard negatives, no silent tool dropping and no silent provider fallback.
//
// OWNERSHIP. This package's SPINE files are `src/fakes/server.ts` (the shared loopback fake base)
// and `src/corpus/runner.ts` (the scenario runner) — Task 3's deliverables, frozen on its merge
// (R6-12). Adapter lanes then ADD `src/fakes/<family>.ts` and `src/corpus/<family>.ts` beside them,
// never editing the base. This barrel is the spine's package skeleton; T3 re-exports the fake base
// and the runner from here.
//
// TEST-ONLY, and structurally so: nothing in the shipped runtime imports this package. Its fakes
// bind `127.0.0.1` on port 0, close in a `finally` with an explicit deadline, and log every request
// they receive (redacted) as the evidence that they were the only endpoint contacted — the ground
// truth for what a provider was ASKED is always the live request the fake received, never what the
// adapter believed it sent.

/** The package's own identity, so a scenario report can name what produced it. */
export const PROVIDER_CONFORMANCE_PACKAGE = "winter-provider-conformance";

// --- Phase 6 Task 3: the spine's two frozen files, re-exported ------------------------------------
//
// A lane imports from this barrel rather than reaching into `fakes/`/`corpus/` by path, so the
// package's own public surface is what R6-12 freezes and a lane's added file is what it adds.
export {
  errorResponse,
  jsonResponse,
  noRequestContains,
  redirectResponse,
  requestsTo,
  scenarioTable,
  sseResponse,
  stalledResponse,
  startFake,
  withFake,
} from "./fakes/server.ts";
export type { FakeRoute, FakeServer, RecordedRequest, ScenarioResponder, ScenarioTableOptions, SseFrame, SseResponseOptions, StartFakeOptions } from "./fakes/server.ts";
export { CORPUS_CASES, formatCorpusReport, runAdapterCorpus } from "./corpus/runner.ts";
export type { CorpusCaseContext, CorpusCaseId, CorpusCaseImpl, CorpusCaseOutcome, CorpusCaseResult, CorpusCaseSpec, CorpusReport, RunAdapterCorpusOptions } from "./corpus/runner.ts";

// --- Phase 6 Lane C: the continuity corpus -------------------------------------------------------
//
// Report §12.3's eight named switch cases and its §12.4 security proofs, as DATA plus a runner --
// the pair-shaped counterpart to `runner.ts`'s per-adapter questions. Exported here so a consumer
// reaches it through the package's own surface rather than by path (review round 1, minor 4);
// `corpus/runner.ts` and `fakes/server.ts` remain untouched.
export { CONTINUITY_CASES, CONTINUITY_CASE_IMPLS, OPAQUE_MARKERS, claudeTurn, createContinuityWorld, formatContinuityReport, openaiTurn, runContinuityCorpus } from "./corpus/continuity.ts";
export type { ContinuityCaseContext, ContinuityCaseId, ContinuityCaseImpl, ContinuityCaseOutcome, ContinuityCaseSpec, ContinuityReport, ContinuityWorld } from "./corpus/continuity.ts";

// --- Phase 6 Task 8 (Lane D): the classifier safety corpus and the opt-in live gate ---------------
//
// Both are DATA plus a runner, for the same reason the adapter corpus is: the offline run (Lane D's
// runtime-side fixture, against a scripted `Provider` double) and the live run
// (`scripts/verify-provider-live.ts`, opt-in) must ask the identical questions, or "the corpus
// passed" means two different things depending on who said it.
export { CLASSIFIER_SAFETY_CASES, CLASSIFIER_SAFETY_CATEGORIES, describeThrown, formatClassifierSafetyReport, runClassifierSafetyCorpus } from "./corpus/classifier-safety.ts";
export type {
  ClassifierSafetyAnswer,
  ClassifierSafetyCase,
  ClassifierSafetyCategory,
  ClassifierSafetyClassify,
  ClassifierSafetyOutcome,
  ClassifierSafetyReport,
  SafetyEnvelope,
} from "./corpus/classifier-safety.ts";
export { LIVE_CASES, LiveCaseAssertionError, formatLiveReport, runLiveCases } from "./live/index.ts";
export type { LiveCaseContext, LiveCaseId, LiveCaseOutcome, LiveCaseSpec, LiveReport, RunLiveCasesOptions } from "./live/index.ts";

// --- Phase 6 Task 10: the per-family fakes and corpora, as NAMESPACES ----------------------------
//
// Four adapter lanes added `fakes/<family>.ts` and `corpus/<family>.ts` beside the spine's two frozen
// files exactly as R6-12 told them to — and this barrel, frozen for the same reason, could not name
// them. So every cross-package consumer reached them by relative path, which is the drift a barrel
// exists to prevent.
//
// NAMESPACES RATHER THAN A FLAT `export *`, and the reason is not style. `corpus/anthropic.ts` and
// `corpus/google.ts` BOTH export `collectEvents`, `foldTurn` and `foldFailure` — a star-export
// collision is silently EXCLUDED from the re-export set rather than reported, so a flat barrel would
// publish a surface that quietly omits three names each lane genuinely uses. A namespace per module
// is collision-proof by construction, and it keeps `anthropicCorpus.foldTurn` readable at the call
// site about which family's fold it is.
export * as anthropicCorpus from "./corpus/anthropic.ts";
export * as azureCorpus from "./corpus/azure.ts";
export * as bedrockCorpus from "./corpus/bedrock.ts";
export * as googleCorpus from "./corpus/google.ts";
export * as openaiCorpus from "./corpus/openai.ts";
export * as openaiScenarios from "./corpus/openai-scenarios.ts";
export * as vertexCorpus from "./corpus/vertex.ts";

export * as anthropicFake from "./fakes/anthropic-messages.ts";
export * as azureFake from "./fakes/azure-openai.ts";
export * as bedrockFake from "./fakes/bedrock.ts";
export * as codexFake from "./fakes/codex-oauth.ts";
export * as geminiFake from "./fakes/gemini.ts";
export * as openaiChatFake from "./fakes/openai-chat.ts";
export * as openaiModelsFake from "./fakes/openai-models.ts";
export * as openaiResponsesFake from "./fakes/openai-responses.ts";
export * as vertexFake from "./fakes/vertex.ts";
export { OPAQUE_FIELD_NAMES, redactOpaqueFields } from "./fakes/redact-opaque.ts";
