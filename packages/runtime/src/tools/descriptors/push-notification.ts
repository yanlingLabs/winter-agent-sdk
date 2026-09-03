// WS-06 §3.3 "PushNotification" -- winter-backed-equivalent, declared, verbatim schema. Winter
// implements the local desktop notification now; the phone push half rides Winter's own device
// transport ([WS-15]) later. Same schema/result fields either way; `disabledReason` reports an
// unconfigured Winter transport -- so this stays available (not gated on a not-yet-satisfiable
// capability like the winter-backed-LATER tools), since the local half is real today.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "PushNotification",
  advertisedName: "PushNotification",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", maxLength: 199 },
      status: { type: "string", enum: ["proactive"] },
    },
    required: ["message", "status"],
  },
  outputSchema: {
    type: "object",
    properties: {
      message: { type: "string" },
      pushSent: { type: "boolean" },
      localSent: { type: "boolean" },
      disabledReason: { type: "string" },
      sentAt: { type: "string" },
    },
    required: ["message"],
  },
  description: "Local desktop notification now; phone push over Winter's own device transport once [WS-15] ships it.",
  exposure: "eager",
  permissionClass: "task",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "winter-backed-equivalent",
});
