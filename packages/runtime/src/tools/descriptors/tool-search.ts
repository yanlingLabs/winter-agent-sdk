// WS-06 §3.5 "ToolSearch" -- implement-now. Contracts/result shapes owned by [WS-09]; registry
// obligation here is `searchHint` population per descriptor (left to each descriptor file itself --
// none set at T1 since no deferred-exposure tool exists yet to search for) plus this descriptor.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

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
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
