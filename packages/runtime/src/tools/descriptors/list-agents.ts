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
  capabilityRequirements: [],
  disposition: "implement-now",
});
