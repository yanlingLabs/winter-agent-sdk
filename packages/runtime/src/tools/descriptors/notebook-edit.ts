// WS-06 §3.1 "NotebookEdit" -- implement-now, captured, verbatim schema.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "NotebookEdit",
  advertisedName: "NotebookEdit",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      notebook_path: { type: "string" },
      cell_id: { type: "string" },
      new_source: { type: "string" },
      cell_type: { type: "string", enum: ["code", "markdown"] },
      edit_mode: { type: "string", enum: ["replace", "insert", "delete"] },
    },
    required: ["notebook_path", "new_source"],
  },
  description: "edit_mode defaults to 'replace'; 'insert' places after cell_id (or at start) and requires cell_type.",
  exposure: "eager",
  permissionClass: "edit",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
