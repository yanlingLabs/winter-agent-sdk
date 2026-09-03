// WS-06 §4 "advisor" (Winter-only) -- implement-now. Canonical name MUST be `mcp__winter__advisor`
// (bare `advisor` is rejected by policy, report §122) -- registers with MCP identity per R3-2
// (source "mcp", rule-addressable) even though the in-process Winter MCP server itself is P4/WS-09
// work; the descriptor + a directly-wired executor against the P1 provider seam land here per the
// ruling, availability-gated on reviewer-model resolvability (R3-2/R3-3). Input `{}` -- the runtime
// forwards the session's own conversation/tool history; no model-supplied parameters.
import { stub } from "./_shared.ts";

stub({
  canonicalName: "mcp__winter__advisor",
  advertisedName: "mcp__winter__advisor",
  source: "mcp",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: {
    type: "object",
    properties: {
      advice: { type: "string" },
      model: { type: "string" },
      truncated: { type: "boolean" },
    },
    required: ["advice", "model"],
  },
  description:
    "Consults a stronger reviewer model over this session's own conversation/tool history (provider-opaque state such as encrypted_content is never included). Reviewer unavailable/timeout -> ordinary tool error; never blocks the turn.",
  exposure: "eager",
  permissionClass: "mcp",
  availability: {},
  capabilityRequirements: ["winter.reviewer-model"],
  disposition: "implement-now",
});
