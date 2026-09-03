// WS-06 §3.3 "ExitWorktree" -- implement-now, captured, verbatim schema. Unavailable to subagents
// with isolation-pinned cwd -- not modeled as an AvailabilityPredicate field at T1 (there is no
// session-role input for "this call is inside an isolation-pinned subagent" on
// AdvertisedSetInputs yet); Lane E's own executor is expected to enforce it at call time instead.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "ExitWorktree",
  advertisedName: "ExitWorktree",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["keep", "remove"] },
      discard_changes: { type: "boolean" },
    },
    required: ["action"],
  },
  description: "remove refuses on uncommitted files/unmerged commits unless discard_changes: true.",
  exposure: "eager",
  permissionClass: "mode",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
