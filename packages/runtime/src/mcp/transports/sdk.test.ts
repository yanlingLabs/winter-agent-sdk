import { describe, test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildSdkTransport } from "./sdk.ts";
import { createFixtureMcpServer, defaultFixtureSpec } from "../test-fixtures.ts";

describe("buildSdkTransport: in-process @modelcontextprotocol/sdk McpServer over InMemoryTransport", () => {
  test("connects, lists tools, calls a tool, and closes cleanly", async () => {
    const server = createFixtureMcpServer(defaultFixtureSpec());
    const clientTransport = await buildSdkTransport(server);
    const client = new Client({ name: "sdk-transport-test", version: "1.0.0" });
    try {
      await client.connect(clientTransport, { timeout: 5000 });
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual(["boom", "echo"]);
      const result = await client.callTool({ name: "echo", arguments: { text: "hi" } }, undefined, { timeout: 5000 });
      expect(result).toEqual({ content: [{ type: "text", text: "echo:hi" }] });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("is re-usable: each call produces an independent, freshly-linked pair", async () => {
    const serverA = createFixtureMcpServer(defaultFixtureSpec());
    const serverB = createFixtureMcpServer(defaultFixtureSpec());
    const [transportA, transportB] = await Promise.all([buildSdkTransport(serverA), buildSdkTransport(serverB)]);
    const clientA = new Client({ name: "a", version: "1.0.0" });
    const clientB = new Client({ name: "b", version: "1.0.0" });
    try {
      await Promise.all([clientA.connect(transportA, { timeout: 5000 }), clientB.connect(transportB, { timeout: 5000 })]);
      const [resultA, resultB] = await Promise.all([
        clientA.callTool({ name: "echo", arguments: { text: "A" } }, undefined, { timeout: 5000 }),
        clientB.callTool({ name: "echo", arguments: { text: "B" } }, undefined, { timeout: 5000 }),
      ]);
      expect(resultA).toEqual({ content: [{ type: "text", text: "echo:A" }] });
      expect(resultB).toEqual({ content: [{ type: "text", text: "echo:B" }] });
    } finally {
      await Promise.all([clientA.close(), clientB.close(), serverA.close(), serverB.close()]);
    }
  });
});
