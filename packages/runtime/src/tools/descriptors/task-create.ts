// WS-06 §3.4 "TaskCreate" -- implement-now, captured. Shared session task graph, distinct from
// background-task ids (background-tasks.ts). R3-4 provisional availability: shown unless the
// resolved model family is marked task-native (hiddenWhenFamilyTaskNative; absent familyMetadata =
// shown, per the ruling's own default).
import { stub } from "./_shared.ts";

stub({
  canonicalName: "TaskCreate",
  advertisedName: "TaskCreate",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      subject: { type: "string" },
      description: { type: "string" },
      activeForm: { type: "string" },
      metadata: { type: "object", additionalProperties: true },
    },
    required: ["subject", "description"],
  },
  description: "Creates a row in the shared session task graph. Returns id/subject.",
  exposure: "eager",
  permissionClass: "task",
  availability: { hiddenWhenFamilyTaskNative: true },
  capabilityRequirements: [],
  disposition: "implement-now",
});
