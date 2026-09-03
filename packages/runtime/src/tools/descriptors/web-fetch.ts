// WS-06 §3.2 "WebFetch" -- implement-now, captured, verbatim schema. Executor routes through the
// [WS-13] provider layer's extractor model (P6); T1 registers the descriptor only.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "WebFetch",
  advertisedName: "WebFetch",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string" },
      prompt: { type: "string" },
    },
    required: ["url", "prompt"],
  },
  description: "Fetch -> convert -> answer prompt via a smaller extractor model; lossy; ~15-minute cache; redirects can require a follow-up call to the new URL.",
  exposure: "eager",
  permissionClass: "network",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: ["winter.fetch-extractor"],
  disposition: "implement-now",
});
