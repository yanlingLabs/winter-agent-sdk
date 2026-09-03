// WS-06 §3.3 "ExitPlanMode" -- implement-now, captured, verbatim (open) schema. Permission-gated
// (unlike EnterPlanMode); submits the plan to the approval path ([WS-07] §29.5).
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "ExitPlanMode",
  advertisedName: "ExitPlanMode",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      allowedPrompts: {
        type: "array",
        description: "deprecated, ignored",
        items: { type: "object", properties: { tool: { type: "string", enum: ["Bash"] }, prompt: { type: "string" } }, required: ["tool", "prompt"] },
      },
    },
    additionalProperties: true,
  },
  description: "Submits the plan to the approval path; permission-gated. Result carries plan/plan-file/flags.",
  exposure: "eager",
  permissionClass: "mode",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
