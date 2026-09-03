// WS-06 §3.3 "ListAgents" -- implement-now, captured, verbatim schema. [WS-10] owns the router.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "ListAgents",
  advertisedName: "ListAgents",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      channel: { type: "string", maxLength: 256, description: "reserved" },
      q: { type: "string", maxLength: 256, description: "reserved" },
    },
  },
  outputSchema: { type: "object", properties: { listing: { type: "string" } }, required: ["listing"] },
  description: "Names/refs, activity/status, addressing identity for children, teammates, eligible live peers; never an enumeration of exited transcripts.",
  exposure: "eager",
  permissionClass: "messaging",
  availability: ALWAYS_AVAILABLE,
  // I4 (fix wave, P3 close-out): gated on "winter.subagents" -- this descriptor has no `impl/*.ts`
  // executor anywhere in the codebase yet (owned by P4/WS-10), so advertising it unconditionally
  // handed a real model a schema for a tool that always answers "registered but not yet
  // executable" (registry.ts). Mirrors the WebSearch/LSP precedent -- a capability token, not
  // `executor !== undefined` (which would also silently hide a test-registered executorless tool).
  capabilityRequirements: ["winter.subagents"],
  disposition: "implement-now",
});
