// WS-06 §3.6 "StructuredOutput" -- implement-now ([WS-03]). input_schema is GENERATED per-call from
// the caller's requested output schema -- never one static interface. This descriptor's own
// `inputSchema` is therefore a documented placeholder, not the real per-session shape; the host
// (WS-03) is responsible for substituting the real generated schema when actually advertising a
// session that requested structured output.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "StructuredOutput",
  advertisedName: "StructuredOutput",
  source: "host",
  inputSchema: {
    type: "object",
    description: "Generated per-call from the caller's requested output schema (WS-06 §3.6); not a static interface. This placeholder is replaced by the host-generated schema (WS-03) whenever a session actually requests structured output.",
    additionalProperties: true,
  },
  description: "Success ends the turn with a validated structured_output.",
  exposure: "eager",
  permissionClass: "task",
  availability: ALWAYS_AVAILABLE,
  // I4 (fix wave, P3 close-out): gated on "winter.structured-output" -- this descriptor has no `impl/*.ts`
  // executor anywhere in the codebase yet (owned by P5/WS-03 host), so advertising it unconditionally
  // handed a real model a schema for a tool that always answers "registered but not yet
  // executable" (registry.ts). Mirrors the WebSearch/LSP precedent -- a capability token, not
  // `executor !== undefined` (which would also silently hide a test-registered executorless tool).
  capabilityRequirements: ["winter.structured-output"],
  disposition: "implement-now",
});
