import { describe, test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildStdioTransport } from "./stdio.ts";
import { stdioFixtureCommand } from "../test-fixtures.ts";

// Every test in this file spawns a REAL child process (the fixture at
// __fixtures__/stdio-server.ts) -- the lane protocol's own stall discipline requires killing it in
// `finally` with a deadline, every test, since a leaked child process hangs the linux runner.
// `client.close()` reliably kills a direct (non-shell-wrapped) bun-script child in the success
// path (verified empirically before writing this file); the `transport.pid`-based manual SIGKILL
// below is the belt-and-suspenders fallback, since `transport.pid` is empirically NULLED OUT by the
// SDK's own error handling on a failed/timed-out connect before a caller ever gets to read it --
// captured proactively via a short poll instead so the fallback still has a real pid to act on.
async function withStdioConnection<T>(env: Record<string, string>, fn: (client: Client) => Promise<T>): Promise<{ result: T; pid: number | null }> {
  const { command, args } = stdioFixtureCommand();
  const transport = buildStdioTransport({ command, args, env });
  const client = new Client({ name: "stdio-transport-test", version: "1.0.0" });

  let capturedPid: number | null = null;
  const pollTimer = setInterval(() => {
    if (capturedPid === null && transport.pid !== null) capturedPid = transport.pid;
  }, 2);

  try {
    await client.connect(transport, { timeout: 5000 });
    const result = await fn(client);
    return { result, pid: capturedPid };
  } finally {
    clearInterval(pollTimer);
    await client.close().catch(() => {});
    if (capturedPid !== null) {
      const pid = capturedPid;
      const deadline = Date.now() + 1000;
      let alive = true;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0); // throws ESRCH once the process is gone
        } catch {
          alive = false;
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      if (alive) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone by the time we got here */
        }
      }
    }
  }
}

describe("buildStdioTransport: a real out-of-process stdio MCP server", () => {
  test("connects, lists tools, and calls a tool over a real child process spawned with an explicit (here: empty) env", async () => {
    const { result } = await withStdioConnection({}, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual(["boom", "echo"]);
      return client.callTool({ name: "echo", arguments: { text: "hi" } }, undefined, { timeout: 5000 });
    });
    expect(result).toEqual({ content: [{ type: "text", text: "echo:hi" }] });
  });

  test("reads a text resource and a blob resource (base64) over the real child process", async () => {
    const { result } = await withStdioConnection({}, async (client) => {
      const textRes = await client.readResource({ uri: "fixture://text.txt" });
      const blobRes = await client.readResource({ uri: "fixture://blob.bin" });
      return { textRes, blobRes };
    });
    expect(result.textRes.contents).toEqual([{ uri: "fixture://text.txt", mimeType: "text/plain", text: "hello fixture world" }]);
    expect(result.blobRes.contents).toEqual([
      { uri: "fixture://blob.bin", mimeType: "application/octet-stream", blob: Buffer.from([1, 2, 3, 4]).toString("base64") },
    ]);
  });

  test("an isError tool result is surfaced, not thrown", async () => {
    const { result } = await withStdioConnection({}, (client) => client.callTool({ name: "boom", arguments: {} }, undefined, { timeout: 5000 }));
    expect(result).toEqual({ content: [{ type: "text", text: "boom" }], isError: true });
  });

  test("the spawned child process is reliably terminated once the connection's finally block runs (no leaked process)", async () => {
    const { pid } = await withStdioConnection({}, async (client) => {
      await client.listTools(); // just needs a real, completed exchange so the pid was captured
    });
    expect(pid).not.toBeNull();
    // withStdioConnection's own finally has already run by the time this line executes (it is
    // awaited above) -- either client.close() killed it, or the deadline-bounded SIGKILL fallback
    // did. Either way, the pid must be unreachable NOW, proving this test file's own cleanup
    // discipline actually works rather than merely hoping the SDK's close() is sufficient.
    expect(() => process.kill(pid!, 0)).toThrow();
  });
});
