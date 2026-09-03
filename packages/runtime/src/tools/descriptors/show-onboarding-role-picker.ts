// WS-06 §3.2/§40.46 "ShowOnboardingRolePicker" -- correctly-absent (v1), declared/runtime-derived.
// Hosted onboarding surface; registry-pinned, never advertised.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "ShowOnboardingRolePicker",
  advertisedName: "ShowOnboardingRolePicker",
  source: "host",
  inputSchema: { type: "object", additionalProperties: true },
  description: "Hosted onboarding role-picker surface. Correctly absent from Winter v1.",
  exposure: "hidden",
  permissionClass: "hosted",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: ["claude.ai-hosting"],
  disposition: "correctly-absent",
});
