// WS-06 §3.6 "ReadMcpResourceDirTool" -- implement-now ([WS-09]), verbatim schema. Direct children
// of a directory resource.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "ReadMcpResourceDirTool",
  advertisedName: "ReadMcpResourceDirTool",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: { server: { type: "string" }, uri: { type: "string" } },
    required: ["server", "uri"],
  },
  description: "Direct children of a directory resource.",
  exposure: "eager",
  permissionClass: "mcp",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
