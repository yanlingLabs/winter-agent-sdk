// WS-06 §3.4 "TaskUpdate" -- implement-now, captured, verbatim schema. Dependency and ownership
// semantics MUST be implemented, not reduced to a todo rename (Lane D). R3-4 provisional
// availability (see task-create.ts).
import { stub } from "./_shared.ts";

stub({
  canonicalName: "TaskUpdate",
  advertisedName: "TaskUpdate",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string" },
      subject: { type: "string" },
      description: { type: "string" },
      activeForm: { type: "string" },
      status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] },
      addBlocks: { type: "array", items: { type: "string" } },
      addBlockedBy: { type: "array", items: { type: "string" } },
      owner: { type: "string" },
      metadata: { type: "object", additionalProperties: true },
    },
    required: ["taskId"],
  },
  description: "Updates a task graph row; addBlocks/addBlockedBy are union-merges, not replacements.",
  exposure: "eager",
  permissionClass: "task",
  availability: { hiddenWhenFamilyTaskNative: true },
  capabilityRequirements: [],
  disposition: "implement-now",
});
