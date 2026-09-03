// WS-06 §3.4 "TodoWrite" -- implement-now (declared), verbatim schema. Additionally disabled by
// DEFAULT in favor of the task graph, re-enabled by configuration -- modeled as a feature-flag gate
// (requiresFeatures) STACKED with the same R3-4 family gate the task-graph tools share, matching the
// spec's own "additionally" wording (both conditions apply, not either/or).
import { stub } from "./_shared.ts";

stub({
  canonicalName: "TodoWrite",
  advertisedName: "TodoWrite",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            activeForm: { type: "string" },
          },
          required: ["content", "status", "activeForm"],
        },
      },
    },
    required: ["todos"],
  },
  description: "Whole-list replacement. Returns oldTodos/newTodos. Disabled by default in favor of the task graph; re-enabled by configuration.",
  exposure: "eager",
  permissionClass: "task",
  availability: { hiddenWhenFamilyTaskNative: true, requiresFeatures: ["todoWrite"] },
  capabilityRequirements: [],
  disposition: "implement-now",
});
