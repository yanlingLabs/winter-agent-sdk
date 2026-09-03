// WS-06 §3.6 "ProposeGoal" -- implement-later. Proposes (or, only when already requested, sets) a
// separately evaluated completion condition.
import { stub } from "./_shared.ts";

stub({
  canonicalName: "ProposeGoal",
  advertisedName: "ProposeGoal",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      condition: { type: "string" },
      ask_user: { type: "boolean" },
    },
    required: ["condition"],
  },
  description: "Proposes (or, only when already requested, sets) a separately evaluated completion condition.",
  // See send-user-file.ts's note: exposure:"hidden" is reserved for correctly-absent tools.
  exposure: "eager",
  permissionClass: "task",
  availability: {},
  capabilityRequirements: ["winter.goal-proposal-review"],
  disposition: "implement-later",
});
