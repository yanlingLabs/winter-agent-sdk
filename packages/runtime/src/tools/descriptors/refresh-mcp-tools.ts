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
  // I4 (fix wave, P3 close-out): gated on "winter.mcp" -- this descriptor has no `impl/*.ts`
  // executor anywhere in the codebase yet (owned by P4/WS-09), so advertising it unconditionally
  // handed a real model a schema for a tool that always answers "registered but not yet
  // executable" (registry.ts). Mirrors the WebSearch/LSP precedent -- a capability token, not
  // `executor !== undefined` (which would also silently hide a test-registered executorless tool).
  capabilityRequirements: ["winter.mcp"],
  disposition: "implement-now",
});
