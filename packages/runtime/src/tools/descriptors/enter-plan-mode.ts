// WS-06 §3.3 "EnterPlanMode" -- implement-now, captured. `{}` -- switches to plan mode; changes
// permission/tool posture, not a prompt hint. Lane E's executor mutates through
// ToolExecutionContext.session.setPermissionMode("plan").
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "EnterPlanMode",
  advertisedName: "EnterPlanMode",
  source: "builtin",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  description: "Switches the session's permission mode to plan.",
  exposure: "eager",
  permissionClass: "mode",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
