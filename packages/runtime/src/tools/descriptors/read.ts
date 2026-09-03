// WS-06 §3.1 "Read" -- implement-now, captured, verbatim schema.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "Read",
  advertisedName: "Read",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      offset: { type: "number" },
      limit: { type: "number" },
      pages: { type: "string", description: "one-based page range, e.g. '1-5'; max 20 PDF pages per call" },
    },
    required: ["file_path"],
  },
  description:
    "Reads a file with line windowing; images/notebooks/PDFs render as type-specific blocks. Oversized whole-file reads return a PARTIAL view continuable with offset/limit; an explicitly bounded range that still cannot fit errors. Reading a directory is an error.",
  exposure: "eager",
  permissionClass: "read",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
