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
  // I4 (fix wave, P3 close-out): gated on "winter.mcp" -- this descriptor has no `impl/*.ts`
  // executor anywhere in the codebase yet (owned by P4/WS-09), so advertising it unconditionally
  // handed a real model a schema for a tool that always answers "registered but not yet
  // executable" (registry.ts). Mirrors the WebSearch/LSP precedent -- a capability token, not
  // `executor !== undefined` (which would also silently hide a test-registered executorless tool).
  capabilityRequirements: ["winter.mcp"],
  disposition: "implement-now",
});
