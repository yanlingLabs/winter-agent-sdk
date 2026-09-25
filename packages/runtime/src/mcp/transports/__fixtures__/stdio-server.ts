// TEST-ONLY: a small, fixed stdio MCP server spawned as a child process by
// mcp/transports/stdio.test.ts (and any other test that needs a real, out-of-process server).
// Never imported by production code or by any other test file directly -- always reached via
// mcp/test-fixtures.ts's stdioFixtureCommand(), which points a real child_process spawn at this
// file's own absolute path. Mirrors mcp/test-fixtures.ts's defaultFixtureSpec() tool/resource set
// exactly, so a stdio-path test can assert the identical expectations as the in-memory/http/sse
// fixtures. Zod-free (see test-fixtures.ts's own header for why).
//
// Fix round 1 (MAJOR M1): also exposes "env_dump", a tool with no other purpose than reporting
// THIS process's own `process.env` back over the wire -- the only way a test can observe what
// `WinterStdioTransport.buildStdioEnv()` actually handed to a real, separately-spawned child
// (a same-process check can only ever prove what the FUNCTION computes, never what a real spawned
// child actually receives).
//
// WS-23: on the v2 server package (`@modelcontextprotocol/server` 2.1.0, a dev dependency), with
// method-string handler keys. Hand-connected (`server.connect(new StdioServerTransport())`), so it is
// a LEGACY-era server: it answers the 2025 `initialize` handshake and nothing modern -- exactly the
// "existing server" an `'auto'` stdio client must still settle on 2025-11-25 against.
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const server = new Server({ name: "stdio-fixture", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });

server.setRequestHandler("tools/list", async () => ({
  tools: [
    { name: "echo", description: "echoes text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "boom", description: "always fails", inputSchema: { type: "object", properties: {} } },
    { name: "env_dump", description: "reports this process's own env", inputSchema: { type: "object", properties: {} } },
  ],
}));

server.setRequestHandler("tools/call", async (req) => {
  if (req.params.name === "echo") {
    const args = req.params.arguments as { text?: unknown } | undefined;
    return { content: [{ type: "text", text: `echo:${String(args?.text)}` }] };
  }
  if (req.params.name === "boom") {
    return { content: [{ type: "text", text: "boom" }], isError: true };
  }
  if (req.params.name === "env_dump") {
    // The whole point is fidelity: report every key this process's env actually has, not a
    // pre-selected subset -- a test asserting "the canary name is ABSENT from keys" would be
    // meaningless against a payload that only ever includes names the test already expects.
    const payload = { keys: Object.keys(process.env), values: { ...process.env } };
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  }
  throw new Error(`fixture: unknown tool "${req.params.name}"`);
});

server.setRequestHandler("resources/list", async () => ({
  resources: [
    { uri: "fixture://text.txt", name: "text.txt", mimeType: "text/plain" },
    { uri: "fixture://blob.bin", name: "blob.bin", mimeType: "application/octet-stream" },
  ],
}));

server.setRequestHandler("resources/read", async (req) => {
  if (req.params.uri === "fixture://text.txt") {
    return { contents: [{ uri: req.params.uri, mimeType: "text/plain", text: "hello fixture world" }] };
  }
  if (req.params.uri === "fixture://blob.bin") {
    return { contents: [{ uri: req.params.uri, mimeType: "application/octet-stream", blob: Buffer.from([1, 2, 3, 4]).toString("base64") }] };
  }
  throw new Error(`fixture: unknown resource "${req.params.uri}"`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
