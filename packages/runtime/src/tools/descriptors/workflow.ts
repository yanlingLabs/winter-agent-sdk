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
  // I4 (fix wave, P3 close-out): gated on "winter.workflows" -- this descriptor has no `impl/*.ts`
  // executor anywhere in the codebase yet (owned by P5/WS-11), so advertising it unconditionally
  // handed a real model a schema for a tool that always answers "registered but not yet
  // executable" (registry.ts). Mirrors the WebSearch/LSP precedent -- a capability token, not
  // `executor !== undefined` (which would also silently hide a test-registered executorless tool).
  capabilityRequirements: ["winter.workflows"],
  disposition: "implement-now",
});
