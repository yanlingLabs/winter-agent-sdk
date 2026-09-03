// WS-06 §3.1 "Grep" -- implement-now, captured, verbatim schema.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "Grep",
  advertisedName: "Grep",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      glob: { type: "string" },
      output_mode: { type: "string", enum: ["content", "files_with_matches", "count"] },
      "-B": { type: "number" },
      "-A": { type: "number" },
      "-C": { type: "number" },
      context: { type: "number" },
      "-n": { type: "boolean" },
      "-i": { type: "boolean" },
      "-o": { type: "boolean" },
      type: { type: "string" },
      head_limit: { type: "number", description: "default 250; 0 = unlimited" },
      offset: { type: "number", description: "default 0" },
      multiline: { type: "boolean" },
    },
    required: ["pattern"],
  },
  description:
    "ripgrep-style regex search. Context/line-number options only matter for output_mode 'content'. Repository ignore rules are respected; directly naming an ignored file still searches it. Returns a structured result: mode, files, content/counts, applied limit/offset.",
  exposure: "eager",
  permissionClass: "read",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
