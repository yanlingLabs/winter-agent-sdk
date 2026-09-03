// WS-06 §3.4 "CronCreate" -- implement-now, captured, verbatim schema. `durable: true` persists to
// `.winter/scheduled_tasks.json` (Winter path; WS-01 map) -- the daemon RoutineStore is a host
// subsystem ([WS-15]), the model-facing surface is this tool trio.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "CronCreate",
  advertisedName: "CronCreate",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      cron: { type: "string", description: "five-field local-time cron expression" },
      prompt: { type: "string" },
      recurring: { type: "boolean", description: "default true; false = fire once, self-delete" },
      durable: { type: "boolean", description: "default false; persists to .winter/scheduled_tasks.json" },
    },
    required: ["cron", "prompt"],
  },
  description: "Schedules prompts, not OS cron. Returns id, human schedule, recurring, durable?.",
  exposure: "eager",
  permissionClass: "task",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
