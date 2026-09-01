import { createInMemoryChannel, runWinterRuntime, echoProvider } from "winter-agent-runtime";
import type { Duplex } from "winter-agent-runtime";
import type { SpawnRuntime } from "./options.ts";

// P0 default: in-memory runtime with the echo provider. P1 replaces this with a child-process spawner (WS-04 §8).
export const defaultSpawnRuntime: SpawnRuntime = ({ cwd, model }): Duplex => {
  const { host, runtime } = createInMemoryChannel();
  void runWinterRuntime({ input: runtime.input, output: runtime.output, provider: echoProvider, sessionId: "s_" + Math.random().toString(16).slice(2), cwd, model });
  return host;
};
