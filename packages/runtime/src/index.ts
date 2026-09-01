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
