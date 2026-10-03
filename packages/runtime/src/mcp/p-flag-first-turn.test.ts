import { describe, expect, test } from "bun:test";
import { firstTurnMcpWaitDeadlineMs, FIRST_TURN_MCP_WAIT_DEFAULT_MS } from "./lifecycle.ts";
import { parseMcpEnvConfig } from "./env.ts";

// WS-09 §2 ("Non-interactive `-p` mode has additional first-turn waiting behavior and MUST be
// treated as a separate lifecycle path with its own fixtures") / §12 Open Question 5.
//
// The behaviour pinned here: before the FIRST turn of an SDK-driven session, claude waits for its
// configured MCP servers to settle (connected, failed or needs-auth) up to a deadline; later turns read
// live state without waiting, and `system/init` is built after that wait. The deadline is 2000 ms by
// default, and MCP_TIMEOUT (default 30000) when the explicit MCP config asks for the long wait: strict
// MCP config is on, or any explicitly supplied server is not an in-process `sdk` server. The agent SDK
// hands a host's `mcpServers` to claude as its explicit MCP config.
//
// Winter maps the explicit MCP config onto `RuntimeConfig.mcpServers` and strict mode onto
// `RuntimeConfig.strictMcpConfig`; engine.ts waits before the startup `system/init`, which it writes
// once before the first turn. History: added in 054344d, removed in 171dec8 on a ruling from a
// measurement whose bun-launched fixtures started past 2000 ms, restored in fix round 20 after the
// re-review overturned that ruling.
describe("MCP first-turn wait (WS-09 §2 / §12 Q5, fix round 19)", () => {
  const env = parseMcpEnvConfig({});

  test("no explicit servers: the default deadline, 2000 ms", () => {
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

  test("a server entry with no readable `type` (null, a string, a missing field) counts as non-sdk", () => {
    expect(firstTurnMcpWaitDeadlineMs({ explicitServers: { a: null }, envConfig: env })).toBe(30000);
    expect(firstTurnMcpWaitDeadlineMs({ explicitServers: { a: "sdk" }, envConfig: env })).toBe(30000);
    expect(firstTurnMcpWaitDeadlineMs({ explicitServers: { a: undefined }, envConfig: env })).toBe(30000);
    expect(firstTurnMcpWaitDeadlineMs({ explicitServers: { a: {} }, envConfig: env })).toBe(30000);
  });

  test("only the exact lowercase `sdk` type is in-process", () => {
    expect(firstTurnMcpWaitDeadlineMs({ explicitServers: { a: { type: "SDK" } }, envConfig: env })).toBe(30000);
    expect(firstTurnMcpWaitDeadlineMs({ explicitServers: { a: { type: " sdk" } }, envConfig: env })).toBe(30000);
    expect(firstTurnMcpWaitDeadlineMs({ explicitServers: { a: { type: "sdk" }, b: { type: "sdk" } }, envConfig: env })).toBe(2000);
  });

  test("strictMcpConfig counts only when it is exactly `true`", () => {
    expect(firstTurnMcpWaitDeadlineMs({ strictMcpConfig: false, envConfig: env })).toBe(2000);
    expect(firstTurnMcpWaitDeadlineMs({ strictMcpConfig: "true" as unknown as boolean, envConfig: env })).toBe(2000);
    expect(firstTurnMcpWaitDeadlineMs({ strictMcpConfig: true, explicitServers: { a: { type: "sdk" } }, envConfig: env })).toBe(30000);
  });

  test("the long wait returns the configured timeout as given, whatever its value", () => {
    expect(firstTurnMcpWaitDeadlineMs({ strictMcpConfig: true, envConfig: { timeoutMs: 0 } })).toBe(0);
    expect(firstTurnMcpWaitDeadlineMs({ strictMcpConfig: true, envConfig: { timeoutMs: 1 } })).toBe(1);
    expect(firstTurnMcpWaitDeadlineMs({ envConfig: { timeoutMs: 1 } })).toBe(2000);
  });
});
