// WS-06 §3.5 "WaitForMcpServers" -- implement-now, advertised only when ToolSearch is disabled
// ([WS-09]).
//
// Phase 4 Task 8 (rider 4, schema identity): the input schema was the T1-era placeholder
// `{ timeout_ms: number }`, invented while WS-06 §3 deferred the contract to [WS-09]. WS-09 §8.4
// now pins it exactly -- `{ servers?: string[] }`, "omitted waits for all pending" -- and Lane B's
// shipped executor (tools/impl/wait-for-mcp-servers.ts) validates and handles precisely that shape
// while ignoring `timeout_ms` entirely (the 5 s deadline is the tool's own, never a model input).
// A model reading the old schema could literally not express the one field this tool accepts, and
// could pass a field it does not have. Corrected here, at the one place that tells the model what
// the tool takes.
import { stub } from "./_shared.ts";

stub({
  canonicalName: "WaitForMcpServers",
  advertisedName: "WaitForMcpServers",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: { servers: { type: "array", items: { type: "string" }, description: "omitted waits for all pending servers" } },
  },
  description: "Waits for connected MCP servers to finish handshaking. Advertised only when ToolSearch is disabled.",
  exposure: "eager",
  permissionClass: "read",
  availability: { requiresToolSearchDisabled: true },
  capabilityRequirements: ["winter.mcp"],
  disposition: "implement-now",
});
