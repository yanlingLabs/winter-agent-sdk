// WS-06 §3.4 "ReportFindings" -- implement-now, captured, verbatim schema. A structured review
// result channel, not a scanner; fully cloneable (local value only).
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "ReportFindings",
  advertisedName: "ReportFindings",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      level: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
      findings: {
        type: "array",
        maxItems: 32,
        items: {
          type: "object",
          properties: {
            file: { type: "string" },
            line: { type: "number" },
            summary: { type: "string" },
            short_summary: { type: "string" },
            failure_scenario: { type: "string" },
            category: { type: "string" },
            verdict: { type: "string", enum: ["CONFIRMED", "PLAUSIBLE"] },
            outcome: { type: "string", enum: ["fixed", "skipped", "no_change_needed"] },
          },
          required: ["file", "summary", "failure_scenario"],
        },
      },
    },
    required: ["findings"],
  },
  description: "Most severe first. A structured review result channel, not a scanner.",
  exposure: "eager",
  permissionClass: "task",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
