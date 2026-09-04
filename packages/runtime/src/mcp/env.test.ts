// Phase 4 Task 2: mcp/env.ts's exact value-semantics pins (WS-09 §2/§7/§8.1). Every test passes an
// explicit env object -- never touches the real process.env.
import { describe, test, expect } from "bun:test";
import { parseMcpEnvConfig } from "./env.ts";

describe("parseMcpEnvConfig: ENABLE_TOOL_SEARCH (WS-09 §8.1)", () => {
  test("absent -> 'unset'", () => {
    expect(parseMcpEnvConfig({}).enableToolSearch).toBe("unset");
  });
  test("'true' / 'false' / 'auto' pass through exactly", () => {
    expect(parseMcpEnvConfig({ ENABLE_TOOL_SEARCH: "true" }).enableToolSearch).toBe("true");
    expect(parseMcpEnvConfig({ ENABLE_TOOL_SEARCH: "false" }).enableToolSearch).toBe("false");
    expect(parseMcpEnvConfig({ ENABLE_TOOL_SEARCH: "auto" }).enableToolSearch).toBe("auto");
  });
  test("'auto:N' parses the custom percentage threshold", () => {
    expect(parseMcpEnvConfig({ ENABLE_TOOL_SEARCH: "auto:15" }).enableToolSearch).toEqual({ auto: 15 });
    expect(parseMcpEnvConfig({ ENABLE_TOOL_SEARCH: "auto:2.5" }).enableToolSearch).toEqual({ auto: 2.5 });
  });
  test("an unrecognized spelling degrades to 'unset' rather than throwing (CAPTURE-PENDING case-sensitivity)", () => {
    expect(parseMcpEnvConfig({ ENABLE_TOOL_SEARCH: "TRUE" }).enableToolSearch).toBe("unset");
    expect(parseMcpEnvConfig({ ENABLE_TOOL_SEARCH: "yes" }).enableToolSearch).toBe("unset");
    expect(parseMcpEnvConfig({ ENABLE_TOOL_SEARCH: "auto:" }).enableToolSearch).toBe("unset");
    expect(parseMcpEnvConfig({ ENABLE_TOOL_SEARCH: "auto:abc" }).enableToolSearch).toBe("unset");
    expect(() => parseMcpEnvConfig({ ENABLE_TOOL_SEARCH: "garbage" })).not.toThrow();
  });
});

describe("parseMcpEnvConfig: MCP_CONNECTION_NONBLOCKING (WS-09 §2)", () => {
  test("absent -> nonblocking (true), the documented default", () => {
    expect(parseMcpEnvConfig({}).connectionNonblocking).toBe(true);
  });
  test("exactly '0' -> false (forces the startup-blocking override)", () => {
    expect(parseMcpEnvConfig({ MCP_CONNECTION_NONBLOCKING: "0" }).connectionNonblocking).toBe(false);
  });
  test("any other value (including '1'/'false') leaves the nonblocking default untouched", () => {
    expect(parseMcpEnvConfig({ MCP_CONNECTION_NONBLOCKING: "1" }).connectionNonblocking).toBe(true);
    expect(parseMcpEnvConfig({ MCP_CONNECTION_NONBLOCKING: "false" }).connectionNonblocking).toBe(true);
  });
});

describe("parseMcpEnvConfig: timeouts (WS-09 §2)", () => {
  test("MCP_CONNECT_TIMEOUT_MS defaults to 5000 and parses a valid override", () => {
    expect(parseMcpEnvConfig({}).connectTimeoutMs).toBe(5000);
    expect(parseMcpEnvConfig({ MCP_CONNECT_TIMEOUT_MS: "9000" }).connectTimeoutMs).toBe(9000);
  });
  test("MCP_TIMEOUT defaults to 30000 and parses a valid override", () => {
    expect(parseMcpEnvConfig({}).timeoutMs).toBe(30000);
    expect(parseMcpEnvConfig({ MCP_TIMEOUT: "60000" }).timeoutMs).toBe(60000);
  });
  test("a non-numeric or non-positive value falls back to the default rather than throwing", () => {
    expect(parseMcpEnvConfig({ MCP_CONNECT_TIMEOUT_MS: "not-a-number" }).connectTimeoutMs).toBe(5000);
    expect(parseMcpEnvConfig({ MCP_CONNECT_TIMEOUT_MS: "0" }).connectTimeoutMs).toBe(5000);
    expect(parseMcpEnvConfig({ MCP_CONNECT_TIMEOUT_MS: "-100" }).connectTimeoutMs).toBe(5000);
  });
  test("MCP_TOOL_TIMEOUT has no documented default -- absent unless a valid positive value is set", () => {
    expect(parseMcpEnvConfig({}).toolTimeoutMs).toBeUndefined();
    expect(parseMcpEnvConfig({ MCP_TOOL_TIMEOUT: "garbage" }).toolTimeoutMs).toBeUndefined();
    expect(parseMcpEnvConfig({ MCP_TOOL_TIMEOUT: "1234" }).toolTimeoutMs).toBe(1234);
  });
});

describe("parseMcpEnvConfig: MCP_DISCOVERY_CACHE (WS-09 §2/§12 Open Question 2)", () => {
  test("off by default", () => {
    expect(parseMcpEnvConfig({}).discoveryCache).toBe(false);
  });
  test("exactly '1' turns it on", () => {
    expect(parseMcpEnvConfig({ MCP_DISCOVERY_CACHE: "1" }).discoveryCache).toBe(true);
  });
  test("any other value stays off", () => {
    expect(parseMcpEnvConfig({ MCP_DISCOVERY_CACHE: "true" }).discoveryCache).toBe(false);
    expect(parseMcpEnvConfig({ MCP_DISCOVERY_CACHE: "yes" }).discoveryCache).toBe(false);
  });
});

describe("parseMcpEnvConfig: MAX_MCP_OUTPUT_TOKENS (WS-09 §7)", () => {
  test("defaults to 25000 (R4-8 capture-pending default)", () => {
    expect(parseMcpEnvConfig({}).maxOutputTokens).toBe(25000);
  });
  test("parses a valid override", () => {
    expect(parseMcpEnvConfig({ MAX_MCP_OUTPUT_TOKENS: "50000" }).maxOutputTokens).toBe(50000);
  });
  test("an invalid value falls back to the default", () => {
    expect(parseMcpEnvConfig({ MAX_MCP_OUTPUT_TOKENS: "0" }).maxOutputTokens).toBe(25000);
    expect(parseMcpEnvConfig({ MAX_MCP_OUTPUT_TOKENS: "abc" }).maxOutputTokens).toBe(25000);
  });
});

test("parseMcpEnvConfig is a pure function of its input -- never reads the real process.env", () => {
  const before = process.env.ENABLE_TOOL_SEARCH;
  parseMcpEnvConfig({ ENABLE_TOOL_SEARCH: "true" });
  expect(process.env.ENABLE_TOOL_SEARCH).toBe(before); // untouched
});
