import { WinterSDKError } from "./errors.ts";
import type { SpawnRuntime } from "./options.ts";

// P0 shipped an in-memory default (echo provider) wired straight to winter-agent-runtime here.
// Severing the sdk→runtime dependency (WS-02 §3) removes it: the published wrapper must not
// depend on the private runtime. Task 2 lands the real default (a child process resolved via
// spawnClaudeCodeProcess / pathToClaudeCodeExecutable). Until then every caller injects
// spawnRuntime explicitly — tests and the differential harness use winter-agent-runtime/testing's
// inMemorySpawn().
export const defaultSpawnRuntime: SpawnRuntime = () => {
  throw new WinterSDKError("no runtime transport configured — pass spawnClaudeCodeProcess or pathToClaudeCodeExecutable (Task 2)");
};
