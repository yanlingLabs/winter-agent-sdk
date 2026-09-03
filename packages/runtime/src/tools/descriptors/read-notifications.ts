// WS-06 §3.6 "ReadNotifications" -- winter-backed-equivalent: drains Winter's global-messaging
// notification queue ([WS-10]), not Anthropic's. Available now (the local half is real, same
// posture as PushNotification) -- not gated behind a not-yet-satisfiable capability.
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
  capabilityRequirements: [],
  disposition: "winter-backed-equivalent",
});
