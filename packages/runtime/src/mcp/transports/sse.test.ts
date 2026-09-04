import { describe, test, expect } from "bun:test";
import { createServer as createNodeHttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildSseTransport } from "./sse.ts";
import { withSseFixture, defaultFixtureSpec } from "../test-fixtures.ts";

describe("buildSseTransport: legacy SSE over a real loopback node:http server", () => {
  test("connects, lists tools, calls a tool, and reads resources", async () => {
    await withSseFixture(defaultFixtureSpec(), async (url) => {
      const transport = buildSseTransport({ type: "sse", url: url.toString() });
      const client = new Client({ name: "sse-transport-test", version: "1.0.0" });
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

  test("forwards configured headers on the initial (GET /sse) request", async () => {
    let seenHeader: string | null = null;
    const httpServer = createNodeHttpServer((req, res) => {
      seenHeader = (req.headers["x-fixture-test"] as string | undefined) ?? null;
      res.writeHead(400).end("not a real mcp server, just a header probe");
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const transport = buildSseTransport({ type: "sse", url: `http://127.0.0.1:${port}/sse`, headers: { "X-Fixture-Test": "yes" } });
      const client = new Client({ name: "header-probe", version: "1.0.0" });
      await client.connect(transport, { timeout: 2000 }).catch(() => {});
      // See http.test.ts's identical test for why this compares a boolean rather than passing the
      // narrowed `let` directly into expect() (a bun:test overload-resolution quirk, not a real type
      // error).
      expect(seenHeader === "yes").toBe(true);
      await client.close().catch(() => {});
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  // IMPORTANT, LOAD-BEARING FINDING (verified empirically before writing this test): unlike
  // buildHttpTransport (http.test.ts's own identical-shaped test), an SSE client's `{timeout}`
  // option passed to `client.connect()` does NOT bound the case where the server never responds to
  // the initial GET at all -- `SSEClientTransport.start()` opens an EventSource, a DIFFERENT phase
  // from the JSON-RPC request/response cycle `RequestOptions.timeout` actually covers, and it hangs
  // indefinitely with no error and no timeout of its own. This is exactly the "spawn/open can hang
  // before initialize" risk this lane's own review flagged -- confirmed here concretely for SSE, not
  // hypothetically. Consequence for mcp/client.ts (this transport's real caller): it MUST wrap
  // `client.connect()` in its OWN outer race for every transport, never trusting a transport's own
  // `{timeout}` option alone -- this test documents the raw SDK behavior an inner-only timeout would
  // silently rely on, and proves the OUTER race is what actually bounds it.
  test("the SDK's own inner {timeout} option does NOT bound a fully unresponsive server -- an outer race is required (documents the client.ts obligation)", async () => {
    const httpServer = createNodeHttpServer(() => {
      /* never responds at all -- not even connection-refused; simulates a truly hung endpoint */
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const transport = buildSseTransport({ type: "sse", url: `http://127.0.0.1:${port}/sse` });
      const client = new Client({ name: "timeout-test", version: "1.0.0" });
      const started = Date.now();
      const outerTimeoutMs = 300;
      const outerRace = new Promise((_, reject) => setTimeout(() => reject(new Error("outer-timeout")), outerTimeoutMs));
      await expect(Promise.race([client.connect(transport, { timeout: 50 }), outerRace])).rejects.toThrow("outer-timeout");
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(outerTimeoutMs - 20);
      expect(elapsed).toBeLessThan(2000);
      await client.close().catch(() => {});
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
