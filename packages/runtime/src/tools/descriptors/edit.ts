// WS-06 §3.1 "Edit" -- implement-now, captured, verbatim schema.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "Edit",
  advertisedName: "Edit",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  description:
    "old_string is literal and normally unique; replace_all replaces every occurrence. Subject to the shared read-before-edit ladder and MUST retain Read-deny enforcement on the target.",
  exposure: "eager",
  permissionClass: "edit",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
