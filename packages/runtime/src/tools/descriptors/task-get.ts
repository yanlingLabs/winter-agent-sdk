// WS-06 §3.4 "TaskGet" -- implement-now, captured. R3-4 provisional availability (see task-create.ts).
import { stub } from "./_shared.ts";

stub({
  canonicalName: "TaskGet",
  advertisedName: "TaskGet",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: { taskId: { type: "string" } },
    required: ["taskId"],
  },
  description: "Returns id, subject, description, status, blocks, blockedBy, or null.",
  exposure: "eager",
  permissionClass: "task",
  availability: { hiddenWhenFamilyTaskNative: true },
  capabilityRequirements: [],
  disposition: "implement-now",
});
