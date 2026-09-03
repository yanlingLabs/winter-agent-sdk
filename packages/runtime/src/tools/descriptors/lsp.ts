// WS-06 §3.1 "LSP" -- implement-now, runtime-derived, verbatim schema. Availability: only when a
// compatible language-server plugin is active -- modeled as a capability requirement rather than an
// AvailabilityPredicate field, since it is a connected-backend fact, not a mode/platform/feature
// axis.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "LSP",
  advertisedName: "LSP",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: [
          "goToDefinition",
          "findReferences",
          "hover",
          "documentSymbol",
          "workspaceSymbol",
          "goToImplementation",
          "prepareCallHierarchy",
          "incomingCalls",
          "outgoingCalls",
        ],
      },
      filePath: { type: "string" },
      line: { type: "number", minimum: 1 },
      character: { type: "number", minimum: 1 },
      query: { type: "string" },
    },
    required: ["operation", "filePath", "line", "character"],
  },
  outputSchema: {
    type: "object",
    properties: {
      operation: { type: "string" },
      result: { type: "string" },
      filePath: { type: "string" },
      resultCount: { type: "number" },
      fileCount: { type: "number" },
    },
    required: ["operation", "result", "filePath"],
  },
  description: "One-based positions converted internally; files >10 MB rejected; language server supplied by a code-intelligence plugin; ignored locations filtered.",
  exposure: "eager",
  permissionClass: "read",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: ["winter.lsp-server"],
  disposition: "implement-now",
});
