// WS-06 §3.6 "ProposeSkills" -- implement-later (review-gated proposal surface). Presents for
// review, never silently installs.
import { stub } from "./_shared.ts";

stub({
  canonicalName: "ProposeSkills",
  advertisedName: "ProposeSkills",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      proposals: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            kind: { type: "string", enum: ["new", "improvement"] },
            target: { type: "string" },
            description: { type: "string" },
            evidence: { type: "string" },
            skillMd: { type: "string" },
          },
          required: ["name", "kind", "description", "skillMd"],
        },
      },
    },
    required: ["proposals"],
  },
  description: "Presents skill proposals for human review; never silently installs.",
  // See send-user-file.ts's note: exposure:"hidden" is reserved for correctly-absent tools.
  exposure: "eager",
  permissionClass: "task",
  availability: {},
  capabilityRequirements: ["winter.skill-proposal-review"],
  disposition: "implement-later",
});
