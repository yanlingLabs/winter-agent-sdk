// WS-06 §2 "ReadMcpResourceTool" -- implement-now ([WS-09]). Schema not pinned verbatim by WS-06
// §3 -- placeholder shape.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "ReadMcpResourceTool",
  advertisedName: "ReadMcpResourceTool",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: { server: { type: "string" }, uri: { type: "string" } },
    required: ["server", "uri"],
  },
  description: "Reads one resource from a connected MCP server.",
  exposure: "eager",
  permissionClass: "mcp",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
