// WS-24 (cross-lane): `@yanlinglabs/winter-agent-runtime/mcp-client` resolves by its PUBLIC specifier and
// is the real client -- a host connects a stdio server and calls a tool through it.
import { expect, test } from "bun:test";
import { connectMcpServer, createElicitationAsker, McpConnectError, type ConnectedMcpClient } from "@yanlinglabs/winter-agent-runtime/mcp-client";
import * as internal from "./mcp/client.ts";
import { pingFixtureCommand } from "./mcp/test-fixtures.ts";

test("the public subpath resolves to the runtime's own client (not a copy)", () => {
  expect(connectMcpServer).toBe(internal.connectMcpServer);
  expect(McpConnectError).toBe(internal.McpConnectError);
});

test("a host connects, lists and calls through it; a failure is a typed McpConnectError", async () => {
  const client: ConnectedMcpClient = await connectMcpServer({ name: "host-side", config: pingFixtureCommand({ label: "host" }), cwd: process.cwd(), connectTimeoutMs: 5000, elicitationAsk: createElicitationAsker(undefined) });
  try {
    expect((await client.listTools()).map((t) => t.name)).toEqual(["gate_ping"]);
    expect(await client.callTool("gate_ping", {})).toEqual({ content: [{ type: "text", text: "PONG-host" }] });
  } finally {
    await client.close();
  }
  await expect(connectMcpServer({ name: "missing", config: { command: "/no/such/winter-mcp-binary" }, cwd: process.cwd(), connectTimeoutMs: 2000, elicitationAsk: createElicitationAsker(undefined) })).rejects.toBeInstanceOf(McpConnectError);
}, 15_000);
