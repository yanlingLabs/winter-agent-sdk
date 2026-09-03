// WS-06 §3.3 "EnterPlanMode" -- implement-now, captured. `{}` -- switches to plan mode; changes
// permission/tool posture, not a prompt hint. Lane E's executor mutates through
// ToolExecutionContext.session.setPermissionMode("plan").
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "EnterPlanMode",
  advertisedName: "EnterPlanMode",
  source: "builtin",
  // N2 (fix wave, nit, P3 close-out): the schema previously declared `additionalProperties: false`
  // here, but no executor in this codebase validates input against a JSON Schema at all
  // (registry.ts's own JSONSchema type is explicitly "self-describing... not a validator") -- the
  // keyword was decorative, never enforced. Dropped uniformly (see the same fix on CronList/TaskList/
  // EnterPlanMode/advisor -- pick one posture and apply it everywhere, rather than a schema that
  // implies enforcement none of these executors perform).
  inputSchema: { type: "object", properties: {} },
  description: "Switches the session's permission mode to plan.",
  exposure: "eager",
  permissionClass: "mode",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
