// WS-06 §3.5 "WaitForMcpServers" -- implement-now, advertised only when ToolSearch is disabled
// ([WS-09]). Not pinned verbatim by WS-06 §3 (contract owned by [WS-09]) -- placeholder schema.
import { stub } from "./_shared.ts";

stub({
  canonicalName: "WaitForMcpServers",
  advertisedName: "WaitForMcpServers",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: { timeout_ms: { type: "number" } },
  },
  description: "Waits for connected MCP servers to finish handshaking. Advertised only when ToolSearch is disabled.",
  exposure: "eager",
  permissionClass: "read",
  availability: { requiresToolSearchDisabled: true },
  capabilityRequirements: [],
  disposition: "implement-now",
});
