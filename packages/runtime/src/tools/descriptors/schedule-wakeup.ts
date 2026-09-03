// WS-06 §3.4 "ScheduleWakeup" -- implement-now, captured, verbatim schema. The self-paced loop
// primitive, not a general timer. Unless `stop`, delaySeconds/reason/prompt/noop are logically
// required (not encoded as JSON Schema `required` since `stop` makes them all optional -- a
// cross-field conditional the executor validates, not the schema).
//
// T8 schema-sweep fix (envelope reconciliation via ephemeral capture, derived-shapes-p3-task8.md):
// the pinned artifact's own `delaySeconds` carries NO schema-level minimum/maximum -- clamping to
// [60, 3600] is documented there as RUNTIME behavior only (matching impl/schedule-wakeup.ts's own
// clamp constants exactly). The `minimum`/`maximum` previously declared below were unpinned and put
// the schema in tension with the executor's own clamp-not-reject behavior; removed so the runtime
// clamp is the only enforcement, as pinned. `outputSchema.scheduledFor` corrected from `string` to
// `number` (epoch ms), matching the impl fix.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "ScheduleWakeup",
  advertisedName: "ScheduleWakeup",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      delaySeconds: { type: "number" },
      reason: { type: "string" },
      prompt: { type: "string" },
      stop: { type: "boolean" },
      noop: { type: "boolean" },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      scheduledFor: { type: "number" },
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
