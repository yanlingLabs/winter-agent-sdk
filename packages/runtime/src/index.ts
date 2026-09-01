// Package entry point for `winter-agent-runtime`. Re-exports the full surface
// consumed by the SDK wrapper (Task 7): the runtime entry point, the
// in-memory channel constructor + its types, the mock provider + its type,
// and the wire-protocol types (frames + SDK messages).

export { runWinterRuntime } from "./runtime.ts";

export { createInMemoryChannel } from "./protocol/channel.ts";
export type { Duplex, FrameSource, FrameSink } from "./protocol/channel.ts";

export { echoProvider } from "./provider/mock.ts";
export type { Provider } from "./provider/mock.ts";

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
} from "@yanlinglabs/winter-agent-sdk";
