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
} from "./engine.ts";

export { createInMemoryChannel } from "./protocol/channel.ts";
export type { Duplex, FrameSource, FrameSink } from "./protocol/channel.ts";

export { echoProvider, scriptedProvider, stubExecutor, isTestProviderName, testProviderByName } from "./provider/mock.ts";
export type { TestProviderName } from "./provider/mock.ts";

// Paths (Task 6): WINTER_HOME resolution, the exact CC-compatible project-key algorithm, and the
// D18 per-session temp resolver — consumed by the store (Task 7), the dialect writer (Task 8), and
// resume (Task 9).
export { resolveWinterHome } from "./paths/home.ts";
export { transcriptProjectKey } from "./paths/project-key.ts";
export { compatibilityKeys } from "./paths/keys.ts";
export type { CompatibilityKeys } from "./paths/keys.ts";
export { sessionTempDir, ensureTasksDir, WinterPathsError } from "./paths/temp.ts";
export type { SessionTempDirOptions, SessionTempDirPaths } from "./paths/temp.ts";
// Controller Ruling P1-N: WINTER_PROJECT_DIR_NAME override for the PERSISTENT transcript-project
// directory name only — never the temp cwd segment above. A store consumer calls this to compute
// the projectKey it passes as SessionKey.projectKey; recording/reapplying it across resume is
// Task 9's job (see store/session-store.ts's task-7-report.md seam note).
export { resolveProjectDirName } from "./paths/project-dir-name.ts";

// The filesystem SessionStore (Task 7, WS-05 §6): the pinned WS-03 §10 SessionStore/SessionKey/
// SessionStoreEntry/SessionSummaryEntry type family (authored here per Controller Ruling P1-O —
// Task 10 relocates store+type into the sdk package) plus the concrete filesystem-backed store and
// its typed errors (leases.ts).
export {
  WinterCompatibilitySessionStore,
  WinterStoreError,
  WinterStoreLeaseError,
  DIALECT_RECORD_ENTRY_TYPE,
} from "./store/session-store.ts";
export type { SessionKey, SessionStoreEntry, SessionSummaryEntry, SessionStore } from "./store/session-store.ts";

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

// Resume/continue/fork/resume-at (Task 9, WS-05 §7): the pure store-level primitives resume.ts
// implements and resolveEngineSession above orchestrates.
export { findContinueTarget, findResumeTarget, forkSession, truncateAt, toDialectEntries, rebuildProviderMessages, ResumeTargetError, ResumeTruncationError } from "./store/resume.ts";
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
