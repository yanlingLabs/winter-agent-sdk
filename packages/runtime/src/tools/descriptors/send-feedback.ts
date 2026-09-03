// WS-06 §3.2/§40.28 "SendFeedback" -- correctly-absent, declared. Full declared union pinned; local
// draft queue under the vendor home; explicitly omitted from -p/SDK sessions. A future Winter
// product-feedback tool MUST use a Winter name/path and MUST NOT pretend to reach Anthropic's
// feedback service. §2's Class column is blank ("—") for this row, same judgment call as
// EndConversation's own comment -- "task" picked as the least-wrong fit.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "SendFeedback",
  advertisedName: "SendFeedback",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      type: { type: "string" },
      title: { type: "string" },
      details: { type: "string" },
      area: { type: "string" },
      failure_mode: {
        type: "string",
        enum: [
          "incorrect_output", "crashed", "hung", "slow", "unclear_error", "wrong_tool_choice", "unwanted_action",
          "refused", "lost_context", "repeated_itself", "ignored_instructions", "security_concern", "data_loss",
          "unexpected_cost", "other",
        ],
      },
      task_category: { type: "string", enum: ["coding", "writing", "research", "analysis", "automation", "creative", "support", "other"] },
    },
  },
  description: "Local draft queue (10 drafts, 30-day expiry) under the vendor home; explicitly omitted from -p/SDK sessions.",
  exposure: "hidden",
  permissionClass: "task",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "correctly-absent",
});
