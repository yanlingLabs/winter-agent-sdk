// WS-06 §3.5 "ToolSearch" -- implement-now. Contracts/result shapes owned by [WS-09]; registry
// obligation here is `searchHint` population per descriptor (left to each descriptor file itself --
// none set at T1 since no deferred-exposure tool exists yet to search for) plus this descriptor.
import { stub } from "./_shared.ts";

stub({
  canonicalName: "ToolSearch",
  advertisedName: "ToolSearch",
  source: "builtin",
  // Not pinned by WS-06 §3 (its own text defers the contract to [WS-09]) -- a reasonable
  // placeholder shape; [WS-09] owns the authoritative schema.
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      max_results: { type: "number" },
    },
    required: ["query"],
  },
  description: "Fetches full schema definitions for deferred tools so they can be called.",
  exposure: "eager",
  permissionClass: "read",
  // Phase 4 Task 8 (rider 4): the activation gate Lane B's own report flagged as missing ("no
  // Tool-Search-activation gate at all -- unconditionally eager once winter.mcp is supplied"). This
  // tool is only meaningful when deferral is genuinely ACTIVE for the session: with activation off,
  // resolveDeferral collapses every `deferred: true` descriptor to "eager" (full injection, WS-09
  // §8.1's `false` row), so the deferred pool is empty by construction and every query can only ever
  // return nothing. The complement of WaitForMcpServers' own WS-09 §8.4 gate -- exactly one of the
  // two is advertised in any session.
  availability: { requiresToolSearchEnabled: true },
  // I4 (fix wave, P3 close-out): gated on "winter.mcp" -- this descriptor has no `impl/*.ts`
  // executor anywhere in the codebase yet (owned by P4/WS-09), so advertising it unconditionally
  // handed a real model a schema for a tool that always answers "registered but not yet
  // executable" (registry.ts). Mirrors the WebSearch/LSP precedent -- a capability token, not
  // `executor !== undefined` (which would also silently hide a test-registered executorless tool).
  capabilityRequirements: ["winter.mcp"],
  disposition: "implement-now",
});
