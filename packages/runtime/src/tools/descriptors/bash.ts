// WS-06 §3.2 "Bash" -- implement-now, captured, verbatim schema. [WS-12] owns the execution/sandbox
// contract (Lane C, Task 3); this file only pins the descriptor.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "Bash",
  advertisedName: "Bash",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout: { type: "number", description: "ms; 2 min default, 10 min ordinary ceiling, declaration caps at 600000" },
      description: { type: "string" },
      run_in_background: { type: "boolean" },
      dangerouslyDisableSandbox: { type: "boolean", description: "requests unsandboxed execution; does NOT bypass permission policy" },
    },
    required: ["command"],
  },
  description:
    "Fresh shell per call; cwd changes persist only within allowed working directories; env exports do not persist. run_in_background returns a background task. Recognized read-only forms are built-in pre-approvals.",
  exposure: "eager",
  permissionClass: "execute",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
