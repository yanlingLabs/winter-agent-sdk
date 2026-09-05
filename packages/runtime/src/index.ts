// Package entry point for `winter-agent-runtime`. Re-exports the full surface
// consumed by the SDK wrapper (Task 7): the runtime entry point, the
// in-memory channel constructor + its types, the mock provider + its type,
// and the wire-protocol types (frames + SDK messages).

export { runWinterRuntime } from "./runtime.ts";

// The turn engine (Task 3): state machine, tool rounds, maxTurns, interrupt, streaming input,
// teardown. This is the real production entry point (Task 4's main.ts calls it directly);
// runWinterRuntime above is a compatibility adapter over it.
export { runEngine } from "./engine.ts";
export type {
  Provider,
  ProviderTurn,
  ProviderMessage,
  ContentBlock,
  ToolExecutor,
  SessionPersistence,
  EngineOptions,
  // Phase 5 Task 2 (R5-3): the provider-seam extension. Named on the barrel because the consumers
  // that live OUTSIDE this package -- packages/sdk/src/transport-equivalence.test.ts and
  // scripts/differential.ts, neither of which can use a relative import -- are exactly the ones T8
  // needs for a cross-leg `system`/usage scenario. Lanes use relative imports and do not need this.
  ProviderRequest,
  ProviderUsage,
  ContextAccountant,
  ContextAccountantOptions,
} from "./engine.ts";
export { createContextAccountant, DEFAULT_CONTEXT_WINDOW_TOKENS } from "./engine.ts";
// Phase 5 Task 2: the mock family's `system` recorder (provider/mock.ts) -- same out-of-package
// reasoning as above; T8's cross-leg assertion reads it from here.
export { recordedProviderSystems, resetRecordedProviderSystems } from "./provider/mock.ts";
// Phase 5 Task 2 (R5-4 / WS-09 §8.5): the compaction reset seam.
export { onCompaction } from "./tools/registry.ts";

export { createInMemoryChannel } from "./protocol/channel.ts";
export type { Duplex, FrameSource, FrameSink } from "./protocol/channel.ts";

// Task 2 (WS-04 §3.1): the runtime's half of the bidirectional control-RPC bridge — re-exported so
// later tasks (permission/hook RPCs, Tasks 8/10) can reach it from outside engine.ts without a deep
// import.
export { createRpcBridge } from "./rpc/bridge.ts";
export type { RpcBridge } from "./rpc/bridge.ts";

export {
  echoProvider,
  scriptedProvider,
  stubExecutor,
  isTestProviderName,
  testProviderByName,
  registerBgTaskTestTool,
  BGTASK_TEST_TOOL_NAME,
  MCP_SDK_TEST_SERVER_NAME,
  // Phase 4 Task 8 (riders 6/25): the subagent/messaging equivalence fixtures' own shared literal.
  SUBAGENT_CHILD_PROBE_TEXT,
  // Phase 5 Task 8: the two shared literals the P5 equivalence fixtures and their scenarios both
  // need -- the fixture skill's name and the workflow script -- exported for the same reason every
  // sibling above is: a hand-copied literal in a test file is a producer/consumer pair that can
  // drift silently.
  P5_FIXTURE_SKILL_NAME,
  P5_WORKFLOW_SCRIPT,
  MCP_SDK_TEST_TOOL_NAME,
} from "./provider/mock.ts";
export type { TestProviderName } from "./provider/mock.ts";

// Phase 3 Task 2 (WS-06 §3.5): the tool-registration seam (Task 1, packages/runtime/src/tools/
// registry.ts) was package-internal until now -- re-exported so packages/sdk/src/transport-
// equivalence.test.ts (an sdk-package test, one layer up from this package) can register its own
// scripted background-task-emitting tool the SAME way testing.ts's own registerEquivalenceStandIn
// does, rather than reaching past this package's public surface with a deep relative import. Only
// the registration FUNCTION is exported, not the descriptor/executor/disposition types it takes --
// TS's contextual typing already fully checks an object literal passed directly as registerTool's
// own argument (this file's one new consumer does exactly that), so nothing else needs a name here.
export { registerTool } from "./tools/registry.ts";

