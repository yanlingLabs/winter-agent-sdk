// WS-06 §3.4 "CronDelete" -- implement-now, captured. By id only, never by expression.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "CronDelete",
  advertisedName: "CronDelete",
  source: "builtin",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  description: "Deletes a scheduled job by id only, never by expression.",
  exposure: "eager",
  permissionClass: "task",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
