// WS-06 §3.2/§40.46 "Projects" -- correctly-absent (v1), declared/runtime-derived. Hosted
// knowledge-base surface; registry-pinned, never advertised.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "Projects",
  advertisedName: "Projects",
  source: "host",
  inputSchema: { type: "object", additionalProperties: true },
  description: "Hosted claude.ai knowledge-base project surface. Correctly absent from Winter v1.",
  exposure: "hidden",
  permissionClass: "hosted",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: ["claude.ai-hosting"],
  disposition: "correctly-absent",
});
