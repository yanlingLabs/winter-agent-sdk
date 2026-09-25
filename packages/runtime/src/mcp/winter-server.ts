// WS-09 §1.3: the standing Winter server's NAME (`winter`) -- the reserved identity both MCP doors
// (mcp/lifecycle.ts's `resolveMcpServerSources`, mcp/control.ts's `setServers`) refuse to let any
// source configure, and the rename's `from` side under a brand.
//
// WS-23 (MCP TS SDK v2): this file used to ALSO build the standing server itself, as a real, empty
// in-process `McpServer` object (`createWinterServer`). Nothing ever imported that factory -- D29 had
// already moved its one tool, the advisor, to a bare native name (tools/descriptors/advisor.ts), and
// the other standing-server tools WS-09 §1.3 names are product-layer work that registers nowhere yet.
// The v2 migration deleted the factory (and its test) rather than port dead code onto a new server
// package: it was the runtime's only production import of an MCP SERVER class, so the compiled
// `winter` binary now depends on the client package alone. The NAME stays, here, because four
// modules and the brand gate's call-site allowlist already read it from this path. The first
// product-layer tool that genuinely needs a standing server object builds it then, on the server
// package of that day.
//
// Collision note (see registry.ts's own "Phase 4 Task 2: live MCP server registration" header):
// the standing server's name is RESERVED (registry.ts's own RESERVED_MCP_SERVER_NAMES, which a
// branded session extends through `rebrandStandingServerTools`), so ANY `registerMcpServerTools`
// call under it throws unconditionally, for any tool name.
import { WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";

/** Winter's OWN standing-server name, derived rather than spelled (P7a, D19). */
export const WINTER_SERVER_NAME = WINTER_BRAND.mcpServerName;
