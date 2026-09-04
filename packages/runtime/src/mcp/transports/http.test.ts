import { describe, test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildHttpTransport } from "./http.ts";
import { withHttpFixture, defaultFixtureSpec } from "../test-fixtures.ts";

describe("buildHttpTransport: Streamable HTTP over a real loopback Bun.serve server", () => {
  test("connects, lists tools, calls a tool, and reads resources", async () => {
    await withHttpFixture(defaultFixtureSpec(), async (url) => {
      const transport = buildHttpTransport({ type: "http", url: url.toString() });
      const client = new Client({ name: "http-transport-test", version: "1.0.0" });
      try {
        await client.connect(transport, { timeout: 5000 });
        const tools = await client.listTools();
        expect(tools.tools.map((t) => t.name).sort()).toEqual(["boom", "echo"]);
        const result = await client.callTool({ name: "echo", arguments: { text: "hi" } }, undefined, { timeout: 5000 });
        expect(result).toEqual({ content: [{ type: "text", text: "echo:hi" }] });
        const textRes = await client.readResource({ uri: "fixture://text.txt" });
        expect(textRes.contents).toEqual([{ uri: "fixture://text.txt", mimeType: "text/plain", text: "hello fixture world" }]);
      } finally {
        await client.close();
      }
    });
  });

  test("forwards configured headers on the initial request (requestInit.headers)", async () => {
    let seenHeader: string | null = null;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        seenHeader = req.headers.get("x-fixture-test");
        return new Response("not a real mcp server, just a header probe", { status: 400 });
      },
    });
    try {
      const transport = buildHttpTransport({ type: "http", url: `http://127.0.0.1:${server.port}/mcp`, headers: { "X-Fixture-Test": "yes" } });
      const client = new Client({ name: "header-probe", version: "1.0.0" });
      await client.connect(transport, { timeout: 2000 }).catch(() => {}); // the probe server never speaks real MCP -- only the header matters
      // `expect(seenHeader).toBe("yes")` mis-resolves bun:test's own expect() overload (it infers
      // the null-only overload for a `let` narrowed by a closure assignment tsc's control-flow
      // analysis doesn't see as reachable here) -- comparing a boolean sidesteps that overload
      // entirely rather than fighting the inferred type.
      expect(seenHeader === "yes").toBe(true);
      await client.close().catch(() => {});
    } finally {
      server.stop(true);
    }
  });

  test("connect() rejects (never hangs) against a server that never responds, bounded by the given timeout", async () => {
    const hungServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) });
    try {
      const transport = buildHttpTransport({ type: "http", url: `http://127.0.0.1:${hungServer.port}/mcp` });
      const client = new Client({ name: "timeout-test", version: "1.0.0" });
      const started = Date.now();
      await expect(client.connect(transport, { timeout: 200 })).rejects.toBeTruthy();
      expect(Date.now() - started).toBeLessThan(2000);
      await client.close().catch(() => {});
    } finally {
      hungServer.stop(true);
    }
  });
});
