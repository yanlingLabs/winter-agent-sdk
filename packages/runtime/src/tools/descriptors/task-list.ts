// WS-06 §3.4 "TaskList" -- implement-now, captured. R3-4 provisional availability (see task-create.ts).
import { stub } from "./_shared.ts";

stub({
  canonicalName: "TaskList",
  advertisedName: "TaskList",
  source: "builtin",
  // N2 (fix wave, nit, P3 close-out): the schema previously declared `additionalProperties: false`
  // here, but no executor in this codebase validates input against a JSON Schema at all
  // (registry.ts's own JSONSchema type is explicitly "self-describing... not a validator") -- the
  // keyword was decorative, never enforced. Dropped uniformly (see the same fix on CronList/TaskList/
  // EnterPlanMode/advisor -- pick one posture and apply it everywhere, rather than a schema that
  // implies enforcement none of these executors perform).
  inputSchema: { type: "object", properties: {} },
  description: "Compact rows: id, subject, status, owner?, blockedBy.",
  exposure: "eager",
  permissionClass: "task",
  availability: { hiddenWhenFamilyTaskNative: true },
  capabilityRequirements: [],
  disposition: "implement-now",
});
