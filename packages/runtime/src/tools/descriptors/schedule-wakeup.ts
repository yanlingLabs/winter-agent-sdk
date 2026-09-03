// WS-06 §3.4 "ScheduleWakeup" -- implement-now, captured, verbatim schema. The self-paced loop
// primitive, not a general timer. Unless `stop`, delaySeconds/reason/prompt/noop are logically
// required (not encoded as JSON Schema `required` since `stop` makes them all optional -- a
// cross-field conditional the executor validates, not the schema).
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "ScheduleWakeup",
  advertisedName: "ScheduleWakeup",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      delaySeconds: { type: "number", minimum: 60, maximum: 3600 },
      reason: { type: "string" },
      prompt: { type: "string" },
      stop: { type: "boolean" },
      noop: { type: "boolean" },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      scheduledFor: { type: "string" },
      clampedDelaySeconds: { type: "number" },
      wasClamped: { type: "boolean" },
      stopped: { type: "boolean" },
      cancelledWakeups: { type: "number" },
    },
  },
  description: "Delay clamped 60-3600s. Unless `stop`, delaySeconds/reason/prompt/noop are logically required.",
  exposure: "eager",
  permissionClass: "task",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
