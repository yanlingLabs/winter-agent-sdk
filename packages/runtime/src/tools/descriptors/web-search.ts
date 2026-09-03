// WS-06 §3.2 "WebSearch" -- implement-now with an explicit backend DEPENDENCY (Winter must supply
// its own search backend via [WS-13]); gated on a capability token so it is honestly unavailable
// until that backend exists, per the disposition table's own "(dependency)" annotation.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "WebSearch",
  advertisedName: "WebSearch",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      allowed_domains: { type: "array", items: { type: "string" } },
      blocked_domains: { type: "array", items: { type: "string" } },
    },
    required: ["query"],
  },
  description:
    "Allow-list and block-list are mutually exclusive. Up to 8 internal backend searches per call; default session cap 200 calls shared by the main conversation and all descendants.",
  exposure: "eager",
  permissionClass: "network",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: ["winter.search-backend"],
  disposition: "implement-now",
});
