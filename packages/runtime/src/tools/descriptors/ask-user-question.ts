// WS-06 §3.3 "AskUserQuestion" -- implement-now, captured/declared, verbatim schema. Routes through
// canUseTool ([WS-07] §34); the tool surface itself (P3, Lane E) implements input validation +
// result echo. Not available inside Agent-tool subagents.
import { stub } from "./_shared.ts";

stub({
  canonicalName: "AskUserQuestion",
  advertisedName: "AskUserQuestion",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            header: { type: "string", maxLength: 12 },
            options: {
              type: "array",
              minItems: 2,
              maxItems: 4,
              items: {
                type: "object",
                properties: { label: { type: "string" }, description: { type: "string" }, preview: { type: "string" } },
                required: ["label", "description"],
              },
            },
            multiSelect: { type: "boolean" },
          },
          required: ["question", "header", "options"],
        },
      },
      answers: { type: "object", additionalProperties: { type: "string" } },
      annotations: { type: "object", additionalProperties: { type: "object", properties: { preview: { type: "string" }, notes: { type: "string" } } } },
      metadata: { type: "object", properties: { source: { type: "string" } } },
    },
    required: ["questions"],
  },
  description:
    "Host resolves via canUseTool updatedInput.answers -- question prompting and permission are one protocol. Never auto-approved by allow rules/acceptEdits/auto/bypass; denied under dontAsk.",
  exposure: "eager",
  permissionClass: "interaction",
  availability: { insideSubagent: false },
  capabilityRequirements: [],
  disposition: "implement-now",
});
