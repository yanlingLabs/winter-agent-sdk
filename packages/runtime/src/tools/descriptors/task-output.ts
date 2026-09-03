// WS-06 §3.5 "TaskOutput" -- implement-now, captured. Reads a background task's output, optionally
// waiting. Deprecated in favor of Read on the task's output file -- Winter preserves the tool for
// pinned compatibility and the file as the primary path (background-tasks.ts's D18 layout).
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "TaskOutput",
  advertisedName: "TaskOutput",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      task_id: { type: "string" },
      block: { type: "boolean" },
      timeout: { type: "number" },
    },
    required: ["task_id", "block", "timeout"],
  },
  description: "Reads a background task's output, optionally waiting. Deprecated in favor of Read on the task's output file.",
  exposure: "eager",
  permissionClass: "task",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
