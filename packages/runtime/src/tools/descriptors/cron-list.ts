// WS-06 §3.4 "CronList" -- implement-now, captured. `{}` -> jobs with id/cron/humanSchedule/prompt/
// recurring/durable.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "CronList",
  advertisedName: "CronList",
  source: "builtin",
  // N2 (fix wave, nit, P3 close-out): the schema previously declared `additionalProperties: false`
  // here, but no executor in this codebase validates input against a JSON Schema at all
  // (registry.ts's own JSONSchema type is explicitly "self-describing... not a validator") -- the
  // keyword was decorative, never enforced. Dropped uniformly (see the same fix on CronList/TaskList/
  // EnterPlanMode/advisor -- pick one posture and apply it everywhere, rather than a schema that
  // implies enforcement none of these executors perform).
  inputSchema: { type: "object", properties: {} },
  outputSchema: {
    type: "object",
    properties: {
      jobs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            cron: { type: "string" },
            humanSchedule: { type: "string" },
            prompt: { type: "string" },
            recurring: { type: "boolean" },
            durable: { type: "boolean" },
          },
        },
      },
    },
  },
  description: "Lists scheduled jobs.",
  exposure: "eager",
  permissionClass: "task",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
