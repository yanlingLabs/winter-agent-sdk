// WS-24 (cross-lane): `@yanlinglabs/winter-agent-runtime/mcp-client` resolves by its PUBLIC specifier and
// is the real client -- a host connects a stdio server and calls a tool through it.
import { expect, test } from "bun:test";
import { connectMcpServer, createElicitationAsker, McpConnectError, type ConnectedMcpClient, type ConnectMcpServerOptions } from "@yanlinglabs/winter-agent-runtime/mcp-client";
import * as internal from "./mcp/client.ts";
import { pingFixtureCommand } from "./mcp/test-fixtures.ts";

test("the public subpath resolves, and its error class is the runtime's own (not a copy)", () => {
  expect(typeof connectMcpServer).toBe("function");
  expect(McpConnectError).toBe(internal.McpConnectError);
});

test("the public options are the host-shaped subset: an in-process `sdk` config is not something a host can pass", () => {
  // @ts-expect-error -- `type: "sdk"` is excluded from the public config type
  const opts: ConnectMcpServerOptions = { name: "x", config: { type: "sdk", name: "x" }, connectTimeoutMs: 1, elicitationAsk: createElicitationAsker(undefined) };
  void opts;
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
