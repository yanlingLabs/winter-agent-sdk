// WS-06 §3.2/§40.46 "ClaudeDesign" -- correctly-absent (v1), declared/runtime-derived. Hosted
// design-service surface; registry-pinned, never advertised.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "ClaudeDesign",
  advertisedName: "ClaudeDesign",
  source: "host",
  inputSchema: { type: "object", additionalProperties: true },
  description: "Hosted design-service surface. Correctly absent from Winter v1.",
  exposure: "hidden",
  permissionClass: "hosted",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: ["claude.ai-hosting"],
  disposition: "correctly-absent",
});
