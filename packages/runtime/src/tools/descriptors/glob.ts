// WS-06 §3.1 "Glob" -- implement-now, captured, verbatim schema.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "Glob",
  advertisedName: "Glob",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
    },
    required: ["pattern"],
  },
  description: "Fast file-name glob matching. Max 100 paths, modification-time ordered, truncation/total metadata. .gitignore is NOT applied by default.",
  exposure: "eager",
  permissionClass: "read",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
