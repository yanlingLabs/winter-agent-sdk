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
  // I4 (fix wave, P3 close-out): gated on "winter.skills" -- this descriptor has no `impl/*.ts`
  // executor anywhere in the codebase yet (owned by P5/WS-11), so advertising it unconditionally
  // handed a real model a schema for a tool that always answers "registered but not yet
  // executable" (registry.ts). Mirrors the WebSearch/LSP precedent -- a capability token, not
  // `executor !== undefined` (which would also silently hide a test-registered executorless tool).
  capabilityRequirements: ["winter.skills"],
  disposition: "implement-now",
});
