import { describe, expect, test } from "bun:test";
import { firstTurnMcpWaitDeadlineMs, FIRST_TURN_MCP_WAIT_DEFAULT_MS } from "./lifecycle.ts";
import { parseMcpEnvConfig } from "./env.ts";

// WS-09 §2 ("Non-interactive `-p` mode has additional first-turn waiting behavior and MUST be
// treated as a separate lifecycle path with its own fixtures") / §12 Open Question 5. Capture-pending
// until fix round 19; the capture is the pinned 2.1.250 binary itself (the strings dump):
//
//   - The SDK drives claude's one headless runner: stream-json input requires `--print` (24230915)
//     and the print entry calls `runHeadless` (24425107). Configured servers are already `pending`
//     when it starts -- `zAn` (24253401) adds each synchronously, user-scope `.claude.json` servers
//     included (`qk`, 17839163).
//   - `runHeadless` starts `sf = km(p, Jl, {waitForDeferrable:true, …})` at setup (34005856) and the
//     first command awaits it (34017496); every later turn reads live state without waiting.
//   - `km(e,t=2000,o={})` (34109614) polls every pending server until none is pending or the deadline
//     passes; a connected, failed or needs-auth server has settled.
//   - The deadline comes from `e_` (34109559): `explicitMcpConfigFlag && !sdkUrl ? ic() : undefined`,
//     so `km`'s own 2000 ms unless the explicit MCP config asks for the long wait, `ic()` =
//     MCP_TIMEOUT (16259760, default 30000). `explicitMcpConfigFlag` is
//     `OL(mcpConfigFlagServers, strictMcpConfig)` = `strictMcpConfig || any --mcp-config server is
//     not "sdk"`; the agent SDK passes a host's `mcpServers` as `--mcp-config` and never `--sdk-url`.
//   - `system/init` is built inside each query (33881679), after the wait.
//
// Winter maps `--mcp-config` onto `RuntimeConfig.mcpServers` and `--strict-mcp-config` onto
// `RuntimeConfig.strictMcpConfig`; engine.ts waits before the startup `system/init`, which it writes
// once before the first turn. History: ported in 054344d, removed in 171dec8 on a ruling from a
// measurement whose bun-launched fixtures started past 2000 ms, restored in fix round 20 after the
// re-review overturned that ruling from this trail.
describe("MCP first-turn wait (WS-09 §2 / §12 Q5; claude's `km`, fix round 19)", () => {
  const env = parseMcpEnvConfig({});

  test("no explicit servers: km's own default, 2000 ms", () => {
    expect(FIRST_TURN_MCP_WAIT_DEFAULT_MS).toBe(2000);
    expect(firstTurnMcpWaitDeadlineMs({ envConfig: env })).toBe(2000);
    expect(firstTurnMcpWaitDeadlineMs({ explicitServers: {}, envConfig: env })).toBe(2000);
  });

  test("explicit servers that are ALL in-process sdk servers: still 2000 ms (the daemon's capability-server shape)", () => {
    expect(firstTurnMcpWaitDeadlineMs({ explicitServers: { cap: { type: "sdk", name: "cap" } }, envConfig: env })).toBe(2000);
  });

  test("any explicit non-sdk server (stdio with or without `type`, http): the long wait, MCP_TIMEOUT", () => {
    expect(firstTurnMcpWaitDeadlineMs({ explicitServers: { a: { command: "x" } }, envConfig: env })).toBe(30000);
    expect(firstTurnMcpWaitDeadlineMs({ explicitServers: { cap: { type: "sdk", name: "cap" }, h: { type: "http", url: "http://127.0.0.1:1/mcp" } }, envConfig: env })).toBe(30000);
  });

  test("strictMcpConfig alone asks for the long wait too", () => {
    expect(firstTurnMcpWaitDeadlineMs({ strictMcpConfig: true, envConfig: env })).toBe(30000);
  });

  test("the long wait is MCP_TIMEOUT as configured, not a fixed number", () => {
    expect(firstTurnMcpWaitDeadlineMs({ explicitServers: { a: { command: "x" } }, envConfig: parseMcpEnvConfig({ MCP_TIMEOUT: "9000" }) })).toBe(9000);
  });
});
