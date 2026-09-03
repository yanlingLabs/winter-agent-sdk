// WS-06 §3.4 "CronList" -- implement-now, captured. `{}` -> jobs with id/cron/humanSchedule/prompt/
// recurring/durable.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "CronList",
  advertisedName: "CronList",
  source: "builtin",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
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
