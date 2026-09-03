// WS-06 §3.4 "TaskList" -- implement-now, captured. R3-4 provisional availability (see task-create.ts).
import { stub } from "./_shared.ts";

stub({
  canonicalName: "TaskList",
  advertisedName: "TaskList",
  source: "builtin",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  description: "Compact rows: id, subject, status, owner?, blockedBy.",
  exposure: "eager",
  permissionClass: "task",
  availability: { hiddenWhenFamilyTaskNative: true },
  capabilityRequirements: [],
  disposition: "implement-now",
});
