// WS-06 §3.3 "EndConversation" -- correctly-absent. Absent from SDK sessions, exactly like CC
// (report §40.9). If Winter ever defines the same product-level terminal state, it implements this
// contract; until then it stays out of SDK sessions exactly like CC. §2's own table leaves this
// row's Class column blank ("—", never permission-gated at all -- "auto-allows, skips PreToolUse
// interception"); PermissionClass has no "none" member, so "task" (session-lifecycle control) is
// picked as the least-wrong fit -- a documented judgment call, not a silent default.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "EndConversation",
  advertisedName: "EndConversation",
  source: "builtin",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object", properties: { ended: { type: "boolean" }, message: { type: "string" } }, required: ["ended", "message"] },
  description: "Auto-allows, skips PreToolUse interception, disabled for subagents, excluded from -p and Agent SDK sessions. Correctly absent from Winter for the same reason.",
  exposure: "hidden",
  permissionClass: "task",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "correctly-absent",
});
