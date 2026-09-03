// WS-06 §3.5 "Skill" -- implement-now, captured. One tool for all skills; permission rules match
// skill name + argument prefix; filesystem discovery requires deliberate settings sources ([WS-11]).
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "Skill",
  advertisedName: "Skill",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      skill: { type: "string" },
      args: { type: "string" },
    },
    required: ["skill"],
  },
  description: "Loads the named skill into the main conversation.",
  exposure: "eager",
  permissionClass: "mode",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
