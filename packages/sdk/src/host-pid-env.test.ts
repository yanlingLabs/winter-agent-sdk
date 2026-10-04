// `defaultSpawn` tells the runtime which pid is its host (`SpawnRuntimeOptions.hostPidEnv`), so the
// runtime can stop when the host dies -- even during its own startup. `query()` names the variable
// from the session's brand.
import { expect, test } from "bun:test";
import { defaultSpawn, type SpawnRuntimeOptions } from "./transport.ts";
import { query } from "./query.ts";
import { inMemoryProcess } from "@yanlinglabs/winter-agent-runtime/testing";

test("defaultSpawn puts THIS process's pid in the named variable of the child's environment", async () => {
  const proc = defaultSpawn({ command: "/usr/bin/env", args: [], cwd: process.cwd(), env: { PATH: "/usr/bin:/bin" }, hostPidEnv: "SOME_HOST_PID" });
  let out = "";
  for await (const chunk of proc.stdout) out += chunk;
  await proc.exited;
  expect(out.split("\n")).toContain(`SOME_HOST_PID=${process.pid}`);
});

test("without hostPidEnv, defaultSpawn passes the environment through untouched", async () => {
  const proc = defaultSpawn({ command: "/usr/bin/env", args: [], cwd: process.cwd(), env: { PATH: "/usr/bin:/bin" } });
  let out = "";
  for await (const chunk of proc.stdout) out += chunk;
  await proc.exited;
  expect(out).not.toContain("HOST_PID=");
});

test("query() names the variable from the brand's env prefix", async () => {
  const seen: SpawnRuntimeOptions[] = [];
  const gen = query({
    prompt: "hi",
    options: {
      model: "winter-test/echo",
      spawnClaudeCodeProcess: (opts) => {
        seen.push(opts);
        return inMemoryProcess(opts.args);
      },
    },
  });
  for await (const _ of gen) {
    /* drain */
  }
  expect(seen[0]!.hostPidEnv).toBe("WINTER_HOST_PID");
});
