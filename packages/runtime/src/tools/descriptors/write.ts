// WS-06 §3.1 "Write" -- implement-now, captured, verbatim schema.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "Write",
  advertisedName: "Write",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      content: { type: "string" },
    },
    required: ["file_path", "content"],
  },
  description: "Create or complete overwrite -- never append/merge. Same read-before-overwrite ladder as Edit for existing files; new files have no precondition. Honors Read-deny on the target.",
  exposure: "eager",
  permissionClass: "edit",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
