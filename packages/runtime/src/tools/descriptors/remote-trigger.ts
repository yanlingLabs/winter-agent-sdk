// WS-06 §3.2 "RemoteTrigger" -- correctly-absent (v1), declared. Manages claude.ai Routines;
// subscription auth + Anthropic infrastructure gate it. Winter's daemon-owned routines ([WS-15]) are
// the product-layer analog and MUST NOT impersonate this tool name.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "RemoteTrigger",
  advertisedName: "RemoteTrigger",
  source: "host",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "get", "create", "update", "run", "create_webhook_trigger", "list_runs", "get_run_log"] },
      trigger_id: { type: "string" },
      session_id: { type: "string" },
      cursor: { type: "string" },
      body: { type: "object" },
    },
    required: ["action"],
  },
  description: "Manages claude.ai Routines. Gated on subscription auth + Anthropic infrastructure -- correctly absent from Winter.",
  exposure: "hidden",
  permissionClass: "hosted",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: ["claude.ai-hosting"],
  disposition: "correctly-absent",
});
