// WS-06 §3.5 "TaskStop" -- implement-now, captured. At least one of task_id/shell_id logically
// required (shell_id deprecated).
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "TaskStop",
  advertisedName: "TaskStop",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      task_id: { type: "string" },
      shell_id: { type: "string", description: "deprecated" },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      message: { type: "string" },
      task_id: { type: "string" },
      task_type: { type: "string" },
      command: { type: "string" },
    },
    required: ["message"],
  },
  description: "Stops a background command/agent/teammate. At least one of task_id/shell_id is logically required.",
  exposure: "eager",
  permissionClass: "task",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
