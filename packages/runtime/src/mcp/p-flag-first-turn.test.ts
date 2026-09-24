import { describe, expect, test } from "bun:test";
import { firstTurnMcpWaitDeadlineMs, FIRST_TURN_MCP_WAIT_DEFAULT_MS } from "./lifecycle.ts";
import { parseMcpEnvConfig } from "./env.ts";

// WS-09 §2 ("Non-interactive `-p` mode has additional first-turn waiting behavior and MUST be
// treated as a separate lifecycle path with its own fixtures") / §12 Open Question 5. This file was
// a CAPTURE-PENDING `test.skip` until fix round 19: no deadline had been pinned, and none was to be
// guessed. The capture is now the pinned 2.1.250 binary itself (the strings dump), traced end to end:
//
//   - `runHeadless` starts `km(getState, deadlineMs, {waitForDeferrable:true, localOnly, …})` at
//     entry and awaits it before the FIRST turn only (dump byte 34005858 / 34017501: `if(bt){bt=!1;…
//     tS("before_mcp_prewait");… await km(…) / await sf …}`), then reads live state for the turn.
//   - `km(e,t=2000,o={})` (34109614) polls every 50 ms until no pending client is left or the
//     deadline passes; a connected, failed or needs-auth server has settled.
//   - The deadline comes from `e_` (34109559): `deadlineMs: e.explicitMcpConfigFlag && !sdkUrl ?
//     ic() : undefined`, so `km`'s own default of 2000 ms unless the session's explicit MCP config
//     asks for the long wait, which is `ic()` = MCP_TIMEOUT (16259760, default 30000).
//   - `explicitMcpConfigFlag` is `OL(mcpConfigFlagServers, strictMcpConfig)` (34109559 / 24419236):
//     `strictMcpConfig || Object.values(servers).some((s) => s.type !== "sdk")` (claude's
//     `!isBridgeCarrierChild` clause has no Winter counterpart). The agent SDK passes a host's
//     `mcpServers` as `--mcp-config` and never `--sdk-url` (verified in claude-agent-sdk 0.3.250's
//     sdk.mjs), so for an SDK-driven session `localOnly` is false and every pending server is waited on.
//
// Winter maps `--mcp-config` onto `RuntimeConfig.mcpServers` (the host's explicit servers) and
// `--strict-mcp-config` onto `RuntimeConfig.strictMcpConfig`. `engine.ts` applies the wait before the
// startup `system/init`, which Winter writes once before the first turn (see its own call site).
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
