// WS-06 §2 "ListMcpResourcesTool" -- implement-now ([WS-09]). Schema not pinned verbatim by WS-06
// §3 (MCP resource contracts are [WS-09]'s own) -- placeholder shape.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "ListMcpResourcesTool",
  advertisedName: "ListMcpResourcesTool",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: { server: { type: "string" } },
  },
  description: "Lists resources exposed by connected MCP servers.",
  exposure: "eager",
  permissionClass: "mcp",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
