// `@yanlinglabs/winter-provider-conformance` — the behavioural corpus every adapter must pass.
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
// never editing the base. This barrel is the spine's package skeleton; T3's runner is re-exported
// directly from here, and `server.ts` plus every fake are re-exported via the dedicated
// `./fakes/index.ts` subpath barrel (P7a Lane C) — see that file's own header.
//
// TEST-ONLY, and structurally so: nothing in the shipped runtime imports this package. Its fakes
// bind `127.0.0.1` on port 0, close in a `finally` with an explicit deadline, and log every request
// they receive (redacted) as the evidence that they were the only endpoint contacted — the ground
// truth for what a provider was ASKED is always the live request the fake received, never what the
// adapter believed it sent.

/** The package's own identity, so a scenario report can name what produced it. */
export const PROVIDER_CONFORMANCE_PACKAGE = "@yanlinglabs/winter-provider-conformance";

// --- Phase 6 Task 3: the spine's frozen corpus runner, re-exported ---------------------------------
//
// A lane imports from this barrel rather than reaching into `fakes/`/`corpus/` by path, so the
// package's own public surface is what R6-12 freezes and a lane's added file is what it adds.
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
export { CLASSIFIER_SAFETY_CASES, CLASSIFIER_SAFETY_CATEGORIES, describeCaseFailure, describeReasonCode, describeThrown, formatClassifierSafetyReport, runClassifierSafetyCorpus } from "./corpus/classifier-safety.ts";
export type {
  ClassifierSafetyAnswer,
  ClassifierSafetyCase,
  ClassifierSafetyCategory,
  ClassifierSafetyClassify,
  ClassifierSafetyOutcome,
  ClassifierSafetyReport,
  SafetyEnvelope,
} from "./corpus/classifier-safety.ts";
export { LIVE_CASES, LiveCaseAssertionError, formatLiveReport, formatLiveRow, liveRowSummary, runLiveCases, runLiveTarget } from "./live/index.ts";
export type { LiveCaseContext, LiveCaseId, LiveCaseOutcome, LiveCaseSpec, LiveReport, LiveRowSummary, LiveRowSummaryOptions, LiveTargetKindLabel, RunLiveCasesOptions } from "./live/index.ts";

// --- Phase 6 Task 10: the per-family corpora, as NAMESPACES ----------------------------------------
//
// Four adapter lanes added `fakes/<family>.ts` and `corpus/<family>.ts` beside the spine's frozen
// runner exactly as R6-12 told them to — and this barrel, frozen for the same reason, could not name
// them. So every cross-package consumer reached them by relative path, which is the drift a barrel
// exists to prevent.
//
// NAMESPACES RATHER THAN A FLAT `export *`, and the reason is not style. `corpus/anthropic.ts` and
// `corpus/google.ts` BOTH export `collectEvents`, `foldTurn` and `foldFailure` — a star-export
// collision is silently EXCLUDED from the re-export set rather than reported, so a flat barrel would
// publish a surface that quietly omits three names each lane genuinely uses. A namespace per module
// is collision-proof by construction, and it keeps `anthropicCorpus.foldTurn` readable at the call
// site about which family's fold it is.
export * as azureCorpus from "./corpus/azure.ts";

// `anthropicCorpus`, `bedrockCorpus`, `googleCorpus`, `openaiCorpus`, `vertexCorpus` and
// `openaiScenarios` are DELIBERATELY NOT re-exported here (review r1 Critical Finding 2's actual
// fix, not a Phase 6 omission). `corpus/{anthropic,bedrock,google,openai}.ts` import
// `foldProviderStream`/`adapterAsProvider` from `packages/runtime/src/provider/bridge.ts` — a
// relative path into `winter-agent-runtime`, which is `"private": true` and never published (WS-02
// §3: "not published directly"). `bridge.ts`'s own header explains why that conversion can only ever
// live in the runtime engine package (a one-way runtime -> provider-runtime dependency, never
// reversed), so no package-specifier spelling of that import could ever be resolved by an external
// installer. `corpus/vertex.ts` and `corpus/openai-scenarios.ts` are excluded TRANSITIVELY: neither
// touches `packages/runtime` itself, but `vertex.ts` imports real VALUES (not just types) from
// `google.ts`, and `openai-scenarios.ts` imports real values from `openai.ts` -- an ES module import
// always evaluates the entire target file, so pulling in either one still requires the broken file's
// own top-level import to resolve. (`azure.ts`'s own reach into `openai.ts` is `import type` only,
// which Bun/tsc elide entirely -- confirmed the one case that is actually safe to keep.) A bare
// `import("@yanlinglabs/winter-provider-conformance")` crashed immediately once packed and installed
// standalone (`Cannot find module '../../../runtime/src/provider/bridge.ts'`), reproduced against a
// real packed tarball via `scripts/smoke-installed.ts` -- which is what caught the vertex/
// openai-scenarios cases specifically, after fixing the first four made the obvious ones green.
//
// Removing these six names from the PUBLISHED barrel is a no-op for every real consumer: nothing
// anywhere in this monorepo (or the pipeline's own conformance matrix) imports them by package name
// — every genuine consumer, including each corpus file's own `.test.ts`, reaches its implementation
// by a direct same-directory relative import (e.g. `anthropic.test.ts` imports
// `anthropicCorpusCases` from `"./anthropic.ts"`, never `anthropicCorpus` from this barrel) and is
// completely unaffected. The six `corpus/*.ts` files themselves are untouched and keep working
// exactly as before for every in-monorepo consumer; only their re-export from THIS published
// surface is gone.

// --- P7a Lane C: every fake, via the dedicated `./fakes` subpath barrel ----------------------------
//
// Moved out of this file and into `fakes/index.ts` (WS-02 §9 Step 2: "exports maps ./fakes"), which
// this line re-exports in full so nothing importing a fake from the package's TOP LEVEL (as
// `verify-provider-live.test.ts` does) needs to change. A consumer who wants ONLY the fakes can
// import `@yanlinglabs/winter-provider-conformance/fakes` directly instead.
export * from "./fakes/index.ts";
