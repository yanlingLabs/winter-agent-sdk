// WS-06 §3.4 "CronCreate" -- implement-now, captured, verbatim schema. `durable: true` persists to
// `<projectDir>/scheduled_tasks.json` (WS-01 map) -- the daemon RoutineStore is a host
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
      // P7a fix r1 (Minor-1): generic rather than naming Winter's own dot-dir -- this schema is
      // built at module load and the real path derives from `ctx.brand.projectDirName`.
      durable: { type: "boolean", description: "default false; persists to scheduled_tasks.json in the project dot-directory" },
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
