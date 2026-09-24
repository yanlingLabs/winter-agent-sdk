// TEST-ONLY: a one-tool stdio MCP server, `gate_ping`, the shape of the WS-21 live gate's own fixture
// (fix round 19). Reached through mcp/test-fixtures.ts's `pingFixtureCommand()`, never imported.
// Zod-free, on the low-level `Server` class, for the reason mcp/test-fixtures.ts's header gives.
//
// PLAIN JAVASCRIPT (`.mjs`), fix round 20: it runs under the `node` on PATH, and the release runner's
// Node 18 (and ubuntu-latest's preinstalled node) cannot strip TypeScript annotations -- a `.ts`
// fixture died there with ERR_UNKNOWN_FILE_EXTENSION. Bun runs it too.
//
// `--delay-ms <n>` postpones the MCP handshake by n milliseconds (the transport does not attach, so
// the client's `initialize` waits in the pipe): a slow-starting server, for the first-turn wait and
// the late-connection tests. `--label <s>` is echoed in the tool's answer.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const delayMs = Number(argValue("--delay-ms") ?? "0");
const label = argValue("--label") ?? "fixture";

const server = new Server({ name: `ping-${label}`, version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "gate_ping", description: `Answers a ping for ${label}.`, inputSchema: { type: "object", properties: {} } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "gate_ping") return { content: [{ type: "text", text: `PONG-${label}` }] };
  throw new Error(`ping fixture: unknown tool "${req.params.name}"`);
});

if (Number.isFinite(delayMs) && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
await server.connect(new StdioServerTransport());
