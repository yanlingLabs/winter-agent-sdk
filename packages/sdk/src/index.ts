export { query } from "./query.ts";
export type { Query, SdkMessage } from "./query.ts";
export type { Options, SpawnRuntime } from "./options.ts";
export { WinterSDKError, CLIConnectionError, ProcessError, ResultError, ProtocolDecodeError } from "./errors.ts";

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
