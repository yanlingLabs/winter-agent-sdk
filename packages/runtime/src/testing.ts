import type { SpawnRuntime } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "./protocol/channel.ts";
import { runWinterRuntime } from "./runtime.ts";
import { echoProvider, type Provider } from "./provider/mock.ts";

// P0 test/differential seam: boots the in-memory runtime against a chosen provider and hands back
// a spawnRuntime hook shaped for the sdk's Options.spawnRuntime. Moved out of
// packages/sdk/src/query.test.ts's inline helper now that the sdk no longer default-spawns a
// runtime (WS-02 §3) — every consumer (query.test.ts, scripts/differential.ts) injects this
// explicitly.
export function inMemorySpawn(provider: Provider = echoProvider): SpawnRuntime {
  return ({ cwd, model }) => {
    const { host, runtime } = createInMemoryChannel();
    void runWinterRuntime({ input: runtime.input, output: runtime.output, provider, sessionId: "s_test", cwd, model });
    return host;
  };
}
