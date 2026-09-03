// WS-06 §3.6 "RefreshMcpTools" -- implement-now ([WS-09]), verbatim schema. Re-query connected
// servers' tool lists; never establishes a disconnected connection.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "RefreshMcpTools",
  advertisedName: "RefreshMcpTools",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: { server: { type: "string" } },
  },
  description: "Re-queries connected servers' tool lists; never establishes a disconnected connection.",
  exposure: "eager",
  permissionClass: "mcp",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
