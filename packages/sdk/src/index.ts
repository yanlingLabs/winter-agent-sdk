export { query } from "./query.ts";
export type { Query, SdkMessage } from "./query.ts";
export type { Options } from "./options.ts";
export { WinterSDKError, CLIConnectionError, ProcessError, ResultError, ProtocolDecodeError, AbortError } from "./errors.ts";

// The pinned process seam (WS-04 §8) — byte-level SpawnedRuntimeProcess handle, shared by the real
// child transport and winter-agent-runtime/testing's in-memory transport (Task 2).
export { resolveRuntimeExecutable, defaultSpawn } from "./transport.ts";
export type { SpawnedRuntimeProcess, SpawnRuntimeOptions, SpawnClaudeCodeProcess } from "./transport.ts";
export type { RuntimeConfig } from "./protocol/config.ts";

// Wire protocol (WS-02 §3: owned by the sdk, the runtime depends on it — never the reverse).
// Previously reachable only via the runtime; now the sdk's own public surface.
export { encodeFrame, decodeFrame, splitFrames, ProtocolError } from "./protocol/codec.ts";
export { PROTOCOL_VERSION } from "./protocol/frames.ts";
// Aliased: `SdkMessage` above is query()'s CLOSED result union (WS-03 §8). This is the wire-level
// OPEN union frames carry (system/assistant/result + a lossless unknown-kind catch-all) — the two
// can't share a name in one barrel.
export type {
  ProtocolVersion,
  WinterFrame,
  SdkMessage as ProtocolSdkMessage,
  InitFrame,
  UserFrame,
  DataFrame,
  ControlRequestFrame,
  ControlResponseFrame,
  UnknownFrame,
} from "./protocol/frames.ts";
