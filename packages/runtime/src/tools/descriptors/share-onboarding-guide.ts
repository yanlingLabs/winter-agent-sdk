// WS-06 §3.2 "ShareOnboardingGuide" -- winter-backed-later, runtime-derived, verbatim schema.
// Winter's later equivalent is WINTER.md-oriented and points at a Winter backend; absent until that
// backend exists.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "ShareOnboardingGuide",
  advertisedName: "ShareOnboardingGuide",
  source: "host",
  inputSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["check", "update", "create", "delete"] },
      short_code: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["created", "updated", "deleted", "has_existing", "unavailable"] },
      share_url: { type: "string" },
      short_code: { type: "string" },
      message: { type: "string" },
    },
    required: ["status", "message"],
  },
  description: "64 KiB source cap. Winter's later equivalent is WINTER.md-oriented and backed by a Winter backend -- absent until that backend exists.",
  // See send-user-file.ts's identical comment: exposure:"hidden" is reserved for correctly-absent
  // tools; a winter-backed-later tool relies on capabilityRequirements to stay unadvertised today.
  exposure: "eager",
  permissionClass: "hosted",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: ["winter.onboarding-guide-backend"],
  disposition: "winter-backed-later",
});