// Paths (Task 6): WINTER_HOME resolution, the exact CC-compatible project-key algorithm, and the
// D18 per-session temp resolver — consumed by the store (Task 7), the dialect writer (Task 8), and
// resume (Task 9). Task 10 moved home.ts/project-key.ts/keys.ts into the sdk package (WS-05 §6) —
// re-exported here unchanged (pass-through) so existing runtime-side imports of
// `winter-agent-runtime` (e.g. packages/sdk/src/transport-equivalence.test.ts) keep compiling.
// temp.ts/project-dir-name.ts stay runtime-private, unaffected.
export { resolveWinterHome } from "@yanlinglabs/winter-agent-sdk";
export { transcriptProjectKey } from "@yanlinglabs/winter-agent-sdk";
export { compatibilityKeys } from "@yanlinglabs/winter-agent-sdk";
export type { CompatibilityKeys } from "@yanlinglabs/winter-agent-sdk";
export { sessionTempDir, ensureTasksDir, WinterPathsError } from "./paths/temp.ts";
export type { SessionTempDirOptions, SessionTempDirPaths } from "./paths/temp.ts";
// Controller Ruling P1-N: WINTER_PROJECT_DIR_NAME override for the PERSISTENT transcript-project
// directory name only — never the temp cwd segment above. A store consumer calls this to compute
// the projectKey it passes as SessionKey.projectKey; recording/reapplying it across resume is
// Task 9's job (see store/session-store.ts's task-7-report.md seam note).
export { resolveProjectDirName } from "./paths/project-dir-name.ts";

// The filesystem SessionStore (Task 7, WS-05 §6): the pinned WS-03 §10 SessionStore/SessionKey/
// SessionStoreEntry/SessionSummaryEntry type family plus the concrete filesystem-backed store and
// its typed errors (leases.ts). Task 10 moved the store+type into the sdk package (Controller
// Ruling P1-O anticipated exactly this) — re-exported here unchanged (pass-through), same as the
// paths re-exports above.
export {
  WinterCompatibilitySessionStore,
  WinterStoreError,
  WinterStoreLeaseError,
  DIALECT_RECORD_ENTRY_TYPE,
} from "@yanlinglabs/winter-agent-sdk";
export type { SessionKey, SessionStoreEntry, SessionSummaryEntry, SessionStore } from "@yanlinglabs/winter-agent-sdk";

// The Claude-dialect transcript writer/reader (Task 8, WS-05 §5.2): converts engine turn content
// into Claude-transcript-compatible JSONL entries and appends them through the store above.
// resolveEngineSession/resolveProductionWinterHome are the shared wiring main.ts and testing.ts
// both call to honor RuntimeConfig.persistSession and (Task 9) continue/resume/forkSession/
// resumeSessionAt — resolveEngineSession replaces Task 8's createTranscriptPersistence, which did
// only the persistSession/store-construction half of what it now does.
export {
  userEntry,
  assistantEntry,
  TranscriptWriter,
  TranscriptWriterError,
  RUNTIME_ENGINE_VERSION,
  resolveEngineSession,
  resolveProductionWinterHome,
} from "./store/dialect.ts";
export type { Block, Chain, SessionCtx, DialectEntryBase, UserEntryOpts, TranscriptWriterOptions, ResolvedEngineSession } from "./store/dialect.ts";

// Resume/continue/resume-at (Task 9, WS-05 §7): the pure store-level primitives resume.ts
// implements and resolveEngineSession above orchestrates. Task 10 relocated the fourth primitive,
// forkSession, to the sdk package alongside the store (exported above as `forkSessionByKey` is
// NOT re-exported from here: nothing outside this file imported `forkSession` via this package's
// own index before the move -- dialect.ts, this index's only internal-ish consumer, now imports it
// directly from the sdk -- so there is nothing to preserve pass-through compatibility for; see
// task-10-report.md).
export { findContinueTarget, findResumeTarget, truncateAt, toDialectEntries, rebuildProviderMessages, ResumeTargetError, ResumeTruncationError } from "./store/resume.ts";
export type { DialectEntry } from "./store/resume.ts";

// The wire protocol (frames + codec) moved to the sdk (WS-02 §3 dependency inversion, Task 1):
// this package now depends on it, never the reverse. Re-exported unchanged so existing
// runtime-side imports of `winter-agent-runtime` keep compiling.
export {
  PROTOCOL_VERSION,
  encodeFrame,
  decodeFrame,
  splitFrames,
  ProtocolError,
} from "@yanlinglabs/winter-agent-sdk";

export type {
  ProtocolVersion,
  WinterFrame,
  ProtocolSdkMessage as SdkMessage,
  InitFrame,
  UserFrame,
  DataFrame,
  ControlRequestFrame,
  ControlResponseFrame,
  UnknownFrame,
  RuntimeConfig,
} from "@yanlinglabs/winter-agent-sdk";
