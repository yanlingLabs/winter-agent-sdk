// WS-06 §3.3 "AskUserQuestion" -- implement-now, captured/declared. The input schema is a SUPERSET
// of the pinned Claude Code shape: every call valid there stays valid here. The additions are
// free-text questions (`options` is optional -- absent or an empty array means the user types the
// answer; when present it still carries 2-4 entries, enforced in impl/ask-user-question.ts because a
// "0 or 2-4" rule needs `oneOf`, which some providers' strict tool schemas reject) and a per-question
// `placeholder` hint for the answer box. Not available inside Agent-tool subagents.
//
// HOST CONTRACT (kept here, not in the model-facing description): the host resolves the call via
// canUseTool `updatedInput.answers` -- question prompting and permission are one protocol ([WS-07]
// §34). Answers are keyed by question text. Never auto-approved by allow rules/acceptEdits/auto/
// bypass; denied under dontAsk. The tool surface (impl/ask-user-question.ts) implements input
// validation + the result echo.
import { stub } from "./_shared.ts";

export const ASK_USER_QUESTION_PLACEHOLDER_MAX_LENGTH = 80;

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
            question: { type: "string", description: "The complete question to ask the user, ending in a question mark." },
            header: { type: "string", maxLength: 12, description: "A very short label shown as a chip or tag (12 characters max), e.g. \"Auth method\"." },
            options: {
              type: "array",
              maxItems: 4,
              description:
                "2-4 choices, recommended first. Omit (or pass an empty array) for a free-text question the user answers by typing. Never exactly 1 option.",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "The choice as shown to the user (1-5 words)." },
                  description: { type: "string", description: "What this choice means or what happens if it is picked." },
                  preview: { type: "string" },
                },
                required: ["label", "description"],
              },
            },
            placeholder: {
              type: "string",
              maxLength: ASK_USER_QUESTION_PLACEHOLDER_MAX_LENGTH,
              description: "Optional hint shown in the empty answer box, such as an example answer.",
            },
            multiSelect: { type: "boolean", description: "Allow picking more than one option. Only meaningful with options." },
          },
          required: ["question", "header"],
        },
      },
      answers: { type: "object", additionalProperties: { type: "string" } },
      annotations: { type: "object", additionalProperties: { type: "object", properties: { preview: { type: "string" }, notes: { type: "string" } } } },
      metadata: { type: "object", properties: { source: { type: "string" } } },
    },
    required: ["questions"],
  },
  description: [
    "Ask the user one to four questions and wait for their answers.",
    "",
    "Use this only when you cannot proceed on a sensible default: the choice is genuinely the user's (a preference, a trade-off, a name), or guessing wrong would waste real work. If a reasonable default exists, take it and say so instead of asking.",
    "",
    "- Prefer 2-4 concrete options. Put the one you recommend first and add \"(Recommended)\" to the end of its label.",
    "- Leave out `options` only when the answer cannot be predicted, such as a name, a value, or a free description. The user then types the answer; use `placeholder` to show an example.",
    "- The user can always type their own answer instead of picking an option, so do not add an \"Other\" option.",
    "- Set `multiSelect` when more than one option can apply.",
    "- Never ask the user a question in plain text in your reply; use this tool so the question gets an answer.",
  ].join("\n"),
  exposure: "eager",
  permissionClass: "interaction",
  availability: { insideSubagent: false },
  capabilityRequirements: [],
  disposition: "implement-now",
});
