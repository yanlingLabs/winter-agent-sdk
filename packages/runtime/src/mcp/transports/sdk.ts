// Phase 4 Task 4 (Lane A), WS-09 §1.1/§1.3: the fourth transport -- an in-process
// `@modelcontextprotocol/sdk` `McpServer` object connected via a real MCP `Client` over
// `InMemoryTransport`, giving an in-process server the IDENTICAL protocol treatment (resource
// listing/reading, elicitation, annotations, output cap) mcp/client.ts gives a real stdio/http/sse
// server -- something the narrower `sdk_mcp_call` bridge (T3's own `WinterMcpServerInstance`
// listTools()/callTool() duck-type, `packages/sdk/src/query.ts`) structurally cannot offer, since
// that bridge has no resources/elicitation concept at all.
//
// Scope boundary (read this before wiring anything to this file): this connector is for (a) this
// lane's own fixture servers (the brief's own "Fixture servers: an in-process SDK server" line),
// and (b) any FUTURE in-process server the runtime itself constructs as a real McpServer instance
// and wants full client-side treatment for. It is explicitly NOT how a host-supplied
// `Options.mcpServers` entry of `type: "sdk"` reaches the model today -- that path's tool
// DISCOVERY and CALL are both already complete, end to end, on the `sdk_mcp_call` control-request
// bridge (T3's own `engine.ts`/`query.ts` wiring; see mcp/lifecycle.ts's own header for how this
// lane's real McpServerStateSource still reports those servers `connected`, per RULING P4-C,
// WITHOUT ever routing through this file or through `registerMcpServerTools`). The standing
// `winter` server (mcp/winter-server.ts) also never routes through here: RESERVED_MCP_SERVER_NAMES
// (registry.ts) forbids `registerMcpServerTools("winter", ...)` unconditionally, and that server's
// own byte-identical-descriptor obligation (WS-06 §6) is already met by mirroring the registry
// descriptor directly onto a real McpServer object -- nothing needs to CONNECT to it as a client.
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// Structural, not the high-level `McpServer` type by name: `McpServer.connect` is itself a thin
// delegate to the identical low-level `Server.connect` (`@modelcontextprotocol/sdk/server/index.js`)
// -- accepting anything with this one method admits BOTH the high-level convenience wrapper WS-09
// §1.1's own prose names AND the low-level `Server`, which is what this lane's own zod-free test
// fixtures build (mcp/test-fixtures.ts's own header explains why: `McpServer.registerTool`'s
// `inputSchema` requires a real zod schema, a dependency this package does not declare).
export interface InProcessMcpServer {
  connect(transport: Transport): Promise<void>;
}

// Connects `server` to one half of a freshly-created in-memory transport pair and returns the
// CLIENT-side half, ready for `client.connect(clientTransport, {...})` -- mirrors the other three
// transports/*.ts builders' own "config in, client-side Transport out" shape as closely as an
// async, instance-based (rather than config-based) connector can. `server.connect(...)` starts the
// server's own side immediately; the returned transport is inert until a Client connects it.
export async function buildSdkTransport(server: InProcessMcpServer): Promise<Transport> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return clientTransport;
}
