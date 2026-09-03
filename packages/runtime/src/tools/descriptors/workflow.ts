// WS-06 §3.5 "Workflow" -- implement-now, captured, verbatim schema. D8 exact parity ([WS-11]);
// Norma's sandboxed-subprocess runtime is the vehicle. `name` resolves built-ins or filesystem
// workflows under `.winter/workflows` (WS-01 §2.4).
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "Workflow",
  advertisedName: "Workflow",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      script: { type: "string" },
      name: { type: "string" },
      description: { type: "string", description: "ignored" },
      title: { type: "string", description: "ignored" },
      args: { type: "object", additionalProperties: true },
      scriptPath: { type: "string", description: "takes precedence" },
      resumeFromRunId: { type: "string" },
    },
  },
  description: "At least one of script/name/scriptPath. resumeFromRunId reuses completed unchanged agent calls within the same session after the prior run stopped.",
  exposure: "eager",
  permissionClass: "execute",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
