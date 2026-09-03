// WS-06 §3.6 "ReadNotifications" -- winter-backed-equivalent: drains Winter's global-messaging
// notification queue ([WS-10]), not Anthropic's.
//
// CORRECTION (I4, fix wave, P3 close-out): this file used to claim "available now ... not gated
// behind a not-yet-satisfiable capability" -- that was aspirational, not actual: no `impl/*.ts`
// executor for this descriptor exists anywhere in the codebase (verified before this fix), so a
// real model handed this schema unconditionally got "registered but not yet executable" on every
// call. Now gated on "winter.global-messaging" (see the WebSearch/LSP precedent) until WS-10 wires a
// real executor.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "ReadNotifications",
  advertisedName: "ReadNotifications",
  source: "builtin",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: {
    type: "object",
    properties: {
      notification_id: { type: "string" },
      origin: { type: "string" },
      queued_at: { type: "string" },
      content: { type: "string" },
      remaining: { type: "number" },
    },
  },
  description: "Drains Winter's own global-messaging notification queue ([WS-10]).",
  exposure: "eager",
  permissionClass: "messaging",
  availability: ALWAYS_AVAILABLE,
  // I4 (fix wave, P3 close-out): gated on "winter.global-messaging" -- this descriptor has no `impl/*.ts`
  // executor anywhere in the codebase yet (owned by WS-10), so advertising it unconditionally
  // handed a real model a schema for a tool that always answers "registered but not yet
  // executable" (registry.ts). Mirrors the WebSearch/LSP precedent -- a capability token, not
  // `executor !== undefined` (which would also silently hide a test-registered executorless tool).
  capabilityRequirements: ["winter.global-messaging"],
  disposition: "winter-backed-equivalent",
});
