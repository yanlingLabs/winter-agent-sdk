// WS-09 §1.3: the standing Winter server (`winter`) -- Winter's own product-capability tools,
// registered as a real, in-process @modelcontextprotocol/sdk `McpServer` object so the Winter branch
// and the official (Claude) branch can advertise byte-identical descriptors for the same names
// (WS-06 §6 obligation 5).
//
// IT REGISTERS NOTHING TODAY, and that is the P7a state rather than an oversight. The one tool this
// file ever carried was the advisor, and D29 retired the server-qualified advisor name entirely: the
// advisor is now a BARE NATIVE tool (`advisor`, tools/descriptors/advisor.ts), because that is the
// name the model sees on the official branch too — Anthropic's own API-side advisor server tool,
// which a host cannot intercept. Registering a second, server-qualified twin here would put a name
// on the Winter branch that the official branch cannot have, which is the exact divergence the
// interchangeability rule exists to prevent. The other standing-server tools WS-09 §1.3 names
// (browser/computer/docs/sheets/slides/sessions) are P7/P8 product-layer work owned by
// [WS-14]/[WS-15]; nothing registers them here yet.
//
// So this factory survives as the SEAM, empty: `createWinterServer()` returns a real, connectable
// server object with an empty tool list, and the first product-layer tool that needs the standing
// server registers itself here rather than reinventing the plumbing. An empty server is also the
// honest advertisement of the current state — a client that lists its tools learns "none yet",
// which is true.
//
// Deliberately NOT wired into any auto-loaded barrel (main.ts, tools/descriptors/index.ts, this
// package's own index.ts): nothing imports this module yet, so the compiled `winter` binary's
// dependency graph is UNAFFECTED -- @modelcontextprotocol/sdk is a real, declared dependency (R4-3)
// but is not yet reachable from any entry point `bun build --compile` follows.
//
// Collision note (see registry.ts's own "Phase 4 Task 2: live MCP server registration" header):
// `winter` is a RESERVED server name (registry.ts's own RESERVED_MCP_SERVER_NAMES), so ANY
// `registerMcpServerTools("winter", ...)` call throws unconditionally, for any tool name. Building a
// real McpServer object directly, as this file does, is how WS-09 §1.3's obligation is met without
// going through that live-registration mechanism at all. Resolving the two mechanisms deliberately
// (rather than by surprise) means removing `winter` from that reserved set, not working around it.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const WINTER_SERVER_NAME = "winter";

// Re-callable by design (no module-load singleton, no cached instance) -- a later phase that wants a
// fresh server per session, or that extends this factory with real tools, can call it as many times
// as it needs.
export function createWinterServer(): McpServer {
  return new McpServer({ name: WINTER_SERVER_NAME, version: "0.0.1" });
}
