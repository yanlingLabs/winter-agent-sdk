// Package entry point for `winter-agent-runtime`. Re-exports the full surface
// consumed by the SDK wrapper (Task 7): the runtime entry point, the
// in-memory channel constructor + its types, the mock provider + its type,
// and the wire-protocol types (frames + SDK messages).

export { runWinterRuntime } from "./runtime.ts";

export { createInMemoryChannel } from "./protocol/channel.ts";
export type { Duplex, FrameSource, FrameSink } from "./protocol/channel.ts";

export { echoProvider } from "./provider/mock.ts";
export type { Provider } from "./provider/mock.ts";

export type {
  ProtocolVersion,
  WinterFrame,
  SdkMessage,
  InitFrame,
  UserFrame,
  DataFrame,
  ControlRequestFrame,
  ControlResponseFrame,
  UnknownFrame,
} from "./protocol/frames.ts";
